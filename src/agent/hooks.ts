import type { StructuredLogger } from "@/observability"
import { matchTool, type ToolMatcher } from "./tool-matchers"

/**
 * Minimal in-process hook bus (RFC §13 Q1 → DECISION: Phase-3, in-process only).
 *
 * Rationale: v2's failure was workflow/plugin weight (RFC §1.2). A hook system
 * does not need a process boundary, a manifest, or a registry to be useful in a
 * single-binary agent — it needs exactly one thing: deterministic in-loop
 * extension points. So this is a tiny typed event bus, nothing more. When no
 * bus is attached to {@link AgentConfig} the loop never constructs or calls one,
 * so the default path is byte-for-byte unchanged (behavior-preserving).
 *
 * Semantics:
 * - Handlers run sequentially in registration order (deterministic).
 * - Handlers may be async; each is awaited before the next.
 * - A throwing handler is caught and logged via {@link StructuredLogger}; it
 *   never breaks the loop and never stops later handlers.
 * - A `pre_tool_use` handler may return `{ deny: string }` to block the call.
 *   The first deny wins; the tool becomes an error tool_result and the model
 *   recovers (mirrors the permission-deny path in dispatch.ts).
 * - A `pre_tool_use` handler may return `{ updatedInput }` to REWRITE the tool
 *   arguments before execution (Cursor `updated_input` parity, AWF
 *   `beforeShellExecution`/`beforeReadFile` mutate seam). Rewrites COMPOSE: each
 *   subsequent handler sees the prior handler's `updatedInput` as its
 *   `event.input`, so a chain of handlers can each refine the args. The LAST
 *   rewrite is what `emit` returns.
 *
 *   SECURITY: a rewrite is applied at the pre_tool_use seam, which dispatch runs
 *   AFTER the permission / HARD_DENY gates have evaluated the ORIGINAL input. A
 *   hook is operator-authored local code at the same trust level as the
 *   permission config itself, so this is intentional (it cannot be reached by
 *   the model or by untrusted content); it is NOT a sandbox-escape vector. A
 *   handler that both denies AND rewrites is treated as a deny (the rewrite is
 *   moot because the call never executes).
 *
 * ADR-0133 — Bidirectional Request/Response RPC (Cursor `ExecuteHookResult`
 * parity). Two superset extensions, both backward-compatible:
 *
 *   1. Three NEW lifecycle event variants on the {@link HookEvent} union:
 *      `post_tool_use_failure` (tool execution failed), `pre_compact`
 *      (transcript compaction about to run), `subagent_start` /
 *      `subagent_stop` (forked-child lifecycle). The legacy 5 variants
 *      (`session_start`/`session_end`/`pre_tool_use`/`post_tool_use`/
 *      `turn_start`) are UNCHANGED — every prior test/integration on those
 *      events still type-checks and runs the same code path.
 *
 *   2. Two NEW optional fields on {@link HookEmitResult}: `promptHook`
 *      (accumulated `injectAfterSystem`/`injectBeforeUser` text the loop
 *      should fold into the NEXT LLM turn's prompt) and `abort` (any handler
 *      can ask the loop to stop the current operation — compaction is
 *      skipped, subagent fork is cancelled, dispatch raises). Both are
 *      OMITTED when no handler emitted them (presence-not-truthiness), so
 *      every legacy caller that reads only `{deny, updatedInput?}` is
 *      byte-identical.
 *
 *   `promptHook` is bounded by {@link PROMPT_HOOK_MAX_CHARS}. When the
 *   running total for one side (after-system OR before-user) exceeds the
 *   cap, the OLDEST text is dropped (FIFO trim) and a warning is logged via
 *   {@link StructuredLogger}. This is a defense against an
 *   accumulate-each-turn handler quietly inflating the prompt.
 *
 *   `abort` from a single handler stops the emit chain (no later handler
 *   runs for that emit). Like `deny`, the first wins.
 */

/** Maximum characters accumulated per side (`injectAfterSystem` or
 *  `injectBeforeUser`) of a {@link HookPromptInject}. When a single emit's
 *  accumulated text exceeds this, the oldest text is dropped (FIFO) and a
 *  warning is logged. The cap is per-side (10K chars each, ~2.5K tokens by
 *  chars/4) so total worst case = 20K chars ≈ 5K tokens per emit — bounded
 *  but generous enough for a real "inject a checklist" use case. */
