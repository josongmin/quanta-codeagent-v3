/**
 * `apps/cli/repl/prompt-suggestion-wire.ts` — ADR-0467 CLI composition-root
 * binding for the prompt-suggestion slice (`@/agent/prompt-suggestion`).
 *
 * WHY: the slice is pure + port-inverted. `runPromptSuggestion(suggest, req)`
 * applies the cheap suppression/reject gates and consults an INJECTED
 * {@link SuggestFn} at most once. Nothing in `@/apps` builds that adapter
 * today, so the feature is dead until a surface (1) constructs a `SuggestFn`
 * over a real `LLMPort` AND (2) sets `QUANTA_ENABLE_PROMPT_SUGGESTION=1`.
 * This file is that composition-root step: it builds the concrete adapter
 * (the ONLY place concrete deps are constructed — ARCHITECTURE.md §intro) and
 * an env-gated wire the repl invokes AFTER a turn completes / before the next
 * input prompt.
 *
 * ADAPTER: `buildSuggestFn(llm)` wraps `LLMPort.stream` into a dedicated
 * single-shot "SUGGESTION MODE" call:
 *   - tools DENIED (`tools: []`) so the model can only emit text;
 *   - `system` = the slice's `SUGGESTION_MODE_SYSTEM_PROMPT` (single source
 *     of truth — the sanitizer expects the `<suggestion>…</suggestion>`
 *     wrapper it asks for);
 *   - one user turn carrying the prior transcript tail as plain context;
 *   - collects ONLY `text_delta` events into the raw string (thinking /
 *     tool_use / usage / progress events are ignored — the model is told not
 *     to use tools, but we defend structurally too).
 * The adapter returns `Result<string>`; the slice's `SuggestFn` contract is
 * `Promise<string | undefined>` and MUST NOT throw, so the wire maps
 * `Err → undefined` (the honest "show nothing" degrade).
 *
 * DEFAULT-OFF byte-identical (RFC §1.2): when
 * `QUANTA_ENABLE_PROMPT_SUGGESTION !== "1"`, `maybeCreatePromptSuggestionWire`
 * returns `null` (NO callable) and allocates NOTHING — no adapter, no closure
 * over the LLM, zero `stream()` calls. The host's after-turn boundary skips a
 * null wire. (The slice's own `runPromptSuggestion` ALSO short-circuits on the
 * same gate, so even a wired-but-gate-off path makes zero model calls; the
 * wire-level null is the cheaper outer guard so we never even build the
 * adapter.)
 *
 * NO-THROW at the boundary: `run()` catches everything and resolves; a thrown
 * adapter, a thrown `runPromptSuggestion`, or a thrown render is caught +
 * `logger.warn`-ed and the turn continues. A `{kind:"suppress"}` outcome
 * renders nothing.
 *
 * Slice posture: leaf-level @/apps wire. Imports `@/agent/prompt-suggestion`
 * (the pure orchestrator + types), `@/llm` (the `LLMPort` / `Message` types it
 * adapts), and `@/shared` (`Result` / `logger` / `errMessage`). No
 * `@/permission` / `@/mcp` / `@/tool` / loop imports.
 */

import {
  type AppStateView,
  type PromptSuggestionRequest,
  promptSuggestionEnabled,
  runPromptSuggestion,
  SUGGESTION_MODE_SYSTEM_PROMPT,
  type SuggestFn,
} from "@/agent/prompt-suggestion"
import type { LLMPort, Message } from "@/llm"
import { errMessage, logger, ok, type Result } from "@/shared"

/** The default-OFF gate. Value MUST be exactly `"1"` — mirrors Claude Code's
 *  `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION`. The slice re-exports the same
 *  literal via `PROMPT_SUGGESTION_ENV`; we restate it here so the wire's gate
 *  check needs no extra import. */
export const PROMPT_SUGGESTION_ENV = "QUANTA_ENABLE_PROMPT_SUGGESTION"

/** Render sink for an accepted suggestion. The host paints `text` as a dim
 *  one-line hint before the next composer row. */
export type PromptSuggestionRender = (text: string) => void

/** A live prompt-suggestion wire. The repl calls `run(args)` once at the
 *  after-turn boundary (post-record, pre-next-prompt). Always resolves —
 *  never throws, never rejects. */
