/**
 * ★ HELLGATE — DOF-40: compaction attribution race, fail-closed.
 *
 * The compaction-visibility seam emits `post_compact` provenance through an
 * ASYNC `postCompactEmit`. Before DOF-40 that provenance carried NO turn id, so
 * a subscriber that resolved LATE (after the loop advanced to the next turn) had
 * to read ambient "current turn" state — mis-attributing the event to the wrong
 * turn, or dropping it when the turn already finalized.
 *
 * DOF-40 makes attribution DETERMINISTIC: the compactor stamps `attributedTurnId`
 * / `attributedThreadId` into the provenance SYNCHRONOUSLY at emit time, so a
 * late async handler reads the turn from the payload it was handed. A dropped /
 * failed emit is surfaced (fail-closed) via `onAttributionFailure`, not silently
 * lost.
 *
 * Coverage:
 *  - ORDERING: a handler that resolves out-of-order (turn N's emit settles AFTER
 *    the loop moved to turn N+1) still attributes to turn N via the stamp.
 *  - SYNC-STAMP: the turn id is captured at emit time — mutating the caller's
 *    ambient turn AFTER `compactIfNeeded` returns does not change the stamp.
 *  - FAIL-CLOSED: a throwing emit surfaces the stamped provenance to
 *    `onAttributionFailure` (not silently dropped); a throwing sink is contained.
 *  - OFF IDENTITY: no callback wired ⇒ zero emit, byte-identical legacy path.
 */

import { describe, expect, test } from "bun:test"
import { compactIfNeeded } from "@/agent"
import type { RecoveryProvenance } from "@/agent/recovery-reason"
import type { LLMPort, Message, StreamEvent, StreamInput, SystemPromptInput } from "@/llm"

class SummarizingLLM implements LLMPort {
  callCount = 0
  constructor(private readonly summary: string) {}
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.callCount += 1
    yield { type: "text_delta", delta: this.summary }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const userText = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })
const assistantText = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
})

const overThresholdMessages = (): Message[] => [
  userText("a".repeat(2_000)),
  assistantText("b".repeat(2_000)),
  userText("recent ask"),
  assistantText("recent answer"),
]

const _sys: SystemPromptInput = "sys"

