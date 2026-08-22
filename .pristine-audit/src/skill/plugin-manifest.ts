/**
 * Plugin manifest schemas (Cluster E / F13, ADR-0039).
 *
 * Faithful absorption of the Codex plugin layout, RENAMED for v3:
 *
 *   <plugin-root>/
 *     .quanta-plugin/
 *       plugin.json       (this module's main schema)
 *     .mcp.json           (optional — MCP server registration)
 *     skills/<name>/SKILL.md
 *
 * NB. We deliberately do NOT ship the upstream `.codex-plugin/` path — pinning
 * the layout to our own product name avoids leaking someone else's brand into
 * filesystem-visible identifiers (RFC §1.6, "no foreign brand in paths").
 *
 * Slice contract: schemas only. Discovery + loader live in `./plugin-loader.ts`.
 * This file MUST NOT touch the filesystem.
 *
 * Strictness: every schema uses `.strict()` so misspelled keys fail loudly
 * (ZERO heuristics / fallbacks — Cluster E hard rule).
 */

import { z } from "zod"
import { runtimeConfig } from "@/shared"
import { normalizePluginManifest } from "./manifest-compat"

/** Closed Capability enum lifted from Codex's plugin schema (exact triplet —
 *  do NOT widen without an ADR; widening silently broadens a plugin's
 *  declared surface). */
export const CapabilitySchema = z.enum(["Interactive", "Read", "Write"])
export type Capability = z.infer<typeof CapabilitySchema>

/** MCP server descriptor. Shape matches the standard `.mcp.json` server entry
 *  (Anthropic MCP spec): `{ command, args, env?, url?, headers? }`. Strict on
 *  purpose so a manifest typo cannot turn into a silent server-spawn miss.
 *
 *  Carriers: STDIO (spawn `command`) is the default. Setting `url` opts into the
 *  Streamable-HTTP + SSE carrier (ADR-0391). `command`/`args` are now OPTIONAL so
 *  the CANONICAL Anthropic http server form — `{ "url": "...", "headers": {...} }`
 *  with NO `command` key — parses (it previously HARD-FAILED the required-`command`
 *  schema; REPORT-jun26 §3.4). The refine still guarantees at least one of a
 *  non-empty `command` (stdio) or a `url` (http) is present, preserving the
 *  "no silent empty-spawn" invariant for stdio-only callers. */
export const MCPServerSpecSchema = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    // H18 — per-server OAuth opt-in (mirrors `McpServerConfig.oauth`). OPTIONAL
    // and additive: a stdio / no-auth entry omits it (byte-identical to before).
    // Without this key the strict schema HARD-REJECTED any `.mcp.json` server
    // carrying `oauth:true`, so the per-server OAuth flag could never round-trip
    // from disk — installing an http OAuth connector dropped its auth opt-in and
    // the H18 bearer was never resolved (server 401). Honored only for an http
    // (`url`) server; harmless on stdio (no auth carrier).
    oauth: z.boolean().optional(),
    // UUX-4-14 — `/mcp disable <server>` write-through marker. OPTIONAL and
    // additive: absent ⇒ byte-identical parse. `true` ⇒ the loader skips the
    // server (its config is preserved; only the launch is suppressed). Without
    // this key the strict schema would HARD-REJECT a `.mcp.json` touched by
    // `/mcp disable`, silently dropping EVERY server in the file.
    disabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (s) => (s.command !== undefined && s.command.length > 0) || s.url !== undefined,
    "mcp server requires either non-empty `command` (stdio) or `url` (http)",
  )
export type MCPServerSpec = z.infer<typeof MCPServerSpecSchema>

/** Author metadata. `email` and `url` are optional per the recovered shape;
 *  `name` is required (any plugin must have an attributable author). */
export const PluginAuthorSchema = z
  .object({
    name: z.string().min(1, "author.name must be non-empty"),
    email: z.string().email().optional(),
    url: z.string().url().optional(),
  })
  .strict()
export type PluginAuthor = z.infer<typeof PluginAuthorSchema>

/** Interface metadata block — strictly mirrors the upstream shape so we can
 *  load Codex-format plugins after the `.quanta-plugin/` rename without
 *  field-by-field migration. `screenshots` is an empty-array marker today;
 *  we accept arbitrary string entries to leave the door open for future
 *  asset-path schemas (see ADR-0039 限界). */
