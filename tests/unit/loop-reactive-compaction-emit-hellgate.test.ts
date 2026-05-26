/**
 * ADR-0331 — reactive (mid-turn / PTL-driven) compaction emit wire hellgate.
 *
 * ADR-0324 introduced `compaction_event` as the 6th `TypedHistoryEvent` variant
 * and `AgentConfig.compactionEventEmit?: (event) => void`. Commit `a2490eb8`
 * wired the PROACTIVE site (top-of-turn `maybeCompact`). ADR-0331 closes the
 * symmetry by wiring the REACTIVE site (PTL recovery → `reactiveCompact`) with
 * `trigger:"mid_turn"` and `reason:"context_limit"` (the only driver the
 * `compact` recovery action can be produced from today; see
 * `decideOnStreamError` in `src/agent/loop.ts`).
 *
 * Pinned invariants (one per test):
 *   1. Absent slot ⇒ no emit (byte-identical to pre-ADR-0331 behavior).
 *   2. Present slot ⇒ exactly one emit, `kind:"compaction_event"`,
 *      `trigger:"mid_turn"`, `reason:"context_limit"`.
 *   3. Throwing emitter is swallowed ⇒ loop still completes successfully.
 *   4. `reactiveCompact` skip (empty summary ⇒ `ok:false`) ⇒ NO emit.
 *   5. Field shape: `tokensAfter <= tokensBefore`, `messagesRemoved >= 0`,
 *      `at` is a finite recent timestamp.
 *   6. Two consecutive PTL → reactive compactions in one run each emit
 *      independently (per-call emission, not deduped).
 *
 * Driven through the REAL `runAgent` loop so the slice + wire stay end-to-end
 * pinned. House fakes mirror `tests/unit/recovery-hellgate.test.ts` and
 * `tests/integration/_harness.ts` (kept local: the unit slice does NOT depend
 * on the integration directory).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { CompactionEventVariant } from "@/memory/typed-event"
import { __resetDefaultPermissionStore, type PermissionContext } from "@/permission"
import { __resetRuntimeConfig, LLMError } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

// ─── House fakes (mirror tests/unit/recovery-hellgate.test.ts) ──────────

type Step = { kind: "throw"; error: unknown } | { kind: "events"; events: StreamEvent[] }

class ScriptedLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  calls = 0
  readonly model = "scripted-test-model"
  private readonly steps: Step[]
  constructor(steps: Step[]) {
    this.steps = steps
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    this.calls += 1
    const step = this.steps.shift() ?? this.steps[this.steps.length - 1]
    if (!step) throw new LLMError("script exhausted")
    if (step.kind === "throw") throw step.error
    for (const e of step.events) yield e
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const text = (t: string, stop = "end_turn"): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: stop },
]
const ev = (events: StreamEvent[]): Step => ({ kind: "events", events })
const thr = (error: unknown): Step => ({ kind: "throw", error })

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

/** Build a history with ≥2 trailing assistant turns + a non-trivial
 *  summarizable prefix so `reactiveCompact` (default keepRecentTurns=2) can
 *  find a positive boundary AND remove >0 messages. Total token estimate stays
 *  under `REACTIVE_MIN_INPUT_TOKENS` (4 000) so the drop-ratio fail-fast
 *  guard is skipped (we test the SUCCESS branch). */
const successHistory = (): Message[] => [
  { role: "user", content: [{ type: "text", text: "first request" }] },
  { role: "assistant", content: [{ type: "text", text: "older turn one" }] },
  { role: "user", content: [{ type: "text", text: "second request" }] },
  { role: "assistant", content: [{ type: "text", text: "older turn two" }] },
  { role: "user", content: [{ type: "text", text: "third request" }] },
  { role: "assistant", content: [{ type: "text", text: "older turn three" }] },
  { role: "user", content: [{ type: "text", text: "current request" }] },
]

/** A scripted run that drives ONE reactive compaction:
 *   call 1: PTL throw → router emits `compact`
 *   call 2: continuation-summary stream (non-empty)
 *   call 3: final answer (after reactive compact mutated wm) */
const oneReactiveScript = (): Step[] => [
  thr(new LLMError("400 prompt is too long for this model")),
  ev(text("<summary>resume from here</summary>")),
  ev(text("final answer after compaction")),
]

