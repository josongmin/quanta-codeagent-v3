/**
 * ADR-0161 Phase A — RFC 5545 §3.3.10 BASIC RECUR rule parser (strict subset).
 *
 * Supported:
 *   FREQ=<DAILY|WEEKLY|MONTHLY>
 *   [;INTERVAL=<n>]            (positive integer)
 *   [;COUNT=<n>]               (positive integer, mutually exclusive with UNTIL)
 *   [;UNTIL=<YYYYMMDDTHHMMSSZ>] (UTC only — trailing Z required)
 *   [;BYDAY=<weekday-list>]    (`MO` / `+2MO` / `-1FR`)
 *   [;BYMONTHDAY=<n-list>]     (1..31; 0 + 32+ rejected)
 *
 * Out of scope (returns `unsupported-freq` / `malformed`):
 *   HOURLY / MINUTELY / SECONDLY / YEARLY
 *   BYSETPOS / BYWEEKNO / BYYEARDAY / BYMONTH / BYHOUR / BYMINUTE / BYSECOND
 *   WKST / RDATE / EXDATE / DTSTART (those are siblings to RRULE in iCal)
 *
 * Pure: no clock, no I/O, no env. The parser is the SSOT for what an
 * automation can express; expansion / firing is the evaluator's job.
 *
 * Output discipline (exactOptionalPropertyTypes):
 *   Optional `RRule` fields (`interval` / `count` / `until` / `byDay` /
 *   `byMonthDay`) are OMITTED when absent. The serializer reflects this
 *   omission — `serializeRRule(parseRRule(s))` is idempotent under
 *   canonicalization (keys re-ordered, weekdays upper-cased, no extra
 *   whitespace).
 */

import { sliceWholeChars } from "@/shared"
import type { Frequency, RRule, RRuleParseError, Weekday } from "./types"
import { parseWeekday, serializeWeekday } from "./weekday"

/** Parser entry. Returns a discriminated union — `ok: true` for success,
 *  `ok: false` for any RFC 5545 violation. Never throws. */
export type RRuleParseResult = (RRule & { readonly ok: true }) | RRuleParseError

/** Parse a RFC 5545 RRULE string. Case-insensitive on KEY tokens; value
 *  tokens normalized to upper case for weekdays. */
/** Mutable accumulator for parsed RRULE parts. Filled by per-key handlers
 *  inside the parse loop; finalized at the end (FREQ presence + COUNT/UNTIL
 *  exclusion). Kept in this module so the structure is the SSOT. */
interface Accumulator {
  freq?: Frequency
  interval?: number
  count?: number
  until?: number
  byDay?: Weekday[]
  byMonthDay?: number[]
}

type SplitResult =
  | { readonly ok: true; readonly key: string; readonly value: string }
  | { readonly ok: false; readonly err: RRuleParseError }

/** Split one `KEY=value` segment, normalizing the key to upper case. */
const splitKeyValue = (part: string): SplitResult => {
  const eq = part.indexOf("=")
  if (eq < 0) return { ok: false, err: malformed(`segment missing '=' — ${truncate(part)}`) }
  const key = part.slice(0, eq).trim().toUpperCase()
  const value = part.slice(eq + 1).trim()
  if (key.length === 0) return { ok: false, err: malformed(`empty key`) }
  if (value.length === 0) return { ok: false, err: malformed(`empty value for ${key}`) }
  return { ok: true, key, value }
}

/** Apply a single key/value to the accumulator. Returns `undefined` on
 *  success or a `RRuleParseError` to bubble up. */
const applyKeyValue = (
  acc: Accumulator,
  key: string,
  value: string,
): RRuleParseError | undefined => {
  switch (key) {
    case "FREQ":
      return applyFreq(acc, value)
    case "INTERVAL":
      return applyInteger(acc, "interval", value)
    case "COUNT":
      return applyInteger(acc, "count", value)
    case "UNTIL":
      return applyUntil(acc, value)
    case "BYDAY":
      return applyByDay(acc, value)
    case "BYMONTHDAY":
      return applyByMonthDay(acc, value)
    default:
      return malformed(`unknown key ${truncate(key)}`)
  }
}

