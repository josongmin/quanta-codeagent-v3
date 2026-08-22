/**
 * RFC-01 A2 (aug-02 absorption) — FEEDER for the durable checkpoint mapping.
 *
 * `captureCheckpoint` (RFC01-2, `./thread-rollback-checkpoint.ts`) builds a
 * durable `message → ShadowOdb SHA` mapping, and `executeRollback` (RFC01-3)
 * resolves a `/rewind --restore-files` target ONLY from that persisted mapping.
 * Before this module there was NO production caller of `captureCheckpoint`, so
 * `SavedSession.rollbackCheckpoints` was ALWAYS empty and every
 * `/rewind --restore-files` fail-closed at `missing-checkpoint`.
 *
 * This is the ONE production feeder: at a per-message/per-turn boundary (the
 * post-turn id-mode persist site) it binds the LATEST shadow anchor SHA taken
 * during the turn to the message id the operator would rewind to, and folds the
 * resulting record onto the SavedSession snapshot through the EXISTING atomic
 * store. It creates NO new store/schema/ODB — it reuses `captureCheckpoint`,
 * `upsertRollbackCheckpoint`, `RollbackCheckpointRecord`, and
 * `updateSessionAtomic`.
 *
 * # Why the SHA comes from the live registry, not a fresh registerHead
 *
 * The restore effect (`buildRollbackEffectPort`, RFC01-3) resolves a durable
 * `checkpointSha` by matching it against the LIVE in-memory `GranularRegistry`
 * (the tag→SHA store `withAutoCheckpoint` populates per tool mutation). So the
 * durable record's `checkpointSha` MUST be a SHA that already lives in that
 * registry, or the restore fail-closes at `checkpoint-anchor-missing`. We
 * therefore take the NEWEST registry anchor's SHA (the freshest post-mutation
 * shadow head of THIS turn) rather than calling `registerHead` again (which
 * would mint a SHA the registry never saw). The injected `CheckpointCapturePort`
 * returns that SHA verbatim — so `captureCheckpoint` stays reused verbatim.
 *
 * # Hard invariants (mirror the checkpoint slice's fail-OPEN posture)
 *
 *  1. **Gate-OFF ⇒ ZERO work.** The caller (composition root) only invokes this
 *     when the dedicated capture gate is set AND a registry SHA source exists.
 *     When it does not invoke us, the turn is byte-identical — this module is
 *     never on the hot path unless explicitly enabled.
 *  2. **Best-effort / NON-throwing.** A capture failure (no registry SHA, no
 *     addressable message id, a store I/O reject) is SWALLOWED — it MUST NEVER
 *     break the turn. The function resolves to a typed `FeedResult`; it never
 *     rejects.
 *  3. **No fabricated target.** When there is no registry SHA (no mutation this
 *     turn) or no message id (legacy id-less transcript), we record NOTHING —
 *     a `/rewind --restore-files` then still fail-closes safe (no phantom
 *     checkpoint that could not actually restore).
 *  4. **Boundary = the LAST addressable message.** The record's `turnId`/
 *     `messageId` is the id of the newest message carrying an id — the exact
 *     value `/rewind <id>` resolves and passes as `targetTurnId`.
 */

import {
  type RollbackCheckpointRecord,
  updateSessionAtomic,
  upsertRollbackCheckpoint,
} from "@/session"
import { type CheckpointCapturePort, captureCheckpoint } from "./thread-rollback-checkpoint"

/** The narrow read the feeder needs over the live per-tool checkpoint registry:
 *  the SHA of the newest anchor taken this session (`list()` is newest-first).
 *  Injected as a plain function so this module never imports the per-tool slice
 *  and stays unit-testable with a one-line fake. Returns `undefined` when NO
 *  anchor has been recorded (no mutation ⇒ nothing to bind). */
export type LatestAnchorShaSource = () => string | undefined

/** Minimal message projection the feeder reads — only the optional stable id.
 *  Structural (no `@/llm` import) so the feeder is a leaf. */
export interface FeederMessage {
  readonly id?: string
}

/** Inputs for one feed. Every collaborator is injected so the composition root
 *  binds the real registry + workspace + session id, and tests bind fakes. */
