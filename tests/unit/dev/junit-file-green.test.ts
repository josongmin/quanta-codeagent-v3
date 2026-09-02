import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCRIPT = join(import.meta.dir, "..", "..", "..", "tools", "dev", "junit-file-green.ts")
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const receipt = (suites: readonly string[]): string => {
  const root = mkdtempSync(join(tmpdir(), "junit-file-green-"))
  roots.push(root)
  const path = join(root, "receipt.xml")
  writeFileSync(
    path,
    `<?xml version="1.0"?>\n<testsuites name="bun test sharded">\n${suites.join("\n")}\n</testsuites>\n`,
  )
  return path
}

const suite = (file: string, attrs: string): string =>
  `<testsuite name="${file}" file="${file}" ${attrs}><testcase name="t" time="0.001" file="${file}" /></testsuite>`

const run = (
  args: readonly string[],
): { readonly code: number; readonly out: string; readonly err: string } => {
  const proc = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    code: proc.exitCode ?? 1,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  }
}

describe("junit receipt consumer (no second execution)", () => {
  test("a green suite entry passes; every listed file must be present", () => {
    const xml = receipt([
      suite("tests/unit/pm-dod-ratchet.test.ts", 'tests="12" failures="0" skipped="0"'),
      suite(
        "tests/meta/preload-runtime-closure-hellgate.test.ts",
        'tests="3" failures="0" skipped="1"',
      ),
    ])
    const both = run([
      xml,
      "tests/unit/pm-dod-ratchet.test.ts",
      "tests/meta/preload-runtime-closure-hellgate.test.ts",
    ])
    expect(both.code, both.err).toBe(0)
    expect(both.out).toContain("green in receipt (tests=12")

    // Red-on-injection: a file the receipt never mentions can never pass.
    const missing = run([xml, "tests/unit/not-in-receipt.test.ts"])
    expect(missing.code).toBe(1)
    expect(missing.err).toContain("NOT PRESENT")
  })

  test("failures, vacuous entries, and all-skipped receipts fail closed", () => {
    const xml = receipt([
      suite("red.test.ts", 'tests="4" failures="1" skipped="0"'),
      suite("empty.test.ts", 'tests="0" failures="0" skipped="0"'),
      suite("skipped.test.ts", 'tests="5" failures="0" skipped="5"'),
    ])
    expect(run([xml, "red.test.ts"]).code).toBe(1)
    expect(run([xml, "red.test.ts"]).err).toContain("RED in receipt")
    expect(run([xml, "empty.test.ts"]).code).toBe(1)
    expect(run([xml, "skipped.test.ts"]).code).toBe(1)
    expect(run([xml, "skipped.test.ts"]).err).toContain("vacuous")
  })

  test("an unreadable receipt is a failure, never a pass", () => {
    const gone = run(["/nonexistent/receipt.xml", "a.test.ts"])
    expect(gone.code).toBe(1)
    expect(gone.err).toContain("cannot read receipt")
    expect(run([]).code).toBe(1)
  })
})
