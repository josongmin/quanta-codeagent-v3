/**
 * Stream-dispatch callback factory (R2-B P3, byte-identical extract).
 *
 * Background
 * ──────────
 * `streamConsume` (in `./loop.ts`) opens one provider stream per turn and
 * wires the loop's collaborators (registry, dispatch, stream emits, metrics,
 * verify-guard tool history, …) to the pure {@link streamingTurn} engine via
 * five callbacks (`dispatch` + `onTextDelta` + `onToolStart` + `onInProgress`
 * + `onFirstChunk`). Historically those callbacks were inlined as closures
 * inside `streamConsume`, which made the host function dominate `loop.ts`
 * length and forced every reader to mentally page through ~200 lines of
 * collaborator wiring to locate the actual stream lifecycle.
 *
 * This factory hoists the FIVE callbacks (and the two private helpers they
 * use — `tickToolDispatch` for BudgetMeter folding, `skillScopeDeny` for the
 * skill-allowlist deny block) into a single named function. The factory is a
 * pure constructor: it takes the same {@link TurnSession} / {@link TurnState}
 * the loop already threads everywhere PLUS a {@link TurnTimingAnchors}
 * capsule for the TTFT cell, and returns a {@link StreamCallbacks} record the
 * loop spreads into `streamingTurn({...callbacks, ...})`.
 *
 * Default-OFF byte-identical (RFC §1.2)
 * ──────────────────────────────────────
 * Every callback body is COPIED VERBATIM from the prior inline closures —
 * same optional-chain reads, same emit order, same per-tool conditional
 * branches, same `EXACTOPTIONAL` spreads. The factory is a structural lift,
 * not a behavioural redesign: a turn that did N stream emits + M tool
 * dispatches in the prior code path does the SAME N + M with byte-identical
 * payloads after this extract.
 *
 * Cycle safety
 * ────────────
 * Imports from `@/llm`, `@/security`, `@/observability`, plus three siblings
 * (`./dispatch`, `./streaming-dispatch`, `./turn-context`). No edge to
 * `./loop` (which imports US for `createStreamDispatcher`), so the loop ↔
 * stream-callbacks pair is a one-way edge — the `agent-import-cycle` SCC
 * guard's whitelist does not need updating.
 *
 * Scope (R2-B P3 vs R2-B P5)
 * ───────────────────────────
 * This slice is the PURE MECHANICAL extract: rebinding the closures into a
 * named factory + carrying the two private helpers along. The follow-up
 * P5 slice will introduce an explicit `DispatchPort` interface so the
 * factory can be unit-tested against a mock port without spinning up the
 * full `dispatchTool` / `streamingTurn` machinery. P3 deliberately stays
 * untyped beyond {@link StreamCallbacks}.
 */

import type { ToolResultBlock } from "@/llm"
import type { Span } from "@/observability"
import type { RedactionHit } from "@/security"
import { dispatchTool } from "./dispatch"
import type { DispatchOutcome, InProgressIndicator, StreamingCall } from "./streaming-dispatch"
import type { TurnSession, TurnState } from "./turn-context"
import type { AgentConfig } from "./types"

/** The five callbacks {@link streamingTurn} consumes off this seam. The
 *  factory returns this record so the host can spread it into the engine
 *  call (`streamingTurn({...callbacks, events, signal, ...})`). */
export interface StreamCallbacks {
  /** Single-tool pipeline: gate + dispatch + skill-scope deny + work-metrics
   *  + enriched `tool_result` emit. */
  dispatch: (call: StreamingCall) => Promise<DispatchOutcome>
  /** Mirror text deltas onto the loop's `AgentEvent` stream. */
  onTextDelta: (delta: string) => void
  /** Per-tool scheduling notification: emit `tool_call` event, push verify-
   *  guard history entry (when armed). */
  onToolStart: (call: StreamingCall) => void
  /** Provider `response.in_progress` heartbeat (ADR-0048). */
  onInProgress: (indicator: InProgressIndicator) => void
  /** ADR-0077 TTFT seam — captures the first-chunk wall-clock anchor. */
  onFirstChunk: () => void
}

/** TTFT cell — a mutable single-slot for the first-chunk timestamp. Hoisted
 *  out of the dispatch-callback closure so the host's `finally` block can
 *  read the final value without re-capturing it. `value` is `undefined`
 *  when no qualifying chunk has been observed (engine-side guarantee:
 *  `onFirstChunk` fires at most once per stream, possibly multiple times
 *  across `stream_reset` tombstones; per ADR-0077 the REPLACEMENT stream's
 *  fire wins, so we OVERWRITE rather than freeze). */
