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

/** The SECURITY-load-bearing band of a layer (§4.c). For a repo layer, its
 *  LOOSENING parts (permission `allow`/`ask`, `hooks`, `mcp`) are dropped when
 *  the project is untrusted; its TIGHTENING parts (permission `deny`) survive. */
export interface LayerSecurity {
  readonly permissions?: PermissionSettings
  readonly hooks?: HooksSettings
  readonly mcp?: McpSettings
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
  droppedForUntrust: [],
}
