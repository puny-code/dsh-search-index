/**
 * dsh-search-index client half.
 *
 * No slot is registered for the entry any more. The plugin owns exactly one
 * DOM-visible thing — the floating title/content search panel, rendered into
 * its own root — and one borrowed control: the sidebar section's own search
 * button, whose click it intercepts in the document capture phase so the
 * host's native global-search panel never opens (see `SearchHost`).
 *
 * The `locale` and config services are consumed structurally: when the host
 * release lacks them the panel falls back to the bundled zh dictionary and the
 * host-composition config layer.
 */
import { createElement, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { Context } from 'cordis'
import { SWITCH_SEARCH_SETTINGS_NAMESPACE, type SwitchSearchConfig } from '../config.ts'
// 0.1.7：插件族共用设置节（dsh-thinking-levels 持有并声明 `dsh-family.tab`
// 子席位；本仓不依赖 ui-slots 类型包，席位键以运行时 children 表为准）。
import { callHost, callHostAny, openSessionThrough, type HostContentHit, type HostIndexStatus, type HostSessionItem, type HostSortMode, type SwitchSessionsService, type SwitchUiWorkspaceService } from './host-api.ts'
import { SearchSettingsCard, type SwitchCardScope } from './card.tsx'
import { NS, de, en, es, fr, it, ru, translate, zh, type LocaleKey } from './locales.ts'
import { LABELS } from './platform.ts'

/** ------------------------------------------------------------------ types */

/** The client slots service face (structural subset used here). */
interface SwitchSlotsService {
  inject(key: string, callback: () => () => void, label?: string): () => void
  register(options: {
    name: string
    id?: string
    key?: string
    order?: number
    store?: unknown
    locale?: string
    label?: string | (() => string)
    inject?: (actions: unknown) => unknown
  }, component: unknown): () => void
}

/**
 * The client sessions service face: open a session from a search result.
 * Defined in `host-api.ts` (shared with `openSessionThrough`); re-imported as
 * a type here for the cordis Context augmentation below.
 */

/** The client settings-scope service face (structural subset). */
interface SwitchSettingsScope<C> {
  bind(spec: { namespace: string }): SwitchScopeLike<C>
}
/** configForms 服务面（0.1.7：以 profile entry id 取句柄）。 */
interface SwitchConfigForms<T> {
  get(entryId: string): SwitchScopeLike<T>
}
interface SwitchScopeLike<T> {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    value: T | undefined
    revision: number | undefined
    writable: boolean
  }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
}

/**
 * The client locale service face (structural mirror; the plugin must not
 * value- or type-import a single release of the official locale package).
 */
interface SwitchLocaleService {
  register(ns: string, dicts: Partial<Record<string, Record<string, string>>>): () => void
  register(ns: string, localeId: string, dicts: Record<string, string>): () => void
  /**
   * Read-time translator bound to a namespace (host `dsh-client-locale`).
   * Needed for slot `label` thunks, which the owner re-reads per render so the
   * tab text follows locale switches without re-registration. Optional: older
   * hosts may expose `register` only, hence the guarded call site.
   */
  bind?(ns: string): (key: string, params?: Record<string, unknown>) => string
}

/** The locale dictionary face the renderer may hand the card as `t`. */
type CardLocale = (key: LocaleKey, params?: Record<string, unknown>) => string

/** Coarse content-type filter carried to the host content-search. */
type ContentType = 'all' | 'user' | 'reply' | 'tool'

/** The coarse filter chips rendered above content results. */
const CONTENT_TYPE_CHIPS: readonly { id: ContentType; labelKey: LocaleKey }[] = [
  { id: 'all', labelKey: 'filter.all' },
  { id: 'user', labelKey: 'filter.user' },
  { id: 'reply', labelKey: 'filter.reply' },
  { id: 'tool', labelKey: 'filter.tool' },
]

/** Result-ordering chips rendered at the right of the same filter row. */
const SORT_CHIPS: readonly { id: HostSortMode; labelKey: LocaleKey }[] = [
  { id: 'relevance', labelKey: 'sort.relevance' },
  { id: 'time', labelKey: 'sort.time' },
]

/**
 * The identity of one content-search request, derived from every input that
 * changes the result set.
 *
 * This is the single owner of that identity. The effect that issues the
 * request and the render path that decides whether the stored result belongs
 * to the current inputs must both come through here: two hand-written copies
 * of the same template literal drift apart silently, and the render path then
 * falls through to its empty `loading` state for every query — results arrive,
 * parse, and are never shown.
 *
 * @param normalized - the trimmed query text.
 * @param contentType - the active content-type filter.
 * @param sortBy - the active result ordering.
 * @returns an opaque key, stable for equal inputs.
 */
function contentRequestKey(normalized: string, contentType: ContentType, sortBy: HostSortMode): string {
  return `${normalized}\u0000${contentType}\u0000${sortBy}`
}

/**
 * Persisted ordering preference. Unlike `lastPanelMode` this one survives a
 * page reload — an ordering is a durable preference, not a session mood.
 */
const SORT_STORE_KEY = 'dsh-search-index.sortBy'

