/**
 * ADR-0422 — common default `MentionResolverPort` builder.
 *
 * DRY composition root shared by EVERY surface (the unified-agent
 * `apps/agent/assemble.ts` wire AND the CLI host-runtime wire). Reads the
 * `QUANTA_MENTION_*` env knobs (all default-ON; `=off` opts out per kind),
 * then assembles a {@link createCompositeMentionResolver} from whatever deps
 * the surface can supply:
 *
 *   - `@file`   — always available (workspace root = `cwd`); `QUANTA_MENTION_FILE`.
 *   - `@symbol` — available when an `lsp` and/or `semantic` SymbolLookup port
 *                 is injected (built by the surface via ADR-0422's
 *                 `createLspSymbolLookup` / `createSemanticSymbolLookup`);
 *                 `QUANTA_MENTION_SYMBOL`.
 *   - `@skill`  — available when a `SkillRegistryReadOnly` is injected;
 *                 `QUANTA_MENTION_SKILL`.
 *   - `@folder` — (§10.3) always available (workspace root = `cwd`, same jail
 *                 as `@file`); `QUANTA_MENTION_FOLDER` (default-ON).
 *   - `@git`    — (§10.3) available when a `git` context provider is injected
 *                 (the runner backs it with `runShell`); `QUANTA_MENTION_GIT`.
 *   - `plugin://` / `@@app` — (ADR-0336) available when a `PluginRegistryPort`
 *                 (real `discoverPlugins` scan) and/or `AppCatalogPort` (real
 *                 `loadWorkspaceAppCatalog` merge) is injected AND the
 *                 `QUANTA_MENTION_APP_PLUGIN` knob is ON. Unlike the other
 *                 knobs this one is DEFAULT-OFF: unset ⇒ the injected ports are
 *                 NOT passed to the composite, so both resolve `null`
 *                 (byte-identical to the pre-wire path). A miss against a
 *                 present registry/catalog returns the resolver's typed `null`,
 *                 never a fabricated stub (NO heuristic fallback).
 *
 * GRACEFUL OMIT: a kind whose dep is absent (no symbol ports / no registry)
 * is simply NOT attached, so that kind resolves to `null` — byte-identical to
 * the legacy path, never a regression. A kind whose env knob is `=off` is also
 * skipped even if its dep is present.
 *
 * BYTE-IDENTICAL: with every knob `=off` (or every dep absent) the composite
 * exposes only the 3 legacy skill/plugin/app methods with no registry, so the
 * built resolver resolves every mention to `null` — the loop injects nothing.
 *
 * File caps: `QUANTA_MENTION_FILE_MAX_BYTES` / `QUANTA_MENTION_FILE_TAIL_RATIO`
 * map onto the file-resolver knobs; symbol strategy / timeout map onto the
 * symbol resolver via `QUANTA_MENTION_SYMBOL_RESOLVER` /
 * `QUANTA_MENTION_SYMBOL_TIMEOUT_MS`.
 */

import type { AppCatalogPort } from "@/agent/app-catalog"
import {
  createSymbolResolver,
  type MentionResolverPort,
  type SymbolLookupLspPort,
  type SymbolLookupSemanticPort,
  type SymbolResolverPriority,
} from "@/agent/mention-injection"
import type { NamedAgentResolver } from "@/agent/named-agent-registry"
import {
  type CompositeResolverDeps,
  createCompositeMentionResolver,
  type FileResolverOptions,
  type FolderResolverOptions,
  type GitContextProvider,
  type GitResolverOptions,
  type McpResolverOptions,
  type McpServerListingPort,
  type SkillRegistryReadOnly,
  type ThreadResolverOptions,
  type ThreadSummaryPort,
} from "@/agent/plugin-app-resolver"
import type { PluginRegistryPort } from "@/agent/plugin-discovery"
import { gateOn, parseEnvFlag } from "@/shared"

