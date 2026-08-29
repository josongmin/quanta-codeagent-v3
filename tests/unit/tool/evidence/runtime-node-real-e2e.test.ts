/**
 * Keystone runtime — REAL Node e2e (CDP over `node --inspect-brk`). The FOURTH
 * runtime language and the first NON-DAP carrier: node speaks the Chrome
 * DevTools Protocol, not DAP. A real node:test file is run inline under
 * --inspect-brk; CDP stops at the failing assertion line and captures the local
 * that explains the failure (`result = 10` vs expected 99), fused into the
 * Evidence Packet's `runtime` section — same shape as the DAP languages.
 *
 * AUTO-SKIPS without node. Verified 2026-06-10.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gateOn } from "@/shared"
import { defaultRuntimePort } from "@/tool/evidence"
import { buildEvidence } from "@/tool/evidence/builder"
import { runToolchain, type Toolchain } from "@/tool/testrun"

const has = (b: string, ...a: string[]): boolean => {
  try {
    return Bun.spawnSync([b, ...a], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
  } catch {
    return false
  }
}
const REAL_E2E = gateOn(process.env, "QUANTA_REAL_TOOLCHAIN_E2E")

// REAL-ON-DEMAND LANE. Toolchain presence alone was the gate, so on a developer
// machine that HAS the toolchain these ran inside the ordinary unit suite and
// their cost tracks whatever else the box is doing (measured: 3,455ms idle,
// 9,387ms at load average 68 — past the 8,529ms per-test speed budget, a ceiling
// that may only go DOWN). Same suffix, same lane as their `-real-e2e` siblings:
// a VISIBLE skip by default, run by `bun run test:real-toolchain`. CI still runs
// this lane — `.github/workflows/ci.yml` has an explicit
// `QUANTA_REAL_TOOLCHAIN_E2E=1 bun run test:real-toolchain` step, added after an
// audit measured that ubuntu-latest DOES ship node, go, cargo, python3 and npm
// (only clangd, lldb-dap, dlv and debugpy are absent), so gating without that
// step silently dropped 8 cases from the blocking merge gate.
const D = REAL_E2E && has("node", "--version") ? describe : describe.skip

// A node:test file that self-runs inline (one process). `result` is 10 (0+1+2+3+4),
// the assertion expects 99 → fails. The CDP breakpoint lands on the assert line.
const TEST_MJS = [
  'import { test } from "node:test"',
  'import assert from "node:assert"',
  "function compute(n) {",
  "  let total = 0",
  "  for (let i = 0; i < n; i++) total += i",
  "  return total",
  "}",
  'test("fails", () => {',
  "  const result = compute(5)",
  "  assert.strictEqual(result, 99) // line 10 — fails, result=10",
  "})",
  "",
].join("\n")

D("defaultRuntimePort — REAL Node runtime via CDP (fourth language, non-DAP carrier)", () => {
  test("buildEvidence captures the node test's locals (the value behind the failure)", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "rtnode-")))
    writeFileSync(join(dir, "m.test.mjs"), TEST_MJS)
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", version: "0.0.0" }))

    // Run the real failure via `node --test` (node:test output → parseNodeTest);
    // runtime re-runs the file under `node --inspect-brk` via CDP.
    const tc: Toolchain = {
      kind: "node",
      command: ["node", "--test", "m.test.mjs"],
      parser: "node",
    }
    const pkt = await buildEvidence(dir, {
      detect: async () => tc,
      runTests: (t, c) => runToolchain(t, c),
      runtime: defaultRuntimePort,
      changedFiles: async () => ["m.test.mjs"],
    })

    expect(pkt.language).toBe("node")
    expect(pkt.failure?.test_name).toContain("fails")
    expect(pkt.failure?.file).toMatch(/m\.test\.mjs$/)
    // RUNTIME: real CDP capture of the local at the failure line.
    expect(pkt.runtime).not.toBeNull()
    const result = pkt.runtime?.locals.find((v) => v.name === "result")
    expect(result?.value).toBe("10")
    // DAP-parity extras carried over the CDP carrier: type + per-frame structure.
    expect((result?.type ?? "").length).toBeGreaterThan(0)
    expect(pkt.runtime?.frames?.length ?? 0).toBeGreaterThan(0)
  }, 60_000)
})
