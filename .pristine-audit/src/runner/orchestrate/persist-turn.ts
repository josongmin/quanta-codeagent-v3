import type { AgentOutcome } from "@/agent"
import { saveSession } from "@/agent"
import type { Message } from "@/llm"
import { assignMessageIds, type SavePayload, type SessionMeta, saveSessionById } from "@/session"
import { errMessage, logger, runtimeConfig } from "@/shared"

/**
 * Per-turn persistence — surface-AGNOSTIC.
 *
 * Verbatim relocation of the inline save block from the CLI REPL's `turn`
 * closure. Two independent default-OFF persistence paths:
 *
 *   1. `--state <p>` path-mode transcript (legacy `saveSession`).
 *   2. Id-mode auto-save via `saveSessionById` when `idMeta` is set
 *      (so `quanta --resume <id>` self-persists without `--state`).
 *
 * Both fire only when their respective gate is set — no new branches.
 *
 * Layer-2 slice (`@/runner/orchestrate`): may import `@/agent`, `@/llm`,
 * `@/session`. Default-OFF posture preserved: when neither `state` nor
 * `idMeta` is set, this is a no-op.
 *
 * `apps/cli/session-io.ts` re-exports {@link persistTurn} from here so the
 * existing call site in `repl.ts` and the unit test reach the same function.
 */

/** RFC-01 A2 feeder hook — record a durable rewind checkpoint for the turn that
 *  just persisted (`/rewind --restore-files` restores to it). Runs AFTER the
 *  id-mode transcript save so the message ids it binds to are already durable.
 *
 *  Default-OFF: the composition root builds this ONLY when the dedicated capture
 *  gate is set AND the ShadowOdb/registry substrate exists; ABSENT ⇒ `persistTurn`
 *  makes ZERO extra calls and is byte-identical to the prior save-only path.
 *
 *  Best-effort by contract: the hook itself NEVER throws (it swallows every
 *  failure to a typed result); `persistTurn` additionally guards the call so a
 *  hook bug can never break the turn's persistence. */
export type PersistTurnCheckpointHook = (input: {
  readonly sessionId: string
  readonly messages: readonly Message[]
}) => Promise<void>

/** Inputs for {@link persistTurn} — every field mirrors the bindings the
 *  in-line REPL block used to close over. */
export interface PersistTurnInput {
  /** Path-mode transcript path from `--state <p>` / `QUANTA_STATE_PATH`.
   *  Default OFF (undefined) → skip path-mode save. */
  state: string | undefined
  /** Id-mode session meta (set when resumed by id or `--new-session`).
   *  Default OFF (undefined) → skip id-mode auto-save. */
  idMeta: SessionMeta | undefined
  /** Opaque session id (used by path-mode save metadata even when idMeta
   *  is undefined — preserved verbatim from the prior inline behavior). */
  sessionId: string
  /** Post-turn message history. */
  messages: Message[]
  /** Outcome of the just-completed turn. */
  outcome: AgentOutcome
  /** RFC-01 A2 — OPTIONAL durable rewind-checkpoint feeder. ABSENT ⇒ byte-
   *  identical (no extra call). Only fires alongside the id-mode auto-save (the
   *  ids it binds to must be persisted first). See {@link PersistTurnCheckpointHook}. */
  captureCheckpoint?: PersistTurnCheckpointHook
  /** RFC-13 HOP-2 — id-assign gate (injectable purely for tests; production
   *  reads it from `runtimeConfig()`). When true, id-LESS messages are minted a
   *  stable deterministic id at the TOP of `persistTurn` (before BOTH saves and
   *  the checkpoint hook). Default (undefined ⇒ read config) OFF ⇒ NO assign ⇒
   *  transcript byte-identical. See {@link maybeAssignMessageIds}. */
  assignIds?: boolean
}

