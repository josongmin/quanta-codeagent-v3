/**
 * RFC-06 F3 — the live {@link SkillRuntimeReader} over a
 * {@link SkillRuntimeAuthority}.
 *
 * This replaces the construction-time COPY the prompt inventory, ToolSearch, and
 * the `Skill` tool description used to close over. Every method reads the
 * authority's CURRENT published {@link SkillRuntimeView} at call time, so a skill
 * disabled after session start (via the authority's `setEnabled`) disappears
 * from all three discovery surfaces on the NEXT read — there is no stale array.
 *
 * The `paths:` conditional-activation filter and the MCP-deps gate (previously
 * applied once in `buildSkillBlock` over the frozen discovered list) are applied
 * HERE, over the LIVE active projection, on each `activeInventory()` call:
 *   - `changedPaths` unset/empty ⇒ the whole active set (byte-identical to the
 *     pre-F3 identity case);
 *   - set ⇒ unconditional skills (no `paths:`) PLUS the `paths:`-declaring skills
 *     whose globs match a changed path (via the existing `skillsActivatedFor`
 *     helper — no reimplementation).
 * A disabled skill is absent from the active projection, so it is filtered out
 * BEFORE `paths:` matching — a disable wins over a path match.
 *
 * Slice rules: `@/skill` siblings (`../activation`, the runtime authority) +
 * `@/shared` (`runtimeConfig`) only. exactOptionalPropertyTypes: `rawDependencies`
 * is OMITTED unless the gate is on and the skill declares one.
 */

import { runtimeConfig } from "@/shared"
import { skillsActivatedFor } from "../activation"
import type { SkillRegistryEntry } from "../registry"
import type { Skill } from "../types"
import type { SkillRuntimeAuthority } from "./authority"
import type { SkillActiveInventoryEntry, SkillRuntimeReader } from "./types"

/** Options captured for the SESSION (not per read): the changed-path set that
 *  drives `paths:` conditional activation. The active/searchable projections
 *  themselves are always read LIVE from the authority. */
export interface SkillRuntimeReaderOptions {
  /** Files in play this session — narrows the per-turn suggestion inventory to
   *  unconditional + path-matched skills. Absent/empty ⇒ the whole active set. */
  readonly changedPaths?: readonly string[] | undefined
}

/** Apply the session's `paths:` conditional-activation filter to a LIVE active
 *  set. Mirrors the pre-F3 `buildSkillBlock` branch verbatim, but over the
 *  authority's current `active` projection instead of the frozen discovered
 *  list. */
const activatedFor = (
  active: readonly Skill[],
  changedPaths: readonly string[] | undefined,
): Skill[] => {
  if (changedPaths === undefined || changedPaths.length === 0) return [...active]
  return [
    ...active.filter((s) => s.paths === undefined || s.paths.length === 0),
    ...skillsActivatedFor([...active], [...changedPaths]),
  ]
}

/**
 * Build a live reader over `authority`. Reads are O(active) projections off the
 * authority's already-derived view — no discovery, no second cache.
 */
export const createSkillRuntimeReader = (
  authority: SkillRuntimeAuthority,
  options: SkillRuntimeReaderOptions = {},
): SkillRuntimeReader => {
  const changedPaths = options.changedPaths
  return {
    activeInventory: (): SkillActiveInventoryEntry[] => {
      // LIVE read: the current active projection (disabled + admin-banned rows
      // already excluded by the authority), THEN the session's path filter.
      const activated = activatedFor(authority.read().active, changedPaths)
      // ADR-0476 — lift `dependencies` onto the channel ONLY when the gate is on
      // AND the skill declared one. Read the gate LIVE (runtimeConfig is frozen
      // per process, so this is byte-identical to reading it once). Gate off ⇒
      // field omitted ⇒ byte-identical inventory shape.
      const wantDeps = runtimeConfig().skillMcpDeps
      return activated.map((s) =>
        wantDeps && s.rawDependencies !== undefined
          ? { name: s.name, description: s.description, rawDependencies: s.rawDependencies }
          : { name: s.name, description: s.description },
      )
    },
    searchable: (): readonly SkillRegistryEntry[] => authority.read().searchable,
    revision: (): number => authority.read().revision,
  }
}