export const PROMPT_HOOK_MAX_CHARS = 10_000

/** Maximum retries of a SAME (tool_use call_id) after a
 *  `post_tool_use_failure` hook responds with a `promptHook`-only response
 *  (no `abort`). Without this cap, a hook that always tells the model "try
 *  again" with no `abort` could loop indefinitely. The counter is enforced
 *  by the dispatch caller (`dispatch.ts`); hooks.ts exports the constant
 *  so tests can reference the same number. */
export const TOOL_FAILURE_RETRY_MAX = 3

export type HookEvent =
  | { type: "session_start"; sessionId: string }
  | { type: "session_end"; reason: string; turns: number }
  | { type: "pre_tool_use"; name: string; input: unknown }
  | { type: "post_tool_use"; name: string; input: unknown; ok: boolean; output: string }
  // ADR-0133 — NEW. Fired when `execute()` returned `ok:false` (a typed tool
  // failure) OR when the execute path threw and dispatch normalized it. The
  // `error` string is the post-redaction tool output text (the same content
  // the model would see). Response may carry `promptHook` (inject context for
  // a retry) or `abort` (halt the loop). `updatedInput` is NOT honored here
  // (the tool already ran with its input; rewriting it post-hoc is
  // meaningless).
  | { type: "post_tool_use_failure"; name: string; input: unknown; error: string }
  // ADR-0133 — NEW. Fired by `compaction.ts` IMMEDIATELY BEFORE the summarizer
  // LLM runs. `isFirstCompaction` lets a host treat the first compact of a
  // session differently (e.g. warm-up vs. steady-state). Response may carry
  // `abort` to skip THIS compaction (the loop's breaker treats it as no
  // progress and re-evaluates next turn).
  | {
      type: "pre_compact"
      messagesToCompact: number
      isFirstCompaction: boolean
    }
  // ADR-0133 — NEW. Fired by `subagent-runner.ts` immediately after the child
  // config has been built and BEFORE the child `runAgent` is invoked.
  // Response may carry `abort` (cancel the fork before it spawns) or
  // `promptHook` (the PARENT will see this in its NEXT turn after the child
  // resumes — typed as `subagentStartPromptHook` on the bus internally).
  | {
      type: "subagent_start"
      subagentId: string
      parentId: string | undefined
      taskPrompt: string
    }
  // ADR-0133 — NEW. Fired by `subagent-runner.ts` immediately after the child
  // returns. `result.ok` mirrors `SubagentResult.ok`; `result.finalText` is
  // the joined final-assistant text. Response may carry `promptHook` (e.g.
  // "the subagent reported X — consider Y") which the parent loop folds into
  // its NEXT prompt.
  | {
      type: "subagent_stop"
      subagentId: string
      result: { ok: boolean; finalText: string; turns: number }
    }
  | { type: "turn_start"; turn: number }

export type HookEventType = HookEvent["type"]

/** Narrow a {@link HookEvent} to one variant by its `type`. */
export type HookEventOf<T extends HookEventType> = Extract<HookEvent, { type: T }>

/** A `pre_tool_use` handler may return this to block the call. */
export interface HookDeny {
  deny: string
}

/** A `pre_tool_use` handler may return this to REWRITE the tool input before
 *  execution (Cursor `updated_input` parity). Presence of the `updatedInput`
 *  KEY is the signal — the value itself is opaque (the tool re-validates its
 *  own schema), so a rewrite to `undefined`/`null` is still an explicit
 *  rewrite, distinct from a no-op handler that returns nothing. */
export interface HookUpdatedInput {
  updatedInput: unknown
}

/** ADR-0133 — text a handler asks the loop to fold into the NEXT LLM turn's
 *  prompt. `injectAfterSystem` is appended to the end of the system prompt;
 *  `injectBeforeUser` is prepended to the trailing user-side messages. Both
 *  optional (a handler may set one or both). Each side has an independent
 *  {@link PROMPT_HOOK_MAX_CHARS} budget; accumulation across multiple emits in
 *  the same turn is governed by the bus on its `emit` call (per-emit) and by
 *  the loop's pending-queue trimmer (across emits). */