export interface FirstTokenCell {
  value: number | undefined
}

/** Anchors captured at `streamConsume` open. `requestSentAt` is the
 *  wall-clock anchor immediately preceding the adapter call (matches
 *  Cursor's `submitChat.hangTtft` anchor); `firstTokenAtCell` is the
 *  one-slot cell the `onFirstChunk` callback overwrites.
 *
 *  `samplingSpan` + `samplingStatus` are listed for forward compatibility
 *  with a future iteration that may want to surface OTel sampling-span
 *  state to the callbacks; the P3 factory does NOT read them (their full
 *  lifecycle stays inside `streamConsume`'s try/catch/finally so error
 *  + abort paths remain trivial to reason about). */
export interface TurnTimingAnchors {
  requestSentAt: number
  firstTokenAtCell: FirstTokenCell
  samplingSpan?: Span
  samplingStatus?: "ok" | "error" | "aborted"
}

/** Internal: the dispatch-callback's return shape (a structural superset of
 *  {@link DispatchOutcome} that carries an optional `redactionHits` payload
 *  on the `dispatchTool` branch). Kept local because both branches of the
 *  dispatch closure produce this shape — the `skillScopeDeny` branch never
 *  has redaction hits (it never executed a tool), so the field is optional
 *  to keep the union accessed by the closure uniform. */
type StreamDispatchOut = {
  block: ToolResultBlock
  ok: boolean
  preview: string
  redactionHits?: ReadonlyArray<RedactionHit>
}

/** RFC may-22 Phase 1: BudgetMeter tick helper for tool dispatch. Folds the
 *  bash → shell_command and test_runner → test_run sub-counters into a single
 *  call site so the dispatch callback's cognitive complexity doesn't grow.
 *  Optional-chain on every read so a meter-less config is byte-for-byte
 *  identical to the pre-RFC path. */
const tickToolDispatch = (config: AgentConfig, name: string): void => {
  config.budgetMeter?.tick("tool_call")
  if (name === "bash") config.budgetMeter?.tick("shell_command")
  if (name === "test_runner") config.budgetMeter?.tick("test_run")
}

/** Recoverable deny when a tool is outside the active skill's allowlist. */
const skillScopeDeny = (call: { id: string; name: string }): StreamDispatchOut => ({
  block: {
    type: "tool_result",
    tool_use_id: call.id,
    content:
      `Tool "${call.name}" is not in the active skill's permitted tool set. ` +
      "Use only the tools the skill allows, or invoke a different skill.",
    is_error: true,
  } satisfies ToolResultBlock,
  ok: false,
  preview: "skill-scoped",
})

/**
 * Build the {@link StreamCallbacks} record `streamingTurn` consumes off the
 * loop's stream seam. Pure: the returned closures capture the supplied
 * `session` / `state` / `anchors` and depend on no globals.
 *
 * Field-by-field destructure mirrors the prior inline body so reviewers can
 * diff the closure bodies one-for-one against the pre-extract `streamConsume`.
 *
 * @see {@link StreamCallbacks}
 */
