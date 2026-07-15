import { describe, expect, test } from "bun:test"
import { ExternalPromptQueue } from "@/apps/cli/repl/external-prompt-queue"
import {
  createMemoryWatcher,
  dispatchPlaybook,
  type PlaybookPlanQueueSink,
  type PlaybookRegistration,
  startPlaybookAutoDispatch,
} from "@/skill/playbook"
import { withTimeout } from "./_harness"

/**
 * TRUE end-to-end for PLAYBOOK AUTO-DISPATCH (ADR-0240/0293), driven through
 * the REAL production sink — the CLI's `ExternalPromptQueue`.
 *
 * WHAT PRODUCTION ACTUALLY WIRES (verified against `session-loop.ts`):
 *   `attachPlaybookHandle()` (src/apps/cli/repl/session-loop.ts:543-566)
 *   builds the dispatcher's ONLY prod `PlaybookPlanQueueSink`:
 *
 *       const playbookSink = { enqueue: (input) => {
 *         externalPromptQueue.push(input.text); return { ok: true } } }
 *
 *   and hands it to `maybeStartPlaybookTriggerWire({ planQueueSink })`. The
 *   `externalPromptQueue` is a real `ExternalPromptQueue`; the REPL's outer
 *   turn loop drains it via `promptSource.next()` (session-loop.ts:840) —
 *   `push(text)` publishes and `next()` yields that exact text back.
 *
 * This test reconstructs THAT sink verbatim (push `input.text` into a REAL
 * `ExternalPromptQueue`) and drives the REAL dispatcher
 * (`startPlaybookAutoDispatch` + a real `createMemoryWatcher` fire, and the
 * one-shot `dispatchPlaybook`) so we prove the load-bearing production seam:
 * a marker save resolves to `/play <name>` text that ACTUALLY lands in the
 * `ExternalPromptQueue` the REPL consumes.
 *
 * SCOPE HONESTY (why not `runAgent`): `externalPromptQueue` is NOT touched by
 * `runAgent` (grep `externalPromptQueue` in src/agent/ = empty). It is the
 * OUTER REPL ingress, drained by the interactive branch's `promptSource.next()`
 * on a later REPL turn — that consumption cannot be driven without standing up
 * the whole REPL. So this test asserts ONLY what is real: the dispatch enqueues
 * `/play <name>` into the production `ExternalPromptQueue` sink, and the
 * production drain (`queue.next()`, the same call the REPL makes) yields it
 * back. It does NOT claim `runAgent`-loop consumption.
 *
 * NON-VACUITY: a control (no marker in the saved file ⇒ nothing enqueued ⇒ the
 * queue stays empty and `next()` never resolves), plus a red-on-injection
 * (neuter the sink so the push is dropped ⇒ the enqueue assertion goes RED).
 */

const PLAYBOOK_NAME = "refactor-sweep"
const MARKER = "QUANTA-DISPATCH!"
const WATCHED_FILE = "src/thing.ts"

/**
 * The REAL production sink, byte-for-byte from `session-loop.ts:545-556`:
 * the dispatcher's `/play <name>` follow-up text is pushed straight into the
 * REPL's `ExternalPromptQueue`. `input.text` is a `string`, and
 * `ExternalPromptQueue<CliPromptInput>` accepts a bare string (CliPromptInput
 * = `string | {text,...}`), so this is the exact prod shape — no adapter.
 */