export interface FeedCheckpointInput {
  readonly sessionId: string
  /** Absolute workspace root — copied verbatim into the durable record's
   *  `workspace` via `captureCheckpoint`. */
  readonly workspace: string
  /** Post-turn message history (with ids assigned). The LAST message carrying
   *  an id is the rewind boundary. */
  readonly messages: readonly FeederMessage[]
  /** SHA source over the live registry (newest anchor). */
  readonly latestAnchorSha: LatestAnchorShaSource
  /** Path → content-hash observed at this boundary. Optional — an empty set is
   *  a valid (non-lossy) record. Defaults to `{}` (the feeder does NOT invent
   *  hashes; the restore leg is SHA-pinned regardless). */
  readonly expectedFileHashes?: Readonly<Record<string, string>>
}

/** Closed, typed outcome of one feed. Every arm is observable so a test /
 *  telemetry surface can prove WHY nothing was captured (never a silent
 *  swallow of a genuine capture). */
export type FeedResult =
  /** A durable checkpoint record was folded onto the SavedSession snapshot. */
  | { readonly kind: "captured"; readonly record: RollbackCheckpointRecord }
  /** No anchor SHA in the registry (no mutation this turn) ⇒ nothing to bind. */
  | { readonly kind: "no-anchor" }
  /** No addressable message id in the transcript ⇒ no rewind boundary. */
  | { readonly kind: "no-message-id" }
  /** The session vanished between turn and fold (updateSessionAtomic ⇒ false). */
  | { readonly kind: "session-missing" }
  /** A capture/store step threw — SWALLOWED (fail-OPEN). `reason` is the
   *  message; the turn is unaffected. */
  | { readonly kind: "error"; readonly reason: string }

/** The id of the newest message carrying a non-empty id (the rewind boundary),
 *  or `undefined` when the transcript is id-less (legacy). Pure. */
const lastMessageId = (messages: readonly FeederMessage[]): string | undefined => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const id = messages[i]?.id
    if (typeof id === "string" && id.length > 0) return id
  }
  return undefined
}

/**
 * Fold a durable checkpoint mapping onto the SavedSession snapshot for the turn
 * that just persisted. Best-effort + NON-throwing (see the module contract).
 *
 * The SHA is the newest live-registry anchor (so the restore effect can resolve
 * it); the boundary is the last addressable message id (so `/rewind <id>
 * --restore-files` finds it). When either is absent NOTHING is recorded and the
 * subsequent `/rewind --restore-files` fail-closes safe.
 */
export const feedCheckpointCapture = async (input: FeedCheckpointInput): Promise<FeedResult> => {
  try {
    const sha = input.latestAnchorSha()
    if (typeof sha !== "string" || sha.length === 0) return { kind: "no-anchor" }
    const messageId = lastMessageId(input.messages)
    if (messageId === undefined) return { kind: "no-message-id" }

    // A capture port that returns the ALREADY-registered registry SHA — no fresh
    // registerHead (which would mint a SHA the restore registry never saw). This
    // keeps `captureCheckpoint` the SINGLE record-builder (reused verbatim).
    const port: CheckpointCapturePort = { registerHead: async () => sha }
    // Build the canonical record via the reused capture primitive. The `existing`
    // arg is `[]` because the authoritative fold happens INSIDE the atomic lock
    // below (against the freshest on-disk collection) — this call is only used
    // for its (record) output, not its (checkpoints) projection.
    const { record } = await captureCheckpoint(port, [], {
      workspace: input.workspace,
      // `/rewind` resolves a message id and passes it as `targetTurnId`, and
      // `resolveRollbackTarget` matches on the record's `turnId`, so BOTH the
      // turnId and messageId fields are the boundary message id.
      turnId: messageId,
      messageId,
      expectedFileHashes: input.expectedFileHashes ?? {},
    })

    // Fold under the per-session save lock: re-read the freshest snapshot INSIDE
    // the lock and upsert the record against whatever checkpoints are already
    // durable, carrying every other field forward. A concurrent rollback fold
    // (rollbackOperations) or rename (meta.title) is preserved by the full
    // snapshot spread — whoever runs second sees the first's committed write.
    const ok = await updateSessionAtomic(input.sessionId, (saved) => ({
      ...saved,
      rollbackCheckpoints: [...upsertRollbackCheckpoint(saved.rollbackCheckpoints ?? [], record)],
    }))
    if (!ok) return { kind: "session-missing" }
    return { kind: "captured", record }
  } catch (e) {
    return { kind: "error", reason: e instanceof Error ? e.message : "capture-threw" }
  }
}
