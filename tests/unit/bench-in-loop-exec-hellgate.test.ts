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
 *  - revert the `:896` branch to always-SWEBENCH_DIRECTIVE ⇒ IN-LOOP-3 (OFF
 *    posture must NOT contain the MANDATORY-run-tests clause) goes RED.
 *  - revert the `:955` verifyGuard gate to drop `&& opt.inLoopExec` ⇒ IN-LOOP-4
 *    goes RED.
 *  - flip the BenchPosture default (`inLoopExec` from true→false) ⇒ IN-LOOP-1
 *    (default ON byte-identical) goes RED.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { StreamPort } from "@/stream"
import { __resetKnobOverrides } from "@/shared/knob-overrides"
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
const swebenchInstance = (): Instance => ({
  id: "p-1",
  repoPath: "/tmp/x",
  problemStatement: "fix it",
  testCmd: "true",
  swebench: { instanceId: "x__1", repo: "x/x", baseCommit: "deadbeef" },
})
const baseDeps = { llm: new StubLLM(), maxTurns: 1, timeoutMs: 5_000 }
const buildOnce = (): ReturnType<typeof buildConfig> => {
  const ac = new AbortController()
  return buildConfig(swebenchInstance(), baseDeps, "/tmp/sb", ac.signal, stubStream)
}
const userText = (cfg: ReturnType<typeof buildConfig>): string => {
  const block = cfg.messages[0]?.content[0]
  return block && block.type === "text" ? block.text : ""
}
// Single-line substring (the directive wraps "run the repository's\n existing
// test(s)" across lines, so match the unambiguous MANDATORY clause head).
const MANDATE = "MANDATORY before you stop"

describe("bench-in-loop-exec posture flip", () => {
  // IN-LOOP-1: DEFAULT (no knob, no preset) = ON, byte-identical to today.
  test("IN-LOOP-1: default ⇒ inLoopExec true, MANDATE present, verifyGuard present", () => {
    expect(benchOptIns().inLoopExec).toBe(true)
    const cfg = buildOnce()
    expect(userText(cfg)).toContain("MANDATORY")
    expect(userText(cfg)).toContain(MANDATE)
    expect(cfg.verifyGuard).toEqual({ mustPass: true, maxTrips: 2 })
  })

  // IN-LOOP-2: explicit OFF via env flips the posture.
  test("IN-LOOP-2: QUANTA_BENCH_IN_LOOP_EXEC=off ⇒ inLoopExec false", () => {
    process.env.QUANTA_BENCH_IN_LOOP_EXEC = "off"
    expect(benchOptIns().inLoopExec).toBe(false)
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
    expect(buildOnce().verifyGuard).toBeUndefined()
  })

  // IN-LOOP-5: the agentless-v2-safe preset resolves the knob OFF AND drops the
  // host-python repro-test (reproTestK undefined), without touching localization.
  test("IN-LOOP-5: preset agentless-v2-safe ⇒ OFF posture + no repro, lsp kept", () => {
    process.env.QUANTA_BENCH_PRESET = "agentless-v2-safe"
    const opt = benchOptIns()
    expect(opt.inLoopExec).toBe(false)
    expect(opt.reproTestK).toBeUndefined()
    expect(opt.lspNav).toBe(true) // localization stack preserved
    const cfg = buildOnce()
    expect(userText(cfg)).not.toContain(MANDATE)
    expect(cfg.verifyGuard).toBeUndefined()
  })

  // IN-LOOP-6: the apps-side phase/repro decisions flip on inLoopExec. These pin
  // the two `runInstanceOnce` posture branches (the buildConfig tests can't reach
  // them). Red-on-injection: drop the `inLoopExec` term from either predicate and
  // these go RED.
  test("IN-LOOP-6: repro-hint install gated on inLoopExec", () => {
    expect(benchInstallsReproHint(true)).toBe(true) // ON ⇒ install (byte-identical)
    expect(benchInstallsReproHint(false)).toBe(false) // OFF ⇒ skip
  })
  test("IN-LOOP-7: repair phase requires inLoopExec (OFF ⇒ single-pass)", () => {
    expect(benchRunsRepairPhase(true, true, true)).toBe(true) // repair+swebench+ON
    expect(benchRunsRepairPhase(true, true, false)).toBe(false) // OFF ⇒ forced single-pass
    expect(benchRunsRepairPhase(false, true, true)).toBe(false) // no repair config
    expect(benchRunsRepairPhase(true, false, true)).toBe(false) // non-swebench
  })
})
