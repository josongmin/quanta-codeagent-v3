/**
 * R3 audit-H 24h-window — silent-catch swap proof for the
 * approval-state-machine attribution catches (`clearObjectiveBlocker` +
 * `settleLedger`).
 *
 * Pre-fix: both catches were bare `catch {}` with only a comment so a
 * misbehaving objective/ledger port left production with ZERO observability
 * — exactly the audit signal the R3 24h-window ratchet enforces.
 *
 * Post-fix: each catch now emits `logger.warn` with a stable label prefix
 * (`approval-state.attr.clearBlocker` / `approval-state.attr.settleLedger`)
 * and `errMessage(e)` payload.
 *
 * Pinned invariants:
 *   1. clearBlocker throw ⇒ exactly one warn line containing the
 *      `approval-state.attr.clearBlocker:` label + the underlying message.
 *   2. settleLedger throw ⇒ exactly one warn line containing the
 *      `approval-state.attr.settleLedger:` label + the underlying message.
 *   3. Both throwing at once ⇒ both labels emitted, approval state still
 *      transitions to `approved`.
 *   4. NO-THROW survival — the existing hostile-attribution contract still
 *      holds (status transitions complete; the swap only ADDED telemetry).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  type ApprovalStateMachinePort,
  createApprovalStateMachine,
} from "@/agent/approval-state-machine"
import type { Objective, ObjectivePort } from "@/agent/objective"
import type { RunEntry, RunLedgerPort } from "@/agent/run-ledger"
import { __resetLoggerRateLimit } from "@/shared"
import { __resetTerminalIo, setTerminalIo } from "@/shared/terminal-io"

/** Capture every stderr write into an in-memory list. The logger writes
 *  `[warn] <msg>\n` lines through `writeStderr`; one write per `logger.warn`
 *  call. We split off the trailing newline so assertions read cleanly. */
const captureStderr = (): { lines: string[]; restore: () => void } => {
  const lines: string[] = []
  setTerminalIo({
    stdout: () => undefined,
    stderr: (chunk: string) => {
      for (const piece of chunk.split("\n")) {
        if (piece.length > 0) lines.push(piece)
      }
    },
  })
  return { lines, restore: () => __resetTerminalIo() }
}

/** A monotone clock so deterministic createdAt/settledAt stamps don't
 *  interfere with line-order assertions. */
const stepClock = (start = 1000, step = 10) => {
  let t = start
  return () => {
    const v = t
    t += step
    return v
  }
}

/** Build a minimal Objective with a single blocker — what `objective.get()`
 *  must hand back so the store can extract `blockerId` and later try to
 *  clear it (and trip the swap'd catch). */
const stubObjective = (threadId: string, blockerId: string): Objective => ({
  threadId,
  goal: "stub",
  successCriteria: Object.freeze([]),
  status: "blocked",
  budget: { tokensUsed: 0, turnsUsed: 0 },
  blockers: Object.freeze([{ id: blockerId, reason: "stub", waitingOn: "user", since: 1 }]),
  nextActions: Object.freeze([]),
  createdAt: 1,
  updatedAt: 1,
})

/** Build a minimal RunEntry — what `ledger.start()` must hand back so the
 *  store records `runEntryId` and later tries to settle it. */
const stubRunEntry = (id: string, owner: string): RunEntry => ({
  id,
  kind: "exec",
  owner,
  title: "stub",
  status: "running",
  startedAt: 1,
  lastEventAt: 1,
  artifacts: Object.freeze([]),
})

/** Working ObjectivePort whose `clearBlocker` is the ONLY throwing method
 *  — `addBlocker` + `get` succeed so the request gets a blockerId that the
 *  swap catch then has to clear (and trip). */
const objectiveWithThrowingClear = (): ObjectivePort => {
  const obj = stubObjective("thread-A", "blk-1")
  return {
    set: () => obj,
    get: () => obj,
    updateStatus: () => obj,
    addBlocker: () => obj,
    clearBlocker: () => {
      throw new Error("clear-boom")
    },
    setNextActions: () => obj,
    markCriterion: () => obj,
    recordUsage: () => obj,
    markUsageLimited: () => obj,
    list: () => Object.freeze([obj]),
    toSnapshot: () => ({ objectives: Object.freeze([obj]) }),
    fromSnapshot: () => undefined,
  }
}

/** Working RunLedgerPort whose `settle` is the ONLY throwing method —
 *  `start` + `touch` succeed so the request gets a runEntryId that the
 *  swap catch then has to settle (and trip). */
const ledgerWithThrowingSettle = (): RunLedgerPort => {
  const ent = stubRunEntry("approval-id-placeholder", "thread-A")
  return {
    // `start` is called BEFORE the approval id is minted on the store side;
    // the store passes its minted id as `init.id`. The store treats start as
    // "successful if it doesn't throw" — the returned value is not read for
    // the id (the store uses `approvalId` from its own scope).
    start: (init) => stubRunEntry(init.id, init.owner),
    touch: () => ent,
    settle: () => {
      throw new Error("settle-boom")
    },
    get: () => ent,
    list: () => Object.freeze([ent]),
    running: () => Object.freeze([ent]),
    waiting: () => Object.freeze([]),
    toSnapshot: () => ({ entries: Object.freeze([ent]) }),
    fromSnapshot: () => undefined,
  }
}