/** Env subset the builder reads. A plain bag so callers can pass
 *  `process.env` OR a hermetic record (tests / non-Node hosts). */
export type MentionEnv = Readonly<Record<string, string | undefined>>

/** Options for {@link buildDefaultMentionResolver}. */
export interface BuildDefaultMentionResolverOptions {
  /** Workspace root for the `@file` resolver. */
  readonly cwd: string
  /** Env source (e.g. `process.env`). */
  readonly env: MentionEnv
  /** Read-only skill registry for `@skill`. Omit ⇒ `@skill` resolves null. */
  readonly skills?: SkillRegistryReadOnly
  /** LSP-backed `@symbol` lookup. Omit ⇒ LSP strategy disabled. */
  readonly lsp?: SymbolLookupLspPort
  /** Semantic-backed `@symbol` lookup. Omit ⇒ semantic strategy disabled. */
  readonly semantic?: SymbolLookupSemanticPort
  /** §10.3 — injected git-context provider for `@git`. Omit ⇒ `@git`
   *  resolves null (graceful omit; byte-identical to the legacy path). */
  readonly git?: GitContextProvider
  /** ADR-0336 — injected plugin registry for `plugin://`. Built by the host
   *  composition root from the ALREADY-LIVE `discoverPlugins` scan (the
   *  `.codex-plugin/plugin.json` layout under `<cwd>/.quanta/plugins`). Omit
   *  ⇒ `plugin://` resolves null. Only flows to the composite when the
   *  default-OFF `QUANTA_MENTION_APP_PLUGIN` knob is ON (see `pluginDep`). */
  readonly plugins?: PluginRegistryPort
  /** ADR-0336 — injected app catalog for `@@app`. Built by the host
   *  composition root from `loadWorkspaceAppCatalog` merged over
   *  `DEFAULT_APP_CATALOG`. Omit ⇒ `@@app` resolves null. Only flows to the
   *  composite when `QUANTA_MENTION_APP_PLUGIN` is ON (see `appDep`). */
  readonly apps?: AppCatalogPort
  /** RFC-12-2 — injected MCP-server listing port for `@mcp:`. Backed by the
   *  host's live loaded-tools set (server → `Tool[]`). Omit ⇒ `@mcp:` resolves
   *  null. Gated on `QUANTA_MENTION_MCP` (default-ON kill-switch). */
  readonly mcpListing?: McpServerListingPort
  /** RFC-12-2 — injected named-agent registry for `@subagent:` (the same
   *  read-only port the subagent runner consults). Omit ⇒ `@subagent:` resolves
   *  null. Gated on `QUANTA_MENTION_SUBAGENT`. */
  readonly subagents?: NamedAgentResolver
  /** RFC-12-2 — injected prior-thread summary port for `@thread:`. Backed by
   *  the live session store (`listSessions` / `SessionMeta`). Omit ⇒ `@thread:`
   *  resolves null. Gated on `QUANTA_MENTION_THREAD`. */
  readonly threadSummary?: ThreadSummaryPort
}

/** A knob is ON unless explicitly disabled. Delegates to the canonical
 *  `parseEnvFlag` truth table so the falsey set (`0`/`false`/`off`/`no`) is
 *  shared with memory + all other default-ON knobs across the codebase — no
 *  more mention-only `!== "off"` asymmetry that audit found. */
const isOn = (env: MentionEnv, key: string): boolean => parseEnvFlag(env[key], /* defaultOn */ true)

const parsePositiveNumber = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

const parseRatio = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined
}

const parsePriority = (raw: string | undefined): SymbolResolverPriority => {
  if (raw === "lsp" || raw === "semantic" || raw === "auto") return raw
  return "auto"
}

