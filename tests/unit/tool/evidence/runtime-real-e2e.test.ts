/**
 * Keystone runtime port — REAL e2e. The `defaultRuntimePort` runs the FAILING
 * test under debugpy with a breakpoint at the failure line and captures the
 * stack + locals — so the Evidence Packet's `runtime` section shows the actual
 * variable values that explain the failure (e.g. `result = 10` when the test
 * expected 99). This is the last LIVE section of the keystone.
 *
 * AUTO-SKIPS without python3 + debugpy. Verified 2026-06-10.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildEvidence } from "@/tool/evidence/builder"
import { defaultRuntimePort } from "@/tool/evidence"
import { detectToolchain, runToolchain } from "@/tool/testrun"

const has = (bin: string, ...a: string[]): boolean => {
  try {
    return Bun.spawnSync([bin, ...a], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
  } catch {
    return false
  }
}
const hasDebugpy = (): boolean => has("python3", "-c", "import debugpy")
const lldbDap = (): boolean => {
  if (has("lldb-dap", "--help")) return true
  try {
    return Bun.spawnSync(["xcrun", "-f", "lldb-dap"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
  } catch {
    return false
  }
}
const D = hasDebugpy() ? describe : describe.skip
const buildSources = (dir: string) => ({
  detect: (c: string) => detectToolchain(c, { fileExists: async (n: string) => existsSync(join(c, n)) }),
  runTests: (tc: never, c: string) => runToolchain(tc, c),
  runtime: defaultRuntimePort,
  changedFiles: async () => [] as string[],
})

const TEST_PY = [
  "import unittest",
  "def compute(n):",
  "    total = 0",
  "    for i in range(n):",
  "        total += i",
  "    return total",
  "class T(unittest.TestCase):",
  "    def test_fail(self):",
  "        result = compute(5)",
  "        self.assertEqual(result, 99)  # line 10 — result is really 10",
].join("\n")

D("defaultRuntimePort — REAL debugpy runtime capture in the evidence packet", () => {
  test("buildEvidence captures the failing test's stack + locals (the values that explain the failure)", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt-")))
    writeFileSync(join(dir, "pyproject.toml"), '[project]\nname = "t"\nversion = "0.1.0"\n')
    writeFileSync(join(dir, "test_m.py"), TEST_PY)

    const pkt = await buildEvidence(dir, {
      detect: (c) => detectToolchain(c, { fileExists: async (n) => existsSync(join(c, n)) }),
      runTests: (tc, c) => runToolchain(tc, c),
      runtime: defaultRuntimePort, // real debugpy under the hood
      changedFiles: async () => ["test_m.py"],
    })

    expect(pkt.failure?.test_name).toContain("test_fail")
    expect(pkt.runtime).not.toBeNull()
    // The captured locals expose the REAL value that made the assertion fail.
    const result = pkt.runtime?.locals.find((v) => v.name === "result")
    expect(result?.value).toBe("10")
    // Stack points into the failing test.
    expect(pkt.runtime?.stack.some((f) => f.name.includes("test_fail"))).toBe(true)
  }, 90_000)
})

// ── RUST runtime via lldb-dap (cargo test --no-run → test binary under lldb) ──
const DR = has("cargo", "--version") && lldbDap() ? describe : describe.skip
DR("defaultRuntimePort — REAL Rust runtime capture (cargo + lldb-dap)", () => {
  test("buildEvidence captures the failing Rust test's locals (result=10)", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt-rs-")))
    mkdirSync(join(dir, "src"), { recursive: true })
    writeFileSync(join(dir, "Cargo.toml"), ['[package]', 'name = "t"', 'version = "0.1.0"', 'edition = "2021"'].join("\n"))
    writeFileSync(
      join(dir, "src", "lib.rs"),
      [
        "pub fn compute(n: i32) -> i32 {",
        "    let mut total = 0;",
        "    for i in 0..n { total += i; }",
        "    total",
        "}",
        "#[cfg(test)]",
        "mod tests {",
        "    use super::*;",
        "    #[test]",
        "    fn fail_test() {",
        "        let result = compute(5);",
        "        assert_eq!(result, 99);  // line 12",
        "    }",
        "}",
      ].join("\n"),
    )
    const pkt = await buildEvidence(dir, buildSources(dir) as never)
    expect(pkt.failure?.test_name).toContain("fail_test")
    expect(pkt.runtime).not.toBeNull()
    expect(pkt.runtime?.locals.find((v) => v.name === "result")?.value).toBe("10")
    expect(pkt.runtime?.stack.length).toBeLessThanOrEqual(12) // runtime-noise cap
    expect(pkt.runtime?.stack.some((f) => f.name.includes("fail_test"))).toBe(true)
  }, 120_000)
})

// ── GO runtime via dlv dap (over the TCP transport — its first real consumer) ──
const dlvOk = (): boolean => has("dlv", "version") || has(`${process.env.HOME}/go/bin/dlv`, "version")
const DG = has("go", "version") && dlvOk() ? describe : describe.skip
DG("defaultRuntimePort — REAL Go runtime capture (dlv dap over TCP)", () => {
  test("buildEvidence captures the failing Go test's locals via the TCP DAP transport", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt-go-")))
    writeFileSync(join(dir, "go.mod"), "module t\ngo 1.25\n")
    writeFileSync(
      join(dir, "m_test.go"),
      [
        "package t",
        'import "testing"',
        "func compute(n int) int { total := 0; for i := 0; i < n; i++ { total += i }; return total }",
        "func TestFail(t *testing.T) {",
        "\tresult := compute(5)",
        "\tif result != 99 {",
        '\t\tt.Fatalf("got %d", result)',
        "\t}",
        "}",
      ].join("\n"),
    )
    // dlv may need its bin dir on PATH for the go toolchain; the resolver finds it.
    const pkt = await buildEvidence(dir, buildSources(dir) as never)
    expect(pkt.failure?.test_name).toContain("TestFail")
    expect(pkt.runtime).not.toBeNull()
    expect(pkt.runtime?.locals.find((v) => v.name === "result")?.value).toBe("10")
    expect(pkt.runtime?.stack.some((f) => f.name.includes("TestFail"))).toBe(true)
  }, 120_000)
})
