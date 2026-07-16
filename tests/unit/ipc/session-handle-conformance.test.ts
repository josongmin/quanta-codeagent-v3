/**
 * S6 (jul-16 SDK ticket 01) — HANDLE-LEVEL transport conformance.
 *
 * The same pinned command script runs through TWO doors over the SAME real
 * runtime shape (ScriptedLLM + live kernel dispatch):
 *
 *   · ORACLE — `toSessionHandle(realRuntimeSession)` (the internal in-process
 *     adapter, MASTER §3.3);
 *   · WIRE   — `attachSessionTransport` + in-memory duplex pair, consumed
 *     through the production connect() internals (runSessionHandshake →
 *     transport client → createSessionHandle).
 *
 * The event streams each handle observes must be EQUAL under the SEALED
 * normalization contract in the fixtures (closed 3-class list: minted ids /
 * clock stamps / seq ordinal — see `normalizeHandleEvents`'s docblock; adding
 * a field there to silence a diff is a RED finding, MASTER §3.4).
 *
 * "다름이 정답" (difference-is-correct) items are asserted POSITIVELY:
 *   · the wire door received ≥1 snapshot FRAME (the handshake state carrier),
 *     the oracle received ZERO (its `snapshot()` is a live read);
 *   · NEITHER stream contains `session.created` (in-proc synthetic tied to a
 *     transport attach — never rides the wire, and the oracle never attaches).
 *
 * Both scenarios also pin RECEIPT parity ({commandId, submitted: true} with
 * the script's pinned ids) and §3.2 terminal parity (same normalized
 * turn-end event through an approval-succeeded chain).
 */

import { afterEach, describe, expect, test } from "bun:test"
import type { SessionEvent } from "@/protocol/session"
import {
  conformanceCallToolScript,
  conformanceEndTextScript,
  createOracleHandleColumn,
  createWireHandleColumn,
  type HandleConformanceColumn,
  makeStateUpdatedEvent,
  normalizeHandleEvents,
  runApprovalTurnHandleScenario,
  runPlainTurnHandleScenario,
} from "./session-transport-conformance-fixtures"

let teardowns: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const teardown of teardowns.reverse()) await teardown()
  teardowns = []
})

const bothColumns = async (scriptsFor: () => Parameters<typeof createOracleHandleColumn>[0]) => {
  const oracle = await createOracleHandleColumn(scriptsFor())
  const wire = await createWireHandleColumn(scriptsFor())
  teardowns.push(oracle.teardown, wire.teardown)
  return { oracle, wire }
}

const assertSharedInvariants = (
  oracle: HandleConformanceColumn,
  wire: HandleConformanceColumn,
  runs: { oracle: { events: SessionEvent[] }; wire: { events: SessionEvent[] } },
): void => {
  // The load-bearing assertion: BYTE-EQUAL streams under the sealed contract.
  expect(normalizeHandleEvents(runs.wire.events)).toEqual(normalizeHandleEvents(runs.oracle.events))
  // Non-vacuity: the streams actually carried the turn.
  expect(runs.oracle.events.length).toBeGreaterThan(3)

  // "다름이 정답": snapshot frames are a WIRE-door artifact (handshake state
  // carrier); the oracle serves snapshot() from a live read instead.
  expect(wire.snapshotFrames.length).toBeGreaterThanOrEqual(1)
  expect(oracle.snapshotFrames.length).toBe(0)

  // "다름이 정답" #2: session.created is an in-proc attach synthetic — never
  // on the wire, and the oracle column performs no attach. NEITHER stream
  // may carry it; a frame appearing here means the wire non-publication
  // contract (fix B, jul-16 ticket) regressed.
  expect(runs.oracle.events.some((e) => e.type === "session.created")).toBe(false)
  expect(runs.wire.events.some((e) => e.type === "session.created")).toBe(false)
}