/** Build the `@file` deps slot when the knob is ON. */
const fileDeps = (opts: BuildDefaultMentionResolverOptions): FileResolverOptions | undefined => {
  if (!isOn(opts.env, "QUANTA_MENTION_FILE")) return undefined
  const maxBytes = parsePositiveNumber(opts.env.QUANTA_MENTION_FILE_MAX_BYTES)
  const tailRatio = parseRatio(opts.env.QUANTA_MENTION_FILE_TAIL_RATIO)
  return {
    root: opts.cwd,
    ...(maxBytes !== undefined ? { maxBytes } : {}),
    ...(tailRatio !== undefined ? { tailRatio } : {}),
  }
}

/** Build the `@symbol` resolver fn when the knob is ON AND at least one
 *  lookup port is injected. No ports ⇒ undefined (graceful omit). */
const symbolDep = (
  opts: BuildDefaultMentionResolverOptions,
): CompositeResolverDeps["symbol"] | undefined => {
  if (!isOn(opts.env, "QUANTA_MENTION_SYMBOL")) return undefined
  if (opts.lsp === undefined && opts.semantic === undefined) return undefined
  const priority = parsePriority(opts.env.QUANTA_MENTION_SYMBOL_RESOLVER)
  const timeoutMs = parsePositiveNumber(opts.env.QUANTA_MENTION_SYMBOL_TIMEOUT_MS)
  return createSymbolResolver({
    ...(opts.lsp !== undefined ? { lsp: opts.lsp } : {}),
    ...(opts.semantic !== undefined ? { semantic: opts.semantic } : {}),
    priority,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  })
}

/** Build the `@skill` registry slot when the knob is ON AND a registry is
 *  injected. No registry ⇒ undefined (graceful omit). */
const skillDep = (opts: BuildDefaultMentionResolverOptions): SkillRegistryReadOnly | undefined => {
  if (!isOn(opts.env, "QUANTA_MENTION_SKILL")) return undefined
  return opts.skills
}

/** §10.3 — build the `@folder` deps slot when the knob is ON. Reuses the cwd
 *  workspace root (same jail as `@file`). `=off` ⇒ undefined. */
const folderDeps = (
  opts: BuildDefaultMentionResolverOptions,
): FolderResolverOptions | undefined => {
  if (!isOn(opts.env, "QUANTA_MENTION_FOLDER")) return undefined
  const maxEntries = parsePositiveNumber(opts.env.QUANTA_MENTION_FOLDER_MAX_ENTRIES)
  return {
    root: opts.cwd,
    ...(maxEntries !== undefined ? { maxEntries } : {}),
  }
}

/** ADR-0336 — the `plugin://` + `@@app` resolution knob. Unlike the other
 *  `QUANTA_MENTION_*` knobs (default-ON kill-switches read via `parseEnvFlag`),
 *  this one is a DEFAULT-OFF OPT-IN gate, so it routes through the canonical
 *  `gateOn` SSOT (ADR-0503 bool-vocab): ON only for an explicit truthy token
 *  (`1`/`on`/`true`/`yes`); unset / empty (`QUANTA_MENTION_APP_PLUGIN=`) / a
 *  falsy token / anything unrecognized ⇒ OFF. `gateOn` (NOT `parseEnvFlag`,
 *  whose legacy `""`→true quirk would spuriously arm the gate) is what
 *  preserves the byte-identical opt-in guarantee: with the knob absent neither
 *  `plugins` nor `apps` flows to the composite, so `plugin://` / `@@app`
 *  resolve `null` — identical to the pre-wire path even when a surface injects
 *  the ports. */
const isAppPluginOn = (env: MentionEnv): boolean => gateOn(env, "QUANTA_MENTION_APP_PLUGIN")

/** Build the `plugin://` registry slot when the app/plugin knob is ON AND a
 *  registry is injected. Gate OFF or no registry ⇒ undefined (graceful omit /
 *  byte-identical). The injected registry is the real `discoverPlugins`-backed
 *  port; a miss returns the resolver's typed `null`, never a stub. */
const pluginDep = (opts: BuildDefaultMentionResolverOptions): PluginRegistryPort | undefined => {
  if (!isAppPluginOn(opts.env)) return undefined
  return opts.plugins
}