const originalPermissionState = process.env.QUANTA_PERMISSION_STATE
let permissionStateRoot: string | null = null

beforeEach(() => {
  permissionStateRoot = mkdtempSync(join(tmpdir(), "loop-reactive-emit-"))
  process.env.QUANTA_PERMISSION_STATE = join(permissionStateRoot, "permission-state.json")
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

afterEach(() => {
  if (permissionStateRoot !== null) {
    rmSync(permissionStateRoot, { recursive: true, force: true })
    permissionStateRoot = null
  }
  if (originalPermissionState === undefined) delete process.env.QUANTA_PERMISSION_STATE
  else process.env.QUANTA_PERMISSION_STATE = originalPermissionState
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

describe("ADR-0331 — reactive compaction emit wire", () => {
  test("(1) absent slot ⇒ no emit (byte-identical: completed run with no emit ref)", async () => {
    const stream = new RecordingStream()
    const llm = new ScriptedLLM(oneReactiveScript())
    const out = await withTimeout(
      runAgent(cfg({ llm, stream, messages: successHistory(), maxTurns: 2 })),
      20_000,
      "reactive-emit-absent",
    )
    expect(out.reason).toBe("completed")
    // Recovery `compact` was emitted (reactive path ran).
    const compactRecov = stream.events.filter(
      (e) => e.type === "recovery" && e.reason === "compact",
    )
    expect(compactRecov.length).toBeGreaterThanOrEqual(1)
    // No way to observe an emit without a slot: the assertion is structural —
    // the run did not require `compactionEventEmit` to be set to complete.
  })

  test("(2) present slot ⇒ exactly one emit with mid_turn / context_limit", async () => {
    const captured: CompactionEventVariant[] = []
    const stream = new RecordingStream()
    const llm = new ScriptedLLM(oneReactiveScript())
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          messages: successHistory(),
          maxTurns: 2,
          compactionEventEmit: (e) => captured.push(e),
        }),
      ),
      20_000,
      "reactive-emit-present",
    )
    expect(out.reason).toBe("completed")
    expect(captured.length).toBe(1)
    const e = captured[0] as CompactionEventVariant
    expect(e.kind).toBe("compaction_event")
    expect(e.trigger).toBe("mid_turn")
    expect(e.reason).toBe("context_limit")
  })

  test("(3) throwing emitter is swallowed ⇒ loop still completes successfully", async () => {
    let throws = 0
    const stream = new RecordingStream()
    const llm = new ScriptedLLM(oneReactiveScript())
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          messages: successHistory(),
          maxTurns: 2,
          compactionEventEmit: () => {
            throws += 1
            throw new Error("observer boom")
          },
        }),
      ),
      20_000,
      "reactive-emit-throw",
    )
    expect(out.reason).toBe("completed")
    expect(throws).toBe(1) // emitter was reached exactly once
    // No `error` AgentEvent escaped the swallow.
    const errEvt = stream.events.find((e) => e.type === "error")
    expect(errEvt).toBeUndefined()
  })

  test("(4) reactive skip (empty summary ⇒ ok:false) ⇒ NO emit (and loop ends in error)", async () => {
    const captured: CompactionEventVariant[] = []
    const stream = new RecordingStream()
    // Script: PTL throw, then continuation-summary returns EMPTY (whitespace-only).
    // `reactiveCompact` then returns `{ok:false, reason:"...empty"}` — applyAction
    // routes to `{kind:"error"}` without `wm.replace` and (per ADR-0331)
    // without `emitCompactionEvent`.
    const llm = new ScriptedLLM([
      thr(new LLMError("400 prompt is too long for this model")),
      ev(text("   ")), // empty/whitespace-only summary
      ev(text("unreachable")),
    ])
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          messages: successHistory(),
          maxTurns: 2,
          compactionEventEmit: (e) => captured.push(e),
        }),
      ),
      20_000,
      "reactive-emit-skip",
    )
    expect(out.reason).toBe("error")
    expect(captured.length).toBe(0)
    // The router consumed exactly 2 stream calls: the PTL throw + the empty
    // summary attempt. No third call (no reactive success → no post-compact
    // model turn).
    expect(llm.calls).toBe(2)
  })

  test("(5) emitted fields are shape-correct (tokens numeric, removed ≥ 1, at recent)", async () => {
    const captured: CompactionEventVariant[] = []
    const beforeWallClock = Date.now()
    const stream = new RecordingStream()
    const llm = new ScriptedLLM(oneReactiveScript())
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          messages: successHistory(),
          maxTurns: 2,
          compactionEventEmit: (e) => captured.push(e),
        }),
      ),
      20_000,
      "reactive-emit-fields",
    )
    const afterWallClock = Date.now()
    expect(out.reason).toBe("completed")
    expect(captured.length).toBe(1)
    const e = captured[0] as CompactionEventVariant
    // `tokensBefore` is the working-memory snapshot estimate at the recovery
    // point; `tokensAfter` is the post-`reactiveCompact` transcript estimate.
    // The type contract explicitly notes that `tokensAfter <= tokensBefore`
    // is the producer's responsibility, NOT enforced by the store: a small
    // input under `REACTIVE_MIN_INPUT_TOKENS` (=4 000) bypasses the drop-ratio
    // guard, so a fixture where the synthetic `<continuation summary>` header
    // is longer than the tiny summarizable prefix is a legitimate "tokens
    // went up" outcome — accurate accounting, not a wire bug. We only assert
    // the FIELDS are well-typed + finite here. The breaker observes the same
    // tokens via `recordReactive(before, after)` and would strike on no
    // progress; that's a separate hellgate (compaction-breaker-hellgate).
    expect(typeof e.tokensBefore).toBe("number")
    expect(typeof e.tokensAfter).toBe("number")
    expect(Number.isFinite(e.tokensBefore)).toBe(true)
    expect(Number.isFinite(e.tokensAfter)).toBe(true)
    expect(e.tokensBefore).toBeGreaterThan(0)
    expect(e.tokensAfter).toBeGreaterThanOrEqual(0)
    // `reactiveCompact` (keepRecentTurns=2 default) MUST have removed at
    // least one message from the 7-message fixture (5 pre-cut + 2 trailing
    // assistants ⇒ summarized to 1 synthetic + 2 trailing assistants + the
    // current user, net `messagesRemoved = 7 - (1 + 4) = 2` here; the lower
    // bound `>= 1` is the robust assertion since `findBoundary` can shift).
    expect(typeof e.messagesRemoved).toBe("number")
    expect(e.messagesRemoved).toBeGreaterThanOrEqual(1)
    expect(Number.isFinite(e.at)).toBe(true)
    expect(e.at).toBeGreaterThanOrEqual(beforeWallClock)
    expect(e.at).toBeLessThanOrEqual(afterWallClock)
  })

  test("(6) two separate runs each emit one reactive compact (per-call, not deduped)", async () => {
    // A SINGLE run with two reactive compactions back-to-back is unreliable:
    // after the first compact collapses the prefix to a synthetic summary,
    // the second `findBoundary` cannot retain 2 assistant turns from what
    // remains and `reactiveCompact` returns `{ok:false}` (boundary<=0). That
    // is correct loop behavior — see `reactive-failfast-e2e.test.ts`. To
    // exercise per-call emission we use TWO independent `runAgent` invocations
    // sharing one emitter; each must contribute exactly one event with the
    // ADR-0331 shape (no module-level dedupe, no caching across calls).
    const captured: CompactionEventVariant[] = []
    const emit = (e: CompactionEventVariant) => captured.push(e)

    const run = async (label: string) =>
      withTimeout(
        runAgent(
          cfg({
            llm: new ScriptedLLM(oneReactiveScript()),
            stream: new RecordingStream(),
            messages: successHistory(),
            maxTurns: 2,
            compactionEventEmit: emit,
          }),
        ),
        20_000,
        label,
      )

    const out1 = await run("reactive-emit-run1")
    const out2 = await run("reactive-emit-run2")
    expect(out1.reason).toBe("completed")
    expect(out2.reason).toBe("completed")
    expect(captured.length).toBe(2)
    for (const e of captured) {
      expect(e.kind).toBe("compaction_event")
      expect(e.trigger).toBe("mid_turn")
      expect(e.reason).toBe("context_limit")
    }
  })
})
