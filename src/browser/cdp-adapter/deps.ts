/**
 * Browser slice — CDP adapter dependency contract + chrome-binary discovery
 * (extracted from `../cdp-adapter.ts` to keep that orchestrator under the
 * god-module line cap, and to break a would-be import cycle between the adapter
 * and its `./bring-up` helper which also needs {@link CdpBrowserDeps}).
 */

import type { BrowserFs, CdpTransport, Clock, ProcessSpawner, Scheduler } from "../cdp/ports"

export const DEFAULT_CHROME_CANDIDATES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
] as const

export const DEFAULT_MAC_CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
] as const

export interface CdpBrowserDeps {
  readonly spawner: ProcessSpawner
  readonly transport: CdpTransport
  readonly fs: BrowserFs
  readonly scheduler: Scheduler
  readonly clock: Clock
  /** Directory (already inside the fs-jail, supplied by the tool layer) under
   *  which each session's isolated profile is created. */
  readonly profileRoot: string
  readonly chromeCandidates?: readonly string[]
  readonly macPaths?: readonly string[]
  readonly endpointTimeoutMs?: number
  /** Default deadline for one connected CDP command. Production callers may
   *  omit it to retain the session's 30-second default; pressure-aware test
   *  composition roots can inject the same bounded budget as their watchdog. */
  readonly commandTimeoutMs?: number
}

export const resolveChromeBinary = (
  deps: Pick<CdpBrowserDeps, "spawner" | "fs" | "chromeCandidates" | "macPaths">,
): string | null => {
  for (const cmd of deps.chromeCandidates ?? DEFAULT_CHROME_CANDIDATES) {
    const found = deps.spawner.which(cmd)
    if (found !== null) return found
  }
  for (const p of deps.macPaths ?? DEFAULT_MAC_CHROME_PATHS) {
    if (deps.fs.existsSync(p)) return p
  }
  return null
}
