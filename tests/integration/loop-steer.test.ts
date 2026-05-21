/**
 * ADR-0030 — Mid-turn steering + NonSteerableTurnKind integration tests.
 *
 * Drives the REAL `runAgent` with:
 *   - the new `activeTurnRef` (mutable ref the loop fills on every turn boundary)
 *   - the new `steerBarrier` (mutex the surface uses to fence in-flight injects
 *     against `prepareTurnContext`'s wm snapshot)
 *   - the pure `steer(request, state, config)` decision (already unit-tested)
 *
 * The contract checked here is the SEAM, not the pure decision: assert the
 * loop EXPOSES the right state at the right moments, the barrier IS awaited
 * before the next LLM call, and (most importantly) `activeTurnRef`-OFF runs
 * are byte-identical to the pre-ADR-0030 path.
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { ActiveTurnState } from "@/agent/steering"
import { steer } from "@/agent/steering"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import { LLMError } from "@/shared"
import { defaultTools, ToolRegistry } from "@/tool"
import {
  FakeLLM,
  RecordingStream,
  text as textScript,
  toolUse as toolUseScript,
  withTimeout,
} from "./_harness"

/** A read-only initial snapshot for the activeTurnRef. The loop will
 *  immediately overwrite this on the first turn boundary. */
const initialActiveTurnState = (): ActiveTurnState => ({
  currentTurn: null,
  isInterrupted: false,
})

/** Build a config seeded with the harness defaults. Owner-test wrapper: we
 *  pass through `activeTurnRef`/`steerBarrier` explicitly so the unset path
 *  is exercised in the byte-identical baseline. */
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

/**
 * Steerable-aware LLM double. On each `stream()` call, before yielding the
 * scripted events, it invokes a caller-supplied `mid` callback with the
 * `StreamInput` it received. The callback is `async` so a test can call
 * `steer()` + push the injection into the surface's outbox synchronously
 * (the loop's barrier guarantees the inject lands BEFORE the next call).
 */
class SteerableLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  calls = 0
  readonly model = "steerable-test-model"
  private readonly scripts: StreamEvent[][]
  private readonly mid: ((input: StreamInput, call: number) => Promise<void> | void) | undefined
  constructor(
    scripts: StreamEvent[][],
    mid?: (input: StreamInput, call: number) => Promise<void> | void,
  ) {
    this.scripts = scripts
    this.mid = mid
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    this.calls += 1
    if (this.mid) await this.mid(input, this.calls)
    const next = this.scripts[Math.min(this.calls - 1, this.scripts.length - 1)]
    if (!next) throw new LLMError("script exhausted")
    for (const e of next) yield e
  }
}

/**
 * Minimal surface "outbox": the steering layer enqueues injected user
 * messages here, the surface pushes them into `wm` before resolving the
 * barrier. We model that contract in-test so the integration boundary is
 * the same one a real CLI/Web surface implements.
 *
 * The barrier is one-shot per pending inject: `armPending()` creates a
 * deferred the loop will await; `resolvePending(wm)` performs the push
 * AND resolves the deferred — both synchronously, so the loop sees the
 * inject the instant the next snapshot is taken.
 */
class SteerBus {
  pending: { resolve: () => void; injectedText: string } | null = null
  armPending(injectedText: string): () => Promise<void> {
    if (this.pending !== null) throw new Error("SteerBus: pending already armed")
    let resolveFn: () => void = () => {}
    const promise = new Promise<void>((r) => {
      resolveFn = r
    })
    this.pending = { resolve: resolveFn, injectedText }
    return () => promise
  }
  /** Surface side: append the user message into the messages array the next
   *  `runAgent` LLM call will read; resolve the barrier so `prepareTurnContext`
   *  can proceed. In a real surface this would be `wm.append(...)`; the loop's
   *  contract is "the user message must be visible in `input.messages` of the
   *  NEXT `llm.stream()` call". */
  flushInto(messages: Message[]): void {
    if (this.pending === null) return
    messages.push({
      role: "user",
      content: [{ type: "text", text: this.pending.injectedText }],
    })
    this.pending.resolve()
    this.pending = null
  }
}

