/**
 * T-02 — REAL jest e2e documenting the HONEST jest behaviour (an adversarial-
 * audit correction). jest `--runInBand` IS single-process, but jest TRANSFORMS
 * the source (babel-jest, run via vm), so a CDP file:line breakpoint on the
 * original file URL does NOT bind to the executing module — runtime capture
 * fails. So: failure + STATIC localize fine (the `●` parser gives file:line →
 * tsserver), but RUNTIME degrades to null GRACEFULLY (no crash). This test pins
 * that contract so a future "jest runtime works" claim can't sneak back in
 * unverified. (mocha is the verified runner-runtime path — see runtime-mocha.)
 *
 * Installs jest into a temp project (gated on npm). AUTO-SKIPS without npm.
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

const installJestProject = (): string | null => {
  let dir: string
  try {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "rtjest-")))
  } catch {
    return null
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", version: "0.0.0" }))
  writeFileSync(
    join(dir, "sum.test.js"),
    [
      "function compute(n) { let t = 0; for (let i = 0; i < n; i++) t += i; return t }",
      'test("fails", () => {',
      "  const result = compute(5)",
      "  expect(result).toBe(99) // line 4 — fails, result=10",
      "})",
      "",
    ].join("\n"),
  )
  const r = Bun.spawnSync(["npm", "i", "--silent", "--no-audit", "--no-fund", "jest"], {
    cwd: dir,
    stdout: "ignore",
    stderr: "ignore",
  })
  return r.exitCode === 0 ? dir : null
}

const dir = has("npm", "--version") ? installJestProject() : null
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
const D = REAL_E2E && dir !== null ? describe : describe.skip

D("defaultRuntimePort — REAL jest (T-02: failure+static localize, runtime degrades)", () => {
  test("jest failure localizes via the ● parser; runtime degrades to null (transform)", async () => {
    const root = dir as string
    const tc: Toolchain = {
      kind: "node",
      command: ["node_modules/.bin/jest", "--runInBand", "sum.test.js"],
      parser: "node",
    }
    const pkt = await buildEvidence(root, {
      detect: async () => tc,
      runTests: (t, c) => runToolchain(t, c),
      runtime: defaultRuntimePort,
      changedFiles: async () => ["sum.test.js"],
    })
    expect(pkt.language).toBe("node")
    // FAILURE localizes from jest's `● fails` + V8 frame → file:line (→ static).
    expect(pkt.failure?.file).toMatch(/sum\.test\.js$/)
    expect(pkt.failure?.line).toBe(4)
    // RUNTIME degrades GRACEFULLY to null — jest transforms the source so a CDP
    // file:line bp can't bind. The honest contract (NOT a crash, NOT a false
    // capture). mocha is the verified runner-runtime path.
    expect(pkt.runtime).toBeNull()
  }, 180_000)
})
