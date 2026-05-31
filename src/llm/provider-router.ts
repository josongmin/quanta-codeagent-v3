/**
 * ADR-0163 Phase A — provider router with CLAUDE_CODE_USE_* env mirror.
 *
 * Claude CLI standardized on a quartet of boolean env switches:
 *   CLAUDE_CODE_USE_BEDROCK  / _VERTEX / _FOUNDRY / _MANTLE
 *
 * Operators set ONE of these to a truthy value ("1" / "true") to route every
 * downstream LLM call through the corresponding cloud transport. quanta's
 * pre-W12 router (`@/llm/providers/registry.ts`) consults a DIFFERENT triad
 * (`ANTHROPIC_*_BASE_URL`), which works but does not mirror the community
 * convention the user community internalized via Claude CLI.
 *
 * This router accepts BOTH conventions and resolves precedence
 * deterministically:
 *
 *   1. Explicit caller argument (highest — same discipline as ADR-0139).
 *   2. `CLAUDE_CODE_USE_*` truthy (claude-cli convention).
 *   3. `ANTHROPIC_*_BASE_URL` non-empty (ADR-0139 convention).
 *   4. `chatgpt-oauth` token on disk (subscription provider — ADR-0094).
 *   5. `ANTHROPIC_API_KEY` env (BYOK Anthropic).
 *   6. `OPENAI_API_KEY` env (BYOK OpenAI).
 *   7. Default — `anthropic` (matches `pickProvider` final fallback).
 *
 * Conflict policy: if TWO `CLAUDE_CODE_USE_*` keys are truthy at the same
 * time, we throw a typed `provider-conflict` error rather than silently
 * picking one. Cloud transports are mutually exclusive — silently choosing
 * "bedrock because alphabetical" hides operator misconfiguration that
 * almost always produces a $-bill surprise (one team's BEDROCK env leaked
 * into another team's VERTEX prod).
 *
 * Plane-clean: imports `provider-types` (leaf) and re-exports `ProviderId`
 * from the existing port for back-compat. NO SDK touches.
 */

import { isTruthyEnv, providerCredentials } from "./provider-metadata"
import type {
  LlmProvider,
  ProviderCredentialKind,
  ProviderCredentialSource,
} from "./provider-types"
import { LLM_PROVIDERS } from "./provider-types"

/** Read-only env shape — caller passes it in so the router never reaches
 *  for `process.env` (same SSOT discipline as `@/llm/factory.EnvLike`). */
export type RouterEnv = Record<string, string | undefined>

/** Resolution result. `provider` is the selected `LlmProvider`. `credentials`
 *  classifies the discovered credential (kind + source) so downstream code
 *  can route to the right refresh path (OIDC vs OAuth vs IAM). `reason`
 *  is a short, machine-stable code naming the precedence layer that fired —
 *  used by tests, by `quanta status`, and by telemetry. */
export interface RouterResolution {
  readonly provider: LlmProvider
  readonly credentials: {
    readonly kind: ProviderCredentialKind
    readonly source: ProviderCredentialSource
  }
  readonly reason: RouterReason
}

/** Closed reason union. Names mirror the precedence-ladder layers verbatim so
 *  a telemetry consumer can group runs by router decision. */
export type RouterReason =
  | "explicit"
  | "claude-code-use-env"
  | "anthropic-base-url-env"
  | "chatgpt-oauth-token-on-disk"
  | "anthropic-api-key-env"
  | "openai-api-key-env"
  | "default-fallback"

/** Claude-CLI convention env keys — exported so callers can surface canonical
 *  names in `--help` output without re-typing them. */
export const CLAUDE_USE_ENV_KEYS = {
  bedrock: "CLAUDE_CODE_USE_BEDROCK",
  vertex: "CLAUDE_CODE_USE_VERTEX",
  foundry: "CLAUDE_CODE_USE_FOUNDRY",
  mantle: "CLAUDE_CODE_USE_MANTLE",
} as const

