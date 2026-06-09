/**
 * §13.2 (jun-08 long-tail) — PERSISTED interrupted-turn marker + crash resume.
 *
 * The in-memory `InterruptedTurnBuffer` (`src/agent/interrupted-turn.ts`,
 * jun-08) restores an interrupted turn WITHIN a single process. A hard crash
 * (SIGKILL, OOM, power loss) mid-turn loses that buffer entirely — the work is
 * gone. This module adds the missing durability layer: it persists the
 * interrupted-turn marker onto the session SNAPSHOT (`SessionMeta.interruptedTurn`),
 * detects sessions that died mid-turn on the next restart, and rebuilds the
 * exact resume message the in-process buffer would have produced.
 *
 * Three operations, all on the existing snapshot store (no new on-disk file):
 *   - {@link markSessionInterrupted}  — persist the marker (called when a turn
 *     starts / is abandoned uncleanly).
 *   - {@link clearSessionInterrupted} — drop the marker (called on clean turn
 *     completion).
 *   - {@link detectInterruptedSessions} / {@link buildCrashResumeOffer} —
 *     restart-time detection + the operator-facing resume offer.
 *
 * GATE (default-OFF): every operation is a NO-OP unless `QUANTA_CRASH_RESUME`
 * is on. Gate absent ⇒ no marker is ever written and detection returns `[]`, so
 * the session store behaves byte-identically to the pre-ticket code. The gate is
 * read via `@/shared` `gateOn` (the env-flag SSOT).
 *
 * NEVER throws: the mark/clear paths swallow store errors (a crash-resume marker
 * is best-effort durability, not a correctness invariant — failing to write it
 * must not break the live turn). Detection is read-only and degrades to `[]`.
 *
 * Pure where it can be: {@link buildCrashResumeOffer} and
 * {@link buildCrashResumeMessage} are pure (no I/O, no clock). The clock is
 * injected into {@link markSessionInterrupted} by the caller.
 */

import { errMessage, gateOn, logger } from "@/shared"
import type { SessionRootProvider } from "./root-port"
import { loadSessionById, saveSessionById } from "./store"
import type { PersistedInterruptedTurn, SessionMeta } from "./types"

/** Env-gate name for the persisted crash-resume layer. Default-OFF. */
export const CRASH_RESUME_GATE = "QUANTA_CRASH_RESUME"

/** True iff the persisted crash-resume layer is armed (default-OFF opt-in via the
 *  `@/shared` gate SSOT). `env` is INJECTED — the `@/session` slice is env-pure
 *  (the slice-boundary guard forbids a `process.env` literal here), so the read
 *  is threaded from the composition root (apps/cli / host passes `process.env`);
 *  tests pass a fake env. ABSENT env ⇒ OFF (a caller that never threads env can
 *  never accidentally arm the layer — fail-safe + matches default-OFF). */
export const crashResumeEnabled = (env?: Record<string, string | undefined>): boolean =>
  env !== undefined && gateOn(env, CRASH_RESUME_GATE)

/** Env-gate for the L3 streaming-partial-freshness layer (ADR-0528 P2). */
export const CRASH_RESUME_PARTIAL_GATE = "QUANTA_CRASH_RESUME_PARTIAL"

/** True iff the partial-freshness layer is armed. STRICT SUPERSET of
 *  {@link crashResumeEnabled}: partial-flushing only makes sense ON TOP of the
 *  base marker layer (the flush UPDATES the marker the base layer writes), so
 *  BOTH gates must be on. Default-OFF; absent env ⇒ off (fail-safe). */
export const crashResumePartialEnabled = (
  env?: Record<string, string | undefined>,
): boolean => crashResumeEnabled(env) && env !== undefined && gateOn(env, CRASH_RESUME_PARTIAL_GATE)

/**
 * Persist an interrupted-turn marker onto a session's snapshot so a restart can
 * detect + offer to resume it. Best-effort + NEVER throws: a store failure is
 * logged and swallowed (the marker is durability, not correctness).
 *
 * Default-OFF: when the gate is absent this is a NO-OP — no read, no write — so
 * the session file is byte-identical to the pre-ticket shape.
 *
 * Idempotent overwrite (last-interrupt-wins), mirroring the in-memory buffer's
 * single-slot semantics.
 */
export const markSessionInterrupted = async (
  sessionId: string,
  turn: PersistedInterruptedTurn,
  opts?: { provider?: SessionRootProvider; env?: Record<string, string | undefined> },
): Promise<void> => {
  if (!crashResumeEnabled(opts?.env)) return
  try {
    const existing = await loadSessionById(sessionId, opts?.provider)
    if (existing === undefined) return
    const nextMeta: SessionMeta = { ...existing.meta, interruptedTurn: { ...turn } }
    await saveSessionById(
      nextMeta,
      { reason: existing.reason, turns: existing.turns, messages: existing.messages },
      opts?.provider,
    )
  } catch (e) {
    logger.warn("crash-resume: failed to persist interrupted-turn marker", {
      sessionId,
      error: errMessage(e),
    })
  }
}

