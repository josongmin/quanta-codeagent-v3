/**
 * ADR-0161 Phase B — Schedule evaluator.
 *
 * `computeNextFire(rule, from, fireCount)` returns the next ms-epoch the rule
 * should fire at, OR `"never"` when the rule is exhausted (`UNTIL` already
 * past, OR `COUNT` already reached).
 *
 * Deterministic: same (`rule`, `from`, `fireCount`) → same result. No clock,
 * no I/O, no env. Pure function. The caller supplies `fireCount` (tracked in
 * `Automation.fireCount`) so COUNT exhaustion is observable from the
 * persistent store, not state hidden in the evaluator.
 *
 * Strict `>` boundary: when `from` is exactly a fire timestamp, the NEXT one
 * is returned. This prevents firing twice for the same minute when the runtime
 * ticks at a clock that lands on a fire boundary.
 *
 * Frequency semantics:
 *   - DAILY:   every `INTERVAL` (default 1) days. BYDAY filters which weekdays
 *              are eligible; BYMONTHDAY filters which days-of-month.
 *   - WEEKLY:  every `INTERVAL` (default 1) weeks. BYDAY enumerates which
 *              weekdays within each eligible week fire.
 *   - MONTHLY: every `INTERVAL` (default 1) months. BYDAY (with optional nth)
 *              enumerates which weekdays; BYMONTHDAY enumerates which
 *              days-of-month. Both lists are OR-combined when both present.
 */

import type { ClockPort, RRule, Weekday, WeekdayDay } from "./types"
import { allOccurrencesInMonth, daysInUtcMonth, nthWeekdayOfMonth } from "./weekday"

const MS_PER_DAY = 86_400_000
const MS_PER_HOUR = 3_600_000
const MS_PER_MINUTE = 60_000
const MAX_SCAN_DAYS = 366 * 10 // 10 years — defensive cap so we never spin forever.
const MAX_SCAN_MONTHS = 120 // 10 years.

const WEEKDAY_FROM_JS_INDEX: ReadonlyArray<WeekdayDay> = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]

/**
 * Compute the next fire-at ms. Returns `"never"` when:
 *   - `rule.until` is set AND < `from`.
 *   - `rule.count` is set AND `fireCount >= rule.count`.
 *   - No eligible fire within the scan horizon (10 years) — defensive.
 *
 * `clock` is currently unused (kept in signature for consistency with the
 * runtime; pure evaluation only needs `from`). Reserved for future
 * timezone-sensitive variants.
 */
export const computeNextFire = (
  rule: RRule,
  from: number,
  fireCount: number,
  _clock?: ClockPort,
): number | "never" => {
  if (rule.count !== undefined && fireCount >= rule.count) return "never"
  if (rule.until !== undefined && rule.until <= from) return "never"

  const candidate = scanForward(rule, from)
  if (candidate === undefined) return "never"
  if (rule.until !== undefined && candidate > rule.until) return "never"
  return candidate
}

/**
 * Lazy generator of fire timestamps. Honors `UNTIL` and `COUNT`. Caller
 * breaks when satisfied — the generator does not materialize the entire
 * series.
 *
 * Defensive: caps at the scan horizon so an over-restrictive rule can't loop
 * the generator forever in caller.
 */
export function* iterateFires(rule: RRule, from: number): Generator<number, void, unknown> {
  let cursor = from
  let emitted = 0
  for (let i = 0; i < (rule.count ?? MAX_SCAN_DAYS); i += 1) {
    const next = computeNextFire(rule, cursor, emitted)
    if (next === "never") return
    yield next
    emitted += 1
    cursor = next
    // Defensive: very over-constrained rules might re-yield the same cursor;
    // computeNextFire's strict `>` should prevent that, but bail if it ever
    // happens (the closed test fleet would catch this regression).
    if (rule.count !== undefined && emitted >= rule.count) return
  }
}

// ============================================================================
// scan strategy per frequency
// ============================================================================

const scanForward = (rule: RRule, from: number): number | undefined => {
  switch (rule.freq) {
    case "MINUTELY":
      return scanFixedDelta(rule, from, MS_PER_MINUTE)
    case "HOURLY":
      return scanFixedDelta(rule, from, MS_PER_HOUR)
    case "DAILY":
      return scanDaily(rule, from)
    case "WEEKLY":
      return scanWeekly(rule, from)
    case "MONTHLY":
      return scanMonthly(rule, from)
  }
}

/**
 * HOURLY / MINUTELY scan: the next fire is a single fixed wall-clock step of
 * `INTERVAL * unitMs` from `from`. Strict `>` boundary is inherent (the step is
 * always ≥ one unit, so the returned instant is strictly after `from`). No
 * BYDAY/BYMONTHDAY refinement — sub-daily rules fire on the raw cadence; if a
 * caller supplied those fields they simply have no effect at this frequency
 * (mirrors RFC 5545, where BYDAY on HOURLY would be an EXPANDED filter we do
 * not implement). `UNTIL`/`COUNT` exhaustion is enforced by the caller
 * (`computeNextFire`), so this only computes the raw next step.
 */
