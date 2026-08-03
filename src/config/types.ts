/**
 * Typed `Settings` schema for the central on-disk config loader (ADR-0497,
 * jun-7-misc 05).
 *
 * The schema is deliberately SMALL and EXPLICIT (NOT free-form). The whole
 * point of the trust gate (§4.c) is to discriminate **security-load-bearing**
 * keys (capability-granting: permission `allow`/`ask`, command hooks, MCP
 * server launchers, tool grants) from **benign** keys (formatting / display
 * prefs that grant no capability). So the two bands are DISTINCT fields:
 *
 *   - {@link LayerSecurity} — gated on project trust for repo-local layers.
 *   - {@link LayerBenign}   — never carries capability; not (currently) gated.
 *
 * `deny`-direction keys (permission `deny`, sandbox-narrowing) live in
 * {@link LayerSecurity} but are TIGHTENING-only and so are applied even from
 * an untrusted repo (§4.c asymmetry) — the merge layer decides that, not the
 * schema.
 *
 * Mirrors the Claude Code `settings.json` shape we already validate against
 * (jun-7-draft-ide-integration-spec-claude.md:577-594) and the migration
 * translator already reads (src/migration/translators/claude-code-config.ts).
 */

/** A discovery layer, high→low precedence: managed > user > project > local. */
export type SettingsLayerName = "managed" | "user" | "project" | "local"

/** All four layers in canonical high→low precedence order. */
export const LAYER_PRECEDENCE: readonly SettingsLayerName[] = [
  "managed",
  "user",
  "project",
  "local",
] as const

/** Machine-owned layers — NOT attacker-shippable in a cloned repo. These are
 *  always honored regardless of project trust. */
export const MACHINE_OWNED_LAYERS: readonly SettingsLayerName[] = ["managed", "user"] as const

/** Repo-controllable layers — an attacker can ship these in a cloned repo, so
 *  their capability-granting (loosening) keys require explicit project trust. */
export const REPO_LAYERS: readonly SettingsLayerName[] = ["project", "local"] as const

/** Permission rule lists — the capability surface. `allow`/`ask` are
 *  LOOSENING (trust-gated for repo layers); `deny` is TIGHTENING (always
 *  applied). */
export interface PermissionSettings {
  /** Capability-WIDENING grants — trust-gated for repo layers. */
  readonly allow?: readonly string[]
  /** Always-deny rules — TIGHTENING; applied even from untrusted repos. */
  readonly deny?: readonly string[]
  /** Ask-rules — capability-relevant (auto-prompt overlay), trust-gated. */
  readonly ask?: readonly string[]
  /** Claude `allowManagedPermissionRulesOnly` — when set in the MANAGED layer,
   *  ONLY managed permission rules apply (lower layers cannot add allow/ask).
   *  The org-lockdown primitive (§4.b). Only honored on the managed layer. */
  readonly allowManagedPermissionRulesOnly?: boolean
}

/** One command-hook group (Claude shape) carried by a layer. */
export interface HookGroupSetting {
  readonly matcher?: string
  readonly hooks?: readonly { readonly type?: string; readonly command?: string }[]
  /** T04 provenance — the config LAYER this group came from, STAMPED BY THE
   *  TRUSTED MERGE ({@link mergeSettings}), NEVER read from disk (the layer
   *  parser drops unknown keys, so a hostile repo cannot smuggle a trusted
   *  `source` to skip review). Absent on a freshly-parsed disk group; present
   *  only on a group inside {@link ResolvedSettings.hooks}. Consumed by the
   *  command-hooks `bindingsFromHookEvents` to derive `needsReview`. */
  readonly source?: SettingsLayerName
}

/** Hooks block — command execution. Capability-granting ⇒ trust-gated. */
export interface HooksSettings {
  /** EventName → groups, the Claude `settings.json#hooks` shape. */
  readonly events?: Readonly<Record<string, readonly HookGroupSetting[]>>
  /** Claude `allowManagedHooksOnly` — when set in the MANAGED layer, ONLY
   *  managed hooks apply. Only honored on the managed layer. */
  readonly allowManagedHooksOnly?: boolean
}

/** MCP block — server launchers (arbitrary-binary exec). Trust-gated. */
export interface McpSettings {
  /** Project-local MCP server ids the repo wants enabled. LOOSENING (dropped
   *  for an untrusted repo; blocked by `allowManagedMcpServersOnly`). */
  readonly enabledServers?: readonly string[]
  /** E2 (CC `deniedMcpServers`) — server ids to FORBID. TIGHTENING: removes
   *  from the enabled set (deny wins) and applies EVEN for an untrusted repo
   *  layer (§4.c — narrowing is always safe). */
  readonly deniedServers?: readonly string[]
  /** E1-sub (CC `allowManagedMcpServersOnly`) — when set in the MANAGED layer,
   *  ONLY managed-layer enabledServers apply (user/project/local cannot add),
   *  even for a trusted repo. Mirrors `allowManagedHooksOnly`. */
  readonly allowManagedMcpServersOnly?: boolean
}

/** OpenAI-compatible endpoint wire surface. Closed union — a value outside it
 *  makes the whole endpoint fail-closed at parse (never a silent wrong grammar
 *  on the wire). Mirrors {@link CreateLLMOptions.surface} minus the `auto`
 *  inference: a declarative endpoint always states its wire EXPLICITLY. */
export type EndpointWireApi = "chat" | "responses"

/** Network admission class an endpoint is pinned to (RFC05-1 vocabulary).
 *  `public_https` ⇒ HTTPS to a public-resolved address only; `loopback_local`
 *  ⇒ HTTP/HTTPS to a loopback-resolved address only (the local-OSS profile).
 *  Closed union — an out-of-set value drops the endpoint. */
