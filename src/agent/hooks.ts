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
 */

export type HookEvent =
  | { type: "session_start"; sessionId: string }
  | { type: "session_end"; reason: string; turns: number }
  | { type: "pre_tool_use"; name: string; input: unknown }
  | { type: "post_tool_use"; name: string; ok: boolean; output: string }
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

/**
 * A handler may return anything; only a `{ deny: string }` and/or
 * `{ updatedInput }` from a `pre_tool_use` handler is acted on (deny blocks the
 * call; updatedInput rewrites its args). Returning nothing is the common no-op
 * case, so the return type is intentionally `unknown` (a `HookDeny | void`
 * union trips biome's noConfusingVoidType, and forcing every no-op handler to
 * `return undefined` is poor ergonomics).
 */
export type HookHandler<T extends HookEventType> = (event: HookEventOf<T>) => unknown

/** Result of {@link HookBus.emit}. `deny` carries the first `pre_tool_use`
 *  refusal (else null); `updatedInput` is PRESENT (key included) only when a
 *  `pre_tool_use` handler rewrote the args, carrying the last/composed rewrite.
 *  Non-pre_tool_use events always return `{ deny: null }`. */
export interface HookEmitResult {
  deny: HookDeny | null
  updatedInput?: unknown
}

const isDeny = (v: unknown): v is HookDeny =>
  typeof v === "object" && v !== null && typeof (v as HookDeny).deny === "string"

const isUpdatedInput = (v: unknown): v is HookUpdatedInput =>
  typeof v === "object" && v !== null && "updatedInput" in v

/** Type-erased handler stored internally. The `HookBus.on` API preserves the
 *  per-type narrowing by closure-capturing the user's `HookHandler<T>` and
 *  routing only the type-matching events to it via the Map bucket key — so the
 *  runtime cast inside the closure is safe by construction (the Map enforces
 *  that a handler is only ever invoked with events of its registered type).
 *  R-Phase4 P3-2: replaces the prior `as unknown as HookHandler<HookEventType>`
 *  cast at registration time with a structural closure. */
type AnyHookHandler = (event: HookEvent) => unknown

/** Registration options for {@link HookBus.on}. `matcher` is consulted ONLY
 *  for tool-shaped events (`pre_tool_use` / `post_tool_use`) — other variants
 *  carry no `name` field and the matcher is ignored. Omitting `options` is
 *  byte-identical to the prior 2-arg signature. Tier-0 absorption #0-1 (AWF
 *  2-matcher). */
export interface HookOnOptions {
  matcher?: ToolMatcher
}

interface StoredHandler {
  readonly fn: AnyHookHandler
  readonly matcher: ToolMatcher | undefined
}

const isToolEvent = (event: HookEvent): event is Extract<HookEvent, { name: string }> =>
  event.type === "pre_tool_use" || event.type === "post_tool_use"

export class HookBus {
  private readonly handlers = new Map<HookEventType, StoredHandler[]>()
  private readonly logger: StructuredLogger | undefined

  constructor(logger?: StructuredLogger) {
    this.logger = logger
  }

  /** Register `handler` for `type`. Handlers fire in registration order.
   *  Optional `options.matcher` gates dispatch on tool-shaped events
   *  (`pre_tool_use`, `post_tool_use`); non-tool events ignore it. */
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
   * `pre_tool_use` / `post_tool_use` events carry a name).
   *
   * For `pre_tool_use`, each handler sees the latest input: a `{ updatedInput }`
   * from an earlier handler becomes the `event.input` the next handler receives,
   * so rewrites compose deterministically in registration order.
   */
  async emit(event: HookEvent): Promise<HookEmitResult> {
    const list = this.handlers.get(event.type)
    if (list === undefined) return { deny: null }
    // pre_tool_use is the only variant that can deny or rewrite input — it owns
    // the composition loop. Every other event just fires its (matched) handlers.
    if (event.type === "pre_tool_use") return this.emitPreToolUse(event, list)
    const toolEvent = isToolEvent(event)
    for (const stored of list) {
      if (toolEvent && !matchTool(stored.matcher, event.name)) continue
      await this.runHandler(stored, event)
    }
    return { deny: null }
  }

  /** Composition loop for `pre_tool_use`: threads the (possibly rewritten) input
   *  through matched handlers, recording the first deny and the last rewrite. */
  private async emitPreToolUse(
    event: HookEventOf<"pre_tool_use">,
    list: StoredHandler[],
  ): Promise<HookEmitResult> {
    let denied: HookDeny | null = null
    let currentInput: unknown = event.input
    let mutated = false
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
    }
    return { deny: denied, ...(mutated ? { updatedInput: currentInput } : {}) }
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
