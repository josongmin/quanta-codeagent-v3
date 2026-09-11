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
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultRuntimePort } from "@/tool/evidence"
import { buildEvidence } from "@/tool/evidence/builder"
import { runToolchain, type Toolchain } from "@/tool/testrun"
import {
  assertCapabilityNotBlocked,
  boundedVersion,
  capabilityGate,
  hasBinary,
  laneDescribe,
  reportExecuted,
} from "../../../_helpers/capability-lane"

const GROUP = "node-runtime-cdp"
const FILE = "tests/unit/tool/evidence/runtime-node-real-e2e.test.ts"

// CAPABILITY GROUP `node-runtime-cdp` — the only NON-DAP runtime carrier, which
// is why it is its own group rather than an arm of the debugger group. Toolchain
// presence alone used to be the gate, so on a dev machine with node these ran
// inside the ordinary unit suite (measured 3,455ms idle, 9,387ms at load 68 —
// past the 8,529ms per-test budget, a ceiling that may only go DOWN).
const GATE = capabilityGate({ group: GROUP, file: FILE, needs: { node: hasBinary("node") } })
const D = laneDescribe(GROUP, GATE)

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
  beforeAll(() => assertCapabilityNotBlocked({ group: GROUP, file: FILE }, GATE))
  afterAll(() =>
    reportExecuted(GATE, GROUP, FILE, "real node --inspect-brk CDP capture", () => ({
      nodeVersion: boundedVersion(["node", "--version"]),
    })),
  )

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
