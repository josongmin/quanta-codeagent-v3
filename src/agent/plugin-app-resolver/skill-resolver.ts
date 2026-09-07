/**
 * ADR-0336 — Skill sub-resolver for the composite mention resolver.
 *
 * This is the kind-specific factory used by
 * {@link createCompositeMentionResolver}. It is **distinct from**
 * ADR-0330's `createSkillOnlyResolver` which builds a full
 * `MentionResolverPort` (with frozen-null plugin/app methods). The
 * composite resolver wants ONLY the skill method here, then bolts
 * on plugin / app sub-resolvers in `composite-resolver.ts`.
 *
 * Behaviour parity with ADR-0330's skill resolver is intentional:
 *
 *   - Hit  ⇒ bodyText = first LINE of `description` (LF / CRLF
 *            tolerant — trailing `\r` stripped).
 *   - Miss ⇒ `null` (skip).
 *   - NO-THROW boundary.
 *
 * The first-line projection is owned by the fence-legal `@/shared` leaf so
 * this resolver cannot drift from the other mention consumers.
 */

import type { MentionResolverPort } from "@/agent/mention-injection"
import { mentionFirstLine } from "@/shared"
import type { SkillRegistryReadOnly } from "./types"

const safeLookup = (
  skills: SkillRegistryReadOnly | undefined,
  target: string,
): { name: string; description: string } | null => {
  if (skills === undefined) return null
  try {
    const entry = skills.lookup(target)
    if (entry === null) return null
    if (typeof entry.description !== "string") return null
    return { name: entry.name, description: entry.description }
  } catch {
    return null
  }
}

/**
 * Build the `resolveSkill` method of a {@link MentionResolverPort}.
 *
 * @param skills — read-only registry. Omit ⇒ every skill mention
 *                 resolves to `null` (skipped).
 */
export const createSkillResolver = (
  skills?: SkillRegistryReadOnly,
): MentionResolverPort["resolveSkill"] => {
  return async (target: string) => {
    if (typeof target !== "string" || target.length === 0) return null
    const entry = safeLookup(skills, target)
    if (entry === null) return null
    return { bodyText: mentionFirstLine(entry.description) }
  }
}
