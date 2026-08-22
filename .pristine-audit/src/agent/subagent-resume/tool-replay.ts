/**
 * Tool-history replay strategy + orchestrator (ADR-0174 Phase 3).
 *
 * For each persisted {@link ToolCallRecord} attached to a handle being
 * resumed, decide how to handle the call and (for mutating tiers) signal the
 * shadow-ODB workspace restore.
 *
 * Industry pattern (verified consensus): cache-the-output (Option A). The
 * cached `result` is the canonical truth — even when the tier is
 * `"mutating-external"` we DO NOT re-execute the side effect (would duplicate
 * the network/shell action); we surface the captured output to the LLM as if
 * the tool ran again. This mirrors OpenHands EventStream, Aider git replay,
 * Cursor BackgroundComposer, Claude Code `--resume` `toolUseResult`, Codex
 * `function_call_output`.
 *
 * Cache MISS:
 *   - pure                  → safe-re-run (idempotent by definition).
 *   - mutating-recoverable  → halt (data loss risk; no shadow anchor exists
 *                             to restore the workspace to the pre-call state).
 *   - mutating-external     → ask-user-confirm (caller decides whether
 *                             re-running the side effect is acceptable).
 *
 * UNKNOWN tier (from a custom classifier or a tampered record) → halt
 * (defensive — never silently default to "pure" on an unknown classification).
 *
 * Plane-clean: imports ONLY `./idempotency`, `./tool-history` (siblings). NO
 * `@/storage/shadow-odb` — the restore wire is a NARROW closed port
 * ({@link ShadowCommitRestorer}) the caller injects, so this slice does not
 * depend on shadow-odb's full surface (and shadow-odb cannot be modified per
 * the work-order). NO `@/agent/loop`, `@/agent/dispatch`, `@/llm`,
 * `@/permission`, `@/tool`.
 */

import { errMessage } from "@/shared"
import {
  defaultIdempotencyClassifier,
  type IdempotencyClassifier,
  type IdempotencyTier,
} from "./idempotency"
import type { ToolCallRecord } from "./tool-history"
/** Decision arm for one tool call. Exhaustive 4-way union — caller branches
 *  on `action` and consumes the relevant fields. */
export type ToolReplayDecision =
  | { readonly action: "replay-from-cache"; readonly record: ToolCallRecord }
  | { readonly action: "safe-re-run"; readonly reason: string }
  | {
      readonly action: "ask-user-confirm"
      readonly reason: string
      readonly recordHint?: ToolCallRecord
    }
  | { readonly action: "halt"; readonly reason: string }

/** Closed port — `decide` is pure (no I/O). The orchestrator does the I/O. */
export interface ToolReplayPolicy {
  /** Decide what to do for one tool call.
   *
   *  - `record`     — the persisted {@link ToolCallRecord}, or `null` if the
   *                   re-fork issued a tool call that has no cached match.
   *                   In that case we use `toolName` to look up the tier
   *                   from the classifier.
   *  - `toolName`   — the new call's tool name (used on cache miss).
   *  - `classifier` — for tier lookup when no record is present.
   *
   *  Pure — no I/O, no async. Throws are CAUGHT by the orchestrator and
   *  collapsed to `halt`. */
  decide(
    record: ToolCallRecord | null,
    toolName: string,
    classifier: IdempotencyClassifier,
  ): ToolReplayDecision
}

/** Narrow port the orchestrator consumes to materialize a workspace restore
 *  to a specific shadow commit SHA. We deliberately do NOT depend on
 *  `@/storage/shadow-odb`'s full ShadowOdb surface — this slice has no need
 *  to init / register / list / cleanup, and the work-order forbids modifying
 *  shadow-odb. Caller wires a thin adapter when integrating the two slices.
 *
 *  Contract: throws on failure (mismatched workspace, unknown SHA, git
 *  failure). The orchestrator collapses throws into a `halt` outcome.
 *  Returning normally means the workspace tracked files now match the
 *  state captured at `shadowCommit`. */
export interface ShadowCommitRestorer {
  restoreToCommit(workspaceRoot: string, shadowCommit: string): Promise<void>
}

/* ------------------------------------------------------------------ */
/* default policy                                                      */
/* ------------------------------------------------------------------ */

/** Default 3-tier policy — see module-doc for the full matrix. */
export const defaultToolReplayPolicy = (): ToolReplayPolicy => ({
  decide(
    record: ToolCallRecord | null,
    toolName: string,
    classifier: IdempotencyClassifier,
  ): ToolReplayDecision {
    try {
      // ---- Cache HIT path ----
      if (record !== null) {
        const tier = record.tier
        switch (tier) {
          case "pure":
            return { action: "replay-from-cache", record }
          case "mutating-recoverable":
            // Output already captured; orchestrator ALSO restores shadowCommit.
            return { action: "replay-from-cache", record }
          case "mutating-external":
            // External side effect already produced its real effect before
            // the crash — DO NOT re-run; surface cached output to the LLM.
            return { action: "replay-from-cache", record }
          default: {
            // Defensive — unknown tier on a persisted record (table evolved,
            // record was hand-edited, etc.). Halt rather than guess.
            const tierRepr: string =
              typeof tier === "string" ? (tier as string) : JSON.stringify(tier)
            return { action: "halt", reason: `unknown tier on record: ${tierRepr}` }
          }
        }
      }

      // ---- Cache MISS path ----
      const tier = classifier.classify(toolName)
      if (tier === null) {
        return {
          action: "halt",
          reason: `unknown tool '${toolName}' on cache miss (no classifier entry)`,
        }
      }
      switch (tier) {
        case "pure":
          return {
            action: "safe-re-run",
            reason: `cache miss for pure tool '${toolName}' — safe to re-run`,
          }
        case "mutating-recoverable":
          return {
            action: "halt",
            reason: `cache miss for mutating-recoverable tool '${toolName}' — re-running would mutate workspace and no shadow anchor exists to restore`,
          }
        case "mutating-external":
          return {
            action: "ask-user-confirm",
            reason: `cache miss for mutating-external tool '${toolName}' — re-running would repeat side effect; caller must confirm`,
          }
        default: {
          // Defensive — exhaustiveness check; should be unreachable.
          const tierRepr: string =
            typeof tier === "string" ? (tier as string) : JSON.stringify(tier)
          return { action: "halt", reason: `unknown tier from classifier: ${tierRepr}` }
        }
      }
    } catch (e) {
      // NO-THROW contract: collapse any policy-internal throw into halt.
      const msg = errMessage(e)
      return { action: "halt", reason: `policy threw: ${msg}` }
    }
  },
})