export interface HookPromptInject {
  injectAfterSystem?: string
  injectBeforeUser?: string
}

/** A handler return that asks the loop to abort the current operation
 *  (compaction skip / subagent fork cancel / dispatch throw). First wins;
 *  subsequent handlers for this emit are NOT run. */
export interface HookAbort {
  abort: { reason: string }
}

/** ADR-0133 — V2 deferred. A handler may surface a tool-set delta for the
 *  NEXT turn: `add` registers extra tools (lazy-load), `remove` blacklists
 *  by name. We type the field on {@link HookEmitResult} so callers can
 *  forward it through their pipelines, but the loop does NOT yet apply it
 *  (no producer wires `add`/`remove` today; V2 will wire the registry
 *  patcher). Defined so the contract is forward-compatible. */
export interface HookToolOverride {
  add?: readonly { name: string; description?: string }[]
  remove?: readonly string[]
}

/**
 * A handler may return anything; only a `{ deny: string }` and/or
 * `{ updatedInput }` from a `pre_tool_use` handler is acted on (deny blocks the
 * call; updatedInput rewrites its args). Returning nothing is the common no-op
 * case, so the return type is intentionally `unknown` (a `HookDeny | void`
 * union trips biome's noConfusingVoidType, and forcing every no-op handler to
 * `return undefined` is poor ergonomics).
 *
 * ADR-0133 — a handler MAY also return a combined object with any of
 * `{ promptHook, abort, toolOverride }`. These are recognized for EVERY event
 * variant (not just pre_tool_use); the seam that consumes the emit decides
 * whether the response is meaningful (e.g. `pre_compact` honors `abort`,
 * ignores `updatedInput`).
 */
export type HookHandler<T extends HookEventType> = (event: HookEventOf<T>) => unknown

/** Result of {@link HookBus.emit}.
 *
 *  - `deny`: first `pre_tool_use` refusal (else null). Backward-compat.
 *  - `updatedInput`: PRESENT (key included) only when a `pre_tool_use` handler
 *    rewrote the args. Backward-compat.
 *
 *  ADR-0133 — NEW (all optional; OMITTED when no handler set them):
 *  - `promptHook`: accumulated `injectAfterSystem` / `injectBeforeUser` text
 *    from every handler that returned one. Capped at
 *    {@link PROMPT_HOOK_MAX_CHARS} per side; FIFO trim with a logger warning
 *    when exceeded.
 *  - `abort`: present (with `reason`) when the FIRST handler that returned
 *    one — like `deny`, the rest are not consulted. Note that for
 *    `pre_tool_use` we still run subsequent handlers for the rewrite chain
 *    (deny stops further deny consideration, not the chain itself); for the
 *    other events `abort` short-circuits the loop.
 *  - `toolOverride`: V2-deferred. Defined for forward compat — callers may
 *    forward it; today the loop ignores it. */
export interface HookEmitResult {
  deny: HookDeny | null
  updatedInput?: unknown
  promptHook?: HookPromptInject
  abort?: { reason: string }
  toolOverride?: HookToolOverride
}

const isDeny = (v: unknown): v is HookDeny =>
  typeof v === "object" && v !== null && typeof (v as HookDeny).deny === "string"

const isUpdatedInput = (v: unknown): v is HookUpdatedInput =>
  typeof v === "object" && v !== null && "updatedInput" in v

const isAbort = (v: unknown): v is HookAbort => {
  if (typeof v !== "object" || v === null) return false
  const a = (v as { abort?: unknown }).abort
  return (
    typeof a === "object" && a !== null && typeof (a as { reason?: unknown }).reason === "string"
  )
}

const isPromptHook = (v: unknown): v is { promptHook: HookPromptInject } => {
  if (typeof v !== "object" || v === null || !("promptHook" in v)) return false
  const ph = (v as { promptHook: unknown }).promptHook
  if (typeof ph !== "object" || ph === null) return false
  const after = (ph as { injectAfterSystem?: unknown }).injectAfterSystem
  const before = (ph as { injectBeforeUser?: unknown }).injectBeforeUser
  // At least one side present and a string. Either side may be omitted.
  return typeof after === "string" || typeof before === "string"
}

