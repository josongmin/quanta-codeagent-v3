import { assertWorkspaceTrusted } from "../workspace-trust"

/** Probe whether a server binary is launchable. Cached per process so a single
 *  agent run does not re-spawn `--version` for every diagnostics call. */
/** Wall-clock budget for the `<bin> --version` availability probe. Set short
 *  because the probe blocks tool registration / agent startup; a missing or
 *  hung binary must NOT delay the whole session. */
const LSP_AVAILABILITY_TIMEOUT_MS = 5_000

// Cache the in-flight PROBE PROMISE, not the resolved bool. Concurrent
// `isAvailable(bin)` callers (multiple LSP-backed tools initializing at once)
// then share ONE `bin --version` subprocess instead of each racing a cache miss
// and spawning a duplicate. The probe never rejects (errors resolve to `false`),
// so a cached promise is always a settled, reusable result.
//
// Cache ONLY successes (audit #4): a `false` result is evicted once it settles
// so a single transient failure — the 5s race timeout firing under startup
// CPU/IO contention — does NOT permanently disable EVERY LSP surface
// process-wide. Without this, one flaky `bin --version` poisons the cache and
// every later `open()` short-circuits to null + reports "not installed" even
// though the binary IS installed (the recurring "LSP inert" footgun). A cached
// `true` stays permanent (the binary cannot un-install mid-process); concurrent
// callers still share the in-flight probe (it is evicted only AFTER it resolves
// false), so the dedup guarantee is preserved. Mirrors a reset-on-failure
// `once` memoizer.
const availabilityCache = new Map<string, Promise<boolean>>()
let availabilityOverrideForTest: ((bin: string) => boolean | Promise<boolean>) | null = null
const probeAvailable = async (bin: string): Promise<boolean> => {
  try {
    const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "pipe" })
    const exit = await Promise.race([
      proc.exited,
      new Promise<number>((r) => setTimeout(() => r(-1), LSP_AVAILABILITY_TIMEOUT_MS)),
    ])
    try {
      proc.kill()
    } catch {
      // already exited
    }
    // Reap the child after kill so no process handle is left dangling. The
    // await is post-kill so it resolves promptly; `.catch` keeps it defensive.
    await proc.exited.catch(() => undefined)
    // Non-zero `--version` still proves the binary resolves; -1 = our timeout.
    return exit !== -1
  } catch {
    return false
  }
}
const cachedProbe = (bin: string): Promise<boolean> => {
  if (availabilityOverrideForTest !== null) {
    return Promise.resolve(availabilityOverrideForTest(bin))
  }
  const cached = availabilityCache.get(bin)
  if (cached !== undefined) return cached
  const probe = probeAvailable(bin).then((ok) => {
    // Evict a settled `false` so a transient miss is re-probed next call; a
    // `true` is left cached (permanent, the binary stays installed). The
    // in-flight promise is still shared by concurrent callers above — eviction
    // only happens after it resolves, so the dedup invariant holds.
    if (!ok && availabilityCache.get(bin) === probe) availabilityCache.delete(bin)
    return ok
  })
  availabilityCache.set(bin, probe)
  return probe
}

/**
 * Whether `bin` launches, asked for a session in `trustRoot`. Rejects with
 * `WorkspaceUntrustedError` when that folder is not trusted — before the cache, the test
 * override, or any spawn.
 *
 * The probe runs `<bin> --version` with the agent's environment, and `bin` resolves on
 * PATH, which a workspace can lead (direnv `PATH_add`, an activated venv, npm-run's
 * `node_modules/.bin`). Every surface asked this BEFORE the trust gate, so an untrusted
 * folder's own `gopls` / `pyright-langserver` ran with the API key and only then was the
 * launch refused (reported by the sep-14 lane B session, reproduced). `trustRoot` is
 * required so no caller can ask without saying for which folder. Once trust is
 * established the answer does not depend on the folder, so the cache stays keyed by bin.
 */
export const isAvailable = async (bin: string, trustRoot: string): Promise<boolean> => {
  assertWorkspaceTrusted(`Language server ${bin}`, trustRoot)
  return cachedProbe(bin)
}

/** Production-safe availability probe for one language-server binary. Shares
 *  the same per-process cache as the tool surfaces, so a bench preflight and
 *  the later tool/session open do not double-spawn `--version`. */
export const lspBinaryAvailable = (bin: string, trustRoot: string): Promise<boolean> =>
  isAvailable(bin, trustRoot)

/** TEST-ONLY: clear the per-process availability cache. The cache is a module
 *  singleton (one `bin --version` per process by design — see above), so a test
 *  that probes a real binary leaks a cached `true` into a later test that
 *  overrides `PATH` to force a miss, making the suite order-dependent / flaky.
 *  Resetting in `beforeEach` restores per-test isolation. Mirrors the
 *  `__drain*ForTest` seams elsewhere; NEVER called in production. */
export const __resetLspAvailabilityCacheForTest = (): void => {
  availabilityCache.clear()
}

/** TEST-ONLY: override binary-availability answers so higher-level callers can
 *  drive strict fail-closed rails without depending on the host's installed
 *  language servers. null restores the real cached probe. */
export const __setLspAvailabilityOverrideForTest = (
  override: ((bin: string) => boolean | Promise<boolean>) | null,
): void => {
  availabilityOverrideForTest = override
  availabilityCache.clear()
}

/** TEST-ONLY: drive the cached availability probe for one binary so a unit test
 *  can prove the "cache only successes" contract (audit #4) — a first probe that
 *  resolves `false` (binary off `PATH`) must NOT poison a later probe once the
 *  binary is reachable. Mirrors the other `__*ForTest` seams; NEVER called in
 *  production. */
export const __isLspAvailableForTest = (bin: string): Promise<boolean> => cachedProbe(bin)

/** TEST-ONLY: report whether a binary currently has a cached availability entry.
 *  Lets a unit test prove that a settled `false` is EVICTED (cache miss) while a
 *  `true` is RETAINED (cache hit) — the core of the "cache only successes"
 *  contract (audit #4). NEVER called in production. */
export const __hasCachedLspAvailabilityForTest = (bin: string): boolean =>
  availabilityCache.has(bin)