/** ADR-0139 convention env keys — kept for back-compat. */
export const ANTHROPIC_BASE_URL_ENV_KEYS = {
  bedrock: "ANTHROPIC_BEDROCK_BASE_URL",
  vertex: "ANTHROPIC_VERTEX_BASE_URL",
  foundry: "ANTHROPIC_FOUNDRY_BASE_URL",
  // Mantle has no `ANTHROPIC_MANTLE_BASE_URL` mirror — Anthropic ships it
  // through `CLAUDE_CODE_USE_MANTLE` only as of 2026-05-24.
} as const

/** Strict truthy check for boolean env vars — delegates to the canonical
 *  {@link isTruthyEnv} authority (audit L6 M11). The grammar (`"1"`/`"true"`/
 *  `"yes"`, trimmed + lowercased, everything else rejected) lives in ONE place
 *  so the router and the foundry registry can never diverge. */
const isTruthy = isTruthyEnv

/** Thrown when two or more `CLAUDE_CODE_USE_*` keys are simultaneously truthy.
 *  Cloud transports are mutually exclusive; silently picking one would hide
 *  operator misconfig. Typed as a class (not a string) so callers branch on
 *  `instanceof`, not message-match. */
export class ProviderConflictError extends Error {
  readonly providers: readonly LlmProvider[]
  constructor(providers: readonly LlmProvider[]) {
    super(
      `provider-conflict: multiple cloud transports requested simultaneously: ${providers.join(", ")} ` +
        "(set exactly one of CLAUDE_CODE_USE_BEDROCK / VERTEX / FOUNDRY / MANTLE)",
    )
    this.name = "ProviderConflictError"
    this.providers = providers
  }
}

/** Inputs to {@link resolveProviderWithRouter}. */
export interface RouterInput {
  /** Explicit caller-supplied provider — wins over everything. Pass undefined
   *  to fall through to env detection. Empty string treated as "not supplied"
   *  to match CLI flag-parse output. */
  readonly explicit?: string
  /** Env source — required (SSOT: no `process.env` reaches inside the router). */
  readonly env: RouterEnv
  /** Cheap on-disk probe for the ChatGPT-OAuth token bundle. Port-injected
   *  so tests do not touch the filesystem. Mirrors `hasChatgptOAuthToken`
   *  in `@/llm/factory`. */
  readonly hasChatgptOAuthToken?: (env: RouterEnv) => boolean
}

/** Detect the active `CLAUDE_CODE_USE_*` provider (if any). Returns at most
 *  one — if multiple are truthy, throws {@link ProviderConflictError}. */
const detectClaudeUseEnv = (env: RouterEnv): LlmProvider | undefined => {
  const active: LlmProvider[] = []
  if (isTruthy(env[CLAUDE_USE_ENV_KEYS.bedrock])) active.push("bedrock")
  if (isTruthy(env[CLAUDE_USE_ENV_KEYS.vertex])) active.push("vertex")
  if (isTruthy(env[CLAUDE_USE_ENV_KEYS.foundry])) active.push("foundry")
  if (isTruthy(env[CLAUDE_USE_ENV_KEYS.mantle])) active.push("mantle")
  if (active.length === 0) return undefined
  if (active.length > 1) throw new ProviderConflictError(active)
  return active[0]
}

/** Detect the active `ANTHROPIC_*_BASE_URL` provider (if any). Same closed
 *  triad as ADR-0139's registry — kept here for the router so callers do not
 *  have to consult two modules. Mantle is NOT in this triad (see comment on
 *  ANTHROPIC_BASE_URL_ENV_KEYS). */
const detectAnthropicBaseUrlEnv = (env: RouterEnv): LlmProvider | undefined => {
  const bedrockUrl = env[ANTHROPIC_BASE_URL_ENV_KEYS.bedrock]
  if (bedrockUrl !== undefined && bedrockUrl.length > 0) return "bedrock"
  const vertexUrl = env[ANTHROPIC_BASE_URL_ENV_KEYS.vertex]
  if (vertexUrl !== undefined && vertexUrl.length > 0) return "vertex"
  const foundryUrl = env[ANTHROPIC_BASE_URL_ENV_KEYS.foundry]
  if (foundryUrl !== undefined && foundryUrl.length > 0) return "foundry"
  return undefined
}

