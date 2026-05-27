/**
 * ADR-0372 — Caller-owned registry builder with flock telemetry.
 *
 * # Context
 *
 * ADR-0364 added an optional `metricsEmitter` slot to `DiskRegistryConfig`
 * so the per-session lock acquire / release / timeout / stale-reclaim
 * counters land on a {@link MetricEmitterPort}. ADR-0368 documented that
 * the wire CANNOT be threaded through the global lazy-init singleton
 * (ADR-0347) — the singleton was minted before any per-call `cfg.metrics`
 * was visible, and the four design alternatives (env var, signature
 * change, factory pattern, etc.) all broke either the first-call-wins
 * lazy-init invariant OR the "one observability surface" multi-tenant
 * future (ADR-0354).
 *
 * This file ships the **caller-owned-registry** path ADR-0368 promised:
 * a composition root that already owns a `MetricsRegistry` (via
 * `cfg.metrics`) bypasses the global singleton and mints a FRESH
 * registry with the `metricsEmitter` injected. The result is an
 * orthogonal slice: the global singleton path stays unchanged
 * (byte-identical for hosts that do NOT thread metrics), and the
 * caller-owned path picks up flock telemetry "for free" without
 * touching `global.ts` at all.
 *
 * # Env priority — mirror of global.ts (ADR-0347 + ADR-0351 + ADR-0367)
 *
 *   1. `QUANTA_SESSION_REGISTRY_SQLITE_PATH` ⇒ sqlite backend (NO emit —
 *      WAL handles concurrency; no flock concept).
 *   2. `QUANTA_SESSION_REGISTRY_DISK_DIR`    ⇒ disk-adapter with
 *      `metricsEmitter` injected ⇒ flock telemetry active.
 *   3. otherwise ⇒ in-memory adapter (NO emit — no lock either).
 *
 * # Non-goals
 *
 *   - Mutating `global.ts` or its lazy-init contract.
 *   - Threading an emitter through the global singleton.
 *   - Per-surface multi-tenant registries (ADR-0354 — out of scope).
 *   - Sqlite emitter wiring (WAL already covers concurrency).
 *   - In-memory emitter wiring (no lock to telemeter).
 *
 * # NO-THROW posture
 *
 * The builder wraps each backend constructor in try/catch + falls
 * through to the next-best fallback (sqlite → disk → in-memory), same
 * shape as `global.ts::buildDefaultRegistry`. A hostile `metricsEmitter`
 * cannot poison the registry — the disk-adapter already wraps emit in
 * `safeEmit` (ADR-0364), and the emitter port contract is best-effort.
 *
 * # Slice fence
 *
 * Imports ONLY the sibling adapter factories + the `MetricEmitterPort`
 * type from `@/observability/codex-r2-metrics`. NO `assemble.ts` /
 * `installCodexR2Wires` / `loop.ts` imports here — the builder is a
 * pure factory.
 */

import type { MetricEmitterPort } from "@/observability/codex-r2-metrics"
import { createDiskSessionResourceRegistry } from "./disk-adapter/disk-store"
import { createInMemorySessionResourceRegistry } from "./in-memory-registry"
import { createSqliteSessionResourceRegistry } from "./sqlite-adapter"
import type { SessionResourceRegistry, SessionResources } from "./types"

/**
 * Construction-time options for the caller-owned builder.
 *
 * - `emitter` — REQUIRED. The telemetry sink that disk-adapter forwards
 *   to {@link acquireSessionLock} when the disk env path is taken.
 * - `sessionId` — OPTIONAL. Currently informational only; reserved so
 *   future ADRs can tag emitter labels with the session id without a
 *   signature break.
 */
export interface CallerOwnedBuilderOpts {
  readonly emitter: MetricEmitterPort
  readonly sessionId?: string
}

/**
 * Mint a fresh `SessionResourceRegistry` instance (bypassing the
 * `global.ts` singleton) with the supplied `metricsEmitter` injected
 * into the disk-adapter when the disk env var is set.
 *
 * Behavior matches `global.ts::buildDefaultRegistry` priority chain
 * EXCEPT for emitter threading on the disk path. Every call returns a
 * NEW instance — there is no caller-side singleton (the WHOLE POINT
 * is to escape the lazy-init mismatch ADR-0368 documented).
 *
 * NO-THROW. The builder NEVER throws — every backend constructor is
 * wrapped, and the final fallback (in-memory) cannot fail.
 */
export const buildCallerOwnedRegistryWithTelemetry = (
  opts: CallerOwnedBuilderOpts,
): SessionResourceRegistry => {
  const { emitter } = opts
  // 1. SQLite (ADR-0367) — most durable. NO emitter wiring (WAL
  //    handles concurrency; no flock to telemeter).
  const sqlitePath = process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH
  if (sqlitePath !== undefined && sqlitePath.length > 0) {
    try {
      return createSqliteSessionResourceRegistry({ databasePath: sqlitePath })
    } catch {
      // SQLite unavailable ⇒ fall through.
    }
  }
  // 2. Disk JSONL (ADR-0348 + ADR-0356 flock + ADR-0364 telemetry).
  //    The emitter is injected here — this is the WHOLE POINT of the
  //    caller-owned path.
  const diskDir = process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
  if (diskDir !== undefined && diskDir.length > 0) {
    try {
      return createDiskSessionResourceRegistry({
        storageDir: diskDir,
        metricsEmitter: emitter,
      })
    } catch {
      // Disk unavailable ⇒ fall through to in-memory.
    }
  }
  // 3. In-memory default — NO emitter wiring (no lock to telemeter).
  return createInMemorySessionResourceRegistry()
}

/**
 * Convenience wrapper around `registry.getOrCreate(sessionId)`.
 *
 * Equivalent to `registry.getOrCreate(sessionId)` — exists as a named
 * function so composition-root call sites read symmetrically with the
 * global path (`getGlobalSessionResourceRegistry().getOrCreate(id)`
 * vs. `buildCallerOwnedSessionResources(id, reg)`).
 */
export const buildCallerOwnedSessionResources = (
  sessionId: string,
  registry: SessionResourceRegistry,
): SessionResources => registry.getOrCreate(sessionId)
