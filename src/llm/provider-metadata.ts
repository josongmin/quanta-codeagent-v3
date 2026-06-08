/**
 * ── Canonical provider-metadata authority (T07 — May-31 bugbash) ─────────────
 *
 * THE single exported owner of "what credential does this provider use" and
 * "is this boolean env switch truthy". Before this module the same two truth
 * tables were copy-pasted across the routing surfaces:
 *   - `cloudCreds()` (provider → {kind, source}) lived inline in
 *     `provider-router.ts`, and its `chatgpt-oauth` arm silently fell into the
 *     `default` case → it returned `{kind:"api-key", source:"env"}` for an
 *     explicit `chatgpt-oauth` selection even though Layer-4 detection correctly
 *     classifies it `{kind:"oauth", source:"file"}` (audit L6 M1 — a routing
 *     bug that sent the on-disk OAuth bundle down the env-API-key refresh path).
 *   - the truthy-env predicate (`"1" / "true" / "yes"`) was duplicated verbatim
 *     in `provider-router.ts` (`isTruthy`) and `providers/registry.ts`
 *     (`isFoundryUseTruthy`); a divergence between the two silently changes
 *     which provider a `CLAUDE_CODE_USE_*` env routes to (audit L6 M11).
 *
 * This module is the SSOT both surfaces consume. T13 deletes the duplicate
 * bodies and re-points imports here — DO NOT re-fork these tables.
 *
 * Plane-clean leaf: imports ONLY the `provider-types` leaf (closed unions). No
 * SDK touch, no I/O, no globals — every consumer (router, factory, registry,
 * adapters) can import it without dragging a transitive dependency.
 * ───────────────────────────────────────────────────────────────────────────
 */

import type {
  LlmProvider,
  ProviderCredentialKind,
  ProviderCredentialSource,
  ProviderCredentials,
} from "./provider-types"

/**
 * Canonical credential classification for EVERY {@link LlmProvider}. Closed
 * `Record` (not a `switch` with a `default` arm) so adding a provider to the
 * union is a compile error here until its credential pair is declared — the
 * exact drift that let `chatgpt-oauth` fall through to the api-key default
 * (audit L6 M1) cannot recur.
 *
 * `chatgpt-oauth` is `{kind:"oauth", source:"file"}` — the bundle lives on disk
 * (`~/.quanta/auth/chatgpt.json`) and is refreshed, NOT an env API key. The
 * cloud transports map to their native IAM surfaces; `mantle` is modelled as
 * env-api-key until its real spec lands (Phase 2). BYOK vendors are env keys.
 */
export const PROVIDER_CREDENTIALS: Record<LlmProvider, ProviderCredentials> = {
  anthropic: { kind: "api-key", source: "env" },
  openai: { kind: "api-key", source: "env" },
  "chatgpt-oauth": { kind: "oauth", source: "file" },
  bedrock: { kind: "aws-iam", source: "env" },
  vertex: { kind: "gcp-sa", source: "env" },
  foundry: { kind: "azure-msi", source: "env" },
  // Mantle uses Anthropic's internal token bridge — modelled as api-key-from-env
  // until the real spec lands (Phase 2).
  mantle: { kind: "api-key", source: "env" },
}

/**
 * The canonical credential {kind, source} for a provider. Single authority —
 * the router's old inline `cloudCreds` returned the WRONG pair for
 * `chatgpt-oauth` because it lived behind a `default` arm; this lookup is total
 * over the closed union so that class of bug is structurally impossible.
 */
export const providerCredentials = (provider: LlmProvider): ProviderCredentials =>
  PROVIDER_CREDENTIALS[provider]

/** Convenience splits for call sites that want only one axis. */
export const providerCredentialKind = (provider: LlmProvider): ProviderCredentialKind =>
  PROVIDER_CREDENTIALS[provider].kind
export const providerCredentialSource = (provider: LlmProvider): ProviderCredentialSource =>
  PROVIDER_CREDENTIALS[provider].source

