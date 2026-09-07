/**
 * ADR-0347 — Process-level singleton `SessionResourceRegistry`.
 *
 * ADR-0345 shipped the registry slice but composition roots (ADR-0334)
 * still mint a FRESH `{ store, cache }` pair on every call to
 * `installCodexR2Wires`. The same-`sessionId` revisit therefore loses
 * every prior typed-history event AND starts with a cold system-prompt
 * cache — both regressions are silent.
 *
 * This file owns the per-process singleton that the composition roots
 * use to swap "fresh on every call" for "registry.getOrCreate(sessionId)".
 *
 * # Why lazy-init (not eager module-scope)?
 *
 * Test isolation. With an eager `export const registry = createInMemory…()`
 * the registry would be constructed at module-import time and leaks state
 * between test files (every test importing this module would see the
 * same Map). Lazy-init + `resetGlobalSessionResourceRegistry()` gives
 * the test harness a clean knob to reset between assertions while
 * production code still pays the construction cost exactly once.
 *
 * # Why Option A (process-level) over caller-side ownership?
 *
 * The whole point of ADR-0345 is reuse ACROSS composition-root calls.
 * If each composition root carried its own registry instance the
 * second-assemble-same-id reuse would not survive a CLI repl restart
 * (different module instance) OR a web-daemon vs CLI co-tenancy
 * (different surface, different instance). One singleton per node
 * process IS the contract.
 *
 * # Config
 *
 * Runtime-config selects SQLite, disk, or the in-memory default. The selected
 * backend descriptor and sweep config are stored beside the registry so every
 * observer/cleanup consumer shares the same first-call snapshot.
 *
 * # NOT in scope
 *
 *   - Per-host distributed sharing (Redis-class — out of scope)
 *   - Runtime mutation after first use (reset + remint is required)
 */

import { type RuntimeConfig, runtimeConfig } from "@/shared"
import {
  type AutoSweepConfig,
  type AutoSweepHandle,
  autoSweepConfigFromRuntime,
  startAutoSweep,
} from "./auto-sweep"
import { createDiskSessionResourceRegistry } from "./disk-adapter/disk-store"
import { createInMemorySessionResourceRegistry } from "./in-memory-registry"
import { createSqliteSessionResourceRegistry } from "./sqlite-adapter"
import type { SessionResourceRegistry } from "./types"

export type GlobalRegistryBackend =
  | { readonly kind: "in-memory" }
  | { readonly kind: "disk"; readonly path: string }
  | { readonly kind: "sqlite"; readonly path: string }

export interface GlobalSessionResourceRegistryState {
  readonly registry: SessionResourceRegistry
  /** The backend that was actually constructed after the fallback chain. */
  readonly backend: GlobalRegistryBackend
  /** The first-call runtime snapshot projected for every sweep consumer. */
  readonly sweepConfig: AutoSweepConfig
  readonly autoSweepHandle: AutoSweepHandle | null
}

let state: GlobalSessionResourceRegistryState | null = null

/**
 * ADR-0351 (disk) + ADR-0367 (sqlite) — runtime-config backend swap.
 *
 * Priority order on first `getGlobalSessionResourceRegistry()` call:
 *
 *   1. `QUANTA_SESSION_REGISTRY_SQLITE_PATH` (non-empty)
 *      ⇒ `createSqliteSessionResourceRegistry({ databasePath })`
 *      (ADR-0361, most durable: Codex `logs_2.sqlite` WAL parity).
 *   2. `QUANTA_SESSION_REGISTRY_DISK_DIR` (non-empty)
 *      ⇒ `createDiskSessionResourceRegistry({ storageDir })`
 *      (ADR-0348, per-session JSONL files).
 *   3. otherwise ⇒ `createInMemorySessionResourceRegistry()`
 *      (ADR-0345 default, byte-identical to pre-ADR-0351).
 *
 * Both paths set ⇒ SQLite wins (more durable + Codex parity).
 *
 * NO-THROW invariant: if any backend's constructor throws (unreadable
 * file, parent dir missing, disk full, etc.) the next fallback in the
 * chain is tried, terminating at in-memory. A misconfigured path
 * MUST NOT abort process startup. Subsequent calls reuse the same
 * instance per the usual lazy-init contract (runtime snapshot EXACTLY ONCE
 * per process or per `resetGlobalSessionResourceRegistry()`).
 */