export interface PromptSuggestionWire {
  /** Attempt one suggestion for the just-finished turn. The recent transcript
   *  tail seeds the model; the typed `state` drives the suppression gate. On
   *  `{kind:"show"}` the wire calls `render(text)`; on suppress / failure it
   *  renders nothing. */
  run(args: PromptSuggestionRunArgs): Promise<void>
}

/** Per-invocation inputs supplied by the after-turn boundary. */
export interface PromptSuggestionRunArgs {
  /** The transcript after the finished turn — the tail is shown to the
   *  suggestion model as plain context. */
  readonly messages: ReadonlyArray<Message>
  /** Typed surface state for the suppression-context guard. */
  readonly state: AppStateView
  /** Optional cancellation (the live turn-cancel signal is fine — a pre-aborted
   *  signal short-circuits the slice to `no_output`). */
  readonly signal?: AbortSignal
}

/** Live CLI state ports read at turn completion. Every port is optional so a
 *  partially composed surface is representable; the adapter treats any absent,
 *  throwing, or malformed result as unknown and suppresses fail-closed. */
export interface PromptSuggestionStatePorts {
  readonly planMode?: (() => boolean | undefined) | undefined
  readonly providerRateLimitRemainingPercent?: (() => number | undefined) | undefined
  readonly pendingPromptLabels?: (() => readonly (string | undefined)[] | undefined) | undefined
}

type RateLimitTelemetry =
  | { readonly kind: "known"; readonly remainingPercent: number }
  | { readonly kind: "unavailable" }
  | { readonly kind: "unsafe" }

const resolveRateLimitTelemetry = (
  port: PromptSuggestionStatePorts["providerRateLimitRemainingPercent"],
): RateLimitTelemetry => {
  if (port === undefined) return { kind: "unavailable" }
  try {
    const remaining = port()
    if (remaining === undefined) return { kind: "unavailable" }
    if (!Number.isFinite(remaining) || remaining < 0 || remaining > 100) return { kind: "unsafe" }
    return { kind: "known", remainingPercent: remaining }
  } catch {
    return { kind: "unsafe" }
  }
}

export interface PromptSuggestionTurnCompletionAdapter {
  run(args: Omit<PromptSuggestionRunArgs, "state">): Promise<void>
}

/** Options for {@link maybeCreatePromptSuggestionWire}. */
export interface PromptSuggestionWireOptions {
  /** How many trailing transcript messages to feed the suggestion model.
   *  NOT an arbitrary magic number — a bounded tail keeps the single-shot
   *  call cheap; the value is the wire's own context-window budget, exposed
   *  so a host can override it. Default 8. */
  readonly tailMessages?: number
}

const DEFAULT_TAIL_MESSAGES = 8

const resolvePromptSuggestionState = (
  ports: PromptSuggestionStatePorts,
): AppStateView | undefined => {
  try {
    const planMode = ports.planMode?.()
    const labels = ports.pendingPromptLabels?.()
    const rateLimitTelemetry = resolveRateLimitTelemetry(ports.providerRateLimitRemainingPercent)
    if (
      typeof planMode !== "boolean" ||
      labels === undefined ||
      rateLimitTelemetry.kind === "unsafe"
    ) {
      return undefined
    }

    const elicitationActive = labels.some(
      (label) => label === "elicitation" || label === "user-input",
    )
    const pendingPermission = labels.some((label) => label === "approval" || label === "prompt")
    const allLabelsClassified = labels.every(
      (label) =>
        label === "elicitation" ||
        label === "user-input" ||
        label === "approval" ||
        label === "prompt",
    )
    if (!allLabelsClassified) return undefined

    return {
      planMode,
      rateLimited: rateLimitTelemetry.kind === "known" && rateLimitTelemetry.remainingPercent <= 0,
      elicitationActive,
      pendingPermission,
    }
  } catch {
    return undefined
  }
}

/** Production after-turn adapter. It snapshots every authoritative state port
 *  immediately before the suggestion gate; unknown state returns without even
 *  invoking the wire, so the model is never called on an inferred `false`. */
export const buildPromptSuggestionTurnCompletionAdapter = (
  wire: PromptSuggestionWire | null,
  statePorts: PromptSuggestionStatePorts,
): PromptSuggestionTurnCompletionAdapter | null => {
  if (wire === null) return null
  return {
    run: async (args): Promise<void> => {
      const state = resolvePromptSuggestionState(statePorts)
      if (state === undefined) return
      await wire.run({ ...args, state })
    },
  }
}