const applyFreq = (acc: Accumulator, value: string): RRuleParseError | undefined => {
  const f = parseFreq(value)
  if (f === undefined) {
    return {
      ok: false,
      code: "unsupported-freq",
      message: `unsupported FREQ=${truncate(value)}`,
    }
  }
  acc.freq = f
  return undefined
}

const applyInteger = (
  acc: Accumulator,
  field: "interval" | "count",
  value: string,
): RRuleParseError | undefined => {
  const n = parsePositiveInteger(value)
  if (n === undefined)
    return malformed(`${field.toUpperCase()} must be a positive integer — ${truncate(value)}`)
  acc[field] = n
  return undefined
}

const applyUntil = (acc: Accumulator, value: string): RRuleParseError | undefined => {
  const ms = parseUntilUtc(value)
  if (ms === undefined) return malformed(`UNTIL must be YYYYMMDDTHHMMSSZ — ${truncate(value)}`)
  acc.until = ms
  return undefined
}

const invalidByday = (msg: string): RRuleParseError => ({
  ok: false,
  code: "invalid-byday",
  message: msg,
})

const applyByDay = (acc: Accumulator, value: string): RRuleParseError | undefined => {
  const tokens = value.split(",").map((s) => s.trim())
  if (tokens.length === 0) return invalidByday("BYDAY had no tokens")
  const items: Weekday[] = []
  for (const t of tokens) {
    const w = parseWeekday(t)
    if (w === undefined) return invalidByday(`bad BYDAY token ${truncate(t)}`)
    items.push(w)
  }
  if (items.length === 0) return invalidByday("BYDAY had no tokens")
  acc.byDay = items
  return undefined
}

const applyByMonthDay = (acc: Accumulator, value: string): RRuleParseError | undefined => {
  const tokens = value.split(",").map((s) => s.trim())
  if (tokens.length === 0) return malformed("BYMONTHDAY had no tokens")
  const items: number[] = []
  for (const t of tokens) {
    const n = parsePositiveInteger(t)
    if (n === undefined || n > 31) return malformed(`BYMONTHDAY must be 1..31 — ${truncate(t)}`)
    items.push(n)
  }
  acc.byMonthDay = items
  return undefined
}

/** Walk parts → fill `acc`. Returns the first error, or undefined on
 *  success. Extracted from `parseRRule` to keep that function under the
 *  cognitive-complexity threshold. */
const fillAccumulator = (
  parts: ReadonlyArray<string>,
  acc: Accumulator,
): RRuleParseError | undefined => {
  const seen = new Set<string>()
  for (const part of parts) {
    const split = splitKeyValue(part)
    if (!split.ok) return split.err
    if (seen.has(split.key)) return malformed(`duplicate key ${split.key}`)
    seen.add(split.key)
    const result = applyKeyValue(acc, split.key, split.value)
    if (result !== undefined) return result
  }
  return undefined
}

