/**
 * ADR-0336 — Plugin manifest discovery types.
 *
 * Closed-port + closed-enum surface for Codex `.codex-plugin/plugin.json`
 * manifest absorption. The 3-value {@link PluginCapability} enum is
 * FROZEN by this ADR; extending the capability set requires a new ADR.
 *
 * Sibling to ADR-0325's mention-injection slice + ADR-0330's mention-
 * runner: this slice supplies the {@link PluginRegistryPort} that the
 * plugin resolver (in `@/agent/plugin-app-resolver`) consults when
 * resolving `plugin://name` mentions. The capability set + manifest
 * shape mirror Codex's plugin format byte-identically so future Codex
 * absorption is a one-line swap of the parser.
 *
 * Codex reference (per memory `codex-plugin-manifest-pattern`): a
 * Codex plugin is a directory containing `.codex-plugin/plugin.json`
 * (+ optional `.mcp.json` + optional `skills/{name}/SKILL.md` files).
 * The capability enum is closed: `Interactive | Read | Write`.
 *
 * Default-OFF: this slice ships parser + registry port + discovery +
 * an in-memory adapter. No production path imports the module —
 * wire-up is the responsibility of the composition root that builds
 * the `MentionResolverPort` (see `@/agent/plugin-app-resolver`).
 */

/**
 * Closed plugin capability set. Mirrors Codex `plugin.json#capabilities`
 * verbatim: a plugin may declare any subset of {Interactive, Read, Write}.
 *
 * Capability semantics (informational — runtime enforcement is the host's
 * job, not this slice's):
 *   - `Interactive` — may prompt the user / open dialogs.
 *   - `Read`        — may read files / external resources.
 *   - `Write`       — may write files / mutate state.
 *
 * **Frozen.** Extending requires a new ADR.
 */
export type PluginCapability = "Interactive" | "Read" | "Write"

/**
 * A single declared MCP server entry inside a plugin manifest.
 * Simplification of Codex's full `.mcp.json` shape — only the fields
 * the resolver needs are captured. Forward-compat: additional fields
 * in the on-disk JSON are dropped silently.
 *
 * `name` is required; `command` is optional (a manifest may declare a
 * server by name and resolve the command elsewhere, e.g. via env).
 */
export interface PluginMcpServer {
  readonly name: string
  readonly command?: string
}

/**
 * Parsed `.codex-plugin/plugin.json` manifest.
 *
 * Invariants (enforced by the parser):
 *   - `id` non-empty (falls back to directory name at discovery time).
 *   - `name` non-empty.
 *   - `capabilities` is a (possibly empty) array of {@link PluginCapability}.
 *     Unknown strings in the source JSON are silently dropped.
 *   - `mcpServers` / `skills` arrays are optional; absence is distinct
 *     from empty (`undefined` ⇒ the manifest did not declare the field;
 *     `[]` ⇒ the manifest declared an empty list).
 *
 * Forward-compat: unknown top-level fields are dropped by the parser.
 */
export interface PluginManifest {
  /** Plugin identifier. From `id` field, or — at discovery time —
   *  the directory name containing `.codex-plugin/`. ASCII-only by
   *  convention. */
  readonly id: string
  /** Human-readable plugin name. */
  readonly name: string
  /** Optional short description (first line is what the resolver
   *  surfaces; deeper body is intentionally not loaded). */
  readonly description?: string
  /** Closed enum capabilities. */
  readonly capabilities: readonly PluginCapability[]
  /** Optional MCP server declarations. */
  readonly mcpServers?: readonly PluginMcpServer[]
  /** Optional declared skill names. Forward-compat with future
   *  plugin-skill activation ADR. */
  readonly skills?: readonly string[]
}

/**
 * Closed read-only registry port over discovered plugins. Mirrors the
 * shape of `@/skill/registry-readonly`'s `SkillRegistryReadOnly` so the
 * plugin resolver can adopt the identical lookup/list seam.
 *
 * NO-THROW contract: implementations MUST swallow registry I/O errors
 * and return `null` (for `lookup`) or `[]` (for `list`).
 */
export interface PluginRegistryPort {
  /** Returns the manifest or `null` for unknown / malformed entries. */
  lookup(id: string): PluginManifest | null
  /** Returns all discovered manifests. Ordering is implementation-defined
   *  (discovery-order for the fs-backed adapter, insertion-order for
   *  the in-memory adapter). */
  list(): readonly PluginManifest[]
}

/**
 * Closed filesystem port the discovery scanner depends on. Tiny by
 * design: only the two reads the scanner needs. Sibling to the
 * `@/integrations/github` `FsPort` but kept local to this slice so the
 * dependency graph stays empty.
 *
 * NO-THROW contract: implementations SHOULD throw on I/O errors;
 * the scanner wraps every call in a try/catch and degrades to
 * "directory empty / file unreadable".
 */
export interface FilesystemPort {
  /** Return the list of immediate children of `dir`. Names only, no
   *  paths. Order is implementation-defined. */
  readDir(dir: string): readonly string[]
  /** Return the UTF-8 contents of `path`, or `null` if absent /
   *  unreadable. */
  readFile(path: string): string | null
}
