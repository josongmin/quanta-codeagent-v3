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
    // A REGEX inside a template SUBSTITUTION — this repo's own shell-quote
    // idiom. Reading only quotes there made the `'` in `/'/g` open a string
    // that never closed, so the balancing `}` was never found and the rest of
    // the file came back verbatim, comments and all. MEASURED: 84,260
    // characters across 53 files, and a live import forgery through the
    // reachability tool.
    const sq = [
      "const q = (s) => `'$",
      "{s.replace(/'/g, 'x')}'`",
      "\n// gone\nconst kept = 1\n",
    ].join("")
    expect(stripComments(sq)).not.toContain("gone")
    expect(stripComments(sq)).toContain("kept")
  })
})

/**
 * A TEST FILE MAY NOT DISARM THE FENCES FOR EVERY FILE AFTER IT.
 *
 * bun runs every test file in ONE process — measured, same `process.pid` across
 * files — so `delete process.env.X` in an `afterAll` leaves X undefined for
 * every file bun schedules afterwards. `tests/setup.ts` installs
 * `QUANTA_BENCH_RESULTS_DIR` as the fence against writing the operator's live
 * results corpus (the aug-22 incident). Deleting it does not tidy up: it turns
 * the fence off for the rest of the run, and the file that then writes a report
 * is somewhere else entirely.
 *
 * MEASURED before the fix: a sibling's hooks saw both `QUANTA_BENCH_RESULTS_DIR`
 * and `QUANTA_BENCH_HOME` undefined for its entire run.
 */
describe("no test file deletes a shared environment fence", () => {
  const FENCED = ["QUANTA_BENCH_RESULTS_DIR", "QUANTA_BENCH_HOME", "QUANTA_HOME"] as const

  /**
   * A delete the file never UNDOES.
   *
   * Two shapes are legitimate and must not be flagged, because flagging them
   * teaches the next reader to ignore this guard:
   *
   *  · `if (prior === undefined) delete process.env.X` — the correct restore,
   *    putting back exactly what was there, including nothing;
   *  · an unconditional delete during SETUP, paired with a saved value the
   *    file restores in a hook. Six files use the first, one uses the second.
   *
   * What is left is a file that removes a shared fence and walks away — and bun
   * runs every file in one process, so that fence stays off.
   */
  const deletes = (src: string, name: string): boolean =>
    src
      .split("\n")
      .some(
        (line) =>
          new RegExp(
            `delete\\s+process\\.env(?:\\.${name}\\b|\\[\\s*["'\`]${name}["'\`]\\s*\\])`,
          ).test(line) && !/\bif\s*\(|\?\?|:\s*delete\b/.test(line),
      ) &&
    // …and the file never RESTORES it — assigning a saved value back, as
    // opposed to merely setting it to a fresh sandbox path during setup. The
    // difference is the identifier: a restore reads from a `prior`/`saved`
    // binding, a setup assignment does not. A looser check ("any assignment
    // exists") marked the real defect as fine, because the file assigns the
    // variable in every test.
    !new RegExp(
      `process\\.env\\.${name}\\s*=\\s*\\w*(?:prior|saved|orig|before|previous)\\w*`,
      "i",
    ).test(src)

  test("🔴 a fenced variable is RESTORED, never deleted outright", () => {
    const offenders = ROOTS.flatMap((root) => testFiles(root))
      .filter((f) => f !== SELF)
      .flatMap((f) => {
        const src = stripComments(readFileSync(f, "utf8"))
        return FENCED.filter((name) => deletes(src, name)).map((name) => `${f} → ${name}`)
      })
    expect(
      offenders,
      "restore the prior value instead — bun shares one process across every test file",
    ).toEqual([])
  })

  test("ANTI-VACUITY: the detector fires on both spellings", () => {
    expect(deletes("delete process.env.QUANTA_BENCH_HOME", "QUANTA_BENCH_HOME")).toBe(true)
    expect(deletes('delete process.env["QUANTA_BENCH_HOME"]', "QUANTA_BENCH_HOME")).toBe(true)
    // the CONDITIONAL form is a correct restore, not a finding
    expect(
      deletes("if (prior === undefined) delete process.env.QUANTA_BENCH_HOME", "QUANTA_BENCH_HOME"),
    ).toBe(false)
    // an unconditional delete during setup is fine when the file restores later
    expect(
      deletes("delete process.env.QUANTA_HOME\nprocess.env.QUANTA_HOME = savedHome", "QUANTA_HOME"),
    ).toBe(false)
    // …but not when nothing puts it back
    expect(deletes("delete process.env.QUANTA_HOME\nconst x = 1", "QUANTA_HOME")).toBe(true)
    // restoring is what we want, and must not be flagged
    expect(deletes("process.env.QUANTA_BENCH_HOME = prior", "QUANTA_BENCH_HOME")).toBe(false)
  })
})
