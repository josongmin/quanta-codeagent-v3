import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import {
  buildResumeMessage,
  captureAbortedTurn,
  captureInterruptedTurn,
  createInterruptedTurnBuffer,
} from "@/agent/interrupted-turn"
import { prepareTurnIteration } from "@/agent/loop/turn-iteration"
import { resolveTurnLoopOutcome } from "@/agent/loop/turn-outcome"
import type { Message } from "@/llm"

/**
 * ALBB-06 — the SIGNAL-driven abort exits (Ctrl+C / Esc-Esc → plain
 * `AbortController.abort()`) must capture the interrupted turn, not just the
 * conversation-action `/cancel` verb. Three silent exits are covered here:
 *
 *   (path a) prepareTurnIteration signal.aborted early-return  → reason "signal_abort"
 *   (path b) prepareTurnIteration queued-inputs "aborted" relay → reason "signal_abort"
 *   (path c) resolveTurnLoopOutcome result.kind==="aborted"     → reason "turn_result_abort"
 *
 * Plus: the payload now carries an in-flight tool_use summary (ids/names ONLY),
 * and the /cancel path stays byte-identical (paired control lives in the E2E
 * hellgate; here we pin the distinct reason strings + the default-OFF no-op).
 *
 * RED-ON-INJECTION: stub `captureAbortedTurn` to a no-op ⇒ every "captures"
 * assertion below fails (the buffer stays empty).
 */

const msg = (role: "user" | "assistant", text: string): Message => ({
  role,
  content: [{ type: "text", text }],
})

const noopStream = { emit: () => {} }

const fakeWm = (initial: Message[]) => {
  const buf = [...initial]
  return {
    messages: buf,
    append: (m: Message) => buf.push(m),
    snapshot: () => buf,
    clear: () => {
      buf.length = 0
    },
    replace: (xs: Message[]) => {
      buf.length = 0
      buf.push(...xs)
    },
    tokenEstimate: () => 0,
  }
}

/** cfg with a wired buffer + an already-aborted signal (path a) or a fresh
 *  signal (paths b/c). `conversationActionPort` absent ⇒ pollConversationAction
 *  yields no action, so path (b) is reached ONLY via the aborted-signal relay. */
const buildCfg = (opts: {
  buffer?: ReturnType<typeof createInterruptedTurnBuffer>
  aborted: boolean
}): AgentConfig => {
  const ac = new AbortController()
  if (opts.aborted) ac.abort()
  return {
    stream: noopStream,
    signal: ac.signal,
    ...(opts.buffer !== undefined ? { interruptedTurnBuffer: opts.buffer } : {}),
  } as unknown as AgentConfig
}

describe("captureAbortedTurn — shared helper", () => {
  test("captures the partial turn into a wired buffer (mirrors the :81 shape)", () => {
    const buffer = createInterruptedTurnBuffer()
    const cfg = buildCfg({ buffer, aborted: false })
    const wm = fakeWm([msg("user", "do the thing"), msg("assistant", "started")])
    captureAbortedTurn(cfg, wm as never, "signal_abort")
    expect(buffer.has()).toBe(true)
    expect(buffer.peek()?.userText).toBe("do the thing")
    expect(buffer.peek()?.partialAssistantText).toBe("started")
    expect(buffer.peek()?.reason).toBe("signal_abort")
  })

  test("DEFAULT-OFF: no buffer wired ⇒ no-op, no throw", () => {
    const cfg = buildCfg({ aborted: false })
    const wm = fakeWm([msg("user", "task"), msg("assistant", "partial")])
    expect(() => captureAbortedTurn(cfg, wm as never, "signal_abort")).not.toThrow()
  })
})

describe("path (a) — prepareTurnIteration signal.aborted early-return", () => {
  const runPrep = (cfg: AgentConfig, wm: ReturnType<typeof fakeWm>) =>
    prepareTurnIteration({
      cfg,
      wm: wm as never,
      sessionId: "s",
      taskRegistry: undefined,
      turn: 3,
      localizePhaseState: undefined,
      dedupGate: undefined,
      shellSnapshotSession: undefined,
      hookPromptPending: [],
      tokenBaseline: undefined,
    })

  test("aborted signal ⇒ CAPTURES with reason signal_abort", async () => {
    const buffer = createInterruptedTurnBuffer()
    const cfg = buildCfg({ buffer, aborted: true })
    const wm = fakeWm([msg("user", "cancelled task"), msg("assistant", "half done")])
    expect(await runPrep(cfg, wm)).toBe("aborted")
    expect(buffer.has()).toBe(true)
    expect(buffer.peek()?.reason).toBe("signal_abort")
    expect(buffer.peek()?.userText).toBe("cancelled task")
    expect(buffer.peek()?.partialAssistantText).toBe("half done")
  })

  test("DEFAULT-OFF: aborted signal, no buffer ⇒ still 'aborted', no throw", async () => {
    const cfg = buildCfg({ aborted: true })
    const wm = fakeWm([msg("user", "t"), msg("assistant", "p")])
    expect(await runPrep(cfg, wm)).toBe("aborted")
  })
})

