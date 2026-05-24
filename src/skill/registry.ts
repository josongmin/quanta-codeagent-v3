/**
 * Skill registry (ADR-0134 §1 + §4) — 7-source discovery + name-collision
 * precedence resolver + per-entry effective-scope log.
 *
 * Why a registry on top of {@link discoverSkills}: the underlying discovery
 * function is path-scoped (one source ⇒ one Skill[]). The registry merges
 * outputs from up to 7 sources (admin / repo / team / user / personal /
 * system / builtIn), applies the fixed precedence
 * {@link SKILL_SCOPES_PRECEDENCE_DESC}, and records every shadowed entry so
 * a host (or `skill list` CLI) can surface "the version from `admin` won
 * over the version from `user`".
 *
 * Closed port (ADR-0083 / [[branch-search-adr0083]]): all source discovery
 * goes through {@link discoverSkillSourcesIn} which takes a {@link
 * SkillRegistryOptions} bag of pre-resolved directories. The default
 * resolver {@link defaultSkillSources} reads QUANTA_ORG_CONFIG_DIR + repoRoot
 * + homeDir but is a pure transformation — every test injects fixtures and
 * never touches the real fs.
 *
 * NO caching at this layer. The ADR mentions a 24h TTL cache; that lives in
 * a (future) host adapter — the registry itself is deterministic and side-
 * effect-free given its inputs, which is what makes it testable. A host
 * that wants 24h caching wraps `buildSkillRegistry` and memoizes by
 * (resolved-sources-fingerprint).
 */

import { join } from "node:path"
import { discoverSkills } from "./discover"
import { SKILL_SCOPES_PRECEDENCE_DESC, type Skill, type SkillScope, skillScope } from "./types"

/**
 * One scope's source directory. `dir === null` means "this scope is not
 * configured on this host" (skipped silently — distinct from "configured
 * but empty", which yields []).
 */
export interface SkillSource {
  readonly scope: SkillScope
  readonly dir: string | null
}

/** Inputs to {@link defaultSkillSources}. All fields optional. */
export interface SkillSourceInputs {
  /** Repo root (`<repo>/.quanta/skills/`, `<repo>/.team-skills/`). */
  readonly repoRoot?: string | null
  /** User home (`~/.quanta/skills/`, `~/.quanta/personal-skills/`, `~/.claude/skills/`). */
  readonly homeDir?: string | null
  /** Org config dir (`$QUANTA_ORG_CONFIG_DIR` or `~/.config/quanta/org/`). */
  readonly orgConfigDir?: string | null
  /** Bundled system-skills dir (resolved by caller — usually `systemSkillsDir()`). */
  readonly systemSkillsDir?: string | null
}

/**
 * Build the canonical 7-source layout from a host's inputs. Each scope maps
 * to ONE directory (or null when the input is missing).
 *
 * `builtIn` is intentionally absent here: builtIn skills are in-code (no
 * directory) and are merged in via {@link buildSkillRegistry}'s
 * `extraSkills` knob, not via source-dir discovery.
 */
export const defaultSkillSources = (inp: SkillSourceInputs): readonly SkillSource[] => {
  const sources: SkillSource[] = []
  sources.push({
    scope: "admin",
    dir: inp.orgConfigDir ? join(inp.orgConfigDir, "admin-skills") : null,
  })
  sources.push({
    scope: "repo",
    dir: inp.repoRoot ? join(inp.repoRoot, ".quanta", "skills") : null,
  })
  sources.push({
    scope: "team",
    dir: inp.repoRoot ? join(inp.repoRoot, ".team-skills") : null,
  })
  sources.push({
    scope: "user",
    dir: inp.homeDir ? join(inp.homeDir, ".quanta", "skills") : null,
  })
  sources.push({
    scope: "personal",
    dir: inp.homeDir ? join(inp.homeDir, ".quanta", "personal-skills") : null,
  })
  sources.push({
    scope: "system",
    dir: inp.systemSkillsDir ?? null,
  })
  return sources
}

/**
 * Pre-0134 backward-compat shim: if the homeDir is configured but the
 * canonical `~/.quanta/skills/` source is empty, we ALSO scan
 * `~/.claude/skills/` (pre-0134 location) and tag results as 'user'. Hosts
 * doing a clean migration can disable this by passing
 * `legacyClaudeSkillsFallback: false`.
 */
export interface SkillRegistryOptions extends SkillSourceInputs {
  /** Force-merge in-code Skill[] (typically the bundled builtIn set — none today). */
  readonly extraSkills?: readonly Skill[]
  /** Default true — see {@link SkillRegistryOptions}. */
  readonly legacyClaudeSkillsFallback?: boolean
}

/** One resolved-name entry in the registry. */
export interface SkillRegistryEntry {
  /** The winning skill (highest scope per precedence). */
  readonly skill: Skill
  /** The winning scope (mirror of `skill.scope`, set by {@link skillScope}). */
  readonly winnerScope: SkillScope
  /**
   * Every other scope that ALSO provided a skill with this name, in
   * descending-precedence order. Empty when there was no collision.
   */
  readonly overriddenScopes: readonly SkillScope[]
}

/** Per-name collision warning the registry emits. */
export interface SkillRegistryCollision {
  readonly name: string
  readonly winnerScope: SkillScope
  readonly overriddenScopes: readonly SkillScope[]
}

/** The full registry. */
export interface SkillRegistry {
  /** All entries, sorted alphabetically by name (deterministic). */
  readonly entries: readonly SkillRegistryEntry[]
  /** Convenience: name → entry. */
  lookup(name: string): SkillRegistryEntry | undefined
  /** Convenience: scope → skills tagged with that scope (winner-only). */
  bySope(scope: SkillScope): readonly Skill[]
  /** Every name collision encountered, in name order. */
  readonly collisions: readonly SkillRegistryCollision[]
}

