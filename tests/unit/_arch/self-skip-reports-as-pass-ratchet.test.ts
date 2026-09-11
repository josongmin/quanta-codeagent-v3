/**
 * Ratchet — a test that decides not to run must SKIP, never silently pass.
 *
 * ## The shape
 *
 * ```ts
 * test("checks the thing", () => {
 *   if (!toolAvailable) return      // ← bun counts this as a PASS
 *   …
 * })
 * ```
 *
 * `bun test` has no way to know the body returned early, so the test is reported
 * green and does not appear in the skip counter. It is invisible in both places
 * a reader would look.
 *
 * ## Measured, not hypothetical
 *
 * `ast-grep` is not installed on this machine. Before the conversion,
 * `ast-grep-scenarios.test.ts` reported **23 pass, 0 skip, 15 expect() calls** —
 * fourteen of the twenty-three asserted nothing and every one of them was green.
 * Across the four ast-grep files, 18 tests reported as passing while executing no
 * assertion at all. After converting to `test.skipIf(...)` the same run reports
 * 9 pass / 14 skip, which is the truth and is legible.
 *
 * ## Why the allowlist exists
 *
 * Twenty-five other sites carry the shape today, and on this machine every one of
 * their conditions is FALSE — they guard `process.platform === "win32"` and a
 * missing `python3`, so the tests actually run here and the defect is latent
 * rather than live. Converting them is mechanical but touches twelve files owned
 * by other work, and the honest reason to do it is legibility on a Windows or
 * python-less machine, not a bug here. So they are listed rather than silently
 * tolerated, and the list may only shrink.
 *
 * What must not happen is a twenty-sixth, or a regression of the eighteen already
 * converted.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { selfSkipSites } from "../../../tools/dev/self-skip-sites"
import { assertScanPopulation } from "../_shared/scan-population"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

/**
 * ## Why the detector is a parse and no longer a regex
 *
 * It was:
 *
 *     /\b(?:it|test)\s*\(\s*(["\'`])…\1[^\n]*\)\s*=>\s*\{\s*\n\s*if\s*\(…\)\s*…return\b/
 *
 * `[^\n]*` between the title and the arrow requires the whole `test(` header on
 * ONE LINE. `tests/unit/worktree.test.ts` passes a per-test timeout as a third
 * argument, so biome wraps the call across four lines — and the four
 * `if (!(await gitAvailable())) return` guards inside it were invisible to this
 * ratchet while reporting as four green passes. MEASURED: the ratchet was green
 * on that file the whole time; the FORMATTER decided whether the rule applied.
 *
 * `tools/dev/self-skip-sites.ts` asks the structural question instead — is the
 * FIRST statement of this test's callback a conditional `return`? — which has no
 * opinion about line breaks, `async`, or where the callback sits in the argument
 * list.
 *
 * Converting the four made the file honest, and converting three more found the
 * same way (a strategy-matrix case, a preset-equivalence case, a win32 case)
 * turned 4 silent passes into 4 visible skips — one of which exposed that all
 * four presets `posture-phase-modules-hellgate` pins have been deleted from the
 * registry, so that block had been asserting nothing.
 */

/** Every `*.test.ts` under `tests/` and `src/`, anchored on this file. */
const testFiles = (): readonly string[] => {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue
      const abs = join(dir, ent.name)
      if (ent.isDirectory()) walk(abs)
      else if (abs.endsWith(".test.ts")) out.push(abs.slice(REPO_ROOT.length + 1))
    }
  }
  walk(join(REPO_ROOT, "tests"))
  walk(join(REPO_ROOT, "src"))
  return out.sort()
}

/**
 * Files that still self-skip, with the count. One-directional: a number may go
 * DOWN or the entry may disappear; it may never rise, and a new file may not
 * appear.
 *
 * Every condition here is a platform or external-tool probe that is FALSE on
 * macOS/Linux with the standard toolchain, so these run rather than silently
 * pass. That is why they are tolerated and the ast-grep ones were not.
 *
 * TWO COUNTS WENT UP when the detector became a parse, and neither is a
 * regression being papered over — both sites were always there and the regex
 * could not see them:
 *
 *   browser-real-chrome-adversarial-e2e   2 → 3   (site at line 917)
 *   recursive-file-list-characterization  9 → 10  (site at line 731)
 *
 * Two entries were REMOVED because the files no longer carry the shape at all:
 * `sphinx-ra-shim.test.ts` (converted to `describe.skipIf(!canExecute(python))`)
 * and `git/conflict-parser-differential-fuzz.test.ts`. And `worktree.test.ts`
 * never appeared here despite four sites — that is the defect this rewrite
 * fixes, so it is converted rather than listed.
 */
