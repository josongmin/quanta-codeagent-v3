import OpenAI from "openai";
import { LLMError } from "@/shared";
import { withStreamTimeout } from "../stream-timeout";
import { buildUsageEvent as buildUsageEventShared, parseToolInputOrThrow, resolveAdapterStreamTimeouts, } from "./shared";
export const STOP_REASON = {
    tool_calls: "tool_use",
    stop: "end_turn",
    length: "max_tokens",
};
/** Model-family detector: TRUE for OpenAI families that reject `max_tokens`
 *  and require `max_completion_tokens` (reasoning models + GPT-5 line).
 *  Pinned by prefix — adding a new family means one line here, not a regex
 *  on the error message AFTER a 400. Exported for the unit test that pins
 *  the contract per model id. */
export const usesCompletionTokensParam = (model) => {
    const m = model.toLowerCase();
    // o1/o3 reasoning families + gpt-5 generation all use max_completion_tokens.
    // The trailing `-` / `.` cases bound the prefix so `gpt-5o-future` style
    // model names are caught while `gpt-4o` (legacy) is not.
    return m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4") || m.startsWith("gpt-5");
};
export const assistantParam = (blocks) => {
    const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
    const toolCalls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => b.type === "tool_use"
        ? {
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }
        : null)
        .filter((c) => c !== null);
    return {
        role: "assistant",
        content: text === "" ? null : text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
};
export const userParams = (blocks) => {
    const params = [];
    const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
    const images = blocks.filter((b) => b.type === "image");
    if (images.length > 0) {
        // ADR-0083 multi-modal: emit OpenAI's content-ARRAY form so text + images
        // ride on a single user message. A data-URL carries the base64 inline.
        const parts = [];
        if (text !== "")
            parts.push({ type: "text", text });
        for (const img of images) {
            parts.push({
                type: "image_url",
                image_url: { url: `data:${img.mediaType};base64,${img.data}` },
            });
        }
        params.push({ role: "user", content: parts });
    }
    else if (text !== "") {
        // No images ⇒ legacy plain-string content (byte-identical).
        params.push({ role: "user", content: text });
    }
    for (const b of blocks) {
        if (b.type === "tool_result") {
            params.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content });
        }
    }
    return params;
};
/** Flatten the system input to a single string. OpenAI does automatic prefix
 *  caching with no `cache_control` knob, so the only requirement is that the
 *  rendered prefix be byte-stable across turns: preserve block order and join
 *  deterministically. The `cache` flag is irrelevant here and ignored. */
const flattenSystem = (system) => typeof system === "string" ? system : system.map((b) => b.text).join("\n\n");
/**
 * ADR-0079 — map our orthogonal {@link ToolChoice} to OpenAI's `tool_choice`
 * shape. Closed switch with a `never` default so adding a new variant is a
 * compile error here AND in the Anthropic adapter. The `auto` case returns
 * `undefined` so callers OMIT the field — byte-identical to the pre-feature
 * path (OpenAI's default is auto). A `tool` choice whose `name` is not
 * present in the request `tools` is a caller bug; we throw at the adapter so
 * the request never reaches the provider with an unresolvable name (no
 * silent fallback).
 */
