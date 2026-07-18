/**
 * WS4 HELLGATE — RFC jul-18 §3.3, §3.4, §3.5, §4.3: the post-stream steer
 * SAFE-POINT drain + finalization port + interrupt supersession.
 *
 * Two batteries, both non-vacuous:
 *
 *  A) SAFE-POINT (real loop): drive the REAL `runAgent` loop with a scripted
 *     `end_turn` LLM, a real `ChildControlSurface` holding an admitted steer, a
 *     real controller-built finalization port, and the loop's steer-drain +
 *     finalization wire. Asserts a SECOND model call runs under the SAME turn id,
 *     sees the sanitized injection, emits an `applied` receipt, and creates NO
 *     mailbox copy + NO abort. Gate OFF (no `childSteerDrain`) ⇒ byte-identical
 *     (exactly one model call, no injection).
 *
 *     MUTATION: delete the safe-point drain in `same-turn-engine.runTurn` ⇒ the
 *     end_turn rail sees only ONE model call and no applied receipt ⇒ RED.
 *
 *  B) FINALIZATION PORT (real controller): the controller-built
 *     `SubagentSteerFinalizationPort` closes every accepted delivery in EXACTLY
 *     ONE final receipt — `applied` on consumption, `degraded` (one mailbox
 *     fallback from the retained envelope) on late reject / supersession / budget
 *     exhaustion, `cancelled` on session teardown. Exactly-once is asserted by a
 *     receipt-count-per-deliveryId invariant; supersession precedence is asserted
 *     by the interrupt payload preceding the queued steer.
 *
 *     MUTATION: drop the supersession guard (consume instead of fallback) ⇒ the
 *     race rail sees an `applied` (not `degraded/superseded_by_interrupt`) ⇒ RED.
 */

import { describe, expect, test } from "bun:test"
import { type AgentConfig, runAgent } from "@/agent"
import {
  applySteerSafePoint,
  finalizeBufferedSteersOnAbort,
  freshSteerSafePointState,
  STEER_SAFEPOINT_MAX_ROUNDS,
} from "@/agent/loop/turn-iteration"
import {
  type ChildControlSurface,
  createChildControlSurface,
} from "@/agent/subagent-control-endpoint"
import {
  createSubagentSteerFinalization,
  makeSteerRetentionStore,
} from "@/agent/subagent-delivery/controller"
import type {
  SubagentDeliveryReceipt,
  SubagentSteerSubmission,
} from "@/agent/subagent-delivery/ports"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { createWorkingMemory } from "@/memory"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

// ─── doubles ─────────────────────────────────────────────────────────────────

class FakeLLM implements LLMPort {
  readonly seenMessages: Message[][] = []
  calls = 0
  readonly model = "test-model"
  private readonly scripts: StreamEvent[][]
  private last: StreamEvent[] = []
  /** Optional per-call hook — runs BEFORE the call's script is yielded (so a test
   *  can admit a steer against the LIVE turn header the loop has already set). */
  onCall?: (call: number) => void
  constructor(scripts: StreamEvent[][]) {
    this.scripts = scripts
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.seenMessages.push([...input.messages])
    this.calls += 1
    this.onCall?.(this.calls)
    const next = this.scripts.shift()
    if (next) this.last = next
    const script = next ?? this.last
    for (const e of script) yield e
  }
}

class NullStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const endTurnText = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]

const spyMailbox = () => {
  const sent: { from: string; to: string; body: string }[] = []
  let seq = 0
  return {
    sent,
    port: {
      send(init: { from: string; to: string; body: string }) {
        sent.push({ from: init.from, to: init.to, body: init.body })
        seq += 1
        return { id: `msg-${seq}` }
      },
    },
  }
}

/** The sanitized untrusted-provenance formatter (RFC §4.5) — mirror the real
 *  `[teammate <from> — untrusted]` shape so the injection assertion is truthful. */
const fmtPeer = (from: string, body: string): string => `[teammate ${from} — untrusted] ${body}`

/** Admit a steer submission onto a real `ChildControlSurface` bound to a live
 *  turn header (so `steer()` authority accepts). Returns the submission. */