const scanFixedDelta = (rule: RRule, from: number, unitMs: number): number | undefined => {
  const interval = Math.max(1, rule.interval ?? 1)
  return from + interval * unitMs
}

/**
 * DAILY scan: step by `INTERVAL` days starting from the day AFTER `from`.
 * Filter by BYDAY (if set — only those weekdays) and BYMONTHDAY (if set —
 * only those day-of-month numbers). The two filters are AND-combined when
 * both present.
 *
 * `from` is interpreted as ms-epoch; the resulting fire ms preserves the
 * time-of-day of `from` (the runtime uses `lastFiredAt` to encode the
 * intended fire HH:MM:SS, falling back to `createdAt`).
 */
const scanDaily = (rule: RRule, from: number): number | undefined => {
  const interval = Math.max(1, rule.interval ?? 1)
  // Start at the next-day boundary (strict `>` semantics — never re-fire same instant).
  let probe = from + MS_PER_DAY
  // Snap probe to a multiple of INTERVAL days from `from` (interval is honored
  // relative to `from`, the anchor — simpler and matches Codex behavior).
  // Naive forward-step by 1 day, but only accept slots where (delta/day) % interval === 0.
  for (let i = 0; i < MAX_SCAN_DAYS; i += 1) {
    const date = new Date(probe)
    const dayOfMonth = date.getUTCDate()
    const weekday = WEEKDAY_FROM_JS_INDEX[date.getUTCDay()] as WeekdayDay
    const daysSinceFrom = Math.round((probe - from) / MS_PER_DAY)
    if (
      daysSinceFrom % interval === 0 &&
      matchesByDay(rule.byDay, weekday) &&
      matchesByMonthDay(rule.byMonthDay, dayOfMonth)
    ) {
      return probe
    }
    probe += MS_PER_DAY
  }
  return undefined
}

/**
 * WEEKLY scan: same model as DAILY but the INTERVAL is in 7-day units.
 * BYDAY enumerates which weekdays within an eligible week fire (default: the
 * same weekday as `from`).
 */
const scanWeekly = (rule: RRule, from: number): number | undefined => {
  const interval = Math.max(1, rule.interval ?? 1)
  const fromDate = new Date(from)
  const fromWeekday = WEEKDAY_FROM_JS_INDEX[fromDate.getUTCDay()] as WeekdayDay
  // The set of weekdays to fire on (filtered by BYDAY; default = same as from).
  const eligible: ReadonlyArray<WeekdayDay> =
    rule.byDay !== undefined && rule.byDay.length > 0 ? rule.byDay.map((w) => w.day) : [fromWeekday]
  // Scan by day; accept when (week-delta % interval === 0) AND weekday in eligible.
  const fromMidnight = startOfUtcDay(from)
  let probe = from + MS_PER_DAY
  for (let i = 0; i < MAX_SCAN_DAYS; i += 1) {
    const date = new Date(probe)
    const dayWeekday = WEEKDAY_FROM_JS_INDEX[date.getUTCDay()] as WeekdayDay
    if (eligible.includes(dayWeekday)) {
      const probeMidnight = startOfUtcDay(probe)
      const fromWeekStart = startOfUtcWeek(fromMidnight)
      const probeWeekStart = startOfUtcWeek(probeMidnight)
      const weeksDelta = Math.round((probeWeekStart - fromWeekStart) / (MS_PER_DAY * 7))
      if (weeksDelta % interval === 0 && matchesByMonthDay(rule.byMonthDay, date.getUTCDate())) {
        return probe
      }
    }
    probe += MS_PER_DAY
  }
  return undefined
}

/**
 * MONTHLY scan: candidate fires per month are the union of BYDAY-with-nth
 * expansions + BYMONTHDAY entries. INTERVAL is in months.
 *
 * If both BYDAY and BYMONTHDAY are unset, the default is BYMONTHDAY = day-of-
 * `from` (RFC 5545 implicit), so a rule like `FREQ=MONTHLY` from Jan 15 fires
 * Jan 15, Feb 15, Mar 15, … and skips months where that day-of-month doesn't
 * exist (e.g. Feb 30).
 */
/** Stamp a UTC midnight ms with from's HH:MM:SS, mirroring evaluator's
 *  contract that the fire time-of-day matches the anchor. */
const stampTimeOfDay = (midnightUtc: number, fromDate: Date): number => {
  const d = new Date(midnightUtc)
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    fromDate.getUTCHours(),
    fromDate.getUTCMinutes(),
    fromDate.getUTCSeconds(),
  )
}

