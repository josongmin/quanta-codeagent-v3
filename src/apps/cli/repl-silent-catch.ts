/**
 * Silent-catch telemetry helper.
 *
 * Three call sites in `runRepl` previously swallowed exceptions with bare
 * `catch {}` blocks (indicator port / skills callback / rule inventory).
 * Failure isolation is correct — a faulty render or disk scan MUST NOT crash
 * the surface — but the original blocks produced a TELEMETRY hole: a broken
 * pill silently disappears with no signal.
 *
 * `swallowAndLog` keeps the same fail-isolation contract while emitting one
 * `slog.warn(event, { error })` line. The log call itself is wrapped in a
 * defensive try so a misbehaving sink can never break the catch (the whole
 * point of swallowing was that nothing downstream depends on success).
 */

import type { StructuredLogger } from "@/observability"

/** Best-effort error-message extractor — never throws. */
const safeErrMessage = (err: unknown): string => {
  try {
    if (err instanceof Error) return err.message
    return String(err)
  } catch {
    return "<unknown>"
  }
}

/**
 * Emit a single warn-level structured log for a silently-swallowed failure.
 *
 * Contract:
 *   - When `slog` is provided, emit `slog.warn(event, { error })` and return.
 *   - When `slog` is `undefined` (defensive — never expected on the REPL
 *     path), no-op. We deliberately do NOT route to `console.warn` here:
 *     a noisy fallback would defeat the point of a swallowed catch (the
 *     REPL's `stderr` is the user-facing chrome surface).
 *   - The log call itself is wrapped — a sink that throws is itself
 *     swallowed so the catch contract holds in pathological cases.
 *
 * Stack traces are intentionally NOT logged: keeps records concise + avoids
 * leaking implementation details to a downstream collector.
 */
export const swallowAndLog = (
  slog: StructuredLogger | undefined,
  event: string,
  err: unknown,
): void => {
  if (slog === undefined) return
  try {
    slog.warn(event, { error: safeErrMessage(err) })
  } catch {
    // Sink threw — the catch contract still holds; we just lose this one
    // observation. Do NOT escalate.
  }
}
