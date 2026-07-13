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
 *
 * ── SAFETY ──
 *
 * Observability MUST NOT break the loop. Every public function is wrapped so it
 * NEVER throws — a logger/registry hiccup is swallowed. It is allocation-cheap
 * (one record object per spawn ATTEMPT, a low-frequency event) and gated on
 * nothing (the log line self-gates on the `debug` threshold).
 *
 * This is a LEAF module (imports only `@/observability` + local types), so it
 * cannot participate in the ADR-0436 `features.ts` import cycle that constrains
 * `spawn-depth.ts`.
 */

import { log, Metrics } from "@/observability"

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