const isToolOverride = (v: unknown): v is { toolOverride: HookToolOverride } => {
  if (typeof v !== "object" || v === null || !("toolOverride" in v)) return false
  const ov = (v as { toolOverride: unknown }).toolOverride
  return typeof ov === "object" && ov !== null
}

/** Type-erased handler stored internally. The `HookBus.on` API preserves the
 *  per-type narrowing by closure-capturing the user's `HookHandler<T>` and
 *  routing only the type-matching events to it via the Map bucket key — so the
 *  runtime cast inside the closure is safe by construction (the Map enforces
 *  that a handler is only ever invoked with events of its registered type).
 *  R-Phase4 P3-2: replaces the prior `as unknown as HookHandler<HookEventType>`
 *  cast at registration time with a structural closure. */
type AnyHookHandler = (event: HookEvent) => unknown

/** Registration options for {@link HookBus.on}. `matcher` is consulted ONLY
 *  for tool-shaped events (`pre_tool_use` / `post_tool_use` /
 *  `post_tool_use_failure`) — other variants carry no `name` field and the
 *  matcher is ignored. Omitting `options` is byte-identical to the prior
 *  2-arg signature. Tier-0 absorption #0-1 (AWF 2-matcher). */
export interface HookOnOptions {
  matcher?: ToolMatcher
}

interface StoredHandler {
  readonly fn: AnyHookHandler
  readonly matcher: ToolMatcher | undefined
}

const isToolEvent = (event: HookEvent): event is Extract<HookEvent, { name: string }> =>
  event.type === "pre_tool_use" ||
  event.type === "post_tool_use" ||
  event.type === "post_tool_use_failure"

/** Append `next` to the accumulated `side` text. Returns the appended text
 *  trimmed to {@link PROMPT_HOOK_MAX_CHARS} (FIFO: oldest characters dropped).
 *  The caller logs a warning when the trim was non-trivial — keeping the
 *  warn-emit out of this pure helper. */
const appendPromptSide = (
  acc: string | undefined,
  next: string,
): { text: string; trimmed: boolean } => {
  const joined = acc !== undefined && acc.length > 0 ? `${acc}\n${next}` : next
  if (joined.length <= PROMPT_HOOK_MAX_CHARS) return { text: joined, trimmed: false }
  // FIFO trim: keep the TAIL (most recent), drop the head. A consumer that
  // wants a "head-wins" policy can compose two handlers in deliberate order.
  return { text: joined.slice(joined.length - PROMPT_HOOK_MAX_CHARS), trimmed: true }
}

export class HookBus {
  private readonly handlers = new Map<HookEventType, StoredHandler[]>()
  private readonly logger: StructuredLogger | undefined

  constructor(logger?: StructuredLogger) {
    this.logger = logger
  }

  /** Register `handler` for `type`. Handlers fire in registration order.
   *  Optional `options.matcher` gates dispatch on tool-shaped events
   *  (`pre_tool_use`, `post_tool_use`, `post_tool_use_failure`); non-tool
   *  events ignore it. */
  on<T extends HookEventType>(type: T, handler: HookHandler<T>, options?: HookOnOptions): this {
    const list = this.handlers.get(type) ?? []
    // Closure-erase to the union: the Map key (`type`) GUARANTEES this stored
    // closure is only invoked with events whose `.type === type`, so the
    // narrowing assertion is safe at runtime (the alternative — `as unknown as
    // HookHandler<HookEventType>` at the call-site of `on()` — was the lint
    // warning hooks.ts:63 carried prior to R-Phase4 P3-2).
    const fn: AnyHookHandler = (event: HookEvent) => handler(event as HookEventOf<T>)
    list.push({ fn, matcher: options?.matcher })
    this.handlers.set(type, list)
    return this
  }

