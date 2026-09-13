/**
 * T-02 — REAL Node runner-routing e2e (mocha). Proves the JS runner routing
 * (detectJsRunner → nodeInspectArgv) drives a REAL mocha run under
 * `node --inspect-brk node_modules/.bin/mocha <file>` (single process, in-proc),
 * CDP stops at the failing assertion, and the local explaining the failure
 * (`result = 10` vs expected 99) is captured — same Evidence shape as node:test.
 *
 * CAPABILITY GROUP `js-test-runner` (tools/dev/test-capability-manifest.ts).
 *
 * Same three defects as the jest sibling, same fix: the install was UNPINNED
 * (`npm i mocha`), had NO timeout, and ran at MODULE SCOPE where
 * `unit-speed-budget` cannot see it. It is now a pinned version from the
 * manifest, installed (or copied from a pre-built fixture root) inside a bounded
 * `beforeAll`, with the version in the capability receipt — this file and the
 * jest one assert OPPOSITE runtime contracts, so "which version" is load-bearing.
 */
import { beforeAll, expect, test } from "bun:test"
import { defaultRuntimePort } from "@/tool/evidence"
import { buildEvidence } from "@/tool/evidence/builder"
import { runToolchain, type Toolchain } from "@/tool/testrun"
import { FIXTURE_INSTALL_TIMEOUT_MS } from "../../../../tools/dev/test-capability-manifest"
import {
  capabilityGate,
  hasBinary,
  laneDescribe,
  reportCapability,
} from "../../../_helpers/capability-lane"
import { type JsRunnerFixture, prepareJsRunnerFixture } from "../../../_helpers/js-runner-fixture"

const GROUP = "js-test-runner"
const FILE = "tests/unit/tool/evidence/runtime-mocha-real-e2e.test.ts"

const SUM_TEST_JS = [
  'const assert = require("assert")',
  "function compute(n) { let t = 0; for (let i = 0; i < n; i++) t += i; return t }",
  'describe("math suite", function () {',
  '  it("adds correctly", function () {',
  "    const result = compute(5)",
  "    assert.strictEqual(result, 99) // line 6 — fails, result=10",
  "  })",
  "})",
  "",
].join("\n")

const GATE = capabilityGate({
  group: GROUP,
  file: FILE,
  needs: { node: hasBinary("node"), npm: hasBinary("npm") },
})

let fixture: JsRunnerFixture | undefined

const D = laneDescribe(GATE)

D("defaultRuntimePort — REAL mocha runner routing (T-02)", () => {
  beforeAll(() => {
    fixture = prepareJsRunnerFixture({
      runner: "mocha",
      group: GROUP,
      file: FILE,
      testFileName: "sum.test.js",
      testFileBody: SUM_TEST_JS,
    })
    // The HOOK deadline must be strictly looser than the install's own, so the
    // install reports `failed-setup` with a message instead of bun killing the
    // hook at its 5s default and the real cause never being printed. Measured:
    // without this the npm child took SIGTERM at 6.4s and the only diagnostic
    // was "a beforeEach/afterEach hook timed out".
  }, FIXTURE_INSTALL_TIMEOUT_MS + 60_000)

  test("detects mocha + captures the failing test's local over CDP", async () => {
    const built = fixture
    if (built === undefined) throw new Error("mocha fixture missing; beforeAll did not run")
    const root = built.dir
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
    reportCapability({
      group: GROUP,
      file: FILE,
      outcome: "executed",
      detail: `real mocha run completed from a ${built.source} fixture`,
      receipt: built.receipt,
    })
  }, 120_000)
})
