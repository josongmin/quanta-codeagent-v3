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
import { createSqliteSessionResourceRegistry } from "./sqlite-adapter"
import type { SessionResourceRegistry } from "./types"

let instance: SessionResourceRegistry | null = null

/**
 * ADR-0351 (disk) + ADR-0367 (sqlite) — env-var backend swap.
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
 * Both env vars set ⇒ SQLite wins (more durable + Codex parity).
 *
 * NO-THROW invariant: if any backend's constructor throws (unreadable
 * file, parent dir missing, disk full, etc.) the next fallback in the
 * chain is tried, terminating at in-memory. A misconfigured env var
 * MUST NOT abort process startup. Subsequent calls reuse the same
 * instance per the usual lazy-init contract (env read EXACTLY ONCE
 * per process or per `resetGlobalSessionResourceRegistry()`).
 */
const buildDefaultRegistry = (): SessionResourceRegistry => {
  // 1. SQLite (ADR-0367) — most durable backend wins when both env vars set.
  const sqlitePath = process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH
  if (sqlitePath !== undefined && sqlitePath.length > 0) {
    try {
      return createSqliteSessionResourceRegistry({ databasePath: sqlitePath })
    } catch {
      // SQLite adapter unavailable ⇒ fall through to disk / in-memory
      // so a hosed env var cannot break every quanta process.
    }
  }
  // 2. Disk JSONL (ADR-0351).
  const diskDir = process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
  if (diskDir !== undefined && diskDir.length > 0) {
    try {
      return createDiskSessionResourceRegistry({ storageDir: diskDir })
    } catch {
      // Disk adapter unavailable ⇒ silently fall back so a hosed env
      // var cannot break every quanta process on the machine.
    }
  }
  // 3. In-memory default (ADR-0345).
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