const KNOWN: Readonly<Record<string, number>> = {
  "tests/integration/browser-real-chrome-adversarial-e2e.test.ts": 3,
  "tests/unit/apps/bench/promax/promax-bundle-assembly.test.ts": 2,
  "tests/unit/apps/cli/at-autocomplete/recursive-file-list-characterization.test.ts": 10,
  "tests/unit/apps/cli/rewind-harness-messages-hellgate.test.ts": 1,
  "tests/unit/auth/token-store.test.ts": 2,
  "tests/unit/bash-mode-hellgate.test.ts": 1,
  "tests/unit/cli/fetch-rules-hellgate.test.ts": 1,
  "tests/unit/retrieval/indexer-hellgate.test.ts": 2,
  "tests/unit/tool/glob-gitignore-mtime-hellgate.test.ts": 1,
  "tests/unit/tool/glob-pattern-jail-escape-hellgate.test.ts": 2,
}

describe("a self-skip must not report as a pass", () => {
  const files = testFiles()

  test("anti-vacuity: the walk reached the real test tree", () => {
    assertScanPopulation(
      files.filter((file) => file.startsWith("tests/")).map((file) => join(REPO_ROOT, file)),
      join(REPO_ROOT, "tests"),
      {
        id: "tests/unit/_arch/self-skip-reports-as-pass-ratchet.test.ts#TESTS",
        collectable: (name) => name.endsWith(".test.ts"),
      },
    )
    assertScanPopulation(
      files.filter((file) => file.startsWith("src/")).map((file) => join(REPO_ROOT, file)),
      join(REPO_ROOT, "src"),
      {
        id: "tests/unit/_arch/self-skip-reports-as-pass-ratchet.test.ts#SRC",
        collectable: (name) => name.endsWith(".test.ts"),
      },
    )
    // This ratchet is an instance of the class it guards — a walk that read
    // nothing would report "no self-skips" just as convincingly.
    expect(
      files.length,
      "the walk read no test files — the counts below are vacuous",
    ).toBeGreaterThan(3000)
  })

  const sitesIn = (text: string) => selfSkipSites({ path: "probe.test.ts", text })
  const countIn = (text: string) => sitesIn(text).length

  test("🔴 the detector fires on the shape, and not on an ordinary early return", () => {
    expect(countIn('test("x", () => {\n  if (!have) return\n  expect(1).toBe(1)\n})')).toBe(1)
    expect(
      countIn('it("x", async () => {\n  if (!have) {\n    return\n  }\n  expect(1).toBe(1)\n})'),
    ).toBe(1)

    // THE SHAPE THE REGEX MISSED — a multiline, async callback passed as the
    // SECOND argument with a timeout third. This is `tests/unit/worktree.test.ts`
    // verbatim in structure, and the previous detector scored it 0.
    const multiline = [
      "test(",
      '  "rejects a non-git directory",',
      "  async () => {",
      "    if (!(await gitAvailable())) return",
      "    expect(1).toBe(1)",
      "  },",
      "  GIT_TEST_TIMEOUT,",
      ")",
    ].join("\n")
    expect(countIn(multiline), "the multiline/async form must be detected").toBe(1)
    expect(sitesIn(multiline)[0]?.line, "and it must name the line of the guard").toBe(4)

    // …and the same with a braced branch, and with `it`
    expect(
      countIn(
        [
          "it(",
          '  "t",',
          "  async () => {",
          "    if (!have) {",
          "      return",
          "    }",
          "    expect(1).toBe(1)",
          "  },",
          "  30_000,",
          ")",
        ].join("\n"),
      ),
    ).toBe(1)

    // An early return AFTER real work is control flow, not a skip.
    expect(
      countIn(
        'test("x", () => {\n  expect(1).toBe(1)\n  if (done) return\n  expect(2).toBe(2)\n})',
      ),
    ).toBe(0)
    expect(countIn('test.skipIf(!have)("x", () => {\n  expect(1).toBe(1)\n})')).toBe(0)
    // an `if/else` at the top is a branch, not a skip
    expect(countIn('test("x", () => {\n  if (a) return\n  else expect(1).toBe(1)\n})')).toBe(0)
    // a function that merely LOOKS like a test declaration is not one
    expect(countIn('runTest("x", () => {\n  if (!have) return\n  expect(1).toBe(1)\n})')).toBe(0)
  })

  test("no NEW file self-skips, and no known count rises", () => {
    const offenders: string[] = []
    for (const rel of files) {
      const sites = selfSkipSites({ path: rel, text: readFileSync(join(REPO_ROOT, rel), "utf8") })
      if (sites.length === 0) continue
      const where = sites.map((site) => `${rel}:${site.line} "${site.title}"`).join(", ")
      const allowed = KNOWN[rel]
      if (allowed === undefined) {
        offenders.push(`${rel}: ${sites.length} new self-skip(s) — ${where}`)
      } else if (sites.length > allowed) {
        offenders.push(`${rel}: ${sites.length} > ${allowed} — ${where}`)
      }
    }
    expect(
      offenders.sort(),
      offenders.length === 0
        ? ""
        : "a test that returns early reports as a PASS and never appears in the skip " +
            "counter — use `test.skipIf(condition)` so the environment gate is legible:\n  " +
            offenders.join("\n  "),
    ).toEqual([])
  })

  test("no allowlist entry is stale — a converted file must be removed", () => {
    const stale = Object.entries(KNOWN)
      .filter(([rel, n]) => {
        try {
          return (
            selfSkipSites({ path: rel, text: readFileSync(join(REPO_ROOT, rel), "utf8") }).length <
            n
          )
        } catch {
          return true
        }
      })
      .map(([rel]) => rel)
      .sort()
    expect(
      stale,
      stale.length === 0
        ? ""
        : `these improved — lower or remove their entry:\n  ${stale.join("\n  ")}`,
    ).toEqual([])
  })
})

