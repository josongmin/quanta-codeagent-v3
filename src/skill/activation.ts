import { gateOn } from "@/shared"
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

/** Does the fixed-width token `tok` match position `j` of `s`? `lit` wants that
 *  exact character; `one` (`?`) wants any character that is not a path
 *  separator. Both fail past the end of the string. Split out of the consume
 *  loop so the loop is a plain "advance while it matches" and the per-kind rule
 *  lives in one expression. */
const fixedTokenMatches = (
  tok: { k: "lit"; c: string } | { k: "one" },
  s: string,
  L: number,
  j: number,
): boolean => (tok.k === "lit" ? j < L && s[j] === tok.c : j < L && s[j] !== "/")

/** Sentinel returned by {@link skipFixedTokens} when a `lit`/`?` token failed
 *  to match. Distinct from every packed cursor, which is always >= 0. */
const FIXED_TOKEN_MISMATCH = -1

/**
 * Consume the maximal run of FIXED-WIDTH tokens (`lit`, `one`) starting at
 * token `ti` / position `si`.
 *
 * WHY THIS IS A UNIT: `step`'s cost was never its length — it was a three-way
 * token-kind dispatch living inside a `while`, inside a function that is itself
 * nested inside `matchFull`, so each of its six guards paid a +2/+3 NESTING
 * surcharge (21 total). Only the fixed-width half of that dispatch needs the
 * loop — that loop exists solely for the R2 stack fix (iterate literals instead
 * of recursing once per character, which blew Node's ~7K-frame default on a
 * 4000-char literal-only glob). The variable-width half is a flat two-case
 * tail. Hoisting the loop to MODULE scope puts it at nesting 0 and leaves
 * `step` as that tail — the same code, none of the surcharge.
 *
 * CONTRACT: returns the cursor packed as `i * (L + 1) + j` — where `i` is the
 * first non-fixed-width token index (or `tokens.length`) and `j` the matching
 * string position — or {@link FIXED_TOKEN_MISMATCH} when a literal / `?` did
 * not match. Packed rather than returned as an object because this runs once
 * per memoized (token, position) cell and must not allocate. `L` is passed in
 * rather than read from `s` so the packing base is the caller's, by
 * construction identical.
 */
const skipFixedTokens = (
  tokens: GlobTok[],
  s: string,
  L: number,
  ti: number,
  si: number,
): number => {
  let i = ti
  let j = si
  while (i < tokens.length) {
    const tok = tokens[i] as GlobTok
    if (tok.k !== "lit" && tok.k !== "one") break
    if (!fixedTokenMatches(tok, s, L, j)) return FIXED_TOKEN_MISMATCH
    i++
    j++
  }
  return i * (L + 1) + j
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
  // Mutually-recursive nested function declarations (hoisted, so `step`/`star`
  // can reference `go`). Split out of one body to keep each under the
  // cognitive-complexity cap; the memo makes the recursion poly-bounded.
  function star(ti: number, si: number, crossSlash: boolean): boolean {
    // consume 0..k chars (crossSlash: any incl `/`; else non-`/`), trying the
    // continuation at each length until one matches.
    let j = si
    for (;;) {
      if (go(ti + 1, j)) return true
      if (j < L && (crossSlash || s[j] !== "/")) j++
      else return false
    }
  }
  function step(ti: number, si: number): boolean {
    const packed = skipFixedTokens(tokens, s, L, ti, si)
    if (packed === FIXED_TOKEN_MISMATCH) return false
    const i = Math.floor(packed / (L + 1))
    const j = packed % (L + 1)
    if (i === T) return j === L
    const tok = tokens[i] as GlobTok
    if (tok.k === "seg") return star(i, j, false)
    return star(i, j, true) // any
  }
  function go(ti: number, si: number): boolean {
    const key = ti * (L + 1) + si
    const cached = memo[key]
    if (cached !== 0) return cached === 1
    const res = step(ti, si)
    memo[key] = res ? 1 : 2
    return res
  }
  return go(0, 0)
}

/** Slash-prefix tokens (`**` + `/`) prepended for the no-slash basename-anywhere
 *  case — see {@link matchesAnyGlob}. Module-level so it is allocated once. */
const ANY_SLASH: GlobTok[] = [{ k: "any" }, { k: "lit", c: "/" }]

