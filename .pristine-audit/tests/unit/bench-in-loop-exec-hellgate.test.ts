/**
 * Hellgate: the `bench-in-loop-exec` knob actually FLIPS the agent posture, and
 * default (unset) is byte-identical to today.
 *
 * Imports from the PRODUCTION apps driver (`src/apps/bench/eval/driver`) — the
 * runner driver is a dead twin (memory: apps=prod/runner=dead), so a test that
 * built the runner config would prove nothing. `buildConfig`/`benchOptIns` are
 * re-exported by the apps driver from the runner module; the LIVE path reaches
 * `SWEBENCH_DIRECTIVE` / `verifyGuard` via the apps driver calling `buildConfig`.
 *
 * Red-on-injection:
 *  - revert the directive branch to always-SWEBENCH_DIRECTIVE ⇒ IN-LOOP-3 (OFF
 *    posture must NOT contain the MANDATORY-run-tests clause) goes RED.
 *  - revert the verifyGuard gate to drop the `"full"`-mode check ⇒ IN-LOOP-4
 *    goes RED.
 *  - flip the BenchPosture default (`inLoopExecMode` from "full"→"off") ⇒ IN-LOOP-1
 *    (default ON byte-identical) goes RED.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { __resetKnobOverrides } from "@/shared/knob-overrides"
import type { StreamPort } from "@/stream"
import {
  benchInstallsReproHint,
  benchOptIns,
  benchRunsRepairPhase,
  buildConfig,
} from "../../src/apps/bench/eval/driver"
import type { Instance } from "../../src/apps/bench/types"

const ENV_KEYS = [
  "QUANTA_BENCH_PRESET",
  "QUANTA_BENCH_SOTA",
  "QUANTA_KNOBS_PRESET",
  "QUANTA_BENCH_IN_LOOP_EXEC",
  "QUANTA_BENCH_REPRO_TEST",
  "QUANTA_BENCH_MUST_PASS",
  "QUANTA_READ_OUTLINE",
  "QUANTA_TEST_RUNNER",
  "QUANTA_REPO_MAP",
] as const

let saved: Map<string, string | undefined>
beforeEach(() => {
  saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  __resetKnobOverrides()
})
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  __resetKnobOverrides()
})

class StubLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}
const stubStream: StreamPort = { emit() {} }
const swebenchInstance = (testCmd = "true"): Instance => ({
  id: "p-1",
  repoPath: "/tmp/x",
  problemStatement: "fix it",
  testCmd,
  swebench: { instanceId: "x__1", repo: "x/x", baseCommit: "deadbeef" },
})
const baseDeps = { llm: new StubLLM(), maxTurns: 1, timeoutMs: 5_000 }
const buildOnce = (testCmd?: string): ReturnType<typeof buildConfig> => {
  const ac = new AbortController()
  return buildConfig(swebenchInstance(testCmd), baseDeps, "/tmp/sb", ac.signal, stubStream)
}
const userText = (cfg: ReturnType<typeof buildConfig>): string => {
  const block = cfg.messages[0]?.content[0]
  return block && block.type === "text" ? block.text : ""
}
// Single-line substring (the directive wraps "run the repository's\n existing
// test(s)" across lines, so match the unambiguous MANDATORY clause head).
const MANDATE = "MANDATORY before you stop"
const VERIFY_MODE_STEER = 'set mode:"write"'

describe("bench-in-loop-exec posture flip", () => {
  // IN-LOOP-1: DEFAULT (no knob, no preset) = ON, byte-identical to today.
  test("IN-LOOP-1: default ⇒ inLoopExec true, MANDATE present, verifyGuard present", () => {
    expect(benchOptIns().inLoopExec).toBe(true)
    expect(benchOptIns().inLoopExecMode).toBe("full")
    const cfg = buildOnce()
    expect(userText(cfg)).toContain("MANDATORY")
    expect(userText(cfg)).toContain(MANDATE)
    expect(userText(cfg)).toContain(VERIFY_MODE_STEER)
    // `true` is an intentional no-op test command, never an agent-visible
    // verifier. The outcome gate remains armed, but it must not pretend that
    // this fixture supplies an authority command.
    expect(cfg.verifyGuard).toEqual({ mustPass: true, maxTrips: 2 })
    expect(cfg.protectTestPaths).toBe(true)
  })

  // SSOT (jun-28): the must-pass OVERRIDE flows buildConfig → reconcileBenchGuards
  // → verifyGuard (must-pass apply is bench-NOOP now). This pins the exact path
  // the gpt-5.4 11141 e2e PASS relied on, after the single-authority refactor.
  test("MUST-PASS-STICKY: QUANTA_BENCH_MUST_PASS=sticky ⇒ verifyGuard.stickyRed", () => {
    process.env.QUANTA_BENCH_MUST_PASS = "sticky"
    const cfg = buildOnce()
    expect(cfg.verifyGuard).toEqual({
      mustPass: true,
      maxTrips: 2,
      stickyRed: true,
    })
  })

  test("MUST-PASS-OFF: override=off ⇒ verifyGuard {mustPass:false}", () => {
    process.env.QUANTA_BENCH_MUST_PASS = "off"
    const cfg = buildOnce()
    expect(cfg.verifyGuard).toEqual({ mustPass: false })
  })

  test("MUST-PASS: a public verifier remains the exact authority for default, sticky, and off", () => {
    const publicVerifier = "pytest tests/public.py"
    const cases: ReadonlyArray<readonly [string | undefined, object]> = [
      [undefined, { mustPass: true, maxTrips: 2, exactCommands: [publicVerifier] }],
      ["sticky", { mustPass: true, maxTrips: 2, stickyRed: true, exactCommands: [publicVerifier] }],
      ["off", { mustPass: false, exactCommands: [publicVerifier] }],
    ]
    for (const [override, expected] of cases) {
      if (override === undefined) delete process.env.QUANTA_BENCH_MUST_PASS
      else process.env.QUANTA_BENCH_MUST_PASS = override
      expect(buildOnce(publicVerifier).verifyGuard).toEqual(expected)
    }
  })

  // IN-LOOP-2: explicit OFF via env flips the posture.
  test("IN-LOOP-2: QUANTA_BENCH_IN_LOOP_EXEC=off ⇒ inLoopExec false", () => {
    process.env.QUANTA_BENCH_IN_LOOP_EXEC = "off"
    expect(benchOptIns().inLoopExec).toBe(false)
    expect(benchOptIns().inLoopExecMode).toBe("off")
  })

  // IN-LOOP-3: OFF posture removes the run-the-tests MANDATE (the real driver of
  // the abort), and emits the edit-and-submit directive instead.
  test("IN-LOOP-3: OFF ⇒ no MANDATE clause, NOEXEC directive present", () => {
    process.env.QUANTA_BENCH_IN_LOOP_EXEC = "0"
    const cfg = buildOnce()
    const txt = userText(cfg)
    expect(txt).not.toContain(MANDATE)
    expect(txt).not.toContain("MANDATORY")
    expect(txt).toContain("Do NOT run the test suite")
    // still keeps the source-discipline rules:
    expect(txt).toContain("Change library/source code ONLY")
  })

  // IN-LOOP-4: OFF drops verifyGuard.
  test("IN-LOOP-4: OFF ⇒ no verifyGuard", () => {
    process.env.QUANTA_BENCH_IN_LOOP_EXEC = "false"
    const cfg = buildOnce()
    expect(cfg.verifyGuard).toBeUndefined()
    expect(cfg.protectTestPaths).toBe(true)
  })

  // IN-LOOP-5: the agentless-v3-thin-strict preset resolves the knob OFF AND drops
  // the host-python repro-test (reproTestK undefined), without touching localization.
  // (Repointed from the retired agentless-v2-safe — same OFF/no-repro/lsp-kept shape.)
  test("IN-LOOP-5: preset agentless-v3-thin-strict ⇒ OFF posture + no repro, lsp kept", () => {
    process.env.QUANTA_BENCH_PRESET = "agentless-v3-thin-strict"
    const opt = benchOptIns()
    expect(opt.inLoopExec).toBe(false)
    expect(opt.inLoopExecMode).toBe("off")
    expect(opt.reproTestK).toBeUndefined()
    expect(opt.lspNav).toBe(true) // localization stack preserved
    const cfg = buildOnce()
    expect(userText(cfg)).not.toContain(MANDATE)
    expect(cfg.verifyGuard).toBeUndefined()
    expect(cfg.protectTestPaths).toBe(true)
  })

  test("IN-LOOP-6: REPRO-ONLY ⇒ focused reproducer allowed, no full-suite mandate, no verifyGuard", () => {
    process.env.QUANTA_BENCH_IN_LOOP_EXEC = "repro-only"
    const opt = benchOptIns()
    expect(opt.inLoopExecMode).toBe("repro-only")
    expect(opt.inLoopExec).toBe(false)
    const cfg = buildOnce()
    const txt = userText(cfg)
    expect(txt).not.toContain(MANDATE)
    expect(txt).toContain("you MAY run a tiny issue reproducer")
    expect(txt).toContain(VERIFY_MODE_STEER)
    expect(txt).toContain("Do NOT run the repository test suite")
    expect(cfg.verifyGuard).toBeUndefined()
    expect(cfg.protectTestPaths).toBe(true)
  })

  // IN-LOOP-7/8: the apps-side phase/repro decisions flip on execution mode.
  // These pin the two `runInstanceOnce` posture branches (the buildConfig tests
  // can't reach them). Red-on-injection: collapse the mode checks back to a
  // boolean or make repro/repair share one branch again, and these go RED.
  test("IN-LOOP-7: repro-hint install gated on execution mode", () => {
    expect(benchInstallsReproHint("full")).toBe(true)
    expect(benchInstallsReproHint("repro-only")).toBe(true)
    expect(benchInstallsReproHint("off")).toBe(false)
  })
  test("IN-LOOP-8: repair phase remains FULL-only", () => {
    expect(benchRunsRepairPhase(true, true, "full")).toBe(true)
    expect(benchRunsRepairPhase(true, true, "repro-only")).toBe(false)
    expect(benchRunsRepairPhase(true, true, "off")).toBe(false)
    expect(benchRunsRepairPhase(false, true, "full")).toBe(false)
    expect(benchRunsRepairPhase(true, false, "full")).toBe(false)
  })
})
