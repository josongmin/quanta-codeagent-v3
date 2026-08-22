import { readBool } from "@/shared"

/**
 * BENCH default for the OpenAI reasoning-summary request (`reasoning.summary:
 * "auto"`). DEFAULT-ON for bench — a CODE default, not an operator env — so it
 * rides the rsynced bench source to the full-remote box with NO env forwarding.
 *
 * WHY default-on for bench: gpt-5.5 is a reasoning model. Without
 * `reasoning.summary` it reasons SILENTLY (zero bytes on the wire while
 * thinking), so the LLM stream idle-timeout (DEFAULT_IDLE_MS) fires
 * mid-reasoning, the SAME request is retried, reasons silently again → infinite
 * stall (proven via raw-SSE capture). Turning it on makes the model stream
 * `response.reasoning_summary_text.delta` continuously (idle-timeouts → 0).
 *
 * STILL OVERRIDABLE: an explicit `QUANTA_REASONING_SUMMARY=0`/off (operator
 * turning it OFF) wins, via `readBool(raw, defaultOn=true)`:
 *   - unset / "" / unrecognized ⇒ true  (bench default-ON)
 *   - 1/on/true/yes             ⇒ true
 *   - 0/off/false/no            ⇒ false (operator opt-out beats the default)
 *
 * This value is threaded into `tryCreateLLM` as `opts.reasoningSummary`, so the
 * factory's `resolveReasoningSummary` (`opts.reasoningSummary ?? gateOn(...)`)
 * short-circuits to it. NON-bench surfaces (CLI/web) pass no such opt and so
 * stay default-OFF (byte-identical) — only bench flips on.
 */
export const resolveBenchReasoningSummary = (env: Record<string, string | undefined>): boolean =>
  readBool(env.QUANTA_REASONING_SUMMARY, /* defaultOn */ true)

/**
 * Bench default for reasoning summary detail level. DEFAULT: `"detailed"` for
 * bench (maximises CoT visibility in trajectory). Operator can override with
 * `QUANTA_REASONING_SUMMARY_DETAIL=auto|concise|detailed`.
 *
 * Why `"detailed"` for bench: the trajectory recorder captures the full
 * reasoning summary so the operator can understand why the agent made each
 * decision. `"detailed"` gives the most verbose CoT (vs `"auto"` which the
 * API may abbreviate). An explicit env value always wins.
 *
 * NON-bench surfaces pass no explicit `opts.reasoningSummaryDetail`, so the
 * factory's `resolveReasoningSummaryDetail` sees `undefined` from both opts and
 * the (unset) env → returns `undefined` → wire defaults to `"auto"`
 * (byte-identical). Only bench flips the CODE default to `"detailed"`.
 */
export const resolveBenchReasoningSummaryDetail = (
  env: Record<string, string | undefined>,
): "auto" | "concise" | "detailed" => {
  const raw = env.QUANTA_REASONING_SUMMARY_DETAIL
  if (raw === "auto" || raw === "concise" || raw === "detailed") return raw
  return "detailed" // bench default: max detail for trajectory readability
}