/**
 * NIGHTLY MEMBERSHIP HAS ONE AUTHORITY, AND IT IS THE FILE NAME.
 *
 * `tools/dev/test-policy.ts` maps `*.nightly.test.ts` to `nightly`-only tiers.
 * The runner then selects the file, or it does not. That is the whole decision.
 *
 * `tests/integration/lint-debt-reach-e2e.nightly.test.ts` had a SECOND one on
 * top of it:
 *
 *     test.skipIf(!nightlyStressEnabled())("nightly: every diagnostic …")
 *
 * So the single case in that file ran only when the nightly campaign both
 * SELECTED the file and exported `QUANTA_TEST_STRESS=1`. A nightly run that
 * selected it and did not export the variable reported a green SKIP for the one
 * case the file exists to run — and "0 failures" is what a scheduled job is read
 * for. Two authorities over one decision means the weaker one silently wins, and
 * the weaker one here is an environment variable set four layers away in
 * `tools/dev/verification-campaign.ts`.
 *
 * # What this guard asserts
 *
 * No test file gates its own body on `QUANTA_TEST_STRESS`. Not the nightly files
 * (they are already selected by name) and not the ordinary ones (a heavy case
 * hidden behind an env var in an ordinary file is a case that never runs).
 *
 * # Why it is a parse
 *
 * A text search for `QUANTA_TEST_STRESS` also matches this file's own
 * documentation, the tests/README table that explains the campaign, and the
 * string literal that `verification-campaign.test.ts` writes into a generated
 * child test to prove the variable reaches it. None of those gate anything. The
 * guard looks for the two shapes that actually DO gate: a member access named
 * `QUANTA_TEST_STRESS`, and a call to `nightlyStressEnabled`.
 *
 * It lives in this file rather than its own because it is the same family of
 * defect — a case that reports success without running — over the same corpus,
 * and because `assertScanPopulation` floors are enrolled per FILE: the walk
 * above is already pinned, and a second file would need a second enrollment for
 * an identical walk.
 */

const STRESS_ENV = "QUANTA_TEST_STRESS"
const STRESS_PREDICATE = "nightlyStressEnabled"

/**
 * The tests OF the campaign plumbing. They exist to assert that the variable is
 * exported/removed correctly, so they must be able to name it. Listed rather
 * than pattern-matched: a rule that exempted `**\/verification-*` would exempt
 * any future file that adopted the prefix.
 */
const PLUMBING_TESTS: ReadonlySet<string> = new Set([
  "tests/unit/dev/verification-campaign.test.ts",
  "tests/unit/dev/verification-first-failure.test.ts",
])

export interface StressGate {
  readonly line: number
  readonly form: string
}

