import { LLMError } from "@/shared/errors";
import { runtimeConfig } from "@/shared/runtime-config";
import { resolveStreamTimeoutMs } from "../stream-timeout";
/** Resolve the per-adapter stream-hang deadlines ONCE at construction.
 *  Caller-supplied overrides win over env knobs
 *  (`QUANTA_LLM_STREAM_FIRST_CHUNK_MS` / `QUANTA_LLM_STREAM_IDLE_MS`); env wins
 *  over the defaults baked into `src/llm/stream-timeout.ts`. Reads
 *  `runtimeConfig()` exactly once — no per-call re-read. Behavior is
 *  byte-identical to the inline logic each adapter used to carry. */
export const resolveAdapterStreamTimeouts = (config) => {
    const env = runtimeConfig();
    const override = {};
    if (config.streamFirstChunkMs !== undefined)
        override.firstChunkMs = config.streamFirstChunkMs;
    if (config.streamIdleMs !== undefined)
        override.idleMs = config.streamIdleMs;
    return resolveStreamTimeoutMs(env.llmStreamFirstChunkMs, env.llmStreamIdleMs, override);
};
/** Parse accumulated tool-call argument JSON, or throw the structured
 *  `stream_corrupt` LLMError both adapters raised verbatim. Empty / whitespace
 *  ⇒ `{}` (a tool with no arguments). `causePolicy` selects whether the parse
 *  error is threaded as `cause` (OpenAI) or omitted (Anthropic), preserving
 *  each adapter's exact prior throw. */
export const parseToolInputOrThrow = (json, id, provider, causePolicy = "no-cause") => {
    if (!json.trim())
        return {};
    try {
        return JSON.parse(json);
    }
    catch (e) {
        throw new LLMError(`Malformed tool input JSON for ${id}`, {
            kind: "stream_corrupt",
            provider,
            ...(causePolicy === "with-cause" ? { cause: e } : {}),
        });
    }
};
/** Build the additive `usage` StreamEvent from accumulated counts. Returns
 *  `null` when neither side reported tokens (absent usage is valid — never emit
 *  zeros). `cacheReadTokens` is included only when a cache hit was reported
 *  (exactOptionalPropertyTypes: conditional spread, not undefined). Shared by
 *  both adapters; the per-provider raw→counts fold stays provider-side. */
export const buildUsageEvent = (counts) => {
    if (counts.inputTokens === undefined && counts.outputTokens === undefined)
        return null;
    return {
        type: "usage",
        inputTokens: counts.inputTokens ?? 0,
        outputTokens: counts.outputTokens ?? 0,
        model: counts.model ?? "",
        ...(counts.cacheReadTokens !== undefined ? { cacheReadTokens: counts.cacheReadTokens } : {}),
    };
};
