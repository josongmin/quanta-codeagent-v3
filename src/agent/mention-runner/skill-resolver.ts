/**
 * ADR-0330 / ADR-0418 — Skill-only `MentionResolverPort` impl (async).
 *
 * Builds a `MentionResolverPort` (ADR-0325 + ADR-0418) where:
 *
 *   - `resolveSkill(target)` consults the injected
 *     {@link SkillRegistryReadOnly}. Hit ⇒ `{ bodyText: firstLine }`.
 *     Miss ⇒ `null`. The body text is the FIRST LINE of the
 *     description, NOT the SKILL.md body. Progressive-disclosure
 *     parity with `src/agent/prompt.ts`'s active-skills block.
 *
 *   - `resolvePlugin(target)` ALWAYS returns `null`. Frozen by
 *     ADR-0330 — plugin manifest discovery is the composite resolver.
 *
 *   - `resolveApp(target)` ALWAYS returns `null`. Frozen by ADR-0330 —
 *     the "app" concept requires a quanta surface-model mapping.
 *
 *   - `resolveFile(target)` ALWAYS returns `null`. ADR-0418 negative
 *     invariant — caller wires a file resolver explicitly (composite).
 *
 *   - `resolveSymbol(target)` ALWAYS returns `null`. ADR-0418 negative
 *     invariant — caller wires a symbol resolver explicitly (composite).
 *
 * Async: every method returns `Promise<…>` to match the ADR-0418 port
 * shape. The underlying skill registry is sync (in-memory lookup) — we
 * bridge the sync core to the async port (no artificial latency).
 *
 * NO-THROW: every method swallows registry exceptions and returns
 * `null`. Belt-and-suspenders since {@link buildInjectionFragments}
 * also try/catches at the call site.
 */

import type { MentionResolverPort } from "@/agent/mention-injection"
import { errMessage, logger, mentionFirstLine } from "@/shared"
import type { SkillRegistryReadOnly } from "./types"

/**
 * Safe wrapper around the registry's `lookup`. The registry IS supposed
 * to be NO-THROW (per its own contract), but a hostile / partial impl
 * could throw — we convert that to `null`. Identical pattern to
 * `safeCall` in ADR-0325's resolver wrapper.
 */
const safeLookup = (
  skills: SkillRegistryReadOnly | undefined,
  target: string,
): { name: string; description: string } | null => {
  if (skills === undefined) return null
  try {
    const entry = skills.lookup(target)
    if (entry === null) return null
    // Sanitize at the boundary — registry could be untyped.
    if (typeof entry.description !== "string") return null
    return { name: entry.name, description: entry.description }
  } catch (e) {
    logger.warn(`mention.skill-resolver: ${errMessage(e)}`)
    return null
  }
}

/**
 * Build a {@link MentionResolverPort} that delegates skill resolution
 * to the injected {@link SkillRegistryReadOnly} and statically refuses
 * plugin / app resolution.
 *
 * Pure factory: returns a fresh port object every call, holding only a
 * closure reference to `skills` (or `undefined`). No global state, no
 * I/O, no clock read.
 */
export const createSkillOnlyResolver = (skills?: SkillRegistryReadOnly): MentionResolverPort => {
  return {
    async resolveSkill(target: string) {
      const entry = safeLookup(skills, target)
      if (entry === null) return null
      return { bodyText: mentionFirstLine(entry.description) }
    },
    // Frozen by ADR-0330 — composite resolver closes plugin / app.
    async resolvePlugin(_target: string) {
      return null
    },
    async resolveApp(_target: string) {
      return null
    },
    // Frozen by ADR-0418 negative invariant — caller wires explicitly.
    async resolveFile(_target: string) {
      return null
    },
    async resolveSymbol(_target: string) {
      return null
    },
  }
}
