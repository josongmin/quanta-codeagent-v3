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
 * Why duplicate instead of importing from `@/agent/mention-runner`:
 * ADR-0330's exported helper is the full-port builder. Extracting
 * the kind-specific factory there would mutate the ADR-0330 slice,
 * which the spec forbids ("ADR-0330 mention-runner 슬라이스
 * mutate X"). Code duplication is intentional and minimal — both
 * helpers share the identical first-line policy.
 */

import type { MentionResolverPort } from "@/agent/mention-injection"
import type { SkillRegistryReadOnly } from "./types"

const firstLineOf = (description: string): string => {
  if (typeof description !== "string" || description.length === 0) return ""
  const nl = description.indexOf("\n")
  const slice = nl === -1 ? description : description.slice(0, nl)
  return slice.endsWith("\r") ? slice.slice(0, -1) : slice
}

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
    return { bodyText: firstLineOf(entry.description) }
  }
}
