import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AnthropicAdapter } from "./adapters/anthropic";
import { ChatGPTOAuthAdapter } from "./adapters/chatgpt-oauth";
import { OpenAIAdapter } from "./adapters/openai";
/** Default model id per provider — the single source of truth the three app
 *  entry points (`cli`, `bench`, `eval`) previously each duplicated. */
export const DEFAULT_MODEL = {
    anthropic: "claude-sonnet-4-6",
    openai: "gpt-5-mini",
    // ChatGPT-OAuth subscription path. The Codex-only `gpt-5-codex` slug is
    // rejected by chatgpt.com backend ("not supported when using Codex with
    // a ChatGPT account"), so we default to the flagship `gpt-5` instead —
    // available on Plus/Pro/Team/Business/Enterprise tiers. Override with
    // `QUANTA_MODEL=<slug>` (e.g. `gpt-5-pro` on Pro, `o1`, `gpt-4o`).
    "chatgpt-oauth": "gpt-5",
};
/** Per-provider env var holding the API key. The `chatgpt-oauth` entry is a
 *  sentinel — that provider's credential lives on disk (token store), not in
 *  an env var; `createLLM` short-circuits the env lookup for it. */
const API_KEY_ENV = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    "chatgpt-oauth": "__CHATGPT_OAUTH_ON_DISK__",
};
/** Thrown by {@link createLLM} when the resolved provider has no API key and
 *  the caller did not opt into {@link tryCreateLLM}. Typed so the wiring phase
 *  can branch on it instead of string-matching a message. */
export class MissingApiKeyError extends Error {
    provider;
    envVar;
    constructor(provider) {
        const envVar = API_KEY_ENV[provider];
        super(`${envVar} is not set`);
        this.name = "MissingApiKeyError";
        this.provider = provider;
        this.envVar = envVar;
    }
}
/** Registry: provider → adapter constructor. Adding a provider = one entry
 *  here (plus the `DEFAULT_MODEL` / `API_KEY_ENV` entries), NOT an if-chain
 *  edit. Each builder receives the resolved key/model, the raw options, and
 *  the canonical env source — env is passed through (not read from
 *  `process.env`) so the SSOT invariant from the file header holds: this
 *  factory never touches the global env itself. The chatgpt-oauth adapter
 *  uses env to locate the on-disk token bundle. */