/** Credential {kind, source} for a resolved provider. Delegates to the
 *  canonical {@link providerCredentials} authority (audit L6 M1). The OLD
 *  inline `switch` had a `default` arm that returned `{api-key, env}` for ANY
 *  provider it didn't name — so an EXPLICIT `chatgpt-oauth` selection (Layer 1)
 *  got the WRONG `{api-key, env}` pair instead of `{oauth, file}`, mis-routing
 *  the on-disk bundle down the env-key refresh path. The authority's lookup is
 *  total over the closed union, so that fall-through is structurally gone. */
const cloudCreds = (
  provider: LlmProvider,
): {
  kind: ProviderCredentialKind
  source: ProviderCredentialSource
} => providerCredentials(provider)

/**
 * Resolve the active provider through the seven-layer precedence ladder
 * documented in the file header. Pure function — no I/O except the
 * caller-supplied `hasChatgptOAuthToken` probe (which is itself port-injected).
 *
 * Throws {@link ProviderConflictError} on simultaneous `CLAUDE_CODE_USE_*`
 * keys. Returns `RouterResolution` for every other input — unknown explicit
 * ids fall through to env (matching `pickProvider`'s "validity check uses
 * DEFAULT_MODEL keys" discipline), with the ladder selecting the next layer.
 */
export const resolveProviderWithRouter = (input: RouterInput): RouterResolution => {
  // Layer 1 — explicit caller wins. Validity check is "is this a known
  // LlmProvider?" (LLM_PROVIDERS list). Unknown ⇒ falls through (NOT throws,
  // matching `pickProvider`'s permissive contract).
  if (input.explicit !== undefined && input.explicit.length > 0) {
    const trimmed = input.explicit.trim()
    if ((LLM_PROVIDERS as readonly string[]).includes(trimmed)) {
      const provider = trimmed as LlmProvider
      return { provider, credentials: cloudCreds(provider), reason: "explicit" }
    }
    // Fall through to env — same as `pickProvider`.
  }

  // Layer 2 — CLAUDE_CODE_USE_* (claude-cli convention). May throw on conflict.
  const claudeUse = detectClaudeUseEnv(input.env)
  if (claudeUse !== undefined) {
    return {
      provider: claudeUse,
      credentials: cloudCreds(claudeUse),
      reason: "claude-code-use-env",
    }
  }

  // Layer 3 — ANTHROPIC_*_BASE_URL (ADR-0139 convention).
  const baseUrl = detectAnthropicBaseUrlEnv(input.env)
  if (baseUrl !== undefined) {
    return { provider: baseUrl, credentials: cloudCreds(baseUrl), reason: "anthropic-base-url-env" }
  }

  // Layer 4 — chatgpt-oauth token on disk.
  if (input.hasChatgptOAuthToken?.(input.env)) {
    return {
      provider: "chatgpt-oauth",
      credentials: { kind: "oauth", source: "file" },
      reason: "chatgpt-oauth-token-on-disk",
    }
  }

  // Layer 5 — ANTHROPIC_API_KEY env.
  if (input.env.ANTHROPIC_API_KEY !== undefined && input.env.ANTHROPIC_API_KEY.length > 0) {
    return {
      provider: "anthropic",
      credentials: { kind: "api-key", source: "env" },
      reason: "anthropic-api-key-env",
    }
  }

  // Layer 6 — OPENAI_API_KEY env.
  if (input.env.OPENAI_API_KEY !== undefined && input.env.OPENAI_API_KEY.length > 0) {
    return {
      provider: "openai",
      credentials: { kind: "api-key", source: "env" },
      reason: "openai-api-key-env",
    }
  }

  // Layer 7 — default fallback (matches `pickProvider`).
  return {
    provider: "anthropic",
    credentials: { kind: "api-key", source: "env" },
    reason: "default-fallback",
  }
}
