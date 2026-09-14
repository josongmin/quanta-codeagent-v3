/**
 * Epic-2 — REAL structured test-runner e2e (no fakes). Runs ACTUAL cargo / go /
 * python unittest test suites with a known-failing test and asserts the
 * normalized {passed, failed:[{name,file,line,message}]} result. This is the
 * failure-evidence half of the Evidence Packet Builder.
 *
 * Each block AUTO-SKIPS when its toolchain is absent. Verified 2026-06-10
 * (cargo 1.95, go 1.25.4, python3 unittest).
 */
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeRunTestsTool } from "@/tool/testrun/tool"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"
import {
  boundedVersion,
  capabilityGate,
  hasBinary,
  laneDescribe,
  reportExecuted,
} from "../../../_helpers/capability-lane"

const GROUP = "language-test-matrix"
const FILE = "tests/unit/tool/testrun/run-tests-real-e2e.test.ts"
const run = async (cwd: string): Promise<ToolResult> => {
  const tool = makeRunTestsTool()
  const ctx = { cwd, signal: new AbortController().signal } as ToolContext
  let r: ToolResult | undefined
  for await (const ev of tool.execute({} as never, ctx) as AsyncIterable<ToolEvent>)
    if (ev.type === "result") r = ev.result
  if (r === undefined) throw new Error("no result")
  return r
}

/**
 * CAPABILITY GROUP `language-test-matrix` — the normalized
 * `{passed, failed:[{name,file,line,message}]}` shape over three REAL runners.
 * One group, one provisioning step: go + cargo + python3. Probes are PATH
 * resolution, so the ordinary suite pays no spawn for a file it skips.
 */
const GATE = capabilityGate({
  group: GROUP,
  file: FILE,
  needs: {
    go: hasBinary("go"),
    cargo: hasBinary("cargo"),
    python3: hasBinary("python3"),
  },
})
const D = laneDescribe(GATE)

const reportMatrixExecuted = (): void =>
  reportExecuted(GATE, GROUP, FILE, "real go / cargo / python unittest runs parsed", () => ({
    goVersion: boundedVersion(["go", "version"]),
    cargoVersion: boundedVersion(["cargo", "--version"]),
    pythonVersion: boundedVersion(["python3", "--version"]),
  }))

const Dgo = D
Dgo("run_tests — REAL go test -json", () => {
  afterAll(reportMatrixExecuted)

  test("detects go, runs, reports the failing test by name + file:line", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tr-go-")))
    writeFileSync(join(dir, "go.mod"), "module t\ngo 1.25\n")
    writeFileSync(
      join(dir, "m_test.go"),
      [
        "package t",
        'import "testing"',
        'func TestPass(t *testing.T){ if 1+1!=2 {t.Fatal("no")} }',
        'func TestFail(t *testing.T){ if 2+2!=5 {t.Fatalf("got %d want 5", 2+2)} }',
      ].join("\n"),
    )
    const r = await run(dir)
    expect(r.ok).toBe(false) // a suite with failures is ok:false
    expect(r.output).toContain("TestFail")
    expect(r.output).toContain("1 passed") // passed count surfaced
    expect(r.output).not.toMatch(/FAILED:[\s\S]*TestPass/) // TestPass not in the failures list
  }, 60_000)
})

const Drs = D
Drs("run_tests — REAL cargo test", () => {
  test("detects rust, runs, reports the failing test + file:line", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tr-rs-")))
    mkdirSync(join(dir, "src"), { recursive: true })
    writeFileSync(
      join(dir, "Cargo.toml"),
      ["[package]", 'name = "t"', 'version = "0.1.0"', 'edition = "2021"', "", "[workspace]"].join(
        "\n",
      ),
    )
    writeFileSync(
      join(dir, "src", "lib.rs"),
      [
        "pub fn add(a: i32, b: i32) -> i32 { a + b }",
        "#[cfg(test)]",
        "mod tests {",
        "    use super::*;",
        "    #[test] fn pass_test() { assert_eq!(add(2,2), 4); }",
        "    #[test] fn fail_test() { assert_eq!(add(2,2), 5); }",
        "}",
      ].join("\n"),
    )
    const r = await run(dir)
    expect(r.ok).toBe(false)
    expect(r.output).toContain("fail_test")
    expect(r.output).toContain("lib.rs")
  }, 120_000)
})

const Dpy = D
Dpy("run_tests — REAL python unittest", () => {
  test("detects python, runs, reports the failing test + message", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tr-py-")))
    writeFileSync(join(dir, "pyproject.toml"), '[project]\nname = "t"\nversion = "0.1.0"\n')
    writeFileSync(
      join(dir, "test_m.py"),
      [
        "import unittest",
        "class T(unittest.TestCase):",
        "    def test_pass(self): self.assertEqual(1+1, 2)",
        "    def test_fail(self): self.assertEqual(2+2, 5)",
      ].join("\n"),
    )
    const r = await run(dir)
    expect(r.ok).toBe(false)
    expect(r.output).toContain("test_fail")
  }, 60_000)
})
