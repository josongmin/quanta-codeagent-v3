import type { Skill } from "./types"

/**
 * Glob matching for the constructs CC's `paths:` (and `.cursor/rules` `globs:`)
 * use: `**` (any chars incl. `/`, with an optional following `/` convenience),
 * `*` (any run of non-`/`), `?` (one non-`/`), literals. A pattern without a
 * `/` matches a path's basename at any depth (gitignore semantics).
 *
 * ReDoS HARDENING — why this is NOT regex: glob patterns come from attacker-
 * influenceable frontmatter, and the obvious `**`→`.*` translation produces
 * multiple unbounded `.*` quantifiers. A pattern like `**\/x\/**\/x\/**\/x`
 * compiles to `.*x/.*x/.*x` which catastrophically backtracks (O(nᵏ)) on a long
 * NON-matching path and hangs the whole agent — a denial-of-service. There is
 * no regex spelling that is both correct for glob semantics AND backtracking-
 * free (JS lacks atomic groups; possessive quantifiers change matching). So we
 * match with a memoized DP instead: every (token, position) pair is decided at
 * most once, giving a hard O(tokens · len²) ceiling with no exponential blowup.
 */
type GlobTok =
  | { k: "lit"; c: string }
  | { k: "one" } // `?`  — one non-`/`
  | { k: "seg" } // `*`  — run of non-`/`
  | { k: "any" } // `**` — run of anything (incl. `/`)

const tokenize = (glob: string): GlobTok[] => {
  const toks: GlobTok[] = []
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? ""
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++
        if (glob[i + 1] === "/") i++ // `**/` convenience — fold the slash in
        toks.push({ k: "any" })
      } else {
        toks.push({ k: "seg" })
      }
      continue
    }
    if (c === "?") {
      toks.push({ k: "one" })
      continue
    }
    toks.push({ k: "lit", c })
  }
  return toks
}

/** Does `tokens` match the WHOLE of `s` (both ends anchored)? Memoized DP:
 *  `memo[ti*(L+1)+si]` ∈ {0 unknown, 1 true, 2 false}. Recursion depth is
 *  bounded by the token count (each `go` either resolves or steps to `ti+1`),
 *  and the `seg`/`any` consume-loops are iterative with memoized continuations,
 *  so there is no backtracking explosion. */
const matchFull = (tokens: GlobTok[], s: string): boolean => {
  const T = tokens.length
  const L = s.length
  const memo = new Int8Array((T + 1) * (L + 1))
  const go = (ti: number, si: number): boolean => {
    const key = ti * (L + 1) + si
    const cached = memo[key]
    if (cached !== 0) return cached === 1
    let res: boolean
    if (ti === T) {
      res = si === L
    } else {
      const tok = tokens[ti] as GlobTok
      if (tok.k === "lit") {
        res = si < L && s[si] === tok.c && go(ti + 1, si + 1)
      } else if (tok.k === "one") {
        res = si < L && s[si] !== "/" && go(ti + 1, si + 1)
      } else if (tok.k === "seg") {
        // consume 0..k non-`/` chars, trying the continuation at each length
        res = false
        let j = si
        for (;;) {
          if (go(ti + 1, j)) {
            res = true
            break
          }
          if (j < L && s[j] !== "/") j++
          else break
        }
      } else {
        // any: consume 0..k of ANYTHING (including `/`)
        res = false
        let j = si
        for (;;) {
          if (go(ti + 1, j)) {
            res = true
            break
          }
          if (j < L) j++
          else break
        }
      }
    }
    memo[key] = res ? 1 : 2
    return res
  }
  return go(0, 0)
}

/** Slash-prefix tokens (`**` + `/`) prepended for the no-slash basename-anywhere
 *  case — see {@link matchesAnyGlob}. Module-level so it is allocated once. */
const ANY_SLASH: GlobTok[] = [{ k: "any" }, { k: "lit", c: "/" }]

/**
 * True if `path` matches any of the gitignore-style `patterns`. Pure helper:
 * it is exported for a host to call; nothing in this slice calls it.
 *
 * Anchoring (matches the prior `globToRegExp` semantics exactly):
 *   - pattern WITH `/`  ⇒ the pattern must match the whole normalized path.
 *   - pattern WITHOUT `/` ⇒ basename-anywhere: it matches the whole path OR a
 *     suffix that begins right after a `/`. The latter is modelled by trying
 *     the pattern again with a `**\/` prefix (any chars then a `/` boundary).
 */
export const matchesAnyGlob = (path: string, patterns: string[]): boolean => {
  const norm = path.replace(/\\/g, "/").replace(/^\.?\//, "")
  return patterns.some((p) => {
    const glob = p.trim()
    const tokens = tokenize(glob)
    if (glob.includes("/")) return matchFull(tokens, norm)
    return matchFull(tokens, norm) || matchFull([...ANY_SLASH, ...tokens], norm)
  })
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
