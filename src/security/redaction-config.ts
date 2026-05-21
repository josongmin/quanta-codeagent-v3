/**
 * Redaction opt-out gate (ADR-0078). The redaction layer is DEFAULT-ON.
 * Disabling it at the host level requires an explicit `acknowledgedRisk`
 * string — a non-empty value the caller authored, surfaced in transcripts
 * and audit so "redaction is off" is never invisible.
 *
 * `normalizeRedactionConfig` returns a frozen normalized config OR throws
 * a {@link RedactionConfigError} at startup if the caller asked for
 * `disabled: true` without acknowledging risk. The loop calls this ONCE at
 * startup so a misconfigured host fails fast — never mid-turn.
 */

export interface RedactionConfig {
  readonly disabled?: boolean
  readonly acknowledgedRisk?: string
  readonly whitelist?: ReadonlyArray<RegExp>
}

export interface NormalizedRedactionConfig {
  readonly enabled: boolean
  readonly acknowledgedRisk: string | undefined
  readonly whitelist: ReadonlyArray<RegExp>
}

export class RedactionConfigError extends Error {
  override readonly name = "RedactionConfigError"
  constructor(message: string) {
    super(message)
  }
}

/** Exact error message — surfaced as the startup contract. Tests assert
 *  this string verbatim; do not edit without bumping ADR + tests. */
export const REDACTION_DISABLED_WITHOUT_ACK_MESSAGE =
  "Secret redaction disabled requires explicit acknowledgedRisk string. Refusing to start."

const EMPTY_WHITELIST: ReadonlyArray<RegExp> = Object.freeze([])

/**
 * Normalize the raw {@link RedactionConfig} into the frozen runtime shape.
 *
 *   - `raw === undefined` ⇒ enabled, no ack, no whitelist (default-ON);
 *   - `raw.disabled !== true` ⇒ enabled (whitelist passed through);
 *   - `raw.disabled === true` AND `acknowledgedRisk` is a NON-EMPTY string
 *     ⇒ disabled, ack preserved;
 *   - `raw.disabled === true` AND `acknowledgedRisk` is missing / empty /
 *     non-string ⇒ throw {@link RedactionConfigError}.
 *
 * Whitespace-only `acknowledgedRisk` counts as empty — we want a real
 * audit-grade explanation, not a single space.
 */
export const normalizeRedactionConfig = (
  raw: RedactionConfig | undefined,
): NormalizedRedactionConfig => {
  if (raw === undefined) {
    return Object.freeze({
      enabled: true,
      acknowledgedRisk: undefined,
      whitelist: EMPTY_WHITELIST,
    })
  }
  const whitelist = raw.whitelist ?? EMPTY_WHITELIST
  if (raw.disabled !== true) {
    return Object.freeze({
      enabled: true,
      acknowledgedRisk: undefined,
      whitelist: Object.freeze([...whitelist]),
    })
  }
  // disabled === true — REQUIRES a non-empty string ack.
  const ack = raw.acknowledgedRisk
  if (typeof ack !== "string" || ack.trim().length === 0) {
    throw new RedactionConfigError(REDACTION_DISABLED_WITHOUT_ACK_MESSAGE)
  }
  return Object.freeze({
    enabled: false,
    acknowledgedRisk: ack,
    whitelist: Object.freeze([...whitelist]),
  })
}
