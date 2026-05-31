/**
 * Browser slice — CDP method allowlist (ADR-0427, strengthen #1).
 *
 * ★ This is the quanta differentiator over Cursor. Cursor restricts dangerous
 * CDP methods (Input.* / Storage.* / Cookies.* / Browser.* /
 * Page.setDownloadBehavior / Target.* / System.*) only in the tool's PROSE
 * description — a soft instruction the model can ignore. quanta makes the
 * allowlist a CLOSED SET enforced in code at the `BrowserPort.cdp()` boundary:
 * anything not on this list returns `Err{ cdp-method-denied }`.
 *
 * Asymmetry by design: this gates the MODEL-reachable `browser_cdp` surface
 * only. The adapter's own `click` / `type` implementations may invoke
 * `Input.dispatchMouseEvent` etc. directly — the gate is on what the model can
 * name, not on the implementation.
 *
 * Adding a method here is a SECURITY DECISION. Keep the list minimal: read-only
 * introspection + evaluate. Never add `Input.*`, `Storage.*`, `Cookies.*`,
 * `Browser.*`, `Target.*`, `Page.setDownloadBehavior`, `Page.navigate`,
 * `System.*`, `Fetch.*`, or `Network.setCookie` — those are reachable through
 * the typed verbs (navigate/click/type) under their own gates, not raw CDP.
 */

export const CDP_ALLOWED_METHODS = [
  "Runtime.evaluate",
  "DOM.getDocument",
  "DOM.querySelector",
  "CSS.getComputedStyleForNode",
  "Performance.getMetrics",
  "Log.enable",
  "Network.enable",
] as const

export type CdpAllowedMethod = (typeof CDP_ALLOWED_METHODS)[number]

const ALLOWED: ReadonlySet<string> = new Set(CDP_ALLOWED_METHODS)

/** True iff `method` is on the closed allowlist. Default-deny: unknown,
 *  malformed, or empty method strings are rejected. */
export const isCdpMethodAllowed = (method: string): method is CdpAllowedMethod =>
  ALLOWED.has(method)
