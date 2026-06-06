/**
 * RFC jun-6 — per-turn sandbox-escalation retry cap (`ExecPolicyAmendmentExhausted`
 * analog).
 *
 * Bounds how many `escalate:true` REQUESTS a model may issue within a single
 * `(threadId, turnId)`. Each request increments the counter BEFORE routing to
 * the user; past the cap the tool returns a typed `escalation-exhausted` result
 * and fires NO further prompt. Anti-spam: a model cannot loop
 * escalate→deny→escalate forever within one turn.
 *
 * This is a SEPARATE cap from the loop-breaker — it bounds escalation requests,
 * NOT tool calls.
 *
 * Pure + injectable store (a plain Map keyed by `(threadId, turnId)`). No
 * clock, no env, no IO — the counter resets per turn by virtue of the turnId
 * changing (and `resetTurn` for explicit reclaim). Default cap = 3 (a KNOB
 * elsewhere: `QUANTA_SANDBOX_ESCALATION_MAX`).
 */

/** The default per-turn escalation cap. A KNOB
 *  (`QUANTA_SANDBOX_ESCALATION_MAX`) overrides it; this is the floor when the
 *  env var is absent/invalid. Mirrors a "two retries then stop" posture. */
export const DEFAULT_SANDBOX_ESCALATION_MAX = 3

export interface EscalationCapKey {
  readonly threadId: string
  readonly turnId: string
}

/** Result of an admission attempt. `admitted:false` ⇒ the caller MUST NOT fire
 *  an escalation prompt; surface a typed `escalation-exhausted` instead. */
export interface EscalationAdmission {
  readonly admitted: boolean
  /** The escalation-request count AFTER this attempt (for OTel / diagnostics). */
  readonly count: number
  /** The cap in force for this attempt. */
  readonly max: number
}

const keyOf = (k: EscalationCapKey): string => `${k.threadId}\x00${k.turnId}`

/**
 * Per-turn escalation-retry counter. Inject ONE per session (or construct
 * ad-hoc in tests). `max` is the resolved cap (knob or default).
 */
export interface SandboxEscalationCap {
  /** Attempt to admit one escalation request. Increments the per-turn counter
   *  and returns whether it is within the cap. Idempotent only in the sense
   *  that each CALL counts — a denied-then-retried escalation calls this
   *  twice (which is exactly what the cap bounds). */
  admit(key: EscalationCapKey): EscalationAdmission
  /** Current count for a `(threadId, turnId)` WITHOUT incrementing. */
  count(key: EscalationCapKey): number
  /** Explicitly reset a turn's counter (e.g. at a turn boundary). Optional —
   *  a fresh `turnId` already yields a fresh counter. */
  resetTurn(key: EscalationCapKey): void
}

/**
 * Construct an in-memory escalation cap. `max` defaults to
 * {@link DEFAULT_SANDBOX_ESCALATION_MAX}. A non-positive / non-integer `max`
 * falls back to the default (defensive — the knob parser already rejects
 * those, but a programmatic caller might pass garbage).
 */
export const createSandboxEscalationCap = (max?: number): SandboxEscalationCap => {
  const resolvedMax =
    typeof max === "number" && Number.isInteger(max) && max > 0
      ? max
      : DEFAULT_SANDBOX_ESCALATION_MAX
  const counts = new Map<string, number>()

  return {
    admit(key: EscalationCapKey): EscalationAdmission {
      const k = keyOf(key)
      const next = (counts.get(k) ?? 0) + 1
      counts.set(k, next)
      return { admitted: next <= resolvedMax, count: next, max: resolvedMax }
    },
    count(key: EscalationCapKey): number {
      return counts.get(keyOf(key)) ?? 0
    },
    resetTurn(key: EscalationCapKey): void {
      counts.delete(keyOf(key))
    },
  }
}
