/**
 * Sub-agent nesting control — Phase 2 depth-flow OBSERVABILITY (RFC
 * docs/plans/jul-13-subagent-nesting-control.md §4.5 / §8, rev.4 MANDATORY).
 *
 * WHY THIS EXISTS: the depth holes Phases 0-1 closed were found because the
 * depth-flow was OPAQUE — nothing recorded, at the spawn decision point, whether
 * the EXPOSURE decision (projectSpawnTools) and the RUNTIME REJECT (the runner)
 * agreed. Phase 2 adds MINIMAL telemetry co-located with the reject so a future
 * hole surfaces in metrics instead of silently re-opening.
 *
 * SCOPE (§4.5 — kept MINIMAL): this is ONLY the depth-flow invariant. It is NOT
 * the Phase-3 `SubAgentSource` taxonomy (backlog). At each spawn DECISION we
 * capture `{ parentDepth, childDepth, maxDescendantDepth, toolExposed, decision }`
 * and emit it.
 *
 * ── CORE INVARIANT (§4.5, the split-brain regression detector) ──
 *
 *   `toolExposed === true && decision === "denied_by_depth"` MUST be 0 on the
 *   normal production path.
 *
 * The projection (exposure) and the runtime reject use the SAME `effectiveCap` +
 * lineage depth, so a spawn tool is exposed to a parent IFF that parent's forked
 * child would be admitted (`canExposeSpawnTools(parentDepth, cap)` ⇔
 * `canAdmitChildDepth(parentDepth + 1, cap)`). Therefore an exposed tool that is
 * then DENIED at the runtime reject is a contradiction — the exact class of bug
 * (exposure and reject disagreeing) that let the original holes exist. The
 * dedicated `splitBrain` counter goes >0 ONLY when someone makes them disagree.
 *
 * ── SEAM (§8.1) ──
 *
 * Reuses the EXISTING observability seams — no new sink is invented:
 *   1. `@/observability` `StructuredLogger` (`log`) — one JSON-per-line
 *      `agent.spawn.admission.v1` record (machine-consumable, level `debug`).
 *   2. `@/observability` `Metrics` — a module-local registry with a counter per
 *      `decision` (low cardinality) plus the `splitBrain` regression counter.
 *      A module-local `Metrics` (not the shared `metrics` singleton) keeps the
 *      snapshot deterministic for tests and avoids cross-test contamination.
 *   3. OPERATOR VISIBILITY (jul-15): the `debug` line above is suppressed at the
 *      default `info` log level, and the split-brain COUNTER was read only by
 *      tests — so a REAL split-brain was operator-INVISIBLE in production. When
 *      (and ONLY when) the invariant is violated we ALSO emit ONE `warn`-level
 *      structured line (`agent.spawn.admission.split_brain`) through the SAME
 *      `StructuredLogger` seam. `warn >= info`, so it surfaces at the default
 *      level WITHOUT requiring `QUANTA_LOG_LEVEL=debug`. A split-brain is a rare,
 *      high-signal regression event, so this cannot spam the normal (0) path —
 *      the honest admit/deny path emits no `warn` at all.
 *
 * ── SAFETY ──
 *
 * Observability MUST NOT break the loop. Every public function is wrapped so it
 * NEVER throws — a logger/registry hiccup is swallowed. It is allocation-cheap
 * (one record object per spawn ATTEMPT, a low-frequency event); the `.v1` line
 * self-gates on the `debug` threshold and the split-brain `warn` line self-gates
 * on `warn` (emitted only when the invariant is violated).
 *
 * This is a LEAF module (imports only `@/observability` + local types), so it
 * cannot participate in the ADR-0436 `features.ts` import cycle that constrains
 * `spawn-depth.ts`.
 */

import { log, Metrics, StructuredLogger } from "@/observability"
import type { LogLevel } from "@/shared"

/** The terminal decision for a single spawn attempt (§4.5). Closed union — a new
 *  decision kind forces every switch/Record over it to be updated. */
export type SpawnDepthDecision = "admitted" | "denied_by_depth" | "denied_malformed"

/** The depth-flow record captured at EACH spawn decision (§4.5). Low-cardinality
 *  numeric fields only — no session/agent/task ids (INV-12). */
export interface SpawnDepthDecisionRecord {
  /** The REAL parent config depth (`parent.depth ?? 0`); root === 0. */
  readonly parentDepth: number
  /** The lineage-derived child depth (`childDepthOf`-derived === parentDepth+1).
   *  `null` when the parent depth was malformed (no valid child depth exists). */
  readonly childDepth: number | null
  /** The EFFECTIVE cap the reject used (`effectiveCap(...)` = min(policy, requested)). */
  readonly maxDescendantDepth: number
  /** Was the spawn tool present in THIS parent's tool set — i.e. would
   *  `projectSpawnTools` have exposed it (`canExposeSpawnTools(parentDepth,cap)`)?
   *  This is the EXPOSURE side of the split-brain invariant. */
  readonly toolExposed: boolean
  /** The terminal admission decision at the runtime reject. */
  readonly decision: SpawnDepthDecision
}

