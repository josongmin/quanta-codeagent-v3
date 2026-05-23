import { describe, expect, test } from "bun:test"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import {
  dropLastAssistantMessage,
  parseRetryWithArgs,
  type RetryWithSessionState,
  retryWithCmd,
} from "../../src/apps/cli/retry-with"
import { runSlashCommand, type SlashContext } from "../../src/apps/cli/slash-commands"

/** Scripted LLM that yields a fixed event list. Records the input it was
 *  streamed with so we can assert forwarding. */
class ScriptedLLM implements LLMPort {
  public calls = 0
  public lastInput: StreamInput | undefined
  constructor(
    public readonly model: string,
    private readonly events: StreamEvent[],
  ) {}

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    this.lastInput = input
    for (const ev of this.events) yield ev
  }
}

/** LLM that throws mid-stream — used to assert "errors surface normally". */
class FailingLLM implements LLMPort {
  constructor(
    public readonly model: string,
    private readonly afterEvents: StreamEvent[],
    private readonly err: Error,
  ) {}

  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    for (const ev of this.afterEvents) yield ev
    throw this.err
  }
}

interface Captured {
  out: string
  err: string
  events: StreamEvent[]
  ctx: SlashContext
}

const buildCtx = (retry?: RetryWithSessionState | undefined): Captured => {
  const captured: Captured = {
    out: "",
    err: "",
    events: [],
    ctx: {
      out: (s) => {
        captured.out += s
      },
      err: (s) => {
        captured.err += s
      },
      cwd: "/tmp",
      ...(retry !== undefined ? { retry } : {}),
    },
  }
  return captured
}

const userMsg = (text: string, id?: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
  ...(id !== undefined ? { id } : {}),
})

const asstMsg = (text: string, id?: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...(id !== undefined ? { id } : {}),
})

const emptyStreamInput: StreamInput = { messages: [], tools: [] }

describe("parseRetryWithArgs", () => {
  test("no args ⇒ requested: undefined (escalation mode)", () => {
    expect(parseRetryWithArgs([])).toEqual({ requested: undefined })
  })

  test("one arg ⇒ requested: that id", () => {
    expect(parseRetryWithArgs(["claude-opus-4-7"])).toEqual({ requested: "claude-opus-4-7" })
  })

  test("two or more args ⇒ throws", () => {
    expect(() => parseRetryWithArgs(["a", "b"])).toThrow(/at most one argument/i)
  })

  test("empty-string arg ⇒ throws", () => {
    expect(() => parseRetryWithArgs([""])).toThrow(/cannot be empty/i)
  })
})

describe("dropLastAssistantMessage", () => {
  test("removes the last assistant message in place, leaves users intact", () => {
    const messages: Message[] = [
      userMsg("hi", "u1"),
      asstMsg("hello", "a1"),
      userMsg("again", "u2"),
      asstMsg("answer", "a2"),
    ]
    const dropped = dropLastAssistantMessage(messages)
    expect(dropped?.id).toBe("a2")
    expect(messages.map((m) => m.id)).toEqual(["u1", "a1", "u2"])
  })

  test("returns undefined when no assistant message exists", () => {
    const messages: Message[] = [userMsg("hi", "u1")]
    expect(dropLastAssistantMessage(messages)).toBeUndefined()
    expect(messages.length).toBe(1)
  })

  test("works on legacy id-less messages (falls back to role match)", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "ans" }] },
    ]
    const dropped = dropLastAssistantMessage(messages)
    expect(dropped?.role).toBe("assistant")
    expect(messages.length).toBe(1)
  })
})