const buildDefaultRegistry = (
  cfg: RuntimeConfig,
): Pick<GlobalSessionResourceRegistryState, "registry" | "backend"> => {
  // ADR-0503 P4 — backend selection is routed through the typed runtimeConfig()
  // snapshot (sessionRegistrySqlitePath / sessionRegistryDiskDir) so a
  // `/config set` reaches it. The non-empty guards + NO-THROW fallback chain
  // (sqlite → disk → in-memory) stay byte-identical. Callers MUST pass the
  // same snapshot they hand to `startAutoSweep` — never a second runtimeConfig()
  // read that could diverge.
  // 1. SQLite (ADR-0367) — most durable backend wins when both paths are set.
  const sqlitePath = cfg.sessionRegistrySqlitePath
  if (sqlitePath !== undefined && sqlitePath.length > 0) {
    try {
      return {
        registry: createSqliteSessionResourceRegistry({ databasePath: sqlitePath }),
        backend: { kind: "sqlite", path: sqlitePath },
      }
    } catch {
      // SQLite adapter unavailable ⇒ fall through to disk / in-memory
      // so a hosed runtime path cannot break every quanta process.
    }
  }
  // 2. Disk JSONL (ADR-0351).
  const diskDir = cfg.sessionRegistryDiskDir
  if (diskDir !== undefined && diskDir.length > 0) {
    try {
      return {
        registry: createDiskSessionResourceRegistry({ storageDir: diskDir }),
        backend: { kind: "disk", path: diskDir },
      }
    } catch {
      // Disk adapter unavailable ⇒ silently fall back so a hosed env
      // var cannot break every quanta process on the machine.
    }
  }
  // 3. In-memory default (ADR-0345).
  return {
    registry: createInMemorySessionResourceRegistry(),
    backend: { kind: "in-memory" },
  }
}

const getOrCreateGlobalState = (): GlobalSessionResourceRegistryState => {
  if (state !== null) return state
  const cfg = runtimeConfig()
  const mounted = buildDefaultRegistry(cfg)
  const sweepConfig = autoSweepConfigFromRuntime(cfg)
  let autoSweepHandle: AutoSweepHandle | null = null
  try {
    autoSweepHandle = startAutoSweep(sweepConfig)
  } catch {
    // Registry construction succeeded; a timer wiring failure must not discard it.
  }
  state = { ...mounted, sweepConfig, autoSweepHandle }
  return state
}

/** Canonical process state for registry consumers that need backend provenance. */
export const getGlobalSessionResourceRegistryState = (): GlobalSessionResourceRegistryState =>
  getOrCreateGlobalState()

/**
 * Get-or-mint the process-level singleton. First call constructs the
 * default registry (SQLite, disk, then in-memory fallback from the frozen
 * runtime snapshot); every subsequent call returns the SAME
 * reference. Composition roots call this exactly once per
 * `installCodexR2Wires` to look up (or mint) the session resources.
 */
export const getGlobalSessionResourceRegistry = (): SessionResourceRegistry => {
  return getOrCreateGlobalState().registry
}

/** Test seam — the auto-sweep handle minted on the same first-call path as
 *  the registry singleton. `null` before first get / after reset. */
export const peekGlobalAutoSweepHandle = (): AutoSweepHandle | null =>
  state?.autoSweepHandle ?? null

export type GlobalRegistrySweepOutcome =
  | { readonly kind: "swept" }
  | { readonly kind: "not-configured" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed"; readonly attempted: number }
  | {
      readonly kind: "partial"
      readonly attempted: number
      readonly succeeded: number
      readonly failed: number
    }

/**
 * Run an immediate sweep through the handle owned by the singleton lifecycle.
 * This prevents operator cleanup from minting a second timer or re-reading a
 * newer runtime-config snapshot than the mounted registry.
 */
export const sweepGlobalSessionResourceRegistryNow =
  async (): Promise<GlobalRegistrySweepOutcome> => {
    const current = getOrCreateGlobalState()
    const hasDurableBackend =
      (current.sweepConfig.sqlitePath?.length ?? 0) > 0 ||
      (current.sweepConfig.diskDir?.length ?? 0) > 0
    if (!hasDurableBackend) return { kind: "not-configured" }
    if (current.autoSweepHandle === null) return { kind: "unavailable" }
    const result = await current.autoSweepHandle.sweepNowWithOutcome()
    if (result.failed === result.attempted) {
      return { kind: "failed", attempted: result.attempted }
    }
    if (result.failed > 0) {
      return { kind: "partial", ...result }
    }
    return { kind: "swept" }
  }

/**
 * Test reset — drop the singleton so the next
 * `getGlobalSessionResourceRegistry()` mints a fresh one. Calling this
 * in production is harmless but pointless: the prior registry instance
 * becomes garbage as soon as no caller holds a reference.
 */
export const resetGlobalSessionResourceRegistry = (): void => {
  // ADR-0369 — Stop the auto-sweep timer BEFORE clearing the instance so
  // the next `getGlobalSessionResourceRegistry()` call mints a fresh
  // registry AND a fresh sweep handle. `stop()` is NO-THROW + idempotent
  // (see `auto-sweep.ts`), so it is safe whether or not a handle exists.
  if (state?.autoSweepHandle !== null && state?.autoSweepHandle !== undefined) {
    state.autoSweepHandle.stop()
  }
  state = null
}
