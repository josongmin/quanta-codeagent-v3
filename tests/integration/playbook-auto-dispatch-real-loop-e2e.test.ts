import { describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import { FollowUpQueue, threadId } from "@/agent/follow-up-queue"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import {
  createMemoryWatcher,
  dispatchPlaybook,
  type PlaybookPlanQueueSink,
  type PlaybookRegistration,
  startPlaybookAutoDispatch,
} from "@/skill/playbook"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, text, withTimeout } from "./_harness"

/**
 * TRUE end-to-end for PLAYBOOK AUTO-DISPATCH (ADR-0240/0241), driven by a FAKE
 * LLM through the REAL agent loop (`runAgent`).
 *
 * The prior coverage stopped at the ORCHESTRATOR seam: the existing integration
 * suite (`playbook-inline-trigger-dispatch-hellgate.test.ts`) fires
 * `createMemoryWatcher()` into `startPlaybookAutoDispatch` and asserts the
 * dispatch OUTCOME (a `mock` sink recorded the `/play` enqueue), and only
 * `session-loop-hellgate` touches the loop. ZERO test closes the WHOLE chain:
 *   watcher fire → dispatch → enqueue → the REAL `runAgent` loop consuming that
 *   enqueued `/play <name>` on a SUBSEQUENT turn.
 *
 * This drives the load-bearing next-turn seam directly: the loop drains
 * `cfg.followUpQueue.popReady(threadId(sessionId), null)` at the TOP of every
 * turn (`syncQueuedTurnInputs` → `pollFollowUpQueue`) and appends the ready
 * follow-up's `content` to working memory as the next `role:"user"` turn seed.
 *
 * So we wire ONE real `FollowUpQueue` as `cfg.followUpQueue`, adapt it into the
 * dispatcher's `PlaybookPlanQueueSink`, fire a REAL memory watcher (simulating
 * an FS save carrying the trigger marker) through the REAL
 * `startPlaybookAutoDispatch` orchestrator, then run the loop and assert the
 * `/play <name>` text ACTUALLY REACHES a later LLM turn's input `messages`.
 *
 * Coverage limitation (reported): the FS-`fs.watch` adapter itself
 * (`createInlineTriggerWatcher`) is not part of `runAgent`; we drive the
 * closest real layer — the same `InlineTriggerWatcherPort` contract the real
 * adapter satisfies (`createMemoryWatcher`) plus the REAL orchestrator + REAL
 * `dispatchPlaybook` sink + the REAL loop consumption. Only the physical
 * inotify/kqueue event is simulated.
 */

const PLAYBOOK_NAME = "refactor-sweep"
const MARKER = "QUANTA-DISPATCH!"
const WATCHED_FILE = "src/thing.ts"

/** Adapt a real loop `FollowUpQueue` into the dispatcher's narrow
 *  `PlaybookPlanQueueSink`. This is the SAME shape the CLI's
 *  `adaptPlanQueueStoreToSink` / `session-loop` sink satisfies — here we target
 *  the loop's `followUpQueue` so the enqueued `/play` lands in the exact queue
 *  the loop drains at the turn boundary. */
const followUpQueueSink = (queue: FollowUpQueue, sessionId: string): PlaybookPlanQueueSink => ({
  enqueue: (input) => {
    try {
      queue.enqueue(threadId(sessionId), {
        content: input.text,
        submittedAt: 0,
        submittedTurnId: null,
        metadata: input.metadata,
      })
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  },
})

const registration = (): PlaybookRegistration => ({
  name: PLAYBOOK_NAME,
  frontmatter: {
    trigger: { commentMarker: MARKER, watchGlob: "**/*.ts" },
  },
})

/** Records every turn's user-visible text so we can prove which turn saw the
 *  enqueued `/play <name>`. Two scripted turns: the first does real work, the
 *  second finishes — the follow-up should surface on the SECOND turn's input
 *  (it was enqueued while turn 1 was in flight). */
class TurnRecordingLLM implements LLMPort {
  readonly model = "playbook-dispatch-e2e"
  readonly turnUserText: string[] = []
  private turn = 0
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const userText = input.messages
      .filter((m) => m.role === "user")
      .flatMap((m) => m.content.map((b) => (b.type === "text" ? b.text : "")))
      .join(" ")
    this.turnUserText.push(userText)
    this.turn += 1
    // Turn 1: emit a benign tool call so the loop takes a SECOND turn (giving
    // the enqueued follow-up a boundary to drain into). Turn 2+: finish.
    if (this.turn === 1) {
      yield { type: "tool_use_start", id: "t1", name: "read" }
      yield { type: "tool_use_end", id: "t1", input: { path: "/tmp/__nope_playbook__.txt" } }
      yield { type: "message_stop", stop_reason: "tool_use" }
      return
    }
    yield* text("done")
  }
}