const isIntervalAlignedMonth = (
  fromDate: Date,
  yr: number,
  mo: number,
  interval: number,
): boolean => {
  const monthsSinceFrom = (yr - fromDate.getUTCFullYear()) * 12 + (mo - 1 - fromDate.getUTCMonth())
  return monthsSinceFrom >= 0 && monthsSinceFrom % interval === 0
}

const advanceMonth = (yr: number, mo: number): { yr: number; mo: number } => {
  const next = mo + 1
  return next > 12 ? { yr: yr + 1, mo: 1 } : { yr, mo: next }
}

const scanMonthly = (rule: RRule, from: number): number | undefined => {
  const interval = Math.max(1, rule.interval ?? 1)
  const fromDate = new Date(from)
  let yr = fromDate.getUTCFullYear()
  let mo = fromDate.getUTCMonth() + 1
  for (let i = 0; i < MAX_SCAN_MONTHS; i += 1) {
    if (isIntervalAlignedMonth(fromDate, yr, mo, interval)) {
      const candidates = monthCandidates(rule, yr, mo, fromDate)
      for (const c of candidates) {
        if (c <= from) continue
        const fire = stampTimeOfDay(c, fromDate)
        if (fire > from) return fire
      }
    }
    ;({ yr, mo } = advanceMonth(yr, mo))
  }
  return undefined
}

/** Expand BYDAY for a single month — handles both nth-occurrence and
 *  every-occurrence variants. */
const expandByDayInMonth = (
  byDay: ReadonlyArray<{ readonly day: WeekdayDay; readonly nth?: number }>,
  year: number,
  month: number,
): ReadonlyArray<number> => {
  const out: number[] = []
  for (const w of byDay) {
    if (w.nth !== undefined) {
      const ms = nthWeekdayOfMonth(year, month, w.day, w.nth)
      if (ms !== undefined) out.push(ms)
    } else {
      for (const ms of allOccurrencesInMonth(year, month, w.day)) out.push(ms)
    }
  }
  return out
}

/** Expand BYMONTHDAY for a single month — skip days exceeding the month's
 *  length. */
const expandByMonthDayInMonth = (
  byMonthDay: ReadonlyArray<number>,
  year: number,
  month: number,
): ReadonlyArray<number> => {
  const out: number[] = []
  const lastDay = daysInUtcMonth(year, month)
  for (const d of byMonthDay) {
    if (d >= 1 && d <= lastDay) out.push(Date.UTC(year, month - 1, d))
  }
  return out
}

/** Build the sorted candidate UTC-midnight ms list for a single month. */
const monthCandidates = (
  rule: RRule,
  year: number,
  month: number,
  fromDate: Date,
): ReadonlyArray<number> => {
  const out: number[] = []
  const hasByDay = rule.byDay !== undefined && rule.byDay.length > 0
  const hasByMonthDay = rule.byMonthDay !== undefined && rule.byMonthDay.length > 0
  if (hasByDay && rule.byDay !== undefined) {
    out.push(...expandByDayInMonth(rule.byDay, year, month))
  }
  if (hasByMonthDay && rule.byMonthDay !== undefined) {
    out.push(...expandByMonthDayInMonth(rule.byMonthDay, year, month))
  }
  if (!hasByDay && !hasByMonthDay) {
    const lastDay = daysInUtcMonth(year, month)
    const d = fromDate.getUTCDate()
    if (d <= lastDay) out.push(Date.UTC(year, month - 1, d))
  }
  return Array.from(new Set(out)).sort((a, b) => a - b)
}

const matchesByDay = (byDay: RRule["byDay"], weekday: WeekdayDay): boolean => {
  if (byDay === undefined || byDay.length === 0) return true
  // For DAILY/WEEKLY filter purposes, only the day (not the nth) matters.
  for (const w of byDay) if (w.day === weekday) return true
  return false
}

const matchesByMonthDay = (byMonthDay: RRule["byMonthDay"], dayOfMonth: number): boolean => {
  if (byMonthDay === undefined || byMonthDay.length === 0) return true
  for (const d of byMonthDay) if (d === dayOfMonth) return true
  return false
}

const startOfUtcDay = (ms: number): number => {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

/** Start of the UTC week containing `ms` (Monday = start, RFC 5545 default). */
const startOfUtcWeek = (msMidnight: number): number => {
  const d = new Date(msMidnight)
  const jsDow = d.getUTCDay() // 0 = Sun ... 6 = Sat
  const daysBack = (jsDow + 6) % 7 // Sun → 6, Mon → 0, ... Sat → 5
  return msMidnight - daysBack * MS_PER_DAY
}

// `Weekday` is re-exported via the barrel; suppress unused-import flag.
export type { Weekday }