/**
 * Drop a session's persisted interrupted-turn marker (clean turn completion).
 * Best-effort + NEVER throws. Default-OFF NO-OP when the gate is absent.
 *
 * Byte-identity nuance: when the gate is OFF we never read or write, so a
 * session that never carried a marker is untouched. When the gate is ON but the
 * session has no marker, we ALSO skip the write (no-op) so we don't churn the
 * snapshot / bump `lastTouched` for nothing.
 */
export const clearSessionInterrupted = async (
  sessionId: string,
  opts?: { provider?: SessionRootProvider; env?: Record<string, string | undefined> },
): Promise<void> => {
  if (!crashResumeEnabled(opts?.env)) return
  try {
    const existing = await loadSessionById(sessionId, opts?.provider)
    if (existing === undefined) return
    if (existing.meta.interruptedTurn === undefined) return // nothing to clear
    const { interruptedTurn: _drop, ...rest } = existing.meta
    const nextMeta: SessionMeta = { ...rest }
    await saveSessionById(
      nextMeta,
      { reason: existing.reason, turns: existing.turns, messages: existing.messages },
      opts?.provider,
    )
  } catch (e) {
    logger.warn("crash-resume: failed to clear interrupted-turn marker", {
      sessionId,
      error: errMessage(e),
    })
  }
}

/** One detected mid-turn-crashed session (restart detection result). */
export interface InterruptedSessionDetection {
  readonly sessionId: string
  readonly title: string
  readonly interruptedTurn: PersistedInterruptedTurn
}

/**
 * Restart-time detection: scan the session index for sessions carrying a
 * persisted interrupted-turn marker. The per-id SNAPSHOT is the source of truth
 * (the index is a derived cache that MAY lag the new field), so each candidate
 * is confirmed by re-reading its snapshot before being reported. Returns most-
 * recently-touched first (the session the user was likely on when it died).
 *
 * Default-OFF: returns `[]` immediately when the gate is absent (no I/O), so a
 * restart is byte-identical to the pre-ticket behavior. NEVER throws — a read
 * failure on any one session is skipped, not propagated.
 *
 * `candidates` is the caller-supplied session list (e.g. `listSessions(...)`).
 * Passing it in keeps this module decoupled from the index-store import and
 * lets the host decide archived inclusion.
 */
export const detectInterruptedSessions = async (
  candidates: readonly SessionMeta[],
  opts?: { provider?: SessionRootProvider; env?: Record<string, string | undefined> },
): Promise<InterruptedSessionDetection[]> => {
  if (!crashResumeEnabled(opts?.env)) return []
  const out: InterruptedSessionDetection[] = []
  for (const cand of candidates) {
    try {
      const snap = await loadSessionById(cand.id, opts?.provider)
      const marker = snap?.meta.interruptedTurn
      if (snap === undefined || marker === undefined) continue
      out.push({ sessionId: snap.meta.id, title: snap.meta.title, interruptedTurn: marker })
    } catch {
      // A single unreadable session must not sink the whole detection sweep.
    }
  }
  out.sort((a, b) => b.interruptedTurn.interruptedAt - a.interruptedTurn.interruptedAt)
  return out
}

/**
 * Build the user-facing resume message for a crash-recovered turn. PURE.
 * Re-injected as a `role:"user"` continuation so the agent picks the
 * interrupted task back up — same framing as the in-memory
 * `buildResumeMessage`, but self-contained in the session slice (the session
 * slice may not import `@/agent`).
 */
export const buildCrashResumeMessage = (turn: PersistedInterruptedTurn): string => {
  const head =
    `Resume the previously interrupted task (it was interrupted: ${turn.reason}). ` +
    `The task was:\n${turn.userText}`
  if (turn.partialAssistantText.trim().length === 0) return head
  return `${head}\n\nYour partial progress before the interruption:\n${turn.partialAssistantText}`
}

/** One actionable resume offer surfaced to the operator at restart. PURE. */
export interface CrashResumeOffer {
  readonly sessionId: string
  readonly title: string
  /** Human-readable one-line description of what was interrupted. */
  readonly summary: string
  /** The resume message to re-inject if the operator accepts. */
  readonly resumeMessage: string
}

/** Turn a detection into an operator-facing offer (description + resume
 *  message). PURE — no I/O. The caller decides how to present it (CLI prompt,
 *  TUI banner, IPC notification). */
export const buildCrashResumeOffer = (d: InterruptedSessionDetection): CrashResumeOffer => {
  const promptHead = d.interruptedTurn.userText.trim().split("\n")[0] ?? ""
  const clipped = promptHead.length > 80 ? `${promptHead.slice(0, 77)}…` : promptHead
  const summary =
    clipped.length > 0
      ? `Session "${d.title}" was interrupted mid-turn (${d.interruptedTurn.reason}): ${clipped}`
      : `Session "${d.title}" was interrupted mid-turn (${d.interruptedTurn.reason}).`
  return {
    sessionId: d.sessionId,
    title: d.title,
    summary,
    resumeMessage: buildCrashResumeMessage(d.interruptedTurn),
  }
}
