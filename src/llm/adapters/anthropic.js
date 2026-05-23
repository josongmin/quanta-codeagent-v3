import Anthropic from "@anthropic-ai/sdk";
import { LLMError } from "@/shared/errors";
import { withStreamTimeout } from "../stream-timeout";
import { buildUsageEvent, parseToolInputOrThrow, resolveAdapterStreamTimeouts } from "./shared";
const toAnthropicContent = (block) => {
    switch (block.type) {
        case "text":
            return { type: "text", text: block.text };
        case "tool_use":
            return { type: "tool_use", id: block.id, name: block.name, input: block.input };
        case "tool_result":
            return {
                type: "tool_result",
                tool_use_id: block.tool_use_id,
                content: block.content,
                ...(block.is_error ? { is_error: true } : {}),
            };
        case "thinking": {
            // ADR-0076 Gap-2 carry-over: re-send the thinking block so the provider
            // keeps multi-turn extended-thinking context. The Messages API REQUIRES
            // the original cryptographic signature back verbatim on plaintext
            // thinking — without it the request 400s. A redacted block carries its
            // opaque ciphertext in `thinking` and re-serializes as redacted_thinking.
            //
            // Byte-identical guard: when extended-thinking was never enabled, no
            // ThinkingBlock is ever assembled (assemble.ts only builds one from a
            // thinking_delta, which adapters emit only under an active budget). A
            // signature-less plaintext block can therefore only be a stale artifact
            // (e.g. a hand-built message); we DROP it rather than fail the request,
            // exactly as the pre-feature path did.
            //
            // `satisfies` (not `as`) on both arms — the SDK's `ContentBlockParam`
            // union exports `RedactedThinkingBlockParam` / `ThinkingBlockParam`
            // structurally; `satisfies` catches a future required-field widening
            // at compile time whereas `as` would silently mask it.
            if (block.redacted) {
                return {
                    type: "redacted_thinking",
                    data: block.thinking,
                };
            }
            if (block.signature === undefined)
                return null;
            return {
                type: "thinking",
                thinking: block.thinking,
                signature: block.signature,
            };
        }
        case "image":
            // ADR-0083 multi-modal: Anthropic Messages API base64 image source. The
            // media type is narrowed to the SDK's accepted literal set; the CLI
            // image-loader only ever emits one of these four, so the cast is safe.
            return {
                type: "image",
                source: {
                    type: "base64",
                    media_type: block.mediaType,
                    data: block.data,
                },
            };
        default: {
            // Exhaustiveness pin: a future `ContentBlock` variant must come back
            // here and decide its Anthropic mapping consciously — silent drop is
            // not acceptable for a content-bearing block. The `never` cast fails
            // compilation if the union widens; runtime fall-through is impossible.
            const _exhaustive = block;
            return _exhaustive;
        }
    }
};
/** Map our system input to Anthropic's `system` param. A plain string passes
 *  through verbatim (legacy behavior). Block form becomes structured text
 *  params; the block flagged `cache:true` gets an ephemeral `cache_control`
 *  breakpoint so the static prefix is cached across turns. */
const toAnthropicSystem = (system) => {
    if (typeof system === "string")
        return system;
    return system.map((b) => ({
        type: "text",
        text: b.text,
        ...(b.cache ? { cache_control: { type: "ephemeral" } } : {}),
    }));
};
/** Mark the LAST TEXT block of the last message with an ephemeral
 *  `cache_control` breakpoint, caching the whole conversation prefix (static
 *  system + prior turns) up to the per-turn tail. Mutates a shallow copy.
 *
 *  R-Phase5 P0-B: the Anthropic API only honors `cache_control` on `text`
 *  blocks (server-side it is silently dropped on `tool_use` / `tool_result` /
 *  `thinking` blocks, AND some SDK / server versions reject the request
 *  outright). The prior implementation blindly stamped the TAIL block — when
 *  the last message ended with a tool_use (assistant just issued a call) or
 *  tool_result (user just returned a result), the breakpoint silently
 *  evaporated and the cache never landed on the conversation prefix.
 *
 *  Walk BACKWARD from the tail to find the last `text` block; attach the
 *  breakpoint there. If no text block exists in the last message (a turn
 *  that's purely tool_use / tool_result with no narration), return unchanged
 *  — the cache prefix on the SYSTEM blocks still applies, and the
 *  conversation-prefix breakpoint just doesn't bind this turn. Pure shallow
 *  copy, no mutation of input. */
