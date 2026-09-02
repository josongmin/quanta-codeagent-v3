import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * The unit speed budget stopped executing the unit suite for itself and now
 * consumes the FULL-suite junit scoped to `tests/unit/`. That scoping had
 * never run against a real merged receipt: the full-suite gate has to finish
 * before the consumer is even reached, so a scope that silently matched
 * nothing would surface as a red gate at the END of a 25-minute campaign, and
 * would read as "the budget broke" rather than "the filter missed".
 *
 * The fixture is the exact shape Bun's junit reporter emits (measured on
 * 1.3.14: `file` is written RELATIVE to the worker cwd even when the command
 * line carried absolute paths) merged the way the runner merges chunks.
 */

const SCRIPT = join(import.meta.dir, "..", "..", "..", "tools", "dev", "unit-speed-budget.ts")
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const suite = (file: string, cases: readonly { name: string; seconds: number }[]): string =>
  `<testsuite name="${file}" file="${file}" tests="${cases.length}" assertions="${cases.length}" failures="0" skipped="0" time="0.1" hostname="test">\n` +
  cases
    .map(
      (one) =>
        `  <testcase name="${one.name}" classname="" time="${one.seconds}" file="${file}" line="1" assertions="1" />`,
    )
    .join("\n") +
  "\n</testsuite>"

const mergedJunit = (bodies: readonly string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-speed-scope-"))
  roots.push(dir)
  const path = join(dir, "full-junit.xml")
  writeFileSync(
    path,
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test sharded">\n${bodies.join("\n")}\n</testsuites>\n`,
  )
  return path
}

/** 1,200 fast unit cases: comfortably over the script's anti-vacuity floor. */
const fastUnitSuites = (): string[] =>
  Array.from({ length: 12 }, (_, index) =>
    suite(
      `tests/unit/fixture-${index}.test.ts`,
      Array.from({ length: 100 }, (_, caseIndex) => ({
        name: `case ${caseIndex}`,
        seconds: 0.001,
      })),
    ),
  )

const run = (
  xmlPath: string,
  args: readonly string[],
): { readonly code: number; readonly out: string; readonly err: string } => {
  const proc = Bun.spawnSync([process.execPath, SCRIPT, xmlPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    code: proc.exitCode ?? 1,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  }
}

describe("unit speed budget over the full-suite receipt", () => {
  test("scoping counts the unit tier and ignores the rest", () => {
    const xml = mergedJunit([
      ...fastUnitSuites(),
      suite("tests/integration/slow-e2e.test.ts", [{ name: "slow rail", seconds: 30 }]),
      suite("tests/meta/whatever.test.ts", [{ name: "meta", seconds: 5 }]),
    ])
    const scoped = run(xml, ["--scope=tests/unit/"])
    expect(scoped.code, `${scoped.out}\n${scoped.err}`).toBe(0)
    // Only the 1,200 unit cases are counted — not the 2 outside the scope.
    expect(scoped.out).toContain("unit-speed-budget: 1200 tests")
  })

  test("a slow INTEGRATION test cannot trip the unit ceiling", () => {
    // This is the reason the budget is scoped rather than fed the unit suite:
    // integration owns the cases that are legitimately slow, and before the
    // scope existed they were simply not in the file it read.
    const xml = mergedJunit([
      ...fastUnitSuites(),
      suite("tests/integration/very-slow-e2e.test.ts", [{ name: "60s rail", seconds: 60 }]),
    ])
    expect(run(xml, ["--scope=tests/unit/"]).code).toBe(0)

    // Paired control: the SAME receipt without the scope sees the 60s case and
    // the gate goes red. The filter is doing the work, not the fixture.
    const unscoped = run(xml, [])
    expect(unscoped.code).toBe(1)
    expect(unscoped.err).toContain("REGRESSION")
  })

  test("a scope that matches nothing fails closed instead of passing empty", () => {
    const xml = mergedJunit(fastUnitSuites())
    const missed = run(xml, ["--scope=tests/does-not-exist/"])
    expect(missed.code).toBe(1)
    expect(missed.err).toContain("only 0 testcases parsed")
  })
})
