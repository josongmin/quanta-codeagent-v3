/**
 * `apps/cli/repl/away-summary-wire.ts` — composition-root binding for the AFK
 * away-summary slice (ADR-0465).
 *
 * WHY: `@/agent/away-summary` ships the PURE recap orchestration
 * (`runAwaySummary`) plus the verbatim system prompt and the gate, but it
 * deliberately never imports `@/llm` — the LLM call is the injected
 * {@link SummarizeFn} port (mirrors `@/permission`'s `ClassifierPort`). This
 * file is the ONLY place the concrete adapter is constructed (ARCHITECTURE.md
 * §intro: composition root owns concrete adapters). It wraps the real
 * {@link LLMPort} into a one-shot, tools-DENIED, `maxTurns=1`-equivalent
 * summarizer (one `stream(...)` consumption, no follow-up turn), then exposes
 * an env-gated callable the session invokes on the idle→activity boundary.
 *
 * Default-OFF byte-identical (RFC §1.2): when `QUANTA_ENABLE_AWAY_SUMMARY`
 * is not exactly `"1"`, {@link maybeCreateAwaySummaryWire} returns a frozen
 * NOOP handle and allocates NOTHING beyond that shared singleton — no adapter
 * closure, no LLM consumption, zero net/subprocess calls. (The slice's
 * `runAwaySummary` ALSO re-checks the gate, so this is belt-and-suspenders:
 * the wire short-circuits before ever touching the slice.)
 *
 * No-throw at the boundary: the adapter NEVER rejects — every failure (the
 * port throwing synchronously, the async-iterator rejecting, an abort, an
 * empty stream) resolves to `Err`, which the slice maps to a typed
 * `summarizer-error` / `aborted` skip. The handle's `recap()` returns the
 * slice's `AwaySummaryOutcome` (an `ok`/`skip` discriminated value), never
 * throws, and a NOOP handle always reports `{kind:"skip",reason:gate-off}`.
 *
 * Slice posture: leaf-level apps wire. Imports `@/agent/away-summary` (the
 * orchestrator + port type), `@/llm` (LLMPort + assembleFromEvents — the
 * composition root is allowed to touch concrete adapter helpers), and
 * `@/shared` (Result/ok/err/errMessage/logger). No surface-state coupling.
 */

import {
  type AwaySummaryEnv,
  type AwaySummaryOutcome,
  type RecapTurn,
  runAwaySummary,
  type SummarizeFn,
} from "@/agent/away-summary"
import { assembleFromEvents, type LLMPort, type StreamEvent, type TextBlock } from "@/llm"
import { logger as defaultLogger, err, errMessage, type Logger, ok } from "@/shared"

/** Callable handle returned by {@link maybeCreateAwaySummaryWire}. `recap()`
 *  is the on-idle-return hook the session calls; it is no-throw and returns
 *  the slice's typed outcome. `isActive()` reports whether the env opt-in
 *  fired (false for the NOOP handle). */
export interface AwaySummaryWireHandle {
  /** Produce a recap for the transcript-so-far. NEVER throws. When the wire
   *  is the NOOP handle (gate off) this resolves to the slice's `gate-off`
   *  skip WITHOUT consulting any LLM. `signal` aborts an in-flight recap
   *  (e.g. the user started typing again). */
  readonly recap: (args: {
    readonly transcript: readonly RecapTurn[]
    readonly signal?: AbortSignal | undefined
  }) => Promise<AwaySummaryOutcome>
  /** True iff the env opt-in (`QUANTA_ENABLE_AWAY_SUMMARY==="1"`) fired. */
  readonly isActive: () => boolean
}

/** The single env var that opts a deployment into the away-summary recap.
 *  Re-stated here (not imported) only for the call-site doc; the slice owns
 *  the canonical `AWAY_SUMMARY_ENV` constant and the strict `=== "1"` check. */
export const AWAY_SUMMARY_GATE_ENV = "QUANTA_ENABLE_AWAY_SUMMARY"

/** Inert handle reused for every default-OFF path. One frozen singleton so
 *  the gate-off path allocates NOTHING beyond it. `recap()` returns the
 *  slice-shaped `gate-off` skip so a caller branches identically whether the
 *  wire is on or off. */
const NOOP_HANDLE: AwaySummaryWireHandle = Object.freeze({
  recap: async (): Promise<AwaySummaryOutcome> => ({
    kind: "skip",
    reason: { kind: "gate-off" },
  }),
  isActive: () => false,
})