  /**
   * Emit `event` to every registered handler sequentially. Returns the first
   * `{ deny }` produced by a `pre_tool_use` handler (else null) plus, when a
   * `pre_tool_use` handler rewrote the args, the composed `updatedInput`. A
   * throwing handler is caught + logged and does not abort the emit. Handlers
   * whose registered matcher rejects the tool name are skipped silently (only
   * `pre_tool_use` / `post_tool_use` / `post_tool_use_failure` events carry
   * a name).
   *
   * For `pre_tool_use`, each handler sees the latest input: a `{ updatedInput }`
   * from an earlier handler becomes the `event.input` the next handler receives,
   * so rewrites compose deterministically in registration order.
   *
   * ADR-0133 — for every event, a handler MAY return `{ promptHook, abort,
   * toolOverride }` (any subset). The first `abort` short-circuits the rest
   * of the chain (later handlers are NOT run). `promptHook` is ACCUMULATED
   * across handlers and trimmed to {@link PROMPT_HOOK_MAX_CHARS} per side.
   */
  async emit(event: HookEvent): Promise<HookEmitResult> {
    const list = this.handlers.get(event.type)
    if (list === undefined) return { deny: null }
    // pre_tool_use is the only variant that can deny or rewrite input — it owns
    // the composition loop. Every other event still runs each matched handler
    // but only collects `promptHook` / `abort` / `toolOverride` from them.
    if (event.type === "pre_tool_use") return this.emitPreToolUse(event, list)
    return this.emitGeneric(event, list)
  }

  /** Composition loop for `pre_tool_use`: threads the (possibly rewritten) input
   *  through matched handlers, recording the first deny and the last rewrite.
   *  Also collects `promptHook` / `abort` / `toolOverride` like
   *  {@link emitGeneric}. */
  private async emitPreToolUse(
    event: HookEventOf<"pre_tool_use">,
    list: StoredHandler[],
  ): Promise<HookEmitResult> {
    let denied: HookDeny | null = null
    let currentInput: unknown = event.input
    let mutated = false
    const acc = this.makeAccumulator()
    for (const stored of list) {
      if (!matchTool(stored.matcher, event.name)) continue
      // Re-materialize with the latest input so a prior handler's rewrite is
      // visible to this one (rewrites compose in registration order).
      const result = await this.runHandler(stored, {
        type: "pre_tool_use",
        name: event.name,
        input: currentInput,
      })
      // Normalize to a pure HookDeny — a handler may return a combined
      // `{ deny, updatedInput }`, but the deny channel carries only the reason
      // string (the rewrite rides the separate updatedInput channel).
      if (denied === null && isDeny(result)) denied = { deny: result.deny }
      if (isUpdatedInput(result)) {
        currentInput = result.updatedInput
        mutated = true
      }
      // ADR-0133 — abort short-circuits the chain (first wins). promptHook /
      // toolOverride are still recorded from results PRIOR to this point;
      // after a producer-side abort, we stop running further handlers.
      if (isAbort(result) && acc.abort === undefined) {
        acc.abort = { reason: result.abort.reason }
      }
      this.accumulatePromptHook(acc, result, event.type)
      this.accumulateToolOverride(acc, result)
      if (acc.abort !== undefined) break
    }
    const out: HookEmitResult = { deny: denied }
    if (mutated) out.updatedInput = currentInput
    this.materializeAccumulator(out, acc)
    return out
  }

  /** Generic loop for every non-`pre_tool_use` event: run each (matched)
   *  handler in order, capturing `promptHook` / `abort` / `toolOverride`.
   *  Stops the chain on the first `abort`. */
  private async emitGeneric(event: HookEvent, list: StoredHandler[]): Promise<HookEmitResult> {
    const toolEvent = isToolEvent(event)
    const acc = this.makeAccumulator()
    for (const stored of list) {
      if (toolEvent && !matchTool(stored.matcher, event.name)) continue
      const result = await this.runHandler(stored, event)
      if (isAbort(result) && acc.abort === undefined) {
        acc.abort = { reason: result.abort.reason }
      }
      this.accumulatePromptHook(acc, result, event.type)
      this.accumulateToolOverride(acc, result)
      if (acc.abort !== undefined) break
    }
    const out: HookEmitResult = { deny: null }
    this.materializeAccumulator(out, acc)
    return out
  }

