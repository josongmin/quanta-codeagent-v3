/**
 * RFC-01 A1 — pure attention resolver (`@/attention`).
 *
 * `nextNeedingAttention` is PURE + stateless: it takes a derived snapshot of
 * agents and returns the single one the operator should go to next. Two
 * load-bearing invariants, each pinned with a red-on-injection fixture:
 *   1. LINEAGE GATE (jul-15 sibling-leak class): only `rootId === ownRootId`
 *      agents are ever eligible — a foreign-lineage agent is NEVER selected,
 *      even when it is the globally oldest.
 *   2. PRIORITY DETERMINISM: among own-lineage awaiting agents, oldest-first by
 *      (askedAt, requestId). The MIXED fixture (own-old + own-new + idle +
 *      foreign-oldest) makes both invariants load-bearing — flipping the sort
 *      order OR dropping the lineage filter changes the asserted pick.
 */

import { describe, expect, test } from "bun:test"
import { type AttentionAgent, nextNeedingAttention } from "@/attention"

const awaiting = (
  id: string,
  rootId: string,
  requestId: string,
  askedAt: number,
): AttentionAgent => ({
  id,
  label: id,
  rootId,
  pendingQuestion: { requestId, askedAt, summary: `${id}?` },
})

const idle = (id: string, rootId: string): AttentionAgent => ({
  id,
  label: id,
  rootId,
  pendingQuestion: null,
})

const OWN = "root_self"
const FOREIGN = "root_other"

/**
 * MIXED adversarial fixture:
 *   - A: own-lineage, awaiting, askedAt=100 (own-lineage OLDEST → expected pick)
 *   - B: own-lineage, awaiting, askedAt=200 (newer — must lose to A)
 *   - C: own-lineage, IDLE (no pending — never eligible)
 *   - D: FOREIGN-lineage, awaiting, askedAt=50 (globally OLDEST — lineage gate
 *        must exclude it, or it would win)
 */
const mixed = (): AttentionAgent[] => [
  awaiting("B", OWN, "q_B", 200),
  awaiting("D", FOREIGN, "q_D", 50),
  idle("C", OWN),
  awaiting("A", OWN, "q_A", 100),
]

describe("nextNeedingAttention — priority + lineage", () => {
  test("MIXED fixture: own-lineage OLDEST awaiting wins (priority red-on-injection)", () => {
    const pick = nextNeedingAttention(mixed(), OWN)
    // Own-lineage oldest. If the sort were flipped to newest-first, B would win.
    expect(pick?.id).toBe("A")
    // B (newer) explicitly does NOT win the first slot.
    expect(pick?.id).not.toBe("B")
  })

  test("LINEAGE GATE: foreign-lineage awaiting is NEVER selected, even as globally oldest", () => {
    // D (foreign) has the globally-oldest askedAt=50 — if the lineage filter
    // were dropped, D would be selected. It must not be.
    const pick = nextNeedingAttention(mixed(), OWN)
    expect(pick?.id).not.toBe("D")
    expect(pick?.rootId).toBe(OWN)

    // And from the FOREIGN owner's perspective, only D is eligible.
    expect(nextNeedingAttention(mixed(), FOREIGN)?.id).toBe("D")
  })

  test("IDLE agents (no pending question) are never selected", () => {
    const onlyIdle = [idle("C", OWN), idle("E", OWN)]
    expect(nextNeedingAttention(onlyIdle, OWN)).toBeUndefined()
  })

  test("returns undefined when nothing is awaiting for this lineage", () => {
    // All awaiting agents are foreign; own lineage has nothing.
    const rows = [awaiting("D", FOREIGN, "q_D", 50)]
    expect(nextNeedingAttention(rows, OWN)).toBeUndefined()
  })

  test("deterministic tie-break by requestId (byteCompare) when askedAt is equal", () => {
    const rows = [awaiting("Y", OWN, "q_y", 100), awaiting("X", OWN, "q_x", 100)]
    // Equal askedAt → byteCompare("q_x","q_y") < 0 → X first.
    expect(nextNeedingAttention(rows, OWN)?.id).toBe("X")
  })

  test("afterRequestId advances to the next own-lineage awaiting agent (cycling)", () => {
    const rows = mixed()
    // Start: A (oldest). After A → B (next own-lineage awaiting).
    expect(nextNeedingAttention(rows, OWN, "q_A")?.id).toBe("B")
    // After the last own-lineage awaiting → undefined (caller: all caught up).
    expect(nextNeedingAttention(rows, OWN, "q_B")).toBeUndefined()
    // Unknown afterRequestId falls back to the oldest (no crash / no skip).
    expect(nextNeedingAttention(rows, OWN, "q_missing")?.id).toBe("A")
  })
})
