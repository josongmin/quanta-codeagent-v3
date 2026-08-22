import type { RunShellEvent } from "./types"

/**
 * RFC-04 D2 — parse git's OWN checkout-progress stream into a typed ratio.
 *
 * The load-bearing rule is anti-fabrication (`no-heuristics-only-validated`):
 * a percentage is surfaced ONLY when git's own grammar
 * (`Updating files: N% (x/y)` / older `Checking out files: N% (x/y)`) is
 * present and internally consistent. Anything else — a prose line, a bare
 * percentage, a zero/undersized total, a `completed > total` impossibility —
 * is {@link INDETERMINATE}. No timer, no interpolation, no guessed number ever
 * becomes a ratio. Pure of I/O; a leaf of the `@/runtime` slice.
 */
export type CheckoutProgress =
  | { readonly kind: "indeterminate" }
  | {
      readonly kind: "ratio"
      /** git's reported completed count (the `x` in `(x/y)`). */
      readonly completed: number
      /** git's reported total count (the `y` in `(x/y)`), always > 0. */
      readonly total: number
      /** git's reported integer percent (the `N` in `N%`), 0..100. */
      readonly percent: number
    }

/** Shared indeterminate singleton — the honest "no real percentage" value. */
export const INDETERMINATE: CheckoutProgress = { kind: "indeterminate" }

/** git's checkout meter grammar. Anchored at the (optionally whitespace-led)
 *  start so an arbitrary line that merely *contains* `50% (1/2)` cannot be
 *  mistaken for progress — the `Updating files:` / `Checking out files:` label
 *  is mandatory. The trailing `, done.` (terminal line) is tolerated by not
 *  anchoring the end. */
const CHECKOUT_LINE = /^\s*(?:Updating files|Checking out files):\s+(\d{1,3})%\s+\((\d+)\/(\d+)\)/

/**
 * Parse a SINGLE already-delimited progress segment (one `\r`/`\n` unit).
 * Returns a determinate ratio ONLY for git's own, internally-consistent
 * grammar; every other input is {@link INDETERMINATE}. Never throws.
 */
export const parseCheckoutProgressLine = (line: string): CheckoutProgress => {
  const m = CHECKOUT_LINE.exec(line)
  if (m === null) return INDETERMINATE
  const percent = Number(m[1])
  const completed = Number(m[2])
  const total = Number(m[3])
  // Consistency gates — reject the division trap (total 0) and the impossible
  // `completed > total`; clamp the percent to git's own 0..100 domain. Any
  // failure is indeterminate rather than a fabricated/garbage ratio.
  if (!Number.isFinite(total) || total <= 0) return INDETERMINATE
  if (!Number.isFinite(completed) || completed < 0 || completed > total) return INDETERMINATE
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return INDETERMINATE
  return { kind: "ratio", completed, total, percent }
}

/**
 * Stateful reader that reassembles git's `\r`-overwritten progress stream from
 * arbitrarily-chunked stderr text and tracks the latest REAL ratio.
 *
 * - Segments are split on `\r` or `\n`; a trailing partial segment is buffered
 *   until a later chunk completes it (never parsed half-formed).
 * - Monotonic within a `total`: a segment whose `completed` regresses below the
 *   current ratio (same total) is IGNORED — a backward number is a parse
 *   artifact, and inventing a regression would violate the anti-fabrication
 *   rule. A different `total` (a new checkout phase) is accepted afresh.
 */
export interface CheckoutProgressReader {
  /** Feed one decoded stderr chunk; returns the reader's latest ratio after
   *  consuming it (indeterminate until git's grammar is first seen). */
  push(chunk: string): CheckoutProgress
  /** The latest determinate ratio seen so far, or indeterminate if none. */
  latest(): CheckoutProgress
}

export const createCheckoutProgressReader = (): CheckoutProgressReader => {
  let pending = ""
  let current: CheckoutProgress = INDETERMINATE

  const consider = (segment: string): void => {
    const parsed = parseCheckoutProgressLine(segment)
    if (parsed.kind !== "ratio") return
    if (
      current.kind === "ratio" &&
      parsed.total === current.total &&
      parsed.completed < current.completed
    ) {
      return // regression on the same total ⇒ keep the last real value
    }
    current = parsed
  }

  return {
    push(chunk: string): CheckoutProgress {
      pending += chunk
      // Split on either carriage-return (git's in-place overwrite) or newline.
      const segments = pending.split(/[\r\n]/)
      // The last element is the (possibly empty) unterminated tail — keep it.
      pending = segments.pop() ?? ""
      for (const seg of segments) consider(seg)
      return current
    },
    latest(): CheckoutProgress {
      return current
    },
  }
}

/**
 * Adapt git's {@link RunShellEvent} stream into a checkout-progress callback.
 * Decodes STDERR chunks only (git writes its progress meter to stderr), feeds
 * a {@link CheckoutProgressReader}, and invokes `onProgress` each time a NEW
 * real ratio is surfaced. Never emits for a stream that carries no git progress
 * grammar (byte-identical "nothing happened" when git is silent). This is the
 * concrete `runShell.onShellEvent` consumer the checkout-% wire uses.
 */
export const checkoutProgressObserver = (
  onProgress: (progress: CheckoutProgress) => void,
): ((event: RunShellEvent) => void) => {
  const reader = createCheckoutProgressReader()
  const decoder = new TextDecoder("utf-8")
  let last: CheckoutProgress = INDETERMINATE
  return (event: RunShellEvent): void => {
    if (event.kind !== "stderr") return
    const next = reader.push(decoder.decode(event.chunk, { stream: true }))
    if (next.kind !== "ratio") return
    if (last.kind === "ratio" && last.completed === next.completed && last.total === next.total) {
      return // no change ⇒ don't re-emit an identical ratio
    }
    last = next
    onProgress(next)
  }
}
