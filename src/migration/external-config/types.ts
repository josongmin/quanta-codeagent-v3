/**
 * External-config migration: shared types (H13, jun-3-misc §3).
 *
 * Detect-and-import for competitor (Claude Code / Cursor) CONFIG artifacts —
 * distinct from the session-transcript import that the parent `@/migration`
 * slice already owns (ADR-0038/0430). This sub-slice mirrors Codex's
 * `external_agent_config.rs` model:
 *
 *   - a Detect pass walks known external config locations (home + project)
 *     and returns a typed {@link ConfigInventory},
 *   - an Import pass runs a per-item-type converter into a quanta shape,
 *   - a throttle {@link MigrationLedger} records "offered/imported/declined"
 *     per source so the migration prompt is NOT re-offered every launch.
 *
 * Default-OFF: the knob `QUANTA_MIGRATE_CONFIG` gates the whole flow. Unset ⇒
 * no detect, no prompt, byte-identical startup.
 */

/** The competitor config item types quanta can import. Mirrors Codex's
 *  `ExternalAgentConfigMigrationItemType` ({AGENTS_MD, PLUGINS,
 *  MCP_SERVER_CONFIG, SUBAGENTS}) narrowed to the kinds quanta models. */
export type MigrationItemType =
  | "agents_md" // CLAUDE.md / AGENTS.md → repo-rules
  | "settings" // .claude/settings.json → permission/config shape
  | "hooks" // .claude/settings.json#hooks or hooks.json → hook config
  | "mcp" // .mcp.json → MCP server config (passthrough/normalize)
  | "subagents" // .claude/agents/*.md → subagent spec
  | "cursor_rules" // .cursor/rules/*.mdc / .cursorrules → glob-rules

/** All item types as a readonly array — used to iterate + to assert the
 *  detector covers every type in the suite. */
export const ALL_MIGRATION_ITEM_TYPES: readonly MigrationItemType[] = Object.freeze([
  "agents_md",
  "settings",
  "hooks",
  "mcp",
  "subagents",
  "cursor_rules",
] as const)

/** Where a detected item lives: the user's home (`~/.claude/...`) vs the
 *  current project tree (`<cwd>/.claude/...`, `<cwd>/CLAUDE.md`, …). Home-
 *  scoped config applies to every project; project-scoped is repo-local. */
export type MigrationScope = "home" | "project"

/** One detected competitor config artifact. `path` is absolute. */
export interface DetectedConfigItem {
  readonly type: MigrationItemType
  readonly path: string
  readonly scope: MigrationScope
}

/** The result of the Detect pass — a flat, ordered, deduped list of detected
 *  items plus any non-fatal warnings (a directory that could not be scanned,
 *  etc). Empty `items` ⇒ nothing to offer (no prompt). */
export interface ConfigInventory {
  readonly items: readonly DetectedConfigItem[]
  readonly warnings: readonly MigrationWarning[]
}

/** A typed, non-fatal warning surfaced by detect/convert. A malformed
 *  competitor file becomes a `skipped_malformed` warning (never a throw). */
export interface MigrationWarning {
  readonly kind: "skipped_malformed" | "unreadable" | "scan_failed"
  /** Absolute path the warning concerns. */
  readonly path: string
  /** Human-readable detail (no secrets — never echoes file content). */
  readonly detail: string
}

/** A quanta MCP server entry produced by the mcp converter. Passthrough of
 *  the modeled fields; `env` is dropped (never carry credentials). */
export interface ConvertedMcpServer {
  readonly name: string
  readonly transport: "stdio" | "http" | "sse" | "unknown"
  readonly command?: string
  readonly args?: readonly string[]
}

/** A quanta hook binding produced by the hooks converter. */
export interface ConvertedHook {
  readonly event: string
  readonly matcher?: string
  readonly commands: readonly string[]
}

/** A quanta permission/config fragment produced by the settings converter.
 *  Claude Code `settings.json` carries a `permissions: { allow[], deny[],
 *  ask[] }` block + a `defaultMode`; we normalize those into quanta's
 *  allow/deny/ask vocabulary. Unknown keys are dropped (no silent passthrough
 *  of competitor-only fields). */
export interface ConvertedSettings {
  readonly allow: readonly string[]
  readonly deny: readonly string[]
  readonly ask: readonly string[]
  /** Claude Code `defaultMode` ("acceptEdits"|"plan"|"bypassPermissions"|…),
   *  carried verbatim when present so the surface can map it. */
  readonly defaultMode?: string
}

/** A quanta subagent spec produced by the subagents converter. Claude Code
 *  stores subagents as `.claude/agents/<name>.md` with YAML frontmatter
 *  (`name`, `description`, `tools`) + a markdown system-prompt body. */
export interface ConvertedSubagent {
  readonly name: string
  readonly description?: string
  /** Frontmatter `tools` list, normalized to string[]. Empty ⇒ inherit. */
  readonly tools: readonly string[]
  /** The markdown body after the frontmatter — the agent's system prompt. */
  readonly systemPrompt: string
  /** Absolute source path (provenance). */
  readonly sourcePath: string
}

/** A quanta repo-rules fragment produced by the agents_md converter. Reuses
 *  the read-time `loadRepoRules` parser; we carry the rendered body + source. */
export interface ConvertedRepoRules {
  readonly entrypoint: string
  readonly sourcePath: string
  readonly body: string
}

/** A quanta glob-rule produced by the cursor_rules converter. Reuses the
 *  read-time `loadGlobRules` parser shape. */
export interface ConvertedGlobRule {
  readonly sourcePath: string
  readonly description?: string
  readonly globs: readonly string[]
  readonly alwaysApply: boolean
  readonly body: string
}

/** Discriminated union of converter outputs, tagged by item `type` so a
 *  caller can route each to the right quanta sink. A converter that finds no
 *  usable signal returns `ok: false` with a typed warning rather than throwing. */
export type ConvertedItem =
  | { readonly type: "agents_md"; readonly ok: true; readonly value: ConvertedRepoRules }
  | { readonly type: "settings"; readonly ok: true; readonly value: ConvertedSettings }
  | { readonly type: "hooks"; readonly ok: true; readonly value: readonly ConvertedHook[] }
  | { readonly type: "mcp"; readonly ok: true; readonly value: readonly ConvertedMcpServer[] }
  | { readonly type: "subagents"; readonly ok: true; readonly value: readonly ConvertedSubagent[] }
  | {
      readonly type: "cursor_rules"
      readonly ok: true
      readonly value: readonly ConvertedGlobRule[]
    }
  | { readonly type: MigrationItemType; readonly ok: false; readonly warning: MigrationWarning }

/** The throttle ledger's per-source disposition. `offered` ⇒ the user was
 *  shown the prompt; `imported` ⇒ they ran the import; `declined` ⇒ they
 *  said no. Any of the three suppresses a re-offer for that source. */
export type MigrationDisposition = "offered" | "imported" | "declined"

/** One persisted ledger row. `sourceKey` is a stable identifier for a
 *  detected source (scope + sorted item paths fingerprint) so re-running
 *  detect on the SAME tree dedups against the SAME row. */
export interface MigrationLedgerEntry {
  readonly sourceKey: string
  readonly disposition: MigrationDisposition
  readonly timestamp: string
  /** The item types that were present when this disposition was recorded
   *  (diagnostics only — not part of the throttle key). */
  readonly itemTypes: readonly MigrationItemType[]
}

/** The persisted throttle ledger. Mirrors the parent slice's `ImportLog`
 *  versioned-envelope shape. */
export interface MigrationLedger {
  readonly version: 1
  readonly entries: readonly MigrationLedgerEntry[]
}