export const createStreamDispatcher = (
  session: TurnSession,
  state: TurnState,
  anchors: TurnTimingAnchors,
): StreamCallbacks => {
  // R2-B P1: destructure into the same local names the original body used so
  // every reference below stays byte-identical (config/recorder/classifier/…).
  const { config, recorder, classifier, skillGate } = session
  const { toolHistory, workingState, collector, onRedaction } = state
  const { firstTokenAtCell } = anchors

  const dispatch = async (call: StreamingCall): Promise<DispatchOutcome> => {
    const s = recorder?.toolExec()
    // RFC may-22 Phase 1: BudgetMeter tick — every tool dispatch counts
    // as one tool_call; bash → shell_command; test_runner → test_run.
    // Optional chain so absence is byte-identical to pre-RFC.
    tickToolDispatch(config, call.name)
    try {
      // ADR-0011: enforce the active skill's tool allowlist —
      // an out-of-scope tool is denied as a recoverable tool_result
      // WITHOUT dispatching it. No gate / no active skill ⇒ unchanged.
      const out =
        skillGate && !skillGate.allow(call.name)
          ? skillScopeDeny(call)
          : await dispatchTool(
              { type: "tool_use", id: call.id, name: call.name, input: call.input },
              config,
              config.permission,
              (message) =>
                config.stream.emit({
                  type: "tool_progress",
                  id: call.id,
                  name: call.name,
                  message,
                }),
              classifier,
              workingState,
            )
      // A successful `Skill` invocation (re)arms the scope for next calls.
      skillGate?.observe(call.name, call.input, out.ok)
      // ADR-0078 point #1 — fold this tool_result's redaction hits into the
      // run-scoped rollup (empty/absent ⇒ no-op; disabled ⇒ dispatch never
      // produced hits).
      onRedaction("tool_result", out.redactionHits ?? [])
      // absorb #6: per-turn work-metrics — count the action and, when the
      // tool is `read`, count returned lines. Collector absent ⇒ no-op
      // (the sink is unwired). recordRead duck-types the result shape so
      // no `@/tool` import is needed here.
      collector?.recordToolCall(call.name, out)
      collector?.recordRead(call.name, out.preview)
      // RFC-0002 §5.2 enriched tool_result. CONTRACT with Group E: the
      // dispatch result exposes these EXACT optional field names
      // (`durationMs:number`, `stderrTail:string`, `exitCode:number`,
      // `fullLogPath:string`). Spread whichever are present so this works
      // the instant E lands and never throws while E is still in flight
      // (pre-E the fields are simply absent → byte-identical emit). Pure
      // observation: NullStream swallows it, control flow is untouched.
      const enriched = out as typeof out & {
        durationMs?: number
        stderrTail?: string
        exitCode?: number
        fullLogPath?: string
      }
      config.stream.emit({
        type: "tool_result",
        id: call.id,
        name: call.name,
        ok: out.ok,
        preview: out.preview,
        ...(enriched.durationMs !== undefined ? { durationMs: enriched.durationMs } : {}),
        ...(enriched.stderrTail !== undefined ? { stderrTail: enriched.stderrTail } : {}),
        ...(enriched.exitCode !== undefined ? { exitCode: enriched.exitCode } : {}),
        ...(enriched.fullLogPath !== undefined ? { fullLogPath: enriched.fullLogPath } : {}),
      })
      return out
    } finally {
      s?.()
    }
  }

  const onTextDelta = (delta: string): void => {
    config.stream.emit({ type: "assistant_text", delta })
  }

  const onToolStart = (call: StreamingCall): void => {
    config.stream.emit({ type: "tool_call", id: call.id, name: call.name, input: call.input })
    recorder?.toolCall(call.name)
    // Verify-guard (Tier 0 safety hardening): ordered dispatched tool entries this run.
    // `toolHistory` is created ONLY when `config.verifyGuard` is set, so
    // with the guard absent this push never runs (byte-identical).
    // A real SWE-bench run showed the guard fired 0 times: the agent ran a
    // noise `bash` (`git status`) after editing and the old policy treated
    // ANY bash as "verified". R1's tightened policy only counts a `bash`
    // when its command matches a test/repro regex — so for `bash` we MUST
    // carry the command string (the bash tool input is `{command:string}`);
    // without it `arg` is always undefined and every real `pytest`/`python
    // repro.py` would be (wrongly) treated as non-verify. For non-`bash`
    // tools `arg` is OMITTED (exactOptionalPropertyTypes — never undefined).
    if (toolHistory) {
      const command =
        call.name === "bash" &&
        typeof call.input === "object" &&
        call.input !== null &&
        "command" in call.input
          ? (call.input as { command: unknown }).command
          : undefined
      toolHistory.push(
        typeof command === "string" ? { name: call.name, arg: command } : { name: call.name },
      )
    }
  }

  // ADR-0048 L4 wire: surface the provider's `response.in_progress`
  // heartbeat as an `in_progress` AgentEvent so a UI can paint a
  // "thinking…" indicator. The indicator carries a stable receive-side
  // `timestamp` plus the optional provider-supplied `message`/`progress`;
  // we forward each present field via the same exact-optional spread the
  // sibling `tool_result` emit uses. Default-OFF byte-identical: when the
  // provider never yields the event the seam never fires, and when
  // `config.stream` is NullStream the emit is a no-op.
  const onInProgress = (indicator: InProgressIndicator): void => {
    config.stream.emit({
      type: "in_progress",
      timestamp: indicator.timestamp,
      ...(indicator.message !== undefined ? { message: indicator.message } : {}),
      ...(indicator.progress !== undefined ? { progress: indicator.progress } : {}),
    })
  }

  // ADR-0077 Plane-B (L4 wire): fire on the FIRST of
  // (text_delta | thinking_delta | tool_use_start). The engine gates
  // the seam (only fires once per stream + re-fires after stream_reset).
  // Each engine fire is a fresh first-chunk event; OVERWRITE so the
  // REPLACEMENT stream's chunk wins (honors ADR-0077 tombstone invariant).
  const onFirstChunk = (): void => {
    firstTokenAtCell.value = Date.now()
  }

  return { dispatch, onTextDelta, onToolStart, onInProgress, onFirstChunk }
}