const externalPromptQueueSink = (queue: ExternalPromptQueue): PlaybookPlanQueueSink => ({
  enqueue: (input) => {
    try {
      queue.push(input.text)
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

/** Drain the production queue the way the REPL does: `promptSource.next()`
 *  resolves the pushed prompt (or `null` on abort). We bound the wait so a
 *  non-enqueue (control) times out fast instead of hanging the suite. */
const drainNext = async (
  queue: ExternalPromptQueue,
  ms: number,
): Promise<string | null> => {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    const next = await queue.next(ctrl.signal)
    return typeof next === "string" ? next : (next?.text ?? null)
  } finally {
    clearTimeout(timer)
  }
}

describe("playbook auto-dispatch enqueues /play into the real ExternalPromptQueue sink", () => {
  test("watcher fire → dispatch → /play <name> lands in the production ExternalPromptQueue (drained via queue.next())", async () => {
    const queue = new ExternalPromptQueue()
    const sink = externalPromptQueueSink(queue)
    const watcher = createMemoryWatcher()

    const dispatched: string[] = []
    const ctrl = startPlaybookAutoDispatch({
      enabled: true,
      watcher,
      registry: { list: () => [registration()] },
      planQueueSink: sink,
      threadId: "sess-playbook-dispatch",
      defaultRoot: "/repo",
      onDispatch: (r) => dispatched.push(r.kind),
    })

    // GROUND TRUTH: the watcher actually consumed a saved file carrying the
    // marker, and the dispatch reached the ENQUEUED terminal state.
    const consumed = watcher.fire(WATCHED_FILE, `// do a thing ${MARKER}\nconst x = 1\n`)
    expect(consumed).toBe(true)
    expect(dispatched).toEqual(["enqueued"])

    // GROUND TRUTH on the SINK: the `/play <name>` text is really sitting in the
    // production queue (the REPL's turn-boundary `size()` gate would see it).
    expect(queue.size()).toBe(1)

    // LOAD-BEARING: the production drain (`queue.next()` — the exact call the
    // REPL interactive branch makes at session-loop.ts:840) yields the enqueued
    // `/play <name>` text back verbatim.
    const drained = await withTimeout(
      drainNext(queue, 5_000),
      10_000,
      "playbook-auto-dispatch-drain",
    )
    expect(drained).toBe(`/play ${PLAYBOOK_NAME}`)
    // The queue is emptied by that single drain — the REPL consumes it once.
    expect(queue.size()).toBe(0)

    ctrl.stop()
  })

  test("CONTROL: saved file WITHOUT the marker ⇒ no dispatch ⇒ nothing enqueued (non-vacuous)", async () => {
    const queue = new ExternalPromptQueue()
    const sink = externalPromptQueueSink(queue)
    const watcher = createMemoryWatcher()
    const dispatched: string[] = []
    const ctrl = startPlaybookAutoDispatch({
      enabled: true,
      watcher,
      registry: { list: () => [registration()] },
      planQueueSink: sink,
      threadId: "sess-playbook-no-marker",
      defaultRoot: "/repo",
      onDispatch: (r) => dispatched.push(r.kind),
    })

    // A saved file WITHOUT the marker ⇒ the watcher does not fire ⇒ no dispatch
    // ⇒ nothing enqueued. This discriminates the positive test above: the queue
    // only ever carries `/play` when a real marker-triggered enqueue happened.
    const consumed = watcher.fire(WATCHED_FILE, "const x = 1\n// nothing special here\n")
    expect(consumed).toBe(false)
    expect(dispatched).toEqual([])
    expect(queue.size()).toBe(0)

    // The production drain resolves `null` (abort) because nothing was ever
    // published — proving the enqueue is gated on a real marker fire.
    const drained = await withTimeout(
      drainNext(queue, 300),
      5_000,
      "playbook-auto-dispatch-control-drain",
    )
    expect(drained).toBe(null)

    ctrl.stop()
  })

  test("RED-ON-INJECTION: a neutered sink (push dropped) ⇒ /play NEVER reaches the queue", async () => {
    // Inject a broken production sink: same shape, but the enqueue does NOT
    // push into the queue (simulating the sink wire being severed). The
    // dispatcher still reports ok (the sink lies), but the load-bearing effect
    // — the `/play` text reaching the ExternalPromptQueue — is ABSENT. This is
    // the mutation that must make the positive test's core assertion RED.
    const queue = new ExternalPromptQueue()
    const neuteredSink: PlaybookPlanQueueSink = {
      enqueue: () => {
        // DROPPED — never `queue.push(input.text)`.
        return { ok: true }
      },
    }
    const watcher = createMemoryWatcher()
    const dispatched: string[] = []
    const ctrl = startPlaybookAutoDispatch({
      enabled: true,
      watcher,
      registry: { list: () => [registration()] },
      planQueueSink: neuteredSink,
      threadId: "sess-playbook-neuter",
      defaultRoot: "/repo",
      onDispatch: (r) => dispatched.push(r.kind),
    })

    const consumed = watcher.fire(WATCHED_FILE, `// go ${MARKER}\n`)
    expect(consumed).toBe(true)
    // The dispatcher STILL believes it enqueued (the sink returned ok) — proving
    // the positive test's `dispatched === ["enqueued"]` alone is insufficient;
    // only the REAL sink effect (below) distinguishes a working wire.
    expect(dispatched).toEqual(["enqueued"])
    // The load-bearing effect is ABSENT: nothing reached the real queue.
    expect(queue.size()).toBe(0)
    const drained = await withTimeout(
      drainNext(queue, 300),
      5_000,
      "playbook-auto-dispatch-neuter-drain",
    )
    expect(drained).toBe(null)

    ctrl.stop()
  })

  test("direct dispatchPlaybook (sink = real ExternalPromptQueue) ⇒ /play lands in the queue (bypasses the watcher orchestration)", async () => {
    // Same production-sink proof, but exercising the canonical `dispatchPlaybook`
    // one-shot directly (some hosts wire their own watcher call). Confirms the
    // enqueue → ExternalPromptQueue contract holds regardless of whether the
    // orchestrator or a direct caller drove the fire.
    const queue = new ExternalPromptQueue()
    const sink = externalPromptQueueSink(queue)

    const result = dispatchPlaybook({
      playbookName: PLAYBOOK_NAME,
      fire: { path: WATCHED_FILE, marker: MARKER, line: 1, firedAt: 0 },
      threadId: "sess-playbook-direct",
      planQueueSink: sink,
    })
    expect(result.kind).toBe("enqueued")
    expect(queue.size()).toBe(1)

    const drained = await withTimeout(
      drainNext(queue, 5_000),
      10_000,
      "playbook-auto-dispatch-direct-drain",
    )
    expect(drained).toBe(`/play ${PLAYBOOK_NAME}`)
    expect(queue.size()).toBe(0)
  })
})