/** Read the persisted ordering; private mode or a bad value degrades to relevance. */
function readStoredSort(): HostSortMode {
  try {
    return window.localStorage.getItem(SORT_STORE_KEY) === 'time' ? 'time' : 'relevance'
  } catch {
    return 'relevance'
  }
}

/** Persist the ordering; a storage failure still leaves this session working. */
function writeStoredSort(next: HostSortMode): void {
  try {
    window.localStorage.setItem(SORT_STORE_KEY, next)
  } catch {
    // ignore: the choice applies for the rest of this session regardless
  }
}

/**
 * Local re-sort so the page honours the chosen ordering even against an older
 * host half that ignores `sortBy` and therefore omits `updatedAt` entirely —
 * in that case the host order is left untouched rather than scrambled to NaN.
 */
function sortHits(items: readonly HostContentHit[], sortBy: HostSortMode): HostContentHit[] {
  if (sortBy !== 'time') return [...items]
  if (!items.every(item => typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt))) return [...items]
  return [...items].sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Last panel mode used this web session (mode memory, not persisted). */
let lastPanelMode: 'title' | 'content' = 'title'

declare module 'cordis' {
  interface Context {
    slots: SwitchSlotsService
    sessions?: SwitchSessionsService
    uiWorkspace?: SwitchUiWorkspaceService
    settingsScope?: SwitchSettingsScope<SwitchSearchConfig>
    locale?: SwitchLocaleService
  }
}

/** ------------------------------------------------------------------ styles */

