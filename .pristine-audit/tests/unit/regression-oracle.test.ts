import { describe, expect, it } from "bun:test"
import {
  makeRegressionOracle,
  parseFailedTests,
  type RegressionExecPort,
  toRegressionGreen,
} from "@/runner/batch/eval/regression-oracle"

/** Deterministic fake exec: returns a scripted result and records the call. */
const fakeExec = (result: {
  code: number
  stdout: string
  stderr: string
}): { exec: RegressionExecPort; calls: { argv: readonly string[]; cwd: string; t: number }[] } => {
  const calls: { argv: readonly string[]; cwd: string; t: number }[] = []
  const exec: RegressionExecPort = async (argv, cwd, t) => {
    calls.push({ argv, cwd, t })
    return result
  }
  return { exec, calls }
}

const buildArgv = (tests: readonly string[]): readonly string[] => ["pytest", ...tests]

describe("parseFailedTests (advisory id parse)", () => {
  it("parses FAILED and ERROR short-summary lines, deduped + order-preserving", () => {
    const out = parseFailedTests(
      [
        "some noise",
        "FAILED tests/test_a.py::test_one - AssertionError",
        "ERROR tests/test_b.py::test_two",
        "FAILED tests/test_a.py::test_one", // dup
        "tests/test_c.py::test_three FAILED", // verbose form
      ].join("\n"),
    )
    expect(out).toEqual([
      "tests/test_a.py::test_one",
      "tests/test_b.py::test_two",
      "tests/test_c.py::test_three",
    ])
  })

  it("returns [] when no failure markers present (green output)", () => {
    expect(parseFailedTests("=== 19 passed in 2.1s ===")).toEqual([])
  })

  it("strips the xdist worker tag instead of capturing it as the id", () => {
    expect(parseFailedTests("[gw0] FAILED tests/test_x.py::test_a")).toEqual([
      "tests/test_x.py::test_a",
    ])
  })

  it("captures the node-id from 'ERROR at setup of <id>', not the word 'at'", () => {
    expect(parseFailedTests("ERROR at setup of tests/test_x.py::test_a")).toEqual([
      "tests/test_x.py::test_a",
    ])
  })

  it("drops tokens without node-id shape (no `::`/`.py`) rather than guessing", () => {
    // a stray "FAILED" sentence fragment must not yield a bogus id
    expect(parseFailedTests("FAILED to connect to database")).toEqual([])
  })
})

