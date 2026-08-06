/**
 * ADR-0336 / ADR-0418 — Composite `MentionResolverPort` factory (async).
 *
 * Composes the kind-specific resolvers (skill / plugin / app, plus the
 * ADR-0418 file / symbol kinds) into a single {@link MentionResolverPort}
 * suitable for the `buildInjectionFragments(...)` consumer at ADR-0325.
 *
 * This is the production sibling to ADR-0330's `createSkillOnlyResolver`.
 * The skill-only flavour is preserved for callers that opt out of plugin /
 * app / file / symbol resolution (e.g. headless CI surfaces, smoke tests).
 * The composite flavour wires every kind and closes ADR-0330's two
 * negative invariants (`resolvePlugin → null`, `resolveApp → null`) and
 * ADR-0418's two new ones (`resolveFile → null`, `resolveSymbol → null`)
 * when the corresponding dep is supplied.
 *
 * Kind dispatch is HARD at the parser/runner layer (a `@skill` mention
 * CANNOT fall through to plugin / app / file / symbol), so the composite
 * resolver simply provides independent function values. Each sub-resolver
 * is NO-THROW; the wrapping `buildInjectionFragments` is also NO-THROW.
 *
 * Async (ADR-0418): the composed port is async. File / symbol resolvers
 * are INJECTED (the file resolver lives in THIS slice; the symbol resolver
 * factory lives in `@/agent/mention-injection`) so the composite does not
 * reach into LSP / search-index itself.
 *
 * Default-OFF: callers that omit a dep see that kind always-null. The
 * legacy 3-kind composite is byte-identical when `files` / `symbol` are
 * omitted (those keys are simply absent ⇒ skipped at dispatch).
 */

import type { AppCatalogPort } from "@/agent/app-catalog"
import type { MentionResolverPort, MentionResolverResult } from "@/agent/mention-injection"
import type { NamedAgentResolver } from "@/agent/named-agent-registry"
import type { PluginRegistryPort } from "@/agent/plugin-discovery"
import { createAppResolver } from "./app-resolver"
import { createFileResolver, type FileResolverOptions } from "./file-resolver"
import { createFolderResolver, type FolderResolverOptions } from "./folder-resolver"
import { createGitResolver, type GitResolverOptions } from "./git-resolver"
import { createMcpResolver, type McpResolverOptions } from "./mcp-resolver"
import { createPluginResolver } from "./plugin-resolver"
import { createSkillResolver } from "./skill-resolver"
import { createSubagentResolver } from "./subagent-resolver"
import { createThreadResolver, type ThreadResolverOptions } from "./thread-resolver"
import type { SkillRegistryReadOnly } from "./types"

/**
 * Dependency bag for {@link createCompositeMentionResolver}. Every field
 * is optional; omitting one ⇒ that kind always resolves to `null`
 * (skipped). All fields absent ⇒ the resolver is functionally equivalent
 * to ADR-0330's `createSkillOnlyResolver()` with no registry (every
 * mention skipped).
 */
export interface CompositeResolverDeps {
  readonly skills?: SkillRegistryReadOnly
  readonly plugins?: PluginRegistryPort
  readonly apps?: AppCatalogPort
  /** ADR-0418 — file-mention resolver options (workspace root + caps).
   *  Omit ⇒ the port has NO `resolveFile` and every `@file` mention
   *  resolves to `null` (byte-identical to the legacy 3-kind composite). */
  readonly files?: FileResolverOptions
  /** ADR-0418 — symbol resolver (e.g. from `@/agent/mention-injection`'s
   *  `createSymbolResolver`). Omit ⇒ the port has NO `resolveSymbol` and
   *  every `@Symbol` mention resolves to `null`. */
  readonly symbol?: (target: string) => Promise<MentionResolverResult | null>
  /** §10.3 — folder-mention resolver options (workspace root + entry cap).
   *  Omit ⇒ the port has NO `resolveFolder` and every `@folder/` mention
   *  resolves to `null` (byte-identical to the pre-§10.3 composite). */
  readonly folders?: FolderResolverOptions
  /** §10.3 — git-context resolver options (injected provider + byte cap).
   *  Omit ⇒ the port has NO `resolveGit` and every `@git` mention resolves
   *  to `null`. */
  readonly git?: GitResolverOptions
  /** RFC-12-2 — MCP-server resolver options (injected listing port + tool cap).
   *  Omit ⇒ the port has NO `resolveMcp` and every `@mcp:` mention resolves to
   *  `null` (byte-identical to the pre-RFC-12-2 composite). */
  readonly mcp?: McpResolverOptions
  /** RFC-12-2 — named-agent (subagent) registry for `@subagent:`. Omit ⇒ the
   *  port has NO `resolveSubagent` and every `@subagent:` mention resolves to
   *  `null`. */
  readonly subagents?: NamedAgentResolver
  /** RFC-12-2 — prior-thread resolver options (injected summary port). Omit ⇒
   *  the port has NO `resolveThread` and every `@thread:` mention resolves to
   *  `null`. */
  readonly threads?: ThreadResolverOptions
}

/**
 * Build a {@link MentionResolverPort} that delegates each kind to its own
 * sub-resolver. Pure factory — the returned port holds only closure
 * references to the dependency bag fields.
 */
export const createCompositeMentionResolver = (
  deps: CompositeResolverDeps = {},
): MentionResolverPort => {
  const base: MentionResolverPort = {
    resolveSkill: createSkillResolver(deps.skills),
    resolvePlugin: createPluginResolver(deps.plugins),
    resolveApp: createAppResolver(deps.apps),
  }
  // ADR-0418 — only attach file / symbol methods when their dep is
  // supplied, so the legacy 3-kind shape (no `resolveFile` /
  // `resolveSymbol` key) is preserved when the caller opts out. The
  // factory return is `... | undefined` (optional port member), but the
  // closure never IS undefined; pin it to a concrete fn type so the
  // `exactOptionalPropertyTypes` assignment to `resolveFile?` is exact.
  if (deps.files !== undefined) {
    base.resolveFile = createFileResolver(deps.files)
  }
  if (deps.symbol !== undefined) {
    base.resolveSymbol = deps.symbol
  }
  // §10.3 — folder + git, attached only when their dep is supplied so the
  // pre-§10.3 port shape (no `resolveFolder` / `resolveGit` key) is preserved
  // when the caller opts out.
  if (deps.folders !== undefined) {
    base.resolveFolder = createFolderResolver(deps.folders)
  }
  if (deps.git !== undefined) {
    base.resolveGit = createGitResolver(deps.git)
  }
  // RFC-12-2 — mcp / subagent / thread, attached only when their dep is
  // supplied so the pre-RFC-12-2 port shape (no `resolveMcp` /
  // `resolveSubagent` / `resolveThread` key) is preserved when the caller opts
  // out (byte-identical default-OFF).
  if (deps.mcp !== undefined) {
    base.resolveMcp = createMcpResolver(deps.mcp)
  }
  if (deps.subagents !== undefined) {
    base.resolveSubagent = createSubagentResolver(deps.subagents)
  }
  if (deps.threads !== undefined) {
    base.resolveThread = createThreadResolver(deps.threads)
  }
  return base
}