// ── D4 (jun-7 naive-impl hardening) — model→context-window SSOT ──────────────
//
// The compaction threshold used to be a single model-blind `120_000` constant
// (`@/agent/compaction.DEFAULT_THRESHOLD`) and the usage snapshot hardcoded
// `max:0` ("unknown window"). On a 1M-window model that compacts at 12% of the
// window; on a 32k model it never triggers and the provider rejects first. This
// table is the SSOT the compaction threshold + the status-line denominator
// derive from.
//
// Plane-clean: still imports ONLY `provider-types`. Values are from PUBLIC
// model specs (dated below). UNKNOWN model id ⇒ `resolveModelWindow` returns
// `undefined` and every caller falls back to the legacy `120_000` path
// (signal-presence gates — no global knob), so an un-tabled model is
// byte-identical to the pre-D4 behavior.

/**
 * Context-window facts for a single model id, in TOKENS.
 *  - `contextWindow` — total input+output budget the provider accepts.
 *  - `maxOutput`     — the max tokens the model can GENERATE in one response;
 *                      we reserve this from the window when deriving the
 *                      compaction threshold (so a compaction never leaves too
 *                      little room for the model to finish its reply).
 */
export interface ModelWindow {
  readonly contextWindow: number
  readonly maxOutput: number
}

/**
 * Model id → {@link ModelWindow}. Keyed by the EXACT provider model slug the
 * repo sends (`DEFAULT_MODEL` in `@/llm/factory` + the model-swap / role-
 * override candidates). An un-listed model degrades safely (legacy 120k) — see
 * {@link resolveModelWindow}. Closed-ish: adding a new default model SHOULD add
 * its window here, but a miss is non-fatal.
 *
 * Sources (PUBLIC specs, retrieved 2026-06-07):
 *   - Anthropic Claude models reference (docs.anthropic.com/en/docs/about-
 *     claude/models): Claude 3/3.5/3.7/4 family = 200_000 token context.
 *     Sonnet 4 supports a 1M-token beta context (`context-1m-2025-08-07`).
 *     Max output: Opus 4 = 32_000; Sonnet 4 = 64_000; Haiku 3.5 = 8_192.
 *   - OpenAI models reference (platform.openai.com/docs/models): GPT-5 family
 *     = 400_000 context / 128_000 max output; GPT-4o = 128_000 / 16_384;
 *     o-series reasoning (o1/o3) = 200_000 / 100_000.
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, ModelWindow> = {
  // ── Anthropic (200k window family) ──
  "claude-opus-4-6": { contextWindow: 200_000, maxOutput: 32_000 },
  "claude-opus-4-8": { contextWindow: 200_000, maxOutput: 32_000 },
  "claude-opus-4": { contextWindow: 200_000, maxOutput: 32_000 },
  "claude-sonnet-4-6": { contextWindow: 200_000, maxOutput: 64_000 },
  "claude-sonnet-4-5": { contextWindow: 200_000, maxOutput: 64_000 },
  "claude-sonnet-4": { contextWindow: 200_000, maxOutput: 64_000 },
  "claude-3-7-sonnet": { contextWindow: 200_000, maxOutput: 64_000 },
  "claude-3-5-sonnet": { contextWindow: 200_000, maxOutput: 8_192 },
  "claude-3-5-haiku": { contextWindow: 200_000, maxOutput: 8_192 },
  "claude-haiku-4-5": { contextWindow: 200_000, maxOutput: 8_192 },
  // ── Anthropic 1M-token beta context (Sonnet) ──
  "claude-sonnet-4-6-1m": { contextWindow: 1_000_000, maxOutput: 64_000 },
  "claude-sonnet-4-5-1m": { contextWindow: 1_000_000, maxOutput: 64_000 },
  // ── OpenAI GPT-5 family (400k window) ──
  "gpt-5": { contextWindow: 400_000, maxOutput: 128_000 },
  "gpt-5-mini": { contextWindow: 400_000, maxOutput: 128_000 },
  "gpt-5-nano": { contextWindow: 400_000, maxOutput: 128_000 },
  "gpt-5-pro": { contextWindow: 400_000, maxOutput: 128_000 },
  "gpt-5-codex": { contextWindow: 400_000, maxOutput: 128_000 },
  // ── OpenAI GPT-4o (128k window) ──
  "gpt-4o": { contextWindow: 128_000, maxOutput: 16_384 },
  "gpt-4o-mini": { contextWindow: 128_000, maxOutput: 16_384 },
  // ── OpenAI o-series reasoning (200k window) ──
  o1: { contextWindow: 200_000, maxOutput: 100_000 },
  "o3-mini": { contextWindow: 200_000, maxOutput: 100_000 },
}

/**
 * Provider-FAMILY fallback windows, keyed by a substring of the model id. Used
 * by {@link resolveModelWindow} when the exact id is not in
 * {@link MODEL_CONTEXT_WINDOWS} (e.g. a dated `-20250514` suffix or a future
 * point release). CONSERVATIVE: the smallest reasonable window + output for the
 * family, so a fallback never OVER-estimates the budget (which would push
 * compaction too late). Order matters — first match wins, so the longest /
 * most-specific prefixes are listed first.
 */
