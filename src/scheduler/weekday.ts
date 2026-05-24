/**
 * ADR-0161 Phase A — Weekday DSL + nth-occurrence calendar.
 *
 * BYDAY tokens (RFC 5545 §3.3.10 BYDAY rule part):
 *   - Bare weekday:        `MO` / `TU` / ... / `SU`  (every occurrence)
 *   - Positive ordinal:    `+1MO` / `+2WE` / `+3FR` / `+4SA` / `+5SU`
 *                          (1st .. 5th occurrence from start of month)
 *   - Negative ordinal:    `-1MO` / `-2WE` / `-3FR` / `-4SA` / `-5SU`
 *                          (1st .. 5th occurrence from END of month)
 *
 * Rejected:
 *   - Zero ordinal (`+0MO`) — RFC 5545: ordinal MUST NOT be zero.
 *   - Out-of-range ordinal (`+6MO`, `-7FR`) — only 1..5 valid (max 5
 *     occurrences per month for any weekday).
 *   - Unknown weekday token.
 *
 * Pure: no clock, no I/O, no env. All computations UTC — caller surface owns
 * any local-time conversion (display layer). This keeps DST out of the core.
 */

import { ALL_WEEKDAYS } from "./types"
import type { Weekday, WeekdayDay } from "./types"

/** Parse a single BYDAY token. Returns `undefined` on any RFC violation. */
export const parseWeekday = (raw: string): Weekday | undefined => {
  if (typeof raw !== "string") return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  // Optional sign + optional digit(s) + 2 letters of weekday.
  const m = /^([+-]?)(\d*)([A-Za-z]{2})$/.exec(trimmed)
  if (m === null) return undefined
  const signTok = m[1] ?? ""
  const digitTok = m[2] ?? ""
  const dayTok = (m[3] ?? "").toUpperCase()
  const day = parseDay(dayTok)
  if (day === undefined) return undefined

  // No ordinal — bare weekday.
  if (digitTok.length === 0) {
    if (signTok.length > 0) return undefined // `+MO` / `-MO` without digits is malformed.
    return { day }
  }

  const magnitude = Number.parseInt(digitTok, 10)
  // Reject zero ordinal (RFC: MUST NOT be zero) and out-of-range.
  if (!Number.isFinite(magnitude) || magnitude < 1 || magnitude > 5) return undefined
  const nth = signTok === "-" ? -magnitude : magnitude
  return { day, nth }
}

/** Serialize a single Weekday back to its canonical token. Bare day has no
 *  sign / digit; positive ordinal has explicit `+`; negative has `-`. */
export const serializeWeekday = (w: Weekday): string => {
  if (w.nth === undefined) return w.day
  const sign = w.nth < 0 ? "-" : "+"
  const magnitude = Math.abs(w.nth)
  return `${sign}${magnitude}${w.day}`
}

/**
 * UTC weekday lookup. `0` = Sunday … `6` = Saturday (matches `Date.getUTCDay`).
 * The mapping below normalizes to the RFC 5545 `WeekdayDay` tokens.
 */
const WEEKDAY_FROM_JS_INDEX: ReadonlyArray<WeekdayDay> = [
  "SU",
  "MO",
  "TU",
  "WE",
  "TH",
  "FR",
  "SA",
]

const parseDay = (raw: string): WeekdayDay | undefined => {
  for (const d of ALL_WEEKDAYS) if (d === raw) return d
  return undefined
}

/**
 * Compute the UTC ms epoch of the N-th `day` in `year`/`month` (month is
 * 1-indexed: 1 = January … 12 = December — caller surface, not JS Date).
 *
 * Positive `nth`: count from start of month (1 = first, 5 = fifth).
 * Negative `nth`: count from end of month (-1 = last, -5 = fifth-from-end).
 *
 * Returns `undefined` when:
 *   - `month` out of 1..12.
 *   - `nth` out of -5..-1 or 1..5.
 *   - The requested occurrence does NOT EXIST in that month (e.g. 5th
 *     Monday of Feb 2026 — only 4 Mondays).
 *
 * The returned ms is at 00:00:00 UTC of that date — caller composes with
 * the automation's HH:MM:SS (the runtime takes that from `lastFiredAt`'s
 * time-of-day OR a configured default).
 */
export const nthWeekdayOfMonth = (
  year: number,
  month: number,
  day: WeekdayDay,
  nth: number,
): number | undefined => {
  if (!Number.isInteger(year)) return undefined
  if (!Number.isInteger(month) || month < 1 || month > 12) return undefined
  if (!Number.isInteger(nth) || nth === 0 || nth < -5 || nth > 5) return undefined

  const targetJsIdx = jsIndexOf(day)
  if (nth > 0) {
    return positiveNth(year, month, targetJsIdx, nth)
  }
  return negativeNth(year, month, targetJsIdx, nth)
}

/** Iterate all UTC occurrences of `day` in `year`/`month`. Pure, returns
 *  ms-epoch array (sorted ascending). Used by the evaluator. */
export const allOccurrencesInMonth = (
  year: number,
  month: number,
  day: WeekdayDay,
): ReadonlyArray<number> => {
  if (!Number.isInteger(year)) return []
  if (!Number.isInteger(month) || month < 1 || month > 12) return []
  const targetJsIdx = jsIndexOf(day)
  const out: number[] = []
  const lastDay = daysInUtcMonth(year, month)
  for (let d = 1; d <= lastDay; d += 1) {
    const ms = Date.UTC(year, month - 1, d)
    if (new Date(ms).getUTCDay() === targetJsIdx) out.push(ms)
  }
  return out
}

// ============================================================================
// helpers (private, pure)
// ============================================================================

const jsIndexOf = (day: WeekdayDay): number => {
  const idx = WEEKDAY_FROM_JS_INDEX.indexOf(day)
  // Closed enum — guaranteed >= 0; defensively guard.
  return idx >= 0 ? idx : 0
}

const positiveNth = (
  year: number,
  month: number,
  targetJsIdx: number,
  nth: number,
): number | undefined => {
  // Find day-of-month of first occurrence: ((target - jan1_dow + 7) % 7) + 1.
  const firstOfMonth = Date.UTC(year, month - 1, 1)
  const firstDow = new Date(firstOfMonth).getUTCDay()
  const firstOccurrenceDay = ((targetJsIdx - firstDow + 7) % 7) + 1
  const targetDay = firstOccurrenceDay + (nth - 1) * 7
  if (targetDay > daysInUtcMonth(year, month)) return undefined
  return Date.UTC(year, month - 1, targetDay)
}

const negativeNth = (
  year: number,
  month: number,
  targetJsIdx: number,
  nth: number,
): number | undefined => {
  // Find day-of-month of last occurrence.
  const lastDay = daysInUtcMonth(year, month)
  const lastOfMonth = Date.UTC(year, month - 1, lastDay)
  const lastDow = new Date(lastOfMonth).getUTCDay()
  const lastOccurrenceDay = lastDay - ((lastDow - targetJsIdx + 7) % 7)
  // nth is negative; magnitude 1..5. e.g. nth = -1 → lastOccurrenceDay; -2 → -7.
  const targetDay = lastOccurrenceDay + (nth + 1) * 7
  if (targetDay < 1) return undefined
  return Date.UTC(year, month - 1, targetDay)
}

/** Days in month for UTC year/month (1-indexed month). */
export const daysInUtcMonth = (year: number, month: number): number => {
  // Day 0 of next month = last day of current month (UTC).
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}
