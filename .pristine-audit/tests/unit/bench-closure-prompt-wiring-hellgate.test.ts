import { describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import {
  type BenchKnobState,
  type BenchPosture,
  benchPostureFromState,
  resolveBenchKnobs,
} from "@/runner/batch/eval/driver"
import type { StreamPort } from "@/stream"
import { buildConfig } from "../../src/apps/bench/eval/driver"
import type { Instance } from "../../src/apps/bench/types"

class StubLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const stubStream: StreamPort = { emit() {} }

const mkInstance = (problemStatement = "Fix the bug in src/foo.py."): Instance => ({
  id: "x__1",
  repoPath: "/tmp/x",
  problemStatement,
  testCmd: "true",
  swebench: { instanceId: "x__1", repo: "x/x", baseCommit: "deadbeef" },
})

const userText = (
  closureHint: string | undefined,
  reproHint: string | undefined = undefined,
): string => {
  const ac = new AbortController()
  const cfg = buildConfig(
    mkInstance(),
    { llm: new StubLLM(), maxTurns: 1, timeoutMs: 5_000 },
    "/tmp/sb",
    ac.signal,
    stubStream,
    undefined,
    undefined,
    reproHint,
    closureHint,
  )
  const block = cfg.messages[0]?.content[0]
  return block && block.type === "text" ? block.text : ""
}

// Build a CLEAN default bench state + posture from the knob framework using an
// EMPTY env snapshot (NOT process.env). This severs the localize-phase value from
// the process-GLOBAL `QUANTA_BENCH_LOCALIZE_PHASE` knob: instead of mutating the
// shared env and racing sibling tests under the parallel suite, we thread the
// localize-phase config in as an explicit `postureOverride`/`stateOverride` param
// pair — the SAME seam the prod v5-adaptive driver uses (config-build.ts:678-680,
// "postureOverride/stateOverride must match"). buildConfig reads env only at its
// boundary (`resolveBenchKnobs({ envVars: process.env })`); when both overrides are
// supplied that boundary read is bypassed for the posture entirely, so this test
// needs no global mutation and is hermetic under parallel workers.
const cleanState = (): BenchKnobState => resolveBenchKnobs({ envVars: {} })
const posture = (): BenchPosture => benchPostureFromState(cleanState(), {})
const postureWithLocalizePhase = (phase1Turns: number): BenchPosture => ({
  ...posture(),
  localizePhase: { phase1Turns },
})

describe("closure prompt wiring", () => {
  test("closureHint non-empty ⇒ injected before the base task", () => {
    const text = userText("First edit candidate: src/foo.py")
    expect(text).toContain("First edit candidate: src/foo.py")
    expect(text.indexOf("First edit candidate: src/foo.py")).toBeLessThan(
      text.indexOf(mkInstance().problemStatement),
    )
  })

  test("closureHint empty/undefined ⇒ byte-identical to legacy path", () => {
    expect(userText(undefined)).toBe(userText(""))
  })

  test("closureHint + reproHint ⇒ closure hint stays above repro, both above base", () => {
    const text = userText("First edit candidate: src/foo.py", "REPRO_DIRECTIVE")
    const iClosure = text.indexOf("First edit candidate: src/foo.py")
    const iRepro = text.indexOf("REPRO_DIRECTIVE")
    const iBase = text.indexOf("Work inside /tmp/sb")
    expect(iClosure).toBeGreaterThanOrEqual(0)
    expect(iRepro).toBeGreaterThan(iClosure)
    expect(iBase).toBeGreaterThan(iRepro)
  })

  test("chaMultisiteSteer is injected into both the prompt prelude and localize-phase config", () => {
    const steer = [
      "MULTI-SITE FIX: `m` is overridden by sibling classes that share a base.",
      "  - pkg/oracle.py:9  (Oracle.m)",
    ].join("\n")
    const ac = new AbortController()
    // localize-phase threaded as an EXPLICIT posture param (phase1Turns: 3) —
    // no process.env mutation. postureOverride (arg 10) + matching stateOverride
    // (arg 11) mirror the prod v5-adaptive call shape; chaMultisiteSteer (arg 12)
    // is the dynamic multi-site steer that must land in BOTH the prompt prelude
    // and cfg.localizePhase.
    const cfg = buildConfig(
      mkInstance(),
      { llm: new StubLLM(), maxTurns: 1, timeoutMs: 5_000 },
      "/tmp/sb",
      ac.signal,
      stubStream,
      undefined,
      undefined,
      undefined,
      undefined,
      postureWithLocalizePhase(3), // postureOverride — carries localizePhase.phase1Turns=3
      cleanState(), // stateOverride — matches the posture (v5-adaptive contract)
      steer, // chaMultisiteSteer (arg 12)
    )
    const block = cfg.messages[0]?.content[0]
    const text = block && block.type === "text" ? block.text : ""
    // SAME assertions as before: the steer is injected into the prompt prelude
    // ABOVE the base task, AND folded into the localize-phase config alongside
    // the threaded phase1Turns.
    expect(text).toContain(steer)
    expect(text.indexOf(steer)).toBeLessThan(text.indexOf("Work inside /tmp/sb"))
    expect(cfg.localizePhase).toEqual({ phase1Turns: 3, chaMultisiteSteer: steer })
  })
})
