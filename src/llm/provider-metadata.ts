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
