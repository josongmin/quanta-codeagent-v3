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
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildEvidence } from "@/tool/evidence/builder"
import { defaultRuntimePort } from "@/tool/evidence"
import { detectToolchain, runToolchain } from "@/tool/testrun"

const hasDebugpy = (): boolean => {
  try {
    return Bun.spawnSync(["python3", "-c", "import debugpy"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
  } catch {
    return false
  }
}
const D = hasDebugpy() ? describe : describe.skip

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