const MODEL_FAMILY_FALLBACKS: ReadonlyArray<readonly [string, ModelWindow]> = [
  ["claude-opus", { contextWindow: 200_000, maxOutput: 32_000 }],
  ["claude-sonnet", { contextWindow: 200_000, maxOutput: 64_000 }],
  ["claude-haiku", { contextWindow: 200_000, maxOutput: 8_192 }],
  // 3.7 Sonnet has a 64k output budget (unlike 3.5 Sonnet's 8192). Its DATED /
  // `-latest` slugs (`claude-3-7-sonnet-20250219`) miss the `claude-sonnet`
  // needle (`3-7` infix) and would otherwise fall through to the broader
  // `claude-3` entry below (8192), compacting ~56k tokens too LATE. This entry
  // MUST precede `claude-3` so the dated 3.7-Sonnet slugs route correctly.
  ["claude-3-7-sonnet", { contextWindow: 200_000, maxOutput: 64_000 }],
  ["claude-3", { contextWindow: 200_000, maxOutput: 8_192 }],
  ["claude", { contextWindow: 200_000, maxOutput: 8_192 }],
  ["gpt-5", { contextWindow: 400_000, maxOutput: 128_000 }],
  ["gpt-4o", { contextWindow: 128_000, maxOutput: 16_384 }],
]

/**
 * Resolve a model id to its {@link ModelWindow}. Precedence:
 *   1. EXACT id in {@link MODEL_CONTEXT_WINDOWS};
 *   2. provider-FAMILY fallback (substring match in {@link MODEL_FAMILY_FALLBACKS})
 *      — handles dated/suffixed slugs (`claude-opus-4-8-20260101`) and future
 *      point releases without a table edit;
 *   3. `undefined` — an unknown provider/model; the caller falls back to the
 *      legacy 120k threshold (byte-identical pre-D4 path).
 *
 * Pure leaf — no I/O, no globals. The empty string / `"unknown"` sentinel the
 * loop uses for a test double returns `undefined` (no family match).
 */
export const resolveModelWindow = (model: string): ModelWindow | undefined => {
  if (model === "") return undefined
  const exact = MODEL_CONTEXT_WINDOWS[model]
  if (exact !== undefined) return exact
  for (const [needle, window] of MODEL_FAMILY_FALLBACKS) {
    if (model.includes(needle)) return window
  }
  return undefined
}

