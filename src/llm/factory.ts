import type { LLMProvider } from "@/shared/errors"
import { AnthropicAdapter } from "./adapters/anthropic"
import { OpenAIAdapter } from "./adapters/openai"
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
  openai: "gpt-5",
}

/** Per-provider env var holding the API key, in the precedence order the call
 *  sites used. Centralized so {@link pickProvider} and {@link createLLM} agree
 *  on what "the key for this provider" means. */
const API_KEY_ENV: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
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
  /** Anthropic `anthropic-beta` channels. Ignored by OpenAI. */
  betaHeaders?: readonly string[]
  /** Per-adapter completion token cap (adapter default 8192 when omitted). */
  maxTokens?: number
  /** T1 stream-hang guard overrides, forwarded to the adapter. */
  streamFirstChunkMs?: number
  streamIdleMs?: number
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

/** Registry: provider → adapter constructor. Adding a provider = one entry
 *  here (plus the `DEFAULT_MODEL` / `API_KEY_ENV` entries), NOT an if-chain
 *  edit. Each builder receives the resolved key/model and the raw options so it
 *  can pick the knobs its adapter understands (baseURL for OpenAI, betaHeaders
 *  for Anthropic) — unknown knobs are simply ignored, matching the prior
 *  per-site `buildLLM`. */
const ADAPTER_REGISTRY: Record<
  Provider,
  (apiKey: string, model: string, opts: CreateLLMOptions) => LLMPort
> = {
  openai: (apiKey, model, opts) =>
    new OpenAIAdapter({
      apiKey,
      model,
      ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      ...(opts.streamFirstChunkMs !== undefined
        ? { streamFirstChunkMs: opts.streamFirstChunkMs }
        : {}),
      ...(opts.streamIdleMs !== undefined ? { streamIdleMs: opts.streamIdleMs } : {}),
    }),
  anthropic: (apiKey, model, opts) =>
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
}

/** Read-only view of the env we consult for provider selection / keys. The
 *  caller MUST pass it explicitly — the factory deliberately does NOT default
 *  to `process.env` so it never touches the global env directly (the
 *  `runtimeConfig()` SSOT invariant; the anti-regression scanner bans
 *  `process.env` outside `runtime-config.ts`). The three composition-root call
 *  sites (`cli`/`bench`/`eval`) pass their already-loaded env. */
export type EnvLike = Record<string, string | undefined>

/** Canonical provider selection — the impl the three call sites duplicated and
 *  then let drift. Precedence: explicit `QUANTA_PROVIDER` (when valid) → first
 *  provider whose key env var is set (anthropic before openai) → `anthropic`.
 *  Validity check uses {@link DEFAULT_MODEL} keys so it stays in lockstep with
 *  the registry. */
export const pickProvider = (env: EnvLike): Provider => {
  const explicit = env.QUANTA_PROVIDER
  if (explicit !== undefined && explicit in DEFAULT_MODEL) return explicit as Provider
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
  return ADAPTER_REGISTRY[provider](apiKey, model, merged)
}

/** Null-on-missing-key variant of {@link createLLM} for callers (bench, eval)
 *  that legitimately skip a step when the provider key is absent rather than
 *  aborting. Any OTHER error still throws. */
export const tryCreateLLM = (
  provider: Provider,
  opts: CreateLLMOptions,
  env: EnvLike,
): LLMPort | null => {
  if (resolveApiKey(provider, opts, env) === undefined) return null
  return createLLM(provider, opts, env)
}