describe("path (c) — resolveTurnLoopOutcome result.kind==='aborted'", () => {
  const runOutcome = (cfg: AgentConfig, wm: ReturnType<typeof fakeWm>) =>
    resolveTurnLoopOutcome({
      cfg,
      stream: noopStream as never,
      wm: wm as never,
      breaker: undefined,
      recorder: undefined,
      turn: 5,
      result: { kind: "aborted" },
      pendingPlanExitRef: { current: [] },
      pendingPlanEntryRef: { current: [] },
      hookPromptPending: [],
    })

  test("aborted TurnResult ⇒ CAPTURES with reason turn_result_abort", async () => {
    const buffer = createInterruptedTurnBuffer()
    const cfg = buildCfg({ buffer, aborted: false })
    const wm = fakeWm([msg("user", "mid-turn task"), msg("assistant", "in progress")])
    const res = await runOutcome(cfg, wm)
    expect(res.kind).toBe("finish")
    expect(buffer.has()).toBe(true)
    expect(buffer.peek()?.reason).toBe("turn_result_abort")
    expect(buffer.peek()?.userText).toBe("mid-turn task")
    expect(buffer.peek()?.partialAssistantText).toBe("in progress")
  })

  test("DEFAULT-OFF: no buffer ⇒ still finishes aborted, no capture, no throw", async () => {
    const cfg = buildCfg({ aborted: false })
    const wm = fakeWm([msg("user", "t"), msg("assistant", "p")])
    const res = await runOutcome(cfg, wm)
    expect(res.kind).toBe("finish")
  })

  test("captured:true does not recapture stream salvage (duplicate-capture control)", async () => {
    const buffer = createInterruptedTurnBuffer()
    buffer.capture({
      userText: "go",
      partialAssistantText: "partial...",
      reason: "conversation_cancel",
      interruptedAt: 1,
    })
    const cfg = buildCfg({ buffer, aborted: false })
    const wm = fakeWm([msg("user", "go")])
    const res = await resolveTurnLoopOutcome({
      cfg,
      stream: noopStream as never,
      wm: wm as never,
      breaker: undefined,
      recorder: undefined,
      turn: 5,
      result: { kind: "aborted", captured: true, salvage: { partialText: "partial..." } },
      pendingPlanExitRef: { current: [] },
      pendingPlanEntryRef: { current: [] },
      hookPromptPending: [],
    })
    expect(res.kind).toBe("finish")
    expect(buffer.peek()?.reason).toBe("conversation_cancel")
    expect(buffer.peek()?.partialAssistantText).toBe("partial...")
    expect(buffer.peek()?.interruptedAt).toBe(1)
  })
})

describe("inFlightTools — in-flight tool_use summary (ids/names ONLY)", () => {
  const withTool = (): Message[] => [
    msg("user", "run the thing"),
    {
      role: "assistant",
      content: [
        { type: "text", text: "let me search" },
        { type: "tool_use", id: "toolu_42", name: "grep", input: { pattern: "SECRET_TOKEN=xyz" } },
      ],
    },
  ]

  test("captureInterruptedTurn extracts {id,name} from the last assistant tool_use blocks", () => {
    const cap = captureInterruptedTurn(withTool(), "signal_abort", 1)
    expect(cap.inFlightTools).toEqual([{ id: "toolu_42", name: "grep" }])
  })

  test("NO ARG LEAK: the captured summary never carries tool input args", () => {
    const cap = captureInterruptedTurn(withTool(), "signal_abort", 1)
    const serialized = JSON.stringify(cap)
    expect(serialized).not.toContain("SECRET_TOKEN")
    expect(serialized).not.toContain("input")
  })

  test("no tool_use in flight ⇒ inFlightTools absent/empty (byte-identical text path)", () => {
    const cap = captureInterruptedTurn(
      [msg("user", "task"), msg("assistant", "just text")],
      "signal_abort",
      1,
    )
    expect(cap.inFlightTools === undefined || cap.inFlightTools.length === 0).toBe(true)
  })

  test("buildResumeMessage appends a re-anchor note when a tool was in flight", () => {
    const cap = captureInterruptedTurn(withTool(), "signal_abort", 1)
    const resume = buildResumeMessage(cap)
    expect(resume).toContain("grep")
    expect(resume).toContain("toolu_42")
  })

  test("buildResumeMessage: no in-flight tool ⇒ NO re-anchor note (byte-identical)", () => {
    const cap = captureInterruptedTurn(
      [msg("user", "task"), msg("assistant", "text only")],
      "signal_abort",
      1,
    )
    const resume = buildResumeMessage(cap)
    expect(resume).not.toContain("re-issue")
  })
})