const ADAPTER_REGISTRY = {
    openai: (apiKey, model, opts, _env) => new OpenAIAdapter({
        apiKey,
        model,
        ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
        ...(opts.streamFirstChunkMs !== undefined
            ? { streamFirstChunkMs: opts.streamFirstChunkMs }
            : {}),
        ...(opts.streamIdleMs !== undefined ? { streamIdleMs: opts.streamIdleMs } : {}),
    }),
    anthropic: (apiKey, model, opts, _env) => new AnthropicAdapter({
        apiKey,
        model,
        ...(opts.betaHeaders !== undefined ? { betaHeaders: opts.betaHeaders } : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
        ...(opts.streamFirstChunkMs !== undefined
            ? { streamFirstChunkMs: opts.streamFirstChunkMs }
            : {}),
        ...(opts.streamIdleMs !== undefined ? { streamIdleMs: opts.streamIdleMs } : {}),
    }),
    // ChatGPT-OAuth provider (ADR-0094 Phase 2). The api-key argument is unused
    // — the credential is the on-disk token bundle written by `/login`. `env`
    // is forwarded so the adapter resolves OAuth config (issuer/sku/originator)
    // and locates `~/.quanta/auth/chatgpt.json` without reading process.env
    // directly.
    "chatgpt-oauth": (_apiKey, model, _opts, env) => new ChatGPTOAuthAdapter({ model, env }),
};
/** Cheap sync probe — does a ChatGPT-OAuth token file exist on disk? Used
 *  by {@link pickProvider} so a logged-in user gets `chatgpt-oauth` without
 *  having to set `QUANTA_PROVIDER`. The probe checks file existence only;
 *  token validity (expiry / signature) is established when the adapter
 *  actually streams (it refreshes on the fly if needed). */
const hasChatgptOAuthToken = (env) => {
    const home = env.QUANTA_PREFS_HOME ?? join(homedir(), ".quanta");
    return existsSync(join(home, "auth", "chatgpt.json"));
};
/** Canonical provider selection. Precedence (top wins):
 *   1. Explicit `QUANTA_PROVIDER` (when it names a registered provider).
 *   2. ChatGPT-OAuth token on disk — the user ran `/login` so the
 *      subscription path is their stated intent.
 *   3. `ANTHROPIC_API_KEY` env (BYOK Anthropic).
 *   4. `OPENAI_API_KEY` env (BYOK OpenAI).
 *   5. Fallback default: `anthropic`.
 *
 *  Validity check uses {@link DEFAULT_MODEL} keys so the explicit branch
 *  stays in lockstep with the registry. */
export const pickProvider = (env) => {
    const explicit = env.QUANTA_PROVIDER;
    if (explicit !== undefined && explicit in DEFAULT_MODEL)
        return explicit;
    if (hasChatgptOAuthToken(env))
        return "chatgpt-oauth";
    if (env.ANTHROPIC_API_KEY !== undefined)
        return "anthropic";
    if (env.OPENAI_API_KEY !== undefined)
        return "openai";
    return "anthropic";
};
/** Resolve the API key for a provider: explicit option wins, else the
 *  provider's env var. Returns `undefined` when neither is present. */
const resolveApiKey = (provider, opts, env) => opts.apiKey ?? env[API_KEY_ENV[provider]];
/** Build the adapter for `provider`. The CANONICAL missing-key behavior is to
 *  throw {@link MissingApiKeyError} (the cli's prior contract) so all call
 *  sites converge on the same loud failure. Callers that genuinely want the
 *  bench/eval "skip when no key" behavior use {@link tryCreateLLM}, which
 *  returns `null` instead.
 *
 *  @param env env source (required) — used only to resolve the API key /
 *             baseURL when not passed explicitly. Passed by the composition
 *             root so the factory never reads `process.env` itself. */
export const createLLM = (provider, opts, env) => {
    // ChatGPT-OAuth has no env-var credential — short-circuit the api-key
    // resolution so MissingApiKeyError never fires for it. The adapter itself
    // reads the on-disk token bundle when it actually streams.
    if (provider === "chatgpt-oauth") {
        const model = opts.model ?? DEFAULT_MODEL[provider];
        return ADAPTER_REGISTRY[provider]("", model, opts, env);
    }
    const apiKey = resolveApiKey(provider, opts, env);
    if (apiKey === undefined)
        throw new MissingApiKeyError(provider);
    const model = opts.model ?? DEFAULT_MODEL[provider];
    // Fill baseURL from env once here so the registry builder sees a uniform
    // options object regardless of whether the caller passed it.
    const merged = {
        ...opts,
        ...(opts.baseURL === undefined && env.OPENAI_BASE_URL !== undefined
            ? { baseURL: env.OPENAI_BASE_URL }
            : {}),
    };
    return ADAPTER_REGISTRY[provider](apiKey, model, merged, env);
};
/** Null-on-missing-key variant of {@link createLLM} for callers (bench, eval)
 *  that legitimately skip a step when the provider key is absent rather than
 *  aborting. Any OTHER error still throws. */
export const tryCreateLLM = (provider, opts, env) => {
    // ChatGPT-OAuth: env-var key is irrelevant; the credential is on disk.
    // Phase 1 adapter can't make a wire call, so callers wanting "skip when
    // no credential" should probe the token store directly (Phase 2 will
    // surface a cleaner capability handle here).
    if (provider === "chatgpt-oauth")
        return createLLM(provider, opts, env);
    if (resolveApiKey(provider, opts, env) === undefined)
        return null;
    return createLLM(provider, opts, env);
};