/**
 * Discover skills from each configured source directory in parallel. Sources
 * with `dir: null` yield []. The returned shape is one bucket per scope so
 * the precedence resolver downstream can iterate predictably.
 */
const discoverSkillSourcesIn = async (
  sources: readonly SkillSource[],
): Promise<ReadonlyMap<SkillScope, readonly Skill[]>> => {
  const out = new Map<SkillScope, readonly Skill[]>()
  await Promise.all(
    sources.map(async (src) => {
      if (src.dir === null) {
        out.set(src.scope, [])
        return
      }
      const skills = await discoverSkills(src.dir)
      // Discovery's path inference may tag a skill with the WRONG scope when
      // the user mounts (e.g.) `~/.quanta/skills/foo` AT an admin-skills/
      // path. The registry is the SSOT for scope: override the discovery
      // tag with the source's declared scope. (Explicit frontmatter still
      // wins, because discovery sets scope from frontmatter > path infer;
      // we only override when path inference produced a different scope
      // than the source claims.)
      const retagged = skills.map((s) =>
        skillScope(s) === src.scope ? s : { ...s, scope: src.scope },
      )
      out.set(src.scope, retagged)
    }),
  )
  return out
}

/**
 * Run the legacy `~/.claude/skills/` fallback if enabled and the canonical
 * `~/.quanta/skills/` source is empty. Returns the user-tagged skills
 * (possibly empty). Pre-0134 backward compat invariant.
 */
const loadLegacyUserSkills = async (
  opts: SkillRegistryOptions,
  userBucket: readonly Skill[],
): Promise<readonly Skill[]> => {
  if (opts.legacyClaudeSkillsFallback === false) return []
  if (opts.homeDir === null || opts.homeDir === undefined) return []
  if (userBucket.length > 0) return []
  const legacyDir = join(opts.homeDir, ".claude", "skills")
  const skills = await discoverSkills(legacyDir)
  return skills.map((s) => (skillScope(s) === "user" ? s : { ...s, scope: "user" as const }))
}

/**
 * Merge all buckets under the fixed precedence
 * {@link SKILL_SCOPES_PRECEDENCE_DESC} and emit collision warnings.
 */
const resolveByPrecedence = (
  buckets: ReadonlyMap<SkillScope, readonly Skill[]>,
): { entries: SkillRegistryEntry[]; collisions: SkillRegistryCollision[] } => {
  // Per-name accumulator: every scope that provided this name, in DESCENDING
  // precedence order. The first one wins.
  const byName = new Map<string, { winner: Skill; overridden: SkillScope[] }>()
  for (const scope of SKILL_SCOPES_PRECEDENCE_DESC) {
    const bucket = buckets.get(scope) ?? []
    for (const sk of bucket) {
      const existing = byName.get(sk.name)
      if (existing === undefined) {
        byName.set(sk.name, { winner: sk, overridden: [] })
      } else {
        existing.overridden.push(scope)
      }
    }
  }
  const entries: SkillRegistryEntry[] = []
  const collisions: SkillRegistryCollision[] = []
  // Sorted output ⇒ deterministic.
  const names = [...byName.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  for (const name of names) {
    const acc = byName.get(name)
    if (acc === undefined) continue
    const winnerScope = skillScope(acc.winner)
    entries.push({ skill: acc.winner, winnerScope, overriddenScopes: acc.overridden })
    if (acc.overridden.length > 0) {
      collisions.push({ name, winnerScope, overriddenScopes: acc.overridden })
    }
  }
  return { entries, collisions }
}

/**
 * Build a {@link SkillRegistry} from {@link SkillRegistryOptions}. Pure
 * orchestrator: derives sources via {@link defaultSkillSources}, discovers
 * each in parallel, applies legacy fallback, and runs the precedence
 * resolver. No caching, no global state — the registry is a snapshot.
 */
export const buildSkillRegistry = async (opts: SkillRegistryOptions): Promise<SkillRegistry> => {
  const sources = defaultSkillSources(opts)
  const buckets = new Map<SkillScope, Skill[]>()
  const sourceBuckets = await discoverSkillSourcesIn(sources)
  for (const [k, v] of sourceBuckets.entries()) buckets.set(k, [...v])
  // Legacy ~/.claude/skills/ fallback fills the user bucket if empty.
  const legacy = await loadLegacyUserSkills(opts, buckets.get("user") ?? [])
  if (legacy.length > 0) buckets.set("user", [...legacy])
  // Builtin: in-code skills supplied by the host (none today). Tag scope
  // defensively even though the caller is expected to set it.
  if (opts.extraSkills && opts.extraSkills.length > 0) {
    const retagged: Skill[] = opts.extraSkills.map((s) =>
      skillScope(s) === "builtIn" ? s : { ...s, scope: "builtIn" as const },
    )
    buckets.set("builtIn", retagged)
  }
  const { entries, collisions } = resolveByPrecedence(buckets)
  const byName = new Map(entries.map((e) => [e.skill.name, e]))
  const byScope = new Map<SkillScope, Skill[]>()
  for (const e of entries) {
    const arr = byScope.get(e.winnerScope) ?? []
    arr.push(e.skill)
    byScope.set(e.winnerScope, arr)
  }
  return {
    entries,
    collisions,
    lookup: (name) => byName.get(name),
    bySope: (scope) => byScope.get(scope) ?? [],
  }
}
