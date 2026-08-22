/**
 * ADR-0383 — Unified `getOrCreateRegistry(opts)` API.
 *
 * # Context
 *
 * Two registry mint paths coexist in the codebase today:
 *
 *   - ADR-0347 `getGlobalSessionResourceRegistry()` — process-singleton
 *     lazy-init, env-driven backend (sqlite > disk > in-memory),
 *     auto-sweep handle attached.
 *   - ADR-0372 `buildCallerOwnedRegistryWithTelemetry({ emitter })` —
 *     per-call mint that bypasses the singleton so flock telemetry can
 *     thread through the disk-adapter (ADR-0368 documented why the
 *     singleton path cannot be retroactively wired with an emitter).
 *
 * Composition roots that need both shapes import both helpers. This
 * file adds ONE entry point that picks the right path based on a single
 * `callerOwned` flag — purely additive, breaking changes 0.
 *
 * # Decision shape (5 cases)
 *
 *   | opts                                    | result
 *   |-----------------------------------------|----------------------------
 *   | undefined / {}                          | global singleton (ADR-0347)
 *   | { callerOwned: false }                  | global singleton
 *   | { callerOwned: true, metricsEmitter: X }| caller-owned (ADR-0372)
 *   | { callerOwned: true } (no emitter)      | NO-THROW fallback to global
 *   | { metricsEmitter: X } (no callerOwned)  | global (emitter ignored)
 *
 * The "emitter ignored when callerOwned undefined" case is the conscious
 * choice: caller-owned opt-in MUST be explicit. Forwarding an emitter
 * without `callerOwned: true` is a no-op (matches today's global-path
 * behavior — `metricsEmitter` is not threaded through the singleton).
 *
 * # NO-THROW posture
 *
 * `buildCallerOwnedRegistryWithTelemetry` is itself NO-THROW (ADR-0372),
 * but we still wrap the delegation in try/catch + fall through to the
 * global singleton on ANY failure — the surface contract of this entry
 * point is that callers can always treat the return as a usable
 * `SessionResourceRegistry`.
 *
 * # Non-goals (this ADR)
 *
 *   - Deprecating ADR-0347 / ADR-0372 entry points (those keep their
 *     signatures and call sites — future ADR may consolidate).
 *   - Mutating `assemble.ts` / `loop.ts` / `prompt.ts` / `global.ts` /
 *     `caller-owned-builder.ts` (this file is leaf-additive).
 *   - Per-surface multi-tenant registries (ADR-0354 — still out of scope).
 *   - Telemetry on the global singleton path (ADR-0368 deferred path).
 *
 * # Slice fence
 *
 * Imports ONLY the two existing in-slice modules + the `MetricEmitterPort`
 * type from `@/observability/codex-r2-metrics`. NO `assemble.ts` /
 * `installCodexR2Wires` / `loop.ts` imports here — this is a pure
 * factory pick-list.
 */

import type { MetricEmitterPort } from "@/observability/codex-r2-metrics"
import { buildCallerOwnedRegistryWithTelemetry } from "./caller-owned-builder"
import { getGlobalSessionResourceRegistry } from "./global"
import type { SessionResourceRegistry } from "./types"

/**
 * Options bag for the unified mint API.
 *
 * All fields optional. Defaults route to the ADR-0347 global singleton
 * (the additive-non-breaking default).
 */
export interface UnifiedRegistryOptions {
  /** When true, mint a NEW per-call registry instead of using the global
   *  singleton. Default: false (use singleton).
   *
   *  Requires `metricsEmitter` to actually take effect — see file-header
   *  decision table. */
  readonly callerOwned?: boolean

  /** Optional metric emitter — when set together with
   *  `callerOwned: true`, the disk-adapter gets it pre-wired. Mirrors
   *  ADR-0372 caller-owned-builder semantics.
   *
   *  Forwarded without `callerOwned: true` is a no-op (the global
   *  singleton does NOT accept an emitter — see ADR-0368). */
  readonly metricsEmitter?: MetricEmitterPort

  /** Optional sessionId — currently informational. Forwarded to the
   *  caller-owned builder so future ADRs can tag emitter labels with
   *  the session id without a signature break. */
  readonly sessionId?: string
}

/**
 * Unified registry mint.
 *
 * Default behavior (opts absent, `{}`, or `callerOwned !== true`):
 * delegates to {@link getGlobalSessionResourceRegistry} and returns the
 * process singleton — reference-equal to a direct call.
 *
 * Caller-owned behavior (`callerOwned: true` + `metricsEmitter`
 * present): delegates to {@link buildCallerOwnedRegistryWithTelemetry}
 * and returns a FRESH instance with the emitter wired into the
 * disk-adapter (when the disk env var is set).
 *
 * If `callerOwned: true` is set WITHOUT an emitter, the call falls
 * through to the global singleton (caller-owned semantics aren't useful
 * without telemetry — the whole point of ADR-0372 is the emitter).
 *
 * NO-THROW. Surface contract: this function never throws — any internal
 * failure (delegate throwing, etc.) returns the global singleton as a
 * safe last-resort fallback.
 *
 * @param opts mint options (all optional). Absent ⇒ global singleton.
 * @returns a `SessionResourceRegistry` — global singleton or caller-owned
 *          instance per the decision table in the file header.
 */
export const getOrCreateRegistry = (opts?: UnifiedRegistryOptions): SessionResourceRegistry => {
  if (opts?.callerOwned === true && opts.metricsEmitter !== undefined) {
    try {
      const callerOpts: { emitter: MetricEmitterPort; sessionId?: string } = {
        emitter: opts.metricsEmitter,
      }
      if (opts.sessionId !== undefined) {
        callerOpts.sessionId = opts.sessionId
      }
      return buildCallerOwnedRegistryWithTelemetry(callerOpts)
    } catch {
      // NO-THROW fallback: any failure in the caller-owned path lands on
      // the global singleton so the caller still receives a usable
      // registry. ADR-0372's builder is itself NO-THROW, so this catch
      // is a belt-and-braces guard for future regressions.
    }
  }
  // Default path — ADR-0347 process singleton. Reference-equal to a
  // direct `getGlobalSessionResourceRegistry()` call, preserving the
  // additive-non-breaking byte-identical invariant for opts-absent.
  return getGlobalSessionResourceRegistry()
}