export const toOpenAIToolChoice = (choice, toolNames) => {
    if (choice === undefined)
        return undefined;
    switch (choice.kind) {
        case "auto":
            // Byte-identical to pre-feature: OMIT the field. OpenAI's default is
            // "auto" so emitting the literal string would be semantically the
            // same but a different wire payload — we choose omit so default-OFF
            // holds at the byte level.
            return undefined;
        case "any":
            return "required";
        case "none":
            return "none";
        case "tool":
            if (!toolNames.includes(choice.name)) {
                throw new LLMError(`tool_choice references unregistered tool name "${choice.name}" ` +
                    `(registered: ${toolNames.length === 0 ? "<none>" : toolNames.join(", ")})`);
            }
            return { type: "function", function: { name: choice.name } };
        default: {
            const _exhaustive = choice;
            return _exhaustive;
        }
    }
};
export const toChatMessages = (system, messages) => {
    const out = [];
    if (system !== undefined) {
        const content = flattenSystem(system);
        if (content !== "")
            out.push({ role: "system", content });
    }
    for (const m of messages) {
        if (m.role === "assistant")
            out.push(assistantParam(m.content));
        else
            out.push(...userParams(m.content));
    }
    return out;
};
function* mapOneToolCall(c, pending) {
    let slot = pending.get(c.index);
    if (!slot) {
        slot = { id: c.id ?? "", name: c.function?.name ?? "", args: "", started: false };
        pending.set(c.index, slot);
    }
    if (c.id)
        slot.id = c.id;
    if (c.function?.name)
        slot.name = c.function.name;
    if (!slot.started && slot.id && slot.name) {
        slot.started = true;
        yield { type: "tool_use_start", id: slot.id, name: slot.name };
    }
    const frag = c.function?.arguments;
    if (frag) {
        slot.args += frag;
        if (slot.started)
            yield { type: "tool_use_delta", id: slot.id, delta: frag };
    }
}
export function* mapToolCallDeltas(chunk, pending) {
    const calls = chunk.choices[0]?.delta.tool_calls;
    if (!calls)
        return;
    for (const c of calls)
        yield* mapOneToolCall(c, pending);
}
export function* finalizeCalls(pending) {
    for (const slot of [...pending.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])) {
        const input = parseToolInputOrThrow(slot.args, slot.id, "openai", "with-cause");
        yield { type: "tool_use_end", id: slot.id, input };
    }
}
/** Map an OpenAI usage payload to the additive usage StreamEvent. Returns
 *  `null` when the stream carried no usage (older models) so we never emit
 *  zeros. `cacheReadTokens` is included only on a reported cache hit
 *  (exactOptionalPropertyTypes: conditional spread, not undefined). */
export const buildUsageEvent = (usage, model) => {
    if (!usage)
        return null;
    const cached = usage.prompt_tokens_details?.cached_tokens;
    return buildUsageEventShared({
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        model,
        ...(cached !== undefined ? { cacheReadTokens: cached } : {}),
    });
};
/** Map one streamed chunk to events, threading finish/usage/model into the
 *  shared state. The trailing usage chunk has empty `choices`, so usage/model
 *  are captured before the early return. */