let stderr: { lines: string[]; restore: () => void }

beforeEach(() => {
  // R5 cold-start=1: the label-keyed leaky bucket persists across tests.
  // If a prior case already emitted the `approval-state.attr.clearBlocker`
  // (or `…settleLedger`) label, this test's first throw is SUPPRESSED and
  // the warn-line assertion flips RED. Reset the bucket map so every test
  // gets a fresh cold-start budget on every label.
  __resetLoggerRateLimit()
  stderr = captureStderr()
})
afterEach(() => {
  stderr.restore()
  __resetLoggerRateLimit()
})

const ask = (asm: ApprovalStateMachinePort) =>
  asm.request({
    threadId: "thread-A",
    kind: "permission",
    reason: "audit-H swap proof",
    proposedAction: "noop",
    resumeStep: "Step 1 / 1",
  })

describe("R3 audit-H — approval-state attribution catches emit logger.warn", () => {
  it("clearObjectiveBlocker throw emits exactly one warn line with the canonical label", () => {
    const asm = createApprovalStateMachine({
      now: stepClock(),
      objective: objectiveWithThrowingClear(),
    })
    const r = ask(asm)
    expect(r.blockerId).toBe("blk-1")
    const s = asm.settle(r.id, "approve")
    expect(s?.status).toBe("approved")
    const warnLines = stderr.lines.filter((l) => l.includes("approval-state.attr.clearBlocker"))
    expect(warnLines).toHaveLength(1)
    expect(warnLines[0]).toContain("[warn]")
    expect(warnLines[0]).toContain("approval-state.attr.clearBlocker:")
    expect(warnLines[0]).toContain("clear-boom")
  })

  it("settleLedger throw emits exactly one warn line with the canonical label", () => {
    const asm = createApprovalStateMachine({
      now: stepClock(),
      ledger: ledgerWithThrowingSettle(),
    })
    const r = ask(asm)
    expect(r.runEntryId).toBeDefined()
    const s = asm.settle(r.id, "approve")
    expect(s?.status).toBe("approved")
    const warnLines = stderr.lines.filter((l) => l.includes("approval-state.attr.settleLedger"))
    expect(warnLines).toHaveLength(1)
    expect(warnLines[0]).toContain("[warn]")
    expect(warnLines[0]).toContain("approval-state.attr.settleLedger:")
    expect(warnLines[0]).toContain("settle-boom")
  })

  it("both throwing — both label lines emitted AND state still transitions to approved", () => {
    const asm = createApprovalStateMachine({
      now: stepClock(),
      objective: objectiveWithThrowingClear(),
      ledger: ledgerWithThrowingSettle(),
    })
    const r = ask(asm)
    const s = asm.settle(r.id, "approve")
    expect(s?.status).toBe("approved")
    const labels = stderr.lines.filter((l) => l.includes("approval-state.attr."))
    expect(labels.some((l) => l.includes("clearBlocker"))).toBe(true)
    expect(labels.some((l) => l.includes("settleLedger"))).toBe(true)
  })

  const tripVerb = (
    asm: ApprovalStateMachinePort,
    id: string,
    verb: "deny" | "expire" | "cancel",
  ): { status: string | undefined } => {
    if (verb === "deny") return { status: asm.settle(id, "deny")?.status }
    if (verb === "expire") return { status: asm.expire(id)?.status }
    return { status: asm.cancel(id)?.status }
  }

  const expectedStatus: Record<"deny" | "expire" | "cancel", string> = {
    deny: "denied",
    expire: "expired",
    cancel: "cancelled",
  }

  it("deny / expire / cancel decisions ALSO trip both catches when both ports throw", () => {
    for (const verb of ["deny", "expire", "cancel"] as const) {
      stderr.lines.length = 0
      // Each iteration uses the SAME labels (`approval-state.attr.*`). Reset
      // the leaky bucket per-iteration so each verb gets a fresh cold-start
      // budget on every label — the test pins per-verb behaviour, not the
      // bucket's cross-verb sharing.
      __resetLoggerRateLimit()
      const asm = createApprovalStateMachine({
        now: stepClock(),
        objective: objectiveWithThrowingClear(),
        ledger: ledgerWithThrowingSettle(),
      })
      const r = ask(asm)
      const after = tripVerb(asm, r.id, verb)
      expect(after.status).toBe(expectedStatus[verb])
      const hits = stderr.lines.filter((l) => l.includes("approval-state.attr."))
      // Both label lines fire on every settle-path.
      expect(hits.some((l) => l.includes("clearBlocker"))).toBe(true)
      expect(hits.some((l) => l.includes("settleLedger"))).toBe(true)
    }
  })
})
