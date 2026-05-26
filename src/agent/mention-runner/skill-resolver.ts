/**
 * ADR-0330 — Skill-only `MentionResolverPort` impl.
 *
 * Builds a `MentionResolverPort` (ADR-0325) where:
 *
 *   - `resolveSkill(target)` consults the injected
 *     {@link SkillRegistryReadOnly}. Hit ⇒ `{ bodyText: firstLine }`.
 *     Miss ⇒ `null`. The body text is the FIRST LINE of the
 *     description, NOT the SKILL.md body. Progressive-disclosure
 *     parity with `src/agent/prompt.ts`'s active-skills block.
 *
 *   - `resolvePlugin(target)` ALWAYS returns `null`. Frozen by
 *     ADR-0330 — plugin manifest discovery is a future ADR.
 *
 *   - `resolveApp(target)` ALWAYS returns `null`. Frozen by ADR-0330 —
 *     the "app" concept requires a quanta surface-model mapping that
 *     is a separate ADR.
 *
 * NO-THROW: every method swallows registry exceptions and returns
 * `null`. Belt-and-suspenders since {@link buildInjectionFragments}
 * also try/catches at the call site.
 */

import type { MentionResolverPort } from "@/agent/mention-injection"
import type { SkillRegistryReadOnly } from "./types"

/**
 * Project a description down to its FIRST LINE only. Matches the
 * progressive-disclosure policy in `src/skill/tool-search.ts`'s
 * `splitDescription`: the first line is "everything up to the first
 * newline (LF / CRLF)", with no trimming. Empty description ⇒ "".
 *
 * Why first-line: the SKILL.md description is the user-facing tagline;
 * deeper body is intentionally NOT injected by a mention (only by
 * skill invocation via the `Skill` tool).
 */
const firstLineOf = (description: string): string => {
  if (typeof description !== "string" || description.length === 0) return ""
  const nl = description.indexOf("\n")
  // Defensive: if the description begins with CR (`\r\n`), `\n` lookup
  // still cuts at the LF; we strip a trailing CR so a CRLF file does
  // not bleed a `\r` into the body.
  const slice = nl === -1 ? description : description.slice(0, nl)
  return slice.endsWith("\r") ? slice.slice(0, -1) : slice
}

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
  } catch {
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
    resolveSkill(target: string) {
      const entry = safeLookup(skills, target)
      if (entry === null) return null
      return { bodyText: firstLineOf(entry.description) }
    },
    // Frozen by ADR-0330 — see file header.
    resolvePlugin(_target: string) {
      return null
    },
    resolveApp(_target: string) {
      return null
    },
  }
}
