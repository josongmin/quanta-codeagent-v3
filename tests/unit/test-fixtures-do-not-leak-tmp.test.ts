/**
 * TEST FIXTURES MUST CLEAN UP UNDER THE RUNNER THAT ACTUALLY RUNS THEM.
 *
 * Nine test files registered their temp-dir cleanup with
 * `process.on("exit", …)`. Bun's test runner does not fire an exit hook for a
 * test file, so none of it ever ran. MEASURED: 790 `promax-gate-ids-*`
 * directories on this machine from one file alone, and the failure mode is not
 * disk — it is that `ls /tmp` gets slow enough to time OTHER tests out, which
 * reds the suite somewhere with no connection to the leak.
 *
 * The pattern reads as cleanup, so nothing about the file looks wrong. This
 * guard is what makes the next copy of it visible: `afterAll` runs, an exit
 * hook does not.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./_shared/strip-comments"

/**
 * Anchored on THIS file. The roots were bare `"src"` / `"tests"` / `"tools"`,
 * resolved against the ambient cwd — found by the paired control in
 * `tools/dev/cwd-parity-check.ts`: 3 pass at the repo root, 1 pass / 2 fail from
 * a foreign working directory.
 *
 * The walk goes over ABSOLUTE paths and stores REPO-RELATIVE ones, because
 * `isTestAdjacent` and the two `toContain` assertions below are written against
 * repo-relative paths and would silently stop matching if the list turned
 * absolute — trading a cwd bug for a quieter one.
 */
const REPO_ROOT = join(import.meta.dir, "..", "..")
const ROOTS = ["src", "tests", "tools"] as const

/** This file carries the pattern in string literals, on purpose, to prove the
 *  detector fires. It is the ONLY exemption, and it is named rather than
 *  pattern-matched so a second one cannot slip in behind it. */
const SELF = "tests/unit/test-fixtures-do-not-leak-tmp.test.ts"

/** Under `tests/`, or a test file / `__tests__` module anywhere else. */
const isTestAdjacent = (full: string): boolean =>
  full.startsWith("tests/") || full.endsWith(".test.ts") || full.includes("/__tests__/")

const testFiles = (dir: string, into: string[] = []): string[] => {
  for (const entry of readdirSync(join(REPO_ROOT, dir))) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
    const full = join(dir, entry)
    if (statSync(join(REPO_ROOT, full)).isDirectory()) testFiles(full, into)
    // NOT just `*.test.ts`: the helper modules beside the tests are where the
    // temp dirs are actually created — `_bootstrap-exec-harness.ts` owns every
    // sandbox in the promax suite — and an exit hook planted there leaked 34
    // directories with this guard green.
    //
    // But PRODUCTION code is out of scope: a real Node process does fire its
    // exit hooks, so `src/apps/cli/**` using one is correct. Test-adjacent means
    // anything under `tests/`, plus `*.test.ts` and `__tests__/**` elsewhere.
    else if (full.endsWith(".ts") && isTestAdjacent(full)) into.push(full)
  }
  return into
}

/**
 * Comments are not code. Every file converted away from the exit hook explains
 * WHY in a comment that names it, and this very file discusses it in prose — a
 * raw text scan flagged all ten of them.
 */
/**
 * Strip comments WITHOUT eating string literals. The naive form — two regexes
 * over the raw text — treated `"/*"` inside a string as a comment opener and
 * deleted everything up to the next `*` + `/`, which silently removed real code
 * from the scan. A tiny scanner is the honest way; regex cannot see quoting.
 */

/**
 * Every way to register the hook, not just the spelling we happened to use.
 * `process.once("exit")` has identical never-fires semantics, and so do
 * `addListener` / `prependListener`; an audit planted each and the guard stayed
 * green.
 */
const EXIT_HOOK =
  /process\s*(\.\s*[A-Za-z]*[lL]istener|\.\s*(on|once)|\[\s*["'`][A-Za-z]+["'`]\s*\])\s*\(\s*["`']exit["`']/

describe("temp-dir cleanup is registered with the test runner", () => {
  test('no test file relies on `process.on("exit")`, which bun test never fires', () => {
    const offenders = ROOTS.flatMap((root) => testFiles(root))
      .filter((f) => f !== SELF)
      .filter((f) => EXIT_HOOK.test(stripComments(readFileSync(join(REPO_ROOT, f), "utf8"))))
    expect(
      offenders,
      "these files register cleanup bun test will never run — use `afterAll` instead",
    ).toEqual([])
  })

  test("ANTI-VACUITY: the scan reaches a real, populated set of test files", () => {
    // without this the guard passes just as well when the walk finds nothing
    const all = ROOTS.flatMap((root) => testFiles(root))
    expect(all.length).toBeGreaterThan(500)
    // the helper modules are in scope too — that is where the temp dirs live
    expect(all).toContain("tests/unit/apps/bench/promax/_bootstrap-exec-harness.ts")
    expect(all).toContain(SELF)
  })

  test("ANTI-VACUITY: the detector fires on the shape it is looking for", () => {
    const detect = (src: string) => EXIT_HOOK.test(stripComments(src))
    expect(detect('process.on("exit", () => rmSync(d))')).toBe(true)
    expect(detect("process.on('exit', cleanup)")).toBe(true)
    expect(detect('process.once("exit", cleanup)')).toBe(true)
    expect(detect('process.addListener("exit", cleanup)')).toBe(true)
    expect(detect('process["on"]("exit", cleanup)')).toBe(true)
    // every bracket spelling, not the three we happened to think of
    expect(detect('process["prependListener"]("exit", cleanup)')).toBe(true)
    expect(detect('process["prependOnceListener"]("exit", cleanup)')).toBe(true)
    expect(detect("process[`on`]('exit', cleanup)")).toBe(true)
    expect(detect('process.prependListener("exit", cleanup)')).toBe(true)
    expect(detect("afterAll(() => rmSync(d))")).toBe(false)
    // …and the comment-stripping does not become a blanket amnesty: a line that
    // merely FOLLOWS a comment is still code.
    expect(detect('// use afterAll, not process.on("exit")')).toBe(false)
    expect(detect('/* not process.on("exit") */\nprocess.on("exit", cleanup)')).toBe(true)
    // …and a string literal containing comment punctuation is NOT a comment
    expect(stripComments('const pattern = "/*"\nconst other = "*/"\n')).toContain("pattern")
    // a REGEX CLASS holding comment punctuation is not a comment either
    expect(stripComments("const re = /[/*]/\nconst keep = 1\nconst re2 = /[*/]/\n")).toContain(
      "keep",
    )
  })
})
