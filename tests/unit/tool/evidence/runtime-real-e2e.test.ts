/**
 * Keystone runtime port — REAL e2e. The `defaultRuntimePort` runs the FAILING
 * test under debugpy with a breakpoint at the failure line and captures the
 * stack + locals — so the Evidence Packet's `runtime` section shows the actual
 * variable values that explain the failure (e.g. `result = 10` when the test
 * expected 99). This is the last LIVE section of the keystone.
 *
 * AUTO-SKIPS without python3 + debugpy, and is OPT-IN behind
 * `QUANTA_REAL_TOOLCHAIN_E2E` (`bun run test:real-toolchain`) — see the lane
 * note above the gates below. Verified 2026-06-10.
 */
import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultRuntimePort } from "@/tool/evidence"
import { buildEvidence } from "@/tool/evidence/builder"
import { detectToolchain, runToolchain } from "@/tool/testrun"
import {
  boundedVersion,
  capabilityGate,
  hasBinary,
  hasLldbDap,
  hasPythonModule,
  laneDescribe,
  reportExecuted,
} from "../../../_helpers/capability-lane"

const GROUP = "native-debugger"
const FILE = "tests/unit/tool/evidence/runtime-real-e2e.test.ts"

/**
 * CAPABILITY GROUP `native-debugger`, lane `nightly-heavy`.
 *
 * Three arms, three declared needs, one manifest entry. Every probe is BOUNDED:
 * `debugpy` genuinely requires an interpreter import (no stat can answer it) and
 * so runs `python3 -c "import debugpy"` under an explicit 5s deadline, while the
 * lldb-dap and dlv probes are PATH/toolchain-path resolution. The previous
 * versions were `Bun.spawnSync` with no timeout, at module load, on every
 * ordinary unit run — measured at 10,131ms / 9,469ms per case, past the
 * 8,529ms per-test budget.
 *
 * The interpreter probe is only paid when the LANE is selected; on an ordinary
 * run the gate short-circuits on the env before probing anything.
 */
const laneOn = process.env.QUANTA_REAL_TOOLCHAIN_E2E !== undefined
const PY_GATE = capabilityGate({
  group: GROUP,
  file: FILE,
  needs: { debugpy: laneOn && hasPythonModule("debugpy") },
})
const D = laneDescribe(PY_GATE)

const buildSources = (_dir: string) => ({
  detect: (c: string) =>
    detectToolchain(c, { fileExists: async (n: string) => existsSync(join(c, n)) }),
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
  afterAll(() =>
    reportExecuted(PY_GATE, GROUP, FILE, "real debugpy captured stack + locals", () => ({
      debugpyVersion: boundedVersion([
        "python3",
        "-c",
        "import debugpy;print(debugpy.__version__)",
      ]),
      pythonVersion: boundedVersion(["python3", "--version"]),
    })),
  )

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
const RS_GATE = capabilityGate({
  group: GROUP,
  file: FILE,
  needs: { cargo: hasBinary("cargo"), "lldb-dap": hasLldbDap() },
})
const DR = laneDescribe(RS_GATE)
DR("defaultRuntimePort — REAL Rust runtime capture (cargo + lldb-dap)", () => {
  afterAll(() =>
    reportExecuted(RS_GATE, GROUP, FILE, "real cargo test binary under lldb-dap", () => ({
      cargoVersion: boundedVersion(["cargo", "--version"]),
      lldbDapVersion: boundedVersion(["lldb-dap", "--version"]),
    })),
  )

  test("buildEvidence captures the failing Rust test's locals (result=10)", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt-rs-")))
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
// `dlv` is commonly installed to ~/go/bin, which is not always on PATH; stat it
// there rather than spawning it to find out.
const dlvOk = (): boolean =>
  hasBinary("dlv") || Bun.file(`${process.env.HOME ?? ""}/go/bin/dlv`).size > 0
const GO_GATE = capabilityGate({
  group: GROUP,
  file: FILE,
  needs: { go: hasBinary("go"), dlv: dlvOk() },
})
const DG = laneDescribe(GO_GATE)
DG("defaultRuntimePort — REAL Go runtime capture (dlv dap over TCP)", () => {
  afterAll(() =>
    reportExecuted(GO_GATE, GROUP, FILE, "real dlv dap captured a Go failure over TCP", () => ({
      goVersion: boundedVersion(["go", "version"]),
      dlvVersion: boundedVersion(["dlv", "version"]),
    })),
  )

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
    // T-03 goroutine dump: the Go runtime always has >1 goroutine (scheduler/GC
    // alongside the test), so dlv reports them as DAP threads → captured.
    expect(pkt.runtime?.threads?.length ?? 0).toBeGreaterThan(1)
  }, 120_000)
})