export type EndpointNetworkPolicy = "public_https" | "loopback_local"

/** Fixed allowlist of symbolic references an endpoint may use for its auth key
 *  / header values. This is NOT an arbitrary env-var name: it is a SYMBOLIC
 *  ref the host maps to a concrete secret at composition time. Keeping it a
 *  closed set is the load-bearing anti-exfil guard — a hostile repo endpoint
 *  cannot reference `ANTHROPIC_API_KEY` / `AWS_*` / any other process env to
 *  harvest a cross-provider credential (RFC-05 D1 trust; audit A1). */
export const ENDPOINT_SECRET_REFS = ["endpoint_api_key"] as const
export type EndpointSecretRef = (typeof ENDPOINT_SECRET_REFS)[number]

/** One named OpenAI-compatible endpoint profile (RFC-05 D1). The CONTROL-plane
 *  record: it carries only DECLARATIVE data + restricted symbolic references —
 *  NEVER a resolved secret value (those live only in host composition, never in
 *  a config record / receipt / hash material). `authRef`/`headerRefs` reference
 *  the fixed {@link ENDPOINT_SECRET_REFS} allowlist; an arbitrary env name or a
 *  static header carrying a secret-looking value is rejected at parse. */
export interface OpenAIEndpointOptions {
  /** REQUIRED endpoint base URL. Untrusted input — admitted only through the
   *  trust gate + RFC05-1 network policy (SSRF/scheme/redirect classified). */
  readonly baseUrl: string
  /** Explicit wire surface — no base-URL inference (audit A4). */
  readonly wireApi: EndpointWireApi
  /** REQUIRED model id (no port-level default — factory rationale). */
  readonly model: string
  /** Network admission class this endpoint is pinned to (RFC05-1). */
  readonly networkPolicy: EndpointNetworkPolicy
  /** Optional symbolic ref for the endpoint's own API key. Must be in
   *  {@link ENDPOINT_SECRET_REFS}. Absent ⇒ no-auth (loopback presets). */
  readonly authRef?: EndpointSecretRef
  /** Optional header-name → symbolic-ref map. Every value must be in
   *  {@link ENDPOINT_SECRET_REFS} — never a raw value, never a cross-provider
   *  env name. */
  readonly headerRefs?: Readonly<Record<string, EndpointSecretRef>>
  /** Optional static NON-secret query params (e.g. api-version). */
  readonly query?: Readonly<Record<string, string>>
}

/** The SECURITY-load-bearing band of a layer (§4.c). For a repo layer, its
 *  LOOSENING parts (permission `allow`/`ask`, `hooks`, `mcp`, `openaiEndpoints`)
 *  are dropped when the project is untrusted; its TIGHTENING parts (permission
 *  `deny`) survive. */
export interface LayerSecurity {
  readonly permissions?: PermissionSettings
  readonly hooks?: HooksSettings
  readonly mcp?: McpSettings
  /** Named OpenAI-compatible endpoint profiles (RFC-05 D1). LOOSENING — a repo
   *  layer's endpoints are dropped when the project is untrusted (they redirect
   *  the LLM transport, a capability grant). */
  readonly openaiEndpoints?: Readonly<Record<string, OpenAIEndpointOptions>>
}

/** The BENIGN band of a layer (§4.c) — grants no capability. */
export interface LayerBenign {
  /** Display / formatting model id (e.g. UI default model). Benign. */
  readonly model?: string
}

/** One parsed layer. Unknown keys are dropped (NOT carried) so a hostile repo
 *  cannot smuggle an un-discriminated key past the security/benign split. */
export interface SettingsLayer {
  readonly security?: LayerSecurity
  readonly benign?: LayerBenign
}

/** The merged, trust-gated result the loader returns (§4.a/§4.b/§4.c). */
export interface ResolvedSettings {
  /** Final permission rule lists after precedence + managed-non-overridable +
   *  trust-gate (deny always survives; allow/ask gated for untrusted repos). */
  readonly permissions: {
    readonly allow: readonly string[]
    readonly deny: readonly string[]
    readonly ask: readonly string[]
  }
  /** Final command-hook groups (EventName → groups) after the same gating. */
  readonly hooks: Readonly<Record<string, readonly HookGroupSetting[]>>
  /** Final enabled MCP server ids after gating (enabled minus denied). */
  readonly mcpEnabledServers: readonly string[]
  /** E2 — resolved MCP denylist (union across layers; tightening, never gated).
   *  Exposed for operator visibility + so a launcher can refuse a server that
   *  is denied even if some other path tried to enable it. */
  readonly mcpDeniedServers: readonly string[]
  /** Benign merged model id, if any layer set one. */
  readonly model: string | undefined
  /** Resolved named OpenAI endpoint profiles after precedence + trust gate
   *  (id-keyed deterministic replace; untrusted repo endpoints dropped).
   *  RFC-05 D1. Empty map when no layer set one (byte-identical nothing). */
  readonly openaiEndpoints: Readonly<Record<string, OpenAIEndpointOptions>>
  /** Provenance: which repo layers had capability grants DROPPED for untrust
   *  (parity with `tengu_settings_*_untrusted_source_ignored`). Empty when the
   *  project is trusted or no repo layer carried a grant. Categorical only —
   *  layer NAMES, never paths/commands. */
  readonly droppedForUntrust: readonly SettingsLayerName[]
}

/** Empty resolved settings — the byte-identical "nothing" value (default-OFF,
 *  or all layers absent). */
export const EMPTY_RESOLVED: ResolvedSettings = {
  permissions: { allow: [], deny: [], ask: [] },
  hooks: {},
  mcpEnabledServers: [],
  mcpDeniedServers: [],
  model: undefined,
  openaiEndpoints: {},
  droppedForUntrust: [],
}