/**
 * §2.4 — INLINE plugin-declared hook config. Faithful-minimal mirror of Claude
 * Code's `.claude-plugin/plugin.json` `hooks` block (`{ EVENT: [{ matcher,
 * hooks: [{ type, command, ... }] }] }`). We accept it as an OPAQUE-but-shaped
 * record: an event name → array of `{ matcher?, hooks: [...] }` groups, each
 * group's `hooks[]` is a CLOSED-`type` action ("command" is the only honored
 * action — a typo'd action type hard-fails so a manifest can't silently smuggle
 * an unknown hook kind). The fields beyond `type`/`command` are left permissive
 * (`.passthrough()` on the action) because the harness's settings-hook loader
 * owns the full shape; we only validate the SECURITY-load-bearing `type` enum
 * here. Strict at the outer record level is impossible (event names are open),
 * so the outer map is a plain `z.record`. */
const PluginHookActionSchema = z
  .object({
    type: z.enum(["command"]),
    command: z.string().min(1).optional(),
    timeout: z.number().optional(),
    statusMessage: z.string().optional(),
  })
  .passthrough()
const PluginHookGroupSchema = z
  .object({
    matcher: z.string().optional(),
    hooks: z.array(PluginHookActionSchema),
  })
  .strict()
export const PluginPointerHooksSchema = z.record(z.string(), z.array(PluginHookGroupSchema))
export type PluginPointerHooks = z.infer<typeof PluginPointerHooksSchema>

/** §2.4 — the `hooks` pointer field: EITHER a string path to a hooks config
 *  file (resolved relative to the plugin dir by the loader) OR an INLINE
 *  {@link PluginPointerHooksSchema} config. */
export const PluginHooksFieldSchema = z.union([z.string().min(1), PluginPointerHooksSchema])
export type PluginHooksField = z.infer<typeof PluginHooksFieldSchema>

/** §2.4 — the `apps` pointer field: EITHER a single folder-path string OR an
 *  array of folder paths the harness auto-loads (Cowork "apps" pointers).
 *  Resolution + escape-guarding is the loader's job (`resolvePluginPointers`). */
export const PluginAppsFieldSchema = z.union([z.string().min(1), z.array(z.string().min(1))])
export type PluginAppsField = z.infer<typeof PluginAppsFieldSchema>

export const PluginInterfaceSchema = z
  .object({
    displayName: z.string().min(1),
    shortDescription: z.string().min(1),
    longDescription: z.string().min(1),
    developerName: z.string().min(1),
    category: z.string().min(1),
    capabilities: z.array(CapabilitySchema),
    websiteURL: z.string().url(),
    privacyPolicyURL: z.string().url(),
    termsOfServiceURL: z.string().url(),
    logo: z.string().min(1),
    composerIcon: z.string().min(1).optional(),
    defaultPrompt: z.array(z.string()),
    brandColor: z.string().min(1),
    screenshots: z.array(z.string()),
  })
  .strict()
export type PluginInterface = z.infer<typeof PluginInterfaceSchema>

/** Top-level plugin manifest. The shape is intentionally strict — extra keys
 *  in `.quanta-plugin/plugin.json` are a hard error so authoring drift is
 *  caught at load time, not at runtime. */
export const PluginManifestSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, "name must be kebab/snake-case"),
    version: z.string().min(1),
    description: z.string().min(1),
    author: PluginAuthorSchema,
    homepage: z.string().url().optional(),
    license: z.string().min(1),
    keywords: z.array(z.string()),
    mcpServers: z.record(z.string(), MCPServerSpecSchema).optional(),
    skills: z.array(z.string()).optional(),
    // §2.4 — additive optional pointer fields (Claude Code parity). A manifest
    // WITHOUT them parses byte-identically to before. `hooks` = path OR inline
    // config; `apps` = folder pointer(s). RESOLUTION (path-join + escape guard)
    // is gated + done by the loader (`resolvePluginPointers`), so merely
    // DECLARING them changes no behavior until the host opts in.
    hooks: PluginHooksFieldSchema.optional(),
    apps: PluginAppsFieldSchema.optional(),
    interface: PluginInterfaceSchema,
  })
  .strict()
export type PluginManifest = z.infer<typeof PluginManifestSchema>