const CSS = `
/* 0.7.0：本插件不再注册 sidebar.footer.action 席位，改为接管侧边栏分区标题
   旁自带的搜索按钮（见 index.ts 的 SearchHost）。因此为那个「独占整行入口」
   服务的规则全部删除：footerActions 行容器公约、lc-ov-entry 等第三方矫正、
   以及入口按钮那套（root / button 系列）样式。侧栏 footer 恢复宿主与第三方
   各自的默认布局。 */
/* 面板（.dsws_trigger）改为毛玻璃底板：原来只有 --dsw-specific-tip 实色，
   在部分宿主主题下该变量解析为空 → 面板全透明，弹窗文字与下层正文叠在一起
   无法阅读。backdrop-filter 把身后内容糊掉，color-mix 给出 55% 的侧栏底色
   （保留上一行 background 实色作为 color-mix 不支持时的回退）。 */
.dsws_trigger{position:fixed;z-index:2147483000;left:50%;top:50%;transform:translate(-50%,-50%);width:520px;max-width:calc(100vw - 24px);max-height:min(72vh,640px);box-sizing:border-box;background:var(--dsw-specific-tip);-webkit-backdrop-filter:blur(9px);backdrop-filter:blur(9px);background-color:color-mix(in srgb,var(--dsw-specific-sidebar-fill) 55%,transparent);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:var(--dsw-shadow-lv3,0 8px 28px rgba(0,0,0,.16));overflow:hidden;display:flex;flex-direction:column;font-family:Inter,var(--dsw-font-family)}
.dsws_toolrow{display:flex;align-items:center;gap:8px;padding:10px 10px 0}
.dsws_mode{display:inline-flex;align-items:center;gap:2px;flex:none;background:var(--dsw-alias-interactive-bg-hover);border-radius:8px;padding:2px}
.dsws_modeBtn{height:24px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:6px;padding:0 8px;font-size:12px;font-weight:500;line-height:20px}
.dsws_modeBtn:hover{color:var(--dsw-alias-label-primary)}
.dsws_modeBtnActive{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.dsws_search{flex:auto;min-width:0;height:30px;box-sizing:border-box;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;outline:none;padding:0 10px;font:inherit;font-size:13px;line-height:20px}
.dsws_search:focus{border-color:var(--dsw-alias-state-business-primary)}
.dsws_search::placeholder{color:var(--dsw-alias-label-caption)}
.dsws_chips{display:flex;align-items:center;gap:6px;padding:8px 10px 0;flex:none}
.dsws_chipGap{flex:1;min-width:0}
.dsws_sortGroup{display:flex;align-items:center;gap:6px;flex:none}
.dsws_chip{height:24px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:999px;padding:0 10px;font-size:12px;font-weight:500;line-height:22px;white-space:nowrap}
.dsws_chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsws_chipActive{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}
.dsws_list{flex:1 1 auto;min-height:0;overflow-y:auto;margin:8px 0 0;padding:0 6px 8px;list-style:none}
.dsws_row{box-sizing:border-box;border-radius:8px;width:100%;padding:7px 8px;cursor:pointer;text-align:left;border:none;background:transparent;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:2px;min-width:0}
.dsws_row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsws_rowTitle{display:flex;align-items:center;gap:8px;min-width:0}
.dsws_titleText{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500;line-height:18px}
.dsws_tag{flex:none;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;white-space:nowrap;font-variant-numeric:tabular-nums}
.dsws_snippet{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.dsws_meta{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsws_status{color:var(--dsw-alias-label-tertiary);padding:10px 8px 8px;font-size:12px;line-height:18px}
.dsws_error{color:var(--dsw-alias-state-error-primary);padding:8px;font-size:12px;line-height:18px}
.dsws_empty{color:var(--dsw-alias-label-tertiary);padding:10px 8px 8px;font-size:12px;line-height:18px}
.dsws_backdrop{position:fixed;inset:0;z-index:2147482999;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.24));backdrop-filter:blur(var(--dsw-mask-blur,4px))}
.dsws_setRow{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsws_setRow:last-child{border-bottom:none}
.dsws_setText{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsws_setTitle{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.dsws_setDesc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsws_seg{display:inline-flex;align-items:center;gap:2px;background:var(--dsw-alias-interactive-bg-hover);border-radius:8px;padding:2px;flex:none}
.dsws_segBtn{height:24px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:6px;padding:0 10px;font-size:12px;font-weight:500;line-height:20px}
.dsws_segBtn:hover{color:var(--dsw-alias-label-primary)}
.dsws_segBtn:disabled{cursor:not-allowed;opacity:.5}
.dsws_segBtnActive{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.dsws_actBtn{height:26px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;border-radius:8px;padding:0 10px;font-size:12px;line-height:24px;white-space:nowrap}
.dsws_actBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsws_actBtn:disabled{cursor:not-allowed;opacity:.5}
.dsws_btnRow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dsws_progressWrap{display:flex;flex-direction:column;gap:4px;padding:8px 10px 0}
.dsws_progress{height:6px;border-radius:3px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden}
.dsws_progressFill{height:100%;border-radius:3px;background:var(--dsw-alias-state-business-primary);transition:width .4s ease}
.dsws_progressLabel{color:var(--dsw-alias-state-business-primary);font-size:12px;line-height:18px;font-weight:600;font-variant-numeric:tabular-nums}
.dsws_panelFoot{flex:none;display:flex;align-items:center;gap:14px;padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dsws_footItem{display:inline-flex;align-items:center}
.dsws_footItem>.dsws_kbd{margin-right:5px}
.dsws_footGap{flex:1;min-width:0}
.dsws_kbd{flex:none;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;min-width:18px;width:auto;height:18px;padding:0 4px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1;white-space:nowrap;font-variant-numeric:tabular-nums}
.dsws_pill{flex:none;display:inline-grid;grid-template-columns:14px max-content;align-items:center;column-gap:4px;height:26px;padding:0 10px;box-sizing:border-box;border:none;border-radius:8px;font-size:12px;font-weight:500;line-height:18px;white-space:nowrap;transition:background-color 160ms ease-out,color 160ms ease-out}
.dsws_pill .dsws_pillIcon{display:grid;place-items:center;width:14px;height:14px}
.dsws_pill .dsws_pillLabel{display:grid;text-align:left}
.dsws_pill .dsws_pillLabel>span{grid-area:1/1}
.dsws_pillReady{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary)}
.dsws_pillWarn{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label)}
.dsws_pillError{background:var(--dsw-alias-state-error-tertiary,var(--dsw-alias-state-warn-tertiary));color:var(--dsw-alias-state-error-primary,var(--dsw-alias-state-warn-label))}
.dsws_pillNeutral{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsws_pillDots span{opacity:0;animation:dsws-reveal-dot 1.5s step-end infinite}
.dsws_pillDots span:nth-child(2){animation-delay:.5s}
.dsws_pillDots span:nth-child(3){animation-delay:1s}
@keyframes dsws-reveal-dot{0%,32%{opacity:0}33%,100%{opacity:1}}
@media (prefers-reduced-motion:reduce){.dsws_pillDots span{animation:none;opacity:1}}
`

/** Inject the plugin stylesheet once per activation (removed on disposal). */
function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector('style[data-plugin-css="dsw-session-search-toggle/styles"]') !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-search-index'
  tag.dataset.pluginCss = 'dsw-session-search-toggle/styles'
  tag.textContent = CSS
  document.head.appendChild(tag)
  return () => {
    if (tag.parentNode !== null) tag.parentNode.removeChild(tag)
  }
}

/** ------------------------------------------------------------------ view */

