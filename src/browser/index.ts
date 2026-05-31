/** Browser automation slice (ADR-0427, jun-1-browser-automation). Wave 1: pure
 *  core + deterministic headless stub. The real CDP adapter (system-chrome
 *  spawn) lands in Wave 2 behind this same `BrowserPort`. */

export {
  CDP_ALLOWED_METHODS,
  type CdpAllowedMethod,
  isCdpMethodAllowed,
} from "./cdp-allowlist"
export {
  type HeadlessBrowserOpts,
  type HeadlessPage,
  createHeadlessBrowser,
} from "./headless-stub"
export type { BrowserPort } from "./port"
export { type RefMap, buildSnapshot, createRefMap } from "./snapshot"
export type {
  BrowserError,
  BrowserHandle,
  BrowserStartOpts,
  DomModel,
  DomNode,
  PageSnapshot,
  SnapshotOpts,
  TypeOpts,
} from "./types"