/** The two shapes that make a body conditional on the campaign's env var. */
export const stressGates = (path: string, text: string): readonly StressGate[] => {
  // Cheap superset first — the parse is only worth it for files that mention it
  // at all, and a mention inside a comment merely triggers a parse that then
  // finds nothing.
  if (!text.includes(STRESS_ENV) && !text.includes(STRESS_PREDICATE)) return []
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: StressGate[] = []
  const at = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === STRESS_ENV)
      out.push({ line: at(node), form: `.${STRESS_ENV}` })
    else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === STRESS_ENV
    )
      out.push({ line: at(node), form: `["${STRESS_ENV}"]` })
    else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === STRESS_PREDICATE
    )
      out.push({ line: at(node), form: `${STRESS_PREDICATE}()` })
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

const SELF = "tests/unit/_arch/self-skip-reports-as-pass-ratchet.test.ts"

describe("tier membership has a single authority", () => {
  const files = testFiles()

  test("ANTI-VACUITY: the corpus is populated and the exemptions are real files", () => {
    // The reach/coverage floor for this walk is asserted once, above. What this
    // block needs on top of it is that the two names it EXCUSES still exist: a
    // scan of 3,900 files that excuses two paths which no longer exist would
    // report "no offenders" while excusing nothing, and the next file to want an
    // excuse would be added beside two dead entries.
    expect(files.length, "the walk read no test files").toBeGreaterThan(3000)
    for (const plumbing of PLUMBING_TESTS) expect(files).toContain(plumbing)
    // …and at least one file in the corpus really does mention the variable, or
    // the "0 gates" verdict is a statement about a corpus nobody searched.
    const mentions = files.filter((rel) =>
      readFileSync(join(REPO_ROOT, rel), "utf8").includes(STRESS_ENV),
    )
    expect(
      mentions.length,
      "no file mentions the variable at all — the gate scan is vacuous",
    ).toBeGreaterThan(0)
  })

  test("🔴 the detector fires on a gate and not on prose or a bare literal", () => {
    const one = (text: string) => stressGates("probe.test.ts", text)
    expect(one('test.skipIf(!process.env.QUANTA_TEST_STRESS)("x", () => {})')).toHaveLength(1)
    expect(one('if (env["QUANTA_TEST_STRESS"] === "1") { run() }')).toHaveLength(1)
    expect(one('test.skipIf(!nightlyStressEnabled())("x", () => {})')).toHaveLength(1)
    expect(one('test.skipIf(!nightlyStressEnabled())("x", () => {})')[0]?.line).toBe(1)
    // prose is not a gate
    expect(one("// the campaign exports QUANTA_TEST_STRESS=1 for nightly\n")).toEqual([])
    expect(one("/** nightlyStressEnabled decides the lane */\n")).toEqual([])
    // a bare string literal written into a generated fixture is not a gate
    expect(one("await Bun.write(target, 'process.env[\"QUANTA_TEST_STRESS\"]')")).toEqual([])
    // …and a file that never mentions it at all costs nothing
    expect(one('test("x", () => expect(1).toBe(1))')).toEqual([])
  })

  test("no test file gates its own body on QUANTA_TEST_STRESS", () => {
    const offenders: string[] = []
    for (const rel of files) {
      if (rel === SELF || PLUMBING_TESTS.has(rel)) continue
      const gates = stressGates(rel, readFileSync(join(REPO_ROOT, rel), "utf8"))
      for (const gate of gates) offenders.push(`${rel}:${gate.line} — ${gate.form}`)
    }
    expect(
      offenders.sort(),
      offenders.length === 0
        ? ""
        : "tier membership is decided by the FILE, via tools/dev/test-policy.ts. A second " +
            "gate inside the file turns a missing environment variable into a green skip " +
            "for the case the file exists to run:\n  " +
            offenders.join("\n  "),
    ).toEqual([])
  })

  test("the plumbing exemptions are not stale — each still names the variable", () => {
    // An exemption for a file that no longer needs it is an exemption nobody
    // will remove, and the next file to need one will be added beside it.
    const unnecessary = [...PLUMBING_TESTS]
      .filter((rel) => stressGates(rel, readFileSync(join(REPO_ROOT, rel), "utf8")).length === 0)
      .sort()
    expect(
      unnecessary,
      unnecessary.length === 0
        ? ""
        : `drop these from PLUMBING_TESTS:\n  ${unnecessary.join("\n  ")}`,
    ).toEqual([])
  })
})
