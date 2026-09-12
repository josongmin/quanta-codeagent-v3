// meta-test: exercises tools/feature-catalog/* (lives outside src/, no @/ alias).
import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  composeBaseline,
  countBiomeErrors,
  countTscErrors,
  parseBunTestOutput,
} from "../../tools/feature-catalog/refresh-baseline"

describe("parseBunTestOutput", () => {
  test("happy path: full footer with all five counters", () => {
    const text = [
      "bun test v1.3.14 (0d9b296a)",
      "[error] some stderr noise",
      "",
      " 1952 pass",
      " 2 skip",
      " 0 fail",
      " 5624 expect() calls",
      "Ran 1954 tests across 154 files. [26.27s]",
    ].join("\n")
    expect(parseBunTestOutput(text)).toEqual({
      pass: 1952,
      fail: 0,
      skip: 2,
      expect_count: 5624,
      files: 154,
    })
  })

  test("zero pass / nonzero fail still parses (no implicit success bias)", () => {
    const text = [
      " 0 pass",
      " 12 fail",
      " 0 skip",
      " 0 expect() calls",
      "Ran 12 tests across 3 files. [0.42s]",
    ].join("\n")
    expect(parseBunTestOutput(text)).toEqual({
      pass: 0,
      fail: 12,
      skip: 0,
      expect_count: 0,
      files: 3,
    })
  })

  test("counters embedded mid-line still match (no anchor lock-in)", () => {
    const text = "prefix 7 pass and 1 fail and 0 skip 42 expect() calls done across 5 files."
    expect(parseBunTestOutput(text)).toEqual({
      pass: 7,
      fail: 1,
      skip: 0,
      expect_count: 42,
      files: 5,
    })
  })

  test("CRLF + extra blank lines tolerated", () => {
    const text = " 100 pass\r\n 0 fail\r\n 0 skip\r\n\r\n 250 expect() calls\r\nacross 10 files\r\n"
    expect(parseBunTestOutput(text)).toEqual({
      pass: 100,
      fail: 0,
      skip: 0,
      expect_count: 250,
      files: 10,
    })
  })

  test("missing one counter returns null (no silent zero-fill)", () => {
    const text = " 1 pass\n 0 fail\n 0 skip\n 1 expect() calls" // no `across N files`
    expect(parseBunTestOutput(text)).toBeNull()
  })

  test("totally malformed → null", () => {
    expect(parseBunTestOutput("garbage in, garbage out")).toBeNull()
  })

  test("empty string → null", () => {
    expect(parseBunTestOutput("")).toBeNull()
  })
})

describe("countTscErrors", () => {
  test("counts each `(LINE,COL): error TSxxxx:` row exactly once", () => {
    const text = [
      "tests/unit/foo.test.ts(143,15): error TS2339: Property 'x' does not exist on type 'Y'.",
      "tests/unit/bar.test.ts(37,34): error TS2554: Expected 0 arguments, but got 1.",
      "tests/unit/bar.test.ts(57,16): error TS2339: Property 'z' does not exist.",
      "",
      "Found 3 errors in 2 files.",
    ].join("\n")
    expect(countTscErrors(text)).toBe(3)
  })

  test("clean output → 0", () => {
    expect(countTscErrors("")).toBe(0)
  })

  test("non-matching diagnostic text → 0", () => {
    expect(countTscErrors("tsc completed successfully\nFound 0 errors.")).toBe(0)
  })
})

describe("countBiomeErrors", () => {
  test("counts each `× ...` diagnostic header", () => {
    const text = [
      "  × Unused variable foo",
      "  × Unused import bar",
      "  × noExplicitAny",
      "Checked 315 files. 3 errors.",
    ].join("\n")
    expect(countBiomeErrors(text)).toBe(3)
  })

  test("clean output → 0", () => {
    expect(countBiomeErrors("Checked 315 files in 372ms. No fixes applied.")).toBe(0)
  })
})

describe("the refresher carries every block it does not measure", () => {
  const measured = {
    generated_at: "2026-09-12T00:00:00.000Z",
    measured_at_commit: "abc1234",
    tsc: { exit: 0, errors: 0 },
    biome: { exit: 0, errors: 0 },
    tests: {
      pass: 1,
      fail: 0,
      skip: 0,
      expect_count: 1,
      files: 1,
      by_tier: {
        unit: { files: 0, tests: 0 },
        integration: { files: 0, tests: 0 },
        contract: { files: 0, tests: 0 },
      },
    },
  }

  /**
   * `refresh-baseline.ts` built a fresh object with no `fc` key and wrote it over
   * the file. A single run would have DELETED `empty_stubs_max` and the nineteen
   * grandfathered orphan-ADR paths that `bun fc lint` compares against, turning a
   * tolerated backlog into a red gate. Nobody had run it, which is the only reason
   * the data survived.
   */
  test("the fc sub-ratchet block survives a refresh", () => {
    const fc = {
      empty_stubs_max: 0,
      orphan_adr_paths_grandfathered: ["docs/decisions/0166-burnrate-alerts.md"],
    }
    const out = composeBaseline({ fc }, measured)
    expect(out.fc).toEqual(fc)
    // and the measurements really are replaced, not merged away
    expect(out.tsc).toEqual({ exit: 0, errors: 0 })
    expect(out.measured_at_commit).toBe("abc1234")
  })

  test("an absent fc block is not invented", () => {
    expect("fc" in composeBaseline({}, measured)).toBe(false)
  })

  test("the real baseline.json on disk still carries its fc block", async () => {
    // Anchored on THIS file, not the ambient cwd. A relative path here reads the
    // wrong file (or none) when the runner is launched from anywhere but the repo
    // root, which `repo-path-anchor-ratchet` forbids — and which it caught: this arm
    // sat RED on main, inside a tier that never completes.
    const baselinePath = join(import.meta.dir, "..", "..", "tools/feature-catalog/baseline.json")
    const raw = JSON.parse(await readFile(baselinePath, "utf8")) as {
      fc?: { orphan_adr_paths_grandfathered?: unknown[] }
    }
    expect(raw.fc, "baseline.json lost its fc block — fc lint's allowlist is gone").toBeDefined()
    // Anti-vacuity: an empty allowlist would satisfy "defined" while having lost
    // every row it exists to hold.
    expect(raw.fc?.orphan_adr_paths_grandfathered?.length ?? 0).toBeGreaterThan(10)
  })
})