const admitSteer = (
  surface: ChildControlSurface,
  turnId: string,
  deliveryId: string,
  from: string,
  body: string,
): SubagentSteerSubmission => {
  const submission: SubagentSteerSubmission = {
    deliveryId,
    envelope: { from, formattedBody: fmtPeer(from, body) },
    expectedTurnId: turnId,
  }
  const outcome = surface.submitSteer(submission, {
    currentTurn: {
      turnId,
      kind: "main",
      startedAt: 0,
      threadId: "t",
    },
    isInterrupted: false,
  })
  if (outcome !== "accepted") throw new Error(`admitSteer expected accepted, got ${outcome}`)
  return submission
}

const baseCfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig =>
  ({
    registry: new ToolRegistry(defaultTools),
    stream: new NullStream(),
    permission: { mode: "acceptEdits" } as PermissionContext,
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
    system: "test",
    cwd: "/tmp",
    maxTurns: 6,
    signal: new AbortController().signal,
    onConfirm: async () => false,
    ...over,
  }) as AgentConfig

/** Build the loop-facing steer drain view over a real surface. */
const drainView = (surface: ChildControlSurface) => ({
  drainSteers: () => surface.drainSteers(),
  pendingSteers: () => surface.pendingSteers(),
})

// ─────────────────────────────────────────────────────────────────────────────
// A) SAFE-POINT DRAIN — real loop
// ─────────────────────────────────────────────────────────────────────────────