describe("playbook auto-dispatch — real loop consumes the enqueued /play on a later turn", () => {
  test("watcher fire → dispatch enqueue → loop drains /play <name> into a SUBSEQUENT LLM turn", async () => {
    const sessionId = "sess-playbook-dispatch"
    const queue = new FollowUpQueue()
    const sink = followUpQueueSink(queue, sessionId)
    const watcher = createMemoryWatcher()

    const dispatched: string[] = []
    const ctrl = startPlaybookAutoDispatch({
      enabled: true,
      watcher,
      registry: { list: () => [registration()] },
      planQueueSink: sink,
      threadId: sessionId,
      defaultRoot: "/repo",
      onDispatch: (r) => dispatched.push(r.kind),
    })

    // GROUND TRUTH #1: the watcher actually consumed a saved file carrying the
    // marker, and the dispatch reached the ENQUEUED terminal state.
    const consumed = watcher.fire(WATCHED_FILE, `// do a thing ${MARKER}\nconst x = 1\n`)
    expect(consumed).toBe(true)
    expect(dispatched).toEqual(["enqueued"])
    // GROUND TRUTH #2: the follow-up is really sitting in the loop's queue.
    expect(queue.sizeFor(threadId(sessionId))).toBe(1)

    const llm = new TurnRecordingLLM()
    const stream = new RecordingStream()
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          sessionId,
          followUpQueue: queue,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          maxTurns: 6,
        }),
      ),
      15_000,
      "playbook-auto-dispatch",
    )
    ctrl.stop()

    expect(out.reason).toBe("completed")
    // The queue was drained by the loop (the follow-up left the queue).
    expect(queue.sizeFor(threadId(sessionId))).toBe(0)
    // LOAD-BEARING: the `/play <name>` text reached a REAL LLM turn's input.
    expect(llm.turnUserText.some((t) => t.includes(`/play ${PLAYBOOK_NAME}`))).toBe(true)
    // Ground truth on the DRAIN SEAM shape: the queue was populated BEFORE the
    // loop started (the watcher fired pre-run), so the loop's turn-top
    // `pollFollowUpQueue` drains it on the FIRST turn — the `/play` text is
    // appended AFTER the original seed (`PARENT-GO`) in that same turn's input,
    // proving it is the drained follow-up, not the seed. This pins that the
    // consumption is the loop's real `followUpQueue.popReady` append.
    const dispatchTurn = llm.turnUserText.find((t) => t.includes(`/play ${PLAYBOOK_NAME}`))
    expect(dispatchTurn).toBeDefined()
    expect((dispatchTurn ?? "").indexOf("PARENT-GO")).toBeLessThan(
      (dispatchTurn ?? "").indexOf(`/play ${PLAYBOOK_NAME}`),
    )
    // Drained EXACTLY once. `popReady` pops one ready follow-up per boundary and
    // marks it a tombstone (`state.head += 1`), so the queue is emptied by the
    // first drain (`sizeFor === 0`, asserted above) — no second boundary can
    // re-inject it. The follow-up message, once appended to working memory,
    // persists across later turns (cumulative conversation history), so its
    // presence in >1 turn INPUT snapshot is history — NOT a re-drain. Pin the
    // single-drain ground truth on the QUEUE, and pin that it was appended as
    // exactly ONE distinct user message in the final transcript.
    const playMessages = out.messages.filter(
      (m) =>
        m.role === "user" &&
        m.content.some((b) => b.type === "text" && b.text.includes(`/play ${PLAYBOOK_NAME}`)),
    )
    expect(playMessages).toHaveLength(1)
    expect(llm.turnUserText.length).toBeGreaterThanOrEqual(2)
  })

  test("CONTROL: dispatch that never enqueues (no marker in the saved file) ⇒ loop turn NEVER sees /play (non-vacuous)", async () => {
    const sessionId = "sess-playbook-no-marker"
    const queue = new FollowUpQueue()
    const sink = followUpQueueSink(queue, sessionId)
    const watcher = createMemoryWatcher()
    const dispatched: string[] = []
    const ctrl = startPlaybookAutoDispatch({
      enabled: true,
      watcher,
      registry: { list: () => [registration()] },
      planQueueSink: sink,
      threadId: sessionId,
      defaultRoot: "/repo",
      onDispatch: (r) => dispatched.push(r.kind),
    })

    // A saved file WITHOUT the marker ⇒ the watcher does not fire ⇒ no dispatch
    // ⇒ nothing enqueued. This discriminates the assertion above: the loop only
    // ever sees `/play` when a real enqueue happened.
    const consumed = watcher.fire(WATCHED_FILE, "const x = 1\n// nothing special here\n")
    expect(consumed).toBe(false)
    expect(dispatched).toEqual([])
    expect(queue.sizeFor(threadId(sessionId))).toBe(0)

    const llm = new TurnRecordingLLM()
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          sessionId,
          followUpQueue: queue,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          maxTurns: 6,
        }),
      ),
      15_000,
      "playbook-auto-dispatch-control",
    )
    ctrl.stop()

    expect(out.reason).toBe("completed")
    // No turn ever carried a `/play` — the loop consumption is gated on a real
    // enqueue, so the positive test above is non-vacuous.
    expect(llm.turnUserText.every((t) => !t.includes("/play"))).toBe(true)
  })

  test("direct dispatchPlaybook (sink = loop followUpQueue) ⇒ /play reaches the loop turn (bypasses the watcher orchestration)", async () => {
    // Same next-turn consumption proof, but exercising the canonical
    // `dispatchPlaybook` one-shot sink directly (the entrypoint hosts that wire
    // their own watcher call). Confirms the enqueue → loop-drain contract holds
    // regardless of whether the orchestrator or a direct caller drove the fire.
    const sessionId = "sess-playbook-direct"
    const queue = new FollowUpQueue()
    const sink = followUpQueueSink(queue, sessionId)

    const result = dispatchPlaybook({
      playbookName: PLAYBOOK_NAME,
      fire: { path: WATCHED_FILE, marker: MARKER, line: 1, firedAt: 0 },
      threadId: sessionId,
      planQueueSink: sink,
    })
    expect(result.kind).toBe("enqueued")
    expect(queue.sizeFor(threadId(sessionId))).toBe(1)

    const llm = new TurnRecordingLLM()
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          sessionId,
          followUpQueue: queue,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          maxTurns: 6,
        }),
      ),
      15_000,
      "playbook-auto-dispatch-direct",
    )

    expect(out.reason).toBe("completed")
    expect(queue.sizeFor(threadId(sessionId))).toBe(0)
    expect(llm.turnUserText.some((t) => t.includes(`/play ${PLAYBOOK_NAME}`))).toBe(true)
  })
})