const cacheConversationPrefix = (messages) => {
    if (messages.length === 0)
        return messages;
    const lastIdx = messages.length - 1;
    const last = messages[lastIdx];
    if (typeof last.content === "string" || last.content.length === 0)
        return messages;
    const blocks = [...last.content];
    let textIdx = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].type === "text") {
            textIdx = i;
            break;
        }
    }
    if (textIdx === -1)
        return messages;
    blocks[textIdx] = {
        ...blocks[textIdx],
        cache_control: { type: "ephemeral" },
    };
    const out = [...messages];
    out[lastIdx] = { ...last, content: blocks };
    return out;
};
const toAnthropicMessages = (messages) => messages.map((m) => ({
    role: m.role,
    content: m.content
        .map(toAnthropicContent)
        .filter((b) => b !== null),
}));
/**
 * ADR-0079 — map our orthogonal {@link ToolChoice} to Anthropic's `tool_choice`
 * shape. Closed switch with a `never` default so adding a new variant is a
 * compile error here AND in the OpenAI adapter. The `auto` case returns
 * `undefined` so callers OMIT the field on the wire — byte-identical to the
 * pre-feature path. A `tool` choice whose `name` is not present in the request
 * `tools` is a caller bug; we throw at the adapter so the request never reaches
 * the provider with an unresolvable name (no silent fallback).
 */
export const toAnthropicToolChoice = (choice, toolNames) => {
    if (choice === undefined)
        return undefined;
    switch (choice.kind) {
        case "auto":
            // Byte-identical to pre-feature: OMIT the field. The SDK default is
            // auto, so emitting `{type:"auto"}` would be semantically identical
            // but a different wire payload — we choose the omit form so the
            // default-OFF promise holds at the byte level.
            return undefined;
        case "any":
            return { type: "any" };
        case "none":
            return { type: "none" };
        case "tool":
            if (!toolNames.includes(choice.name)) {
                throw new LLMError(`tool_choice references unregistered tool name "${choice.name}" ` +
                    `(registered: ${toolNames.length === 0 ? "<none>" : toolNames.join(", ")})`);
            }
            return { type: "tool", name: choice.name };
        default: {
            // Exhaustiveness check — adding a new ToolChoice variant without
            // updating this switch is a compile error.
            const _exhaustive = choice;
            return _exhaustive;
        }
    }
};
export class AnthropicAdapter {
    client;
    model;
    provider = "anthropic";
    authMode = "Anthropic BYOK";
    maxTokens;
    betaHeaders;
    /** T1 stream-hang guard: pinned at construction (env knobs + optional
     *  caller overrides resolved ONCE) and applied to every `stream()` call
     *  via the shared `withStreamTimeout` decorator. */
    streamTimeoutMs;
    constructor(config) {
        this.betaHeaders = config.betaHeaders ?? [];
        this.streamTimeoutMs = resolveAdapterStreamTimeouts(config);
        // T1 gap-closer: the per-request SDK `timeout` covers the `create()` call
        // itself (HTTP connect + time-to-first-byte) — the hang point the stream
        // wrapper CANNOT see because it decorates the AsyncIterable returned AFTER
        // create() resolves. We bound it to the first-chunk budget and let the SDK
        // retry once rather than burn the whole instance deadline on a TTFT stall.
        const beta = this.betaHeaders.join(",");
        const base = {
            apiKey: config.apiKey,
            timeout: this.streamTimeoutMs.firstChunkMs,
            maxRetries: 2,
        };
        this.client =
            beta.length > 0
                ? new Anthropic({ ...base, defaultHeaders: { "anthropic-beta": beta } })
                : new Anthropic(base);
        this.model = config.model;
        this.maxTokens = config.maxTokens ?? 8192;
    }
    async openRawStream(input) {
        // ADR-0079 — resolve tool_choice BEFORE the create() call so an
        // unregistered-tool-name throw surfaces from the same try/catch as any
        // other request-construction failure. `undefined` ⇒ field omitted on the
        // wire, byte-identical to the pre-feature path.
        const toolNames = input.tools.map((t) => t.name);
        const toolChoice = toAnthropicToolChoice(input.toolChoice, toolNames);
        try {
            return (await this.client.messages.create({
                model: this.model,
                max_tokens: this.maxTokens,
                stream: true,
                ...(input.system ? { system: toAnthropicSystem(input.system) } : {}),
                ...(input.thinking ? { thinking: input.thinking } : {}),
                messages: cacheConversationPrefix(toAnthropicMessages(input.messages)),
                tools: input.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    input_schema: t.input_schema,
                })),
                ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
            }, 
            // Caller cancellation: the SDK request-options `signal` aborts the
            // underlying fetch — covers the create()/TTFT phase that the stream
            // wrapper cannot see (it only decorates the AsyncIterable returned
            // AFTER create() resolves). Composes with the per-request `timeout`
            // set at construction: whichever fires first cancels the request.
            // Absent ⇒ `undefined` options, byte-identical to the pre-feature path.
            input.signal ? { signal: input.signal } : undefined));
        }
        catch (e) {
            throw LLMError.fromSdkError("anthropic", e);
        }
    }
    async *stream(input) {
        // index -> block kind, so we know whether content_block_stop closes a tool.
        const open = new Map();
        const usage = { model: this.model };
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
            provider: "anthropic",
            // Compose the caller's signal into the wrapper: when it fires, the
            // wrapper aborts its OWN internal controller and tears down the timeout
            // race cleanly. This handles the post-create() streaming phase (the SDK
            // signal above handles the create()/TTFT phase). Absent ⇒ wrapper still
            // self-aborts on its own timeouts (byte-identical).
            ...(input.signal ? { signal: input.signal } : {}),
        });
        try {
            for await (const ev of guarded) {
                yield* mapRawEvent(ev, open, usage);
            }
        }
        catch (e) {
            throw LLMError.fromSdkError("anthropic", e, "Anthropic stream error");
        }
    }
}
/** Fold the prompt-side counts and resolved model from `message_start` into
 *  the accumulator (pure mutation, emits nothing). */