function* processChunk(chunk, st) {
    if (chunk.usage)
        st.rawUsage = chunk.usage;
    if (chunk.model)
        st.usageModel = chunk.model;
    const choice = chunk.choices[0];
    if (!choice)
        return;
    // ADR-0076 Gap-2: reasoning summary delta → thinking_delta. The OpenAI Chat
    // Completions surface and compatible providers diverge between `reasoning`
    // and `reasoning_content`; read both, preferring `reasoning` when both
    // populated on the same chunk (provider bug guard — concatenating would
    // double-count). No signature: OpenAI reasoning is opaque.
    const r = choice.delta.reasoning ?? choice.delta.reasoning_content;
    if (r)
        yield { type: "thinking_delta", text: r };
    if (choice.delta.content)
        yield { type: "text_delta", delta: choice.delta.content };
    yield* mapToolCallDeltas(chunk, st.pending);
    if (choice.finish_reason)
        st.finish = choice.finish_reason;
}
export class OpenAIAdapter {
    client;
    model;
    provider = "openai";
    authMode = "OpenAI BYOK";
    maxTokens;
    /** T1 stream-hang guard: pinned at construction (env knobs + optional
     *  caller overrides resolved ONCE) and applied to every `stream()` call
     *  via the shared `withStreamTimeout` decorator. */
    streamTimeoutMs;
    constructor(config) {
        this.streamTimeoutMs = resolveAdapterStreamTimeouts(config);
        // T1 gap-closer: the per-request SDK `timeout` covers the `create()` call
        // itself (HTTP connect + time-to-first-byte) — the hang point the stream
        // wrapper CANNOT see because it decorates the AsyncIterable returned AFTER
        // create() resolves. A huge-prompt instance (swebench django-11179) hangs
        // here for the SDK's 10-min default, burning the whole bench deadline. We
        // bound it to the first-chunk budget and let the SDK retry once.
        this.client = new OpenAI({
            apiKey: config.apiKey,
            timeout: this.streamTimeoutMs.firstChunkMs,
            maxRetries: 2,
            ...(config.baseURL ? { baseURL: config.baseURL } : {}),
        });
        this.model = config.model;
        this.maxTokens = config.maxTokens ?? 8192;
    }
    async openRawStream(input) {
        // Token-cap param naming diverges between OpenAI families:
        //  - Legacy chat models (`gpt-4o`, `gpt-4`, `gpt-3.5-*`, `gpt-4-turbo`,
        //    `chatgpt-4o-latest`, …) accept `max_tokens`.
        //  - Reasoning + GPT-5 generations (`o1*`, `o3*`, `gpt-5*`) REJECT
        //    `max_tokens` with a 400 and require `max_completion_tokens`.
        // Pick at request time off the configured model id; structured detection
        // (not a heuristic on the error message AFTER we get rejected). Adding a
        // new reasoning family ⇒ extend `usesCompletionTokensParam`.
        const tokenCap = usesCompletionTokensParam(this.model)
            ? { max_completion_tokens: this.maxTokens }
            : { max_tokens: this.maxTokens };
        // ADR-0079 — resolve tool_choice BEFORE create() so an unregistered-name
        // throw surfaces from the same path as any other request-construction
        // failure. `undefined` ⇒ field omitted on the wire (byte-identical).
        const toolNames = input.tools.map((t) => t.name);
        const toolChoice = toOpenAIToolChoice(input.toolChoice, toolNames);
        try {
            return (await this.client.chat.completions.create({
                model: this.model,
                ...tokenCap,
                stream: true,
                // Opt into the trailing usage chunk (RFC-0002 §5.3). Older models that
                // don't support it simply omit the chunk — we then emit no usage.
                stream_options: { include_usage: true },
                messages: toChatMessages(input.system, input.messages),
                tools: input.tools.map((t) => ({
                    type: "function",
                    function: { name: t.name, description: t.description, parameters: t.input_schema },
                })),
                ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
            }, 
            // Caller cancellation: the SDK request-options `signal` aborts the
            // underlying fetch — covers the create()/TTFT phase that the stream
            // wrapper cannot see. Composes with the per-request `timeout` set at
            // construction (whichever fires first cancels). Absent ⇒ `undefined`
            // options, byte-identical to the pre-feature path.
            input.signal ? { signal: input.signal } : undefined));
        }
        catch (e) {
            throw LLMError.fromSdkError("openai", e);
        }
    }
    async *stream(input) {
        const raw = await this.openRawStream(input);
        // T1: wrap the raw SDK stream with first-chunk + idle deadlines. A
        // silently-hung stream now throws a structured `stream_corrupt` LLMError
        // (message includes "timeout") that the agent loop's `classifyLLMError`
        // routes through the existing same-turn retry path (RETRYABLE_MARKERS
        // hit). On timeout the wrapper also cancels the upstream fetch via its
        // own AbortController so no orphan request is left holding the socket.
        const guarded = withStreamTimeout(raw, {
            firstChunkMs: this.streamTimeoutMs.firstChunkMs,
            idleMs: this.streamTimeoutMs.idleMs,
            provider: "openai",
            // Compose the caller's signal into the wrapper: when it fires, the
            // wrapper aborts its OWN internal controller and tears down the timeout
            // race cleanly. Handles the post-create() streaming phase (the SDK
            // signal above handles create()/TTFT). Absent ⇒ wrapper still self-aborts
            // on its own timeouts (byte-identical).
            ...(input.signal ? { signal: input.signal } : {}),
        });
        const st = {
            pending: new Map(),
            finish: null,
            rawUsage: undefined,
            usageModel: this.model,
        };
        try {
            for await (const chunk of guarded)
                yield* processChunk(chunk, st);
        }
        catch (e) {
            throw LLMError.fromSdkError("openai", e, "OpenAI stream error");
        }
        yield* finalizeCalls(st.pending);
        const usageEvent = buildUsageEvent(st.rawUsage, st.usageModel);
        if (usageEvent)
            yield usageEvent;
        yield {
            type: "message_stop",
            stop_reason: st.finish ? (STOP_REASON[st.finish] ?? st.finish) : "end_turn",
        };
    }
}
