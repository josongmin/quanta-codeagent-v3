/**
 * HELLGATE — `bun test` output parser + quarantine matcher (test-resilience ④).
 *
 * The flake-resilient runner's correctness hinges on this parser: a mis-parse
 * either (a) drops a REAL failure (→ a bug ships green) or (b) mis-attributes a
 * failure to the wrong file (→ isolation re-run targets the wrong test and
 * mis-classifies). So the brittle text parsing gets adversarial coverage:
 * multi-file sections, ANSI codes, timing suffixes, describe-chains, summary
 * extraction, and the quarantine substring/suffix match.
 *
 * RED-ON-INJECTION (verified in-session): breaking the file-header tracking
 * (attributing every fail to "") or dropping the `> ` leaf split makes the
 * file-attribution / leaf cases below fail.
 */

import { describe, expect, test } from "bun:test"
import {
  isQuarantined,
  type ParsedFailure,
  parseBunTestOutput,
  type QuarantineLedger,
} from "../../../tools/test-resilience/parse"

describe("HELLGATE: bun-test output parser", () => {
  test("attributes each (fail) to the CORRECT preceding file header", () => {
    const out = [
      "bun test v1.3.14",
      "",
      "tests/unit/a.test.ts:",
      "(fail) groupA > does X [12.34ms]",
      "",
      "tests/unit/b.test.ts:",
      "(fail) groupB > nested > does Y [0.50ms]",
      "(fail) groupB > does Z",
      "",
      " 100 pass",
      " 3 fail",
      "Ran 103 tests across 2 files.",
    ].join("\n")
    const r = parseBunTestOutput(out)
    expect(r.pass).toBe(100)
    expect(r.fail).toBe(3)
    expect(r.failures).toHaveLength(3)
    // file attribution is the load-bearing property (isolation re-run targets it)
    expect(r.failures[0]).toEqual({
      file: "tests/unit/a.test.ts",
      name: "groupA > does X",
      leaf: "does X",
    })
    expect(r.failures[1]?.file).toBe("tests/unit/b.test.ts")
    expect(r.failures[1]?.leaf).toBe("does Y") // leaf = after the LAST ` > `
    expect(r.failures[2]?.file).toBe("tests/unit/b.test.ts") // still b, no new header
  })

  test("strips ANSI color codes before matching", () => {
    const out = [
      "\x1b[2mtests/unit/c.test.ts:\x1b[0m",
      "\x1b[31m(fail)\x1b[0m groupC > red [1ms]",
    ].join("\n")
    const r = parseBunTestOutput(out)
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]?.file).toBe("tests/unit/c.test.ts")
    expect(r.failures[0]?.leaf).toBe("red")
  })

  test("a clean run yields zero failures", () => {
    const r = parseBunTestOutput(["tests/unit/d.test.ts:", " 42 pass", " 0 fail"].join("\n"))
    expect(r.failures).toHaveLength(0)
    expect(r.fail).toBe(0)
    expect(r.pass).toBe(42)
  })

  test("a (fail) with no timing suffix still parses (name not truncated)", () => {
    const r = parseBunTestOutput(
      ["tests/unit/e.test.ts:", "(fail) plain name no timing"].join("\n"),
    )
    expect(r.failures[0]?.name).toBe("plain name no timing")
  })

  test("captures the error count distinctly from fail", () => {
    const r = parseBunTestOutput([" 10 pass", " 2 fail", " 1 error"].join("\n"))
    expect(r.fail).toBe(2)
    expect(r.error).toBe(1)
  })
})

describe("HELLGATE: quarantine matcher", () => {
  const ledger: QuarantineLedger = {
    maxCount: 4,
    entries: [
      {
        file: "tests/unit/evidence-lsp-bridge-real-e2e.test.ts",
        name: "queries the real server at a failure site",
        resourceClass: "external-server",
        reason: "rust-analyzer thundering-herd",
      },
    ],
  }

  test("matches by file SUFFIX + name SUBSTRING (mirrors -t)", () => {
    const f: ParsedFailure = {
      file: "tests/unit/evidence-lsp-bridge-real-e2e.test.ts",
      name: "evidenceLspStatic > queries the real server at a failure site and returns StaticEvidence",
      leaf: "queries the real server at a failure site and returns StaticEvidence",
    }
    expect(isQuarantined(f, ledger)).toBe(true)
  })

  test("does NOT match a different test in the same file (no over-quarantine)", () => {
    const f: ParsedFailure = {
      file: "tests/unit/evidence-lsp-bridge-real-e2e.test.ts",
      name: "evidenceLspStatic > some other unrelated assertion",
      leaf: "some other unrelated assertion",
    }
    expect(isQuarantined(f, ledger)).toBe(false)
  })

  test("does NOT match the same name in a DIFFERENT file", () => {
    const f: ParsedFailure = {
      file: "tests/unit/other.test.ts",
      name: "queries the real server at a failure site and returns StaticEvidence",
      leaf: "queries the real server at a failure site and returns StaticEvidence",
    }
    expect(isQuarantined(f, ledger)).toBe(false)
  })
})
