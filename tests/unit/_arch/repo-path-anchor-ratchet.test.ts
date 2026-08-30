/**
 * Ratchet — a test that reads the repo must anchor on ITSELF, not on the cwd.
 *
 * ## The root cause this exists for
 *
 * 72 test files hand-roll their own repo scan (`readdirSync` over `src/`,
 * `tests/` or `tools/`), and there is no shared scanner. Each one independently
 * decides three things: where the repo root is, which directories to skip, and
 * what an empty result means. Deciding the first of those 72 times is why the
 * same defect kept arriving from different authors — nine separate instances
 * were found and fixed on 2026-08-25/26 alone, in files written by four
 * different people.
 *
 * A bare `readdirSync("src/apps/cli")` or `readFileSync("src/apps/cli/index.ts")`
 * works only because someone happened to launch from the repo root. Launched
 * from anywhere else — a sandboxed working directory, an editor's test runner, a
 * CI step with a different `working-directory` — it resolves somewhere else
 * entirely.
 *
 * ## Why this is worse than an ordinary broken path
 *
 * The failure is not always loud. Measured on the nine:
 *
 *   - Seven failed LOUDLY under a foreign cwd (ENOENT, or a shell-out matching
 *     nothing). Recoverable, if noisy.
 *   - `cli-feature-gates-drift` inverted to VACUOUSLY GREEN in the dangerous
 *     direction: it shells out to `rg … src` and treats "no match" as "this gate
 *     has no consumer". Under a foreign cwd `rg` matched nothing, so every gate
 *     read as unconsumed — a guard whose verdict is derived from a scan cannot
 *     tell "clean" from "I never looked".
 *   - `loadFeaturesStrict(dir = "tools/feature-catalog/features")` had the same
 *     shape one layer down, in a LOADER, so every consumer inherited it and "no
 *     features loaded" read as a clean catalog to all of them.
 *
 * So the rule is enforced structurally rather than left to each author: a repo
 * path in a test must be built from `import.meta.dir` / `__dirname` /
 * `new URL(…, import.meta.url)`, which are properties of the FILE and cannot
 * drift with the process.
 *
 * ## What is pinned, and what is deliberately not
 *
 * Only literal repo-root-relative paths handed to a filesystem or shell call —
 * `readFileSync("src/…")`, `readdirSync("tools/…")`, `Bun.file("tests/…")`,
 * `execSync("rg … src")`. A string that merely CONTAINS `"src/"` (a fixture
 * path inside synthetic input, an `endsWith("src/foo.ts")` predicate over paths
 * the test was handed) is not a filesystem read and is not flagged — that
 * distinction is what a cruder scan gets wrong, and it produced a false positive
 * on `eval-generator-validation.test.ts`, which scans a temp directory it made.
 *
 * The ceiling is a COUNT, not zero-tolerance-by-name, so a genuinely-justified
 * site can be admitted deliberately rather than by weakening the detector.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { assertScanPopulation } from "../_shared/scan-population"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

/**
 * Filesystem and shell entry points that take the path as their first argument.
 *
 * An ALLOWLIST, chosen after measuring the alternative. Inverting it — "any call
 * receiving a repo-relative literal, minus a denylist of string predicates" —
 * catches the hand-rolled `walk("src/apps/cli")` shape, but on this tree it
 * reports 147 files of which nearly all are synthetic fixtures
 * (`hit("src/a.ts")`, `diff("src/core.py")`) or local helpers that already
 * anchor internally. Adding an on-disk existence check only narrows that to 94.
 * Neither variant can tell `read("src/x.ts")` — a helper that resolves against
 * `REPO_ROOT` — from one that does not, without following the binding.
 *
 * A ratchet that cries wolf 90 times gets its detector weakened, not its
 * offenders fixed. So this one is precise and states its gap.
 */