  /** Internal accumulator for the optional ADR-0133 fields. Kept as a plain
   *  object (not on the result yet) so the OMIT-when-empty contract is
   *  enforced in ONE place: {@link materializeAccumulator}. */
  private makeAccumulator(): {
    afterSystem: string | undefined
    beforeUser: string | undefined
    abort: { reason: string } | undefined
    toolOverrideAdd: { name: string; description?: string }[]
    toolOverrideRemove: string[]
  } {
    return {
      afterSystem: undefined,
      beforeUser: undefined,
      abort: undefined,
      toolOverrideAdd: [],
      toolOverrideRemove: [],
    }
  }

  /** Fold a handler's `promptHook` into the accumulator, enforcing the
   *  {@link PROMPT_HOOK_MAX_CHARS} per-side cap. Logs a warning when a side
   *  was trimmed. */
  private accumulatePromptHook(
    acc: ReturnType<HookBus["makeAccumulator"]>,
    result: unknown,
    eventType: HookEventType,
  ): void {
    if (!isPromptHook(result)) return
    const ph = result.promptHook
    if (typeof ph.injectAfterSystem === "string" && ph.injectAfterSystem.length > 0) {
      const next = appendPromptSide(acc.afterSystem, ph.injectAfterSystem)
      acc.afterSystem = next.text
      if (next.trimmed) {
        this.logger?.warn("hook.prompt_hook.trimmed", {
          event: eventType,
          side: "injectAfterSystem",
          cap: PROMPT_HOOK_MAX_CHARS,
        })
      }
    }
    if (typeof ph.injectBeforeUser === "string" && ph.injectBeforeUser.length > 0) {
      const next = appendPromptSide(acc.beforeUser, ph.injectBeforeUser)
      acc.beforeUser = next.text
      if (next.trimmed) {
        this.logger?.warn("hook.prompt_hook.trimmed", {
          event: eventType,
          side: "injectBeforeUser",
          cap: PROMPT_HOOK_MAX_CHARS,
        })
      }
    }
  }

  /** Fold a handler's `toolOverride` into the accumulator. V2-deferred — we
   *  record it but the loop does not apply it yet. */
  private accumulateToolOverride(
    acc: ReturnType<HookBus["makeAccumulator"]>,
    result: unknown,
  ): void {
    if (!isToolOverride(result)) return
    const ov = result.toolOverride
    if (Array.isArray(ov.add)) acc.toolOverrideAdd.push(...ov.add)
    if (Array.isArray(ov.remove)) acc.toolOverrideRemove.push(...ov.remove)
  }

  /** Write the accumulator's non-empty fields onto `out`. OMITS each field
   *  when its source is empty/undefined so a result with no extra channels
   *  is byte-identical to the legacy `{deny, updatedInput?}` shape. */
  private materializeAccumulator(
    out: HookEmitResult,
    acc: ReturnType<HookBus["makeAccumulator"]>,
  ): void {
    if (acc.afterSystem !== undefined || acc.beforeUser !== undefined) {
      const ph: HookPromptInject = {}
      if (acc.afterSystem !== undefined) ph.injectAfterSystem = acc.afterSystem
      if (acc.beforeUser !== undefined) ph.injectBeforeUser = acc.beforeUser
      out.promptHook = ph
    }
    if (acc.abort !== undefined) out.abort = acc.abort
    if (acc.toolOverrideAdd.length > 0 || acc.toolOverrideRemove.length > 0) {
      const ov: HookToolOverride = {}
      if (acc.toolOverrideAdd.length > 0) ov.add = acc.toolOverrideAdd
      if (acc.toolOverrideRemove.length > 0) ov.remove = acc.toolOverrideRemove
      out.toolOverride = ov
    }
  }

  /** Run one stored handler, isolating + logging a throw (returns `undefined`
   *  on throw so the caller treats it as a no-op result). */
  private async runHandler(stored: StoredHandler, event: HookEvent): Promise<unknown> {
    try {
      return await stored.fn(event)
    } catch (e) {
      this.logger?.error("hook.handler.error", {
        event: event.type,
        error: (e as Error).message,
      })
      return undefined
    }
  }
}
