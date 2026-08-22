/**
 * ADR-0037: every PausedReason is documented + tested through `popReady`.
 *
 * Coverage rule: each reason must (a) appear in ALL_PAUSED_REASONS, (b) have
 * a non-empty doc string, (c) cause `popReady` to return null when set.
 */

import { describe, expect, test } from "bun:test"
import {
  ALL_PAUSED_REASONS,
  FollowUpQueue,
  PAUSED_REASON_DOCS,
  type PausedReason,
  threadId,
} from "@/agent/follow-up-queue"

describe("PausedReason enum coverage (ADR-0037)", () => {
  test("ALL_PAUSED_REASONS has exactly 10 distinct values", () => {
    expect(ALL_PAUSED_REASONS.length).toBe(10)
    expect(new Set(ALL_PAUSED_REASONS).size).toBe(10)
  })

  test("PAUSED_REASON_DOCS has a non-empty entry for every reason", () => {
    for (const r of ALL_PAUSED_REASONS) {
      const doc = PAUSED_REASON_DOCS[r]
      expect(doc).toBeDefined()
      expect(doc.length).toBeGreaterThan(10)
    }
  })

  test("popReady returns null for EVERY non-null PausedReason", () => {
    for (const r of ALL_PAUSED_REASONS) {
      const q = new FollowUpQueue()
      const tid = threadId(`th-${r}`)
      q.enqueue(tid, {
        content: "pending",
        submittedAt: 0,
        submittedTurnId: null,
        metadata: {},
      })
      expect(q.popReady(tid, r)).toBeNull()
      // And the queue stayed intact.
      expect(q.sizeFor(tid)).toBe(1)
    }
  })

  test("popReady returns the entry when reason flips to null", () => {
    const q = new FollowUpQueue()
    const tid = threadId("th-flip")
    q.enqueue(tid, {
      content: "msg",
      submittedAt: 0,
      submittedTurnId: null,
      metadata: {},
    })
    // Walk every reason — still blocked.
    for (const r of ALL_PAUSED_REASONS) {
      expect(q.popReady(tid, r)).toBeNull()
    }
    // Unpause once ⇒ delivered.
    const ready = q.popReady(tid, null)
    expect(ready?.ready.content).toBe("msg")
    expect(ready?.remaining).toEqual([])
  })

  test("docs reference an explicit v3 surface noun per reason", () => {
    // Each PausedReason MUST cite the concrete condition that triggers it
    // in v3 — no generic "something is happening" boilerplate.
    const expectedPhrase: Record<PausedReason, string> = {
      model_streaming: "stream",
      tool_running: "tool",
      awaiting_approval: "hitl",
      awaiting_user: "asked",
      network_retry: "backoff",
      compaction_in_progress: "compaction",
      review_in_progress: "review",
      hand_off_in_progress: "hand-off",
      mid_turn_steer_in_flight: "steer",
      unknown_blocking: "blocking",
    }
    for (const r of ALL_PAUSED_REASONS) {
      const doc = PAUSED_REASON_DOCS[r].toLowerCase()
      expect(doc).toContain(expectedPhrase[r])
    }
  })
})