/** Hard caps on inputs to {@link matchesAnyGlob}. The DP matcher is
 *  O(tokens·len²) in time and O(tokens·len) in memory (Int8Array memo); without
 *  bounds a malicious 100KB glob or a multi-megabyte path could pin CPU or blow
 *  out memory. Real file paths are bounded by the OS (PATH_MAX = 4096 on Linux);
 *  real globs are short (< 100 chars in practice). The caps below are generous
 *  multiples so legitimate inputs never hit them; over-cap inputs short-circuit
 *  to a no-match (safe failure mode — a malicious oversized glob/path simply
 *  never matches anything). Chosen as power-of-two multiples of the OS limit
 *  rather than n=1-tuned thresholds. */
export const MAX_GLOB_LEN = 4096
export const MAX_PATH_LEN = 8192

/** Combined work-budget cap: T·L (tokens × path length). The per-axis caps above
 *  bound the WORST corner individually, but their *product* still drives matcher
 *  cost — a 4 KiB glob × 8 KiB path is 33M memo cells and the audit measured
 *  ~50 s on hardware. 2²⁰ ≈ 1 M is generous for any realistic glob/path pair
 *  (e.g. T=10, L=8000 = 80k ≪ 1M) and bounds matcher wall-clock to the low ms
 *  range. Over-cap pairs short-circuit to no-match (same safe failure mode). */
export const MAX_GLOB_WORK = 1 << 20

/**
 * True if `path` matches any of the gitignore-style `patterns`. Pure helper:
 * it is exported for a host to call; nothing in this slice calls it.
 *
 * Anchoring (matches the prior `globToRegExp` semantics exactly):
 *   - pattern WITH `/`  ⇒ the pattern must match the whole normalized path.
 *   - pattern WITHOUT `/` ⇒ basename-anywhere: it matches the whole path OR a
 *     suffix that begins right after a `/`. The latter is modelled by trying
 *     the pattern again with a `**\/` prefix (any chars then a `/` boundary).
 *
 * Safety: a `path` longer than {@link MAX_PATH_LEN} or any pattern longer than
 * {@link MAX_GLOB_LEN} is treated as a no-match for that input (matchesAnyGlob
 * still scans the rest of `patterns`). This is the DoS guard for the DP
 * matcher's O(T·L) state-space.
 */
export const matchesAnyGlob = (path: string, patterns: string[]): boolean => {
  // R2 fix: require the dot in the strip regex so an ABSOLUTE path like
  // "/etc/passwd" is NOT silently relativized to "etc/passwd" (the prior
  // `^\.?\/` made the dot optional and silently stripped the leading `/`,
  // which would let `paths: ["etc/**"]` match `/etc/passwd`). `+` strips any
  // run of `./` prefixes (`././x` ⇒ `x`).
  const norm = path.replace(/\\/g, "/").replace(/^(\.\/)+/, "")
  if (norm.length > MAX_PATH_LEN) return false
  return patterns.some((p) => {
    const glob = p.trim()
    if (glob.length === 0 || glob.length > MAX_GLOB_LEN) return false
    // Combined T·L work-budget — even within per-axis caps, the product can
    // still pin CPU on a crafted pair (audit measured ~50s at 4K × 8K).
    if (glob.length * norm.length > MAX_GLOB_WORK) return false
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

/**
 * §2.3 — pure, host-callable filter: given the full skill set, return the subset
 * that may be IMPLICITLY injected into the model context (the suggestion
 * inventory). A skill with `allowImplicitInvocation === false` (codex
 * `policy.allow_implicit_invocation: false`) is EXCLUDED; absent ⇒ included
 * (codex default = implicit allowed).
 *
 * DEFAULT-OFF: when `QUANTA_SKILL_IMPLICIT_POLICY` is not gate-on, returns the
 * input UNCHANGED (byte-identical — the policy flag has no runtime effect until
 * the host opts in). This filters ONLY the implicit-injection set — the EXPLICIT
 * invocation surface (the Skill tool / `$skill`) is NEVER narrowed by this
 * (mirrors `skillsActivatedFor`'s honesty note).
 *
 * `env` is REQUIRED (no `process.env` default): the `@/skill` slice must not
 * read the ambient environment itself (slice-boundary guard — take plain
 * config). The HOST passes `process.env`; tests pass a synthetic bag.
 */
export const implicitlyInvocableSkills = (
  skills: Skill[],
  env: Record<string, string | undefined>,
): Skill[] => {
  if (!gateOn(env, "QUANTA_SKILL_IMPLICIT_POLICY")) return skills
  return skills.filter((s) => s.allowImplicitInvocation !== false)
}
