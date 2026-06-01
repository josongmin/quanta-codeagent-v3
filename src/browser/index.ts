/** Browser automation slice (ADR-0427, jun-1-browser-automation). Wave 1: pure
 *  core + deterministic headless stub. Wave 2: the real CDP adapter
 *  (system-chrome spawn) behind the same `BrowserPort`, with all IO injected. */

export {
  defaultBrowserFs,
  defaultCdpTransport,
  defaultProcessSpawner,
  realClock,
  realScheduler,
} from "./cdp/defaults"
export type {
  BrowserFs,
  CdpConnection,
  CdpTransport,
  Clock,
  ProcessSpawner,
  Scheduler,
  SpawnedProcess,
} from "./cdp/ports"
export {
  type CdpBrowserDeps,
  createCdpBrowser,
  DEFAULT_CHROME_CANDIDATES,
  DEFAULT_MAC_CHROME_PATHS,
  resolveChromeBinary,
} from "./cdp-adapter"
export {
  CDP_ALLOWED_METHODS,
  type CdpAllowedMethod,
  isCdpMethodAllowed,
} from "./cdp-allowlist"
export {
  createHeadlessBrowser,
  type HeadlessBrowserOpts,
  type HeadlessPage,
} from "./headless-stub"
export type { BrowserPort } from "./port"
export { buildSnapshot, createRefMap, type RefMap } from "./snapshot"
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
