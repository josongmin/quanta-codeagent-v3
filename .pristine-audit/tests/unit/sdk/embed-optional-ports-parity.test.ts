/**
 * ALBB-12 claim 2 — SDK embed optional-port parity.
 *
 * `createAnalysisAgent` must run `wireOptionalAgentPorts(cfg, env)` on the
 * assembled config (the FINAL composition transform every other surface runs),
 * so env-gated ports (`QUANTA_REFUSAL_FALLBACK`, subagent tool-gates, closeout
 * critic, …) are LIVE for SDK consumers — parity with CLI/bench.
 *
 * Proof rails (red-on-injection):
 *  - GATE ON: script a `refusal` turn followed by a real answer. With the wire,
 *    `refusalFallback` neutralizes-by-fork and RE-PROMPTS once (a SECOND LLM
 *    stream call) → the model gets a second chance and the final text is the
 *    real answer, not the refusal terminal. Removing the `wireOptionalAgentPorts`
 *    call in embed ⇒ the refusal terminates the run at ONE LLM call → assertion
 *    fails.
 *  - DEFAULT-OFF byte-identical: with no env gate, a refusal terminates at ONE
 *    LLM call exactly as before (the wire is a no-op) — guards against a wire
 *    that fires unconditionally.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StreamEvent } from "@/llm"
import { type AgentRun, createAnalysisAgent } from "@/sdk"
import { fakeLlm } from "@/sdk/testing"

/** A turn that ends in a provider REFUSAL stop reason (no text). */
const refusalTurn = (): { events: StreamEvent[] } => ({
  events: [{ type: "message_stop", stop_reason: "refusal" }],
})

const mkCwd = () => mkdtempSync(join(tmpdir(), "sdk-parity-"))

describe("embed optional-port parity — QUANTA_REFUSAL_FALLBACK", () => {
  test("GATE ON ⇒ refusal is neutralized+re-prompted through the SDK (parity)", async () => {
    const cwd = mkCwd()
    try {
      // The FakeLlm records every `stream` call in `seen`; a re-prompt is a
      // SECOND call. Turn 1 = refusal; turn 2 = the recovered real answer.
      const llm = fakeLlm([refusalTurn(), { text: "here is the analysis" }])
      const agent = createAnalysisAgent({
        cwd,
        model: "sdk-fake",
        llm,
        maxTurns: 5,
        env: { QUANTA_REFUSAL_FALLBACK: "on" },
      })
      const outcome = await agent.run("do the thing")
      // The fallback re-prompted ⇒ the LLM was called at least twice. This is the
      // load-bearing red-on-injection proof: no wire ⇒ refusal terminates at ONE
      // call (see the DEFAULT-OFF sibling).
      expect((llm as unknown as { seen: unknown[] }).seen.length).toBeGreaterThanOrEqual(2)
      // And the recovered turn-2 answer landed in the transcript — not a refusal
      // terminal.
      const transcript = JSON.stringify(outcome.messages)
      expect(transcript).toContain("here is the analysis")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("DEFAULT-OFF ⇒ refusal terminates at ONE LLM call (byte-identical)", async () => {
    const cwd = mkCwd()
    try {
      const llm = fakeLlm([refusalTurn(), { text: "should never be reached" }])
      const agent = createAnalysisAgent({
        cwd,
        model: "sdk-fake",
        llm,
        maxTurns: 5,
        // NO env gate ⇒ wireOptionalAgentPorts is a no-op ⇒ refusal is terminal.
      })
      await agent.run("do the thing")
      expect((llm as unknown as { seen: unknown[] }).seen.length).toBe(1)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe("AgentRun.droppedEvents observability — ALBB-12 claim 3", () => {
  test("a run whose buffer overflows exposes droppedEvents > 0", async () => {
    const cwd = mkCwd()
    try {
      // Emit MANY text deltas into a tiny buffer with a promise-only consumer
      // (never iterates) ⇒ the drop-oldest overflow path fires.
      const deltas: StreamEvent[] = []
      for (let i = 0; i < 64; i++) deltas.push({ type: "text_delta", delta: `d${i}` })
      deltas.push({ type: "message_stop", stop_reason: "end_turn" })
      const agent = createAnalysisAgent({
        cwd,
        model: "sdk-fake",
        llm: fakeLlm([{ events: deltas }]),
        maxTurns: 3,
        eventBufferSize: 1,
      })
      const run: AgentRun = agent.run("stream a lot")
      await run
      expect(run.droppedEvents).toBeGreaterThan(0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
