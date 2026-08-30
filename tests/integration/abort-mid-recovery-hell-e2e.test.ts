/**
 * ★ CONTRACT — AbortSignal yields a clean, prompt, no-orphan termination at the
 *   hardest moments: mid backoff-sleep (src/agent/recovery.ts + abort-aware
 *   sleep), mid HOL-barrier deferred drain (src/agent/streaming-dispatch.ts),
 *   and mid verify-guard forced turn (src/agent/verify-guard.ts, ADR-0067).
 *   Invariants: no deferred tool starts after abort; no retry/forced stream
 *   opens after abort; loop reports {reason:"aborted", turns:turn-1}
 *   (loop.ts:1557 turn-1 accounting); `withTimeout` proves no hang.
 *
 *   Each test labels its assertions: CONTRACT (clean-termination/no-orphan)
 *   vs CHARACTERIZATION (exact llm.calls / abort-moment timing).
 *
 * HELLGATE — abort at the NASTIEST in-loop moments, driving the REAL `runAgent`.
 *
 * `tests/integration/agent-abort.test.ts` already covers the COARSE abort
 * branches:
 *   - pre-loop abort (controller aborted before turn 1) → turns 0;
 *   - mid-STREAM abort (abort while the model stream is being consumed);
 *   - abort AFTER one productive tool turn (turn-top guard) → turns 1;
 *   - aborted run still emits session_start + done markers.
 *
 * What it does NOT cover — and what this suite ADDS — is abort landing INSIDE
 * the same-turn recovery machinery, where the loop is mid-flight between sub-
 * steps that are NOT a fresh turn boundary:
 *
 *   1. mid same-turn BACKOFF sleep (transient stream error → `decideOnStreamError`
 *      → `{do:"backoff"}` → abort-aware `sleep()` → retry). Abort must land in
 *      the sleep and short-circuit BEFORE the retry stream opens.
 *   2. mid HOL-BARRIER deferred drain (a streaming turn with [safe read, UNSAFE
 *      write, safe read]): the unsafe write engages the head-of-line barrier and
 *      aborts as it dispatches; NO deferred tool after it may start. Proven here
 *      through the FULL `runAgent` dispatch path (the unit hellgate proves it on
 *      the pure `streamingTurn` engine only).
 *   3. mid verify-guard FORCED turn (edit → only `git status` → the guard forces
 *      one extra turn): abort before the forced turn streams → clean aborted
 *      finish, the forced retry stream never opens.
 *   4. CONTROL: the SAME scripts WITHOUT abort complete normally — proving the
 *      abort (not script exhaustion) is what terminated cases 1–3.
 *
 * Every run is `withTimeout`-wrapped: a hang here is a REAL loop bug (an abort
 * that never propagates through a recovery sub-step), which is exactly the
 * failure mode this gate is built to catch.
 *
 * No production code is touched; this lives only under tests/integration/ and
 * reuses the shared `_harness.ts` doubles.
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { LLMError } from "@/shared"
import { defineTool, ToolRegistry } from "@/tool"
import {
  cfg,
  ev,
  multiToolUse,
  RecordingStream,
  ScriptedLLM,
  type Step,
  text,
  thr,
  toolUse,
  withTimeout,
} from "./_harness"

const HARD_MS = 10_000

const verifyGuardTurnScript = async function* (
  call: number,
  ac: AbortController,
): AsyncIterable<StreamEvent> {
  if (call === 1) {
    yield* toolUse("e1", "edit", {
      path: "/tmp/x",
      old_string: "a",
      new_string: "b",
    })
    return
  }
  if (call === 2) {
    yield* toolUse("b1", "bash", { command: "git status" })
    return
  }
  if (call === 3) {
    yield { type: "text_delta", delta: "done, the fix looks good" }
    ac.abort()
    yield { type: "message_stop", stop_reason: "end_turn" }
    return
  }
  throw new Error("FORCED VERIFY TURN STREAMED AFTER ABORT — leak")
}

/** A stub tool that records its name into a shared `dispatched[]` array the
 *  instant it executes, optionally awaits a tick so concurrency/ordering is
 *  observable, and runs an optional side effect (e.g. fire the abort). Read-only
 *  stubs are concurrency-safe; mutating stubs are NOT (so they engage the HOL
 *  barrier exactly like `write`). */