describe("makeRegressionOracle.run", () => {
  it("RED-on-injection: a runner exit≠0 → pass:false + parsed failed ids", async () => {
    const { exec } = fakeExec({
      code: 1,
      stdout: "FAILED tests/test_x.py::test_a\n=== 1 failed, 18 passed ===",
      stderr: "",
    })
    const r = await makeRegressionOracle().run({
      tests: ["tests/test_x.py::test_a", "tests/test_x.py::test_b"],
      sandbox: "/box",
      exec,
      timeoutMs: 1000,
      buildArgv,
    })
    expect(r.pass).toBe(false)
    expect(r.ran).toBe(true) // exit 1 = a real failing verdict
    expect(r.failed).toEqual(["tests/test_x.py::test_a"])
  })

  it("PAIRED control: the SAME tests with exit 0 → pass:true, ran:true, no failed", async () => {
    const { exec } = fakeExec({ code: 0, stdout: "=== 19 passed ===", stderr: "" })
    const r = await makeRegressionOracle().run({
      tests: ["tests/test_x.py::test_a", "tests/test_x.py::test_b"],
      sandbox: "/box",
      exec,
      timeoutMs: 1000,
      buildArgv,
    })
    expect(r.pass).toBe(true)
    expect(r.ran).toBe(true)
    expect(r.failed).toEqual([])
  })

  it("FAIL-OPEN #1: pytest exit 5 (no tests collected) → ran:false, NOT a regression", async () => {
    const { exec } = fakeExec({ code: 5, stdout: "no tests ran in 0.01s", stderr: "" })
    const r = await makeRegressionOracle().run({
      tests: ["tests/test_renamed.py::gone"],
      sandbox: "/box",
      exec,
      timeoutMs: 1000,
      buildArgv,
    })
    expect(r.ran).toBe(false) // never reached a verdict
    expect(r.failed).toEqual([]) // nothing actually failed
    // the false-RED that would defeat the invariant is averted at the mapping:
    expect(toRegressionGreen(["tests/test_renamed.py::gone"], r)).toBeNull()
  })

  it("verdictCodes override admits a non-pytest runner's success code", async () => {
    const { exec } = fakeExec({ code: 0, stdout: "OK", stderr: "" })
    const r = await makeRegressionOracle().run({
      tests: ["t::a"],
      sandbox: "/box",
      exec,
      timeoutMs: 1000,
      buildArgv,
      verdictCodes: [0],
    })
    expect(r.ran).toBe(true)
    expect(r.pass).toBe(true)
  })

  it("M18 advisory purity: clean exit ⇒ failed:[] even when stdout has FAILED-looking text", async () => {
    const { exec } = fakeExec({
      code: 0,
      stdout: "FAILED tests/test_z.py::test_q\n=== passed ===",
      stderr: "",
    })
    const r = await makeRegressionOracle().run({
      tests: ["t::a"],
      sandbox: "/box",
      exec,
      timeoutMs: 1000,
      buildArgv,
    })
    expect(r).toEqual({ pass: true, ran: true, failed: [] }) // exit-code drives it; no advisory leak
  })

  it("wiring-proof: buildArgv receives the tests and exec gets sandbox cwd + timeout", async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: "", stderr: "" })
    await makeRegressionOracle().run({
      tests: ["t::a", "t::b"],
      sandbox: "/sandbox/abc",
      exec,
      timeoutMs: 4242,
      buildArgv,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.argv).toEqual(["pytest", "t::a", "t::b"])
    expect(calls[0]?.cwd).toBe("/sandbox/abc")
    expect(calls[0]?.t).toBe(4242)
  })

  it("empty test set → vacuous pass without invoking exec", async () => {
    const { exec, calls } = fakeExec({ code: 1, stdout: "FAILED x", stderr: "" })
    const r = await makeRegressionOracle().run({
      tests: [],
      sandbox: "/box",
      exec,
      timeoutMs: 1000,
      buildArgv,
    })
    expect(r).toEqual({ pass: true, ran: false, failed: [] })
    expect(calls).toHaveLength(0) // never ran the (failing) exec
  })
})

describe("toRegressionGreen (fail-open mapping)", () => {
  it("empty test set ⇒ null (FAIL-OPEN, never rejects)", () => {
    expect(toRegressionGreen([], { pass: false, ran: true, failed: ["x"] })).toBeNull()
  })

  it("absent run (result null) ⇒ null (FAIL-OPEN)", () => {
    expect(toRegressionGreen(["t::a"], null)).toBeNull()
  })

  it("non-verdict run (ran:false) ⇒ null (FAIL-OPEN) even though pass is false", () => {
    expect(toRegressionGreen(["t::a"], { pass: false, ran: false, failed: [] })).toBeNull()
  })

  it("real verdict maps pass→true / fail→false", () => {
    expect(toRegressionGreen(["t::a"], { pass: true, ran: true, failed: [] })).toBe(true)
    expect(toRegressionGreen(["t::a"], { pass: false, ran: true, failed: ["t::a"] })).toBe(false)
  })
})

describe("no-leak slice-fence", () => {
  it("the engine port names no official SWE-bench hidden field", async () => {
    const src = await Bun.file(
      new URL("../../src/runner/batch/eval/regression-oracle.ts", import.meta.url),
    ).text()
    // Strip the docstring (which legitimately *names* the forbidden tokens to
    // explain the fence) before asserting the executable body is clean.
    const body = src.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    expect(body).not.toContain("PASS_TO_PASS")
    expect(body).not.toContain("FAIL_TO_PASS")
    expect(body).not.toContain("test_patch")
  })
})