/** Build the `@@app` catalog slot when the app/plugin knob is ON AND a catalog
 *  is injected. Gate OFF or no catalog ⇒ undefined (graceful omit /
 *  byte-identical). The injected catalog is the real workspace-merged port. */
const appDep = (opts: BuildDefaultMentionResolverOptions): AppCatalogPort | undefined => {
  if (!isAppPluginOn(opts.env)) return undefined
  return opts.apps
}

/** §10.3 — build the `@git` deps slot when the knob is ON AND a provider is
 *  injected. No provider ⇒ undefined (graceful omit). */
const gitDep = (opts: BuildDefaultMentionResolverOptions): GitResolverOptions | undefined => {
  if (!isOn(opts.env, "QUANTA_MENTION_GIT")) return undefined
  if (opts.git === undefined) return undefined
  const maxBytes = parsePositiveNumber(opts.env.QUANTA_MENTION_GIT_MAX_BYTES)
  return {
    provider: opts.git,
    ...(maxBytes !== undefined ? { maxBytes } : {}),
  }
}

/** RFC-12-2 — build the `@mcp:` deps slot when the knob is ON AND a listing
 *  port is injected. No port ⇒ undefined (graceful omit). */
const mcpDep = (opts: BuildDefaultMentionResolverOptions): McpResolverOptions | undefined => {
  if (!isOn(opts.env, "QUANTA_MENTION_MCP")) return undefined
  if (opts.mcpListing === undefined) return undefined
  const maxTools = parsePositiveNumber(opts.env.QUANTA_MENTION_MCP_MAX_TOOLS)
  return {
    listing: opts.mcpListing,
    ...(maxTools !== undefined ? { maxTools } : {}),
  }
}

/** RFC-12-2 — build the `@subagent:` registry slot when the knob is ON AND a
 *  named-agent registry is injected. No registry ⇒ undefined (graceful omit). */
const subagentDep = (opts: BuildDefaultMentionResolverOptions): NamedAgentResolver | undefined => {
  if (!isOn(opts.env, "QUANTA_MENTION_SUBAGENT")) return undefined
  return opts.subagents
}

/** RFC-12-2 — build the `@thread:` deps slot when the knob is ON AND a summary
 *  port is injected. No port ⇒ undefined (graceful omit). */
const threadDep = (opts: BuildDefaultMentionResolverOptions): ThreadResolverOptions | undefined => {
  if (!isOn(opts.env, "QUANTA_MENTION_THREAD")) return undefined
  if (opts.threadSummary === undefined) return undefined
  return { summary: opts.threadSummary }
}

/**
 * Build the default composite {@link MentionResolverPort} for a surface.
 *
 * @param opts — cwd + env (+ optional skills registry / lsp / semantic ports).
 * @returns A composite resolver. With all knobs off / all deps absent the
 *          resolver answers `null` for every kind (byte-identical default-OFF).
 */
export const buildDefaultMentionResolver = (
  opts: BuildDefaultMentionResolverOptions,
): MentionResolverPort => {
  const files = fileDeps(opts)
  const symbol = symbolDep(opts)
  const skills = skillDep(opts)
  const folders = folderDeps(opts)
  const git = gitDep(opts)
  const plugins = pluginDep(opts)
  const apps = appDep(opts)
  const mcp = mcpDep(opts)
  const subagents = subagentDep(opts)
  const threads = threadDep(opts)
  return createCompositeMentionResolver({
    ...(files !== undefined ? { files } : {}),
    ...(symbol !== undefined ? { symbol } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(folders !== undefined ? { folders } : {}),
    ...(git !== undefined ? { git } : {}),
    ...(plugins !== undefined ? { plugins } : {}),
    ...(apps !== undefined ? { apps } : {}),
    ...(mcp !== undefined ? { mcp } : {}),
    ...(subagents !== undefined ? { subagents } : {}),
    ...(threads !== undefined ? { threads } : {}),
  })
}