/** Project a slice {@link RecapTurn} list into a single user message body.
 *  The slice owns NO `@/llm` Message shape, so the composition root flattens
 *  the transcript into one labeled plain-text blob the isolated query reads.
 *  Pure + no-throw. */
const renderTranscript = (transcript: readonly RecapTurn[]): string =>
  transcript
    .map((turn) => `${turn.role === "assistant" ? "Assistant" : "User"}: ${turn.text}`)
    .join("\n")

/** Extract the assistant's plain-text answer from the assembled turn. Joins
 *  every TextBlock (skips thinking / tool_use — tools are denied anyway).
 *  Pure + no-throw. */
const collectText = (events: StreamEvent[]): string => {
  const assembled = assembleFromEvents(events)
  return assembled.message.content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
}

/**
 * Build the concrete {@link SummarizeFn} over a live {@link LLMPort}. The
 * isolated query is single-turn (one `stream(...)`, no tool-result follow-up),
 * tools DENIED (`tools: []` + `toolChoice:{kind:"none"}` so even a model that
 * wants to act cannot), and the verbatim system prompt is forwarded UNMODIFIED.
 *
 * NO-THROW contract (the slice's `SummarizeFn` MUST NOT reject):
 *   - a synchronous throw from `llm.stream(...)`           → Err
 *   - the async iterator rejecting mid-consume             → Err
 *   - an abort (pre- or mid-flight)                        → Err (the slice
 *     maps this to the more-specific `aborted` skip when the signal is set)
 *   - an empty / text-less stream                          → ok("") (the slice
 *     maps blank text to `empty-recap`)
 */
const buildSummarizeFn = (llm: LLMPort, log: Logger): SummarizeFn => {
  return async ({ system, transcript, signal }) => {
    if (signal?.aborted === true) return err(new Error("aborted before request"))
    try {
      const events: StreamEvent[] = []
      const stream = llm.stream({
        messages: [
          { role: "user", content: [{ type: "text", text: renderTranscript(transcript) }] },
        ],
        system,
        tools: [],
        toolChoice: { kind: "none" },
        ...(signal !== undefined ? { signal } : {}),
      })
      for await (const ev of stream) {
        events.push(ev)
      }
      return ok(collectText(events))
    } catch (e) {
      const reason = errMessage(e)
      log.warn(`[away-summary] summarizer failed: ${reason}`)
      return err(new Error(reason))
    }
  }
}

/** Options for {@link maybeCreateAwaySummaryWire}. */
export interface AwaySummaryWireOptions {
  /** The host's already-loaded environment. The slice's gate reads
   *  `QUANTA_ENABLE_AWAY_SUMMARY` from here (never `process.env`). */
  readonly env: AwaySummaryEnv
  /** The live LLM port to wrap. Only consulted on the ON path. */
  readonly llm: LLMPort
  /** Injectable logger (test seam). Default: the shared logger. */
  readonly logger?: Logger
}

/**
 * Composition-root entry point. When `QUANTA_ENABLE_AWAY_SUMMARY === "1"`,
 * returns a live handle whose `recap()` calls the slice's `runAwaySummary`
 * with a freshly-built LLM-backed {@link SummarizeFn}. Otherwise returns the
 * shared NOOP handle (zero allocation, zero LLM).
 *
 * The session calls `recap()` on the idle→activity transition (see the
 * call-site doc at the bottom of this file). The gate is ALSO re-checked
 * inside `runAwaySummary`, so even if a caller invokes the live handle's
 * `recap()` it stays correct; the wire-level gate is the allocation guard.
 */
export const maybeCreateAwaySummaryWire = (opts: AwaySummaryWireOptions): AwaySummaryWireHandle => {
  // Gate read mirrors the slice's strict `=== "1"` semantics. OFF ⇒ the
  // shared NOOP singleton, so default-OFF allocates nothing.
  if (opts.env[AWAY_SUMMARY_GATE_ENV] !== "1") return NOOP_HANDLE

  const log = opts.logger ?? defaultLogger
  const summarize = buildSummarizeFn(opts.llm, log)
  const env = opts.env

  return {
    recap: ({ transcript, signal }) =>
      runAwaySummary(summarize, {
        transcript,
        env,
        ...(signal !== undefined ? { signal } : {}),
      }),
    isActive: () => true,
  }
}