describe("handle-level conformance: toSessionHandle(oracle) ≡ wire handle", () => {
  test("plain turn scenario: identical normalized event streams + receipts + terminal", async () => {
    const { oracle, wire } = await bothColumns(() => ({
      scripts: [[...conformanceEndTextScript]],
      counts: { n: 0 },
    }))

    const oracleRun = await runPlainTurnHandleScenario(oracle)
    const wireRun = await runPlainTurnHandleScenario(wire)

    assertSharedInvariants(oracle, wire, { oracle: oracleRun, wire: wireRun })

    // Receipt parity: same shape, same PINNED ids, submitted literal true.
    expect(wireRun.receipts).toEqual(oracleRun.receipts)
    expect(oracleRun.receipts.map((r) => r.commandId)).toEqual([
      "cmd-identity",
      "cmd-permission",
      "cmd-append",
      "cmd-run",
    ])
    for (const receipt of [...oracleRun.receipts, ...wireRun.receipts]) {
      expect(receipt.submitted).toBe(true)
    }

    // Terminal parity (§3.2): same normalized turn-end on both doors.
    expect(normalizeHandleEvents([wireRun.turnEnd])).toEqual(
      normalizeHandleEvents([oracleRun.turnEnd]),
    )
    expect(oracleRun.turnEnd.type).toBe("turn.completed")
    expect(oracleRun.turnEnd.causedByCommandId).toBe("cmd-run")
  })

  test("approval-succession scenario (§3.2): suspension + respond + explicit continuation stay conformant", async () => {
    const { oracle, wire } = await bothColumns(() => ({
      scripts: [
        conformanceCallToolScript("t1"),
        conformanceCallToolScript("t1b"),
        [...conformanceEndTextScript],
      ],
      counts: { n: 0 },
    }))

    const oracleRun = await runApprovalTurnHandleScenario(oracle)
    const wireRun = await runApprovalTurnHandleScenario(wire)

    assertSharedInvariants(oracle, wire, { oracle: oracleRun, wire: wireRun })

    // The approval genuinely flowed on BOTH doors (requested + resolved).
    for (const run of [oracleRun, wireRun]) {
      expect(run.events.some((e) => e.type === "approval.requested")).toBe(true)
      expect(run.events.some((e) => e.type === "approval.resolved")).toBe(true)
    }

    // Receipt parity with the pinned script ids.
    expect(wireRun.receipts).toEqual(oracleRun.receipts)
    expect(oracleRun.receipts.map((r) => r.commandId)).toEqual([
      "cmd-append",
      "cmd-run-1",
      "cmd-respond",
      "cmd-run-2",
    ])

    // Terminal parity: the end is caused by the CONTINUATION command on both
    // doors — the §3.2 chain followed the re-issued turn, not the suspended
    // original.
    expect(normalizeHandleEvents([wireRun.turnEnd])).toEqual(
      normalizeHandleEvents([oracleRun.turnEnd]),
    )
    expect(oracleRun.turnEnd.type).toBe("turn.completed")
    expect(oracleRun.turnEnd.causedByCommandId).toBe("cmd-run-2")
    expect(wireRun.turnEnd.causedByCommandId).toBe("cmd-run-2")
  })
})

describe("normalization seal — negative paired-controls (F5/L-1, jul-16 audit)", () => {
  test("F5: a difference in a NON-sealed field (revision / causedByCommandId) SURVIVES normalization — the seal does not over-normalize", () => {
    const base = [
      makeStateUpdatedEvent({
        eventId: "e-base",
        seq: 3,
        revision: 5,
        emittedAt: "2026-07-16T00:00:00.000Z",
        causedByCommandId: "cmd-a",
      }),
    ]
    // Paired CONTROL first: when ONLY the sealed classes differ (minted id /
    // clock / seq ordinal), the streams DO normalize equal — proving the two
    // negative cases below fail for the right reason.
    const sealedOnlyTweak = [
      makeStateUpdatedEvent({
        eventId: "e-other",
        seq: 9,
        revision: 5,
        emittedAt: "2027-01-01T00:00:00.000Z",
        causedByCommandId: "cmd-a",
      }),
    ]
    expect(normalizeHandleEvents(base)).toEqual(normalizeHandleEvents(sealedOnlyTweak))
    // NEGATIVE #1 — `revision` is load-bearing (NOT in the sealed 3-class list).
    const revisionTweak = [
      makeStateUpdatedEvent({
        eventId: "e-rev",
        seq: 9,
        revision: 6,
        emittedAt: "2027-01-01T00:00:00.000Z",
        causedByCommandId: "cmd-a",
      }),
    ]
    expect(normalizeHandleEvents(base)).not.toEqual(normalizeHandleEvents(revisionTweak))
    // NEGATIVE #2 — `causedByCommandId` is load-bearing (the scripts pin
    // commandIds precisely so this stays comparable).
    const causedByTweak = [
      makeStateUpdatedEvent({
        eventId: "e-caused",
        seq: 9,
        revision: 5,
        emittedAt: "2027-01-01T00:00:00.000Z",
        causedByCommandId: "cmd-b",
      }),
    ]
    expect(normalizeHandleEvents(base)).not.toEqual(normalizeHandleEvents(causedByTweak))
  })

  test('L-1: durationMs normalizes by REPLACEMENT (`"<clock>"`) — value differences vanish but an existence mismatch still fails', () => {
    const completed = (durationMs: number | undefined): SessionEvent =>
      ({
        eventId: "e-tool",
        seq: 1,
        revision: 5,
        emittedAt: "t",
        causedByCommandId: "cmd-run",
        type: "tool.completed",
        toolCallId: "t1",
        toolName: "danger",
        outcome: "ok",
        ...(durationMs !== undefined ? { durationMs } : {}),
      }) as SessionEvent
    // Same stopwatch class, different values ⇒ equal after normalization…
    expect(normalizeHandleEvents([completed(3)])).toEqual(normalizeHandleEvents([completed(900)]))
    // …and the placeholder is the pinned carrier (delete would erase presence).
    expect(normalizeHandleEvents([completed(3)])[0]?.durationMs).toBe("<clock>")
    // EXISTENCE parity stays load-bearing: one door stamping the stopwatch and
    // the other not is a REAL divergence, not clock noise.
    expect(normalizeHandleEvents([completed(3)])).not.toEqual(
      normalizeHandleEvents([completed(undefined)]),
    )
  })
})
