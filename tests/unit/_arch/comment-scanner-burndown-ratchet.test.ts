/**
 * ONE COMMENT SCANNER, AND A LIST THAT ONLY SHRINKS.
 *
 * A source-scanning guard has to remove comments before it asserts, and the
 * obvious way to do that is two regexes. That way is wrong in a manner that
 * DEFEATS the guard rather than annoying it: a `/*` inside a string literal or
 * inside a regex character class reads as a comment opener, and everything up
 * to the next `*​/` is deleted before the scan ever sees it.
 *
 * MEASURED, and the numbers are why this file exists rather than a comment
 * somewhere:
 *
 *  · 24 guards in this repo were defeated end-to-end by planting two such
 *    lines around a real violation — including the TLS-MITM gate fence and the
 *    API-key-leak ban, both security boundaries.
 *  · No attacker is required. 80 files under `src/` ALREADY contain a `/*`
 *    inside ordinary prose — a permission rule documenting the glob `/*`, a doc
 *    line naming `resources/*` — and they hide 2,533 real code lines from every
 *    naive scanner today. `src/permission/policy-rules.ts` hides its own
 *    deny-rule table; `src/tool/index.ts` hides 347 lines of the tool barrel.
 *
 * The repo already had a correct implementation. It is now the shared one in
 * `tests/unit/_shared/strip-comments.ts`: quoting-aware, regex-literal-aware,
 * with character-class tracking and the previous-token heuristic that tells a
 * regex from a division.
 *
 * This ratchet does not demand a big-bang conversion — converting a guard makes
 * previously-hidden code visible, and that red has to be READ, not papered. It
 * demands that the list of guards still carrying their own scanner never grows,
 * and that no NEW one is written.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

/**
 * EVERY root, not just the ones the first version looked at. It scanned
 * `tests` and `tools` only, leaving ~7,000 files unexamined — and three real
 * naive strippers already live in them, one of them inside a guard test.
 */
const ROOTS = ["src", "tests", "tools"] as const

/**
 * A LOCAL comment stripper written with regex replaces — the defeatable shape.
 * Matched on the raw text on purpose: this guard must not depend on the very
 * helper whose correctness is in question.
 */
/**
 * A file that STRIPS COMMENTS ITSELF, in any spelling.
 *
 * Matching the three regex spellings we happened to have written was
 * decorative: hoisting the pattern to a `const`, building it with `new
 * RegExp`, or spelling `/*` as `[/][*]` each walked straight past it —
 * MEASURED, all three left the ratchet green.
 *
 * So the detector matches the CONCEPT instead: a file that names a
 * comment-stripping helper of its own AND does not import the shared one. That
 * is the thing being burned down, and it does not care how the regex is
 * spelled. A file may still evade by naming its helper something unrelated —
 * this catches carelessness and drift, not a determined author, and says so.
 */
const DECLARES_OWN_STRIPPER = /(?:const|function|let)\s+[\w$]*[Ss]trip[A-Za-z]*Comment/
const IMPORTS_SHARED = /from\s+["'][^"']*_shared\/strip-comments["']/

const carriesOwnStripper = (src: string): boolean =>
  DECLARES_OWN_STRIPPER.test(src) && !IMPORTS_SHARED.test(src)

const scan = (dir: string, into: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) scan(full, into)
    else if (full.endsWith(".ts")) into.push(relative(REPO, full))
  }
  return into
}

const naiveStripperSites = (): readonly string[] =>
  ROOTS.flatMap((root) => scan(join(REPO, root)))
    .filter((f) => carriesOwnStripper(readFileSync(join(REPO, f), "utf8")))
    .sort()

/**
 * The burn-down list. Every entry is a guard whose scanner can be defeated by
 * two lines of prose. It may only SHRINK — convert a site to the shared scanner
 * and delete its line; a new entry means a new copy of a known-broken helper.
 */