const absorbMessageStart = (m, usage) => {
    if (m?.model)
        usage.model = m.model;
    if (!m?.usage)
        return;
    usage.inputTokens = m.usage.input_tokens;
    if (m.usage.cache_read_input_tokens !== undefined) {
        usage.cacheReadTokens = m.usage.cache_read_input_tokens;
    }
};
/** Terminal `message_delta`: fold the completion count, then emit the usage
 *  event (if any tokens were seen) immediately before `message_stop`. */
function* finishOnMessageDelta(ev, usage) {
    if (ev.usage)
        usage.outputTokens = ev.usage.output_tokens;
    if (!ev.delta.stop_reason)
        return;
    const usageEvent = buildUsageEvent(usage);
    if (usageEvent)
        yield usageEvent;
    yield { type: "message_stop", stop_reason: ev.delta.stop_reason };
}
/** Translate one Anthropic `content_block_delta`'s inner `RawDelta` payload
 *  into our `StreamEvent` shape. Exhaustiveness is enforced by `default: never`
 *  so a future widening of `RawDelta` (e.g. a new `citations_delta` arm) MUST
 *  come back here and decide its mapping consciously — no silent drop. */
function* yieldFromContentBlockDelta(d, open, index) {
    switch (d.type) {
        case "text_delta":
            yield { type: "text_delta", delta: d.text };
            return;
        case "input_json_delta": {
            const slot = open.get(index);
            if (slot) {
                slot.json += d.partial_json;
                yield { type: "tool_use_delta", id: slot.id, delta: d.partial_json };
            }
            return;
        }
        case "thinking_delta":
            // ADR-0076 Gap-2: surface extended-thinking content. Emitted only when
            // a thinking budget is active — with no budget the provider streams no
            // thinking blocks, so this branch never fires (byte-identical).
            yield { type: "thinking_delta", text: d.thinking };
            return;
        case "signature_delta":
            // The cryptographic signature for the in-flight thinking block.
            // Required back verbatim on the next turn's input for carry-over.
            yield { type: "signature_delta", signature: d.signature };
            return;
        default: {
            // Exhaustiveness pin. SDK union widening fails compilation here; the
            // runtime cannot fall through to a silent drop.
            const _exhaustive = d;
            void _exhaustive;
            return;
        }
    }
}
export function* mapRawEvent(ev, open, usage = {}) {
    switch (ev.type) {
        case "message_start":
            absorbMessageStart(ev.message, usage);
            break;
        case "content_block_start": {
            const b = ev.content_block;
            if (b.type === "tool_use") {
                open.set(ev.index, { kind: "tool_use", id: b.id, json: "" });
                yield { type: "tool_use_start", id: b.id, name: b.name };
            }
            else if (b.type === "redacted_thinking") {
                // ADR-0076 Gap-2: the encrypted reasoning ships whole on the start
                // event — no deltas follow. Emit one redacted thinking_delta carrying
                // the opaque ciphertext so assembly preserves it for carry-over.
                open.set(ev.index, { kind: "thinking", id: "", json: "" });
                yield { type: "thinking_delta", text: b.data, redacted: true };
            }
            else {
                open.set(ev.index, { kind: b.type, id: "", json: "" });
            }
            break;
        }
        case "content_block_delta": {
            yield* yieldFromContentBlockDelta(ev.delta, open, ev.index);
            break;
        }
        case "content_block_stop": {
            const slot = open.get(ev.index);
            if (slot?.kind === "tool_use") {
                yield { type: "tool_use_end", id: slot.id, input: finalizeToolInput(slot.json, slot.id) };
            }
            open.delete(ev.index);
            break;
        }
        case "message_delta":
            yield* finishOnMessageDelta(ev, usage);
            break;
        case "message_stop":
        case "ping":
            // Intentionally emit nothing. The terminal `message_stop` StreamEvent is
            // synthesized from `message_delta`'s `stop_reason` (carries the reason,
            // which the raw `message_stop` does not); `ping` is a keep-alive. Listed
            // explicitly so the `default: never` below pins exhaustiveness — a future
            // RawEvent variant must come back here and decide its mapping.
            break;
        default: {
            // Exhaustiveness pin: a new RawEvent arm fails compilation here rather
            // than being silently dropped.
            const _exhaustive = ev;
            void _exhaustive;
            break;
        }
    }
}
export const finalizeToolInput = (json, id) => parseToolInputOrThrow(json, id, "anthropic", "no-cause");
