/**
 * Conversation-seed replay primitive (ADR-0166 Phase 2.5).
 *
 * ADR-0159 Phase 2 re-forks an interrupted handle with `metadata.resumedFrom`
 * but the NEW child starts FRESH (no conversation history). This module adds
 * OPTIONAL conversation-seed injection: when the OLD handle persisted a
 * `conversationSnapshotId` (ADR-0158 `PersistedHandle` extension) AND the
 * caller wires both a {@link ConversationCheckpointStore} (ADR-0124) + a
 * {@link ReplayPolicy} into the resumer, the seed `messages[]` are injected as
 * `spec.initialMessages` on the re-fork.
 *
 * Plane-clean: this slice imports ONLY
 *   `@/agent/subagent-persistence-store` (PersistedHandle type),
 *   `@/agent/conversation-checkpoint` (ConversationCheckpointStore type), and
 *   `@/llm` (Message type — JSON-shape only, no runtime).
 * NO `@/agent/loop`, `@/agent/dispatch`, `@/agent/recovery`, `@/permission`,
 * `@/tool`.
 *
 * Contract:
 *   1. PURE POLICY: `ReplayPolicy.decide` is a pure function — no I/O. The
 *      composer {@link buildReplaySpec} is the one async call (it queries the
 *      store), and even it is NO-THROW (every failure resolves to
 *      `"skip-replay"` with an audit reason).
 *   2. exactOptionalPropertyTypes: optional opts are OMITTED, never set to
 *      `undefined`. The returned `ReplayedSpec.seedMessages` is ALWAYS an
 *      array (empty on skip) — caller can branch on `.length === 0` without
 *      undefined-checks.
 *   3. TRUNCATION = TAIL-KEEP. When the snapshot exceeds `maxMessages`,
 *      `defaultReplayPolicy` keeps the LAST `maxMessages` (= most recent
 *      messages, ≈ tool-result tail + last assistant turn). Rationale: the
 *      child agent's NEXT turn is what matters; the oldest user message is
 *      the least informative context for "what was happening just before
 *      interruption". (Head-keep would preserve the original task but lose
 *      the in-flight tool trace; middle-keep makes no sense for an agent.)
 *      `alwaysReplayPolicy` does NOT truncate — explicit opt-in to risk.
 *   4. AUDIT METADATA: `replayMetadata` ALWAYS includes `resumedFrom` (old
 *      handle id), `replayPolicy` (one of the 3 action arms), and
 *      `replayCount` (= seedMessages.length as a string — Record<string,
 *      string> only). Caller MERGES this into `spec.metadata` so the audit
 *      trail is mechanical (no prose parsing).
 *   5. DEFAULT-OFF: when `ctx.checkpointStore === null` OR
 *      `handle.conversationSnapshotId` is absent, the composer returns
 *      `seedMessages=[]` + `replayMetadata.replayPolicy="skip-replay"`. The
 *      resumer's behavior is BYTE-IDENTICAL to ADR-0159 Phase 2 in that
 *      case (no `initialMessages` on the new spec).
 */