// ── Ticket 14 (§11.6) — per-model reasoning-effort support SSOT ──────────────
//
// The model↔effort coupling gap (Codex `validateEffort`, plan §14 [CORE]): our
// `/model` and `/effort` slashes are independent, so a user can pick a non-
// reasoning model (e.g. `gpt-4o`) while a high reasoning-effort tier is still
// pinned — an incoherent setting the provider silently ignores. This table is
// the SSOT the `/model` picker consults to CLAMP the effort tier into the
// picked model's supported set (see `clampEffortForModel` in
// `apps/cli/slash/model-picker.ts`).
//
// Plane-clean leaf: this module imports ONLY `provider-types` and must NOT
// import `@/agent` (which would create an `@/agent → @/llm → @/agent` cycle —
// `@/agent` already imports `@/llm`). The canonical effort vocabulary is
// `@/agent`'s `EffortLevel`; we mirror it here as a LOCAL structural union with
// a compile-time drift guard against the slug list, so adding a tier to one
// without the other is a build error in the picker (where both unify).

/**
 * The reasoning-effort tiers a model may support. Structural mirror of
 * `@/agent`'s `EffortLevel` (kept local to preserve this leaf's no-cross-slice
 * invariant). The picker (`model-picker.ts`) imports the canonical `EffortLevel`
 * and assigns these values to it, which is the unification point where any drift
 * surfaces as a type error.
 */
export type ReasoningEffort = "default" | "low" | "medium" | "high" | "max"

/** All five tiers, for the "reasoning model supports everything" default. */
export const ALL_REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "default",
  "low",
  "medium",
  "high",
  "max",
]

/**
 * Reasoning-effort metadata for a single model id.
 *  - `supportedEfforts` — the tiers the model accepts. A non-reasoning model
 *    supports ONLY `"default"` (no thinking budget); a reasoning model supports
 *    all five. The `/model` picker clamps the session effort INTO this set.
 *  - `defaultEffort`   — the tier to clamp to when the current effort is not in
 *    `supportedEfforts`. MUST be a member of `supportedEfforts`.
 *  - `reasoning`       — convenience flag: does the model do extended reasoning
 *    at all (used for the capability hint in `formatModelLine`).
 */
export interface ModelEffortSupport {
  readonly supportedEfforts: readonly ReasoningEffort[]
  readonly defaultEffort: ReasoningEffort
  readonly reasoning: boolean
}

/** Reasoning models accept every tier; their natural default is the provider
 *  default (no forced budget). */
const REASONING_ALL: ModelEffortSupport = {
  supportedEfforts: ALL_REASONING_EFFORTS,
  defaultEffort: "default",
  reasoning: true,
}

/** Non-reasoning models (no extended thinking) accept ONLY `"default"`; any
 *  higher tier is meaningless and gets clamped back to `"default"`. */
const NON_REASONING: ModelEffortSupport = {
  supportedEfforts: ["default"],
  defaultEffort: "default",
  reasoning: false,
}

/**
 * Model id → {@link ModelEffortSupport}. Keyed by the EXACT slug, parallel to
 * {@link MODEL_CONTEXT_WINDOWS}. An un-tabled model resolves to `undefined`
 * (see {@link resolveModelEffortSupport}) which the picker treats as the
 * CONSERVATIVE "all supported — never clamp, never invent a mismatch" fallback
 * (plan §14 risk note). Reasoning families: Anthropic Claude (extended
 * thinking), OpenAI GPT-5 + o-series. Non-reasoning: GPT-4o family + Claude 3.5
 * Haiku (no extended-thinking budget).
 */