/** Module-local metrics registry (NOT the shared `metrics` singleton) so the
 *  snapshot is deterministic and test-isolated. */
let registry = new Metrics()

/** Counter name for the per-decision tally (low-cardinality label = the
 *  decision kind, §8.2 / INV-12). */
const decisionCounterName = (decision: SpawnDepthDecision): string =>
  `agent.spawn.admission.${decision}`

/** The SPLIT-BRAIN regression counter (§4.5 CORE INVARIANT). >0 iff a spawn tool
 *  was EXPOSED yet DENIED by depth — exposure and reject disagreeing. On the
 *  normal production path this is always 0. */
export const SPAWN_DEPTH_SPLIT_BRAIN_COUNTER = "agent.spawn.admission.split_brain"

/** The OPERATOR-VISIBLE logger for the split-brain warn line (jul-15). Defaults
 *  to the shared `log` (stderr, whose threshold is `runtimeConfig().logLevel` —
 *  `warn >= info`, so it surfaces at the default level). Test-swappable via
 *  `__setSpawnDepthLogSink` so the emitted line can be captured WITHOUT touching
 *  the env or stderr — mirrors the `__reset*` seams elsewhere. */
let splitBrainLogger: StructuredLogger = log

/**
 * Emit the depth-flow decision at a spawn DECISION point (§4.5). Reuses the
 * childDepthOf/effectiveCap results already computed by the runner — it does NOT
 * recompute admission. Increments the per-decision counter, the split-brain
 * counter when the invariant is violated, and writes one structured log line.
 *
 * NEVER THROWS: observability must not break the agent loop. A logger/registry
 * failure is swallowed (best-effort). Returns nothing.
 */
export const emitSpawnDepthDecision = (record: SpawnDepthDecisionRecord): void => {
  try {
    registry.counter(decisionCounterName(record.decision)).inc()
    // CORE INVARIANT (§4.5): a tool that was EXPOSED must never be DENIED by
    // depth — exposure ⇔ admission. This counter is the regression detector.
    if (record.toolExposed && record.decision === "denied_by_depth") {
      registry.counter(SPAWN_DEPTH_SPLIT_BRAIN_COUNTER).inc()
      // OPERATOR VISIBILITY (jul-15): surface the regression at `warn` so it is
      // visible at the default `info` log level (warn >= info) WITHOUT requiring
      // debug. This branch is reached ONLY when the invariant is violated — a
      // rare, high-signal event — so the normal (0 split-brain) path stays quiet.
      splitBrainLogger.warn(SPAWN_DEPTH_SPLIT_BRAIN_COUNTER, {
        parentDepth: record.parentDepth,
        childDepth: record.childDepth,
        maxDescendantDepth: record.maxDescendantDepth,
        toolExposed: record.toolExposed,
        decision: record.decision,
      })
    }
    log.debug("agent.spawn.admission.v1", {
      parentDepth: record.parentDepth,
      childDepth: record.childDepth,
      maxDescendantDepth: record.maxDescendantDepth,
      toolExposed: record.toolExposed,
      decision: record.decision,
    })
  } catch {
    // Observability is best-effort — a sink/registry hiccup MUST NOT abort the
    // spawn decision. Swallow.
  }
}

/** Current split-brain counter value — 0 on the normal production path. Test /
 *  monitor readback for the §4.5 regression detector. Never throws. */
export const spawnDepthSplitBrainCount = (): number => {
  try {
    return registry.counter(SPAWN_DEPTH_SPLIT_BRAIN_COUNTER).value()
  } catch {
    return 0
  }
}

/** Snapshot of the depth-decision counters (deterministic; module-local
 *  registry). Test / monitor readback. Never throws. */
export const spawnDepthTelemetrySnapshot = (): Record<string, number> => {
  try {
    return registry.snapshot().counters
  } catch {
    return {}
  }
}

/** Reset the module-local telemetry registry (tests only — mirrors the
 *  `__reset*` seams elsewhere). */
export const __resetSpawnDepthTelemetry = (): void => {
  registry = new Metrics()
}

/** Redirect the split-brain warn line to a captured sink at a chosen threshold
 *  (tests only). Lets a suite assert the operator-visible line surfaces at the
 *  DEFAULT (`info`) level without touching env/stderr. `level` defaults to
 *  `info` — the production default — so a `warn` line lands but a `debug` line
 *  would not. */
export const __setSpawnDepthLogSink = (
  sink: (line: string) => void,
  level: LogLevel = "info",
): void => {
  splitBrainLogger = new StructuredLogger({ level, sink })
}

/** Restore the split-brain logger to the shared production `log` (tests only). */
export const __resetSpawnDepthLogSink = (): void => {
  splitBrainLogger = log
}