const FS_ENTRY_POINTS =
  /\b(readFileSync|readdirSync|existsSync|statSync|lstatSync|readFile|readdir|stat|createReadStream|globSync|opendirSync|opendir|readlinkSync|readlink|cpSync|watch|watchFile|Bun\.file|Glob)\s*\(\s*(?:\[\s*)?["'`]([^"'`\n]+)["'`]/g

/**
 * `Glob` takes the PATTERN in its constructor and the ROOT at the call — and the
 * root is the part that resolves against the cwd.
 *
 * `FS_ENTRY_POINTS` already holds `Glob`, but only in the first-argument
 * position, which catches a pattern that is
 * itself repo-rooted (`new Glob("src/…")`, which only matches when launched
 * from the repo root) and misses `new Bun.Glob("…").scanSync("src")` entirely —
 * there the path is one call later. Both positions are real; each on its own is half the shape.
 *
 * Measured on this tree: every live `.scan`/`.scanSync` passes an anchored
 * BINDING (`glob.scanSync(abs)` where `abs` came from `import.meta.url`), so
 * this position exposed NO offender. It is here as prevention, and the cases
 * below say so rather than dressing a synthetic fixture up as a find.
 */
const GLOB_SCAN_ENTRY_POINTS = /\.\s*(scan|scanSync)\s*\(\s*["'`]([^"'`\n]+)["'`]/g

/**
 * Shell-outs hide the path inside the command string rather than as the argument.
 *
 * The delimiter is back-referenced so the capture runs to the CLOSING quote of the
 * same kind. An earlier `[^`"']*` stopped at the first quote of ANY kind, so
 * `execSync("grep -rhoE 'name: …' src/tool …")` captured only `grep -rhoE ` and
 * everything that mattered sat past the inner `'`. That is how the flagship
 * offender — `tool-surface-manifest-hellgate`, 3 failures under a foreign cwd —
 * stayed invisible while this ratchet reported the tree clean.
 */
const SHELL_ENTRY_POINTS =
  /\b(execSync|spawnSync|Bun\.spawnSync|Bun\.spawn)\s*\(\s*(["'`])((?:\\.|(?!\2)[\s\S])*?)\2/g

/**
 * `Bun.$` is a shell-out with no argument list at all — the command is a TAGGED
 * TEMPLATE, so `SHELL_ENTRY_POINTS` (which needs `name(` then a quote) cannot see
 * it, and its cwd anchor is a `.cwd(dir)` METHOD rather than an options object.
 *
 * Measured on this tree: ZERO live uses. Nothing is imported as `$` from `"bun"`
 * and the only `Bun.$` occurrences are two string literals naming it as data.
 * This is prevention, and the two synthetic cases below are labelled as
 * synthetic — a widening that finds nothing must say so rather than look like
 * coverage.
 *
 * Two forms, and the bare one is GATED on the binding actually being imported
 * from `"bun"`. Without that gate `` $` `` matches the tail of any template
 * literal ending in a `$` — this repo has ~20 of them (`` `^${re}$` ``,
 * `` "$& $` $$ $'" ``) and every one would be a false positive. The gate is what
 * keeps this addition at zero.
 */
const BUN_SHELL_BINDING =
  /\{[^}\n]*\$[^}\n]*\}\s*(?:from\s*["']bun["']|=\s*(?:await\s+)?(?:import|require)\s*\(\s*["']bun["'])/
const BUN_SHELL_MEMBER = /\bBun\.\$\s*`((?:\\.|[^`])*)`/g
const BUN_SHELL_BARE = /(?<![A-Za-z0-9_$.)\]}"'])\$\s*`((?:\\.|[^`])*)`/g

const REPO_RELATIVE_ARG = /^(src|tests|tools|docs|scripts)(\/|$)/
const REPO_RELATIVE_IN_COMMAND = /(^|\s)(src|tests|tools|docs|scripts)(\/|\s|$)/

/**
 * An explicit cwd IS an anchor — `execSync("rg … src", {cwd: REPO_ROOT})` is the
 * FIXED form of this very defect, and flagging it would ask the author to undo
 * the fix. Two spellings, because `Bun.$` anchors with a method:
 * `` await $`…`.cwd(REPO_ROOT) ``.
 *
 * `.cwd(` requires a non-empty argument on purpose, so a nearby `process.cwd()`
 * — which READS the ambient cwd rather than pinning one — cannot vouch for a
 * call it has nothing to do with.
 */
const CWD_ANCHOR = /\bcwd\s*:|\.cwd\s*\(\s*[A-Za-z_$"'`]/

/**
 * Scoped to the 200 characters after the call so a `cwd:` belonging to some later
 * spawn cannot vouch for this one.
 */
const hasCwdAnchor = (source: string, from: number): boolean =>
  CWD_ANCHOR.test(source.slice(from, from + 200))
const templatePlaceholder = (name: string): string => ["$", "{", name, "}"].join("")

/**
 * Comments removed, STRING LITERALS LEFT ALONE.
 *
 * The shared `stripComments` in `slice-boundary-scanner.ts` is two regexes over
 * the whole file, so a `/**\u002a/`-shaped substring inside a *string* is a block
 * comment to it. Measured:
 *
 *   stripComments('globSync("src/' + STARS + '/*.ts")')  →  'globSync("src*.ts")'
 *
 * `src/` + `**` + `/` + `*.ts` opens at the `/` + `*` and closes at the next
 * `*` + `/`, and the `src/` prefix — the only thing `REPO_RELATIVE_ARG` matches
 * on — is destroyed. That silently disarmed BOTH `globSync` and the `Glob`
 * constructor position that has been in `FS_ENTRY_POINTS` since this ratchet was
 * written, for the single most common way anyone writes a glob. A detector
 * blinded by its own pre-processing is the same defect this file exists for, one
 * layer down.
 *
 * The shared helper is deliberately NOT changed: 54–60 consumers depend on its
 * current output, and broadening what they see is a separate, measured decision.
 * This scanner keeps its two semantics exactly — block comments anywhere, and
 * `//` comments only when they START a line, so a mid-line `//` inside a URL or a
 * regex survives — and differs only in that it does not look inside a literal.
 */
/** From the opening quote to its match, escapes carried through verbatim. */
const readStringLiteral = (src: string, open: number): string => {
  const quote = src[open] as string
  let out = quote
  let i = open + 1
  while (i < src.length) {
    const ch = src[i] as string
    if (ch === "\\") {
      out += ch + (src[i + 1] ?? "")
      i += 2
      continue
    }
    out += ch
    i++
    if (ch === quote) break
  }
  return out
}

/**
 * A `/` here opens a REGEX LITERAL rather than a division.
 *
 * Needed because a regex literal is allowed to contain quote characters, and
 * this repo has them: `tools/feature-catalog/test-audit.ts` holds
 * `/readFile(?:Sync)?\s*\(\s*["'`](?:\.\.\/)*src\//`. A scanner that took that
 * `"` for the start of a string desynced for the rest of the file and reported
 * the `readFileSync("src/...")` inside the JSDoc BELOW it as live code — a false
 * positive, in the one directory this campaign is not allowed to touch.
 *
 * The classic previous-token heuristic: after an operator, a punctuator or one of
 * the keywords, a `/` is a regex; after an identifier, a literal, `)` or `]` it is
 * division. Only the last 32 characters are inspected, so this stays O(1) per
 * slash.
 */
const REGEX_PRECEDERS = "(,=:[!&|?{};+-*%~^"
const REGEX_KEYWORDS =
  /\b(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/

const opensRegexLiteral = (emitted: string): boolean => {
  const tail = emitted.slice(-32).replace(/\s+$/, "")
  if (tail === "") return true
  return REGEX_PRECEDERS.includes(tail[tail.length - 1] as string) || REGEX_KEYWORDS.test(tail)
}

/**
 * From the opening `/` to its match, honouring `\` escapes and `[...]` classes.
 * A newline means it was not a regex after all, so only the `/` is consumed.
 */
const readRegexLiteral = (src: string, open: number): string => {
  let i = open + 1
  let inClass = false
  while (i < src.length) {
    const ch = src[i] as string
    if (ch === "\\") {
      i += 2
      continue
    }
    if (ch === "\n") return "/"
    if (ch === "[") inClass = true
    else if (ch === "]") inClass = false
    else if (ch === "/" && !inClass) return src.slice(open, i + 1)
    i++
  }
  return "/"
}

/** The index just past a comment opening at `i`, or -1 if none opens there. */
const skipComment = (src: string, i: number, atLineStart: boolean): number => {
  if (src[i] !== "/") return -1
  if (src[i + 1] === "*") {
    const end = src.indexOf("*/", i + 2)
    return end === -1 ? src.length : end + 2
  }
  // Only a LINE-LEADING `//`, matching the shared helper: a mid-line `//` inside
  // a URL or a regex literal must survive.
  if (src[i + 1] === "/" && atLineStart) {
    const end = src.indexOf("\n", i)
    return end === -1 ? src.length : end
  }
  return -1
}

const stripCommentsOutsideStrings = (src: string): string => {
  let out = ""
  let i = 0
  let atLineStart = true
  while (i < src.length) {
    const past = skipComment(src, i, atLineStart)
    if (past !== -1) {
      i = past
      continue
    }
    const c = src[i] as string
    const token =
      c === '"' || c === "'" || c === "`"
        ? readStringLiteral(src, i)
        : c === "/" && opensRegexLiteral(out)
          ? readRegexLiteral(src, i)
          : ""
    if (token !== "") {
      out += token
      i += token.length
      atLineStart = false
      continue
    }
    out += c
    atLineStart = c === "\n" || (atLineStart && (c === " " || c === "\t"))
    i++
  }
  return out
}

/** `readFileSync("src/…")` and `glob.scanSync("src")` — the path IS the argument. */
const pathArgumentSites = (source: string): readonly string[] => {
  const out: string[] = []
  for (const re of [FS_ENTRY_POINTS, GLOB_SCAN_ENTRY_POINTS]) {
    for (const m of source.matchAll(re)) {
      const arg = m[2] ?? ""
      if (REPO_RELATIVE_ARG.test(arg)) out.push(`${m[1]}("${arg}")`)
    }
  }
  return out
}

/** `execSync("rg … src")` — the path is a token inside the command string. */
const shellCommandSites = (source: string): readonly string[] => {
  const out: string[] = []
  for (const m of source.matchAll(SHELL_ENTRY_POINTS)) {
    const cmd = m[3] ?? ""
    if (!REPO_RELATIVE_IN_COMMAND.test(cmd)) continue
    if (hasCwdAnchor(source, m.index + m[0].length)) continue
    out.push(`${m[1]}(\`${cmd.slice(0, 60)}…\`)`)
  }
  return out
}

/** ``await $`grep -r x src` `` — a tagged template, so there is no argument list. */
const bunShellSites = (source: string): readonly string[] => {
  const patterns = BUN_SHELL_BINDING.test(source)
    ? [BUN_SHELL_MEMBER, BUN_SHELL_BARE]
    : [BUN_SHELL_MEMBER]
  const out: string[] = []
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      const cmd = m[1] ?? ""
      if (!REPO_RELATIVE_IN_COMMAND.test(cmd)) continue
      if (hasCwdAnchor(source, m.index + m[0].length)) continue
      out.push(`$\`${cmd.slice(0, 60)}…\``)
    }
  }
  return out
}

/**
 * Sites where a repo-root-relative literal reaches the filesystem or a shell.
 *
 * ## The gap, stated rather than implied
 *
 * A literal that reaches disk through a BINDING is not followed:
 * `const D = "src/runner/knobs"; readdirSync(D)`, and equally a hand-rolled
 * `walk("src/apps/cli")` whose `readdirSync` sits in another function. Those are
 * covered by the complement rather than by this regex — the arch tests run from
 * a foreign working directory in `tools/dev/sandboxed-test.ts`, where a
 * cwd-resolved path fails on ground truth instead of on a proxy for it.
 *
 * This is why the assertion below is a ceiling with an explicit admit-list and
 * not a claim of totality.
 */
export const cwdRelativeRepoReads = (rawSource: string): readonly string[] => {
  // Comments are removed FIRST, and that is not cosmetic. The detector's first
  // version anchored the path literal to the call with `\s*`, which a comment
  // between the two breaks. `tool-surface-manifest-hellgate.test.ts` puts NINE
  // lines of comment between `execSync(` and its `grep … src/tool …` string, so
  // the detector reported the whole tree clean while that file failed 3/36 under
  // a foreign cwd — the ratchet committing the exact defect it forbids.
  const source = stripCommentsOutsideStrings(rawSource)
  return [
    ...new Set([
      ...pathArgumentSites(source),
      ...shellCommandSites(source),
      ...bunShellSites(source),
      ...localWalkerSeedSites(source),
    ]),
  ]
}

/**
 * A walker DEFINED IN THIS FILE, seeded with a bare repo-root literal.
 *
 * This is the shape that actually recurs, and it kept arriving after the entry
 * points were closed. Three found in one night by the paired control, all after
 * this ratchet reported the tree clean:
 *
 *   - `no-raw-process-env-knob-ratchet-hellgate` — `walk("src")`
 *   - `gate-vocabulary-ratchet-hellgate` — `walk("src")`
 *   - `no-timebomb-auth-fixtures-hellgate` — `walk("tests")`
 *
 * Following a binding in general needs name resolution, which a regex cannot do —
 * and this file says so. But the LOCAL case does not: the walker is declared in
 * the same source, its body contains a real filesystem entry point, and the seed
 * is a literal at the call. Two passes over one file, no resolution required.
 *
 * Deliberately narrow. It matches only a same-file declaration whose body reaches
 * the filesystem, so a helper IMPORTED from elsewhere is still the stated gap and
 * still belongs to the foreign-cwd run. Widening it to any called name would
 * reproduce the inverted design measured at 147 files, ~90 of them synthetic
 * fixtures.
 */
// `[^{;\n]{0,120}` between the parameter list and the brace, because a real
// declaration puts things there that a tighter pattern misses: the first version
// required `(params)` then optionally `=>` then `{`, and
// `function* walk(dir: string): Generator<string> {` — the exact shape of all
// three offenders — has a RETURN TYPE in that gap. It matched nothing and the
// lens was inert; only re-introducing a fixed offender revealed it.
const WALKER_DECL =
  /(?:function\s*\*?\s*|const\s+|let\s+)([A-Za-z_$][\w$]*)\s*(?:=\s*)?(?:\([^)]*\)|[\w$]+)[^{;\n]{0,120}\{/g
const FS_IN_BODY = /\b(readdirSync|readdir|opendirSync|opendir|globSync|scanSync|scan)\s*\(/

/**
 * The walker RESOLVES its argument before touching disk, so the seed being
 * repo-relative is fine.
 *
 * `tools/feature-catalog/cli.ts` does exactly this: `collectSrcFiles("src")`
 * looks like the defect, but its inner walk calls
 * `readdir(resolve(ROOT, dir), …)`. Flagging it would ask the author to change a
 * call that is already correct — and the seed is repo-relative BY DESIGN there,
 * because the returned paths are repo-relative too.
 */
const BODY_ANCHORS_ITS_ARG =
  /\b(?:readdirSync|readdir|opendirSync|opendir|globSync|scanSync|scan)\s*\(\s*(?:resolve|join)\s*\(/

/**
 * A walker seed must be a real DIRECTORY under the repo root.
 *
 * Precision, not convenience. Without it this lens flagged two synthetic
 * fixtures that merely start with `src/`:
 * `scanToolSource("src/tool/__synthetic__/bad.ts")` (a path that has never
 * existed — the file names a hypothetical tool for the guard to reason about)
 * and `shellWith("src/b.ts\nsrc/a.ts\nREADME.md")` (fake `ls` OUTPUT handed to a
 * stub shell). Neither is a filesystem read, and flagging them is how a detector
 * gets weakened instead of its offenders fixed.
 *
 * A directory check is the right discriminator HERE specifically — a walker
 * walks a directory — where a bare existence check was measured to be too weak
 * for the general argument position.
 */
const seedsRealDirectory = (arg: string): boolean => {
  try {
    return statSync(join(REPO_ROOT, arg)).isDirectory()
  } catch {
    return false
  }
}

export const localWalkerSeedSites = (
  source: string,
  isSeed: (arg: string) => boolean = seedsRealDirectory,
): readonly string[] => {
  const walkers = new Set<string>()
  for (const m of source.matchAll(WALKER_DECL)) {
    const name = m[1] ?? ""
    // The body is bounded by scanning forward to the matching brace; a 4,000
    // character window is far past any real walker and keeps this linear.
    const body = source.slice(m.index + m[0].length, m.index + m[0].length + 4000)
    if (FS_IN_BODY.test(body) && !BODY_ANCHORS_ITS_ARG.test(body)) walkers.add(name)
  }
  const out: string[] = []
  for (const name of walkers) {
    const call = new RegExp(`\\b${name}\\s*\\(\\s*["'\`]([^"'\`\\n]+)["'\`]`, "g")
    for (const m of source.matchAll(call)) {
      const arg = m[1] ?? ""
      if (REPO_RELATIVE_ARG.test(arg) && isSeed(arg)) out.push(`${name}("${arg}")`)
    }
  }
  return out
}

/**
 * The three populations that read this repo, and why it is three and not one.
 *
 * `tests/**` was the whole walk until 2026-08-26, and that was the same
 * "clean vs I never looked" error one level up: the detector could be perfect and
 * still report a clean tree, because the files doing the scanning were outside
 * the scan.
 *
 *   - `tests/**\/*.test.ts` — 3,367 files, the original population.
 *   - `tools/**\/*.ts` — 103 files, ALL of them, not only tests. The live
 *     vacuous-green this campaign started from (`fc validate` checking 1,068
 *     features at the repo root and 0 features from a foreign cwd, both exit 0)
 *     is in `tools/feature-catalog`, which contains no `.test.ts` at all.
 *   - `src/**\/*.test.ts` — 296 files that no `bun test` script covers and that
 *     `gated-test-scope-ratchet` also cannot see. Two of them
 *     (`prompt-graph/role-drift.ratchet.test.ts`, `tool/terminal-surface.test.ts`)
 *     scan all of `src/` on every run.
 *
 * `.`-prefixed directories are skipped, which is load-bearing here rather than
 * cosmetic: `tools/dev/.scratch` is a gitignored twin of `src/` holding 4,394
 * `.ts` files, and walking it would trade a 400-file scan for a 4,800-file one
 * whose findings are all about copies.
 */
const POPULATIONS = [
  { root: "tests", suffix: ".test.ts", floor: 3000 },
  { root: "tools", suffix: ".ts", floor: 80 },
  { root: "src", suffix: ".test.ts", floor: 250 },
] as const

const filesUnder = (root: string, suffix: string): readonly string[] => {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue
      const abs = join(dir, ent.name)
      if (ent.isDirectory()) walk(abs)
      else if (abs.endsWith(suffix)) out.push(abs)
    }
  }
  walk(join(REPO_ROOT, root))
  return out.sort()
}

const POPULATION_FILES = new Map(
  POPULATIONS.map((population) => {
    const files = filesUnder(population.root, population.suffix)
    assertScanPopulation(files, join(REPO_ROOT, population.root), {
      collectable: (name) => name.endsWith(population.suffix),
      id: `tests/unit/_arch/repo-path-anchor-ratchet.test.ts#${population.root.toUpperCase()}`,
    })
    return [population.root, files] as const
  }),
)

const scannedFiles = (): readonly string[] =>
  POPULATIONS.flatMap((population) => POPULATION_FILES.get(population.root) ?? []).sort()

/**
 * Sites admitted deliberately. Empty today — the nine found on 2026-08-25/26
 * were all fixed rather than admitted, because every one of them had a
 * one-line `import.meta.dir` answer.
 *
 * An entry here is a claim that the ambient cwd is genuinely the right anchor
 * for that read, which is true only for a test ABOUT cwd behaviour.
 */
const ADMITTED: ReadonlySet<string> = new Set<string>()

describe("repo-path anchoring", () => {
  const files = scannedFiles()

  test("anti-vacuity: the scan sees all three real populations", () => {
    // PER-ROOT, not a total. A single `> 2000` is satisfied by `tests/` alone, so
    // it would pass unchanged if the `tools/` or `src/` walk silently returned
    // nothing — which is precisely the failure mode this whole ratchet is about,
    // committed by its own anti-vacuity check.
    expect(
      POPULATIONS.map((p) => `${p.root}: ${filesUnder(p.root, p.suffix).length >= p.floor}`),
    ).toEqual(POPULATIONS.map((p) => `${p.root}: true`))
    expect(files.length).toBeGreaterThan(2000)
  })

  /**
   * This file is the one place that must CONTAIN the forbidden shape — its
   * doc-comment and its own fixtures are worked examples of it. Excluded by
   * name, and the exclusion is turned into evidence below: the detector must
   * still flag it, which proves the scan fires against the real tree and not
   * only against the synthetic strings in the cases further down.
   */
  const SELF = "tests/unit/_arch/repo-path-anchor-ratchet.test.ts"

  const scanned = files
    .map((f) => ({
      file: f.slice(REPO_ROOT.length + 1),
      sites: cwdRelativeRepoReads(readFileSync(f, "utf8")),
    }))
    .filter((r) => r.sites.length > 0)

  test("anti-vacuity: the detector fires on the real tree, not just on fixtures", () => {
    // Without this, a detector that silently stopped matching anything would
    // make the ceiling below pass forever — the exact "clean vs I never looked"
    // confusion this ratchet exists to prevent.
    expect(scanned.map((r) => r.file)).toContain(SELF)
  })

  test("no test resolves a repo path from the ambient working directory", () => {
    const offenders = scanned
      .filter((r) => r.file !== SELF)
      .filter((r) => !ADMITTED.has(r.file))
      .sort((a, b) => a.file.localeCompare(b.file))
    expect(
      offenders.map((o) => `${o.file}: ${o.sites.join(", ")}`),
      offenders.length === 0
        ? ""
        : "these read the repo through the ambient cwd — build the path from " +
            "`import.meta.dir` instead (or pass `{cwd: REPO_ROOT}` to a shell-out). " +
            "Launched from anywhere but the repo root they resolve elsewhere, and a " +
            "guard whose verdict comes from a scan cannot tell 'clean' from 'I never " +
            "looked'.",
    ).toEqual([])
  })

  describe("the detector itself", () => {
    test("🔴 catches every shape that was actually found in the wild", () => {
      // Each of these is a real site fixed on 2026-08-25/26, reduced to one line.
      const wild = [
        'const src = readFileSync("src/apps/cli/index.ts", "utf8")',
        'const asm = await Bun.file("src/host/runtime/agent-config-assembler.ts").text()',
        'const server = readFileSync("src/apps/web-daemon/server/fetch-handler.ts", "utf8")',
        `execSync(\`rg -l --fixed-strings ${templatePlaceholder("knob")} src --type ts\`)`,
      ]
      expect(wild.map((w) => cwdRelativeRepoReads(w).length > 0)).toEqual([true, true, true, true])
    })

    test("the two shapes the detector does NOT follow, recorded as a known gap", () => {
      // Not aspiration — a binding and a hand-rolled walker are invisible to any
      // regex that does not resolve names, and pretending otherwise would let a
      // future reader believe a green here means the tree is clean. Ground truth
      // for these is the foreign-cwd run, not this file.
      expect(cwdRelativeRepoReads('const D = "src/runner/knobs"\nreaddirSync(D)')).toEqual([])
      expect(cwdRelativeRepoReads('for (const f of walk("src/apps/cli")) {}')).toEqual([])
    })

    test("INNOCENT — an anchored read is not flagged", () => {
      expect(
        cwdRelativeRepoReads('readFileSync(join(import.meta.dir, "..", "src/x.ts"), "utf8")'),
      ).toEqual([])
      expect(cwdRelativeRepoReads('readFileSync(ABS_PATH, "utf8")')).toEqual([])
    })

    test("INNOCENT — a repo-looking string that is not a read", () => {
      // The false positive a cruder scan produced: a fixture path inside
      // synthetic input, and a predicate over paths the test already holds.
      expect(cwdRelativeRepoReads('files: [{ path: "src/big.ts", content: huge }]')).toEqual([])
      expect(cwdRelativeRepoReads('path.endsWith("src/shared/runtime-config.ts")')).toEqual([])
      expect(cwdRelativeRepoReads('path.includes("src/config/knob-inventory")')).toEqual([])
    })

    test("INNOCENT — a shell-out anchored with an explicit cwd", () => {
      // The FIXED form of the vacuous-green case: `rg … src` under
      // `{cwd: REPO_ROOT}` resolves correctly from anywhere. Flagging it would
      // ask the author to revert the fix.
      expect(
        cwdRelativeRepoReads(
          `execSync(\`rg -l ${templatePlaceholder("k")} src --type ts\`, { encoding: "utf8", cwd: REPO_ROOT })`,
        ),
      ).toEqual([])
      // …but a DISTANT `cwd:` belonging to some other call does not vouch for it.
      expect(
        cwdRelativeRepoReads(
          // Padding must NOT be comments: the detector strips those first, which
          // would pull the distant `cwd:` back inside the 200-character window and
          // make this case pass for the wrong reason.
          `execSync(\`rg -l x src\`)\n${"const pad = 1\n".repeat(20)}spawnSync(a, { cwd: R })`,
        ),
      ).toHaveLength(1)
    })

    test("INNOCENT — a temp directory scan", () => {
      expect(cwdRelativeRepoReads("expect(readdirSync(out).length).toBe(0)")).toEqual([])
    })

    /**
     * The 2026-08-27 widening, and what each entry point actually FOUND.
     *
     * Nine shapes were measured against the tree BEFORE the widening and every
     * one of them was missed. Of the nine, exactly ZERO had a live offender: the
     * `.scan`/`.scanSync` sites all pass an anchored binding, and `globSync`,
     * `opendirSync`, `readlinkSync`, `cpSync`, `watch` and `Bun.$` have no live
     * use with a repo-relative literal at all. So these fixtures are SYNTHETIC
     * and are labelled as such — the widening is prevention, not a find, and
     * saying otherwise would make a green here look like evidence it is not.
     *
     * Ground truth for each was still taken: every shape was injected into a real
     * file in each of the three populations, the ratchet went red naming that
     * file, and the injection was reverted.
     */
    test("🔴 SYNTHETIC — the call-position glob root, which the constructor position misses", () => {
      // `new Bun.Glob(pattern)` holds the PATTERN; `.scanSync(root)` holds the
      // PATH, and the path is the half that resolves against the cwd.
      expect(cwdRelativeRepoReads('new Bun.Glob("**/*.ts").scanSync("src")')).toEqual([
        'scanSync("src")',
      ])
      expect(cwdRelativeRepoReads('new Glob("**/*.ts").scan("tools/dev")')).toEqual([
        'scan("tools/dev")',
      ])
    })

    test("🔴 SYNTHETIC — the five fs entry points added alongside the read family", () => {
      const shapes: Record<string, string> = {
        globSync: 'globSync("src/**/*.ts")',
        opendirSync: 'opendirSync("src/tool")',
        readlinkSync: 'readlinkSync("src/link")',
        cpSync: 'cpSync("tools/fixtures", dest, { recursive: true })',
        watch: 'watch("src/apps/cli", () => {})',
      }
      expect(
        Object.entries(shapes).map(([k, v]) => `${k}: ${cwdRelativeRepoReads(v).length}`),
      ).toEqual(Object.keys(shapes).map((k) => `${k}: 1`))
    })

    test("🔴 SYNTHETIC — `Bun.$`, a shell-out with no argument list to look inside", () => {
      expect(cwdRelativeRepoReads("await Bun.$`rg -l knob src --type ts`")).toHaveLength(1)
      // The bare binding is gated on it actually coming from `"bun"`.
      expect(
        cwdRelativeRepoReads('import { $ } from "bun"\nawait $`grep -r needle src`'),
      ).toHaveLength(1)
      expect(
        cwdRelativeRepoReads('const { $ } = await import("bun")\nawait $`grep -r needle src`'),
      ).toHaveLength(1)
    })

    test("INNOCENT — a `$` that ends a template literal is not a shell-out", () => {
      // Without the import gate this is what `` $` `` matches: the CLOSING
      // backtick of any template ending in `$`. This repo has ~20, and each would
      // have been a false positive — the thing that gets a ratchet's detector
      // weakened rather than its offenders fixed.
      const dollarEnd = ["`", "^", templatePlaceholder("re"), "$", "`"].join("")
      expect(cwdRelativeRepoReads(`const anchored = ${dollarEnd}\nreaddirSync("src")`)).toEqual([
        'readdirSync("src")',
      ])
      expect(cwdRelativeRepoReads("await Bun.$`rg -l knob docs`.cwd(REPO_ROOT)")).toEqual([])
    })

    test("INNOCENT — an anchored `.scanSync` binding, the live shape on this tree", () => {
      // Every real `.scan`/`.scanSync` in the repo looks like this. Flagging it
      // would be the false positive that discredits the widening on day one.
      expect(cwdRelativeRepoReads("for (const rel of glob.scanSync(SRC_DIR)) {}")).toEqual([])
    })

    test("🔴 a glob pattern must survive comment-stripping", () => {
      // The pre-processing defect this widening uncovered. The shared
      // `stripComments` treats the `/` + `**` + `/` inside a glob STRING as a
      // block comment and rewrites `src/` + `**` + `/*.ts` to `src*.ts`, deleting
      // the `src/` prefix that `REPO_RELATIVE_ARG` matches on. That silently
      // disarmed `globSync` and the `Glob` constructor position — which had been
      // in `FS_ENTRY_POINTS` since this file was written — for the ordinary way
      // everyone writes a glob.
      expect(cwdRelativeRepoReads('globSync("src/**/*.ts")')).toEqual(['globSync("src/**/*.ts")'])
      expect(cwdRelativeRepoReads('new Glob("tools/**/*.ts")')).toEqual(['Glob("tools/**/*.ts")'])
    })

    test("INNOCENT — a quote inside a REGEX literal must not desync the scanner", () => {
      // Measured, not hypothetical: making the stripper string-aware without
      // making it regex-aware produced exactly one false positive on the real
      // tree — `tools/feature-catalog/test-audit.ts`, whose
      // `/readFile(?:Sync)?…["'`]…src/` pattern opened a "string" at the `"` and
      // left every JSDoc below it looking like live code.
      const src = [
        `const RE = /readFile(?:Sync)?\\s*\\(\\s*["'\`]src\\//`,
        "/**",
        ' * a test that reads source via `readFileSync("src/...")` must opt in',
        " */",
        "export const check = () => RE",
      ].join("\n")
      expect(cwdRelativeRepoReads(src)).toEqual([])
    })

    test("a comment is still stripped — the defect this detector was born from", () => {
      // The regex-awareness above must not have reopened the original hole.
      expect(cwdRelativeRepoReads('// readFileSync("src/apps/cli/index.ts")')).toEqual([])
      expect(cwdRelativeRepoReads('/* readdirSync("tools/dev") */')).toEqual([])
      expect(
        cwdRelativeRepoReads('execSync(\n  /* nine\n   * lines\n   */\n  "grep -r x src/tool",\n)'),
      ).toHaveLength(1)
    })
  })
})