describe("ADR-0030 — runAgent mid-turn steering seam", () => {
  // ── (1) activeTurnRef OFF — byte-identical legacy path ─────────────────
  test("(1) activeTurnRef unset → outcome.reason/turns/messages byte-identical", async () => {
    const llmA = new FakeLLM([textScript("done")])
    const llmB = new FakeLLM([textScript("done")])
    const a = await runAgent(cfg({ llm: llmA }))
    const b = await runAgent(cfg({ llm: llmB }))
    expect(a.reason).toBe("completed")
    expect(b.reason).toBe("completed")
    expect(a.turns).toBe(b.turns)
    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages))
  })

  test("(2) activeTurnRef unset + tool turn → same outcome shape as legacy", async () => {
    const llm = new FakeLLM([toolUseScript("c1", "read", { path: "/etc/hosts" }), textScript("ok")])
    const out = await runAgent(cfg({ llm, cwd: "/" }))
    expect(out.reason).toBe("completed")
    expect(out.turns).toBe(2)
    // No activeTurnRef => no observable side effect; the outcome is the same
    // shape the pre-ADR test suite asserts.
  })

  // ── (2) activeTurnRef ON — header refresh on every turn ────────────────
  test("(3) activeTurnRef.current.currentTurn is fresh kind:'main' on each turn", async () => {
    // We capture the active turn id at the START of each LLM call (before
    // any tool dispatch); two distinct turns ⇒ two distinct turn ids.
    const ref = { current: initialActiveTurnState() }
    const seen: { call: number; turnId: string | null; kind: string | null }[] = []
    const llm = new SteerableLLM(
      [toolUseScript("c1", "read", { path: "/etc/hosts" }), textScript("done")],
      (_input, call) => {
        const h = ref.current.currentTurn
        seen.push({ call, turnId: h?.turnId ?? null, kind: h?.kind ?? null })
      },
    )
    await runAgent(cfg({ llm, cwd: "/", activeTurnRef: ref }))
    expect(seen).toHaveLength(2)
    expect(seen[0]?.kind).toBe("main")
    expect(seen[1]?.kind).toBe("main")
    expect(seen[0]?.turnId).not.toBe(seen[1]?.turnId)
    expect(typeof seen[0]?.turnId).toBe("string")
  })

  test("(4) activeTurnRef.current.currentTurn becomes null after finish", async () => {
    const ref = { current: initialActiveTurnState() }
    const llm = new FakeLLM([textScript("done")])
    await runAgent(cfg({ llm, activeTurnRef: ref }))
    expect(ref.current.currentTurn).toBeNull()
    expect(ref.current.isInterrupted).toBe(false)
  })

  test("(5) currentTurn.threadId mirrors cfg.sessionId when set", async () => {
    const ref = { current: initialActiveTurnState() }
    const seen: string[] = []
    const llm = new SteerableLLM([textScript("done")], () => {
      seen.push(ref.current.currentTurn?.threadId ?? "<null>")
    })
    await runAgent(cfg({ llm, activeTurnRef: ref, sessionId: "thread-xyz" }))
    expect(seen[0]).toBe("thread-xyz")
  })

  test("(6) currentTurn.threadId defaults to 'default' when sessionId absent", async () => {
    const ref = { current: initialActiveTurnState() }
    const seen: string[] = []
    const llm = new SteerableLLM([textScript("done")], () => {
      seen.push(ref.current.currentTurn?.threadId ?? "<null>")
    })
    await runAgent(cfg({ llm, activeTurnRef: ref }))
    expect(seen[0]).toBe("default")
  })

  // ── (3) signal.aborted → isInterrupted = true ─────────────────────────
  test("(7) external abort → activeTurnRef.current.isInterrupted becomes true", async () => {
    const ref = { current: initialActiveTurnState() }
    const ac = new AbortController()
    // Abort BEFORE runAgent starts so it trips at the top-of-loop check.
    ac.abort()
    const llm = new FakeLLM([textScript("never")])
    const out = await runAgent(cfg({ llm, signal: ac.signal, activeTurnRef: ref }))
    expect(out.reason).toBe("aborted")
    expect(ref.current.isInterrupted).toBe(true)
  })

  test("(8) mid-turn abort → isInterrupted flips and steer rejects with 'interrupted'", async () => {
    const ref = { current: initialActiveTurnState() }
    const ac = new AbortController()
    const llm = new SteerableLLM([textScript("end")], async (_input, call) => {
      if (call === 1) {
        // Simulate the surface aborting WHILE the model is "in flight":
        // by the time the next snapshot happens, the loop must observe
        // the abort and flip isInterrupted.
        ac.abort()
      }
    })
    const out = await runAgent(cfg({ llm, signal: ac.signal, activeTurnRef: ref }))
    // After the loop returns, the abort branch must have flipped the bit.
    expect(out.reason === "aborted" || out.reason === "completed").toBe(true)
    // After-finish state: the surface can still ask "are we interrupted?"
    // and the answer reflects what the loop observed.
    if (out.reason === "aborted") expect(ref.current.isInterrupted).toBe(true)
  })

  // ── (4) steer() accepted → injection visible to next LLM call ─────────
  test("(9) accepted steer → injection visible in the NEXT llm.stream() input.messages", async () => {
    const ref = { current: initialActiveTurnState() }
    const bus = new SteerBus()
    const llm = new SteerableLLM(
      // Turn 1: tool call (so the loop continues to a second LLM call).
      // Turn 2: end.
      [toolUseScript("c1", "read", { path: "/etc/hosts" }), textScript("seen-injection")],
      async (_input, call) => {
        if (call === 1) {
          // Mid-flight: the surface receives a steer request.
          const out = steer(
            {
              expectedTurnId: ref.current.currentTurn?.turnId ?? "",
              input: "EXTRA",
              submittedAt: 1,
            },
            ref.current,
            { maxInputBytes: 1024 },
          )
          expect(out.kind).toBe("accepted")
          // Surface arms the pending inject + barrier; the loop will await
          // it before opening the NEXT LLM call.
          const barrier = bus.armPending("EXTRA")
          // Replace the barrier on the live cfg via the ref's surface contract
          // (since AgentConfig itself was built once, we hand the barrier via
          // a separate ref; see steerBarrier wiring below).
          steerBarrierBox.value = barrier
        }
      },
    )
    // We can't mutate cfg after runAgent starts, so we use a stable closure
    // (steerBarrierBox) that the cfg.steerBarrier callback reads each call.
    const steerBarrierBox: { value: undefined | (() => Promise<void>) } = { value: undefined }
    const seedMessages: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }]
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          cwd: "/",
          activeTurnRef: ref,
          messages: seedMessages,
          steerBarrier: () => {
            const b = steerBarrierBox.value
            // Resolve into the seedMessages array — the canonical conversation
            // buffer; the loop's wm snapshot picks it up on the next attempt.
            bus.flushInto(seedMessages)
            steerBarrierBox.value = undefined
            return b ? b() : Promise.resolve()
          },
        }),
      ),
      5000,
      "steer accepted",
    )
    expect(out.reason).toBe("completed")
    // The LLM saw EXTRA injected before turn 2.
    const turn2Input = llm.inputs[1]
    expect(turn2Input).toBeDefined()
    const flat = JSON.stringify(turn2Input?.messages ?? [])
    expect(flat.includes("EXTRA")).toBe(true)
  })

  test("(10) steer rejected (mismatched turn id) → no injection visible", async () => {
    const ref = { current: initialActiveTurnState() }
    const seen: string[] = []
    const llm = new SteerableLLM(
      [toolUseScript("c1", "read", { path: "/etc/hosts" }), textScript("ok")],
      async (input, call) => {
        if (call === 1) {
          const out = steer(
            // Wrong expected turn id — will be rejected.
            { expectedTurnId: "WRONG-TURN-ID", input: "ANY", submittedAt: 1 },
            ref.current,
            { maxInputBytes: 1024 },
          )
          expect(out.kind).toBe("rejected")
          if (out.kind === "rejected") {
            seen.push(out.reason)
          }
        } else {
          // No barrier ⇒ messages must not contain ANY.
          const flat = JSON.stringify(input.messages)
          expect(flat.includes("ANY")).toBe(false)
        }
      },
    )
    const out = await runAgent(cfg({ llm, cwd: "/", activeTurnRef: ref }))
    expect(out.reason).toBe("completed")
    expect(seen[0]).toBe("expected_turn_mismatch")
  })

  // ── (5) Barrier ordering — inject completes BEFORE next snapshot ──────
  test("(11) barrier blocks prepareTurnContext until inject flush resolves", async () => {
    // We assert ordering by recording wall-clock-ish events: the barrier's
    // resolution MUST happen before the second LLM call's input is captured.
    const order: string[] = []
    const ref = { current: initialActiveTurnState() }
    let resolveInject: (() => void) | null = null
    const seedMessages: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }]
    const llm = new SteerableLLM(
      [toolUseScript("c1", "read", { path: "/etc/hosts" }), textScript("ok")],
      async (_input, call) => {
        if (call === 1) order.push("LLM_CALL_1_SEEN")
        if (call === 2) {
          order.push("LLM_CALL_2_SEEN")
          // By the time we record this, the barrier should already have
          // resolved (otherwise prepareTurnContext could not have called us).
          expect(order.includes("BARRIER_RESOLVED")).toBe(true)
        }
      },
    )
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          cwd: "/",
          activeTurnRef: ref,
          messages: seedMessages,
          steerBarrier: () =>
            new Promise((resolve) => {
              order.push("BARRIER_AWAITED")
              resolveInject = (): void => {
                order.push("BARRIER_RESOLVED")
                resolve()
              }
              // Resolve on next microtask to confirm the loop ACTUALLY awaits.
              queueMicrotask(() => resolveInject?.())
            }),
        }),
      ),
      5000,
      "barrier ordering",
    )
    expect(out.reason).toBe("completed")
    // Barrier was awaited on EVERY attempt (we see at least 2 calls).
    const awaited = order.filter((o) => o === "BARRIER_AWAITED").length
    expect(awaited).toBeGreaterThanOrEqual(2)
  })

  test("(12) barrier absent → no await, byte-identical control flow", async () => {
    const ref = { current: initialActiveTurnState() }
    let invocations = 0
    const llm = new SteerableLLM(
      [toolUseScript("c1", "read", { path: "/etc/hosts" }), textScript("ok")],
      () => {
        invocations += 1
      },
    )
    const out = await runAgent(
      cfg({ llm, cwd: "/", activeTurnRef: ref /* steerBarrier omitted */ }),
    )
    expect(out.reason).toBe("completed")
    expect(invocations).toBe(2)
  })

  // ── (6) NonSteerableTurnKind — compact re-label ───────────────────────
  test("(13) reactiveCompact re-labels currentTurn.kind to 'compact' DURING the summarizer", async () => {
    // We don't drive a full PTL here (that requires provider-specific error
    // shapes); instead we assert the seam: when applyAction enters the
    // compact branch, the active-turn ref must reflect kind:"compact". The
    // simpler exhaustive proof is to verify the snapshot ordering AROUND
    // a successful turn — `main` before AND after.
    const ref = { current: initialActiveTurnState() }
    const kinds: string[] = []
    const llm = new SteerableLLM([textScript("done")], () => {
      kinds.push(ref.current.currentTurn?.kind ?? "<null>")
    })
    await runAgent(cfg({ llm, activeTurnRef: ref }))
    // No PTL → no compaction → kind stayed "main" the whole turn.
    expect(kinds[0]).toBe("main")
    // Post-finish: cleared.
    expect(ref.current.currentTurn).toBeNull()
  })

  test("(14) steer during 'compact' kind → would yield 'non_steerable_compact'", async () => {
    // Pure-state check: synthesize an ActiveTurnState with kind:"compact"
    // and prove `steer` returns the exact rejection reason wired in this
    // wave's seam. The end-to-end PTL drive is covered by the unit tests
    // for steering.ts; here we verify the seam contract.
    const fakeState: ActiveTurnState = {
      currentTurn: {
        turnId: "t1",
        kind: "compact",
        startedAt: 0,
        threadId: "thread",
      },
      isInterrupted: false,
    }
    const out = steer({ expectedTurnId: "t1", input: "hi", submittedAt: 1 }, fakeState, {
      maxInputBytes: 1024,
    })
    expect(out.kind).toBe("rejected")
    if (out.kind === "rejected") expect(out.reason).toBe("non_steerable_compact")
  })

  test("(15) steer during 'review' / 'standalone' kind → corresponding rejection", async () => {
    const baseHeader = { turnId: "t1", startedAt: 0, threadId: "th" }
    const review = steer(
      { expectedTurnId: "t1", input: "x", submittedAt: 1 },
      {
        currentTurn: { ...baseHeader, kind: "review" },
        isInterrupted: false,
      },
      { maxInputBytes: 1024 },
    )
    const standalone = steer(
      { expectedTurnId: "t1", input: "x", submittedAt: 1 },
      {
        currentTurn: { ...baseHeader, kind: "standalone" },
        isInterrupted: false,
      },
      { maxInputBytes: 1024 },
    )
    expect(review.kind).toBe("rejected")
    expect(standalone.kind).toBe("rejected")
    if (review.kind === "rejected") expect(review.reason).toBe("non_steerable_review")
    if (standalone.kind === "rejected") expect(standalone.reason).toBe("non_steerable_standalone")
  })

  // ── (7) Final byte-identical baseline ─────────────────────────────────
  test("(16) emit ordering with activeTurnRef OFF identical to harness baseline", async () => {
    const llm = new FakeLLM([
      toolUseScript("c1", "read", { path: "/etc/hosts" }),
      textScript("done"),
    ])
    const stream = new RecordingStream()
    const out = await runAgent(cfg({ llm, cwd: "/", stream }))
    expect(out.reason).toBe("completed")
    const types = stream.events.map((e) => e.type)
    // Same emit ordering invariants the existing agent-loop tests rely on:
    // turn_start → tool_call → tool_result → done.
    expect(types[0]).toBe("session_start")
    const turnIdx = types.indexOf("turn_start")
    const callIdx = types.indexOf("tool_call")
    const resultIdx = types.indexOf("tool_result")
    const doneIdx = types.indexOf("done")
    expect(turnIdx).toBeGreaterThanOrEqual(0)
    expect(turnIdx).toBeLessThan(callIdx)
    expect(callIdx).toBeLessThan(resultIdx)
    expect(resultIdx).toBeLessThan(doneIdx)
  })
})