/**
 * jun-7-misc 02 — codex-shape ingest variant of {@link PluginManifestSchema}.
 *
 * Differs from the strict schema in exactly two SAFE-BY-CONSTRUCTION ways:
 *   1. OUTER `.strict()` → `.strip()`: genuinely-unknown TOP-LEVEL keys
 *      (codex's `license`-adjacent extensions, future `policy`/`authentication`
 *      blocks) are DROPPED, never interpreted. `.strip()` (not `.passthrough()`)
 *      so a stripped key can NEVER be read off the parsed object downstream.
 *   2. Additive optional `repository` (string-URL OR `{url,type?}` — both real
 *      ecosystem shapes). A manifest WITHOUT `repository` parses identically to
 *      the strict schema, so this is no-regression for quanta-native files.
 *
 * The SECURITY-load-bearing INNER blocks stay `.strict()` UNCHANGED:
 *   - `MCPServerSpecSchema` (server-spawn descriptor — typo'd key MUST hard-fail)
 *   - `PluginInterfaceSchema` (`capabilities` = declared-surface enum)
 *   - `PluginAuthorSchema`
 *   - `CapabilitySchema` (closed enum)
 * Loosening the OUTER schema cannot widen any grant because every grant-bearing
 * field is an INNER strict-validated field. Unknown outer keys are dropped.
 *
 * Used ONLY when `runtimeConfig().manifestCompat` is armed (strict `=== "1"`).
 * Default-OFF callers use {@link PluginManifestSchema} ⇒ byte-identical today. */
export const PluginManifestCompatSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, "name must be kebab/snake-case"),
    version: z.string().min(1),
    description: z.string().min(1),
    author: PluginAuthorSchema,
    homepage: z.string().url().optional(),
    license: z.string().min(1),
    keywords: z.array(z.string()),
    mcpServers: z.record(z.string(), MCPServerSpecSchema).optional(),
    skills: z.array(z.string()).optional(),
    // §2.4 — additive optional pointer fields, also accepted on the compat path.
    hooks: PluginHooksFieldSchema.optional(),
    apps: PluginAppsFieldSchema.optional(),
    interface: PluginInterfaceSchema,
    // Additive optional: cached codex artifacts carry a string URL; some
    // ecosystems use a `{type,url}` object — accept both. Captured (not
    // stripped) so the loader MAY surface it later.
    repository: z
      .union([
        z.string().url(),
        z.object({ url: z.string().url(), type: z.string().optional() }).strip(),
      ])
      .optional(),
  })
  .strip()
export type PluginManifestCompat = z.infer<typeof PluginManifestCompatSchema>

/**
 * Parse a plugin manifest. Single closed-port entry: when the
 * `QUANTA_MANIFEST_COMPAT` knob is OFF (default) this is BYTE-IDENTICAL to
 * `PluginManifestSchema.safeParse(raw)` — same schema, no normalizer, no
 * `repository` field. When ON it runs the pure {@link normalizePluginManifest}
 * (string `skills` → array) then validates against the relaxed
 * {@link PluginManifestCompatSchema}.
 *
 * `log` is an optional debug sink for dropped/coerced keys (ticket §5 drift
 * observability); inert by default. */
export const parsePluginManifest = (
  raw: unknown,
  log?: (message: string) => void,
): z.SafeParseReturnType<unknown, PluginManifest | PluginManifestCompat> => {
  if (!runtimeConfig().manifestCompat) {
    return PluginManifestSchema.safeParse(raw)
  }
  return PluginManifestCompatSchema.safeParse(normalizePluginManifest(raw, log))
}

/** `.mcp.json` is allowed to declare multiple servers under `mcpServers`. */
export const MCPRootSchema = z
  .object({
    mcpServers: z.record(z.string(), MCPServerSpecSchema),
  })
  .strict()
export type MCPRoot = z.infer<typeof MCPRootSchema>

/** Canonical directory + file names — single source of truth so the loader,
 *  tests, and any future tooling stay in lockstep. Renaming here is the only
 *  place to change the on-disk layout. */
export const PLUGIN_DIR_NAME = ".quanta-plugin"
export const PLUGIN_MANIFEST_FILE = "plugin.json"
export const PLUGIN_MCP_FILE = ".mcp.json"
export const PLUGIN_SKILLS_DIR = "skills"
