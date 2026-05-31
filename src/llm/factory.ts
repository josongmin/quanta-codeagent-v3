import { hasUsableChatgptToken } from "@/auth/chatgpt-oauth"
import type { LLMProvider } from "@/shared/errors"
import { AnthropicAdapter } from "./adapters/anthropic"
import { ChatGPTOAuthAdapter } from "./adapters/chatgpt-oauth"
import { OpenAIAdapter } from "./adapters/openai"
import { OpenAIResponsesAdapter } from "./adapters/openai-responses"
import type { LLMPort } from "./ports"

/** Canonical provider identifier. Re-exports the `LLMProvider` union already
 *  defined in `@/shared/errors` (single source of truth — the error layer and
 *  the factory must agree). Adding a provider means extending THAT union plus
 *  one {@link ADAPTER_REGISTRY} entry and one {@link DEFAULT_MODEL} entry —
 *  never editing an if-chain (OCP). */
export type Provider = LLMProvider

/** Default model id per provider — the single source of truth the three app
 *  entry points (`cli`, `bench`, `eval`) previously each duplicated. */
export const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5-mini",
  // ChatGPT-OAuth subscription path. The Codex-only `gpt-5-codex` slug is
  // rejected by chatgpt.com backend ("not supported when using Codex with
  // a ChatGPT account"), so we default to the flagship `gpt-5` instead —
  // available on Plus/Pro/Team/Business/Enterprise tiers. Override with
  // `QUANTA_MODEL=<slug>` (e.g. `gpt-5-pro` on Pro, `o1`, `gpt-4o`).
  "chatgpt-oauth": "gpt-5",
}

/** Per-provider env var holding the API key. The `chatgpt-oauth` entry is a
 *  sentinel — that provider's credential lives on disk (token store), not in
 *  an env var; `createLLM` short-circuits the env lookup for it. */
const API_KEY_ENV: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "chatgpt-oauth": "__CHATGPT_OAUTH_ON_DISK__",
}

/** Options accepted by {@link createLLM}. The union of everything the three
 *  call sites passed to their local `buildLLM` plus the adapter-level knobs
 *  (beta headers, stream-hang overrides) so the wiring phase never has to reach
 *  past the factory. All optional except where a provider needs it. */
export interface CreateLLMOptions {
  /** Model id. Defaults to {@link DEFAULT_MODEL}[provider] when omitted. */
  model?: string
  /** API key. When omitted, read from the provider's env var
   *  ({@link API_KEY_ENV}). A missing key throws {@link MissingApiKeyError}
   *  unless `allowMissingKey` is set. */
  apiKey?: string
  /** OpenAI-compatible endpoint override (`OPENAI_BASE_URL`). Ignored by
   *  Anthropic. */
  baseURL?: string
  /** OpenAI wire surface preference. `auto` preserves the current default
   *  by selecting `responses` on the official OpenAI API and
   *  `chat-completions` on custom OpenAI-compatible base URLs. */
  surface?: "auto" | "chat-completions" | "responses"
  /** Anthropic `anthropic-beta` channels. Ignored by OpenAI. */
  betaHeaders?: readonly string[]
  /** Per-adapter completion token cap (adapter default 8192 when omitted). */
  maxTokens?: number
  /** T1 stream-hang guard overrides, forwarded to the adapter. */
  streamFirstChunkMs?: number
  streamIdleMs?: number
  /** OpenAI `service_tier` (Responses surface). When omitted, the factory
   *  derives it from the env (`QUANTA_SERVICE_TIER` / `QUANTA_FAST`) so the
   *  adapter slice never reads process.env itself. */
  serviceTier?: string
  /** Reasoning effort (Responses surface). When omitted, derived from
   *  `QUANTA_REASONING_EFFORT`. */
  reasoningEffort?: string
  /** ChatGPT-OAuth body debug logging. When omitted, derived from
   *  `QUANTA_DEBUG_OAUTH === "1"`. */
  debugOAuth?: boolean
}

/** Thrown by {@link createLLM} when the resolved provider has no API key and
 *  the caller did not opt into {@link tryCreateLLM}. Typed so the wiring phase
 *  can branch on it instead of string-matching a message. */
export class MissingApiKeyError extends Error {
  readonly provider: Provider
  readonly envVar: string
  constructor(provider: Provider) {
    const envVar = API_KEY_ENV[provider]
    super(`${envVar} is not set`)
    this.name = "MissingApiKeyError"
    this.provider = provider
    this.envVar = envVar
  }
}

/** Read-only env shape (forward declaration — full doc lower in the file). */
type EnvLikeDecl = Record<string, string | undefined>

