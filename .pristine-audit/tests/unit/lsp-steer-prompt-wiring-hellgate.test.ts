import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import "@/runner/knobs/knobs"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { __resetKnobOverrides } from "@/shared/knob-overrides"
import type { StreamPort } from "@/stream"
import { buildConfig } from "../../src/apps/bench/eval/driver"
import type { Instance } from "../../src/apps/bench/types"

/**
 * Hellgate: the LSP-nav GROUNDING steer is surfaced in the ALWAYS-PRESENT
 * swebench directive, not only in the Phase-1 edit-block message.
 *
 * WHY: measured on a real remote run (gpt-5.4, agentless-v2) — the steer
 * appeared 0× and `lsp_definition` was called 0× because a localize-first agent
 * explores with read/grep for the whole Phase-1 window and NEVER attempts the
 * early edit that fires the block message. So the steer was structurally
 * unreachable. Putting it in the directive makes it visible from turn 0.
 *
 * Red-on-injection:
 *  - drop the `lspSteerLine` append in buildConfig ⇒ STEER-1 (present by default) RED.
 *  - couple it to `lspNav` instead of `lspGroundingSteer` ⇒ STEER-2 (off-switch) RED.
 */
const STEER_MARK = "confirm its TRUE owner with `lsp_definition`"
const ENV_KEYS = [
  "QUANTA_BENCH_PRESET",
  "QUANTA_BENCH_SOTA",
  "QUANTA_KNOBS_PRESET",
  "QUANTA_BENCH_LSP",
  "QUANTA_BENCH_LSP_STEER",
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

describe("LSP grounding steer in the always-present directive", () => {
  test("STEER-1: nav-on preset (agentless-v1) ⇒ steer present in the prompt by default", () => {
    process.env.QUANTA_BENCH_PRESET = "agentless-v1"
    expect(userText(buildOnce())).toContain(STEER_MARK)
  })

  test("STEER-2: QUANTA_BENCH_LSP_STEER=off ⇒ steer absent (A/B baseline, nav still on)", () => {
    process.env.QUANTA_BENCH_PRESET = "agentless-v1"
    process.env.QUANTA_BENCH_LSP_STEER = "off"
    expect(userText(buildOnce())).not.toContain(STEER_MARK)
  })

  test("STEER-3: no preset (nav off) ⇒ no steer (byte-identical baseline)", () => {
    expect(userText(buildOnce())).not.toContain(STEER_MARK)
  })
})
