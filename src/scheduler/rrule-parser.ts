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

import { parseWeekday, serializeWeekday } from "./weekday"
import type { Frequency, RRule, RRuleParseError, Weekday } from "./types"

/** Parser entry. Returns a discriminated union — `ok: true` for success,
 *  `ok: false` for any RFC 5545 violation. Never throws. */
export type RRuleParseResult = (RRule & { readonly ok: true }) | RRuleParseError

/** Parse a RFC 5545 RRULE string. Case-insensitive on KEY tokens; value
 *  tokens normalized to upper case for weekdays. */
export const parseRRule = (input: string): RRuleParseResult => {
  if (typeof input !== "string") {
    return malformed("input is not a string")
  }
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    return malformed("empty rule")
  }
  // Split on `;` — RFC 5545 allows arbitrary order but each KEY appears once.
  const parts = trimmed.split(";").map((p) => p.trim()).filter((p) => p.length > 0)
  const seen = new Set<string>()
  // Accumulator with the parsed pieces; `freq` is the only required field.
  let freq: Frequency | undefined
  let interval: number | undefined
  let count: number | undefined
  let until: number | undefined
  let byDay: Weekday[] | undefined
  let byMonthDay: number[] | undefined

  for (const part of parts) {
    const eq = part.indexOf("=")
    if (eq < 0) return malformed(`segment missing '=' — ${truncate(part)}`)
    const key = part.slice(0, eq).trim().toUpperCase()
    const rawValue = part.slice(eq + 1).trim()
    if (key.length === 0) return malformed(`empty key`)
    if (seen.has(key)) return malformed(`duplicate key ${key}`)
    seen.add(key)
    if (rawValue.length === 0) return malformed(`empty value for ${key}`)

    switch (key) {
      case "FREQ": {
        const f = parseFreq(rawValue)
        if (f === undefined) {
          return {
            ok: false,
            code: "unsupported-freq",
            message: `unsupported FREQ=${truncate(rawValue)}`,
          }
        }
        freq = f
        break
      }
      case "INTERVAL": {
        const n = parsePositiveInteger(rawValue)
        if (n === undefined) return malformed(`INTERVAL must be a positive integer — ${truncate(rawValue)}`)
        interval = n
        break
      }
      case "COUNT": {
        const n = parsePositiveInteger(rawValue)
        if (n === undefined) return malformed(`COUNT must be a positive integer — ${truncate(rawValue)}`)
        count = n
        break
      }
      case "UNTIL": {
        const ms = parseUntilUtc(rawValue)
        if (ms === undefined) return malformed(`UNTIL must be YYYYMMDDTHHMMSSZ — ${truncate(rawValue)}`)
        until = ms
        break
      }
      case "BYDAY": {
        const items: Weekday[] = []
        const tokens = rawValue.split(",").map((s) => s.trim())
        for (const t of tokens) {
          const w = parseWeekday(t)
          if (w === undefined) {
            return { ok: false, code: "invalid-byday", message: `bad BYDAY token ${truncate(t)}` }
          }
          items.push(w)
        }
        if (items.length === 0) {
          return { ok: false, code: "invalid-byday", message: "BYDAY had no tokens" }
        }
        byDay = items
        break
      }
      case "BYMONTHDAY": {
        const items: number[] = []
        const tokens = rawValue.split(",").map((s) => s.trim())
        for (const t of tokens) {
          const n = parsePositiveInteger(t)
          if (n === undefined || n > 31) return malformed(`BYMONTHDAY must be 1..31 — ${truncate(t)}`)
          items.push(n)
        }
        if (items.length === 0) return malformed("BYMONTHDAY had no tokens")
        byMonthDay = items
        break
      }
      default:
        return malformed(`unknown key ${truncate(key)}`)
    }
  }

  if (freq === undefined) return malformed("missing FREQ")
  if (count !== undefined && until !== undefined) {
    return { ok: false, code: "count-and-until", message: "COUNT and UNTIL are mutually exclusive" }
  }

  // Build the RRule with only present optional keys — exactOptionalPropertyTypes
  // requires OMIT (not `undefined`-set).
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
  s.length > TRUNC_LIMIT ? `${s.slice(0, TRUNC_LIMIT - 1)}…` : s

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
