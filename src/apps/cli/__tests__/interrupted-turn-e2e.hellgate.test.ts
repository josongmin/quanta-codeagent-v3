import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { createInterruptedTurnBuffer } from "@/agent/interrupted-turn"
import { pollConversationAction } from "@/agent/loop/control-poll"
import { syncQueuedTurnInputs } from "@/agent/loop/turn-iteration"
import { createConversationActionSurface } from "@/apps/cli/repl/conversation-action-surface"
import type { Message } from "@/llm"

// §11.5 — interrupt → capture → resume E2E hellgate. Drives the FULL chain on
// the real surfaces: the conversation-action surface, the loop's
// `syncQueuedTurnInputs` (capture-on-abort) and `pollConversationAction`
// (resume re-injection), and the session interrupted-turn buffer. The only
// fakes are an in-memory working-memory + a no-op stream sink.

const msg = (role: "user" | "assistant", text: string): Message => ({
  role,
  content: [{ type: "text", text }],
})

/** Minimal structural WorkingMemory (avoids the restricted `@/memory` import). */
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

const noopStream = { emit: () => {} }

const buildCfg = (
  surface: ReturnType<typeof createConversationActionSurface>,
  buffer: ReturnType<typeof createInterruptedTurnBuffer>,
): AgentConfig =>
  ({
    stream: noopStream,
    conversationActionPort: surface.port,
    activeTurnRef: surface.activeTurnRef,
    interruptedTurnBuffer: buffer,
  }) as unknown as AgentConfig

describe("interrupt → capture → resume (E2E)", () => {
  test("a conversation-action cancel CAPTURES the partial turn into the buffer", async () => {
    const surface = createConversationActionSurface()
    surface.activeTurnRef.current = {
      currentTurn: { turnId: "t1", kind: "main", startedAt: 1, threadId: "x" },
      isInterrupted: false,
    }
    const buffer = createInterruptedTurnBuffer()
    const cfg = buildCfg(surface, buffer)
    const wm = fakeWm([msg("user", "refactor the parser"), msg("assistant", "extracted tokenizer")])

    surface.pushCancel("user barge-in")
    const outcome = await syncQueuedTurnInputs({
      cfg,
      wm: wm as never,
      sessionId: "s1",
      taskRegistry: undefined,
    })

    expect(outcome).toBe("aborted")
    expect(buffer.has()).toBe(true)
    expect(buffer.peek()?.userText).toBe("refactor the parser")
    expect(buffer.peek()?.partialAssistantText).toBe("extracted tokenizer")
    expect(buffer.peek()?.reason).toBe("user barge-in")
  })

  test("a later resume RE-INJECTS the captured turn (and consumes the buffer)", async () => {
    const surface = createConversationActionSurface()
    surface.activeTurnRef.current = {
      currentTurn: { turnId: "t2", kind: "main", startedAt: 1, threadId: "x" },
      isInterrupted: false,
    }
    const buffer = createInterruptedTurnBuffer()
    buffer.capture({
      userText: "build the exporter",
      partialAssistantText: "wrote the header",
      reason: "user barge-in",
      interruptedAt: 1,
    })
    const cfg = buildCfg(surface, buffer)

    surface.pushResume()
    const outcome = await pollConversationAction(cfg, undefined)

    expect(outcome.kind).toBe("injection")
    if (outcome.kind !== "injection") throw new Error("expected injection")
    const text = outcome.message.content.map((b) => (b.type === "text" ? b.text : "")).join("")
    expect(text).toContain("build the exporter")
    expect(text).toContain("wrote the header")
    expect(text.toLowerCase()).toContain("resume")
    // The buffer was consumed (take()) — a second resume is a no-op.
    expect(buffer.has()).toBe(false)
  })

  test("DEFAULT-OFF: no interruptedTurnBuffer wired ⇒ abort still works, no capture, no crash", async () => {
    const surface = createConversationActionSurface()
    surface.activeTurnRef.current = {
      currentTurn: { turnId: "t1", kind: "main", startedAt: 1, threadId: "x" },
      isInterrupted: false,
    }
    // cfg WITHOUT interruptedTurnBuffer — the byte-identical legacy path.
    const cfg = {
      stream: noopStream,
      conversationActionPort: surface.port,
      activeTurnRef: surface.activeTurnRef,
    } as unknown as AgentConfig
    surface.pushCancel("x")
    const wm = fakeWm([msg("user", "task"), msg("assistant", "partial")])
    const outcome = await syncQueuedTurnInputs({
      cfg,
      wm: wm as never,
      sessionId: "s",
      taskRegistry: undefined,
    })
    expect(outcome).toBe("aborted") // aborts exactly as before — just no capture
  })

  test("resume with an EMPTY buffer is a clean no-op (continue, nothing injected)", async () => {
    const surface = createConversationActionSurface()
    surface.activeTurnRef.current = { currentTurn: null, isInterrupted: false }
    const buffer = createInterruptedTurnBuffer()
    const cfg = buildCfg(surface, buffer)

    surface.pushResume()
    const outcome = await pollConversationAction(cfg, undefined)
    expect(outcome.kind).toBe("continue")
  })

  test("FULL loop: interrupt (capture) then resume (restore) round-trips the task", async () => {
    const surface = createConversationActionSurface()
    surface.activeTurnRef.current = {
      currentTurn: { turnId: "t3", kind: "main", startedAt: 1, threadId: "x" },
      isInterrupted: false,
    }
    const buffer = createInterruptedTurnBuffer()
    const cfg = buildCfg(surface, buffer)

    // 1) interrupt mid-turn → capture
    surface.pushCancel("interrupt")
    const wm = fakeWm([msg("user", "the big task"), msg("assistant", "halfway done")])
    expect(
      await syncQueuedTurnInputs({ cfg, wm: wm as never, sessionId: "s", taskRegistry: undefined }),
    ).toBe("aborted")

    // 2) resume → re-inject the captured task
    surface.pushResume()
    const resumed = await pollConversationAction(cfg, undefined)
    expect(resumed.kind).toBe("injection")
    if (resumed.kind === "injection") {
      const t = resumed.message.content.map((b) => (b.type === "text" ? b.text : "")).join("")
      expect(t).toContain("the big task")
      expect(t).toContain("halfway done")
    }
    expect(buffer.has()).toBe(false)
  })
})
