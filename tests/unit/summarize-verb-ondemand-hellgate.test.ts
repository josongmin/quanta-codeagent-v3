import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { compactIfNeeded } from "@/agent/compaction"
import { compactNowOnDemand } from "@/agent/loop/compaction-wire"
import { pollConversationAction } from "@/agent/loop/control-poll"
import type { ActiveTurnState } from "@/agent/steering"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"

// §11.5 / ticket-07 — the `summarize` conversation-action verb was decided but a
// NO-OP (control-poll fell through to conversation_action_noop) + compaction had
// no on-demand seam. This pins the fix: (1) compactIfNeeded `force` bypasses the
// token threshold, (2) control-poll surfaces a `summarize` outcome, (3)
// compactNowOnDemand force-compacts working memory (default-OFF when no
// compaction config).

class FakeSummarizerLLM implements LLMPort {
  callCount = 0
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.callCount++
    yield { type: "text_delta", delta: "SUMMARY" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const u = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })
const a = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }] })

/** A multi-turn transcript so `findBoundary` yields a summarizable prefix. */
const manyTurns = (): Message[] => {
  const m: Message[] = []
  for (let i = 0; i < 8; i++) {
    m.push(u(`task ${i}`), a(`work ${i}`))
  }
  return m
}

const fakeWm = (initial: Message[]) => {
  const buf = [...initial]
  return {
    messages: buf,
    append: (x: Message) => buf.push(x),
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

describe("compactIfNeeded — force (on-demand) bypass", () => {
  test("below threshold + force:true ⇒ COMPACTS (vs under_threshold without force)", async () => {
    const messages = manyTurns()
    const llm = new FakeSummarizerLLM()
    // without force: tiny transcript is under threshold → no compaction.
    const off = await compactIfNeeded({ messages, llm, system: "sys" })
    expect(off.compacted).toBe(false)
    if (off.compacted) throw new Error("expected no compaction under threshold")
    expect(off.reason).toBe("under_threshold")
    // with force: summarizes regardless of the threshold.
    const on = await compactIfNeeded({ messages, llm, system: "sys", force: true })
    expect(on.compacted).toBe(true)
    expect(on.messages.length).toBeLessThan(messages.length)
  })

  test("force still respects no_boundary (single indivisible turn ⇒ no-op)", async () => {
    const llm = new FakeSummarizerLLM()
    const r = await compactIfNeeded({ messages: [u("only one")], llm, system: "sys", force: true })
    expect(r.compacted).toBe(false)
    if (r.compacted) throw new Error("expected no compaction for single indivisible turn")
    expect(r.reason).toBe("no_boundary")
  })
})

describe("control-poll — summarize verb is no longer a no-op", () => {
  const activeMain: ActiveTurnState = {
    currentTurn: { turnId: "t1", kind: "main", startedAt: 1, threadId: "x" },
    isInterrupted: false,
  }
  const cfgWith = (action: { kind: string } | undefined): AgentConfig => {
    let served = false
    return {
      stream: { emit: () => {} },
      activeTurnRef: { current: activeMain },
      conversationActionPort: {
        next: () => {
          if (served) return undefined
          served = true
          return action
        },
      },
    } as unknown as AgentConfig
  }

  test("a queued summarize action ⇒ outcome {kind:'summarize'} (not continue/noop)", async () => {
    const outcome = await pollConversationAction(cfgWith({ kind: "summarize" }), undefined)
    expect(outcome.kind).toBe("summarize")
  })
})

describe("compactNowOnDemand", () => {
  const cfg = (withCompaction: boolean): AgentConfig =>
    ({
      llm: new FakeSummarizerLLM(),
      system: "sys",
      ...(withCompaction ? { compaction: {} } : {}),
    }) as unknown as AgentConfig

  test("with compaction config ⇒ force-compacts working memory (wm shrinks)", async () => {
    const wm = fakeWm(manyTurns())
    const before = wm.snapshot().length
    const did = await compactNowOnDemand(cfg(true), wm as never)
    expect(did).toBe(true)
    expect(wm.snapshot().length).toBeLessThan(before)
  })

  test("DEFAULT-OFF: no compaction config ⇒ no-op (false, wm unchanged)", async () => {
    const wm = fakeWm(manyTurns())
    const before = wm.snapshot().length
    const did = await compactNowOnDemand(cfg(false), wm as never)
    expect(did).toBe(false)
    expect(wm.snapshot().length).toBe(before)
  })
})
