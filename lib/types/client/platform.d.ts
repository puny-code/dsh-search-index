/**
 * Platform detection and the keyboard-label vocabulary, for the client half.
 *
 * Why this module exists
 * ----------------------
 * A key-cap hint is the one place where a single hard-coded string is wrong for
 * most users: `esc` is the macOS spelling of the Escape key, `Esc` the one
 * everywhere else. The obvious implementation — one `navigator.platform` test —
 * is also the fragile one: that API is deprecated, and it returns an empty
 * string in some privacy configurations, which silently degrades every Mac user
 * to the Windows vocabulary without any error to notice.
 *
 * This module is the single owner of both the platform answer and every label
 * derived from it, so a platform fix cannot land in one consumer and miss
 * another.
 *
 * The invoke chord (`⌘K` / `Ctrl K`) used to live here too. It is gone: the
 * chord was advertised but never fired reliably, and the panel is opened from
 * the sidebar's own search button instead (see `SearchHost` in `index.ts`), so
 * the only label still rendered is the Escape key cap in the panel footer.
 */
/** The navigator fields the detection reads (all optional, all untrusted). */
export interface NavigatorLike {
    userAgentData?: {
        platform?: unknown;
    };
    platform?: unknown;
    userAgent?: unknown;
}
/**
 * Resolve the running platform string, three tiers deep.
 *
 * 1. UA-CH (`navigator.userAgentData.platform`) — modern and precise.
 * 2. `navigator.platform` — broadly available, deprecated, and empty in some
 *    privacy modes.
 * 3. The UA string — last resort, still non-empty in practice.
 *
 * @param nav - the navigator to read; `undefined` is allowed (non-DOM host).
 * @returns a lower-cased platform string, or `''` when nothing could be read.
 */
export declare function detectPlatform(nav: NavigatorLike | undefined): string;
/** The keyboard vocabulary for one platform. */
export interface PlatformLabels {
    /** The lower-cased platform string these labels were derived from. */
    platform: string;
    isMac: boolean;
    isWindows: boolean;
    /** Escape: `esc` is the macOS spelling, `Esc` the one everywhere else. */
    escLabel: string;
}
/**
 * Derive the label vocabulary from a platform string.
 *
 * An unrecognised platform — an empty string, or a UA that names neither
 * system — takes the non-Mac vocabulary on purpose: `Esc` is legible to
 * everyone, while the lower-case `esc` is a macOS keyboard legend.
 *
 * @param platform - the string produced by {@link detectPlatform}.
 * @returns the label vocabulary for that platform.
 */
export declare function platformLabels(platform: string): PlatformLabels;
/** The labels for the platform this bundle is running on. */
export declare const LABELS: PlatformLabels;
//# sourceMappingURL=platform.d.ts.map