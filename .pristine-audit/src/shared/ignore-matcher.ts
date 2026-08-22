/**
 * Shared `.gitignore` / `.quantaignore` matcher (extracted from
 * `default-scanner.ts`, ADR-0277).
 *
 * Lives in `@/shared` (the lowest layer) because TWO subsystems consume it:
 * the retrieval indexer's workspace walk AND the CLI `@`-autocomplete
 * recursive file lister (whose slice-fence only permits `@/shared` + node).
 * A query candidate is therefore ignored by exactly the same rules the
 * indexer skips. The code is a verbatim move (no behaviour change); the
 * indexer hellgate (`tests/unit/retrieval/indexer-hellgate.test.ts`,
 * HELL-IDX-*) still pins the semantics.
 *
 * Dialect (subset of gitignore): blank lines + `#` comments skip; `!pattern`
 * re-includes a prior-excluded path (last match wins); a leading `/` anchors
 * to root, a trailing `/` matches directories only, `**` matches across
 * directory boundaries, otherwise the pattern matches against any path
 * segment. Paths are matched FORWARD-slash relative (use {@link toPosix}).
 */

import { promises as fsp } from "node:fs"
import { join, sep } from "node:path"

/** Normalise OS path separators to forward slashes for stable matching. */
export const toPosix = (p: string): string => (sep === "/" ? p : p.split(sep).join("/"))

/** Translate a glob (subset: `**`, `*`, `?`, literal) to a RegExp anchored
 *  at the workspace root. We accept the dialect `src/**\/*.ts` — sufficient
 *  for the canonical default. Out-of-dialect callers can pass a wider glob
 *  like `**\/*` and filter post-hoc with their own predicate (future hook). */
export const globToRegex = (glob: string): RegExp => {
  let out = "^"
  let i = 0
  while (i < glob.length) {
    const c = glob[i] as string
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` matches across directory boundaries.
        out += ".*"
        i += 2
        // Eat a trailing `/` after `**` so `src/**\/foo` matches `src/foo`.
        if (glob[i] === "/") i++
        continue
      }
      // `*` matches anything except `/`.
      out += "[^/]*"
      i++
      continue
    }
    if (c === "?") {
      out += "[^/]"
      i++
      continue
    }
    if (c === ".") {
      out += "\\."
      i++
      continue
    }
    out += c.replace(/[\\$+()[\]{}|^]/g, "\\$&")
    i++
  }
  out += "$"
  return new RegExp(out)
}

/** Decides whether a workspace-relative path is ignored, and whether a
 *  directory must still be descended (a negated rule may re-include a child
 *  of an ignored directory). */
export interface IgnoreMatcher {
  isIgnored(relPath: string): boolean
  shouldDescend(relDir: string): boolean
}

/** Parse a `.gitignore`-style file body. Empty lines + `#` comments are
 *  skipped; lines starting with `!` are re-include rules. Returns a
 *  matcher that walks the rules in declaration order — last match wins.
 *  Subset of gitignore semantics: prefix `/` anchors to root, trailing
 *  `/` matches directories, `**` matches across boundaries, otherwise
 *  the pattern is a substring match against any path segment. */
export const parseIgnore = (body: string): IgnoreMatcher => {
  type Rule = {
    readonly regex: RegExp
    readonly negate: boolean
    readonly dirOnly: boolean
    readonly rawPattern: string
    readonly anchored: boolean
  }
  const rules: Rule[] = []
  for (const raw of body.split("\n")) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) continue
    let pat = line
    const negate = pat.startsWith("!")
    if (negate) pat = pat.slice(1)
    const dirOnly = pat.endsWith("/")
    if (dirOnly) pat = pat.slice(0, -1)
    if (pat === "") continue
    // Anchored at root vs match-anywhere.
    const anchored = pat.startsWith("/")
    if (anchored) pat = pat.slice(1)
    const regexSrc = anchored
      ? `^${globToRegex(pat).source.slice(1, -1)}(?:/.*)?$`
      : `(?:^|/)${globToRegex(pat).source.slice(1, -1)}(?:/.*)?$`
    rules.push({ regex: new RegExp(regexSrc), negate, dirOnly, rawPattern: pat, anchored })
  }
  const isIgnored = (relPath: string): boolean => {
    let ignored = false
    for (const r of rules) {
      if (r.regex.test(relPath)) ignored = !r.negate
    }
    return ignored
  }
  const mayNeedDescend = (relDir: string): boolean => {
    const dirPrefix = relDir === "" ? "" : `${relDir}/`
    return rules.some((r) => {
      if (!r.negate) return false
      if (!r.anchored && !r.rawPattern.includes("/")) return true
      if (/[*?]/.test(r.rawPattern)) return true
      return r.rawPattern === relDir || r.rawPattern.startsWith(dirPrefix)
    })
  }
  return {
    isIgnored,
    shouldDescend: (relDir: string): boolean => !isIgnored(relDir) || mayNeedDescend(relDir),
  }
}

/** A matcher that ignores nothing — used when ignore-file honouring is off
 *  or no ignore files are present. */
export const EMPTY_MATCHER: IgnoreMatcher = {
  isIgnored: () => false,
  shouldDescend: () => true,
}

/** Load and combine ignore files present at `root`. Missing files are
 *  silently ignored (matches Cursor / git behaviour). NO-THROW. */
export const loadIgnore = async (root: string, honor: boolean): Promise<IgnoreMatcher> => {
  if (!honor) return EMPTY_MATCHER
  const bodies: string[] = []
  for (const name of [".gitignore", ".quantaignore"]) {
    try {
      const buf = await fsp.readFile(join(root, name), "utf8")
      bodies.push(buf)
    } catch (_e) {
      // ENOENT / EACCES — silently skip.
    }
  }
  if (bodies.length === 0) return EMPTY_MATCHER
  return parseIgnore(bodies.join("\n"))
}