/** Flatten a transcript message to plain text for the suggestion context.
 *  Only `text` blocks survive — tool_use / thinking / images carry no signal
 *  the suggestion model needs and would only inflate the prompt. */
const messageToText = (m: Message): string =>
  m.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")

/** Build the single user turn handed to the SUGGESTION-MODE call: the recent
 *  transcript tail rendered as a labelled plain-text block. */
const buildSuggestionMessages = (tail: ReadonlyArray<Message>, limit: number): Message[] => {
  const recent = tail.slice(-limit)
  const transcript = recent.map((m) => `${m.role.toUpperCase()}: ${messageToText(m)}`).join("\n")
  return [
    {
      role: "user",
      content: [{ type: "text", text: transcript }],
    },
  ]
}

/**
 * Concrete `SuggestFn` adapter over an injected {@link LLMPort}. ONE dedicated
 * single-shot call with tools DENIED + the SUGGESTION-MODE system prompt.
 * Returns `Result<string>` — `Err` on any stream failure. The wire maps `Err`
 * to the slice's `undefined` "no candidate" outcome.
 *
 * Exported for the hellgate test (which drives it with a stub `LLMPort`).
 */
export const buildSuggestFnAdapter = (
  llm: LLMPort,
  opts: PromptSuggestionWireOptions | undefined,
): ((messages: ReadonlyArray<Message>, signal?: AbortSignal) => Promise<Result<string>>) => {
  const limit = opts?.tailMessages ?? DEFAULT_TAIL_MESSAGES
  return async (messages, signal) => {
    try {
      let raw = ""
      const stream = llm.stream({
        messages: buildSuggestionMessages(messages, limit),
        system: SUGGESTION_MODE_SYSTEM_PROMPT,
        // maxTurns=1 is enforced structurally: we run exactly ONE stream and
        // never feed tool results back. Tools DENIED so the model cannot act.
        tools: [],
        ...(signal !== undefined ? { signal } : {}),
      })
      for await (const ev of stream) {
        if (ev.type === "text_delta") raw += ev.delta
      }
      return ok(raw)
    } catch (e) {
      // Encode failure as Err — the wire maps it to `undefined` so the slice
      // suppresses with `no_output` (honest "show nothing"). Never rethrows.
      return { ok: false, error: e instanceof Error ? e : new Error(errMessage(e)) }
    }
  }
}

/**
 * Env-gated wire. When `QUANTA_ENABLE_PROMPT_SUGGESTION === "1"` returns a
 * callable the repl invokes after each turn; otherwise returns `null` and
 * allocates NOTHING (default-OFF byte-identical).
 *
 * No-throw: `run()` always resolves. Adapter / orchestrator / render failures
 * are caught + `logger.warn`-ed; the turn proceeds.
 */
export const maybeCreatePromptSuggestionWire = (
  env: Readonly<Record<string, string | undefined>>,
  llm: LLMPort,
  render: PromptSuggestionRender,
  opts?: PromptSuggestionWireOptions,
): PromptSuggestionWire | null => {
  if (!promptSuggestionEnabled(env)) return null

  const adapter = buildSuggestFnAdapter(llm, opts)

  return {
    run: async (args: PromptSuggestionRunArgs): Promise<void> => {
      // The slice's SuggestFn contract is no-throw: encode the adapter's Err
      // as `undefined` (no candidate). The adapter already catches; this maps
      // the Result.
      const suggest: SuggestFn = async (signal) => {
        const res = await adapter(args.messages, signal)
        return res.ok ? res.value : undefined
      }
      const req: PromptSuggestionRequest = {
        env,
        state: args.state,
        ...(args.signal !== undefined ? { signal: args.signal } : {}),
      }
      try {
        const outcome = await runPromptSuggestion(suggest, req)
        // `runPromptSuggestion` returns `ok` for every NORMAL outcome; an Err
        // would be a forward-compat hard fault — render nothing on it.
        if (!outcome.ok) return
        if (outcome.value.kind === "show") render(outcome.value.text)
      } catch (e) {
        // Defensive belt-and-suspenders: the orchestrator is no-throw on its
        // documented surface, but a render callback that throws must NOT
        // cascade into the loop.
        logger.warn(`[prompt-suggestion] run threw: ${errMessage(e)}`)
      }
    },
  }
}