/** Final validation + RRule shape build with omitted optional keys. */
const finalizeAccumulator = (acc: Accumulator): RRuleParseResult => {
  if (acc.freq === undefined) return malformed("missing FREQ")
  if (acc.count !== undefined && acc.until !== undefined) {
    return { ok: false, code: "count-and-until", message: "COUNT and UNTIL are mutually exclusive" }
  }
  const { freq, interval, count, until, byDay, byMonthDay } = acc
  const base = { freq } as { freq: Frequency }
  return {
    ok: true,
    ...base,
    ...(interval !== undefined ? { interval } : {}),
    ...(count !== undefined ? { count } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(byDay !== undefined ? { byDay } : {}),
    ...(byMonthDay !== undefined ? { byMonthDay } : {}),
  }
}

export const parseRRule = (input: string): RRuleParseResult => {
  if (typeof input !== "string") return malformed("input is not a string")
  const trimmed = input.trim()
  if (trimmed.length === 0) return malformed("empty rule")
  const parts = trimmed
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  const acc: Accumulator = {}
  const err = fillAccumulator(parts, acc)
  if (err !== undefined) return err
  return finalizeAccumulator(acc)
}

/**
 * Serialize an `RRule` back to a canonical RFC 5545 string.
 *
 * Canonical form:
 *   - KEY order: `FREQ`, `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY`, `BYMONTHDAY`.
 *   - Weekday tokens upper-cased.
 *   - `BYDAY` / `BYMONTHDAY` value tokens preserve input order (the parser
 *     does not reorder; serializer mirrors).
 *   - No spaces; `;` separator only.
 *
 * Idempotent: `serializeRRule(parseRRule(serializeRRule(r)))` === `serializeRRule(r)`.
 */
export const serializeRRule = (rule: RRule): string => {
  const segments: string[] = [`FREQ=${rule.freq}`]
  if (rule.interval !== undefined) segments.push(`INTERVAL=${rule.interval}`)
  if (rule.count !== undefined) segments.push(`COUNT=${rule.count}`)
  if (rule.until !== undefined) segments.push(`UNTIL=${formatUntilUtc(rule.until)}`)
  if (rule.byDay !== undefined && rule.byDay.length > 0) {
    segments.push(`BYDAY=${rule.byDay.map(serializeWeekday).join(",")}`)
  }
  if (rule.byMonthDay !== undefined && rule.byMonthDay.length > 0) {
    segments.push(`BYMONTHDAY=${rule.byMonthDay.join(",")}`)
  }
  return segments.join(";")
}

// ============================================================================
// helpers (private, pure)
// ============================================================================

const malformed = (message: string): RRuleParseError => ({
  ok: false,
  code: "malformed",
  message,
})

const TRUNC_LIMIT = 64
const truncate = (s: string): string =>
  s.length > TRUNC_LIMIT ? `${sliceWholeChars(s, TRUNC_LIMIT - 1)}…` : s

const parseFreq = (raw: string): Frequency | undefined => {
  const up = raw.toUpperCase()
  if (up === "DAILY" || up === "WEEKLY" || up === "MONTHLY") return up
  return undefined
}

/** Parse a strictly positive integer. Rejects "0", "-1", "1.5", "abc", "". */
const parsePositiveInteger = (raw: string): number | undefined => {
  if (!/^[0-9]+$/.test(raw)) return undefined
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return n
}

/**
 * Parse `YYYYMMDDTHHMMSSZ` (RFC 5545 UTC). Returns ms since epoch.
 *
 * Strict: trailing `Z` required; all 4+2+2 / 2+2+2 components present; result
 * MUST round-trip through `Date.UTC` (rejects e.g. `20260230T000000Z`).
 */
const parseUntilUtc = (raw: string): number | undefined => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw)
  if (m === null) return undefined
  const y = Number.parseInt(m[1] ?? "0", 10)
  const mo = Number.parseInt(m[2] ?? "0", 10)
  const d = Number.parseInt(m[3] ?? "0", 10)
  const h = Number.parseInt(m[4] ?? "0", 10)
  const mi = Number.parseInt(m[5] ?? "0", 10)
  const s = Number.parseInt(m[6] ?? "0", 10)
  if (mo < 1 || mo > 12) return undefined
  if (d < 1 || d > 31) return undefined
  if (h > 23 || mi > 59 || s > 59) return undefined
  const ms = Date.UTC(y, mo - 1, d, h, mi, s)
  // Reject invalid dates that JS silently normalizes (e.g. Feb 30 → Mar 2).
  const back = new Date(ms)
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== mo - 1 ||
    back.getUTCDate() !== d ||
    back.getUTCHours() !== h ||
    back.getUTCMinutes() !== mi ||
    back.getUTCSeconds() !== s
  ) {
    return undefined
  }
  return ms
}

/** Format ms-epoch back to `YYYYMMDDTHHMMSSZ`. Inverse of `parseUntilUtc`. */
const formatUntilUtc = (ms: number): string => {
  const d = new Date(ms)
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0")
  return (
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  )
}