const REMAINING: readonly string[] = [
  "tests/unit/runtime/single-pid-kill-ban-hellgate.test.ts",
  "src/agent/converge/purity.test.ts",
  "src/agent/repro-test/select.ts",
  "src/apps/bench/composition-root-dispatch.test.ts",
  "src/apps/bench/promax/campaign/owner-audit.ts",
  "src/observability/coverage/v8-source.ts",
  "src/runner/batch/eval/python-source-text.ts",
  "src/runner/batch/eval/verification-owner-test-expectations.ts",
  "src/shared/public-issue-text.ts",
  "tests/integration/admissibility-deny-steer-hell.test.ts",
  "tests/integration/cli-attention-navigation.test.ts",
  "tests/unit/_arch/repo-path-anchor-ratchet.test.ts",
  "tests/unit/_shared/strip-comments.ts",
  "tests/unit/activity/activity-store-constructor-owner-ratchet.test.ts",
  "tests/unit/apps/bench/promax/promax-bootstrap-phase-reachability.test.ts",
  "tests/unit/apps/cli/cli-feature-config-hellgate.test.ts",
  "tests/unit/apps/headless/headless-second-consumer-hellgate.test.ts",
  "tests/unit/compiled-binary-asset-ratchet.test.ts",
  "tests/unit/dataset-family-profile-ssot.test.ts",
  "tests/unit/deny-reason-authority-ratchet-hellgate.test.ts",
  "tests/unit/integrations/github/slice-fence-static-hellgate-r3.test.ts",
  "tests/unit/objective/authority-boundary-ratchet.test.ts",
  "tests/unit/objective/constructor-owner-ratchet.test.ts",
  "tests/unit/observability/new-slice-metrics-hellgate.test.ts",
  "tests/unit/runner/session-authorities-task-registry-identity.test.ts",
  "tests/unit/runtime-config-knobs-parity-hellgate.test.ts",
  "tests/unit/skill/runtime/f4-discovery-owner-ratchet.test.ts",
  "tools/feature-catalog/reachability.ts",
  "tools/feature-catalog/yaml.ts",
  "tools/leaderboard-dashboard/family-union-ssot.test.ts",
  "tools/leaderboard-dashboard/projectors/structural.test.ts",
  "tools/slice-graph/build-graph.ts",
]

describe("the comment-scanner burn-down", () => {
  test("🔴 no NEW guard carries its own defeatable comment stripper", () => {
    const unlisted = naiveStripperSites().filter((f) => !REMAINING.includes(f))
    expect(
      unlisted,
      "a new local comment stripper — import the shared one from tests/unit/_shared/strip-comments",
    ).toEqual([])
  })

  test("🔴 the list only shrinks — a converted site must lose its line", () => {
    const live = new Set(naiveStripperSites())
    const stale = REMAINING.filter((f) => !live.has(f))
    expect(stale, "these were converted; delete their entries so the ceiling drops").toEqual([])
  })

  test("ANTI-VACUITY: the detector fires on every spelling, not the ones we wrote", () => {
    const hit = carriesOwnStripper
    // the canonical form…
    expect(hit('const stripComments = (s: string) => s.replace(/x/g, "")')).toBe(true)
    // …and the four respellings that walked past the previous detector
    expect(hit('const RE = /x/g\nconst stripComments = (s: string) => s.replace(RE, "")')).toBe(
      true,
    )
    expect(hit('const stripComments = (s: string) => s.replace(new RegExp("x"), "")')).toBe(true)
    expect(hit("function stripBlockComments(s: string) { return s }")).toBe(true)
    expect(hit("let stripCommentsOutsideStrings = (s: string) => s")).toBe(true)
    // a file that USES the shared one is not carrying its own
    expect(hit('import { stripComments } from "../_shared/strip-comments"\nstripComments(x)')).toBe(
      false,
    )
  })

  test("ANTI-VACUITY: the scan reaches a real, populated set of files", () => {
    expect(["tests", "tools"].flatMap((r) => scan(join(REPO, r))).length).toBeGreaterThan(500)
  })
})
