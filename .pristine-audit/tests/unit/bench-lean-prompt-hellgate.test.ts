import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import "@/runner/knobs/knobs"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { __resetKnobOverrides } from "@/shared/knob-overrides"
import type { StreamPort } from "@/stream"
import { buildConfig } from "../../src/apps/bench/eval/driver"
import type { Instance } from "../../src/apps/bench/types"

/**
 * Hellgate: the `QUANTA_BENCH_LEAN_PROMPT` knob (Sonar absorption, P2) swaps the
 * VERBOSE swebench directive + every bolt-on steer for a SHORT, non-prescriptive
 * lean directive that folds the steers' intent in.
 *
 * WHY: Sonar measured that LESS-prescriptive prompts score HIGHER for capable
 * models (two-stage 58% → free-workflow 70% → less-prescriptive 75%). Our verbose
 * SWEBENCH_DIRECTIVE + lspSteer + specSteer + simplicitySteer + siblingSteer prose
 * may cap gpt-5.4. LEAN is a parallel A/B arm; default-OFF ⇒ byte-identical.
 *
 * Red-on-injection:
 *  - never select the lean directive ⇒ LEAN-1 (lean text present) RED.
 *  - leave the verbose directive in when lean is on ⇒ LEAN-2 (verbose absent) RED.
 *  - keep emitting the bolt-on steers when lean is on ⇒ LEAN-3 RED.
 *  - let lean ignore `bench-in-loop-exec` authority ⇒ LEAN-4/5 RED.
 *  - flip the default to ON / change OFF composition ⇒ OFF byte-identity RED.
 */

// A phrase that lives ONLY in the verbose SWEBENCH_DIRECTIVE.
const VERBOSE_MARK = "the #1 cause of failure"
// The always-present simplicity steer (default-ON) bolt-on.
const SIMPLICITY_MARK = "SIMPLEST mechanism that already exists"
// A phrase the lean directive must carry.
const LEAN_MARK = "unified diff is the submission"
const VERIFY_MODE_STEER = 'set mode:"write"'

const ENV_KEYS = [
  "QUANTA_BENCH_PRESET",
  "QUANTA_BENCH_SOTA",
  "QUANTA_KNOBS_PRESET",
  "QUANTA_BENCH_LEAN_PROMPT",
  "QUANTA_BENCH_SIMPLICITY",
  "QUANTA_BENCH_LSP",
  "QUANTA_BENCH_LSP_STEER",
  "QUANTA_BENCH_IN_LOOP_EXEC",
  "QUANTA_LSP_TOOLS",
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
const buildOnce = (): ReturnType<typeof buildConfig> => {
  const ac = new AbortController()
  return buildConfig(
    swebenchInstance(),
    { llm: new StubLLM(), maxTurns: 1, timeoutMs: 5_000 },
    "/tmp/sb",
    ac.signal,
    stubStream,
  )
}
const userText = (cfg: ReturnType<typeof buildConfig>): string => {
  const block = cfg.messages[0]?.content[0]
  return block && block.type === "text" ? block.text : ""
}

describe("QUANTA_BENCH_LEAN_PROMPT", () => {
  test("OFF (default) ⇒ verbose directive + (opt-in) simplicity steer present (byte-identical baseline)", () => {
    // Simplicity steer is now DEFAULT-OFF (opt-in); explicitly enable it so this
    // test exercises the verbose-vs-lean directive split with the bolt-on present.
    process.env.QUANTA_BENCH_SIMPLICITY = "1"
    const text = userText(buildOnce())
    expect(text).toContain(VERBOSE_MARK)
    expect(text).toContain(SIMPLICITY_MARK)
    expect(text).not.toContain(LEAN_MARK)
  })

  test("LEAN-1/2/3: ON ⇒ lean directive present, verbose + bolt-on steers absent", () => {
    process.env.QUANTA_BENCH_LEAN_PROMPT = "1"
    process.env.QUANTA_BENCH_SIMPLICITY = "1" // opt-in; lean must still strip it (LEAN-3)
    const text = userText(buildOnce())
    expect(text).toContain(LEAN_MARK) // LEAN-1
    expect(text).toContain(VERIFY_MODE_STEER)
    expect(text).not.toContain(VERBOSE_MARK) // LEAN-2
    expect(text).not.toContain(SIMPLICITY_MARK) // LEAN-3
  })

  test("LEAN-4: ON + in-loop-exec=off preserves NOEXEC authority", () => {
    process.env.QUANTA_BENCH_LEAN_PROMPT = "1"
    process.env.QUANTA_BENCH_IN_LOOP_EXEC = "off"
    const text = userText(buildOnce())
    expect(text).toContain(LEAN_MARK)
    expect(text).toContain("Do NOT run the repository test suite, pytest, tox")
    expect(text).not.toContain("relevant regression tests")
    expect(text).not.toContain("MANDATORY before you stop")
  })

  test("LEAN-5: ON + in-loop-exec=repro-only preserves focused repro authority", () => {
    process.env.QUANTA_BENCH_LEAN_PROMPT = "1"
    process.env.QUANTA_BENCH_IN_LOOP_EXEC = "repro-only"
    const text = userText(buildOnce())
    expect(text).toContain(LEAN_MARK)
    expect(text).toContain("If useful, reproduce the issue with a small script")
    expect(text).toContain(VERIFY_MODE_STEER)
    expect(text).toContain("Do NOT run the repository test suite, pytest, tox")
    expect(text).not.toContain("MANDATORY before you stop")
  })

  test("OFF byte-identity: text is exactly the pre-knob composition with knob unset vs explicit off", () => {
    const off = userText(buildOnce())
    process.env.QUANTA_BENCH_LEAN_PROMPT = "0"
    const explicitOff = userText(buildOnce())
    expect(explicitOff).toBe(off)
  })
})
