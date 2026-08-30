/**
 * Activation for usage accounting (A3-S3).
 *
 * TWO modes. The authority is the session's books, so the knob is a kill
 * switch, not a rollout dial:
 *
 *   - `on`  — the default. Every cost surface projects the session authority.
 *   - `off` — no authority is constructed; surfaces render an explicit
 *             "accounting off", never zeros wearing confidence.
 *
 * `shadow` (the old middle position) is a DEPRECATED alias for `on`: its
 * purpose was comparing the authority against the legacy feed, and the legacy
 * feed no longer exists to compare against. Any other unrecognized value also
 * fails safe to `on` — "off when you wanted on" loses the session's books,
 * "on when you wanted off" merely keeps them — and is named in the warning.
 *
 * The resolution is PURE and returns any warning instead of printing it: a
 * module-global warn-once latch would let the first resolver (often a test)
 * eat every later session's notice, and would leak across sessions in a
 * multi-session process. Each composition root resolves ONCE per session and
 * prints the returned warning itself.
 */

export type UsageAccountingMode = "on" | "off"

export interface UsageAccountingResolution {
  readonly mode: UsageAccountingMode
  /** Present when the raw value needed correcting (deprecated alias or an
   *  unrecognized value). The composition root logs it once per session. */
  readonly warning?: string
}

/** Env knob: `QUANTA_USAGE_ACCOUNTING_V2`. Resolve ONCE per composition root. */
export const resolveUsageAccounting = (
  env: Record<string, string | undefined>,
): UsageAccountingResolution => {
  const raw = env.QUANTA_USAGE_ACCOUNTING_V2
  const norm = raw?.trim().toLowerCase()
  if (norm === undefined || norm === "" || norm === "on") return { mode: "on" }
  if (norm === "off") return { mode: "off" }
  if (norm === "shadow") {
    return {
      mode: "on",
      warning:
        "QUANTA_USAGE_ACCOUNTING_V2=shadow is deprecated: the legacy feed it compared against is gone; running as 'on'.",
    }
  }
  return {
    mode: "on",
    warning: `QUANTA_USAGE_ACCOUNTING_V2=${JSON.stringify(raw)} is not recognized (on|off); failing safe to 'on' so the session keeps its books.`,
  }
}
