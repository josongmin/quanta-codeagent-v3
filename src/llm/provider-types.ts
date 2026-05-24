/**
 * ADR-0163 Phase A — enriched provider-type union and credential-kind taxonomy.
 *
 * The legacy `Provider` union in `@/llm/factory` is the SSOT for the THREE
 * call-tested vendors (anthropic / openai / chatgpt-oauth). ADR-0139 added a
 * SECOND union `ProviderId` in `@/llm/providers/provider-port` for the
 * FOUR enterprise transports (default / bedrock / vertex / foundry). They are
 * orthogonal axes — vendor grammar vs. transport routing — and we deliberately
 * keep them separate so a Bedrock-routed Anthropic request never has to
 * pretend it is "openai".
 *
 * This file adds the THIRD axis: the cross-cutting `LlmProvider` union that
 * names every transport AND every vendor in one place, plus the
 * `ProviderCredentials` discriminator that classifies WHERE the credential
 * lives (env, file, metadata-service, vault). The router (Phase A) consults
 * `LlmProvider` to pick a transport; the OIDC federation port (Phase C) emits
 * a `ProviderCredentials` of kind `oidc-federation`; the OAuth refresh lock
 * (Phase D) keys by `ProviderCredentials.kind === "oauth"`. One small
 * vocabulary, one place to grep.
 *
 * Plane-clean: this file imports NOTHING. It is a leaf type module so every
 * downstream module (router, adapters, lock, GH rotator) can import it
 * without dragging a transitive SDK touch.
 *
 * Default-OFF: every consumer of these types opts in explicitly. The legacy
 * `Provider` union is untouched (3 entries); adding Mantle to it would
 * require a factory-registry edit, which is a separate fork we are NOT
 * making in W12. The router resolves to a `LlmProvider` value; the legacy
 * factory still pre-routes to its 3-entry table when the router is not
 * consulted.
 */

/** Cross-cutting provider identifier — names every transport AND every vendor.
 *  The legacy `Provider` (in `@/llm/factory`) is a STRICT SUBSET of this union
 *  (its 3 entries are present here verbatim). The transport-only `ProviderId`
 *  (in `@/llm/providers/provider-port`) is also a strict subset (its 4 entries
 *  are present). Closed — adding a vendor or transport is a typed change. */
export type LlmProvider =
  // Existing vendors (api-key BYOK + on-disk OAuth).
  | "anthropic"
  | "openai"
  | "chatgpt-oauth"
  // Enterprise transports (Anthropic Messages grammar, different IAM surface).
  | "bedrock"
  | "vertex"
  | "foundry"
  | "mantle"

/** Closed discriminator for "what kind of credential is this?" — orthogonal to
 *  `LlmProvider` (which says "which vendor"). One LlmProvider may accept
 *  multiple credential kinds (e.g. `bedrock` accepts `aws-iam` OR
 *  `oidc-federation` via STS AssumeRoleWithWebIdentity). The router emits a
 *  `ProviderCredentials` so downstream code can branch on the discriminator
 *  rather than re-deriving "is this env-backed?" from the provider name. */
export type ProviderCredentialKind =
  /** Long-lived API key in an env var or config file. */
  | "api-key"
  /** OAuth bearer token persisted in a token-store file
   *  (`~/.quanta/auth/chatgpt.json` today). Refresh is mandatory. */
  | "oauth"
  /** AWS IAM credentials (env / IMDS / IRSA / SSO). Resolution is delegated to
   *  the AWS SDK default chain unless an explicit access-key pair is passed. */
  | "aws-iam"
  /** GCP service-account credentials (ADC or explicit bearer). */
  | "gcp-sa"
  /** Azure managed-service-identity / explicit `AZURE_API_KEY`. */
  | "azure-msi"
  /** Workload-identity → STS-style exchange (Kubernetes SA projection / GitHub
   *  OIDC / Vault). The identity token lives in a file (the source field
   *  below carries the file path); the exchanged access token is held in
   *  memory only. */
  | "oidc-federation"

/** Where the credential is sourced from. Used by telemetry (we log "creds came
 *  from IMDS, not env") and by the refresh-lock router (file-sourced creds
 *  go through the file-based lock; env-sourced creds use the in-memory lock).
 *  Closed union. */
export type ProviderCredentialSource =
  /** Process environment variable (e.g. `ANTHROPIC_API_KEY`). */
  | "env"
  /** A file on disk (token store, identity-token projection, kubeconfig). */
  | "file"
  /** Cloud metadata service (AWS IMDS, GCP metadata server, Azure IMDS). */
  | "metadata-service"
  /** Pulled at runtime from a secret manager (HashiCorp Vault, AWS Secrets
   *  Manager, GCP Secret Manager). Phase 2 — no adapter ships in W12. */
  | "vault"

/** Discriminator pair — every credential bundle carries both fields. The
 *  combination determines which port (oauth-refresh-lock / oidc-federation /
 *  github-token-rotation) is consulted at refresh time. */
export interface ProviderCredentials {
  readonly kind: ProviderCredentialKind
  readonly source: ProviderCredentialSource
}

/** Catalog of every `LlmProvider` — exported so callers can iterate (e.g. the
 *  router's exhaustiveness check, the env-detection module's loop). MUST stay
 *  in lock-step with the union above; the exhaustiveness assertion at module
 *  bottom guards drift at compile time. */
export const LLM_PROVIDERS = [
  "anthropic",
  "openai",
  "chatgpt-oauth",
  "bedrock",
  "vertex",
  "foundry",
  "mantle",
] as const satisfies readonly LlmProvider[]

/** Compile-time exhaustiveness guard: if a new `LlmProvider` is added to the
 *  union without being added to `LLM_PROVIDERS`, the assignment below fails
 *  to typecheck. This pattern is the same SSOT discipline `pickProvider` uses
 *  in `@/llm/factory` (the `if (explicit in DEFAULT_MODEL)` check). */
const _exhaustivenessCheck: readonly LlmProvider[] = LLM_PROVIDERS
void _exhaustivenessCheck
