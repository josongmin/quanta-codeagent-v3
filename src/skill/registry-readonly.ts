/**
 * ADR-0330 — Read-only descriptor view over {@link SkillRegistry}.
 *
 * Adapter shape designed to mirror the subset of `@/skill` that mention
 * resolution (ADR-0325) needs. Mention resolution must NOT load skill
 * bodies eagerly — progressive disclosure mandates that the `SKILL.md`
 * body loads lazily when the skill is invoked, not when it is mentioned.
 *
 * The adapter projects a {@link SkillRegistryReadOnly} surface that
 * exposes ONE method:
 *
 *   `lookup(name) ⇒ { name, description } | null`
 *
 * `null` is returned for every "not found / unknown" case. The adapter
 * is NO-THROW: a hostile / partially-built `SkillRegistry` (lookup that
 * throws, lookup that returns malformed entries) is converted to `null`
 * by the wrapper.
 *
 * Why read-only:
 *   - Mention resolution does not need scope / installState / sourcePath.
 *     Restricting the surface keeps callers honest about what they may
 *     read (no body-loading shortcuts via the mention path).
 *   - The full `SkillRegistry` interface (entries / bySope / collisions)
 *     stays inside @/skill and is not consumed by @/agent slices via the
 *     mention pipeline.
 *
 * Case sensitivity: skill names are ASCII kebab-case (`[a-z][a-z0-9-]*`)
 * by parser invariant. The mention parser only emits lowercase targets,
 * and `SkillRegistry.lookup` is exact-match. We do NOT canonicalize case
 * here — passing `@Foo` is rejected at parse time, so the registry sees
 * only lowercase names. This is documented as a limitation, NOT a TODO.
 *
 * Slice-fence: lives in @/skill so it has zero cross-slice imports
 * (only @/skill in-slice). @/agent/mention-runner imports IT (allowed —
 * @/agent assembles slices), but THIS file does NOT depend on @/agent
 * or the mention-injection slice.
 */

import type { SkillRegistry } from "./registry"

/**
 * Read-only skill descriptor view. The only field a mention resolver
 * needs at first-line resolution time:
 *
 *   - `name`: the canonical skill id (mirrors `Skill.name`).
 *   - `description`: the SKILL.md frontmatter `description` (or first
 *     body line — see `discoverSkills`). Mention resolver projects the
 *     FIRST LINE only.
 */
export interface SkillReadOnlyDescriptor {
  readonly name: string
  readonly description: string
}

/**
 * Closed read-only port. ONE method (`lookup`). Implementations MUST be
 * NO-THROW: any internal error returns `null`. The default adapter
 * {@link createReadOnlySkillRegistry} wraps every call in a try/catch.
 */
export interface SkillRegistryReadOnly {
  /** Returns the descriptor for `name`, or `null` if unknown / malformed. */
  lookup(name: string): SkillReadOnlyDescriptor | null
}

/**
 * Sanitize a descriptor read out of a `SkillRegistryEntry`. Returns
 * `null` if the entry shape is unexpected (missing name, missing or
 * non-string description). Belt-and-suspenders — `Skill` is typed but
 * registries can be constructed from frontmatter that fails validation
 * at the boundary, so this guards against malformed inputs slipping
 * through the static type.
 */
const sanitize = (
  entry: { skill?: { name?: unknown; description?: unknown } } | undefined | null,
): SkillReadOnlyDescriptor | null => {
  if (entry === undefined || entry === null) return null
  const skill = entry.skill
  if (skill === undefined || skill === null) return null
  if (typeof skill.name !== "string" || skill.name.length === 0) return null
  if (typeof skill.description !== "string") return null
  return { name: skill.name, description: skill.description }
}

/**
 * Build a {@link SkillRegistryReadOnly} view over an existing
 * {@link SkillRegistry}. The returned object holds a closure reference
 * to the underlying registry; callers MUST treat the registry as
 * append-only or rebuild the read-only view on changes (registry is a
 * snapshot per ADR-0134).
 *
 * NO-THROW: a hostile / partial registry (lookup throws, lookup returns
 * a malformed entry) is converted to `null` by {@link sanitize} +
 * try/catch. Empty / undefined name input ⇒ `null` (does not call
 * through).
 */
export const createReadOnlySkillRegistry = (
  registry: Pick<SkillRegistry, "lookup">,
): SkillRegistryReadOnly => {
  return {
    lookup(name: string): SkillReadOnlyDescriptor | null {
      if (typeof name !== "string" || name.length === 0) return null
      try {
        const entry = registry.lookup(name)
        return sanitize(entry)
      } catch {
        return null
      }
    },
  }
}

/**
 * Empty read-only registry. Always returns `null`. Useful as a default
 * in headless / test contexts where no real skill registry is built —
 * mentions then degrade to "all unknown" and produce no fragments.
 */
export const emptyReadOnlySkillRegistry: SkillRegistryReadOnly = {
  lookup: () => null,
}