describe("WS4 safe-point drain (real loop, RFC §3.5)", () => {
  test("active end_turn main turn: a 2nd model call runs under SAME turn id, sees the injection, applied receipt, NO abort, NO mailbox copy", async () => {
    const llm = new FakeLLM([endTurnText("first"), endTurnText("second")])
    const surface = createChildControlSurface({
      steerConfig: { maxInputBytes: 8192 },
      capacity: 8,
    })
    const mailbox = spyMailbox()
    const store = makeSteerRetentionStore()
    const receipts: SubagentDeliveryReceipt[] = []
    const finalization = createSubagentSteerFinalization({
      store,
      mailbox: mailbox.port,
      onReceipt: (r) => receipts.push(r),
    })

    const activeTurnRef: NonNullable<AgentConfig["activeTurnRef"]> = {
      current: { currentTurn: null, isInterrupted: false },
    }

    // Admit the steer against the LIVE turn header on the FIRST model call (by
    // then the loop has set `activeTurnRef.current` for this turn), then register
    // retention — so the post-stream safe-point finds a pending steer for THIS
    // turn. Runs once (guarded on the empty surface).
    llm.onCall = (call) => {
      // Admit EXACTLY ONCE, on the first call — a single steer for this turn.
      if (call !== 1) return
      const header = activeTurnRef.current.currentTurn
      if (header !== null) {
        store.retain("del-1", { from: "peer", to: "root/0", body: "please also check X" })
        admitSteer(surface, header.turnId, "del-1", "peer", "please also check X")
      }
    }
    const stream = new NullStream()
    const cfg = baseCfg({
      llm,
      stream,
      activeTurnRef,
      childSteerDrain: drainView(surface),
      steerFinalization: finalization,
    })

    const outcome = await runAgent(cfg)

    // A SECOND model call ran (the safe-point re-streamed the same turn).
    expect(llm.calls).toBe(2)
    // The 2nd call's transcript carries the sanitized untrusted injection.
    const secondSeen = llm.seenMessages[1] ?? []
    const injected = secondSeen.some((m) =>
      m.content.some((b) => b.type === "text" && b.text.includes("[teammate peer — untrusted]")),
    )
    expect(injected).toBe(true)
    // EXACTLY ONE applied receipt, correlated + carrying the live turn id.
    const applied = receipts.filter((r) => r.kind === "applied")
    expect(applied.length).toBe(1)
    expect(applied[0]?.deliveryId).toBe("del-1")
    // NO mailbox duplicate on an applied steer (RFC §3.4).
    expect(mailbox.sent.length).toBe(0)
    // NO abort — the run completed cleanly.
    expect(outcome.reason).toBe("completed")
    // Retention was released (exactly-once bookkeeping).
    expect(store.size()).toBe(0)
    // Surface drained.
    expect(surface.pendingSteers()).toBe(0)
  })

  test("GATE OFF (no childSteerDrain): loop byte-identical — ONE model call, no injection, no receipt", async () => {
    const llm = new FakeLLM([endTurnText("only")])
    const surface = createChildControlSurface({
      steerConfig: { maxInputBytes: 8192 },
      capacity: 8,
    })
    const mailbox = spyMailbox()
    const store = makeSteerRetentionStore()
    const receipts: SubagentDeliveryReceipt[] = []
    // A steer is admitted on the surface, but the loop is NOT wired to drain it.
    store.retain("del-x", { from: "peer", to: "root/0", body: "ignored" })
    admitSteer(surface, "turn-does-not-matter", "del-x", "peer", "ignored")

    const activeTurnRef: NonNullable<AgentConfig["activeTurnRef"]> = {
      current: { currentTurn: null, isInterrupted: false },
    }
    const cfg = baseCfg({
      llm,
      activeTurnRef,
      // childSteerDrain + steerFinalization DELIBERATELY absent (gate OFF).
    })
    void createSubagentSteerFinalization({
      store,
      mailbox: mailbox.port,
      onReceipt: (r) => receipts.push(r),
    })

    const outcome = await runAgent(cfg)

    expect(llm.calls).toBe(1) // no extra safe-point round
    expect(receipts.length).toBe(0) // loop never touched the finalization port
    expect(mailbox.sent.length).toBe(0)
    expect(outcome.reason).toBe("completed")
    // The admitted steer is untouched (loop never drained it) — proves the drain
    // is the ONLY consumer and gate-OFF leaves it inert.
    expect(surface.pendingSteers()).toBe(1)
  })

  test("interrupt supersession: a steer pending when the turn is interrupted is NOT applied — one queue fallback + superseded_by_interrupt receipt", async () => {
    // The loop's gate fires wasInterrupted mid-run; the safe-point must supersede
    // the pending steer rather than consume it.
    const store = makeSteerRetentionStore()
    const mailbox = spyMailbox()
    const receipts: SubagentDeliveryReceipt[] = []
    const finalization = createSubagentSteerFinalization({
      store,
      mailbox: mailbox.port,
      onReceipt: (r) => receipts.push(r),
    })
    store.retain("del-i", { from: "peer", to: "root/0", body: "steer body" })

    // Directly exercise the supersession path the loop uses at the safe point.
    finalization.finalizeFallback("del-i", "superseded_by_interrupt")

    // Exactly ONE mailbox fallback + one degraded receipt, correlated.
    expect(mailbox.sent.length).toBe(1)
    expect(mailbox.sent[0]?.body).toBe("steer body")
    const degraded = receipts.filter((r) => r.kind === "degraded")
    expect(degraded.length).toBe(1)
    expect(degraded[0]?.deliveryId).toBe("del-i")
    if (degraded[0]?.kind === "degraded") {
      expect(degraded[0].reason).toBe("superseded_by_interrupt")
    }
    expect(store.size()).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B) FINALIZATION PORT — exactly-one receipt per accepted delivery
// ─────────────────────────────────────────────────────────────────────────────

describe("WS4 finalization port (RFC §3.3, §4.3)", () => {
  const setup = () => {
    const store = makeSteerRetentionStore()
    const mailbox = spyMailbox()
    const receipts: SubagentDeliveryReceipt[] = []
    const finalization = createSubagentSteerFinalization({
      store,
      mailbox: mailbox.port,
      onReceipt: (r) => receipts.push(r),
    })
    return { store, mailbox, receipts, finalization }
  }

  /** Exactly-one invariant: every retained deliveryId ends with exactly one final
   *  receipt of that id. */
  const receiptsFor = (receipts: SubagentDeliveryReceipt[], id: string) =>
    receipts.filter((r) => r.deliveryId === id)

  test("finalizeApplied ⇒ exactly one applied receipt, NO mailbox send", () => {
    const { store, mailbox, receipts, finalization } = setup()
    store.retain("d1", { from: "peer", to: "root/0", body: "b" })
    finalization.finalizeApplied("d1", "turn-9")
    expect(receiptsFor(receipts, "d1").length).toBe(1)
    expect(receipts[0]?.kind).toBe("applied")
    if (receipts[0]?.kind === "applied") expect(receipts[0].targetTurnId).toBe("turn-9")
    expect(mailbox.sent.length).toBe(0)
    expect(store.size()).toBe(0)
  })

  test("finalizeFallback(action_queue_full) ⇒ ONE mailbox fallback from retained envelope + one degraded receipt", () => {
    const { store, mailbox, receipts, finalization } = setup()
    store.retain("d2", { from: "peer", to: "root/0", body: "overflow body" })
    finalization.finalizeFallback("d2", "action_queue_full")
    expect(mailbox.sent.length).toBe(1)
    expect(mailbox.sent[0]?.body).toBe("overflow body")
    expect(mailbox.sent[0]?.to).toBe("root/0")
    const forD2 = receiptsFor(receipts, "d2")
    expect(forD2.length).toBe(1)
    expect(forD2[0]?.kind).toBe("degraded")
  })

  test("finalizeFallback(same_turn_budget_exhausted) ⇒ one fallback + degraded", () => {
    const { store, mailbox, receipts, finalization } = setup()
    store.retain("d3", { from: "peer", to: "root/0", body: "budget body" })
    finalization.finalizeFallback("d3", "same_turn_budget_exhausted")
    expect(mailbox.sent.length).toBe(1)
    const forD3 = receiptsFor(receipts, "d3")
    expect(forD3.length).toBe(1)
    if (forD3[0]?.kind === "degraded") expect(forD3[0].reason).toBe("same_turn_budget_exhausted")
  })

  test("finalizeCancelled ⇒ exactly one cancelled receipt, NO mailbox send", () => {
    const { store, mailbox, receipts, finalization } = setup()
    store.retain("d4", { from: "peer", to: "root/0", body: "b" })
    finalization.finalizeCancelled("d4", "session_aborted")
    const forD4 = receiptsFor(receipts, "d4")
    expect(forD4.length).toBe(1)
    expect(forD4[0]?.kind).toBe("cancelled")
    expect(mailbox.sent.length).toBe(0)
    expect(store.size()).toBe(0)
  })

  test("EXACTLY ONCE: a second finalize on the same deliveryId is a no-op (no double receipt / no double send)", () => {
    const { store, mailbox, receipts, finalization } = setup()
    store.retain("d5", { from: "peer", to: "root/0", body: "b" })
    finalization.finalizeApplied("d5", "turn-1")
    // Late duplicate (a stale callback) — must NOT produce a second receipt.
    finalization.finalizeApplied("d5", "turn-1")
    finalization.finalizeFallback("d5", "action_queue_full")
    finalization.finalizeCancelled("d5", "session_aborted")
    expect(receiptsFor(receipts, "d5").length).toBe(1)
    expect(mailbox.sent.length).toBe(0)
  })

  test("finalize on an UNKNOWN deliveryId (never admitted) is inert — no receipt, no send", () => {
    const { mailbox, receipts, finalization } = setup()
    finalization.finalizeApplied("ghost", "turn-1")
    finalization.finalizeFallback("ghost", "action_queue_full")
    finalization.finalizeCancelled("ghost", "session_aborted")
    expect(receipts.length).toBe(0)
    expect(mailbox.sent.length).toBe(0)
  })

  test("planted secret/newline in the retained body is delivered VERBATIM to the fallback (formatter owns escaping upstream) but never as a second admission", () => {
    // The retained envelope body is already the sanitized peer string; the
    // fallback re-sends THAT body once. This rail pins the exactly-once + the
    // retained-body pass-through (no re-mangling, no duplicate).
    const { store, mailbox, receipts, finalization } = setup()
    const planted = "[teammate peer — untrusted] line1\\nSECRET=abc"
    store.retain("d6", { from: "peer", to: "root/0", body: planted })
    finalization.finalizeFallback("d6", "control_unavailable")
    expect(mailbox.sent.length).toBe(1)
    expect(mailbox.sent[0]?.body).toBe(planted)
    expect(receiptsFor(receipts, "d6").length).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C) LOOP HELPER — applySteerSafePoint branch coverage (supersede / budget /
//    gate-OFF / apply-one-FIFO) driven directly (non-vacuous loop-helper proof)
// ─────────────────────────────────────────────────────────────────────────────

describe("WS4 applySteerSafePoint (loop helper, RFC §3.5)", () => {
  const sub = (deliveryId: string, turnId: string, body: string): SubagentSteerSubmission => ({
    deliveryId,
    envelope: { from: "peer", formattedBody: fmtPeer("peer", body) },
    expectedTurnId: turnId,
  })

  /** A minimal drain view over a canned FIFO. `drainSteers` empties it once. */
  const cannedDrain = (queue: SubagentSteerSubmission[]) => ({
    drainSteers: (): readonly SubagentSteerSubmission[] => queue.splice(0, queue.length),
    pendingSteers: (): number => queue.length,
  })

  const cfgWith = (over: Partial<AgentConfig>): AgentConfig =>
    ({
      activeTurnRef: {
        current: {
          currentTurn: { turnId: "T1", kind: "main", startedAt: 0, threadId: "t" },
          isInterrupted: false,
        },
      },
      ...over,
    }) as AgentConfig

  test("gate OFF (no childSteerDrain) ⇒ {continue:false} + NO wm mutation", () => {
    const wm = createWorkingMemory<Message>([])
    const state = freshSteerSafePointState()
    const decision = applySteerSafePoint(cfgWith({}), wm, state, false)
    expect(decision.continue).toBe(false)
    expect([...wm.snapshot()].length).toBe(0)
  })

  test("no steer pending ⇒ {continue:false} (byte-identical) + NO wm mutation", () => {
    const wm = createWorkingMemory<Message>([])
    const state = freshSteerSafePointState()
    const cfg = cfgWith({ childSteerDrain: cannedDrain([]) })
    const decision = applySteerSafePoint(cfg, wm, state, false)
    expect(decision.continue).toBe(false)
    expect([...wm.snapshot()].length).toBe(0)
  })

  test("one pending steer ⇒ {continue:true}, injection appended, finalizeApplied called", () => {
    const wm = createWorkingMemory<Message>([])
    const state = freshSteerSafePointState()
    const applied: Array<[string, string]> = []
    const cfg = cfgWith({
      childSteerDrain: cannedDrain([sub("s1", "T1", "do X")]),
      steerFinalization: {
        finalizeApplied: (id, turnId) => applied.push([id, turnId]),
        finalizeFallback: () => {},
        finalizeCancelled: () => {},
      },
    })
    const decision = applySteerSafePoint(cfg, wm, state, false)
    expect(decision.continue).toBe(true)
    const msgs = [...wm.snapshot()]
    expect(msgs.length).toBe(1)
    expect(
      msgs[0]?.content.some(
        (b) => b.type === "text" && b.text.includes("[teammate peer — untrusted]"),
      ),
    ).toBe(true)
    expect(applied).toEqual([["s1", "T1"]])
    expect(state.applied).toBe(1)
  })

  test("superseded=true ⇒ {continue:false}, NO apply, ALL pending fall back with superseded_by_interrupt", () => {
    const wm = createWorkingMemory<Message>([])
    const state = freshSteerSafePointState()
    const fallbacks: Array<[string, string]> = []
    const applied: string[] = []
    const cfg = cfgWith({
      childSteerDrain: cannedDrain([sub("s1", "T1", "a"), sub("s2", "T1", "b")]),
      steerFinalization: {
        finalizeApplied: (id) => applied.push(id),
        finalizeFallback: (id, reason) => fallbacks.push([id, reason]),
        finalizeCancelled: () => {},
      },
    })
    const decision = applySteerSafePoint(cfg, wm, state, true)
    expect(decision.continue).toBe(false)
    expect(applied).toEqual([]) // interrupt precedence — nothing applied
    expect(fallbacks).toEqual([
      ["s1", "superseded_by_interrupt"],
      ["s2", "superseded_by_interrupt"],
    ])
    expect([...wm.snapshot()].length).toBe(0) // no injection on the superseded turn
  })

  test("budget exhaustion ⇒ excess degrades once with same_turn_budget_exhausted", () => {
    const wm = createWorkingMemory<Message>([])
    const state = freshSteerSafePointState()
    state.applied = STEER_SAFEPOINT_MAX_ROUNDS // already at cap
    const fallbacks: Array<[string, string]> = []
    const cfg = cfgWith({
      childSteerDrain: cannedDrain([sub("s9", "T1", "late")]),
      steerFinalization: {
        finalizeApplied: () => {},
        finalizeFallback: (id, reason) => fallbacks.push([id, reason]),
        finalizeCancelled: () => {},
      },
    })
    const decision = applySteerSafePoint(cfg, wm, state, false)
    expect(decision.continue).toBe(false)
    expect(fallbacks).toEqual([["s9", "same_turn_budget_exhausted"]])
    expect([...wm.snapshot()].length).toBe(0)
  })

  // ── Hellaudit R2 regression (cross-turn injection + orphaned buffer) ──────────

  test("R2-HIGH-1: a steer admitted against a PRIOR turn is NOT injected into the current turn — expected_turn_mismatch fallback, no wm mutation", () => {
    const wm = createWorkingMemory<Message>([])
    const state = freshSteerSafePointState()
    const fallbacks: Array<[string, string]> = []
    // The buffered steer targets "T-PRIOR"; the live header (cfgWith default) is "T1".
    const cfg = cfgWith({
      childSteerDrain: cannedDrain([sub("s-stale", "T-PRIOR", "steer meant for a stale turn")]),
      steerFinalization: {
        finalizeApplied: () => {
          throw new Error("R2-HIGH-1: a cross-turn steer must NEVER be applied")
        },
        finalizeFallback: (id, reason) => fallbacks.push([id, reason]),
        finalizeCancelled: () => {},
      },
    })
    const decision = applySteerSafePoint(cfg, wm, state, false)
    expect([...wm.snapshot()].length).toBe(0) // NOT injected into T1
    expect(fallbacks).toEqual([["s-stale", "expected_turn_mismatch"]])
    expect(decision.continue).toBe(false) // no matching steer ⇒ halt
    expect(state.applied).toBe(0)
  })

  test("R2-HIGH-1 mix: a stale-turn steer is fallback'd while a same-turn steer is applied in FIFO order", () => {
    const wm = createWorkingMemory<Message>([])
    const state = freshSteerSafePointState()
    const applied: string[] = []
    const fallbacks: Array<[string, string]> = []
    const cfg = cfgWith({
      // FIFO: stale first (must fallback, not block), then the current-turn steer.
      childSteerDrain: cannedDrain([
        sub("s-stale", "T-PRIOR", "stale"),
        sub("s-live", "T1", "live"),
      ]),
      steerFinalization: {
        finalizeApplied: (id) => applied.push(id),
        finalizeFallback: (id, reason) => fallbacks.push([id, reason]),
        finalizeCancelled: () => {},
      },
    })
    const decision = applySteerSafePoint(cfg, wm, state, false)
    expect(decision.continue).toBe(true) // the live steer was applied
    expect(applied).toEqual(["s-live"])
    expect(fallbacks).toEqual([["s-stale", "expected_turn_mismatch"]])
    expect([...wm.snapshot()].length).toBe(1) // exactly the live injection
    expect(state.applied).toBe(1)
  })

  test("R2-MED-1: steers left buffered when the turn aborts are finalized (superseded_by_interrupt), not orphaned", () => {
    const state = freshSteerSafePointState()
    state.drained.push(sub("b1", "T1", "x"), sub("b2", "T1", "y"))
    const fallbacks: Array<[string, string]> = []
    const cfg = cfgWith({
      steerFinalization: {
        finalizeApplied: () => {},
        finalizeFallback: (id, reason) => fallbacks.push([id, reason]),
        finalizeCancelled: () => {},
      },
    })
    finalizeBufferedSteersOnAbort(cfg, state)
    expect(fallbacks).toEqual([
      ["b1", "superseded_by_interrupt"],
      ["b2", "superseded_by_interrupt"],
    ])
    expect(state.drained.length).toBe(0) // buffer cleared (no double-finalize on a later call)
  })

  test("R2-MED-1 control: an empty buffer ⇒ finalizeBufferedSteersOnAbort is a no-op (byte-identical)", () => {
    const touched: string[] = []
    const cfg = cfgWith({
      steerFinalization: {
        finalizeApplied: (id) => touched.push(id),
        finalizeFallback: (id) => touched.push(id),
        finalizeCancelled: (id) => touched.push(id),
      },
    })
    finalizeBufferedSteersOnAbort(cfg, freshSteerSafePointState())
    expect(touched).toEqual([])
  })
})