/* ------------------------------------------------------------------ */
/* orchestrator                                                        */
/* ------------------------------------------------------------------ */

/** One outcome per persisted record (= input order preserved). Audit-only —
 *  the actual cached output is on `outcome.decision.record.result` for the
 *  consumer to inject into the re-forked agent's message stream. */
export interface ToolReplayOutcome {
  readonly toolUseId: string
  readonly toolName: string
  readonly decision: ToolReplayDecision
  /** When the orchestrator invoked `restoreToCommit` for a mutating-recoverable
   *  hit, this is the SHA passed. Absent when no restore was attempted. */
  readonly restoredCommit?: string
  /** Error captured if the restore call threw. When set, the outcome's
   *  decision is `halt` (orchestrator overrides policy on restore failure). */
  readonly restoreError?: string
}

export interface ReplayToolHistoryOpts {
  /** Persisted records, in append order (oldest first). */
  readonly records: ReadonlyArray<ToolCallRecord>
  /** Classifier — used by the policy on cache miss. Defaults to
   *  {@link defaultIdempotencyClassifier}. */
  readonly classifier: IdempotencyClassifier
  /** Replay policy. Defaults to {@link defaultToolReplayPolicy}. */
  readonly policy: ToolReplayPolicy
  /** Workspace fingerprint for the RESUME side. Every record's `workspace`
   *  must match this exactly — otherwise the orchestrator emits `halt` for
   *  that record (cross-workspace replay is a security hazard: the cached
   *  output may reference paths or git refs that do not exist on the resume
   *  side). */
  readonly workspace: string
  /** Optional shadow-commit restorer. When ABSENT, mutating-recoverable hits
   *  collapse to `halt` ("no restorer wired") instead of `replay-from-cache`
   *  — the cached output alone is insufficient because the workspace state
   *  the LLM expected post-call would not be reproduced. */
  readonly shadowOdb?: ShadowCommitRestorer
}

const isMutatingRecoverable = (tier: IdempotencyTier): boolean => tier === "mutating-recoverable"

/** Replay all cached tool calls for a handle being resumed. ONE pass through
 *  the records in append order; per-record outcomes accumulate in `outcomes`.
 *  This is the orchestrator the resumer (Part 4) calls before the new fork
 *  starts processing turns.
 *
 *  Cross-workspace defense: a record whose `workspace` differs from the
 *  resume workspace produces `halt` even if the policy said replay — better
 *  to halt and force the user to inspect than risk leaking stale state into
 *  a different workspace. */
export const replayToolHistory = async (
  opts: ReplayToolHistoryOpts,
): Promise<ReadonlyArray<ToolReplayOutcome>> => {
  const { records, classifier, policy, workspace, shadowOdb } = opts
  const outcomes: ToolReplayOutcome[] = []

  for (const record of records) {
    // Cross-workspace fence — runs BEFORE policy so a security-sensitive
    // mismatch is never even considered for replay.
    if (record.workspace !== workspace) {
      outcomes.push({
        toolUseId: record.toolUseId,
        toolName: record.toolName,
        decision: {
          action: "halt",
          reason: `record.workspace '${record.workspace}' != resume workspace '${workspace}'`,
        },
      })
      continue
    }

    const decision = policy.decide(record, record.toolName, classifier)

    // mutating-recoverable cache hits MUST restore the shadow commit.
    if (
      decision.action === "replay-from-cache" &&
      isMutatingRecoverable(record.tier) &&
      record.shadowCommit !== undefined
    ) {
      if (shadowOdb === undefined) {
        outcomes.push({
          toolUseId: record.toolUseId,
          toolName: record.toolName,
          decision: {
            action: "halt",
            reason: `mutating-recoverable replay needs shadow restore but no shadowOdb wired`,
          },
        })
        continue
      }
      try {
        await shadowOdb.restoreToCommit(workspace, record.shadowCommit)
        outcomes.push({
          toolUseId: record.toolUseId,
          toolName: record.toolName,
          decision,
          restoredCommit: record.shadowCommit,
        })
      } catch (e) {
        const msg = errMessage(e)
        outcomes.push({
          toolUseId: record.toolUseId,
          toolName: record.toolName,
          decision: {
            action: "halt",
            reason: `shadow restore failed for ${record.shadowCommit}: ${msg}`,
          },
          restoreError: msg,
        })
      }
      continue
    }

    outcomes.push({
      toolUseId: record.toolUseId,
      toolName: record.toolName,
      decision,
    })
  }

  return outcomes
}
