import type { AgentOutcome } from "@/agent"
import { saveSession } from "@/agent"
import type { Message } from "@/llm"
import { type SavePayload, type SessionMeta, saveSessionById } from "@/session"
import { errMessage, logger } from "@/shared"

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
}

export const persistTurn = async (input: PersistTurnInput): Promise<void> => {
  const { state, idMeta, sessionId, messages, outcome } = input
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
