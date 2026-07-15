/**
 * Hellgate for G1 cross-vendor diversity (`model-lane-diversity` knob).
 *
 * The verify-and-select candidate generator + judge ran on ONE LLM port, so the
 * N candidates were correlated samples of a single vendor (diversity ≈ 0). This
 * knob routes candidate `i` to vendor lane `i mod V` over `deps.llmLanes` and the
 * judge to lane 1, decorrelating generation + judging across vendors.
 *
 * Four layers, each with red-on-injection teeth:
 *
 *   1. POSTURE PROJECTION (drives the same path the driver reads):
 *        QUANTA_BENCH_MODEL_LANE_DIVERSITY → resolveBenchKnobs → benchPostureFromState
 *        → posture.modelLaneDiversity.
 *      RED-on-injection: a flipped default reds the unset case; a dropped barrel
 *      import / posture read reds the "=1" case.
 *
 *   2. LANE RESOLUTION (`resolveLaneLlm`, pure round-robin):
 *      OFF ⇒ deps.llm; ON with ≥2 lanes ⇒ index 0→lane0, 1→lane1, 2→lane0
 *      (wraps), each a DISTINCT provider; ON with <2 lanes ⇒ deps.llm.
 *      RED-on-injection: if the function ignored modelLaneDiversity OR returned a
 *      constant, the OFF/ON or per-index distinctness assertions fail.
 *
 *   3. WIRE-SITE REACH (`buildConfig`): the per-candidate lane port the driver
 *      resolved OVERRIDES `deps.llm` as the AgentConfig generator. This is the
 *      proof the laneIndex actually reaches a DIFFERENT provider call, not a tag.
 *      RED-on-injection: if buildConfig hard-coded `deps.llm` (the pre-G1 line),
 *      `config.llm === laneB` fails while `=== deps.llm` would have passed.
 *
 *   4. ROUND-TRIP: lane resolved from posture-ON index 1 is a different provider
 *      than index 0, and each reaches buildConfig as `config.llm`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import "@/runner/knobs/knobs"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import {
  benchPostureFromState,
  buildConfig,
  resolveBenchKnobs,
  resolveLaneLlm,
} from "@/runner/batch/eval/driver"
import { __resetKnobOverrides } from "@/shared/knob-overrides"
import type { StreamPort } from "@/stream"
import type { Instance } from "../../src/apps/bench/types"

class LaneLLM implements LLMPort {
  /** Last StreamInput this port received — proves an outer decorator delegates
   *  down to THIS instance (the recording-lane label reaches the inner port). */
  lastInput: StreamInput | undefined
  constructor(readonly provider: string) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.lastInput = input
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

/** Drive one turn through a port and return the input its BACKING port observed.
 *  For a bare port that's its own input; for a `laneLabeledPort` wrap it's the
 *  input the INNER port saw (with the injected recording lane) — proving the
 *  wrap is a transparent delegator, not an independent port. */
const driveAndCaptureInner = async (port: LLMPort, inner: LaneLLM): Promise<StreamInput> => {
  inner.lastInput = undefined
  const req: StreamInput = { messages: [], tools: [] }
  for await (const _ of port.stream(req)) {
    /* drain */
  }
  if (inner.lastInput === undefined) throw new Error("port did not delegate to the inner LLM")
  return inner.lastInput
}

const stubStream: StreamPort = { emit() {} }
const swebenchInstance = (): Instance => ({
  id: "lane-1",
  repoPath: "/tmp/x",
  problemStatement: "inspect only",
  testCmd: "true",
  swebench: { instanceId: "x__lane-1", repo: "x/x", baseCommit: "deadbeef" },
})

