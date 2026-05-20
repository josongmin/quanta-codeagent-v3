import type { StructuredLogger } from "@/observability"

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

export class HookBus {
  private readonly handlers = new Map<HookEventType, AnyHookHandler[]>()
  private readonly logger: StructuredLogger | undefined

  constructor(logger?: StructuredLogger) {
    this.logger = logger
  }

  /** Register `handler` for `type`. Handlers fire in registration order. */
  on<T extends HookEventType>(type: T, handler: HookHandler<T>): this {
    const list = this.handlers.get(type) ?? []
    // Closure-erase to the union: the Map key (`type`) GUARANTEES this stored
    // closure is only invoked with events whose `.type === type`, so the
    // narrowing assertion is safe at runtime (the alternative — `as unknown as
    // HookHandler<HookEventType>` at the call-site of `on()` — was the lint
    // warning hooks.ts:63 carried prior to R-Phase4 P3-2).
    list.push((event: HookEvent) => handler(event as HookEventOf<T>))
    this.handlers.set(type, list)
    return this
  }

  /**
   * Emit `event` to every registered handler sequentially. Returns the first
   * `{ deny }` produced by a `pre_tool_use` handler, else `null`. A throwing
   * handler is caught + logged and does not abort the emit.
   */
  async emit(event: HookEvent): Promise<HookDeny | null> {
    const list = this.handlers.get(event.type)
    if (list === undefined) return null
    let denied: HookDeny | null = null
    for (const handler of list) {
      try {
        const result = await handler(event)
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