/** The floating search panel. */
function SwitchPanel({
  t,
  onClose,
  open,
}: {
  t?: CardLocale
  onClose: () => void
  open: (sessionId: string) => void
}): ReactElement {
  // Mode memory: the panel reopens in the mode last used in this web session
  // (first open falls back to 'title'). Session-scoped on purpose — no
  // persistence, the settings card's defaultMode stays the durable preference.
  const [mode, setModeState] = useState<'title' | 'content'>(lastPanelMode)
  const setMode = (next: 'title' | 'content'): void => {
    lastPanelMode = next
    setModeState(next)
  }
  const [query, setQuery] = useState('')
  const [contentType, setContentType] = useState<ContentType>('all')
  const [sortBy, setSortByState] = useState<HostSortMode>(readStoredSort)
  const setSortBy = (next: HostSortMode): void => {
    writeStoredSort(next)
    setSortByState(next)
  }
  const [sessions, setSessions] = useState<HostSessionItem[] | null>(null)
  const [sessionsError, setSessionsError] = useState<string | null>(null)
  const [content, setContent] = useState<{ query: string; status: 'idle' | 'loading' | 'ready' | 'error'; items: HostContentHit[]; error?: string }>({
    query: '',
    status: 'idle',
    items: [],
  })
  // Independent-index availability probe + rebuild progress.
  const [searchStatus, setSearchStatus] = useState<{
    available: boolean | null
    reason?: string
    rebuilding: boolean
    done: number
    total: number
  }>({ available: null, rebuilding: false, done: 0, total: 0 })
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)

  const normalized = query.trim().toLowerCase()

  // Probe the independent index status on open, and keep polling while a
  // rebuild ("整理") is in flight so the panel flips to ready on completion.
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const probe = (): void => {
      callHostAny<HostIndexStatus>('index-status', {}).then((res) => {
        if (cancelled) return
        if (!res.ok) {
          // Old host half without this route (browser refresh keeps the old
          // process): show an actionable state instead of a blank panel.
          setSearchStatus({ available: false, reason: 'unreachable', rebuilding: false, done: 0, total: 0 })
          return
        }
        const status = res as HostIndexStatus
        const rebuilding = status.rebuild?.state === 'building' || status.rebuild?.state === 'swapping'
        setSearchStatus({
          available: status.available ?? false,
          reason: status.reason,
          rebuilding,
          done: status.rebuild?.done ?? 0,
          total: status.rebuild?.total ?? 0,
        })
        if (rebuilding) timer = window.setTimeout(probe, 1500)
      })
    }
    probe()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])

  const startIndexBuild = (): void => {
    setSearchStatus(prev => ({ ...prev, rebuilding: true }))
    void callHostAny<HostIndexStatus>('index-rebuild', {})
  }

  // Load the title-search corpus once on open.
  useEffect(() => {
    if (sessions !== null) return
    let cancelled = false
    callHost<HostSessionItem>('list-sessions', {}).then((res) => {
      if (cancelled) return
      if (res.ok) { setSessions(res.items); setSessionsError(null) }
      else setSessionsError(res.error ?? '读取会话列表失败')
    })
    return () => { cancelled = true }
  }, [sessions])

  // Content search debounces against the host route.
  useEffect(() => {
    if (mode !== 'content' || normalized === '') {
      if (mode !== 'content') setContent({ query: normalized, status: 'idle', items: [] })
      return
    }
    let cancelled = false
    const requestType: ContentType = contentType
    const requestKey = contentRequestKey(normalized, requestType, sortBy)
    setContent(prev => ({ query: requestKey, status: 'loading', items: prev.query === requestKey ? prev.items : [] }))
    const timer = window.setTimeout(() => {
      callHost<HostContentHit>('content-search', {
        query: normalized,
        limit: 50,
        types: requestType === 'all' ? undefined : [requestType],
        sortBy,
      }).then((res) => {
        if (cancelled) return
        setContent({
          query: requestKey,
          status: res.ok ? 'ready' : 'error',
          items: res.ok ? sortHits(res.items, sortBy) : [],
          error: res.ok ? undefined : (res.error ?? '搜索失败'),
        })
      })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [mode, normalized, contentType, sortBy])

  // Focus the input on open; reset mode on every open.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Escape closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [onClose])

  // Title-mode rows: local substring filter over the corpus.
  const titleRows = useMemo<HostSessionItem[]>(() => {
    if (sessions === null) return []
    if (normalized === '') return sessions
    return sessions.filter(item =>
      item.title.toLowerCase().includes(normalized)
      || item.cwd.toLowerCase().includes(normalized))
  }, [sessions, normalized])

  const children: ReactElement[] = []
  if (sessionsError !== null) {
    children.push(createElement('div', { key: 'err', className: 'dsws_error' }, translate(t, 'panel.sessionsError', { error: sessionsError })))
  }
  const activeRequestKey = contentRequestKey(normalized, contentType, sortBy)
  const activeContent = content.query === activeRequestKey ? content : { query: activeRequestKey, status: 'loading' as const, items: [] }
  if (mode === 'title') {
    if (sessions === null) {
      children.push(createElement('div', { key: 'loading', className: 'dsws_status' }, translate(t, 'panel.loadingSessions')))
    } else if (titleRows.length === 0) {
      children.push(createElement('div', { key: 'empty', className: 'dsws_empty' }, normalized === '' ? translate(t, 'panel.noSessions') : translate(t, 'panel.noMatch')))
    } else {
      children.push(createElement('ul', {
        key: 'list',
        ref: listRef,
        className: 'dsws_list',
        role: 'listbox',
        'aria-label': translate(t, 'panel.titleSearch'),
      }, titleRows.slice(0, 200).map(item => createElement('li', { key: item.sessionId, role: 'option' }, createElement('button', {
        type: 'button',
        className: 'dsws_row',
        onClick: () => { open(item.sessionId) },
      }, [
        createElement('span', { key: 't', className: 'dsws_rowTitle' }, [
          createElement('span', { key: 'x', className: 'dsws_titleText' }, item.title || translate(t, 'panel.untitled')),
          createElement('span', { key: 'tag', className: 'dsws_tag' }, fmtTime(item.updatedAt)),
        ]),
        item.cwd !== '' && createElement('span', { key: 'c', className: 'dsws_meta' }, item.cwd),
      ])))))
    }
  } else {
    if (searchStatus.rebuilding) {
      const pct = searchStatus.total > 0
        ? Math.min(100, Math.round((searchStatus.done / searchStatus.total) * 100))
        : undefined
      children.push(createElement('div', { key: 'rebuilding', className: 'dsws_progressWrap' }, [
        createElement('div', { key: 'bar', className: 'dsws_progress' },
          createElement('div', {
            className: 'dsws_progressFill',
            style: pct === undefined ? { width: '30%', opacity: 0.6 } : { width: `${pct}%` },
          })),
        createElement('span', { key: 'label', className: 'dsws_progressLabel' },
          translate(t, 'panel.rebuilding', { done: searchStatus.done, total: searchStatus.total || '?' })),
      ]))
    } else if (searchStatus.available === false) {
      children.push(createElement('div', { key: 'unavailable', className: 'dsws_error' }, [
        createElement('div', { key: 'msg' },
          searchStatus.reason === 'unreachable'
            ? '索引状态不可达：Host 半可能是旧进程。请完全重启 dsh web（浏览器刷新不重载 Host）后重试。'
            : searchStatus.reason === 'unavailable'
              ? translate(t, 'panel.unavailable')
              : translate(t, 'panel.notBuilt')),
        createElement('button', {
          key: 'build',
          type: 'button',
          className: 'dsws_actBtn',
          style: { marginTop: '6px' },
          onClick: startIndexBuild,
        }, translate(t, 'panel.buildIndex')),
      ]))
    } else if (activeContent.status === 'loading') {
      children.push(createElement('div', { key: 'loading', className: 'dsws_status' }, translate(t, 'panel.loadingContent')))
    } else if (activeContent.status === 'error') {
      children.push(createElement('div', { key: 'error', className: 'dsws_error' }, translate(t, 'panel.contentError', { error: activeContent.error ?? '未知错误' })))
    } else if (activeContent.items.length === 0) {
      children.push(createElement('div', { key: 'empty', className: 'dsws_empty' }, normalized === '' ? translate(t, 'panel.contentHint') : translate(t, 'panel.noContent')))
    } else {
      children.push(createElement('ul', {
        key: 'list',
        ref: listRef,
        className: 'dsws_list',
        role: 'listbox',
        'aria-label': translate(t, 'panel.contentSearch'),
      }, activeContent.items.slice(0, 200).map(item => createElement('li', { key: item.sessionId, role: 'option' }, createElement('button', {
        type: 'button',
        className: 'dsws_row',
        onClick: () => { open(item.sessionId) },
      }, [
        createElement('span', { key: 't', className: 'dsws_rowTitle' }, [
          createElement('span', { key: 'x', className: 'dsws_titleText' }, item.title || translate(t, 'panel.untitled')),
          createElement('span', { key: 'tag', className: 'dsws_tag' }, typeLabel(t, item.type)),
          // The session clock — the very field the 「时间」 ordering sorts by and
          // the one the title rows already show. Ordering rows by a time the
          // rows never display is illegible: you cannot tell what the sort did.
          createElement('span', { key: 'time', className: 'dsws_tag' }, fmtTime(item.updatedAt)),
        ]),
        createElement('span', { key: 's', className: 'dsws_snippet' }, item.snippet || translate(t, 'panel.noText')),
      ])))))
    }
  }

  return createPortal(createElement('div', { key: 'switch-root' }, [
    createElement('div', { key: 'backdrop', className: 'dsws_backdrop', onClick: onClose }),
    createElement('div', { key: 'panel', className: 'dsws_trigger', role: 'dialog', 'aria-label': translate(t, 'card.title') }, [
      createElement('div', { key: 'tools', className: 'dsws_toolrow' }, [
        createElement('div', { key: 'mode', className: 'dsws_mode', role: 'group', 'aria-label': translate(t, 'card.defaultMode') }, [
          createElement('button', {
            key: 'title',
            type: 'button',
            className: `dsws_modeBtn${mode === 'title' ? ' dsws_modeBtnActive' : ''}`,
            onClick: () => { setMode('title') },
          }, translate(t, 'panel.titleSearch')),
          createElement('button', {
            key: 'content',
            type: 'button',
            className: `dsws_modeBtn${mode === 'content' ? ' dsws_modeBtnActive' : ''}`,
            onClick: () => { setMode('content') },
          }, translate(t, 'panel.contentSearch')),
        ]),
        createElement('input', {
          key: 'search',
          ref: inputRef,
          className: 'dsws_search',
          type: 'text',
          placeholder: mode === 'title' ? translate(t, 'panel.searchTitle') : translate(t, 'panel.searchContent'),
          value: query,
          onChange: (e: { target: { value: string } }) => setQuery(e.target.value),
        }),
      ]),
      mode === 'content' && createElement('div', { key: 'chips', className: 'dsws_chips', role: 'group', 'aria-label': translate(t, 'filter.all') }, [
        ...CONTENT_TYPE_CHIPS.map(chip => createElement('button', {
          key: chip.id,
          type: 'button',
          className: `dsws_chip${contentType === chip.id ? ' dsws_chipActive' : ''}`,
          'aria-pressed': contentType === chip.id,
          onClick: () => { setContentType(chip.id) },
        }, translate(t, chip.labelKey))),
        // Ordering sits on the same row, pushed right: it filters the same
        // result set the type chips do, so it is not a separate toolbar.
        createElement('span', { key: 'gap', className: 'dsws_chipGap' }),
        createElement('span', { key: 'sort', className: 'dsws_sortGroup', role: 'group', 'aria-label': translate(t, 'sort.label') },
          SORT_CHIPS.map(chip => createElement('button', {
            key: chip.id,
            type: 'button',
            className: `dsws_chip${sortBy === chip.id ? ' dsws_chipActive' : ''}`,
            'aria-pressed': sortBy === chip.id,
            title: chip.id === 'time' ? translate(t, 'sort.time.hint') : translate(t, 'sort.relevance.hint'),
            onClick: () => { setSortBy(chip.id) },
          }, translate(t, chip.labelKey)))),
      ]),
      children,
      // The key bar. It advertises only the one key that is actually bound:
      // Escape (see the effect above). The invoke chord is gone with the hotkey
      // — a key cap for a key nothing listens to is a lie the user has to
      // discover by pressing it.
      createElement('div', { key: 'foot', className: 'dsws_panelFoot' }, [
        createElement('span', { key: 'gap', className: 'dsws_footGap' }),
        createElement('span', { key: 'close', className: 'dsws_footItem' }, [
          createElement('kbd', { key: 'k', className: 'dsws_kbd' }, LABELS.escLabel),
          translate(t, 'panel.footer.close'),
        ]),
      ]),
    ]),
  ]), document.body)
}

/**
 * Whether the user has the sidebar entry switched on.
 *
 * The `enabled` field has existed since the card shipped, but nothing read it:
 * the switch promised "show the search entry at the bottom of the sidebar" and
 * controlled nothing at all. Reading it here is the whole fix.
 *
 * An absent or unreadable scope keeps the entry visible — a settings service we
 * cannot read is not a user asking for the feature off, and hiding the entry
 * would also hide the only way back to the panel.
 *
 * @param scope - the bound `switch-search` namespace scope, when available.
 * @returns `false` only when a readable scope says the entry is switched off.
 */
function useEntryEnabled(scope: SwitchCardScope | undefined): boolean {
  const snapshot = useSyncExternalStore(
    (listener) => scope?.subscribe(listener) ?? (() => {}),
    () => scope?.getSnapshot(),
  )
  return snapshot?.value?.enabled !== false
}

/**
 * The borrowed trigger: the sidebar section's own search button.
 *
 * The host (`dsh-projects`) renders `<div class="dshp-section-actions">` with
 * four `button.dshp-mini-button`s, the search one first, its `aria-label` being
 * the localized 「全局搜索」. The label is matched case-insensitively so the
 * English and other locales work too, and the first button is the fallback for a
 * release that renames the label.
 */
const TRIGGER_LABEL = /搜索|search/iu

/** Match the host's CSS-module search button without depending on its hash. */
export function isNativeSearchButton(button: Pick<Element, 'matches' | 'getAttribute'>): boolean {
  return button.matches('button[class*="_searchButton"]')
    && /搜索|search/iu.test(button.getAttribute('aria-label') ?? '')
    && /(?:Control|Meta)\+K/iu.test(button.getAttribute('aria-keyshortcuts') ?? '')
}

/** The `dshp-section-actions` group an element belongs to, if any. */
function actionGroupOf(element: Element | null): Element | null {
  if (element === null || typeof element.closest !== 'function') return null
  const group = element.closest('.dshp-section-actions')
  if (group === null) return null
  return group.closest('.dshp-sidebar') !== null ? group : null
}

/** The search button of one action group (label match, else first by position). */
function triggerOf(group: Element | null): Element | null {
  if (group === null) return null
  const buttons = Array.from(group.querySelectorAll('button.dshp-mini-button'))
  const labelled = buttons.find(button => TRIGGER_LABEL.test(button.getAttribute('aria-label') ?? ''))
  return labelled ?? buttons[0] ?? null
}

/** The sidebar search button as currently rendered, when it is there. */
function borrowedTrigger(): Element | null {
  return triggerOf(document.querySelector('.dshp-sidebar .dshp-section-actions'))
    ?? Array.from(document.querySelectorAll('button[class*="_searchButton"]')).find(isNativeSearchButton) ?? null
}

/**
 * The panel host: no entry of its own, one borrowed button.
 *
 * The click is intercepted in the DOCUMENT CAPTURE phase rather than on the
 * button itself. Two reasons: the button is re-created whenever the host
 * re-renders the sidebar, so a listener bound to the element would go stale; and
 * the host's own handler is a React `onClick` delegated at the app root, so
 * stopping the event before it descends means that handler never runs — the
 * native global-search panel stays shut without the host being patched.
 *
 * `enabled: false` unbinds the interceptor, which hands the button back to the
 * host: the plugin's panel stays closed and the stock search works.
 */
function SearchHost({
  t,
  open,
  scope,
}: {
  t?: CardLocale
  open: (sessionId: string) => void
  scope?: SwitchCardScope
}): ReactElement | null {
  const [openPanel, setOpenPanel] = useState(false)
  const enabled = useEntryEnabled(scope)

  useEffect(() => {
    if (!enabled) {
      setOpenPanel(false)
      return undefined
    }
    const onClick = (event: MouseEvent): void => {
      const target = event.target as Element | null
      if (target === null || typeof target.closest !== 'function') return
      const nativeButton = target.closest('button[class*="_searchButton"]')
      const group = actionGroupOf(target)
      const projectsButton = triggerOf(group)
      const isProjectsSearch = projectsButton !== null && target.closest('button.dshp-mini-button') === projectsButton
      if (!isProjectsSearch && (nativeButton === null || !isNativeSearchButton(nativeButton))) return
      // Swallow the click whole: the host's delegated handler must not run.
      event.stopImmediatePropagation()
      event.stopPropagation()
      setOpenPanel(true)
    }
    document.addEventListener('click', onClick, true)
    return () => { document.removeEventListener('click', onClick, true) }
  }, [enabled])

  // Mirror the panel state onto the borrowed button: it carries the host's own
  // `[data-active=true]` highlight, which would otherwise keep claiming "closed"
  // while our panel is up.
  useEffect(() => {
    const button = borrowedTrigger()
    if (button === null || !openPanel) return undefined
    const active = button.getAttribute('data-active')
    const expanded = button.getAttribute('aria-expanded')
    button.setAttribute('data-active', 'true')
    button.setAttribute('aria-expanded', 'true')
    return () => {
      if (active === null) button.removeAttribute('data-active')
      else button.setAttribute('data-active', active)
      if (expanded === null) button.removeAttribute('aria-expanded')
      else button.setAttribute('aria-expanded', expanded)
    }
  }, [openPanel])

  if (!enabled) return null
  return openPanel
    ? createElement(SwitchPanel, {
      key: 'panel',
      t,
      onClose: () => { setOpenPanel(false) },
      open: (sessionId: string) => {
        setOpenPanel(false)
        open(sessionId)
      },
    })
    : null
}

/**
 * Mount the panel host into its own React root.
 *
 * The plugin registers no slot any more, so nothing else renders its React
 * tree: a detached container in `document.body` plus `createRoot` is the whole
 * surface. The container itself stays empty (the panel portals its nodes) but
 * keeps the root alive across open/close.
 *
 * @param props - translator, session opener, and the shared settings scope.
 * @returns the disposer that unmounts the root and removes the container.
 */
function mountSearchHost(props: {
  t?: CardLocale
  open: (sessionId: string) => void
  scope?: SwitchCardScope
}): () => void {
  if (typeof document === 'undefined' || document.body === null) return () => {}
  const container = document.createElement('div')
  container.dataset.plugin = 'dsh-search-index'
  container.dataset.pluginHost = 'search-panel'
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(createElement(SearchHost, props))
  return () => {
    root.unmount()
    if (container.parentNode !== null) container.parentNode.removeChild(container)
  }
}

/** ------------------------------------------------------------------ helpers */

/** Format an epoch-ms timestamp: today → HH:mm, else YYYY-MM-DD HH:mm. */
function fmtTime(ms: number): string {
  if (!ms || typeof ms !== 'number') return ''
  try {
    const d = new Date(ms)
    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const sameDay = d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth()
      && d.getDate() === now.getDate()
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
    if (sameDay) return time
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`
  } catch {
    return ''
  }
}

/** Short label for a content-hit event type. */
function typeLabel(t: CardLocale | undefined, type: string): string {
  if (type === 'user/message' || type === 'assistant/message'
    || type === 'tool/call' || type === 'tool/result') {
    return translate(t, `type.${type}` as LocaleKey)
  }
  return type
}

/** ------------------------------------------------------------------ plugin */

/**
 * Sibling-tab seat (`settings.plugins.tab`). **Deliberately NOT registered.**
 *
 * Kept as a named constant because it is the seat this plugin used to also
 * occupy — registering both is what made the card appear twice (once next to
 * 「插件配置」 and once under it). 0.1.7 removed the child seat entirely; the
 * settings form is generated from the host half's `.volatile()` Config fields.
 */
export const SETTINGS_SIBLING_SEAT = 'settings.plugins.tab'

/** Services required before mounting: the slot registry + locale (the family
 * tab label captures the translator eagerly — a lazy `ctx.locale` access inside
 * the label thunk would be evaluated by the FAMILY HOLDER's render and throw
 * `cannot get property "locale" without inject` there, killing the whole tab
 * ledger projection). */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: dictionaries, the settings card, and the search panel
 * that hijacks the sidebar section's own search button.
 * @param ctx - client plugin context (slots, optional locale/settingsScope/sessions).
 */
export function apply(ctx: Context): void {
  ctx.effect(() => injectStyles(), 'dsh-search-index: stylesheet')

  // Register the dictionaries when the locale service exists (optional across
  // target releases); the card falls back to the bundled zh dictionary.
  const locale = ctx.get('locale') as SwitchLocaleService | undefined
  if (locale !== undefined && typeof locale.register === 'function') {
    ctx.effect(() => locale.register(NS, { zh, en, fr, de, it, ru, es } as never), 'dsh-search-index: dictionaries')
  }
  // The family-tab label translator, captured EAGERLY: the holder evaluates
  // `label()` during its own render, and a lazy ctx.locale access there throws
  // (see the inject note above). `bind` returns a live binder, so locale
  // switches are still followed.
  const familyLabel = (locale as unknown as { bind?: (n: string) => CardLocale } | undefined)?.bind?.(NS)

  // Session opening resolves through `openSessionThrough` at click time: this
  // plugin applies before the session-controller / ui-workspace client modules
  // in the load order, so an eager service lookup captured undefined and every
  // result click silently no-op'd (see the host-api.ts note). 0.1.7 moved
  // navigation from `sessions.open` (dropped from the contract) to
  // `uiWorkspace.openSession`; the old face stays as a legacy-host fallback —
  // with the old call the guard turned the missing method into a silent
  // no-op, which is exactly how the jump died on 0.1.7/0.2.0 without a trace.
  const open = (sessionId: string): void => {
    openSessionThrough((name) => ctx.get(name), sessionId)
  }

  // The `enabled` switch binding. Resolved before the panel host because the
  // switch and the borrowed button have to read the same binding: otherwise the
  // switch silently goes back to controlling nothing.
  // 0.1.7：configForms 以 entry id 取句柄；旧宿主回退按命名空间绑定。
  const configForms = ctx.get('configForms') as SwitchConfigForms<SwitchSearchConfig> | undefined
  const settingsScope = ctx.get('settingsScope') as SwitchSettingsScope<SwitchSearchConfig> | undefined
  const entryScope: SwitchCardScope | undefined =
    configForms?.get('dsh-search-index') ??
    settingsScope?.bind({
      namespace: SWITCH_SEARCH_SETTINGS_NAMESPACE,
    })

  // The panel host: no slot, no entry of its own — it borrows the sidebar
  // section's search button (see `SearchHost`) and renders into a root of its
  // own, so the panel also comes up on a host that offers no slots service.
  ctx.effect(
    () => mountSearchHost({ t: familyLabel, open, scope: entryScope }),
    'dsh-search-index: search panel host',
  )

  // Slots carry the two settings seats below and nothing else: the archived-
  // sessions viewer moved to dsh-session-steward (养老院), and this package no
  // longer owns any session-history UI.
  const slots = ctx.get('slots') as SwitchSlotsService | undefined
  if (slots === undefined) return

  // 插件族共用设置 tab（dsh-thinking-levels 的顶级「起子插件设置」节声明该子
  // 席位）。thinking-levels 缺席时本 inject 静默等待，不阻塞客户端半；设置卡
  // 随席位于 0.1.7 被宿主删除后在此恢复入口。
  const familyTab = ctx.get('slots') as { inject: (n: string, f: () => unknown) => unknown } | undefined
  familyTab?.inject('dsh-family.tab', () => slots.register(
    {
      name: 'dsh-family.tab',
      id: 'dsh-search-index',
      order: 30,
      // 账本 label：读期求值，跟随当前 locale（translate 内建 zh/en 兜底）。
      label: () => translate(familyLabel, 'card.title'),
      locale: NS,
    },
    (props: { t?: CardLocale }) => createElement(SearchSettingsCard, {
      scope: entryScope as SwitchCardScope,
      t: props.t,
    }),
  ))

  // Plugins 页配置卡（`plugins.bundle.config`，key = 包名，dsh-tidy-display
  // 已实证该模式）：0.2.0 的 Plugins 页不自动渲染 volatile 配置表单，bundle
  // 详情页只渲染在该席位注册、key 与包名相等的条目。组件与 family tab 完全
  // 同一张 `SearchSettingsCard`，scope 复用上方已解析的 `entryScope`
  // （configForms 优先、settingsScope 软回退）——不另建第二份绑定；页面
  // owner props 是 `{ view, form }` 不带 `t`，故回退到 family tab label 同款
  // 的期求译器 `familyLabel`（translate 内建 zh 字典再兜底）。
  // `settings.plugins.tab` 仍故意不注册（见上），两处设置面不重复。
  slots.inject('plugins.bundle.config', () => slots.register(
    { name: 'plugins.bundle.config', key: 'dsh-search-index' },
    (props: { t?: CardLocale }) => createElement(SearchSettingsCard, {
      scope: entryScope as SwitchCardScope,
      t: props.t ?? familyLabel,
    }),
  ), 'dsh-search-index: plugins page config card')
}

// Re-exported dictionary faces for consumers that compose the card directly.
export { NS as SWITCH_SEARCH_LOCALE_NAMESPACE, translate }