const ENV_KEYS = [
  "QUANTA_BENCH_MODEL_LANE_DIVERSITY",
  "QUANTA_BENCH_PRESET",
  "QUANTA_BENCH_SOTA",
  "QUANTA_KNOBS_PRESET",
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

const modelLaneDiversity = (env: Record<string, string>): boolean => {
  const e = env as unknown as NodeJS.ProcessEnv
  return benchPostureFromState(resolveBenchKnobs({ envVars: e }), e).modelLaneDiversity
}

describe("G1 model-lane-diversity — posture projection (default-OFF)", () => {
  test("unset ⇒ modelLaneDiversity false (byte-identical baseline)", () => {
    expect(modelLaneDiversity({})).toBe(false)
  })

  test("QUANTA_BENCH_MODEL_LANE_DIVERSITY=1 ⇒ true (opt-in)", () => {
    expect(modelLaneDiversity({ QUANTA_BENCH_MODEL_LANE_DIVERSITY: "1" })).toBe(true)
  })

  test('strict gate: "on"/"true" enable, "0"/garbage stay OFF', () => {
    expect(modelLaneDiversity({ QUANTA_BENCH_MODEL_LANE_DIVERSITY: "on" })).toBe(true)
    expect(modelLaneDiversity({ QUANTA_BENCH_MODEL_LANE_DIVERSITY: "true" })).toBe(true)
    expect(modelLaneDiversity({ QUANTA_BENCH_MODEL_LANE_DIVERSITY: "0" })).toBe(false)
    expect(modelLaneDiversity({ QUANTA_BENCH_MODEL_LANE_DIVERSITY: "yes" })).toBe(false)
  })
})

describe("G1 resolveLaneLlm — vendor round-robin routing", () => {
  const llm = new LaneLLM("base")
  const lanes = [new LaneLLM("anthropic"), new LaneLLM("openai")] as const
  const deps = { llm, llmLanes: lanes }

  test("OFF ⇒ every index resolves to deps.llm (no provider swap)", () => {
    expect(resolveLaneLlm(deps, false, 0)).toBe(llm)
    expect(resolveLaneLlm(deps, false, 1)).toBe(llm)
    expect(resolveLaneLlm(deps, false, 2)).toBe(llm)
  })

  test("ON ⇒ index mod V round-robin over DISTINCT providers", () => {
    expect(resolveLaneLlm(deps, true, 0)).toBe(lanes[0])
    expect(resolveLaneLlm(deps, true, 1)).toBe(lanes[1])
    expect(resolveLaneLlm(deps, true, 2)).toBe(lanes[0]) // wraps
    // The whole point: cand0 and cand1 are DIFFERENT vendors (decorrelated).
    expect(resolveLaneLlm(deps, true, 0)).not.toBe(resolveLaneLlm(deps, true, 1))
  })

  test("ON but <2 lanes (or absent) ⇒ deps.llm (cannot decorrelate)", () => {
    expect(resolveLaneLlm({ llm, llmLanes: [lanes[0]] }, true, 1)).toBe(llm)
    expect(resolveLaneLlm({ llm }, true, 1)).toBe(llm)
  })
})

describe("G1 buildConfig — lane port reaches the AgentConfig generator", () => {
  test("WIRING-PROOF: a resolved lane port OVERRIDES deps.llm at config.llm", () => {
    const llm = new LaneLLM("base")
    const laneB = new LaneLLM("openai")
    const deps = { llm, maxTurns: 1, timeoutMs: 5_000 }
    // index 1 under ON+2-lanes resolves to laneB; assert it reaches config.llm.
    const cfg = buildConfig(
      swebenchInstance(),
      deps,
      "/tmp/sb",
      new AbortController().signal,
      stubStream,
      undefined, // seedMsg
      undefined, // precomputedHint
      undefined, // reproHint
      undefined, // closureHint
      undefined, // postureOverride
      undefined, // stateOverride
      undefined, // chaMultisiteSteer
      laneB, // laneLlm
    )
    expect(cfg.llm).toBe(laneB)
    expect(cfg.llm).not.toBe(llm)
  })

  test("CONTROL: no laneLlm ⇒ config.llm is deps.llm labeled with the 'repair' recording lane (behaviorally equivalent, NOT a provider swap)", async () => {
    // SHIPPED (config-build.ts:563, commits 4b5354c1b/be34011ba): on the no-lane
    // OFF path buildConfig wraps deps.llm in `laneLabeledPort(deps.llm, "repair")`
    // so the main agent's turns group under one authoritative trajectory band.
    // That wrap is a transparent SOLID decorator (replay-neutral, never hashed):
    // a NEW object, so `=== deps.llm` no longer holds, but it is BEHAVIORALLY
    // equivalent. This CONTROL pins that equivalence WITHOUT asserting a provider
    // swap — the OFF path must never reach a different vendor than deps.llm.
    const llm = new LaneLLM("base")
    const deps = { llm, maxTurns: 1, timeoutMs: 5_000 }
    const cfg = buildConfig(
      swebenchInstance(),
      deps,
      "/tmp/sb",
      new AbortController().signal,
      stubStream,
    )
    // Same descriptive surface — NOT the ON-path laneB/openai provider.
    expect(cfg.llm.provider).toBe(llm.provider)
    // Delegates to the SAME backing port (a bare tag, not an independent LLM):
    // driving cfg.llm reaches `llm` itself, carrying the "repair" recording lane.
    const seen = await driveAndCaptureInner(cfg.llm, llm)
    expect(seen.recordingLane).toBe("repair")
  })

  test("ROUND-TRIP: resolveLaneLlm(ON, idx) → buildConfig → distinct config.llm per lane", () => {
    const llm = new LaneLLM("base")
    const lanes = [new LaneLLM("anthropic"), new LaneLLM("openai")] as const
    const deps = { llm, llmLanes: lanes, maxTurns: 1, timeoutMs: 5_000 }
    const lane0 = resolveLaneLlm(deps, true, 0)
    const lane1 = resolveLaneLlm(deps, true, 1)
    const mk = (lane: LLMPort): LLMPort =>
      buildConfig(
        swebenchInstance(),
        deps,
        "/tmp/sb",
        new AbortController().signal,
        stubStream,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        lane,
      ).llm
    expect(mk(lane0)).toBe(lanes[0])
    expect(mk(lane1)).toBe(lanes[1])
    expect(mk(lane0)).not.toBe(mk(lane1))
  })
})