/** Registry: provider → adapter constructor. Adding a provider = one entry
 *  here (plus the `DEFAULT_MODEL` / `API_KEY_ENV` entries), NOT an if-chain
 *  edit. Each builder receives the resolved key/model, the raw options, and
 *  the canonical env source — env is passed through (not read from
 *  `process.env`) so the SSOT invariant from the file header holds: this
 *  factory never touches the global env itself. The chatgpt-oauth adapter
 *  uses env to locate the on-disk token bundle. */
const ADAPTER_REGISTRY: Record<
  Provider,
  (apiKey: string, model: string, opts: CreateLLMOptions, env: EnvLikeDecl) => LLMPort
> = {
  openai: (apiKey, model, opts, env) => {
    const surface = resolveOpenAISurface(opts, env)
    const shared = {
      apiKey,
      model,
      ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      ...(opts.streamFirstChunkMs !== undefined
        ? { streamFirstChunkMs: opts.streamFirstChunkMs }
        : {}),
      ...(opts.streamIdleMs !== undefined ? { streamIdleMs: opts.streamIdleMs } : {}),
    }
    if (surface !== "responses") return new OpenAIAdapter(shared)
    // Responses surface honors the env-derived service_tier / reasoning effort,
    // resolved HERE (composition root) and threaded in as plain adapter config.
    const serviceTier = resolveServiceTier(opts, env)
    const reasoningEffort = resolveReasoningEffort(opts, env)
    return new OpenAIResponsesAdapter({
      ...shared,
      ...(serviceTier !== undefined ? { serviceTier } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    })
  },
  anthropic: (apiKey, model, opts, _env) =>
    new AnthropicAdapter({
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
  "chatgpt-oauth": (_apiKey, model, _opts, env) => {
    const serviceTier = resolveServiceTier(_opts, env)
    const reasoningEffort = resolveReasoningEffort(_opts, env)
    return new ChatGPTOAuthAdapter({
      model,
      env,
      debugOAuth: resolveDebugOAuth(_opts, env),
      ...(serviceTier !== undefined ? { serviceTier } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(_opts.maxTokens !== undefined ? { maxTokens: _opts.maxTokens } : {}),
      ...(_opts.streamFirstChunkMs !== undefined
        ? { streamFirstChunkMs: _opts.streamFirstChunkMs }
        : {}),
      ...(_opts.streamIdleMs !== undefined ? { streamIdleMs: _opts.streamIdleMs } : {}),
    })
  },
}

/** Read-only view of the env we consult for provider selection / keys. The
 *  caller MUST pass it explicitly — the factory deliberately does NOT default
 *  to `process.env` so it never touches the global env directly (the
 *  `runtimeConfig()` SSOT invariant; the anti-regression scanner bans
 *  `process.env` outside `runtime-config.ts`). The three composition-root call
 *  sites (`cli`/`bench`/`eval`) pass their already-loaded env. */
export type EnvLike = Record<string, string | undefined>

/** Composition-root resolution of the Responses `service_tier`. Explicit
 *  option wins; otherwise `QUANTA_FAST=1` ⇒ `"priority"`, else
 *  `QUANTA_SERVICE_TIER`. Empty ⇒ undefined. Keeping this read HERE (the
 *  factory already owns `env`) is what lets the adapter/wire slice stay free of
 *  `process.env` (slice-boundary invariant). */
const resolveServiceTier = (opts: CreateLLMOptions, env: EnvLikeDecl): string | undefined => {
  if (opts.serviceTier !== undefined) return opts.serviceTier
  const fromFast = env.QUANTA_FAST === "1" ? "priority" : undefined
  const value = fromFast ?? env.QUANTA_SERVICE_TIER
  return value !== undefined && value.length > 0 ? value : undefined
}

/** Composition-root resolution of the Responses reasoning effort. Explicit
 *  option wins; otherwise `QUANTA_REASONING_EFFORT`. The wire normalizes the
 *  closed value set — here we just forward the raw string. */
const resolveReasoningEffort = (opts: CreateLLMOptions, env: EnvLikeDecl): string | undefined =>
  opts.reasoningEffort ?? env.QUANTA_REASONING_EFFORT

/** Composition-root resolution of the ChatGPT-OAuth body-debug flag. Explicit
 *  option wins; otherwise `QUANTA_DEBUG_OAUTH === "1"`. */
const resolveDebugOAuth = (opts: CreateLLMOptions, env: EnvLikeDecl): boolean =>
  opts.debugOAuth ?? env.QUANTA_DEBUG_OAUTH === "1"

const resolveOpenAISurface = (
  opts: CreateLLMOptions,
  env: EnvLikeDecl,
): "chat-completions" | "responses" => {
  const raw = opts.surface ?? env.QUANTA_OPENAI_SURFACE ?? "auto"
  if (raw === "responses") return "responses"
  if (raw === "chat-completions") return "chat-completions"

  const baseURL = (opts.baseURL ?? env.OPENAI_BASE_URL)?.replace(/\/+$/, "")
  if (
    baseURL === undefined ||
    baseURL === "" ||
    baseURL === "https://api.openai.com/v1" ||
    baseURL === "https://api.openai.com"
  ) {
    return "responses"
  }
  return "chat-completions"
}

/** Cheap sync probe — does a ChatGPT-OAuth token file exist on disk? Used
 *  by {@link pickProvider} so a logged-in user gets `chatgpt-oauth` without
 *  having to set `QUANTA_PROVIDER`. The probe checks file existence only;
 *  token validity (expiry / signature) is established when the adapter
 *  actually streams (it refreshes on the fly if needed). */
const hasChatgptOAuthToken = (env: EnvLike): boolean => hasUsableChatgptToken(env)

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
export const pickProvider = (env: EnvLike): Provider => {
  // L6 M2: trim `QUANTA_PROVIDER` before the `in DEFAULT_MODEL` lookup. A
  // value like `" anthropic "` (trailing whitespace from a `.env` line)
  // otherwise misses the lookup and silently falls through to env detection —
  // the same `.trim()` discipline `provider-router.ts` already applies.
  const explicit = env.QUANTA_PROVIDER?.trim()
  if (explicit !== undefined && explicit in DEFAULT_MODEL) return explicit as Provider
  if (hasChatgptOAuthToken(env)) return "chatgpt-oauth"
  if (env.ANTHROPIC_API_KEY !== undefined) return "anthropic"
  if (env.OPENAI_API_KEY !== undefined) return "openai"
  return "anthropic"
}

/** Resolve the API key for a provider: explicit option wins, else the
 *  provider's env var. Returns `undefined` when neither is present. */
const resolveApiKey = (
  provider: Provider,
  opts: CreateLLMOptions,
  env: EnvLike,
): string | undefined => opts.apiKey ?? env[API_KEY_ENV[provider]]

/** Build the adapter for `provider`. The CANONICAL missing-key behavior is to
 *  throw {@link MissingApiKeyError} (the cli's prior contract) so all call
 *  sites converge on the same loud failure. Callers that genuinely want the
 *  bench/eval "skip when no key" behavior use {@link tryCreateLLM}, which
 *  returns `null` instead.
 *
 *  @param env env source (required) — used only to resolve the API key /
 *             baseURL when not passed explicitly. Passed by the composition
 *             root so the factory never reads `process.env` itself. */
export const createLLM = (provider: Provider, opts: CreateLLMOptions, env: EnvLike): LLMPort => {
  // ChatGPT-OAuth has no env-var credential — short-circuit the api-key
  // resolution so MissingApiKeyError never fires for it. The adapter itself
  // reads the on-disk token bundle when it actually streams.
  if (provider === "chatgpt-oauth") {
    const model = opts.model ?? DEFAULT_MODEL[provider]
    return ADAPTER_REGISTRY[provider]("", model, opts, env)
  }
  const apiKey = resolveApiKey(provider, opts, env)
  if (apiKey === undefined) throw new MissingApiKeyError(provider)
  const model = opts.model ?? DEFAULT_MODEL[provider]
  // Fill baseURL from env once here so the registry builder sees a uniform
  // options object regardless of whether the caller passed it.
  const merged: CreateLLMOptions = {
    ...opts,
    ...(opts.baseURL === undefined && env.OPENAI_BASE_URL !== undefined
      ? { baseURL: env.OPENAI_BASE_URL }
      : {}),
  }
  return ADAPTER_REGISTRY[provider](apiKey, model, merged, env)
}

/** Null-on-missing-key variant of {@link createLLM} for callers (bench, eval)
 *  that legitimately skip a step when the provider key is absent rather than
 *  aborting. Any OTHER error still throws. */
export const tryCreateLLM = (
  provider: Provider,
  opts: CreateLLMOptions,
  env: EnvLike,
): LLMPort | null => {
  // ChatGPT-OAuth: env-var key is irrelevant; the credential is on disk.
  // Phase 1 adapter can't make a wire call, so callers wanting "skip when
  // no credential" should probe the token store directly (Phase 2 will
  // surface a cleaner capability handle here).
  if (provider === "chatgpt-oauth") return createLLM(provider, opts, env)
  if (resolveApiKey(provider, opts, env) === undefined) return null
  return createLLM(provider, opts, env)
}
