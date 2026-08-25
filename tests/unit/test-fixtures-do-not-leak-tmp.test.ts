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

const ROOTS = ["src", "tests", "tools"] as const

/** This file carries the pattern in string literals, on purpose, to prove the
 *  detector fires. It is the ONLY exemption, and it is named rather than
 *  pattern-matched so a second one cannot slip in behind it. */
const SELF = "tests/unit/test-fixtures-do-not-leak-tmp.test.ts"

const testFiles = (dir: string, into: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) testFiles(full, into)
    else if (full.endsWith(".test.ts")) into.push(full)
  }
  return into
}

/**
 * Comments are not code. Every file converted away from the exit hook explains
 * WHY in a comment that names it, and this very file discusses it in prose — a
 * raw text scan flagged all ten of them.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")

const EXIT_HOOK = /process\.on\(\s*["']exit["']/

describe("temp-dir cleanup is registered with the test runner", () => {
  test('no test file relies on `process.on("exit")`, which bun test never fires', () => {
    const offenders = ROOTS.flatMap((root) => testFiles(root))
      .filter((f) => f !== SELF)
      .filter((f) => EXIT_HOOK.test(stripComments(readFileSync(f, "utf8"))))
    expect(
      offenders,
      "these files register cleanup bun test will never run — use `afterAll` instead",
    ).toEqual([])
  })

  test("ANTI-VACUITY: the scan reaches a real, populated set of test files", () => {
    // without this the guard passes just as well when the walk finds nothing
    const all = ROOTS.flatMap((root) => testFiles(root))
    expect(all.length).toBeGreaterThan(500)
    expect(all).toContain(SELF)
  })

  test("ANTI-VACUITY: the detector fires on the shape it is looking for", () => {
    const detect = (src: string) => EXIT_HOOK.test(stripComments(src))
    expect(detect('process.on("exit", () => rmSync(d))')).toBe(true)
    expect(detect("process.on('exit', cleanup)")).toBe(true)
    expect(detect("afterAll(() => rmSync(d))")).toBe(false)
    // …and the comment-stripping does not become a blanket amnesty: a line that
    // merely FOLLOWS a comment is still code.
    expect(detect('// use afterAll, not process.on("exit")')).toBe(false)
    expect(detect('/* not process.on("exit") */\nprocess.on("exit", cleanup)')).toBe(true)
  })
})
