import { matchTool } from "./tool-matchers";
const isDeny = (v) => typeof v === "object" && v !== null && typeof v.deny === "string";
const isUpdatedInput = (v) => typeof v === "object" && v !== null && "updatedInput" in v;
const isToolEvent = (event) => event.type === "pre_tool_use" || event.type === "post_tool_use";
export class HookBus {
    handlers = new Map();
    logger;
    constructor(logger) {
        this.logger = logger;
    }
    /** Register `handler` for `type`. Handlers fire in registration order.
     *  Optional `options.matcher` gates dispatch on tool-shaped events
     *  (`pre_tool_use`, `post_tool_use`); non-tool events ignore it. */
    on(type, handler, options) {
        const list = this.handlers.get(type) ?? [];
        // Closure-erase to the union: the Map key (`type`) GUARANTEES this stored
        // closure is only invoked with events whose `.type === type`, so the
        // narrowing assertion is safe at runtime (the alternative — `as unknown as
        // HookHandler<HookEventType>` at the call-site of `on()` — was the lint
        // warning hooks.ts:63 carried prior to R-Phase4 P3-2).
        const fn = (event) => handler(event);
        list.push({ fn, matcher: options?.matcher });
        this.handlers.set(type, list);
        return this;
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
    async emit(event) {
        const list = this.handlers.get(event.type);
        if (list === undefined)
            return { deny: null };
        // pre_tool_use is the only variant that can deny or rewrite input — it owns
        // the composition loop. Every other event just fires its (matched) handlers.
        if (event.type === "pre_tool_use")
            return this.emitPreToolUse(event, list);
        const toolEvent = isToolEvent(event);
        for (const stored of list) {
            if (toolEvent && !matchTool(stored.matcher, event.name))
                continue;
            await this.runHandler(stored, event);
        }
        return { deny: null };
    }
    /** Composition loop for `pre_tool_use`: threads the (possibly rewritten) input
     *  through matched handlers, recording the first deny and the last rewrite. */
    async emitPreToolUse(event, list) {
        let denied = null;
        let currentInput = event.input;
        let mutated = false;
        for (const stored of list) {
            if (!matchTool(stored.matcher, event.name))
                continue;
            // Re-materialize with the latest input so a prior handler's rewrite is
            // visible to this one (rewrites compose in registration order).
            const result = await this.runHandler(stored, {
                type: "pre_tool_use",
                name: event.name,
                input: currentInput,
            });
            // Normalize to a pure HookDeny — a handler may return a combined
            // `{ deny, updatedInput }`, but the deny channel carries only the reason
            // string (the rewrite rides the separate updatedInput channel).
            if (denied === null && isDeny(result))
                denied = { deny: result.deny };
            if (isUpdatedInput(result)) {
                currentInput = result.updatedInput;
                mutated = true;
            }
        }
        return { deny: denied, ...(mutated ? { updatedInput: currentInput } : {}) };
    }
    /** Run one stored handler, isolating + logging a throw (returns `undefined`
     *  on throw so the caller treats it as a no-op result). */
    async runHandler(stored, event) {
        try {
            return await stored.fn(event);
        }
        catch (e) {
            this.logger?.error("hook.handler.error", {
                event: event.type,
                error: e.message,
            });
            return undefined;
        }
    }
}
