// TODO(migrate-to-harness): swap the local `RecordingStream` + one-off LLM
// double for `tests/integration/_harness.ts` exports (`FakeLLM`/`ScriptedLLM`
// + `RecordingStream` + `baseConfig`). See `agent-loop.test.ts` for the
// pattern. Deferred from refactor B to keep that PR scoped to 3 files.
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

/**
 * C7 closure: the loop had ZERO abort-branch coverage. Drive the REAL
 * `runAgent` to each abort branch with a real `AbortController` and assert:
 *  - `AgentOutcome.reason === "aborted"`,
 *  - turn accounting is the CORRECTED C11 value (a turn that aborted before
 *    producing a productive model turn does NOT inflate `turns`; only
 *    productive turns already completed are counted),
 *  - no hang (a hard timeout guards every run),
 *  - no unhandled promise rejection (a process-level listener fails the test).
 *
 * House fakes are redefined locally (no cross-test imports), same shape as the
 * recovery-e2e suite.
 */

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const cfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry(defaultTools),
  stream: new RecordingStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 5,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HANG: ${label} did not terminate in ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([p, guard])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Asserts no unhandled rejection fires across the awaited body. */
const noUnhandledRejection = async <T>(body: () => Promise<T>): Promise<T> => {
  const seen: unknown[] = []
  const onRej = (reason: unknown): void => {
    seen.push(reason)
  }
  process.on("unhandledRejection", onRej)
  try {
    const r = await body()
    // Give any orphaned microtasks a tick to surface.
    await new Promise((res) => setTimeout(res, 10))
    expect(seen).toHaveLength(0)
    return r
  } finally {
    process.off("unhandledRejection", onRej)
  }
}

const textScript = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]

const toolUseScript = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]

/** An LLMPort whose stream must never be entered (already-aborted runs bail
 *  before the first stream). Throws if reached; the unreachable `yield` keeps
 *  it a syntactically valid generator. */
const neverCalledLLM = (label: string): LLMPort => ({
  async *stream(_i: StreamInput): AsyncIterable<StreamEvent> {
    // `label.length >= 0` is always true → the throw always fires, but the
    // condition is not statically constant so the `yield` stays reachable for
    // the linter (it makes this a valid, never-yielding generator).
    if (label.length >= 0) throw new Error(`LLM must not be called: ${label}`)
    yield { type: "message_stop", stop_reason: "end_turn" }
  },
})

