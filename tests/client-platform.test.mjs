#!/usr/bin/env node
/**
 * The platform vocabulary — and the absence of the hotkey it used to feed.
 *
 * Why this test exists
 * --------------------
 * Two failure modes are invisible in a Windows browser and therefore sail
 * through a GUI check:
 *
 * 1. **One hard-coded vocabulary.** The old footer advertised `⌘K` to everyone,
 *    so its hint was undiscoverable on Windows and Linux. Worse, the old
 *    detection was a single `navigator.platform` test — a deprecated API that
 *    returns an empty string in some privacy configurations, silently
 *    degrading every Mac user to the Windows vocabulary.
 * 2. **A hint that disagrees with the handler.** Which is why 0.7.0 deleted the
 *    chord instead of fixing it: the advertised shortcut did not fire, and a
 *    key cap for a key nothing listens to is a lie the user discovers by
 *    pressing it. The Escape cap is the one that stayed — it is real.
 *
 * The React render path is not exercised by this suite (see the note in
 * `client-store.test.mjs`), so the behaviour of the pure helpers is tested by
 * importing `src/client/platform.ts` through tsx, and the *wiring* is pinned
 * structurally against the built bundle — including the negative assertions
 * that keep the chord from creeping back in.
 *
 * Usage: node --import tsx tests/client-platform.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { detectPlatform, platformLabels } from '../src/client/platform.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..', 'lib', 'client.js')

/** Count non-overlapping matches of a regex in a string. */
function count(source, pattern) {
  return (source.match(pattern) ?? []).length
}

/** ------------------------------------------------- platform detection tiers */

assert.equal(
  detectPlatform({ userAgentData: { platform: 'macOS' }, platform: 'Win32', userAgent: 'Windows NT 10.0' }),
  'macos',
  'tier 1 (UA-CH) must win over the deprecated navigator.platform',
)

assert.equal(
  detectPlatform({ platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }),
  'macintel',
  'tier 2 (navigator.platform) must be used when UA-CH is absent',
)

// The privacy-mode case: UA-CH undefined and navigator.platform present but
// empty. This is exactly where the old single-test detection lost the Mac.
assert.equal(
  detectPlatform({ userAgentData: { platform: '' }, platform: '', userAgent: 'Mozilla/5.0 (Macintosh)' }),
  'mozilla/5.0 (macintosh)',
  'an empty UA-CH platform and an empty navigator.platform must fall through to the UA string, not to the wrong vocabulary',
)

assert.equal(detectPlatform(undefined), '', 'a missing navigator must yield an empty platform, not throw')
assert.equal(detectPlatform({ platform: 42, userAgent: '' }), '', 'non-string navigator fields must be ignored')
assert.equal(detectPlatform({ userAgentData: { platform: 42 } }), '', 'a non-string UA-CH platform must be ignored')

/** ------------------------------------------------------ label vocabularies */

const mac = platformLabels('macos')
const win = platformLabels('win32')
const linux = platformLabels('linux x86_64')
const unknown = platformLabels('')

assert.equal(mac.escLabel, 'esc', 'macOS spell Escape in lower case')
assert.equal(mac.isMac, true, 'macOS must be detected as macOS')

assert.equal(win.escLabel, 'Esc', 'Windows must capitalise Escape')
assert.equal(win.isWindows, true, 'Win32 must be detected as Windows')

assert.equal(linux.isMac, false, 'Linux is not macOS')

// The degradation contract: an unreadable platform must never render a glyph
// that is meaningless to the user reading it.
assert.equal(unknown.escLabel, 'Esc', 'an unknown platform must degrade to the legible vocabulary')
assert.equal(unknown.isMac, false, 'an unknown platform must not claim to be macOS')

/** ------------------------------------------- wiring, pinned in the bundle */

const source = readFileSync(BUNDLE, 'utf8')

// Code-shaped patterns: doc comments survive bundling, and a bare word count
// would happily match the comment that explains the code.
assert.equal(
  count(source, /\.userAgentData\?\.platform/g),
  1,
  'the UA-CH tier must have exactly one owner in the bundle',
)
assert.equal(count(source, /function detectPlatform\(/g), 1, 'the platform detection must be defined once')
assert.ok(count(source, /detectPlatform\(/g) >= 2, 'detection must be defined and consumed')
assert.ok(count(source, /platformLabels\(/g) >= 2, 'the label vocabulary must be derived through one helper')

// The hotkey is GONE (0.7.0). These are the assertions that keep it gone:
// a reinstated chord matcher, or a second keydown listener, would show up here
// even though nothing on screen would look different.
assert.equal(
  count(source, /isInvokeChord\(/g),
  0,
  'the invoke chord must not come back: nothing in the bundle may match ⌘K / Ctrl+K',
)
assert.equal(count(source, /modLabel/g), 0, 'the chord vocabulary must not come back either')
assert.equal(count(source, /addEventListener\("keydown"/g), 1, 'exactly one keydown listener: Escape, to close the panel')

// One key cap: the footer Escape hint. Plus two stylesheet selectors.
assert.equal(count(source, /"dsws_kbd"/g), 1, 'one key cap must be rendered (Escape)')
assert.ok(count(source, /dsws_kbd/g) >= 3, 'the key-cap stylesheet must ship with its one consumer')

// The borrowed button (0.7.0): the bundle must look the sidebar section's
// native search button up by class and intercept its click, and it must not
// ship the old footer-entry markup any more.
assert.ok(count(source, /dshp-section-actions/g) >= 2, 'the borrowed action group must be located in the bundle')
assert.ok(count(source, /dshp-mini-button/g) >= 2, 'the borrowed button must be matched by class')
assert.equal(count(source, /addEventListener\("click"/g), 1, 'the click hijack must be bound exactly once')
assert.ok(count(source, /createRoot/g) >= 1, 'the panel host must mount into its own React root')
assert.equal(count(source, /dsws_root/g), 0, 'the old footer entry wrapper must be gone')
assert.equal(count(source, /dsws_button/g), 0, 'the old footer entry button must be gone')

console.log(`client-platform: ok (4 vocabularies, 0 chord references, ${count(source, /"dsws_kbd"/g)} key cap)`)
