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
 * Default `createInMemorySessionResourceRegistry()` — no `maxEntries`,
 * no `idleTtlMs`. Production callers responsible for size if it matters.
 * A follow-up ADR can expose knobs (env vars, config slot) without
 * changing the call-site shape here.
 *
 * # NOT in scope
 *
 *   - Disk persistence (separate ADR; sqlite/jsonl)
 *   - Per-host distributed sharing (Redis-class — out of scope)
 *   - Config knobs (maxEntries / idleTtlMs) on the singleton
 */

import { createDiskSessionResourceRegistry } from "./disk-adapter/disk-store"
import { createInMemorySessionResourceRegistry } from "./in-memory-registry"
import type { SessionResourceRegistry } from "./types"

let instance: SessionResourceRegistry | null = null

/**
 * ADR-0351 — Disk adapter env-var swap.
 *
 * When `QUANTA_SESSION_REGISTRY_DISK_DIR` env var is set (and non-empty)
 * the first `getGlobalSessionResourceRegistry()` call mints a
 * `createDiskSessionResourceRegistry({ storageDir })` instead of the
 * in-memory default. Subsequent calls reuse the same instance per the
 * usual lazy-init contract. Absent env var ⇒ legacy in-memory path
 * (byte-identical to pre-ADR-0351). NO-THROW: if the disk adapter
 * throws on construction we fall back to in-memory + log nothing —
 * a misconfigured env var must not abort process startup.
 */
const buildDefaultRegistry = (): SessionResourceRegistry => {
  const diskDir = process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
  if (diskDir !== undefined && diskDir.length > 0) {
    try {
      return createDiskSessionResourceRegistry({ storageDir: diskDir })
    } catch {
      // Disk adapter unavailable ⇒ silently fall back so a hosed env
      // var cannot break every quanta process on the machine.
    }
  }
  return createInMemorySessionResourceRegistry()
}

/**
 * Get-or-mint the process-level singleton. First call constructs the
 * default registry (disk-backed when `QUANTA_SESSION_REGISTRY_DISK_DIR`
 * is set, in-memory otherwise); every subsequent call returns the SAME
 * reference. Composition roots call this exactly once per
 * `installCodexR2Wires` to look up (or mint) the session resources.
 */
export const getGlobalSessionResourceRegistry = (): SessionResourceRegistry => {
  if (instance === null) instance = buildDefaultRegistry()
  return instance
}

/**
 * Test reset — drop the singleton so the next
 * `getGlobalSessionResourceRegistry()` mints a fresh one. Calling this
 * in production is harmless but pointless: the prior registry instance
 * becomes garbage as soon as no caller holds a reference.
 */
export const resetGlobalSessionResourceRegistry = (): void => {
  instance = null
}