import type { ConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import type { PersistedHandle } from "@/agent/subagent-persistence-store"
import type { Message } from "@/llm"

import { errMessage } from "@/shared"
/** What the policy decided for one handle. 3-arm union mirrors the
 *  `ResumeDecision` shape (ADR-0159) — exhaustive + auditable. */
export type ReplayDecision =
  | { readonly action: "replay-all"; readonly reason: string }
  | { readonly action: "replay-truncated"; readonly keepLastN: number; readonly reason: string }
  | { readonly action: "skip-replay"; readonly reason: string }

/** Closed port — caller chooses 1 of the 3 stock policies (or supplies their
 *  own). `decide` is pure: NO I/O, NO async. */
export interface ReplayPolicy {
  /** Decide whether to replay conversation for a handle being resumed.
   *  Centralized so policy/audit lives in one place. `snapshot` is `null` when
   *  the checkpoint store could not produce one (absent id, store miss,
   *  store throw — all collapsed to `null` by the composer). */
  decide(handle: PersistedHandle, snapshot: ReadonlyArray<Message> | null): ReplayDecision
}

/** Context passed to {@link buildReplaySpec}. `checkpointStore=null` is an
 *  explicit "I have nothing to replay from" signal — composer short-circuits
 *  to `"skip-replay"`. */
export interface ReplayContext {
  /** The conversation store. `null` ⇒ no replay (skip). */
  readonly checkpointStore: ConversationCheckpointStore | null
  /** Hard cap on injected messages — protects against context-window blow-up.
   *  Default 200 (matches ADR-0124's `maxEntries=50` × ~4 messages/turn). */
  readonly maxMessages?: number
}

/** What the composer returns. `seedMessages` is ALWAYS an array (empty on
 *  skip). `replayMetadata` is ALWAYS populated (audit metadata). */
export interface ReplayedSpec {
  readonly seedMessages: ReadonlyArray<Message>
  /** Audit metadata — caller merges into `spec.metadata`. ALWAYS includes:
   *    - `resumedFrom`: old handle id
   *    - `replayPolicy`: one of `"replay-all"` / `"replay-truncated"` /
   *      `"skip-replay"` (the chosen action arm)
   *    - `replayCount`: seedMessages.length as a STRING (Record<string,
   *      string> constraint).
   *  May also include `replayReason` carrying the policy's audit reason. */
  readonly replayMetadata: Readonly<Record<string, string>>
}

/** Tunables for {@link defaultReplayPolicy}. */
export interface DefaultReplayPolicyOpts {
  /** Hard cap on injected messages — protects against context-window blow-up.
   *  Default 200. Matches the `ReplayContext.maxMessages` knob; whichever is
   *  smaller wins (composer applies `Math.min`). */
  readonly maxMessages?: number
}

const DEFAULT_MAX_MESSAGES = 200

/** Default policy:
 *   - snapshot null/empty                → "skip-replay"
 *   - snapshot.length ≤ maxMessages      → "replay-all"
 *   - snapshot.length > maxMessages      → "replay-truncated" with keepLastN
 *                                          = maxMessages (TAIL-KEEP — see
 *                                          module-doc Contract clause 3).
 */
export const defaultReplayPolicy = (opts: DefaultReplayPolicyOpts = {}): ReplayPolicy => {
  const maxMessages = Math.max(1, Math.floor(opts.maxMessages ?? DEFAULT_MAX_MESSAGES))
  return {
    decide(_handle, snapshot): ReplayDecision {
      if (snapshot === null) {
        return { action: "skip-replay", reason: "snapshot is null (no conversation captured)" }
      }
      if (snapshot.length === 0) {
        return { action: "skip-replay", reason: "snapshot is empty (no messages to replay)" }
      }
      if (snapshot.length <= maxMessages) {
        return {
          action: "replay-all",
          reason: `snapshot length ${snapshot.length} <= maxMessages ${maxMessages}`,
        }
      }
      return {
        action: "replay-truncated",
        keepLastN: maxMessages,
        reason: `snapshot length ${snapshot.length} > maxMessages ${maxMessages}; tail-keep ${maxMessages}`,
      }
    },
  }
}

/** Aggressive policy — always returns `"replay-all"`, even on an empty
 *  snapshot. (Empty seed is a no-op: composer surfaces `seedMessages=[]` and
 *  the runner ignores it. Documented so callers don't expect a fallback to
 *  skip.) For tests + power users. */
export const alwaysReplayPolicy: ReplayPolicy = {
  decide(_handle, snapshot): ReplayDecision {
    return {
      action: "replay-all",
      reason: `alwaysReplayPolicy: unconditional replay-all (snapshot.length=${snapshot?.length ?? 0})`,
    }
  },
}

/** Most-conservative policy — always returns `"skip-replay"`. Preserves
 *  ADR-0159 Phase 2 behavior even when both checkpointStore + a
 *  conversationSnapshotId are wired (caller's explicit opt-out). */
export const skipReplayPolicy: ReplayPolicy = {
  decide(_handle, _snapshot): ReplayDecision {
    return { action: "skip-replay", reason: "skipReplayPolicy: unconditional skip" }
  },
}

/** Truncate `messages` to the LAST `n` (tail-keep). Returns the input
 *  unchanged when `n >= messages.length`. Returns `[]` when `n <= 0`. */
const tailKeep = <T>(messages: ReadonlyArray<T>, n: number): ReadonlyArray<T> => {
  if (n <= 0) return []
  if (n >= messages.length) return messages
  return messages.slice(messages.length - n)
}

/** Build the audit metadata block. ALWAYS populated; caller MERGES into
 *  `spec.metadata`. */
const buildReplayMetadata = (
  handle: PersistedHandle,
  decision: ReplayDecision,
  seedLength: number,
): Readonly<Record<string, string>> => ({
  resumedFrom: handle.id,
  replayPolicy: decision.action,
  replayCount: seedLength.toString(),
  replayReason: decision.reason,
})

/** Compose a re-fork seed from a `PersistedHandle` + `ReplayContext`. NO-THROW
 *  — any failure (store=null, missing id, store.restore throw) resolves to
 *  `seedMessages=[]` + `replayMetadata.replayPolicy="skip-replay"` with an
 *  audit-able `replayReason`. */
export const buildReplaySpec = async (
  handle: PersistedHandle,
  ctx: ReplayContext,
  policy: ReplayPolicy,
): Promise<ReplayedSpec> => {
  // 1) No store wired ⇒ skip (preserve Phase 2 behavior).
  if (ctx.checkpointStore === null) {
    const decision: ReplayDecision = {
      action: "skip-replay",
      reason: "checkpointStore is null (no replay surface wired)",
    }
    return {
      seedMessages: [],
      replayMetadata: buildReplayMetadata(handle, decision, 0),
    }
  }

  // 2) No snapshot id on the handle ⇒ skip.
  const snapshotId = handle.conversationSnapshotId
  if (snapshotId === undefined || snapshotId.length === 0) {
    const decision: ReplayDecision = {
      action: "skip-replay",
      reason: "handle.conversationSnapshotId is absent",
    }
    return {
      seedMessages: [],
      replayMetadata: buildReplayMetadata(handle, decision, 0),
    }
  }

  // 3) Restore — NO-THROW. Any store throw collapses to null + skip-replay.
  let snapshot: ReadonlyArray<Message> | null
  try {
    snapshot = ctx.checkpointStore.restore(snapshotId)
  } catch (e) {
    const msg = errMessage(e)
    const decision: ReplayDecision = {
      action: "skip-replay",
      reason: `store-failed: ${msg}`,
    }
    return {
      seedMessages: [],
      replayMetadata: buildReplayMetadata(handle, decision, 0),
    }
  }

  // 4) Consult policy. Pure call — no I/O.
  const decision = policy.decide(handle, snapshot)

  // 5) Apply decision. The composer's ReplayContext.maxMessages further
  //    truncates — policy's keepLastN AND ctx.maxMessages BOTH apply (min
  //    wins) so the caller can downscale at the call site without changing
  //    policy construction.
  const ctxCap =
    ctx.maxMessages !== undefined
      ? Math.max(1, Math.floor(ctx.maxMessages))
      : Number.POSITIVE_INFINITY

  if (decision.action === "skip-replay") {
    return {
      seedMessages: [],
      replayMetadata: buildReplayMetadata(handle, decision, 0),
    }
  }

  const allMessages = snapshot ?? []
  let seed: ReadonlyArray<Message>
  if (decision.action === "replay-all") {
    seed = ctxCap < allMessages.length ? tailKeep(allMessages, ctxCap) : allMessages
  } else {
    // replay-truncated: policy's keepLastN AND ctx.maxMessages both bind.
    const keep = Math.min(decision.keepLastN, ctxCap)
    seed = tailKeep(allMessages, keep)
  }

  return {
    seedMessages: seed,
    replayMetadata: buildReplayMetadata(handle, decision, seed.length),
  }
}
