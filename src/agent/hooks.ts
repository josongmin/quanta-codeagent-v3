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

/**
 * A handler may return anything; only a `{ deny: string }` from a
 * `pre_tool_use` handler is acted on (it blocks the call). Returning nothing
 * is the common no-op case, so the return type is intentionally `unknown`
 * (a `HookDeny | void` union trips biome's noConfusingVoidType, and forcing
 * every no-op handler to `return undefined` is poor ergonomics).
 */
export type HookHandler<T extends HookEventType> = (event: HookEventOf<T>) => unknown

const isDeny = (v: unknown): v is HookDeny =>
  typeof v === "object" && v !== null && typeof (v as HookDeny).deny === "string"

/** Type-erased handler stored internally. The `HookBus.on` API preserves the
 *  per-type narrowing by closure-capturing the user's `HookHandler<T>` and
 *  routing only the type-matching events to it via the Map bucket key — so the
 *  runtime cast inside the closure is safe by construction (the Map enforces
 *  that a handler is only ever invoked with events of its registered type).
 *  R-Phase4 P3-2: replaces the prior `as unknown as HookHandler<HookEventType>`
 *  cast at registration time with a structural closure. */
type AnyHookHandler = (event: HookEvent) => unknown

<<<<<<< Updated upstream
/** Registration options for {@link HookBus.on}. `matcher` is consulted ONLY
 *  for tool-shaped events (`pre_tool_use` / `post_tool_use`) — other variants
 *  carry no `name` field and the matcher is ignored. Omitting `options` is
 *  byte-identical to the prior 2-arg signature. Tier-0 absorption #0-1 (AWF
 *  2-matcher). */
=======
/** Registration options for {@link HookBus.on}. The matcher applies ONLY to
 *  tool-shaped events (`pre_tool_use`, `post_tool_use`) — other variants have
 *  no `name` field, so for them the matcher is ignored and the handler runs.
 *  Tier-0 absorption #0-1 (AWF 2-matcher): a host can wire one handler for the
 *  FS-tools channel and another for the agent-tools channel, without per-call
 *  pattern checks in user code. */
>>>>>>> Stashed changes
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
<<<<<<< Updated upstream
   *  (`pre_tool_use`, `post_tool_use`); non-tool events ignore it. */
=======
   *  (`pre_tool_use`, `post_tool_use`); non-tool events ignore it. Omitting
   *  `options` is byte-identical to the prior 2-arg signature. */
>>>>>>> Stashed changes
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
   * `{ deny }` produced by a `pre_tool_use` handler, else `null`. A throwing
   * handler is caught + logged and does not abort the emit. Handlers whose
   * registered matcher rejects the tool name are skipped silently (only
   * `pre_tool_use` / `post_tool_use` events carry a name).
   */
  async emit(event: HookEvent): Promise<HookDeny | null> {
    const list = this.handlers.get(event.type)
    if (list === undefined) return null
    const toolEvent = isToolEvent(event)
    let denied: HookDeny | null = null
    for (const stored of list) {
      if (toolEvent && !matchTool(stored.matcher, event.name)) continue
      try {
        const result = await stored.fn(event)
        if (denied === null && event.type === "pre_tool_use" && isDeny(result)) {
          denied = result
        }
      } catch (e) {
        this.logger?.error("hook.handler.error", {
          event: event.type,
          error: (e as Error).message,
        })
      }
    }
    return denied
  }
}