describe("agent abort branches — C7 coverage", () => {
  test("pre-loop abort: controller aborted BEFORE the first turn → aborted, turns 0", async () => {
    // The loop's top-of-iteration guard `if (signal.aborted) return
    // finish("aborted", turn - 1)` with turn=1 → turns 0 (no work done).
    const ac = new AbortController()
    ac.abort()
    const llm = neverCalledLLM("pre-loop abort")
    const out = await noUnhandledRejection(() =>
      withTimeout(runAgent(cfg({ llm, signal: ac.signal })), 10_000, "pre-loop-abort"),
    )
    expect(out.reason).toBe("aborted")
    expect(out.turns).toBe(0)
    // The controller's signal IS aborted entering the run.
    expect(ac.signal.aborted).toBe(true)
  })

  test("mid-stream abort on the first turn → aborted, turns 0 (no productive turn)", async () => {
    // Abort WHILE the model stream is being consumed. `streamingTurn`'s
    // cooperative `isAborted` check returns `{kind:"aborted"}` →
    // `runTurn` → `finish("aborted", turn - 1)` with turn=1 → turns 0.
    const ac = new AbortController()
    const llm: LLMPort = {
      async *stream(_i: StreamInput): AsyncIterable<StreamEvent> {
        yield { type: "text_delta", delta: "partial..." }
        ac.abort()
        yield { type: "text_delta", delta: "...never observed" }
        yield { type: "message_stop", stop_reason: "end_turn" }
      },
    }
    const out = await noUnhandledRejection(() =>
      withTimeout(runAgent(cfg({ llm, signal: ac.signal })), 10_000, "mid-stream-abort"),
    )
    expect(out.reason).toBe("aborted")
    expect(out.turns).toBe(0)
    // The mid-stream `ac.abort()` flipped the signal — observable end state.
    expect(ac.signal.aborted).toBe(true)
  })

  test("mid-stream abort captures streamed partial into the resume buffer (T2)", async () => {
    const { createInterruptedTurnBuffer } = await import("@/agent/interrupted-turn")
    const ac = new AbortController()
    const buffer = createInterruptedTurnBuffer()
    const llm: LLMPort = {
      async *stream(_i: StreamInput): AsyncIterable<StreamEvent> {
        yield { type: "text_delta", delta: "partial..." }
        ac.abort()
        yield { type: "text_delta", delta: "...never observed" }
        yield { type: "message_stop", stop_reason: "end_turn" }
      },
    }
    const out = await noUnhandledRejection(() =>
      withTimeout(
        runAgent(
          cfg({
            llm,
            signal: ac.signal,
            interruptedTurnBuffer: buffer,
            messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
          }),
        ),
        10_000,
        "mid-stream-abort-partial",
      ),
    )
    expect(out.reason).toBe("aborted")
    expect(buffer.peek()?.userText).toBe("go")
    expect(buffer.peek()?.partialAssistantText).toBe("partial...")
  })

  test("abort AFTER one productive tool turn → aborted, turns 1 (corrected C11)", async () => {
    // Turn 1 is a real tool turn (productive → counts). Then abort before the
    // second turn streams: the `runTurn`-top guard returns `{kind:"aborted"}`
    // and the loop reports `turn - 1` with turn=2 → turns 1. The C11 fix makes
    // `AgentOutcome.turns` count exactly the productive turns completed (no
    // inflation from the aborted-before-work second turn).
    const ac = new AbortController()
    let call = 0
    const llm: LLMPort = {
      async *stream(_i: StreamInput): AsyncIterable<StreamEvent> {
        call += 1
        if (call === 1) {
          // Turn 1: a complete, productive tool turn (NOT aborted) — it
          // dispatches a tool, the loop appends the result and bumps the
          // recorder. This is the one turn that legitimately counts.
          for (const evn of toolUseScript("c1", "read", { path: "/tmp/__abort_probe__" })) {
            yield evn
          }
          return
        }
        // Turn 2: abort the instant the second stream is entered, before any
        // event is produced. `streamingTurn`'s cooperative check returns
        // `{kind:"aborted"}` → `runTurn` aborted → `finish("aborted", turn-1)`
        // with turn=2 → turns 1 (exactly the productive turns completed). The
        // pre-C11 code bumped the recorder at turn-top, so the metric said 2
        // while AgentOutcome.turns said 1 — the off-by-one this closes.
        ac.abort()
        for (const evn of textScript("unreached")) yield evn
      },
    }
    const out = await noUnhandledRejection(() =>
      withTimeout(runAgent(cfg({ llm, signal: ac.signal })), 10_000, "post-productive-abort"),
    )
    expect(out.reason).toBe("aborted")
    expect(out.turns).toBe(1)
    // The productive turn's assistant tool_use turn IS in the transcript.
    const toolUses = out.messages.filter(
      (m) => m.role === "assistant" && m.content.some((b) => b.type === "tool_use"),
    ).length
    expect(toolUses).toBe(1)
    // The second-turn `ac.abort()` flipped the signal observably.
    expect(ac.signal.aborted).toBe(true)
  })

  test("aborted run still emits the session_start head marker and a done event", async () => {
    const ac = new AbortController()
    ac.abort()
    const stream = new RecordingStream()
    const llm = neverCalledLLM("abort-emits-markers")
    const out = await noUnhandledRejection(() =>
      withTimeout(runAgent(cfg({ llm, stream, signal: ac.signal })), 10_000, "abort-emits-markers"),
    )
    expect(out.reason).toBe("aborted")
    expect(stream.events[0]?.type).toBe("session_start")
    const done = stream.events.find((e) => e.type === "done")
    expect(done?.type).toBe("done")
    if (done?.type === "done") expect(done.reason).toBe("aborted")
  })
})