describe("compaction attribution race × fail-closed (DOF-40) — hellgate", () => {
  test("LATE out-of-order async handler still attributes to the CORRECT turn via the stamp", async () => {
    // Simulate the loop: a shared "ambient current turn" the loop advances. The
    // handler resolves LATE (after the turn boundary), so if it read the AMBIENT
    // turn it would see the WRONG turn. It must read the STAMP instead.
    let ambientCurrentTurn = "t7"
    const releasers: (() => void)[] = []
    const attributed: { fromAmbient: string; fromStamp: string | undefined }[] = []

    // A handler that does not resolve until we release it — modelling an emit
    // that settles AFTER the loop advanced the turn.
    const lateEmit = (p: RecoveryProvenance): Promise<void> =>
      new Promise<void>((resolve) => {
        releasers.push(() => {
          attributed.push({ fromAmbient: ambientCurrentTurn, fromStamp: p.attributedTurnId })
          resolve()
        })
      })

    // Turn 7 compacts. We DO NOT await settlement yet — the loop moves on first.
    const pending = compactIfNeeded({
      messages: overThresholdMessages(),
      llm: new SummarizingLLM("FOLDED"),
      system: _sys,
      thresholdTokens: 100,
      keepRecentTurns: 1,
      threadId: "thread-1",
      attributedTurnId: "t7",
      postCompactEmit: lateEmit,
    })

    // Let the async chain (LLM summarize stream) run until the emit registers its
    // releaser — i.e. until `compactIfNeeded` is PARKED inside the awaited emit.
    while (releasers.length === 0) await new Promise((r) => setTimeout(r, 0))
    // Loop advances to turn 8 (the turn boundary crossed) BEFORE the emit settles.
    ambientCurrentTurn = "t8"
    // Now release the late handler (out-of-order resolution, post-boundary).
    for (const r of releasers.splice(0)) r()
    await pending

    expect(attributed.length).toBe(1)
    const rec = attributed[0]
    if (!rec) throw new Error("handler never ran")
    // The ambient turn at resolution time is the WRONG (advanced) turn...
    expect(rec.fromAmbient).toBe("t8")
    // ...but the STAMP deterministically attributes to the compaction's own turn.
    expect(rec.fromStamp).toBe("t7")
  })

  test("the turn-id stamp is captured SYNCHRONOUSLY (mutating ambient after the call does not change it)", async () => {
    const holder = { turnId: "tA" }
    const seen: RecoveryProvenance[] = []
    await compactIfNeeded({
      messages: overThresholdMessages(),
      llm: new SummarizingLLM("FOLDED"),
      system: _sys,
      thresholdTokens: 100,
      keepRecentTurns: 1,
      // The caller passes the CURRENT turn id BY VALUE at call time.
      attributedTurnId: holder.turnId,
      threadId: "thread-9",
      postCompactEmit: (p) => {
        seen.push(p)
      },
    })
    // The caller's ambient turn advances after the compaction returned.
    holder.turnId = "tZ"
    const p = seen[0]
    if (!p) throw new Error("no emit")
    expect(p.attributedTurnId).toBe("tA")
    expect(p.attributedThreadId).toBe("thread-9")
  })

  test("FAIL-CLOSED: a throwing emit surfaces the STAMPED provenance to onAttributionFailure (not dropped)", async () => {
    const failures: { p: RecoveryProvenance; err: unknown }[] = []
    const res = await compactIfNeeded({
      messages: overThresholdMessages(),
      llm: new SummarizingLLM("FOLDED"),
      system: _sys,
      thresholdTokens: 100,
      keepRecentTurns: 1,
      attributedTurnId: "t42",
      threadId: "thread-x",
      postCompactEmit: () => {
        throw new Error("attribution channel down")
      },
      onAttributionFailure: (p, err) => {
        failures.push({ p, err })
      },
    })
    // Compaction STILL succeeds (no-throw), but the drop is NOT silent.
    expect(res.compacted).toBe(true)
    expect(failures.length).toBe(1)
    const f = failures[0]
    if (!f) throw new Error("failure not surfaced")
    // Attributable to the correct turn even though the emit failed.
    expect(f.p.attributedTurnId).toBe("t42")
    expect(f.p.attributedThreadId).toBe("thread-x")
    expect((f.err as Error).message).toBe("attribution channel down")
  })

  test("FAIL-CLOSED sink is contained: a throwing onAttributionFailure does not abort the turn", async () => {
    const res = await compactIfNeeded({
      messages: overThresholdMessages(),
      llm: new SummarizingLLM("FOLDED"),
      system: _sys,
      thresholdTokens: 100,
      keepRecentTurns: 1,
      attributedTurnId: "t1",
      postCompactEmit: () => {
        throw new Error("emit down")
      },
      onAttributionFailure: () => {
        throw new Error("sink also down")
      },
    })
    expect(res.compacted).toBe(true)
  })

  test("no failure ⇒ onAttributionFailure NEVER fires (happy path untouched)", async () => {
    let failCount = 0
    const seen: RecoveryProvenance[] = []
    await compactIfNeeded({
      messages: overThresholdMessages(),
      llm: new SummarizingLLM("FOLDED"),
      system: _sys,
      thresholdTokens: 100,
      keepRecentTurns: 1,
      attributedTurnId: "t3",
      postCompactEmit: (p) => {
        seen.push(p)
      },
      onAttributionFailure: () => {
        failCount += 1
      },
    })
    expect(failCount).toBe(0)
    expect(seen[0]?.attributedTurnId).toBe("t3")
  })

  test("objective wire carries the stamped turn tag when a turn is stamped", async () => {
    const calls: readonly string[][] = []
    await compactIfNeeded({
      messages: overThresholdMessages(),
      llm: new SummarizingLLM("FOLDED"),
      system: _sys,
      thresholdTokens: 100,
      keepRecentTurns: 1,
      threadId: "thread-obj",
      attributedTurnId: "t99",
      objectiveSetNextActions: (_tid, actions) => {
        ;(calls as string[][]).push([...actions])
      },
    })
    expect(calls.length).toBe(1)
    const action = calls[0]?.[0] ?? ""
    // Existing resume contract intact...
    expect(action).toContain("agent compacted")
    expect(action).toContain("resume after compaction")
    // ...plus the deterministic turn tag.
    expect(action).toContain("[turn t99]")
  })

  test("R2 adversarial: two INTERLEAVED compactions keep their OWN stamp (no cross-attribution)", async () => {
    // Turn N and turn N+1 both compact; their async emits resolve OUT OF ORDER
    // (N+1 first, then N). Each must attribute to its OWN turn — the stamp lives
    // in each call's local provenance, so there is no shared mutable slot to race.
    const gates = new Map<string, () => void>()
    const seen: { turn: string }[] = []
    const makeEmit =
      (label: string) =>
      (p: RecoveryProvenance): Promise<void> =>
        new Promise<void>((resolve) => {
          gates.set(label, () => {
            seen.push({ turn: p.attributedTurnId ?? "UNSTAMPED" })
            resolve()
          })
        })

    const pN = compactIfNeeded({
      messages: overThresholdMessages(),
      llm: new SummarizingLLM("N"),
      system: _sys,
      thresholdTokens: 100,
      keepRecentTurns: 1,
      attributedTurnId: "tN",
      threadId: "th",
      postCompactEmit: makeEmit("N"),
    })
    const pN1 = compactIfNeeded({
      messages: overThresholdMessages(),
      llm: new SummarizingLLM("N1"),
      system: _sys,
      thresholdTokens: 100,
      keepRecentTurns: 1,
      attributedTurnId: "tN1",
      threadId: "th",
      postCompactEmit: makeEmit("N1"),
    })

    // Wait for BOTH to park inside their awaited emit.
    while (!(gates.has("N") && gates.has("N1"))) await new Promise((r) => setTimeout(r, 0))
    // Release OUT OF ORDER: N+1 settles before N.
    gates.get("N1")?.()
    gates.get("N")?.()
    await Promise.all([pN, pN1])

    // Each handler recorded ITS OWN turn — order of resolution is N1 then N.
    expect(seen).toEqual([{ turn: "tN1" }, { turn: "tN" }])
  })

  // ── OFF / absence IDENTITY (paired control) ─────────────────────────────
  test("OFF: no callback/port wired ⇒ ZERO emit, compaction identical to legacy", async () => {
    const llm = new SummarizingLLM("FOLDED")
    const res = await compactIfNeeded({
      messages: overThresholdMessages(),
      llm,
      system: _sys,
      thresholdTokens: 100,
      keepRecentTurns: 1,
      // NO postCompactEmit, NO objectiveSetNextActions, NO onAttributionFailure.
    })
    expect(res.compacted).toBe(true)
    if (res.compacted) {
      expect(res.messages.length).toBeGreaterThan(0)
      expect(res.summaryTokens).toBeGreaterThan(0)
    }
    // The summarizer still ran exactly once (legacy tier-2 path).
    expect(llm.callCount).toBe(1)
  })

  test("OFF: attributedTurnId set but NO emit callback ⇒ no provenance materialized, still byte-identical result", async () => {
    // A stamped turn id with no consumer must not change behavior — the
    // provenance is never even built (the emit helper early-returns).
    const llm = new SummarizingLLM("FOLDED")
    const res = await compactIfNeeded({
      messages: overThresholdMessages(),
      llm,
      system: _sys,
      thresholdTokens: 100,
      keepRecentTurns: 1,
      attributedTurnId: "t-orphan",
    })
    expect(res.compacted).toBe(true)
    expect(llm.callCount).toBe(1)
  })

  test("stamp OMITTED (exactOptional) when no turn is passed even WITH an emit wired", async () => {
    const seen: RecoveryProvenance[] = []
    await compactIfNeeded({
      messages: overThresholdMessages(),
      llm: new SummarizingLLM("FOLDED"),
      system: _sys,
      thresholdTokens: 100,
      keepRecentTurns: 1,
      // threadId present ⇒ attributedThreadId stamped; turn absent ⇒ omitted.
      threadId: "thread-only",
      postCompactEmit: (p) => {
        seen.push(p)
      },
    })
    const p = seen[0]
    if (!p) throw new Error("no emit")
    expect("attributedTurnId" in p).toBe(false)
    expect(p.attributedThreadId).toBe("thread-only")
  })
})
