/**
 * §9.3 — account DUAL-WINDOW ratelimit (PURE, default-OFF slice).
 *
 * Codex emits, on EVERY response, a per-account dual-window quota meter:
 *   - `x-codex-primary-used-percent`   / `-window-minutes` / `-reset-at`
 *   - `x-codex-secondary-used-percent` / `-window-minutes` / `-reset-at`
 * mapping to its `RateLimitSnapshot { primary, secondary }`, each window a
 * `RateLimitWindow { usedPercent, windowMinutes (window_minutes), resetsAt }`
 * (see `.extracted_source/codex` `RateLimitWindow`/`RateLimitSnapshot`).
 *
 * This is DISTINCT from the existing `parse.ts` single-window family, which
 * reads the Anthropic/OpenAI `remaining`/`reset` shape. Codex reports
 * USED-PERCENT against a fixed window, NOT a remaining count — so the model and
 * the proactive policy differ, and the two live side-by-side. `parse.ts` is
 * request-scoped (last-write-wins on one logical route); this module provides
 * the request-scoped dual-window parse (`parseDualWindowSnapshot`) consumed live
 * by the loop's BudgetMeter feed.
 *
 * Constraints (project rules — identical posture to `parse.ts`):
 *   - NO invented number: a field is populated ONLY when the provider sent a
 *     well-formed value. Garbage ⇒ field absent (never coerced to 0 / NaN).
 *   - used_percent is clamped to the documented [0,100] band; out-of-range ⇒
 *     absent (a junk meter never drives a fabricated quota figure).
 *   - NO-THROW: a hostile header getter degrades to "no snapshot".
 *   - NO Date.now: `now` is injected; reset-at REUSES the parity-locked
 *     {@link parseRateLimitResetMs} band parser from `parse.ts`.
 *   - Default-OFF: nothing is parsed/stored unless the composition root opts in;
 *     a response with none of these headers ⇒ `undefined` (no clobber).
 */

import type { HeaderLookup } from "./parse"
import { parseRateLimitResetMs } from "./parse"

/** One rate-limit window in the Codex dual-window meter. Every field is
 *  optional — present ONLY when the provider sent a well-formed value, so a
 *  partial header set never fabricates a quantity. */
export interface RateLimitWindow {
  /** Percent of the window consumed, clamped to [0,100]. Absent if garbage or
   *  out-of-range. */
  readonly usedPercent?: number
  /** Length of the window in minutes (the slow/fast distinction). Absent if
   *  garbage. A non-negative finite number. */
  readonly windowMinutes?: number
  /** ms until this window resets (relative, via the B3-parity band parser).
   *  Absent if no/garbage reset header. */
  readonly resetMs?: number
}

/** A parsed dual-window snapshot. `primary` is the fast window, `secondary` the
 *  slow one — either may be absent. `observedAt` is the injected-clock read
 *  time. */
export interface DualWindowSnapshot {
  readonly primary?: RateLimitWindow
  readonly secondary?: RateLimitWindow
  readonly observedAt: number
}

/** Canonical (lowercase) header spellings per Codex window. Lookups are
 *  case-insensitive via the caller's accessor, so lowercase suffices. */
const PRIMARY = {
  used: "x-codex-primary-used-percent",
  window: "x-codex-primary-window-minutes",
  reset: "x-codex-primary-reset-at",
} as const
const SECONDARY = {
  used: "x-codex-secondary-used-percent",
  window: "x-codex-secondary-window-minutes",
  reset: "x-codex-secondary-reset-at",
} as const

/** No-throw single-header read: a hostile getter is caught ⇒ `null`. */
const get1 = (get: HeaderLookup, name: string): string | null => {
  try {
    return get(name)
  } catch {
    return null
  }
}

/** Parse `used_percent`: a finite number in the documented [0,100] band.
 *  Anything else (NaN, negative, >100) ⇒ `undefined` so the field stays absent
 *  rather than fabricating a percentage that the provider never sent. */
const parseUsedPercent = (raw: string | null): number | undefined => {
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (trimmed === "") return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined
}

/** Parse `window_minutes`: a non-negative finite number. Garbage ⇒ undefined. */
const parseWindowMinutes = (raw: string | null): number | undefined => {
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (trimmed === "") return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/** Parse one window from its three header spellings. Returns `undefined` when
 *  the window has NO recognized field at all (so an absent window stays absent
 *  rather than becoming `{}`). */
const parseWindow = (
  get: HeaderLookup,
  keys: { used: string; window: string; reset: string },
  now: () => number,
): RateLimitWindow | undefined => {
  const usedPercent = parseUsedPercent(get1(get, keys.used))
  const windowMinutes = parseWindowMinutes(get1(get, keys.window))
  const resetMs = parseRateLimitResetMs(get1(get, keys.reset), now)
  if (usedPercent === undefined && windowMinutes === undefined && resetMs === undefined) {
    return undefined
  }
  // Conditional spread keeps absent fields ABSENT (exactOptionalPropertyTypes).
  return {
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(resetMs !== undefined ? { resetMs } : {}),
  }
}

/**
 * Parse a {@link DualWindowSnapshot} from a response's headers. Returns
 * `undefined` when NEITHER window carries a recognized field — the store then
 * keeps its last value ⇒ byte-identical to the no-snapshot path. Default-OFF:
 * only the composition root calls this, and only when the gate is on.
 */
export const parseDualWindowSnapshot = (
  get: HeaderLookup,
  now: () => number,
): DualWindowSnapshot | undefined => {
  const primary = parseWindow(get, PRIMARY, now)
  const secondary = parseWindow(get, SECONDARY, now)
  if (primary === undefined && secondary === undefined) return undefined
  return {
    ...(primary !== undefined ? { primary } : {}),
    ...(secondary !== undefined ? { secondary } : {}),
    observedAt: now(),
  }
}

// jul-19 — the per-account `AccountRateLimitStore` (observe/current) was a
// PROVEN-DEAD half of this slice: `parseDualWindowSnapshot` is live-consumed
// (stream-consume.ts:199 → BudgetMeter) but nothing ever accumulated per-account
// history. Removed as a proven-dead export; the live single-snapshot parse path
// (above) is untouched.