describe("/retry-with — slash dispatch", () => {
  test("no session state ⇒ user-visible 'no model candidates configured', return 1", async () => {
    const cap = buildCtx(undefined)
    const code = await retryWithCmd.run([], cap.ctx)
    expect(code).toBe(1)
    expect(cap.out).toContain("no model candidates configured")
  })

  test("empty candidates ⇒ user-visible 'no model candidates configured', return 1", async () => {
    const messages: Message[] = [asstMsg("ans", "a1")]
    const cap = buildCtx({
      candidates: [],
      currentModelId: "a",
      messages,
      streamInput: emptyStreamInput,
      onEvent: () => {},
    })
    const code = await retryWithCmd.run([], cap.ctx)
    expect(code).toBe(1)
    expect(cap.out).toContain("no model candidates configured")
    // Session unchanged.
    expect(messages.length).toBe(1)
  })

  test("dispatch via runSlashCommand — `/retry-with` no arg routes correctly", async () => {
    const cap = buildCtx(undefined)
    const code = await runSlashCommand("/retry-with", cap.ctx)
    expect(code).toBe(1)
    expect(cap.out).toContain("no model candidates configured")
  })

  test("dispatch via runSlashCommand — `/retry-with claude-opus-4-7` parses arg", async () => {
    const messages: Message[] = [userMsg("q", "u1"), asstMsg("a", "a1")]
    const candidates = [
      { id: "claude-sonnet-4-6", port: new ScriptedLLM("claude-sonnet-4-6", []) },
      {
        id: "claude-opus-4-7",
        port: new ScriptedLLM("claude-opus-4-7", [
          { type: "text_delta", delta: "swapped" },
          { type: "message_stop", stop_reason: "end_turn" },
        ]),
      },
    ]
    const events: StreamEvent[] = []
    const cap = buildCtx({
      candidates,
      currentModelId: "claude-sonnet-4-6",
      messages,
      streamInput: emptyStreamInput,
      onEvent: (ev) => {
        events.push(ev)
      },
    })
    const code = await runSlashCommand("/retry-with claude-opus-4-7", cap.ctx)
    expect(code).toBe(0)
    // Prior assistant message replaced.
    expect(messages.map((m) => m.role)).toEqual(["user"])
    // Stream began with stream_reset tombstone.
    expect(events[0]).toEqual({ type: "stream_reset" })
    expect(events.length).toBe(3)
  })

  test("unknown requested id ⇒ NoAlternateModelError surfaced via err writer; session unchanged", async () => {
    const priorMessages: Message[] = [userMsg("q", "u1"), asstMsg("a", "a1")]
    const candidates = [
      { id: "a", port: new ScriptedLLM("a", []) },
      { id: "b", port: new ScriptedLLM("b", []) },
    ]
    const cap = buildCtx({
      candidates,
      currentModelId: "a",
      messages: priorMessages,
      streamInput: emptyStreamInput,
      onEvent: () => {},
    })
    const code = await retryWithCmd.run(["does-not-exist"], cap.ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("no alternate model available")
    expect(cap.err).toContain("a, b")
    // Session left intact — the assistant message remains.
    expect(priorMessages.map((m) => m.id)).toEqual(["u1", "a1"])
  })

  test("escalation with no next candidate (current is last) ⇒ err message; session unchanged", async () => {
    const messages: Message[] = [userMsg("q", "u1"), asstMsg("a", "a1")]
    const candidates = [
      { id: "a", port: new ScriptedLLM("a", []) },
      { id: "b", port: new ScriptedLLM("b", []) },
    ]
    const cap = buildCtx({
      candidates,
      currentModelId: "b",
      messages,
      streamInput: emptyStreamInput,
      onEvent: () => {},
    })
    const code = await retryWithCmd.run([], cap.ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("no alternate model available")
    expect(messages.length).toBe(2)
  })

  test("successful escalation ⇒ replaces prior assistant; stream begins with stream_reset", async () => {
    const messages: Message[] = [userMsg("q", "u1"), asstMsg("first answer", "a1")]
    const innerEvents: StreamEvent[] = [
      { type: "text_delta", delta: "fresh " },
      { type: "text_delta", delta: "answer" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const candidates = [
      { id: "a", port: new ScriptedLLM("a", []) },
      { id: "b", port: new ScriptedLLM("b", innerEvents) },
    ]
    const collected: StreamEvent[] = []
    const cap = buildCtx({
      candidates,
      currentModelId: "a",
      messages,
      streamInput: emptyStreamInput,
      onEvent: (ev) => {
        collected.push(ev)
      },
    })
    const code = await retryWithCmd.run([], cap.ctx)
    expect(code).toBe(0)
    // Prior assistant message dropped.
    expect(messages.length).toBe(1)
    expect(messages[0]?.role).toBe("user")
    // Stream began with stream_reset tombstone, then forwarded inner events.
    expect(collected[0]).toEqual({ type: "stream_reset" })
    expect(collected.slice(1)).toEqual(innerEvents)
    expect(cap.out).toContain("re-streamed against b")
  })

  test("error mid-stream surfaces normally (not silently dropped)", async () => {
    const messages: Message[] = [userMsg("q", "u1"), asstMsg("a", "a1")]
    const boom = new Error("provider exploded")
    const candidates = [
      { id: "a", port: new ScriptedLLM("a", []) },
      {
        id: "b",
        port: new FailingLLM("b", [{ type: "text_delta", delta: "partial" }], boom),
      },
    ]
    const cap = buildCtx({
      candidates,
      currentModelId: "a",
      messages,
      streamInput: emptyStreamInput,
      onEvent: () => {},
    })
    let thrown: Error | undefined
    try {
      await retryWithCmd.run([], cap.ctx)
    } catch (e) {
      thrown = e as Error
    }
    expect(thrown).toBeDefined()
    expect(thrown?.message).toBe("provider exploded")
  })

  test("cooperative cancel mid-swap ⇒ AbortSignal honored, throws", async () => {
    const messages: Message[] = [userMsg("q", "u1"), asstMsg("a", "a1")]
    const ctrl = new AbortController()
    // Many events so we can abort mid-stream.
    const innerEvents: StreamEvent[] = Array.from({ length: 50 }, (_, i) => ({
      type: "text_delta" as const,
      delta: String(i),
    }))
    const candidates = [
      { id: "a", port: new ScriptedLLM("a", []) },
      { id: "b", port: new ScriptedLLM("b", innerEvents) },
    ]
    let seen = 0
    const cap = buildCtx({
      candidates,
      currentModelId: "a",
      messages,
      streamInput: emptyStreamInput,
      signal: ctrl.signal,
      onEvent: () => {
        seen += 1
        // Abort after a couple of events to simulate user interrupt.
        if (seen === 3) ctrl.abort(new Error("user cancelled"))
      },
    })
    let thrown: Error | undefined
    try {
      await retryWithCmd.run([], cap.ctx)
    } catch (e) {
      thrown = e as Error
    }
    expect(thrown).toBeDefined()
    expect(thrown?.message).toBe("user cancelled")
    // Did NOT forward all 50 inner events after the abort.
    expect(seen).toBeLessThan(50)
  })

  test("too many args ⇒ user-visible err, return 1; session unchanged", async () => {
    const messages: Message[] = [userMsg("q", "u1"), asstMsg("a", "a1")]
    const cap = buildCtx({
      candidates: [{ id: "a", port: new ScriptedLLM("a", []) }],
      currentModelId: "a",
      messages,
      streamInput: emptyStreamInput,
      onEvent: () => {},
    })
    const code = await retryWithCmd.run(["x", "y"], cap.ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("at most one argument")
    expect(messages.length).toBe(2)
  })

  test("BUILTINS table now includes /retry-with (and /help anchors index 0)", async () => {
    const { BUILTINS } = await import("../../src/apps/cli/slash-commands")
    expect(BUILTINS.map((c) => c.name)).toEqual([
      // `/help` is registered first so it can render the full LIVE table.
      "/help",
      "/context",
      "/usage",
      "/color",
      "/navigate",
      "/wait",
      "/retry-with",
      "/skills",
      "/reload-skills",
      "/login",
      "/logout",
      "/status",
      "/permission",
      "/snooze",
      "/resume",
      // Claude Code v1.7196 "rewind + fork" pattern — env-gated by
      // QUANTA_REWIND (default "1") at module load. Unit-test env leaves
      // the var unset → both registered.
      "/rewind",
      "/fork",
      "/side",
      "/rules",
    ])
  })
})
