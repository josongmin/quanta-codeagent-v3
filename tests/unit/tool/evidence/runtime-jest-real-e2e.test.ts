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
 * CAPABILITY GROUP `js-test-runner` (tools/dev/test-capability-manifest.ts).
 *
 * The install used to be `npm i --silent --no-audit --no-fund jest` — UNPINNED,
 * with NO timeout, executed at MODULE SCOPE. The contract this file asserts is
 * version-specific (a jest major that stopped transforming would flip
 * `runtime === null` to a capture), so a floating install turns that into an
 * unexplainable red with no version in the output; and module-load time is
 * invisible to `tools/dev/unit-speed-budget.ts`, which reads per-CASE durations,
 * so the ~15s was real and unmeasured. Now: pinned version from the manifest, a
 * bounded install (or a pre-built fixture root) inside `beforeAll`, and the
 * version rides in the capability receipt.
 */
import { beforeAll, expect, test } from "bun:test"
import { defaultRuntimePort } from "@/tool/evidence"
import { buildEvidence } from "@/tool/evidence/builder"
import { runToolchain, type Toolchain } from "@/tool/testrun"
import { FIXTURE_INSTALL_TIMEOUT_MS } from "../../../../tools/dev/test-capability-manifest"
import {
  assertCapabilityNotBlocked,
  capabilityGate,
  hasBinary,
  laneDescribe,
  reportCapability,
} from "../../../_helpers/capability-lane"
import { type JsRunnerFixture, prepareJsRunnerFixture } from "../../../_helpers/js-runner-fixture"

const GROUP = "js-test-runner"
const FILE = "tests/unit/tool/evidence/runtime-jest-real-e2e.test.ts"

const SUM_TEST_JS = [
  "function compute(n) { let t = 0; for (let i = 0; i < n; i++) t += i; return t }",
  'test("fails", () => {',
  "  const result = compute(5)",
  "  expect(result).toBe(99) // line 4 — fails, result=10",
  "})",
  "",
].join("\n")

// PATH resolution only: no subprocess at module load, ever.
const GATE = capabilityGate({
  group: GROUP,
  file: FILE,
  needs: { node: hasBinary("node"), npm: hasBinary("npm") },
})

let fixture: JsRunnerFixture | undefined

const D = laneDescribe(GROUP, GATE)

D("defaultRuntimePort — REAL jest (T-02: failure+static localize, runtime degrades)", () => {
  beforeAll(() => {
    assertCapabilityNotBlocked({ group: GROUP, file: FILE }, GATE)
    // BOUNDED SETUP, not module load. A failed install throws `failed-setup`
    // from inside the helper — never a skip, because the capability was there.
    fixture = prepareJsRunnerFixture({
      runner: "jest",
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

  test("jest failure localizes via the ● parser; runtime degrades to null (transform)", async () => {
    const built = fixture
    if (built === undefined) throw new Error("jest fixture missing; beforeAll did not run")
    const root = built.dir
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
    reportCapability({
      group: GROUP,
      file: FILE,
      outcome: "executed",
      detail: `real jest run completed from a ${built.source} fixture`,
      receipt: built.receipt,
    })
  }, 180_000)
})
