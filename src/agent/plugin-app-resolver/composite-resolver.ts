/**
 * ADR-0336 — Composite `MentionResolverPort` factory.
 *
 * Composes the three kind-specific resolvers (skill / plugin / app)
 * into a single {@link MentionResolverPort} suitable for the
 * `buildInjectionFragments(...)` consumer at ADR-0325.
 *
 * This is the production sibling to ADR-0330's
 * `createSkillOnlyResolver`. The skill-only flavour is preserved for
 * callers that opt out of plugin / app resolution (e.g. headless
 * CI surfaces, smoke tests). The composite flavour wires all three
 * kinds and closes ADR-0330's two negative invariants
 * (`resolvePlugin → null`, `resolveApp → null`).
 *
 * Kind dispatch is HARD at the parser/runner layer (a `@skill`
 * mention CANNOT fall through to plugin / app), so the composite
 * resolver simply provides three independent function values. Each
 * sub-resolver is NO-THROW; the wrapping `buildInjectionFragments`
 * is also NO-THROW (belt-and-suspenders).
 *
 * Default-OFF: callers that don't construct this factory see
 * byte-identical legacy (ADR-0330 skill-only behaviour).
 */

import type { AppCatalogPort } from "@/agent/app-catalog"
import type { MentionResolverPort } from "@/agent/mention-injection"
import type { PluginRegistryPort } from "@/agent/plugin-discovery"
import { createAppResolver } from "./app-resolver"
import { createFileResolver, type FileResolverOptions } from "./file-resolver"
import { createPluginResolver } from "./plugin-resolver"
import { createSkillResolver } from "./skill-resolver"
import type { SkillRegistryReadOnly } from "./types"

/**
 * Dependency bag for {@link createCompositeMentionResolver}. Every
 * field is optional; omitting one ⇒ that kind always resolves to
 * `null` (skipped). All three optional ⇒ the resolver is functionally
 * equivalent to ADR-0330's `createSkillOnlyResolver()` with no
 * registry (every mention skipped).
 */
export interface CompositeResolverDeps {
  readonly skills?: SkillRegistryReadOnly
  readonly plugins?: PluginRegistryPort
  readonly apps?: AppCatalogPort
  /** ADR-0413 — file-mention resolver options (workspace root + cap).
   *  Omit ⇒ the port has NO `resolveFile` and every `@file` mention
   *  resolves to `null` (skipped) — byte-identical to the legacy
   *  3-kind composite. */
  readonly files?: FileResolverOptions
}

/**
 * Build a {@link MentionResolverPort} that delegates each of the three
 * kinds to its own sub-resolver. Pure factory — the returned port
 * holds only closure references to the dependency bag fields.
 */
export const createCompositeMentionResolver = (
  deps: CompositeResolverDeps = {},
): MentionResolverPort => {
  const resolveSkill = createSkillResolver(deps.skills)
  const resolvePlugin = createPluginResolver(deps.plugins)
  const resolveApp = createAppResolver(deps.apps)
  const base: MentionResolverPort = {
    resolveSkill,
    resolvePlugin,
    resolveApp,
  }
  // ADR-0413 — only attach `resolveFile` when a `files` dep is supplied,
  // so the legacy 3-kind shape (no `resolveFile` key) is preserved when
  // the caller opts out.
  if (deps.files === undefined) return base
  return { ...base, resolveFile: createFileResolver(deps.files) }
}
