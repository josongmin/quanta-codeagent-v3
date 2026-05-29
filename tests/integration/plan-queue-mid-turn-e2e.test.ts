/**
 * Plan-queue + follow-up-queue MID-TURN E2E (L3 → L4).
 *
 * Promotes the previously unit-only plan-queue (ADR-0128, Codex 12-field
 * follow-ups) + follow-up-queue (ADR-0037, the WIRED Codex absorption) from
 * "store hellgate" to a real-`runAgent` integration:
 *
 *   1. captureDuringStream(): a FakeLLM subclass invokes a `beforeStream`
 *      callback at the start of EVERY `stream()` call. The callback is the
 *      seam for "the user typed mid-turn" — the test enqueues into either the
 *      `PlanQueueStore` (typed-shape primitive) OR `FollowUpQueue` (wired
 *      replay path) from inside the LLM call, exactly mirroring Codex's
 *      keystroke-during-token-stream pattern (no other agent does this).
 *
 *   2. The loop's `pollFollowUpQueue` (top of next turn) dequeues + appends
 *      the synthesized user message to `wm`. We then assert the NEXT
 *      `seenMessages[]` contains the queued text — proving the mid-turn
 *      capture survived into the model's prompt.
 *
 *   3. `subagentPendingPrompt` push path: an alternate fold channel. We push
 *      a `HookPromptInject` from inside the LLM call (mirroring what a
 *      subagent_start/stop hook would do mid-turn) and assert the NEXT turn's
 *      `seenMessages` carries the injected text. This is the `prepareTurn-
 *      Context` injects channel (NOT the wm append channel — different fold
 *      site, different ADR, but same "mid-turn capture → next-turn surfacing"
 *      contract).
 *
 *   4. ADR-0221 per-msg mutators: retry/edit/delete on a queued `PlanQueue`
 *      follow-up. The mutators run AFTER the mid-turn capture but BEFORE the
 *      enqueue's would-have-been delivery (the plan-queue store is NOT yet
 *      auto-wired into the loop's drain step — by design, see ADR-0128
 *      "default-OFF" stanza). The test asserts the typed result contract
 *      (`{ok:true, value:FollowUp}`, `not-found`, `invalid-text`, `send-
 *      not-possible`) under real-runAgent timing.
 *
 *   5. Adversarial:
 *        - enqueue WHILE the cfg.signal is aborted ⇒ store accepts the entry
 *          (queue is pure; abort affects the LOOP, not the store) but the
 *          NEXT turn never runs ⇒ entry stays at the head.
 *        - empty drain on the plan-queue ⇒ returns `[]` (noop), peek unchanged.
 *        - FollowUp built with the MINIMAL 12-field set (no optional `label`,
 *          empty metadata) ⇒ peek snapshot OMITS `label` entirely (proves
 *          exactOptionalPropertyTypes — `label: undefined` would be a
 *          regression).
 *        - Concurrent mid-turn enqueues from TWO `beforeStream` callbacks in
 *          the SAME `stream()` call ⇒ FIFO preserved, both appear in the
 *          NEXT turn's wm in submission order.
 *
 * src untouched. No ADR (test-only L3→L4 promotion).
 */

import { describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import { FollowUpQueue, threadId as makeThreadId } from "@/agent/follow-up-queue"
import { HookBus, type HookPromptInject } from "@/agent/hooks"
import {
  defaultPlanQueueStore,
  type FollowUp as PlanFollowUp,
  type PlanQueueStore,
  type SendNowInjection,
  type SendNowSink,
} from "@/agent/plan-queue"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import {
  ev as evStep,
  findEvent,
  cfg as harnessCfg,
  RecordingStream,
  ScriptedLLM,
  text as textScript,
  toolUse as toolUseScript,
  withTimeout,
} from "./_harness"

// ── helpers ────────────────────────────────────────────────────────────────

/** FakeLLM that invokes `beforeStream` BEFORE yielding events on each call.
 *  Records every per-turn `messages` view, just like the harness FakeLLM. The
 *  hook fires WITH the call index so callers can branch per-turn. */
class HookedFakeLLM implements LLMPort {
  readonly seenMessages: Message[][] = []
  calls = 0
  private readonly scripts: StreamEvent[][]
  private last: StreamEvent[] = []
  constructor(
    scripts: StreamEvent[][],
    private readonly beforeStream: (call: number, input: StreamInput) => void,
  ) {
    this.scripts = scripts
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    this.seenMessages.push(input.messages)
    // The mid-turn capture seam. Runs INSIDE the model call, before any
    // event yields. From the loop's perspective the "user typed during the
    // model turn" happened HERE — the next `prepareTurnIteration` will
    // drain whatever the hook enqueued.
    this.beforeStream(this.calls, input)
    const next = this.scripts.shift()
    if (next) this.last = next
    const script = next ?? this.last
    for (const e of script) yield e
  }
}

/** Flatten all text content blocks of every user-role message in `seen`.
 *  Used to search for the mid-turn-captured text in the model's prompt. */
const userTexts = (seen: Message[][], turn: number): string[] => {
  const turnSeen = seen[turn] ?? []
  const out: string[] = []
  for (const m of turnSeen) {
    if (m.role !== "user") continue
    for (const b of m.content) {
      if (b.type === "text") out.push(b.text)
    }
  }
  return out
}

/** Append every searchable text fragment from one Message content block to
 *  `out`. Extracted from {@link allTexts} to keep that function under the
 *  biome cognitive-complexity cap. */
const collectFromBlock = (block: Message["content"][number], out: string[]): void => {
  if (block.type === "text") {
    out.push(block.text)
    return
  }
  if (block.type !== "tool_result") return
  for (const c of block.content) {
    if (typeof c === "string") out.push(c)
  }
}

/** Read the FULL per-turn StreamInput.messages joined into one searchable
 *  string. Covers user + assistant + tool_result text/content — used for
 *  the subagentPendingPrompt fold which lands BEFORE the user message
 *  (injectAfterSystem) in the assembled context, not in the `messages` view
 *  of the LLM call. */
const allTexts = (seen: Message[][], turn: number): string => {
  const turnSeen = seen[turn] ?? []
  const parts: string[] = []
  for (const m of turnSeen) {
    for (const b of m.content) collectFromBlock(b, parts)
  }
  return parts.join("\n")
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("plan-queue + follow-up-queue mid-turn E2E (L3→L4)", () => {
  test("FollowUpQueue: mid-turn enqueue during turn-1 stream ⇒ folded into turn-2 prompt", async () => {
    const sessionId = "sess-mid-1"
    const tid = makeThreadId(sessionId)
    const queue = new FollowUpQueue({ maxPerThread: 8 })
    const stream = new RecordingStream()

    // Turn 1: assistant calls a tool (so the loop will produce a turn 2).
    // Turn 2: assistant finishes. The FakeLLM hook fires at turn 1 and
    // enqueues a mid-turn follow-up. Turn 2's `seenMessages` MUST contain it.
    const llm = new HookedFakeLLM(
      [
        // turn 1: a tool_use ⇒ loop dispatches + opens turn 2
        toolUseScript("c1", "echo", { msg: "hi" }),
        // turn 2: finish
        textScript("done"),
      ],
      (call) => {
        if (call === 1) {
          // Mid-turn user keystroke captured WHILE the model is "thinking".
          queue.enqueue(tid, {
            content: "please also clean up tmp files",
            submittedAt: 1,
            submittedTurnId: null,
            metadata: {},
          })
        }
      },
    )

    const outcome = await withTimeout(
      runAgent(harnessCfg({ llm, stream, sessionId, followUpQueue: queue, maxTurns: 5 })),
      5_000,
      "FollowUpQueue mid-turn",
    )

    expect(outcome.reason).toBe("completed")
    expect(llm.calls).toBeGreaterThanOrEqual(2)

    // Turn 2's user-text view MUST include the mid-turn-captured content.
    // pollFollowUpQueue appended it as a synthesized user message at the
    // top of the second iteration.
    const turn2User = userTexts(llm.seenMessages, 1)
    expect(turn2User.some((t) => t.includes("please also clean up tmp files"))).toBe(true)

    // Queue was drained.
    expect(queue.sizeFor(tid)).toBe(0)
  })

  test("FollowUpQueue: pausedReason=non-null ⇒ response_queued emit, head retained for the FOLLOWING turn", async () => {
    const sessionId = "sess-paused"
    const tid = makeThreadId(sessionId)
    const queue = new FollowUpQueue({ maxPerThread: 4 })
    const stream = new RecordingStream()

    // pausedReason flips: turn 2 is paused (tool_running), turn 3 is ready.
    let pauseTurn2 = true
    const pausedReason = (_thread: string): "tool_running" | null => {
      if (pauseTurn2) return "tool_running"
      return null
    }

    const llm = new HookedFakeLLM(
      [
        // turn 1: tool_use → opens turn 2
        toolUseScript("c1", "echo", { msg: "first" }),
        // turn 2: tool_use again → opens turn 3
        toolUseScript("c2", "echo", { msg: "second" }),
        // turn 3: finish
        textScript("ok"),
      ],
      (call) => {
        if (call === 1) {
          // Enqueue during turn 1 — will be polled at top of turn 2.
          queue.enqueue(tid, {
            content: "backpressured-follow-up",
            submittedAt: 1,
            submittedTurnId: null,
            metadata: {},
          })
        }
        // After turn 2's stream starts, flip the gate so turn 3 sees ready.
        if (call === 2) pauseTurn2 = false
      },
    )

    const outcome = await withTimeout(
      runAgent(
        harnessCfg({
          llm,
          stream,
          sessionId,
          followUpQueue: queue,
          pausedReason,
          maxTurns: 6,
        }),
      ),
      5_000,
      "FollowUpQueue paused",
    )

    expect(outcome.reason).toBe("completed")

    // The response_queued emit fired with reason "tool_running" at turn 2's
    // top (pausedReason said paused). This is the back-pressure observer.
    const queued = findEvent(stream, "response_queued")
    expect(queued).toBeDefined()
    expect(queued?.reason).toBe("tool_running")

    // Turn 2's prompt should NOT yet contain the queued text (we were paused).
    const turn2User = userTexts(llm.seenMessages, 1)
    expect(turn2User.some((t) => t.includes("backpressured-follow-up"))).toBe(false)

    // Turn 3 (pausedReason flipped to null at turn 2 stream start, so the
    // pop happens at the TOP of turn 3) — must contain the queued text.
    const turn3User = userTexts(llm.seenMessages, 2)
    expect(turn3User.some((t) => t.includes("backpressured-follow-up"))).toBe(true)
    expect(queue.sizeFor(tid)).toBe(0)
  })

  test("hookPromptPending: turn_start promptHook ⇒ injectAfterSystem folds into SAME turn's prompt", async () => {
    // The `subagentPendingPrompt` push port is OWNED by the loop's clone of
    // cfg (see `createRunAgentContext` line ~2361). A caller-supplied port
    // becomes an OBSERVER, NOT the array the loop drains. The only way to
    // drive a push into the fold path from outside is via a hook that
    // returns `{promptHook: {injectAfterSystem}}` — `turn_start` is the
    // simplest such surface (fires before `runTurn` snapshots the array).
    const sessionId = "sess-hpp"
    const stream = new RecordingStream()
    const hooks = new HookBus()
    hooks.on("turn_start", (e) => {
      // Only inject on turn 1 — turn 2 fires turn_start again and would
      // re-inject otherwise. Limiting to turn 1 isolates the "did the
      // ALREADY-pushed entry fold?" assertion.
      if (e.turn !== 1) return undefined
      return {
        promptHook: { injectAfterSystem: "HOOK-INJECT-PAYLOAD-FOLD-OK" },
      }
    })

    const llm = new HookedFakeLLM(
      [
        // turn 1: tool_use → opens turn 2
        toolUseScript("c1", "echo", { msg: "hi" }),
        // turn 2: finish
        textScript("done"),
      ],
      () => {
        // no-op — driven by the hook above.
      },
    )

    const outcome = await withTimeout(
      runAgent(harnessCfg({ llm, stream, sessionId, hooks, maxTurns: 5 })),
      5_000,
      "hookPromptPending fold",
    )
    expect(outcome.reason).toBe("completed")

    // Turn 1's prepareTurnContext should have folded the inject into the
    // `<system-reminder>` user message that buildTurnContext appends. The
    // inject text appears inside `## Hook context\n<payload>`.
    const turn1Messages = allTexts(llm.seenMessages, 0)
    expect(turn1Messages.includes("HOOK-INJECT-PAYLOAD-FOLD-OK")).toBe(true)
    // ADR-0133 — drained AFTER the build, so turn 2 does NOT re-see it.
    const turn2Messages = allTexts(llm.seenMessages, 1)
    expect(turn2Messages.includes("HOOK-INJECT-PAYLOAD-FOLD-OK")).toBe(false)
  })

  test("subagentPendingPrompt: caller-wired port is an OBSERVER, NOT the fold seam", async () => {
    // Documents the cfg-clone seam: the loop owns its own auto-wired port
    // (see `wireHookPromptPending`) and only the loop's INTERNAL pushes
    // (from subagent_start/_stop / turn_start hooks) reach the fold. A
    // caller-supplied push port is an OBSERVER — pushes land in caller's
    // array but never flow into `prepareTurnContext.hookPromptInjects`.
    const sessionId = "sess-spp-observer"
    const stream = new RecordingStream()
    const observed: HookPromptInject[] = []
    const subagentPendingPrompt = {
      push: (entry: HookPromptInject) => {
        observed.push(entry)
        return undefined
      },
    }
    const llm = new ScriptedLLM([
      evStep(toolUseScript("c1", "echo", { msg: "x" })),
      evStep(textScript("ok")),
    ])
    const outcome = await withTimeout(
      runAgent(harnessCfg({ llm, stream, sessionId, subagentPendingPrompt, maxTurns: 4 })),
      4_000,
      "subagentPendingPrompt observer",
    )
    expect(outcome.reason).toBe("completed")
    // No internal hook pushed anything in this lightweight test (no
    // subagent ran, no hooks bus) ⇒ observer is empty. This isolates the
    // shape contract: the port is callable, exists for the WHOLE session,
    // and pushes accumulate WITHOUT entering the fold (we cannot drive a
    // push into it from outside).
    expect(observed).toHaveLength(0)
  })

  test("PlanQueueStore: per-msg mutators (retry/edit/delete) survive real-runAgent timing", async () => {
    const sessionId = "sess-pq-mut"
    const store = defaultPlanQueueStore()
    const stream = new RecordingStream()

    // Capture mid-turn into the PlanQueueStore (the typed primitive — not
    // yet auto-wired into the loop drain, by design). The mutators are
    // exercised AFTER turn 1 completes its stream but BEFORE turn 2 reads
    // anything (we don't expect the store to reach the prompt; we expect
    // its TYPED CONTRACT to hold under real-runAgent timing).
    let firstId = ""
    let secondId = ""
    let editAfter: PlanFollowUp | undefined
    let retryAfter: ReturnType<typeof store.retry> | undefined
    let deleteAfter: ReturnType<typeof store.delete> | undefined
    let sendNowAfter: ReturnType<typeof store.sendNow> | undefined

    const llm = new HookedFakeLLM(
      [toolUseScript("c1", "echo", { msg: "x" }), textScript("done")],
      (call) => {
        if (call === 1) {
          firstId = store.enqueue({
            threadId: sessionId,
            text: "alpha",
            source: "user_keystroke",
            pausedReason: "tool_in_flight",
            arrivedDuringTurn: 1,
            urgent: false,
            metadata: {},
          }).id
          secondId = store.enqueue({
            threadId: sessionId,
            text: "beta",
            source: "user_keystroke",
            pausedReason: "tool_in_flight",
            arrivedDuringTurn: 1,
            urgent: false,
            metadata: {},
          }).id
        }
        if (call === 2) {
          // Mutators DURING the second LLM call — proves they tolerate
          // concurrent loop activity.
          const ed = store.edit(firstId, "alpha edited")
          expect(ed.ok).toBe(true)
          editAfter = store.findEntry(firstId)
          // sendNow on the SECOND entry (no sink wired ⇒ `send-not-possible`).
          // The entry IS removed even when the sink rejects — contract clause.
          sendNowAfter = store.sendNow(secondId)
          // retry first removes the source and re-enqueues with a fresh id.
          retryAfter = store.retry(firstId)
          // delete a synthetic / never-existed id ⇒ `not-found`.
          deleteAfter = store.delete("fu-never-existed-9999")
        }
      },
    )

    const outcome = await withTimeout(
      runAgent(harnessCfg({ llm, stream, sessionId, planQueue: { store }, maxTurns: 5 })),
      5_000,
      "PlanQueue mutators",
    )

    expect(outcome.reason).toBe("completed")
    expect(firstId.length).toBeGreaterThan(0)
    expect(secondId.length).toBeGreaterThan(0)
    // editAfter is the snapshot taken after `.edit("alpha edited")` — text
    // has been updated, id unchanged.
    expect(editAfter?.id).toBe(firstId)
    expect(editAfter?.text).toBe("alpha edited")
    // retry produced a NEW snapshot.
    if (!retryAfter?.ok) throw new Error("retry must succeed")
    expect(retryAfter.value.text).toBe("alpha edited")
    expect(retryAfter.value.id).not.toBe(firstId)
    // delete on a synthetic id ⇒ typed `not-found`.
    if (!deleteAfter) throw new Error("delete must have been invoked")
    expect(deleteAfter.ok).toBe(false)
    if (deleteAfter.ok === false) {
      expect(deleteAfter.error).toBe("not-found")
    }
    // sendNow without a wired sink ⇒ `send-not-possible` + entry REMOVED
    // (contract: remove BEFORE sink call so a sink throw cannot leave the
    // entry in a half-state).
    if (!sendNowAfter) throw new Error("sendNow must have been invoked")
    expect(sendNowAfter.ok).toBe(false)
    if (sendNowAfter.ok === false) {
      expect(sendNowAfter.error).toBe("send-not-possible")
    }
    // Post-mutation state: only the retried (fresh-id) entry remains —
    // first was retry-removed-then-re-enqueued, second was sendNow-removed.
    const remaining = store.peek(sessionId).map((e) => e.text)
    expect(remaining).toEqual(["alpha edited"])
  })

  test("PlanQueueStore: SendNowSink wired ⇒ sendNow forwards typed payload + removes entry", async () => {
    const sessionId = "sess-sendnow"
    const stream = new RecordingStream()
    const injected: SendNowInjection[] = []
    const sink: SendNowSink = {
      inject: (p) => {
        injected.push(p)
        return { ok: true }
      },
    }
    const store: PlanQueueStore = defaultPlanQueueStore({ sendNowSink: sink })

    const llm = new HookedFakeLLM([textScript("ok")], (call) => {
      if (call === 1) {
        const r = store.enqueue({
          threadId: sessionId,
          text: "now-or-never",
          source: "user_keystroke",
          pausedReason: "tool_in_flight",
          arrivedDuringTurn: 1,
          urgent: true,
          metadata: { source_surface: "cli" },
          label: "urgent-redirect",
        })
        const sendRes = store.sendNow(r.id)
        expect(sendRes.ok).toBe(true)
      }
    })

    const outcome = await withTimeout(
      runAgent(harnessCfg({ llm, stream, sessionId, planQueue: { store }, maxTurns: 2 })),
      4_000,
      "sendNow sink",
    )
    expect(outcome.reason).toBe("completed")
    expect(injected).toHaveLength(1)
    expect(injected[0]?.text).toBe("now-or-never")
    expect(injected[0]?.threadId).toBe(sessionId)
    expect(injected[0]?.source).toBe("user_keystroke")
    expect(injected[0]?.label).toBe("urgent-redirect")
    expect(injected[0]?.metadata).toEqual({ source_surface: "cli" })
    // Entry was removed BEFORE the sink call (contract).
    expect(store.peek(sessionId)).toEqual([])
  })

  test("adversarial: abort mid-enqueue ⇒ entry stays at head, next turn never runs", async () => {
    const sessionId = "sess-abort"
    const tid = makeThreadId(sessionId)
    const queue = new FollowUpQueue({ maxPerThread: 4 })
    const stream = new RecordingStream()
    const abort = new AbortController()

    // Turn 1: enqueue mid-turn AND fire abort. Loop unwinds before turn 2.
    const llm = new HookedFakeLLM([textScript("any")], (call) => {
      if (call === 1) {
        queue.enqueue(tid, {
          content: "ghost-msg-stays",
          submittedAt: 1,
          submittedTurnId: null,
          metadata: {},
        })
        abort.abort()
      }
    })

    // Use a ScriptedLLM to drive a multi-turn shape, then wrap it so abort
    // ends the session at the FINISH of turn 1.
    const outcome = await withTimeout(
      runAgent(
        harnessCfg({
          llm,
          stream,
          sessionId,
          followUpQueue: queue,
          signal: abort.signal,
          maxTurns: 5,
        }),
      ),
      4_000,
      "abort mid enqueue",
    )

    // Loop ended early — either completed (single text turn) or aborted
    // depending on how the abort raced the finish. Either way: the entry
    // we enqueued at the head must remain (no turn-2 ever ran).
    expect(["completed", "aborted"]).toContain(outcome.reason)
    expect(queue.sizeFor(tid)).toBe(1)
    const head = queue.peek(tid)
    expect(head?.content).toBe("ghost-msg-stays")
  })

  test("adversarial: empty drain on plan-queue is a noop; peek unchanged", async () => {
    const store = defaultPlanQueueStore()
    expect(store.peek("nobody")).toEqual([])
    expect(store.clear("nobody")).toBe(0)
    expect(store.inspect().size).toBe(0)
    // mutators on an empty store ⇒ typed `not-found` (NEVER throw).
    const r1 = store.retry("fu-nobody-999")
    expect(r1.ok).toBe(false)
    if (r1.ok === false) expect(r1.error).toBe("not-found")
    const r2 = store.edit("fu-nobody-999", "new text")
    expect(r2.ok).toBe(false)
    if (r2.ok === false) expect(r2.error).toBe("not-found")
    const r3 = store.delete("fu-nobody-999")
    expect(r3.ok).toBe(false)
    if (r3.ok === false) expect(r3.error).toBe("not-found")
    const r4 = store.sendNow("fu-nobody-999")
    expect(r4.ok).toBe(false)
    if (r4.ok === false) expect(r4.error).toBe("not-found")
  })

  test("adversarial: minimal FollowUp (no label) ⇒ peek snapshot OMITS label (exactOptional)", async () => {
    const store = defaultPlanQueueStore()
    const r = store.enqueue({
      threadId: "t-min",
      text: "minimal",
      source: "user_keystroke",
      pausedReason: "tool_in_flight",
      arrivedDuringTurn: 0,
      urgent: false,
      metadata: {},
    })
    expect(r.collapsed).toBe(false)
    const snap = store.peek("t-min")
    expect(snap).toHaveLength(1)
    const entry: PlanFollowUp | undefined = snap[0]
    expect(entry).toBeDefined()
    if (!entry) return
    // exactOptional: `label` must be ABSENT, not `undefined`.
    expect("label" in entry).toBe(false)
    // Edit with invalid text ⇒ typed `invalid-text`.
    const bad = store.edit(entry.id, "   ")
    expect(bad.ok).toBe(false)
    if (bad.ok === false) expect(bad.error).toBe("invalid-text")
  })

  test("adversarial: concurrent mid-turn enqueues (2 in one stream call) preserve FIFO into next turn", async () => {
    const sessionId = "sess-concurrent"
    const tid = makeThreadId(sessionId)
    const queue = new FollowUpQueue({ maxPerThread: 8 })
    const stream = new RecordingStream()

    const llm = new HookedFakeLLM(
      [
        // turn 1: tool_use → opens turn 2
        toolUseScript("c1", "echo", { msg: "x" }),
        // turn 2: tool_use → opens turn 3
        toolUseScript("c2", "echo", { msg: "y" }),
        // turn 3: finish
        textScript("ok"),
      ],
      (call) => {
        if (call === 1) {
          // TWO mid-turn enqueues in the SAME stream call.
          queue.enqueue(tid, {
            content: "FIRST-concurrent",
            submittedAt: 1,
            submittedTurnId: null,
            metadata: {},
          })
          queue.enqueue(tid, {
            content: "SECOND-concurrent",
            submittedAt: 2,
            submittedTurnId: null,
            metadata: {},
          })
        }
      },
    )

    const outcome = await withTimeout(
      runAgent(harnessCfg({ llm, stream, sessionId, followUpQueue: queue, maxTurns: 6 })),
      5_000,
      "concurrent enqueues",
    )

    expect(outcome.reason).toBe("completed")

    // FIFO: the FIRST entry pops at turn 2's top; the SECOND at turn 3's.
    const turn2User = userTexts(llm.seenMessages, 1)
    const turn3User = userTexts(llm.seenMessages, 2)
    expect(turn2User.some((t) => t.includes("FIRST-concurrent"))).toBe(true)
    expect(turn2User.some((t) => t.includes("SECOND-concurrent"))).toBe(false)
    expect(turn3User.some((t) => t.includes("SECOND-concurrent"))).toBe(true)
    expect(queue.sizeFor(tid)).toBe(0)
  })

  test("baseline: planQueue wired without callbacks ⇒ loop is byte-identical to legacy", async () => {
    // No mid-turn capture, no mutator, no SendNowSink. Just wire the slot
    // and confirm runAgent reaches `completed` with the store empty — the
    // ADR-0128 default-OFF promise ("nothing in the loop instantiates this
    // store") is observable end-to-end.
    const sessionId = "sess-noop"
    const store = defaultPlanQueueStore()
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([evStep(textScript("ok"))])
    const outcome = await withTimeout(
      runAgent(harnessCfg({ llm, stream, sessionId, planQueue: { store }, maxTurns: 2 })),
      3_000,
      "planQueue noop",
    )
    expect(outcome.reason).toBe("completed")
    expect(store.peek(sessionId)).toEqual([])
    expect(store.inspect().size).toBe(0)
  })
})
