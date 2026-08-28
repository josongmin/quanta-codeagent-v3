/**
 * T-02 — REAL Node runner-routing e2e (mocha). Proves the JS runner routing
 * (detectJsRunner → nodeInspectArgv) drives a REAL mocha run under
 * `node --inspect-brk node_modules/.bin/mocha <file>` (single process, in-proc),
 * CDP stops at the failing assertion, and the local explaining the failure
 * (`result = 10` vs expected 99) is captured — same Evidence shape as node:test.
 *
 * Installs mocha into a temp project (gated on npm). AUTO-SKIPS without npm or if
 * the install fails. Manually verified 2026-06-10 (result=10 captured via mocha).
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

/** Make a temp project with mocha installed + a failing test. Returns the dir,
 *  or null if the install couldn't complete (⇒ the suite skips). */
const installMochaProject = (): string | null => {
  let dir: string
  try {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "rtmocha-")))
  } catch {
    return null
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", version: "0.0.0" }))
  writeFileSync(
    join(dir, "sum.test.js"),
    [
      'const assert = require("assert")',
      "function compute(n) { let t = 0; for (let i = 0; i < n; i++) t += i; return t }",
      'describe("math suite", function () {',
      '  it("adds correctly", function () {',
      "    const result = compute(5)",
      "    assert.strictEqual(result, 99) // line 6 — fails, result=10",
      "  })",
      "})",
      "",
    ].join("\n"),
  )
  const r = Bun.spawnSync(["npm", "i", "--silent", "--no-audit", "--no-fund", "mocha"], {
    cwd: dir,
    stdout: "ignore",
    stderr: "ignore",
  })
  return r.exitCode === 0 ? dir : null
}

const dir = has("npm", "--version") ? installMochaProject() : null
const REAL_E2E = gateOn(process.env, "QUANTA_REAL_TOOLCHAIN_E2E")

// REAL-ON-DEMAND LANE. Toolchain presence alone was the gate, so on a developer
// machine that HAS the toolchain these ran inside the ordinary unit suite and
// their cost tracks whatever else the box is doing (measured: 3,455ms idle,
// 9,387ms at load average 68 — past the 8,529ms per-test speed budget, a ceiling
// that may only go DOWN). Same suffix, same lane as their `-real-e2e` siblings:
// a VISIBLE skip by default, run by `bun run test:real-toolchain`. CI coverage
// is unchanged — the runner has none of these toolchains, so these describes
// already skipped there.
const D = REAL_E2E && dir !== null ? describe : describe.skip

D("defaultRuntimePort — REAL mocha runner routing (T-02)", () => {
  test("detects mocha + captures the failing test's local over CDP", async () => {
    const root = dir as string
    const tc: Toolchain = {
      kind: "node",
      command: ["node_modules/.bin/mocha", "sum.test.js"],
      parser: "node",
    }
    const pkt = await buildEvidence(root, {
      detect: async () => tc,
      runTests: (t, c) => runToolchain(t, c),
      runtime: defaultRuntimePort,
      changedFiles: async () => ["sum.test.js"],
    })
    expect(pkt.language).toBe("node")
    expect(pkt.failure?.file).toMatch(/sum\.test\.js$/)
    expect(pkt.failure?.line).toBe(6)
    // RUNTIME via `node --inspect-brk node_modules/.bin/mocha` (single process).
    expect(pkt.runtime).not.toBeNull()
    expect(pkt.runtime?.locals.find((v) => v.name === "result")?.value).toBe("10")
  }, 120_000)
})
