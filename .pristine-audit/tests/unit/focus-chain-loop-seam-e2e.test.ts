/**
 * Focus Chain loop-seam e2e (ADR-0219) — "does our tool get picked up
 * automatically?" answered at the REAL loop seam, not the pure tracker.
 *
 * The hellgate proves the tracker math; this proves the WIRING: that
 * `injectFocusChainMessage` (the function the turn loop actually calls every
 * turn) drains the tracker and SPLICES the rendered todo block into the live
 * WorkingMemory as a `role:"user"` message — exactly the Claude-Code-style
 * "here is your current todo list" re-injection, on the default N=6 cadence.
 *
 * Teeth: pre-wire (or a regression that stops calling tickTurn/append) makes
 * the snapshot stay empty.
 *
 * PURE — no LLM, no IO. Drives the production `injectFocusChainMessage`
 * against a real tracker + real WorkingMemory.
 */
import { describe, expect, test } from "bun:test"
import { defaultFocusChainTracker } from "@/agent/focus-chain"
import { injectFocusChainMessage } from "@/agent/loop/turn-iteration"
import type { AgentConfig } from "@/agent/types"
import type { Message } from "@/llm"
import { createWorkingMemory } from "@/memory"

/** Minimal cfg: only the slots injectFocusChainMessage touches. */
const cfgWith = (reinjectEveryN: number): AgentConfig =>
  ({
    focusChain: { tracker: defaultFocusChainTracker({ reinjectEveryN }), reinjectEveryN },
    stream: { emit: () => {} },
  }) as unknown as AgentConfig

const userBlocks = (wm: ReturnType<typeof createWorkingMemory<Message>>): string[] =>
  wm
    .snapshot()
    .filter((m) => m.role === "user")
    .map((m) => (m.content[0]?.type === "text" ? m.content[0].text : ""))

describe("focus-chain loop seam — auto re-inject wiring", () => {
  test("DEFAULT cadence (6): the model's todos re-appear as a user message on turn 6", () => {
    const cfg = cfgWith(6)
    cfg.focusChain?.tracker.setTodos([
      { text: "implement feature", state: "in-progress" },
      { text: "adversarial audit x2", state: "pending" },
      { text: "write ticket", state: "pending" },
    ])
    const wm = createWorkingMemory<Message>([])

    // turns 1-5: no re-inject yet (cycle not complete)
    for (let i = 0; i < 5; i++) injectFocusChainMessage(cfg, wm)
    expect(userBlocks(wm).length).toBe(0)

    // turn 6: the todo block lands
    injectFocusChainMessage(cfg, wm)
    const blocks = userBlocks(wm)
    expect(blocks.length).toBe(1)
    expect(blocks[0]).toContain("## Focus Chain — Todos")
    expect(blocks[0]).toContain("[~] implement feature")
    expect(blocks[0]).toContain("[ ] adversarial audit x2")
    expect(blocks[0]).toContain("[ ] write ticket")
  })

  test("EMPTY todos (model never called the plan tool) ⇒ nothing is ever spliced", () => {
    const cfg = cfgWith(2)
    const wm = createWorkingMemory<Message>([])
    for (let i = 0; i < 10; i++) injectFocusChainMessage(cfg, wm)
    expect(wm.snapshot().length).toBe(0)
  })

  test("progress shows through: markDone flips [~]→[x] in the next re-inject", () => {
    const cfg = cfgWith(1)
    cfg.focusChain?.tracker.setTodos([
      { text: "step one", state: "in-progress" },
      { text: "step two", state: "pending" },
    ])
    const wm = createWorkingMemory<Message>([])

    injectFocusChainMessage(cfg, wm) // turn 1 → inject
    cfg.focusChain?.tracker.markDone(0)
    injectFocusChainMessage(cfg, wm) // turn 2 → inject again, now with progress

    const blocks = userBlocks(wm)
    expect(blocks.length).toBe(2)
    expect(blocks[1]).toContain("[x] step one")
  })

  test("OFF (no focusChain slot) ⇒ byte-identical no-op", () => {
    const cfg = {} as unknown as AgentConfig
    const wm = createWorkingMemory<Message>([])
    for (let i = 0; i < 8; i++) injectFocusChainMessage(cfg, wm)
    expect(wm.snapshot().length).toBe(0)
  })
})
