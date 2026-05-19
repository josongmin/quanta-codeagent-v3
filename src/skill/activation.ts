import type { Skill } from "./types"

/**
 * Compile one gitignore-ish glob pattern to a RegExp. Supports the constructs
 * CC's `paths:` patterns use: `**` (any depth incl. `/`), `*` (no `/`), `?`
 * (single non-`/`), and a leading `**\/` convenience. Patterns without a `/`
 * match a path's basename at any depth (gitignore semantics).
 */
const globToRegExp = (glob: string): RegExp => {
  const hasSlash = glob.includes("/")
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? ""
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` → any chars including path separators; consume optional `/`.
        i++
        if (glob[i + 1] === "/") i++
        re += ".*"
      } else {
        re += "[^/]*"
      }
      continue
    }
    if (c === "?") {
      re += "[^/]"
      continue
    }
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal set of regex metacharacters to escape, not a template placeholder
    if (".+^${}()|[]\\".includes(c)) {
      re += `\\${c}`
      continue
    }
    re += c
  }
  // No slash in the pattern ⇒ match basename anywhere (gitignore behaviour).
  const anchored = hasSlash ? `^${re}$` : `(^|/)${re}$`
  return new RegExp(anchored)
}

/** True if `path` matches any of the gitignore-style `patterns`. */
export const matchesAnyGlob = (path: string, patterns: string[]): boolean => {
  const norm = path.replace(/\\/g, "/").replace(/^\.?\//, "")
  return patterns.some((p) => globToRegExp(p.trim()).test(norm))
}

/**
 * Pure helper for the main thread (analysis §2.5): given the full skill set and
 * the paths the model/user just touched, return the subset of skills whose
 * `paths:` globs match — i.e. the conditional skills that should now activate.
 * Skills without `paths:` are never returned here (they are always-on and
 * surfaced through the normal listing instead). This slice only computes the
 * set; wiring it into the turn loop is a documented main-thread seam.
 */
export const skillsActivatedFor = (skills: Skill[], changedPaths: string[]): Skill[] =>
  skills.filter(
    (s) =>
      s.paths !== undefined &&
      s.paths.length > 0 &&
      changedPaths.some((p) => matchesAnyGlob(p, s.paths as string[])),
  )
