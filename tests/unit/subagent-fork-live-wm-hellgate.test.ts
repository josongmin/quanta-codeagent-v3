/**
 * HELLGATE — ALBB-16 #1: `fork_turns` must read LIVE working-memory, not the
 * frozen session SEED.
 *
 * `buildSubagentBlock` wires the trio's `forkPrompt` to compose an inherited
 * parent-transcript preamble. The buggy impl closed over `config.messages` (the
 * SEED array captured at block-build time), so a child spawned MID-SESSION with
 * `fork_turns:"all"` inherited only pre-session turns — every turn accrued after
 * block build was invisible (silent under-inheritance).
 *
 * The fix mirrors the advisor's `transcriptSource?: () => readonly Message[]`
 * pattern: `buildSubagentBlock` takes an optional live-WM getter, resolved
 * LAZILY at spawn time. Absent ⇒ fall back to `config.messages ?? []`
 * (byte-identical to today).
 *
 * We mock `@/agent/subagent-runner` so the block's `agent` tool drives a SPY
 * runner that captures the composed `req.prompt` — the observable proof that the
 * fork preamble carries the post-build turn.
 *
 * MUTATION: the static-`config.messages` impl omits the post-build turn ⇒ RED.
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test"
import * as runnerModule from "@/agent/subagent-runner"
import type { AgentConfig } from "@/agent/types"
import type { Message } from "@/llm"
import type { SubagentRequest, SubagentResult } from "@/subagent"
import { present } from "../_helpers/expect-present"

// Spy runner: capture every `req.prompt` the trio `agent` tool composes.
// Namespace spy (mockRestore-able) — NOT `mock.module`, which leaks the fake
// runner into every other test file sharing the process.
const capturedPrompts: string[] = []

const runnerSpy = spyOn(runnerModule, "createSubagentRunner").mockImplementation((() =>
  async (req: SubagentRequest): Promise<SubagentResult> => {
    capturedPrompts.push(req.prompt)
    return { ok: true, finalText: "done", turns: 1 }
  }) as unknown as typeof runnerModule.createSubagentRunner)

// Import AFTER the spy so the block closes over the spy runner.
const { buildSubagentBlock } = await import("@/agent/tier1/subagent")

afterEach(() => {
  capturedPrompts.length = 0
})
// Restore the real runner so this file's spy never leaks into sibling suites.
afterAll(() => {
  runnerSpy.mockRestore()
})

const u = (t: string): Message => ({ role: "user", content: [{ type: "text", text: t }] })

const ctx = () => ({ cwd: "/tmp", signal: new AbortController().signal }) as never

/** Drive the block's `agent` tool (background:true so it fires the runner
 *  immediately) with the given input, then return the composed child prompt. */
const spawnAndCapture = async (
  block: NonNullable<ReturnType<typeof buildSubagentBlock>>,
  input: Record<string, unknown>,
): Promise<string> => {
  const agentTool = block.extraTools.find((t) => t.name === "agent")
  if (!agentTool) throw new Error("no agent tool on block")
  for await (const _ev of agentTool.execute(input as never, ctx())) void _ev
  // Background spawns fire-and-forget; let the microtask/timer settle.
  await new Promise<void>((r) => setTimeout(r, 5))
  const last = capturedPrompts.at(-1)
  if (last === undefined) throw new Error("runner never received a request")
  return last
}

// Minimal config; buildSubagentBlock reads config.subagent + config.messages.
const cfg = (messages: Message[]): AgentConfig =>
  ({ subagent: {}, messages }) as unknown as AgentConfig

describe("ALBB-16 #1 — fork_turns reads LIVE working-memory", () => {
  test("a turn appended AFTER block build is inherited (live WM, not seed)", async () => {
    // The SEED (config.messages) is a DISTINCT, frozen array — it must NOT be
    // the same reference as the live buffer, or the buggy seed-sourced closure
    // would incidentally observe the mutation and the test would be vacuous.
    const seed: Message[] = [u("seed-turn")]
    // The live working-memory buffer is a SEPARATE array the loop owns.
    const liveWM: Message[] = [u("seed-turn")]
    const block = present(
      buildSubagentBlock(cfg(seed), {
        transcriptSource: () => liveWM,
      }),
      "subagent block",
    )

    // Session progresses: a NEW user turn accrues in LIVE WM only (the seed
    // stays frozen — exactly the production divergence).
    liveWM.push(u("post-build-turn"))

    const composed = await spawnAndCapture(block, {
      prompt: "child task",
      background: true,
      fork_turns: "all",
    })

    // The composed prompt must carry the LIVE turn, not just the seed. The buggy
    // impl reads `config.messages` (the frozen seed) and omits "post-build-turn".
    expect(composed).toContain("post-build-turn")
    expect(composed).toContain("seed-turn")
    expect(composed).toContain("## Your task")
    expect(composed).toContain("child task")
  })

  test("no transcriptSource ⇒ falls back to config.messages (byte-identical seed)", async () => {
    const seed: Message[] = [u("only-seed-turn")]
    // Two blocks over the SAME seed: one seed-sourced (no thunk), one whose
    // thunk returns the SAME seed. The composed prompts must be byte-identical.
    const blockNoThunk = present(buildSubagentBlock(cfg(seed)), "subagent block (seed-sourced)")
    const blockThunk = present(
      buildSubagentBlock(cfg(seed), { transcriptSource: () => seed }),
      "subagent block (thunk)",
    )

    const noThunk = await spawnAndCapture(blockNoThunk, {
      prompt: "t",
      background: true,
      fork_turns: "all",
    })
    const thunk = await spawnAndCapture(blockThunk, {
      prompt: "t",
      background: true,
      fork_turns: "all",
    })

    expect(noThunk).toBe(thunk)
    expect(noThunk).toContain("only-seed-turn")
  })
})