/** RFC-13 HOP-2 — mint STABLE, deterministic ids at the per-turn persist
 *  boundary, gated + IDEMPOTENT.
 *
 *  - Gate OFF ⇒ the SAME array reference is returned (zero mutation) so the
 *    saved transcript is byte-identical to the id-less path.
 *  - Gate ON ⇒ `assignMessageIds` mints an id on EACH id-LESS message; a
 *    message that ALREADY carries a non-empty id is passed through unchanged
 *    (idempotent — ids survive resume/resave, never re-minted).
 *
 *  Scheme: sequential `m{k}` where `k` is the smallest non-negative integer NOT
 *  already used by ANY existing message id in this transcript. Rationale: the
 *  naive position-based `m{index}` COLLIDES when a pre-existing id (e.g. `m1`
 *  from a fork/prior save) equals a future position's mint — two messages would
 *  share an id and `resolveMessageIdPrefix` would go ambiguous, breaking
 *  `/rewind`. Seeding past the used set guarantees every minted id is UNIQUE
 *  while staying deterministic AND stable across resave (existing ids are
 *  preserved by `assignMessageIds`, and the transcript is append-only per turn,
 *  so the same id-less message re-mints the same `m{k}`). Pure: input array is
 *  not mutated.
 *
 *  Best-effort: `assignMessageIds` cannot throw for well-formed messages, but if
 *  a caller passes a hostile shape the assignment MUST NOT break persistence, so
 *  the call is guarded and falls back to the original messages on any throw. */
export const maybeAssignMessageIds = (messages: Message[], gateOn: boolean): Message[] => {
  if (!gateOn) return messages
  try {
    // Collect ids already present so a fresh mint can never collide with one at
    // a different position. `assignMessageIds` calls `idFor(i)` ONLY for id-less
    // messages, in ascending index order — we hand out the next unused `m{k}`.
    const used = new Set<string>()
    for (const m of messages) {
      if (typeof m.id === "string" && m.id.length > 0) used.add(m.id)
    }
    let next = 0
    const nextFreeId = (): string => {
      let candidate = `m${next}`
      while (used.has(candidate)) {
        next += 1
        candidate = `m${next}`
      }
      // Reserve it so two id-less messages in the SAME pass never collide either.
      used.add(candidate)
      next += 1
      return candidate
    }
    return assignMessageIds(messages, () => nextFreeId())
  } catch (e) {
    // Assignment is best-effort; never let it break the turn's persistence.
    // Attribute the failure so a real id-assignment bug is not silently lost.
    logger.warn(`persist-turn: message-id assignment failed: ${errMessage(e)}`)
    return messages
  }
}

export const persistTurn = async (input: PersistTurnInput): Promise<void> => {
  const { state, idMeta, sessionId, outcome } = input
  // RFC-13 HOP-2 — assign STABLE ids FIRST (before BOTH saves AND the checkpoint
  // hook) so the saved transcript is addressable and the hook binds to a durable
  // id. Gate: the dedicated `messageIds` knob OR `rewindCapture` (F3 is inert
  // without ids, so enabling capture implies assignment). `input.assignIds`
  // overrides purely for tests. Default OFF ⇒ same array ⇒ byte-identical.
  const cfg = runtimeConfig()
  const gateOn = input.assignIds ?? (cfg.messageIds || cfg.rewindCapture)
  const messages = maybeAssignMessageIds(input.messages, gateOn)
  if (state) {
    await saveSession(state, {
      sessionId,
      messages,
      reason: outcome.reason,
      turns: outcome.turns,
    })
  }
  if (idMeta) {
    // Auto-save in id-mode: per-turn persistence so `quanta --resume <id>`
    // self-persists without the user touching `--state`. No log emitted
    // here — would be too chatty inside the REPL.
    const payload: SavePayload = {
      reason: outcome.reason,
      turns: outcome.turns,
      messages,
    }
    await saveSessionById(idMeta, payload)
    // RFC-01 A2 — feed a durable rewind checkpoint AFTER the transcript is on
    // disk (so the message ids the checkpoint binds to are durable). ABSENT hook
    // ⇒ this whole block is skipped (byte-identical). Best-effort: the hook does
    // not throw, but we still guard so a hook bug can never break persistence.
    if (input.captureCheckpoint !== undefined) {
      try {
        await input.captureCheckpoint({ sessionId: idMeta.id, messages })
      } catch (e) {
        // checkpoint capture is observability-class; it MUST NOT break the
        // turn's persistence (fail-OPEN, mirrors the checkpoint slice) — but a
        // broken checkpoint hook is a real (non-fatal) defect, surfaced at warn.
        logger.warn(`persist-turn: captureCheckpoint failed: ${errMessage(e)}`)
      }
    }
  }
}
