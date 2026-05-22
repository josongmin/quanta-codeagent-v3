import type { Skill } from "./types"

/**
 * Compile one gitignore-ish glob pattern to a RegExp. Supports the constructs
 * CC's `paths:` patterns use: `**` (any depth incl. `/`), `*` (no `/`), `?`
 * (single non-`/`), and a leading `**\/` convenience. Patterns without a `/`
 * match a path's basename at any depth (gitignore semantics).
 *
 * ReDoS HARDENING: glob patterns come from attacker-influenceable frontmatter
 * (skill `paths:` and `.cursor/rules` `globs:`). A naive translation emits a
 * `.*` per `**`, so `**\/**\/**\/x` becomes `.*.*.*x` — ADJACENT unbounded
 * quantifiers over overlapping classes, which catastrophically backtrack
 * (O(nᵏ)) on a long non-matching path and hang the agent. We collapse adjacent
 * wildcards via {@link pushWildcard}: a run of `**`/`*` reduces to a single
 * `.*` (or `[^/]*`), which is semantically identical (one star already matches
 * "anything") but leaves NO adjacent-quantifier ambiguity to backtrack on.
 */
const globToRegExp = (glob: string): RegExp => {
  const hasSlash = glob.includes("/")
  const parts: string[] = []
  // Append a wildcard token, collapsing it into an adjacent wildcard so the
  // compiled regex never contains a `.*.*` / `[^/]*[^/]*` / `.*[^/]*` run.
  // `.*` is the dominant class (matches `/` too) and absorbs any adjacent
  // wildcard; `[^/]*` absorbs an adjacent `[^/]*`. Correctness-preserving.
  const pushWildcard = (token: ".*" | "[^/]*"): void => {
    const prev = parts[parts.length - 1]
    if (token === ".*") {
      if (prev === ".*") return
      if (prev === "[^/]*") parts[parts.length - 1] = ".*"
      else parts.push(".*")
      return
    }
    if (prev === ".*" || prev === "[^/]*") return
    parts.push("[^/]*")
  }
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? ""
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` → any chars including path separators; consume optional `/`.
        i++
        if (glob[i + 1] === "/") i++
        pushWildcard(".*")
      } else {
        pushWildcard("[^/]*")
      }
      continue
    }
    if (c === "?") {
      parts.push("[^/]")
      continue
    }
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal set of regex metacharacters to escape, not a template placeholder
    if (".+^${}()|[]\\".includes(c)) {
      parts.push(`\\${c}`)
      continue
    }
    parts.push(c)
  }
  const re = parts.join("")
  // No slash in the pattern ⇒ match basename anywhere (gitignore behaviour).
  const anchored = hasSlash ? `^${re}$` : `(^|/)${re}$`
  return new RegExp(anchored)
}

/**
 * True if `path` matches any of the gitignore-style `patterns`. Pure helper:
 * it is exported for a host to call; nothing in this slice calls it.
 */
export const matchesAnyGlob = (path: string, patterns: string[]): boolean => {
  const norm = path.replace(/\\/g, "/").replace(/^\.?\//, "")
  return patterns.some((p) => globToRegExp(p.trim()).test(norm))
}

/**
 * Pure, host-callable helper: given the full skill set and the paths the
 * model/user just touched, return the subset of skills whose `paths:` globs
 * match — i.e. the conditional skills a host *could* choose to activate.
 * Skills without `paths:` are never returned here.
 *
 * Honesty note: this slice does NOT WATCH the filesystem. `paths:` only takes
 * effect when a host passes `changedPaths` to it — directly, or via
 * `AgentConfig.skills.changedPaths` (the agent slice wires that into the
 * per-turn skill-suggestion inventory in `features.ts`). Without
 * `changedPaths` from a host, declaring `paths:` has no runtime effect: a
 * skill with `paths:` is still present in the unconditional inventory, and
 * a skill without `paths:` is unaffected by this filter at all. The
 * invocable surface (the `Skill` tool) is NEVER narrowed — only the
 * suggestion inventory is.
 */
export const skillsActivatedFor = (skills: Skill[], changedPaths: string[]): Skill[] =>
  skills.filter(
    (s) =>
      s.paths !== undefined &&
      s.paths.length > 0 &&
      changedPaths.some((p) => matchesAnyGlob(p, s.paths as string[])),
  )