const stubTool = (opts: {
  name: string
  concurrencySafe: boolean
  dispatched: string[]
  onRun?: () => void
}) =>
  defineTool({
    name: opts.name,
    description: `stub ${opts.name}`,
    inputSchema: z.object({}).passthrough(),
    isReadOnly: () => opts.concurrencySafe,
    isConcurrencySafe: () => opts.concurrencySafe,
    async *execute() {
      opts.dispatched.push(opts.name)
      opts.onRun?.()
      // A real tick so an in-flight dispatch is observable while the drain /
      // stream keeps progressing — same trick the unit hellgate uses.
      await Promise.resolve()
      yield { type: "result", result: { ok: true, output: `out-${opts.name}` } }
    },
  })

/** Resolve once the controller actually aborts (so the test fires the abort
 *  AFTER the run is in-flight, not synchronously before runAgent starts). */
const _abortSoon = (ac: AbortController, ms = 0): void => {
  setTimeout(() => ac.abort(), ms)
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Abort during a SAME-TURN backoff sleep
// ─────────────────────────────────────────────────────────────────────────

describe("HELLGATE — abort mid same-turn backoff", () => {
  test("transient throw forces backoff; abort lands in the abort-aware sleep → fast aborted, no retry stream", async () => {
    const ac = new AbortController()
    // A retryable LLMError on the FIRST stream call → decideOnStreamError →
    // {do:"backoff"} → emitRecovery + abort-aware sleep(backoffDelayMs(0)).
    // backoffDelayMs(0) is full-jitter over [0, 500ms): non-zero with
    // overwhelming probability, so the abort fired right after start lands
    // DURING the sleep. After sleep resolves (early, on abort), the turn loop
    // re-enters its top guard `if (config.signal.aborted) return aborted`, so
    // the SECOND (retry) stream must NEVER open.
    let calls = 0
    const llm: LLMPort = {
      model: "backoff-stub",
      async *stream(_i: StreamInput): AsyncIterable<StreamEvent> {
        calls += 1
        if (calls === 1) {
          // Fire the abort as the first stream is entered, then throw a
          // transient error → the loop sleeps (abort-aware) then re-checks.
          ac.abort()
          throw new LLMError("503 service unavailable — temporarily overloaded")
        }
        // Any second call is the bug: the retry must be short-circuited by the
        // abort. Make it loud rather than silently passing.
        throw new Error("RETRY STREAM OPENED AFTER ABORT — backoff abort leaked")
        // unreachable yield keeps this a valid generator
        // biome-ignore lint/correctness/noUnreachable: intentional post-throw yield that pins the async-generator yield type.
        yield { type: "message_stop", stop_reason: "end_turn" }
      },
    }
    const out = await withTimeout(
      runAgent(cfg({ llm, signal: ac.signal, stream: new RecordingStream() })),
      HARD_MS,
      "abort-mid-backoff",
    )
    expect(out.reason).toBe("aborted")
    // Exactly one stream call: the throwing first attempt. No retry after abort.
    expect(calls).toBe(1)
    // No productive turn completed → turns 0.
    expect(out.turns).toBe(0)
    // The controller's signal IS aborted — the abort propagated all the way.
    expect(ac.signal.aborted).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 2. Abort mid HOL-barrier deferred drain (through the REAL runAgent dispatch)
// ─────────────────────────────────────────────────────────────────────────

describe("HELLGATE — abort mid HOL-barrier drain (real runAgent)", () => {
  test("[safe read, UNSAFE write, safe read]: write engages barrier + aborts → trailing deferred read never dispatches", async () => {
    const ac = new AbortController()
    const dispatched: string[] = []
    // safe_read overlaps in flight; unsafe_write is the first concurrency-UNSAFE
    // call → head-of-line barrier: it + every later call defer and run serially
    // after the stream closes. unsafe_write fires the abort as it dispatches, so
    // the drain loop's between-deferred signal check must stop tail_read.
    const safeRead = stubTool({ name: "safe_read", concurrencySafe: true, dispatched })
    const unsafeWrite = stubTool({
      name: "unsafe_write",
      concurrencySafe: false,
      dispatched,
      onRun: () => ac.abort(),
    })
    const tailRead = stubTool({ name: "tail_read", concurrencySafe: true, dispatched })
    const registry = new ToolRegistry([safeRead, unsafeWrite, tailRead])

    const llm = new ScriptedLLM([
      ev(
        multiToolUse([
          { id: "s1", name: "safe_read", input: {} },
          { id: "u1", name: "unsafe_write", input: {} }, // barrier — aborts on run
          { id: "d1", name: "tail_read", input: {} }, // deferred behind barrier
        ]),
      ),
      // If the loop wrongly continues to a second turn, this would run — but the
      // turn-top abort guard must fire first. Loud finish if reached.
      ev(text("SECOND TURN AFTER ABORT")),
    ])

    const out = await withTimeout(
      runAgent(cfg({ llm, registry, signal: ac.signal, stream: new RecordingStream() })),
      HARD_MS,
      "abort-mid-barrier",
    )
    expect(out.reason).toBe("aborted")
    // The unsafe barrier tool DID dispatch (it is the one that fired the abort).
    expect(dispatched).toContain("unsafe_write")
    // The deferred read AFTER the barrier must NOT have started once abort fired.
    expect(dispatched).not.toContain("tail_read")
    // Only one LLM stream call — no second turn after the aborted dispatch turn.
    expect(llm.calls).toBe(1)
    // Signal IS aborted — the barrier dispatch did flip the controller.
    expect(ac.signal.aborted).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 3. Abort during a verify-guard FORCED turn
// ─────────────────────────────────────────────────────────────────────────

describe("HELLGATE — abort mid verify-guard forced turn", () => {
  test("edit → only `git status` → finish attempt forces a verify turn → abort lands so the FORCED turn never streams → clean aborted, no orphan", async () => {
    const ac = new AbortController()
    const dispatched: string[] = []
    // `edit` is mutating (verify-guard MUTATING set). bash `git status` is NOT a
    // test-like command → does NOT count as verify. So when the model then tries
    // to finish (pure text), verifyGuardStep BLOCKS → CONTINUE (forced turn).
    // We fire the abort from INSIDE the finish-attempt stream (turn 3) so that:
    //   - turn 3 streams fully (the finish text is assembled),
    //   - applyAction → verifyGuardStep returns CONTINUE (forces another turn),
    //   - runTurn re-enters its top guard `if (signal.aborted) return aborted`,
    //     so the FORCED turn's stream must NEVER open.
    // We use the real default-tool NAMES so verify-guard's MUTATING / isVerify
    // policy keys on them, but back them with recording stubs so no real FS/shell
    // runs. (Registry maps by tool.name, so a stub named "edit" IS the edit tool
    // for this run.)
    const editTool = stubTool({ name: "edit", concurrencySafe: false, dispatched })
    const bashTool = defineTool({
      name: "bash",
      description: "stub bash",
      inputSchema: z.object({ command: z.string() }).passthrough(),
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      async *execute(input: { command: string }) {
        dispatched.push(`bash:${input.command}`)
        await Promise.resolve()
        yield { type: "result", result: { ok: true, output: "on branch main" } }
      },
    })
    const registry = new ToolRegistry([editTool, bashTool])

    let calls = 0
    const llm: LLMPort = {
      model: "verify-stub",
      async *stream(_i: StreamInput): AsyncIterable<StreamEvent> {
        calls += 1
        yield* verifyGuardTurnScript(calls, ac)
      },
    }

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          registry,
          signal: ac.signal,
          stream: new RecordingStream(),
          verifyGuard: { maxTrips: 1 },
        }),
      ),
      HARD_MS,
      "abort-mid-verify-forced-turn",
    )
    expect(out.reason).toBe("aborted")
    // edit + the noise bash dispatched; the guard forced a turn but the abort
    // short-circuited the forced retry stream before it opened.
    expect(dispatched).toContain("edit")
    expect(dispatched).toContain("bash:git status")
    // Exactly 3 streams: edit, git status, finish-attempt. The 4th (forced
    // verify) turn must NOT open.
    expect(calls).toBe(3)
    // The mid-finish-stream abort flipped the signal.
    expect(ac.signal.aborted).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 4. CONTROL — the SAME scripts WITHOUT abort complete normally
// ─────────────────────────────────────────────────────────────────────────

describe("HELLGATE — control: identical scripts WITHOUT signal flip complete normally", () => {
  test("backoff script (transient then success) completes — proves case 1 ended by the signal flip, not exhaustion", async () => {
    // Same transient-throw-then-retry shape as case 1, but NO abort: the loop
    // sleeps the backoff and the retry stream succeeds → normal completion.
    const steps: Step[] = [
      thr(new LLMError("503 service unavailable — temporarily overloaded")),
      ev(text("recovered and done")),
    ]
    const llm = new ScriptedLLM(steps)
    const out = await withTimeout(
      runAgent(cfg({ llm, stream: new RecordingStream() })),
      HARD_MS,
      "control-backoff",
    )
    expect(out.reason).toBe("completed")
    // First throw + the successful retry = 2 stream calls (the retry DID open
    // because nothing aborted it).
    expect(llm.calls).toBe(2)
  })

  test("barrier script ([safe, unsafe, safe]) under quiescent signal drains all three tools and completes", async () => {
    const dispatched: string[] = []
    const safeRead = stubTool({ name: "safe_read", concurrencySafe: true, dispatched })
    const unsafeWrite = stubTool({ name: "unsafe_write", concurrencySafe: false, dispatched })
    const tailRead = stubTool({ name: "tail_read", concurrencySafe: true, dispatched })
    const registry = new ToolRegistry([safeRead, unsafeWrite, tailRead])
    const llm = new ScriptedLLM([
      ev(
        multiToolUse([
          { id: "s1", name: "safe_read", input: {} },
          { id: "u1", name: "unsafe_write", input: {} },
          { id: "d1", name: "tail_read", input: {} },
        ]),
      ),
      ev(text("all tools done")),
    ])
    const out = await withTimeout(
      runAgent(cfg({ llm, registry, stream: new RecordingStream() })),
      HARD_MS,
      "control-barrier",
    )
    expect(out.reason).toBe("completed")
    // No abort → the deferred trailing read DID drain. All three ran.
    expect(dispatched).toContain("safe_read")
    expect(dispatched).toContain("unsafe_write")
    expect(dispatched).toContain("tail_read")
  })

  test("verify-guard script under quiescent signal: edit → git status → finish → guard forces ONE real verify turn → completes", async () => {
    const dispatched: string[] = []
    const editTool = stubTool({ name: "edit", concurrencySafe: false, dispatched })
    const bashTool = defineTool({
      name: "bash",
      description: "stub bash",
      inputSchema: z.object({ command: z.string() }).passthrough(),
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      async *execute(input: { command: string }) {
        dispatched.push(`bash:${input.command}`)
        await Promise.resolve()
        yield { type: "result", result: { ok: true, output: "ok" } }
      },
    })
    const registry = new ToolRegistry([editTool, bashTool])
    const llm = new ScriptedLLM([
      ev(toolUse("e1", "edit", { path: "/tmp/x", old_string: "a", new_string: "b" })),
      ev(toolUse("b1", "bash", { command: "git status" })), // noise, not verify
      ev(text("done")), // finish attempt → verify-guard FORCES a turn (no abort)
      // Forced turn: now run a real test command (counts as verify) so the NEXT
      // finish is allowed (maxTrips: 1 → guard fires once).
      ev(toolUse("b2", "bash", { command: "pytest -q" })),
      ev(text("verified, done")),
    ])
    const out = await withTimeout(
      runAgent(cfg({ llm, registry, stream: new RecordingStream(), verifyGuard: { maxTrips: 1 } })),
      HARD_MS,
      "control-verify-forced-turn",
    )
    expect(out.reason).toBe("completed")
    // The forced turn actually happened: the verifying `pytest` ran.
    expect(dispatched).toContain("bash:git status")
    expect(dispatched).toContain("bash:pytest -q")
  })
})