export const MODEL_EFFORT_SUPPORT: Record<string, ModelEffortSupport> = {
  // ── Anthropic (extended thinking ⇒ reasoning) ──
  "claude-opus-4-6": REASONING_ALL,
  "claude-opus-4-8": REASONING_ALL,
  "claude-opus-4": REASONING_ALL,
  "claude-sonnet-4-6": REASONING_ALL,
  "claude-sonnet-4-5": REASONING_ALL,
  "claude-sonnet-4": REASONING_ALL,
  "claude-3-7-sonnet": REASONING_ALL,
  "claude-haiku-4-5": REASONING_ALL,
  "claude-sonnet-4-6-1m": REASONING_ALL,
  "claude-sonnet-4-5-1m": REASONING_ALL,
  // Claude 3.5 family — no extended-thinking budget ⇒ non-reasoning.
  "claude-3-5-sonnet": NON_REASONING,
  "claude-3-5-haiku": NON_REASONING,
  // ── OpenAI GPT-5 family (reasoning) ──
  "gpt-5": REASONING_ALL,
  "gpt-5-mini": REASONING_ALL,
  "gpt-5-nano": REASONING_ALL,
  "gpt-5-pro": REASONING_ALL,
  "gpt-5-codex": REASONING_ALL,
  // ── OpenAI o-series reasoning ──
  o1: REASONING_ALL,
  "o3-mini": REASONING_ALL,
  // ── OpenAI GPT-4o (chat, no reasoning effort) ──
  "gpt-4o": NON_REASONING,
  "gpt-4o-mini": NON_REASONING,
}

/**
 * Provider-FAMILY fallback for effort support, keyed by a substring of the
 * model id — parallel to {@link MODEL_FAMILY_FALLBACKS}. Handles dated/suffixed
 * slugs (`gpt-5-2026…`, `claude-opus-4-8-20260101`) without a table edit. Order
 * matters (first match wins); the non-reasoning needles (`gpt-4o`, `3-5`) are
 * listed BEFORE the broad reasoning families so a `claude-3-5-haiku-2024…` slug
 * does not get mis-classified reasoning by the broad `claude` needle.
 */
const MODEL_EFFORT_FAMILY_FALLBACKS: ReadonlyArray<readonly [string, ModelEffortSupport]> = [
  ["gpt-4o", NON_REASONING],
  ["claude-3-5", NON_REASONING],
  ["gpt-5", REASONING_ALL],
  ["o1", REASONING_ALL],
  ["o3", REASONING_ALL],
  ["claude-3-7", REASONING_ALL],
  ["claude-opus", REASONING_ALL],
  ["claude-sonnet", REASONING_ALL],
  ["claude-haiku", REASONING_ALL],
]

/**
 * Resolve a model id to its {@link ModelEffortSupport}. Precedence mirrors
 * {@link resolveModelWindow}:
 *   1. EXACT id in {@link MODEL_EFFORT_SUPPORT};
 *   2. provider-FAMILY fallback (substring match);
 *   3. `undefined` — UNKNOWN model. The picker treats `undefined` as the
 *      conservative "all efforts supported, never clamp" case so an un-tabled
 *      model NEVER invents a spurious mismatch (plan §14 risk note).
 *
 * Pure leaf — no I/O, no globals. Empty string ⇒ `undefined` (no family match).
 */
export const resolveModelEffortSupport = (model: string): ModelEffortSupport | undefined => {
  if (model === "") return undefined
  const exact = MODEL_EFFORT_SUPPORT[model]
  if (exact !== undefined) return exact
  for (const [needle, support] of MODEL_EFFORT_FAMILY_FALLBACKS) {
    if (model.includes(needle)) return support
  }
  return undefined
}

/** The closed set of spellings we accept as a truthy boolean env value. We
 *  accept the four the user community uses and reject everything else —
 *  including the empty string, `"0"`, `"false"`, and arbitrary numbers (`"2"`
 *  is NOT truthy; an operator who typos their env file should hear about it,
 *  not get a silent route). */
export const TRUTHY_ENV_VALUES: ReadonlySet<string> = new Set(["1", "true", "yes"])

/**
 * Strict truthy check for boolean env vars. THE single grammar consulted by the
 * provider router AND the foundry registry (audit L6 M11) — a divergence
 * between two copies silently changes provider routing for `"yes"` etc.
 * Trimmed + lowercased before the set lookup.
 */
export const isTruthyEnv = (value: string | undefined): boolean => {
  if (value === undefined) return false
  return TRUTHY_ENV_VALUES.has(value.trim().toLowerCase())
}
