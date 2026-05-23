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
import { z } from "zod";
/** Closed Capability enum lifted from Codex's plugin schema (exact triplet —
 *  do NOT widen without an ADR; widening silently broadens a plugin's
 *  declared surface). */
export const CapabilitySchema = z.enum(["Interactive", "Read", "Write"]);
/** MCP server descriptor. Shape matches the standard `.mcp.json` server entry
 *  (Anthropic MCP spec): `{ command, args, env? }`. Strict on purpose so a
 *  manifest typo cannot turn into a silent server-spawn miss. */
export const MCPServerSpecSchema = z
    .object({
    command: z.string().min(1, "mcp server command must be non-empty"),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()).optional(),
})
    .strict();
/** Author metadata. `email` and `url` are optional per the recovered shape;
 *  `name` is required (any plugin must have an attributable author). */
export const PluginAuthorSchema = z
    .object({
    name: z.string().min(1, "author.name must be non-empty"),
    email: z.string().email().optional(),
    url: z.string().url().optional(),
})
    .strict();
/** Interface metadata block — strictly mirrors the upstream shape so we can
 *  load Codex-format plugins after the `.quanta-plugin/` rename without
 *  field-by-field migration. `screenshots` is an empty-array marker today;
 *  we accept arbitrary string entries to leave the door open for future
 *  asset-path schemas (see ADR-0039 限界). */
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
    .strict();
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
    interface: PluginInterfaceSchema,
})
    .strict();
/** `.mcp.json` is allowed to declare multiple servers under `mcpServers`. */
export const MCPRootSchema = z
    .object({
    mcpServers: z.record(z.string(), MCPServerSpecSchema),
})
    .strict();
/** Canonical directory + file names — single source of truth so the loader,
 *  tests, and any future tooling stay in lockstep. Renaming here is the only
 *  place to change the on-disk layout. */
export const PLUGIN_DIR_NAME = ".quanta-plugin";
export const PLUGIN_MANIFEST_FILE = "plugin.json";
export const PLUGIN_MCP_FILE = ".mcp.json";
export const PLUGIN_SKILLS_DIR = "skills";
