import { hasUsableChatgptToken } from "@/auth/chatgpt-oauth"
import { gateOn } from "@/shared"
import type { LLMProvider } from "@/shared/errors"
import { runtimeConfig } from "@/shared/runtime-config"
import { AnthropicAdapter } from "./adapters/anthropic"
import { ChatGPTOAuthAdapter } from "./adapters/chatgpt-oauth"
import { OpenAIAdapter } from "./adapters/openai"
import { OpenAIResponsesAdapter } from "./adapters/openai-responses"
import { resolveContext1M } from "./context-1m"
import type { CredentialSource } from "./credential-helper"
import type { LLMPort } from "./ports"
import { type BedrockAdapterOptions, BedrockProviderAdapter } from "./providers/bedrock-adapter"
import type {
  LlmProvider,
  ProviderAuth,
  ProviderConfig,
  ProviderId,
} from "./providers/provider-port"
import { resolveProvider } from "./providers/registry"
import { type VertexAdapterOptions, VertexProviderAdapter } from "./providers/vertex-adapter"
import { jsonlReplayStore, replayLlmPort } from "./replay"
import type { CacheTtl } from "./types"

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
  // jun-15: default bumped `gpt-5-mini` → `gpt-5.4`. The bare `gpt-5.4` slug is
  // not in MODEL_CONTEXT_WINDOWS but routes through the `gpt-5` family fallback
  // (provider-metadata.ts) so the 400k window / reasoning catalog resolve cleanly
  // with no table edit. Override with `--model` / `QUANTA_MODEL=<slug>`.
  openai: "gpt-5.4",
  // ChatGPT-OAuth subscription path. The Codex-only `gpt-5-codex` slug is
  // rejected by chatgpt.com backend ("not supported when using Codex with
  // a ChatGPT account"). jun-10: bumped `gpt-5` → `gpt-5.4` — the bare
  // `gpt-5` slug dropped out of the `/codex/models` subscription catalog, so
  // every session opened with a silent-substitution warn and ran the
  // server-picked fallback instead of a deliberate default. Override with
  // `QUANTA_MODEL=<slug>`; an account whose catalog lacks gpt-5.4 still
  // degrades safely (`resolveModelFromCatalog` swaps to the catalog default
  // with a loud warn).
  "chatgpt-oauth": "gpt-5.4",
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
  /** RFC05-2 — guarded-fetch injection for a configured named OpenAI endpoint.
   *  Forwarded verbatim to the OpenAI adapter's existing `fetchImpl?` seam (both
   *  Chat + Responses) so a declarative endpoint's network policy (SSRF / scheme
   *  / redirect admission via `fetchWithSsrfGuard`) governs the wire. The
   *  composition root (`@/runner/assemble/llm.ts`) builds it from the resolved
   *  endpoint; it is NOT read from env. Ignored by Anthropic. ABSENT ⇒ the SDK
   *  uses its default global fetch (byte-identical to the pre-RFC05 path). */
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
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
  /** Reasoning summary request (Responses surface). When omitted, derived from
   *  `QUANTA_REASONING_SUMMARY` (bool). True ⇒ `reasoning.summary:"auto"`. */
  reasoningSummary?: boolean
  /** Reasoning summary detail level (Responses surface). When omitted, derived
   *  from `QUANTA_REASONING_SUMMARY_DETAIL` (`auto|concise|detailed`). Unset /
   *  invalid ⇒ `undefined` ⇒ wire uses `"auto"`. */
  reasoningSummaryDetail?: "auto" | "concise" | "detailed"
  /** Reasoning output verbosity (Responses surface). When omitted, derived from
   *  `QUANTA_REASONING_VERBOSITY` (`low|medium|high`). Maps to `text.verbosity`. */
  reasoningVerbosity?: string
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
      // RFC05-2 — plumb the configured endpoint's guarded fetch into BOTH OpenAI
      // wires (the Chat + Responses adapters each expose the same `fetchImpl?`
      // seam). Absent ⇒ omitted ⇒ SDK default global fetch (byte-identical).
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
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
    const reasoningVerbosity = resolveReasoningVerbosity(opts, env)
    const reasoningSummaryDetail = resolveReasoningSummaryDetail(opts, env)
    return new OpenAIResponsesAdapter({
      ...shared,
      ...(serviceTier !== undefined ? { serviceTier } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(resolveReasoningSummary(opts, env) ? { reasoningSummary: true } : {}),
      ...(reasoningSummaryDetail !== undefined ? { reasoningSummaryDetail } : {}),
      ...(reasoningVerbosity !== undefined ? { reasoningVerbosity } : {}),
      ...(resolveReasoningCarryover(env) ? { reasoningCarryover: true } : {}),
    })
  },
  anthropic: (apiKey, model, opts, env) => {
    // gap-other-agent GAP 5 — resolve the env/opts service_tier ONCE; the codec
    // normalizes to Anthropic's auto|standard_only and drops the rest. Absent ⇒
    // omitted ⇒ no `service_tier` key (byte-identical).
    const serviceTier = resolveServiceTier(opts, env)
    // gap-other-agent GAP 3 — 1M-context: strip the `[1m]` suffix off the API
    // model id and, when active+eligible, ADD the `context-1m-2025-08-07` beta
    // header (de-duped). Inactive ⇒ canonical model unchanged, no header added
    // (byte-identical). (Window-metadata bump for compaction is a separate broad
    // plumbing step — server-side activation via the header is the essential win.)
    const ctx1m = resolveContext1M(model, env)
    const betaHeaders =
      ctx1m.betaHeader !== undefined
        ? [...(opts.betaHeaders ?? []).filter((h) => h !== ctx1m.betaHeader), ctx1m.betaHeader]
        : opts.betaHeaders
    return new AnthropicAdapter({
      apiKey,
      model: ctx1m.model,
      // gap GAP 3 (ADR-0505) — pin the 1M window key ONLY when context-1m is
      // active+eligible; absent ⇒ compaction resolves the window from `model`
      // (byte-identical 200k default).
      ...(ctx1m.active ? { contextWindowKey: ctx1m.windowKey } : {}),
      ...(serviceTier !== undefined ? { serviceTier } : {}),
      ...(betaHeaders !== undefined ? { betaHeaders } : {}),
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      ...(opts.streamFirstChunkMs !== undefined
        ? { streamFirstChunkMs: opts.streamFirstChunkMs }
        : {}),
      ...(opts.streamIdleMs !== undefined ? { streamIdleMs: opts.streamIdleMs } : {}),
      // Prompt-cache 1h TTL: only granted when the knob is "1h" AND the model
      // is allowlisted; otherwise "5m" (byte-identical fixed-5m cache_control).
      cacheTtl: resolveCacheTtl(ctx1m.model, runtimeConfig()),
    })
  },
  // ChatGPT-OAuth provider (ADR-0094 Phase 2). The api-key argument is unused
  // — the credential is the on-disk token bundle written by `/login`. `env`
  // is forwarded so the adapter resolves OAuth config (issuer/sku/originator)
  // and locates `~/.quanta/auth/chatgpt.json` without reading process.env
  // directly.
  "chatgpt-oauth": (_apiKey, model, _opts, env) => {
    const serviceTier = resolveServiceTier(_opts, env)
    const reasoningEffort = resolveReasoningEffort(_opts, env)
    const reasoningVerbosity = resolveReasoningVerbosity(_opts, env)
    const reasoningSummaryDetail = resolveReasoningSummaryDetail(_opts, env)
    return new ChatGPTOAuthAdapter({
      model,
      env,
      debugOAuth: resolveDebugOAuth(_opts, env),
      ...(serviceTier !== undefined ? { serviceTier } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(resolveReasoningSummary(_opts, env) ? { reasoningSummary: true } : {}),
      ...(reasoningSummaryDetail !== undefined ? { reasoningSummaryDetail } : {}),
      ...(reasoningVerbosity !== undefined ? { reasoningVerbosity } : {}),
      ...(resolveReasoningCarryover(env) ? { reasoningCarryover: true } : {}),
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
export const resolveServiceTier = (
  opts: CreateLLMOptions,
  env: EnvLikeDecl,
): string | undefined => {
  if (opts.serviceTier !== undefined) return opts.serviceTier
  const fromFast = gateOn(env, "QUANTA_FAST") ? "priority" : undefined
  const value = fromFast ?? env.QUANTA_SERVICE_TIER
  return value !== undefined && value.length > 0 ? value : undefined
}

/** Composition-root resolution of the Responses reasoning effort. Explicit
 *  option wins; otherwise `QUANTA_REASONING_EFFORT`. The wire normalizes the
 *  closed value set — here we just forward the raw string. */
const resolveReasoningEffort = (opts: CreateLLMOptions, env: EnvLikeDecl): string | undefined =>
  opts.reasoningEffort ?? env.QUANTA_REASONING_EFFORT

/** Composition-root resolution of the reasoning-summary request
 *  (`QUANTA_REASONING_SUMMARY`, bool). Explicit option wins; otherwise the
 *  broadened gate vocabulary `{1,on,true,yes}`. Default-OFF ⇒ false ⇒ no
 *  `reasoning.summary` (byte-identical). */
export const resolveReasoningSummary = (opts: CreateLLMOptions, env: EnvLikeDecl): boolean =>
  opts.reasoningSummary ?? gateOn(env, "QUANTA_REASONING_SUMMARY")

/** Composition-root resolution of the reasoning output verbosity
 *  (`QUANTA_REASONING_VERBOSITY`, enum `low|medium|high`). Explicit option wins;
 *  otherwise the raw env string — the wire normalizes the closed value set (an
 *  out-of-set value is dropped there, never reaching the body). */
export const resolveReasoningVerbosity = (
  opts: CreateLLMOptions,
  env: EnvLikeDecl,
): string | undefined => opts.reasoningVerbosity ?? env.QUANTA_REASONING_VERBOSITY

/** Composition-root resolution of the reasoning summary detail level
 *  (`QUANTA_REASONING_SUMMARY_DETAIL`, enum `auto|concise|detailed`). Explicit
 *  option wins; otherwise the env var. Unset or out-of-set ⇒ `undefined` ⇒ wire
 *  defaults to `"auto"`. Non-bench surfaces pass no explicit opt so they stay
 *  byte-identical; bench composition root passes `"detailed"` as a CODE default. */
export const resolveReasoningSummaryDetail = (
  opts: CreateLLMOptions,
  env: EnvLikeDecl,
): "auto" | "concise" | "detailed" | undefined => {
  const raw = opts.reasoningSummaryDetail ?? env.QUANTA_REASONING_SUMMARY_DETAIL
  if (raw === "auto" || raw === "concise" || raw === "detailed") return raw
  return undefined
}

/** H15 — composition-root resolution of o-series reasoning carry-over
 *  (`QUANTA_REASONING_CARRYOVER`). Default-OFF: unset ⇒ false ⇒ the Responses
 *  adapters drop thinking + emit no `include` (byte-identical). */
export const resolveReasoningCarryover = (env: EnvLikeDecl): boolean =>
  gateOn(env, "QUANTA_REASONING_CARRYOVER")

/** Models whose Anthropic cache_control supports the extended `ttl:"1h"`
 *  breakpoint. Keyed by NORMALIZED model FAMILY (vendor prefix + date suffix
 *  stripped) so a cloud slug (`anthropic.claude-opus-4-8-v1:0`,
 *  `claude-opus-4-8@20250101`) maps to the same family as the public slug. A
 *  model NOT in this set NEVER receives `ttl:"1h"` even when the knob is on —
 *  the codec stays byte-identical (5m) for it. */
export const CACHE_1H_ALLOWLIST: ReadonlySet<string> = new Set([
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
])

/** Normalize a (possibly cloud-prefixed / date-suffixed) model slug to its
 *  canonical Anthropic family so the allowlist match is transport-agnostic.
 *  Strips a leading `anthropic.` vendor prefix (Bedrock), a trailing
 *  `-v<N>:<N>` Bedrock version, a trailing `@<date>` Vertex pin, and a trailing
 *  `-<8-digit-date>` public-API date suffix. Lowercased for case tolerance. */
export const normalizeModelFamily = (model: string): string => {
  let m = model.toLowerCase().trim()
  if (m.startsWith("anthropic.")) m = m.slice("anthropic.".length)
  // Peel trailing cloud affixes to a FIXPOINT so a combined slug
  // (`…-v1:0-20250101`, `…-20250101-20250102`) collapses fully — a single
  // ordered pass would peel only the outermost affix and leave a non-family
  // key, so the allowlist lookup would non-deterministically miss. Bounded by
  // the strict shrink each iteration causes (no affix ⇒ exit).
  for (;;) {
    const next = m
      .replace(/-v\d+:\d+$/, "") // Bedrock version suffix
      .replace(/@\d{6,}$/, "") // Vertex @date pin
      .replace(/-\d{8}$/, "") // public-API -YYYYMMDD suffix
    if (next === m) break
    m = next
  }
  return m
}

/** Anthropic model FAMILIES that support `thinking:{type:"adaptive"}` (the
 *  model self-paces per request). Keyed by NORMALIZED family so a cloud slug
 *  (`anthropic.claude-opus-4-8-v1:0`, `claude-opus-4-6@20251101`) collapses to
 *  the same key as the public slug. Sibling of {@link CACHE_1H_ALLOWLIST} —
 *  reuses {@link normalizeModelFamily}. A model NOT in this set NEVER receives
 *  `{type:"adaptive"}`; it falls back to the manual `{type:"enabled",
 *  budget_tokens}` path (so Sonnet 4.5 / Haiku 4.5 / 3.x never 400 and never get
 *  a deprecated adaptive request). NOTE deliberately EXCLUDES `claude-haiku-4-5`
 *  (no adaptive support) even though it IS on the 1h-cache allowlist — the two
 *  sets are intentionally different. */
export const ADAPTIVE_THINKING_FAMILIES: ReadonlySet<string> = new Set([
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
])

/** True iff `model`'s normalized family is adaptive-thinking-capable. An absent
 *  / unknown / garbage slug is NOT adaptive (fail-safe → manual budget). */
export const supportsAdaptiveThinking = (model: string | undefined): boolean =>
  model !== undefined && ADAPTIVE_THINKING_FAMILIES.has(normalizeModelFamily(model))

/** Resolve the effective prompt-cache TTL for `model`. `"1h"` is granted ONLY
 *  when the knob selected `"1h"` AND the model's family is on the
 *  {@link CACHE_1H_ALLOWLIST}; otherwise `"5m"` (byte-identical fixed-5m
 *  cache_control). Pure — `cfg` is the frozen runtime config. */
export const resolveCacheTtl = (model: string, cfg: { readonly cacheTtl: CacheTtl }): CacheTtl =>
  cfg.cacheTtl === "1h" && CACHE_1H_ALLOWLIST.has(normalizeModelFamily(model)) ? "1h" : "5m"

/** Composition-root resolution of the ChatGPT-OAuth body-debug flag. Explicit
 *  option wins; otherwise `QUANTA_DEBUG_OAUTH === "1"`. */
export const resolveDebugOAuth = (opts: CreateLLMOptions, env: EnvLikeDecl): boolean =>
  opts.debugOAuth ?? gateOn(env, "QUANTA_DEBUG_OAUTH")

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
  // jun-11 — DETERMINISTIC REPLAY seam (default-OFF). `QUANTA_LLM_REPLAY=<jsonl>`
  // swaps the network adapter for a cassette player: every `stream()` returns the
  // recorded `StreamEvent`s, no API key / no network. Enables turn-layer e2e
  // (e.g. reasoning-display render, mid-turn behavior) + reproducible repro. The
  // request→cassette hash is pinned to a constant so a hand-authored single-turn
  // cassette (`{"id":"replay","events":[…]}`) matches without predicting a hash;
  // `onMiss:"throw"` makes a stale/short cassette FAIL loud. Unset ⇒ byte-
  // identical (no replay import side effect, the real adapter path below runs).
  const replayPath = (env as { QUANTA_LLM_REPLAY?: string }).QUANTA_LLM_REPLAY
  if (replayPath !== undefined && replayPath !== "") {
    const inner = replayLlmPort({
      store: jsonlReplayStore({ path: replayPath, hashRequest: () => "replay" }),
      onMiss: "throw",
    })
    // Optional per-event delay (`QUANTA_LLM_REPLAY_DELAY_MS`, e2e only) to SUSTAIN
    // the turn so a test can type a follow-up DURING it (mid-turn-capture e2e).
    // Unset / ≤0 ⇒ instant (byte-identical to the bare replay port).
    const delayMs = Number(
      (env as { QUANTA_LLM_REPLAY_DELAY_MS?: string }).QUANTA_LLM_REPLAY_DELAY_MS,
    )
    if (Number.isFinite(delayMs) && delayMs > 0) {
      return {
        ...(inner.model !== undefined ? { model: inner.model } : {}),
        async *stream(input) {
          for await (const ev of inner.stream(input)) {
            await new Promise((r) => setTimeout(r, delayMs))
            yield ev
          }
        },
      }
    }
    return inner
  }
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

// ─────────── H7-BYOK — apiKeyHelper mint for the LEGACY vendor key path ──────
//
// RFC docs/plans/jun-6-byok-apikey-helper.md. H7 shipped a fully-hardened
// executable `CredentialSource` whose `mintApiKey()` runs an operator-configured
// shell command that prints a freshly-minted API key (TTL-cached, single-flight,
// empty-stdout-guarded, trust-gated, no-leak — `credential-helper.ts`). Until now
// only its sibling `refreshCloudCreds(...)` had a live consumer (Bedrock/Vertex);
// the `mintApiKey()` path was dead for the LEGACY `anthropic`/`openai` vendor key
// that `createLLM` resolves from `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.
//
// {@link resolveVendorApiKey} closes that gap WITHOUT making the factory async:
// the composition root (`@/runner/assemble/llm`, which already builds the H7
// `CredentialSource`) `await`s this pre-resolution step and passes the minted key
// in as `opts.apiKey` — which `resolveApiKey` already lets win over env. The
// sync `createLLM` is then called with the resolved opts. The mint feeds ONLY the
// two legacy vendor providers; `chatgpt-oauth` (on-disk token) and the multicloud
// transports (`refreshCloudCreds`, a different H7 capability) are guarded out.

/** The ONLY providers whose env-var key may be replaced by an `apiKeyHelper`
 *  mint. `chatgpt-oauth` has no env key (on-disk token); `bedrock`/`vertex` use
 *  the OTHER H7 capability (`refreshCloudCreds`). Pinning the set here keeps the
 *  guard a typed, exhaustive membership check rather than an if-chain. */
export const MINTABLE_PROVIDERS: ReadonlySet<Provider> = new Set<Provider>(["anthropic", "openai"])

/** Pre-resolve `opts.apiKey` from the H7 `apiKeyHelper` mint for a LEGACY vendor
 *  provider, at the composition root, BEFORE the synchronous {@link createLLM}.
 *
 *  This is the ONLY async step in the vendor-key path; the factory itself stays
 *  synchronous (RFC §3.3) — the root `await`s this, then calls `createLLM` with
 *  the returned (possibly key-augmented) opts.
 *
 *  Precedence (RFC §4.3), first wins:
 *    1. `opts.apiKey` — an explicit caller key hard-pins; the mint is NOT even
 *       consulted (no shell spawned).
 *    2. `apiKeyHelper` mint — when a `source` is present AND the provider is
 *       mintable AND the helper is configured/trusted/non-empty.
 *    3. `env[API_KEY_ENV[provider]]` — resolved later, INSIDE `createLLM`.
 *
 *  Default-OFF / byte-identity:
 *    - `source === undefined` (no H7 knob set, or the legacy-vendor gate is off)
 *      ⇒ returns the SAME `opts` reference (no `apiKey` added) ⇒ `createLLM`
 *      resolves from env exactly as today.
 *    - `mintApiKey()` returns `undefined` (no `apiKeyHelper` configured) ⇒ same.
 *    - A non-mintable provider (`chatgpt-oauth`/cloud transport) ⇒ same, mint
 *      never called.
 *
 *  Failure: a CONFIGURED-but-broken helper (non-zero exit / empty stdout /
 *  untrusted) makes `mintApiKey()` THROW a typed `CredentialHelperError`, which
 *  this function propagates to the root (symmetric with how a failing
 *  `refreshCloudCreds` surfaces before a cloud wire call). The H7 empty-stdout
 *  guard is what makes "mint above env" safe — a broken helper throws rather than
 *  shadowing a working env key with `""`.
 *
 *  NO-LEAK: the minted value flows only into the returned `opts.apiKey`; it is
 *  never logged here, and the H7 error taxonomy already drops helper output.
 *
 *  @param source the H7 {@link CredentialSource} the composition root already
 *                built, or `undefined` when the BYOK-mint gate is off / no H7
 *                knob is set (default-OFF fast path). */
export const resolveVendorApiKey = async (
  provider: Provider,
  opts: CreateLLMOptions,
  source: CredentialSource | undefined,
): Promise<CreateLLMOptions> => {
  if (source === undefined) return opts // default-OFF / gate-off fast path
  if (!MINTABLE_PROVIDERS.has(provider)) return opts // oauth / cloud transports skip
  if (opts.apiKey !== undefined) return opts // explicit caller key wins over mint
  const minted = await source.mintApiKey() // undefined when apiKeyHelper unset; throws on broken
  return minted === undefined ? opts : { ...opts, apiKey: minted }
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

// ───────────────────────── Multicloud transport wiring (ADR-0139 + H7) ──────
//
// The four providers above ({anthropic, openai, chatgpt-oauth}) are the legacy
// VENDOR×SURFACE axis — selecting one of them runs the byte-identical path that
// the three composition roots have always used. The `src/llm/providers/` slice
// (ADR-0139 provider port) is a SEPARATE TRANSPORT axis: same Anthropic Messages
// grammar, different billing/residency/IAM boundary (AWS Bedrock, GCP Vertex,
// Azure Foundry, Mantle). Until now that slice was UNWIRED — `resolveProvider`
// existed but no factory consulted it, so H7's rotating-credential helper had no
// live cloud provider to attach to.
//
// `createMulticloudLLM` closes that gap: it is the single composition-root entry
// that (a) reuses the registry's deterministic transport-selection precedence,
// (b) builds the `ProviderConfig` from the same `EnvLike` the legacy factory
// owns, and (c) INJECTS the H7 `CredentialSource` into the Bedrock/Vertex
// adapters so a rotating/expiring cloud credential is refreshed before each
// wire call. It is opt-in: callers that never invoke it get the byte-identical
// legacy `createLLM` path. The legacy `ADAPTER_REGISTRY` and the four providers
// above are untouched.

/** Transport id selectable through {@link createMulticloudLLM}. Re-exports the
 *  registry's {@link ProviderId} union so the multicloud entry stays in lockstep
 *  with the registry (adding a transport is a typed change in ONE place — the
 *  registry — not an if-chain here). Kept SEPARATE from {@link Provider} (the
 *  vendor×surface axis) on purpose: fusing the two unions would ripple `bedrock`
 *  / `vertex` into every `Record<LLMProvider, …>` (pricing tables, the error
 *  classifier, embedder maps) that has nothing to say about transport. */
export type MulticloudProviderId = ProviderId

/** Default Anthropic model id per cloud transport. The cloud catalogs expose
 *  region-/vendor-prefixed model slugs distinct from the public-API slug, so a
 *  caller that does not pin `model` gets a transport-appropriate default rather
 *  than a 400 from a public-API slug the cloud catalog does not list. Callers
 *  override with `opts.model` (CLI `QUANTA_MODEL`). `default` mirrors the public
 *  Anthropic path so a `default`-resolved transport matches `DEFAULT_MODEL`. */
export const MULTICLOUD_DEFAULT_MODEL: Record<MulticloudProviderId, string> = {
  default: "claude-sonnet-4-6",
  bedrock: "anthropic.claude-sonnet-4-6-v1:0",
  vertex: "claude-sonnet-4-6@20250101",
  foundry: "claude-sonnet-4-6",
  mantle: "claude-sonnet-4-6",
}

/** Env keys the multicloud config builder reads to populate {@link ProviderAuth}.
 *  Mirrors the cloud-SDK default-credential-chain spellings; ALL optional — an
 *  absent field lets the SDK's own default chain (env / IMDS / IRSA / SSO / ADC)
 *  resolve. Exposed so a CLI `--help` can surface the canonical names. */
export const MULTICLOUD_AUTH_ENV_KEYS = {
  awsAccessKeyId: "AWS_ACCESS_KEY_ID",
  awsSecretAccessKey: "AWS_SECRET_ACCESS_KEY",
  awsSessionToken: "AWS_SESSION_TOKEN",
  awsRegion: "AWS_REGION",
  gcpProjectId: "ANTHROPIC_VERTEX_PROJECT_ID",
  gcpLocation: "CLOUD_ML_REGION",
  azureResource: "ANTHROPIC_FOUNDRY_RESOURCE",
  azureEndpoint: "ANTHROPIC_FOUNDRY_BASE_URL",
  azureApiKey: "ANTHROPIC_FOUNDRY_API_KEY",
  mantleToken: "ANTHROPIC_MANTLE_TOKEN",
  mantleEndpoint: "ANTHROPIC_MANTLE_BASE_URL",
} as const

/** Options accepted by {@link createMulticloudLLM}. A superset of the per-
 *  transport adapter knobs the factory already owns (model / maxTokens / stream
 *  guards / beta) plus the H7 injection seam. Everything optional. */
export interface CreateMulticloudOptions {
  /** Explicit transport id (caller wins over env). Empty/omitted ⇒ the env
   *  precedence ladder in {@link resolveProvider} decides. */
  providerId?: string
  /** Model slug. Defaults to {@link MULTICLOUD_DEFAULT_MODEL}[resolved id]. */
  model?: string
  /** Explicit auth bundle. Fields supplied here win over the env-derived
   *  defaults; omitted fields fall through to {@link MULTICLOUD_AUTH_ENV_KEYS}. */
  auth?: ProviderAuth
  /** Anthropic beta channels — forwarded to the `default` transport only. */
  betaHeaders?: readonly string[]
  maxTokens?: number
  streamFirstChunkMs?: number
  streamIdleMs?: number
  /** H7 — injected rotating-credential source. When present AND the resolved
   *  transport is `bedrock` / `vertex`, the adapter awaits
   *  `refreshCloudCreds(...)` before each `stream()`. ABSENT ⇒ no rotation;
   *  the adapter uses the SDK default credential chain (byte-identical to the
   *  pre-H7 path). The composition root builds this from the H7 runtime-config
   *  knobs (`QUANTA_AWS_AUTH_REFRESH` / `QUANTA_GCP_AUTH_REFRESH` / …) via
   *  `createCredentialSource` — this slice never spawns a shell itself. */
  credentialSource?: CredentialSource
  /** Test-only DI seams — bypass the lazy cloud-SDK import. Production omits. */
  bedrockClientFactory?: BedrockAdapterOptions["clientFactory"]
  vertexClientFactory?: VertexAdapterOptions["clientFactory"]
}

/** Build the {@link ProviderAuth} bundle from explicit opts (winning) layered
 *  over the env-derived cloud-SDK defaults. Only sets a field when a value is
 *  present so `exactOptionalPropertyTypes` stays honest and the adapter sees a
 *  field ONLY when the operator actually supplied one (absent ⇒ SDK default
 *  chain). */
const resolveMulticloudAuth = (opts: CreateMulticloudOptions, env: EnvLike): ProviderAuth => {
  const e = MULTICLOUD_AUTH_ENV_KEYS
  const pick = (explicit: string | undefined, key: string): string | undefined => {
    if (explicit !== undefined) return explicit
    const v = env[key]
    return v !== undefined && v.length > 0 ? v : undefined
  }
  const a = opts.auth ?? {}
  const out: { -readonly [K in keyof ProviderAuth]?: ProviderAuth[K] } = {}
  const awsAccessKeyId = pick(a.awsAccessKeyId, e.awsAccessKeyId)
  if (awsAccessKeyId !== undefined) out.awsAccessKeyId = awsAccessKeyId
  const awsSecretAccessKey = pick(a.awsSecretAccessKey, e.awsSecretAccessKey)
  if (awsSecretAccessKey !== undefined) out.awsSecretAccessKey = awsSecretAccessKey
  const awsSessionToken = pick(a.awsSessionToken, e.awsSessionToken)
  if (awsSessionToken !== undefined) out.awsSessionToken = awsSessionToken
  const awsRegion = pick(a.awsRegion, e.awsRegion)
  if (awsRegion !== undefined) out.awsRegion = awsRegion
  const gcpProjectId = pick(a.gcpProjectId, e.gcpProjectId)
  if (gcpProjectId !== undefined) out.gcpProjectId = gcpProjectId
  const gcpLocation = pick(a.gcpLocation, e.gcpLocation)
  if (gcpLocation !== undefined) out.gcpLocation = gcpLocation
  if (a.gcpAccessToken !== undefined) out.gcpAccessToken = a.gcpAccessToken
  const azureResource = pick(a.azureResource, e.azureResource)
  if (azureResource !== undefined) out.azureResource = azureResource
  const azureEndpoint = pick(a.azureEndpoint, e.azureEndpoint)
  if (azureEndpoint !== undefined) out.azureEndpoint = azureEndpoint
  const azureApiKey = pick(a.azureApiKey, e.azureApiKey)
  if (azureApiKey !== undefined) out.azureApiKey = azureApiKey
  const mantleToken = pick(a.mantleToken, e.mantleToken)
  if (mantleToken !== undefined) out.mantleToken = mantleToken
  const mantleEndpoint = pick(a.mantleEndpoint, e.mantleEndpoint)
  if (mantleEndpoint !== undefined) out.mantleEndpoint = mantleEndpoint
  // `apiKey` (default transport) flows through from explicit opts.auth only —
  // the legacy `ANTHROPIC_API_KEY` env path is owned by `createLLM`, not here.
  if (a.apiKey !== undefined) out.apiKey = a.apiKey
  if (a.azureADTokenProvider !== undefined) out.azureADTokenProvider = a.azureADTokenProvider
  return out
}

/**
 * Construct a cloud-transport LLM provider (ADR-0139) with H7 rotating-credential
 * injection. The single composition-root seam that connects the `providers/`
 * slice to a live provider.
 *
 *   1. {@link resolveProvider} picks the transport (explicit id wins, else the
 *      `ANTHROPIC_{BEDROCK,VERTEX,FOUNDRY}_*` env precedence ladder).
 *   2. A {@link ProviderConfig} is assembled from opts + env (model default,
 *      auth bundle, stream guards, beta).
 *   3. For `bedrock` / `vertex` the adapter is constructed DIRECTLY so the H7
 *      `credentialSource` (and the test-only client factory) can be injected —
 *      the registry's `factory(config)` arm cannot carry those. For
 *      `default` / `foundry` / `mantle` (which do not consume a `CredentialSource`)
 *      the registry factory is used verbatim, preserving its lazy-unsupported
 *      contract for unknown ids.
 *
 * Returns an {@link LLMPort} — `LlmProvider extends LLMPort`, so the result is
 * plug-compatible everywhere the loop expects an `LLMPort`.
 *
 * @param env env source (required) — passed by the composition root so this
 *            slice never reads `process.env` (the `runtimeConfig()` SSOT).
 */
export const createMulticloudLLM = (opts: CreateMulticloudOptions, env: EnvLike): LLMPort => {
  const resolved = resolveProvider(opts.providerId, env)
  // The resolved id is `ProviderId | string`; a string-only id is an UNKNOWN
  // transport whose registry factory lazy-throws `provider-unsupported`. Use
  // the known-id default model when we have one, else fall through to the
  // public-Anthropic slug (the unsupported factory throws before it is read).
  const id = resolved.id
  const knownId: MulticloudProviderId =
    (id as MulticloudProviderId) in MULTICLOUD_DEFAULT_MODEL
      ? (id as MulticloudProviderId)
      : "default"
  const model = opts.model ?? MULTICLOUD_DEFAULT_MODEL[knownId]
  const config: ProviderConfig = {
    // The registry already validated `id`; for an unknown id the factory
    // lazy-throws, so `providerId` here only needs to satisfy the type — the
    // adapter constructor re-checks `config.providerId === <its id>`.
    providerId: knownId,
    model,
    auth: resolveMulticloudAuth(opts, env),
    ...(opts.betaHeaders !== undefined ? { betaHeaders: opts.betaHeaders } : {}),
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.streamFirstChunkMs !== undefined
      ? { streamFirstChunkMs: opts.streamFirstChunkMs }
      : {}),
    ...(opts.streamIdleMs !== undefined ? { streamIdleMs: opts.streamIdleMs } : {}),
    // Prompt-cache 1h TTL — gated by the same allowlist as the legacy path.
    // The cloud adapters share the Anthropic Messages codec, so the 4th-arg
    // ttl reaches their request builder identically (5m default = byte-id).
    cacheTtl: resolveCacheTtl(model, runtimeConfig()),
  }

  // Bedrock / Vertex: construct directly so the H7 credentialSource + the
  // test-only client factory can be injected (the registry `factory(config)`
  // arm has no slot for adapter options).
  if (id === "bedrock") return buildBedrock(config, opts)
  if (id === "vertex") return buildVertex(config, opts, env)

  // default / foundry / mantle / unknown — no CredentialSource slot; use the
  // registry factory verbatim (preserves the lazy-unsupported contract for
  // unknown ids).
  const provider: LlmProvider = resolved.factory(config)
  return provider
}

/** Construct the Bedrock adapter with the H7 credential source + test client
 *  factory injected only when supplied (exactOptional honest). Extracted from
 *  {@link createMulticloudLLM} so the entry stays under the cognitive-complexity
 *  cap and the injection shape lives in one place per transport. */
const buildBedrock = (config: ProviderConfig, opts: CreateMulticloudOptions): LLMPort => {
  const adapterOpts: BedrockAdapterOptions = {}
  if (opts.credentialSource !== undefined) adapterOpts.credentialSource = opts.credentialSource
  if (opts.bedrockClientFactory !== undefined) adapterOpts.clientFactory = opts.bedrockClientFactory
  return new BedrockProviderAdapter(config, adapterOpts)
}

/** Vertex sibling of {@link buildBedrock}. Additionally derives the per-model
 *  region map from `VERTEX_REGION_<MODEL>` env (same injected `env` the auth
 *  ladder reads for `CLOUD_ML_REGION`) and threads it into the adapter opts.
 *  Empty/absent ⇒ no map (byte-identical single-region path). */
const buildVertex = (
  config: ProviderConfig,
  opts: CreateMulticloudOptions,
  env: EnvLike,
): LLMPort => {
  const adapterOpts: VertexAdapterOptions = {}
  if (opts.credentialSource !== undefined) adapterOpts.credentialSource = opts.credentialSource
  if (opts.vertexClientFactory !== undefined) adapterOpts.clientFactory = opts.vertexClientFactory
  const regionMap = resolveVertexRegionMap(env)
  if (regionMap !== undefined) adapterOpts.vertexRegionByModel = regionMap
  return new VertexProviderAdapter(config, adapterOpts)
}

/** Derive the per-model Vertex region map from `VERTEX_REGION_<MODEL>` env
 *  vars. The suffix after `VERTEX_REGION_` is the model slug with `-`/`.`/`@`
 *  separators rendered as `_` (the only chars an env var name admits); we
 *  re-render it to the canonical dashed-lowercase wire slug used as the
 *  adapter map KEY (`VertexProviderAdapter` does an EXACT match against
 *  `config.model`). Returns `undefined` when no such var is set, so the adapter
 *  sees no map at all (byte-identical single-region path). Reads ONLY the
 *  injected `env` (never `process.env`). */
const resolveVertexRegionMap = (env: EnvLike): Readonly<Record<string, string>> | undefined => {
  const PREFIX = "VERTEX_REGION_"
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(PREFIX)) continue
    if (value === undefined || value.length === 0) continue
    // Env names cannot contain `-`; operators spell the slug with `_`. Render
    // it back to the dashed-lowercase wire slug the adapter matches on.
    const slug = key.slice(PREFIX.length).toLowerCase().replaceAll("_", "-")
    if (slug.length === 0) continue
    out[slug] = value
  }
  return Object.keys(out).length > 0 ? Object.freeze(out) : undefined
}
