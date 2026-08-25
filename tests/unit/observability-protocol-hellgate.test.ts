/**
 * ADR-0408 — Observability protocol hellgate.
 *
 * Pins the wire shape for the two messages (`observability.snapshot` +
 * `observability.delta`) and their round-trip via the encode/decode pair.
 * 22 adversarial cases. Aimed at the SHAPE — the snapshot/delta semantics
 * live in the emitter hellgate.
 */

import { describe, expect, test } from "bun:test"
import type { ApprovalRequest } from "@/agent/approval-state-machine"
import type { RunEntry } from "@/agent/run-ledger"
import type { Objective } from "@/objective"
import type {
  ObservabilityDeltaMessage,
  ObservabilityMessage,
  ObservabilitySnapshotMessage,
} from "@/protocol/observability"
import {
  decodeObservabilityFrame,
  encodeObservabilityFrame,
  isObservabilityMessage,
  isObservabilityMessageKind,
  OBSERVABILITY_MESSAGE_KINDS,
  OBSERVABILITY_PROTOCOL_VERSION,
} from "@/protocol/observability"

const makeRun = (over: Partial<RunEntry> = {}): RunEntry => ({
  id: "run-1",
  kind: "shell",
  owner: "thread-a",
  title: "echo hi",
  status: "running",
  startedAt: 1,
  lastEventAt: 2,
  artifacts: [],
  ...over,
})

const makeObjective = (over: Partial<Objective> = {}): Objective => ({
  objectiveId: "obj-a",
  threadId: "thread-a",
  goal: "ship it",
  createdBy: "system",
  successCriteria: [],
  status: "active",
  budget: { tokensUsed: 0, turnsUsed: 0 },
  blockers: [],
  nextActions: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

const makeApproval = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: "apv-1",
  threadId: "thread-a",
  kind: "permission",
  reason: "delete file",
  proposedAction: "rm /tmp/x",
  resumeStep: "step-1",
  status: "pending",
  createdAt: 1,
  ...over,
})

describe("observability protocol — message kind tag", () => {
  test("OBSERVABILITY_MESSAGE_KINDS contains exactly the two tags", () => {
    expect(OBSERVABILITY_MESSAGE_KINDS).toEqual(["observability.snapshot", "observability.delta"])
  })

  test("isObservabilityMessageKind narrows valid tags", () => {
    expect(isObservabilityMessageKind("observability.snapshot")).toBe(true)
    expect(isObservabilityMessageKind("observability.delta")).toBe(true)
  })

  test("isObservabilityMessageKind rejects unknown / non-string", () => {
    expect(isObservabilityMessageKind("observability.unknown")).toBe(false)
    expect(isObservabilityMessageKind("")).toBe(false)
    expect(isObservabilityMessageKind(0 as unknown)).toBe(false)
    expect(isObservabilityMessageKind(null)).toBe(false)
    expect(isObservabilityMessageKind(undefined)).toBe(false)
  })
})

describe("observability protocol — isObservabilityMessage", () => {
  test("accepts a minimal snapshot", () => {
    const msg: ObservabilitySnapshotMessage = {
      kind: "observability.snapshot",
      runs: [],
      objective: null,
      approvals: [],
      emittedAt: 0,
    }
    expect(isObservabilityMessage(msg)).toBe(true)
  })

  test("accepts a populated snapshot", () => {
    const msg: ObservabilitySnapshotMessage = {
      kind: "observability.snapshot",
      runs: [makeRun(), makeRun({ id: "run-2", status: "completed" })],
      objective: makeObjective(),
      approvals: [makeApproval()],
      emittedAt: 7,
    }
    expect(isObservabilityMessage(msg)).toBe(true)
  })

  test("accepts a minimal empty delta", () => {
    const msg: ObservabilityDeltaMessage = {
      kind: "observability.delta",
      emittedAt: 1,
    }
    expect(isObservabilityMessage(msg)).toBe(true)
  })

  test("accepts a delta with every field present", () => {
    const msg: ObservabilityDeltaMessage = {
      kind: "observability.delta",
      runChanges: [
        { id: "run-1", entry: makeRun() },
        { id: "run-99", entry: null },
      ],
      objectiveChanged: makeObjective(),
      approvalChanges: [
        { id: "apv-1", approval: makeApproval() },
        { id: "apv-2", approval: null },
      ],
      emittedAt: 9,
    }
    expect(isObservabilityMessage(msg)).toBe(true)
  })

  test("rejects non-object inputs", () => {
    expect(isObservabilityMessage(null)).toBe(false)
    expect(isObservabilityMessage(undefined)).toBe(false)
    expect(isObservabilityMessage("snapshot")).toBe(false)
    expect(isObservabilityMessage(42)).toBe(false)
    expect(isObservabilityMessage([])).toBe(false)
  })

  test("rejects unknown tag", () => {
    expect(isObservabilityMessage({ kind: "observability.other", emittedAt: 0 })).toBe(false)
  })

  test("rejects missing / non-finite emittedAt", () => {
    expect(
      isObservabilityMessage({
        kind: "observability.snapshot",
        runs: [],
        approvals: [],
        objective: null,
      }),
    ).toBe(false)
    expect(
      isObservabilityMessage({
        kind: "observability.snapshot",
        runs: [],
        approvals: [],
        objective: null,
        emittedAt: Number.NaN,
      }),
    ).toBe(false)
    expect(
      isObservabilityMessage({
        kind: "observability.snapshot",
        runs: [],
        approvals: [],
        objective: null,
        emittedAt: Number.POSITIVE_INFINITY,
      }),
    ).toBe(false)
  })

  test("rejects snapshot missing runs / approvals arrays", () => {
    expect(
      isObservabilityMessage({
        kind: "observability.snapshot",
        approvals: [],
        objective: null,
        emittedAt: 0,
      }),
    ).toBe(false)
    expect(
      isObservabilityMessage({
        kind: "observability.snapshot",
        runs: [],
        objective: null,
        emittedAt: 0,
      }),
    ).toBe(false)
  })

  test("rejects snapshot.objective shape != null|object", () => {
    expect(
      isObservabilityMessage({
        kind: "observability.snapshot",
        runs: [],
        approvals: [],
        objective: "nope" as unknown,
        emittedAt: 0,
      }),
    ).toBe(false)
    expect(
      isObservabilityMessage({
        kind: "observability.snapshot",
        runs: [],
        approvals: [],
        objective: [] as unknown,
        emittedAt: 0,
      }),
    ).toBe(false)
  })

  test("rejects delta where runChanges / approvalChanges is not array", () => {
    expect(
      isObservabilityMessage({
        kind: "observability.delta",
        runChanges: "no" as unknown,
        emittedAt: 0,
      }),
    ).toBe(false)
    expect(
      isObservabilityMessage({
        kind: "observability.delta",
        approvalChanges: 42 as unknown,
        emittedAt: 0,
      }),
    ).toBe(false)
  })

  test("rejects delta where objectiveChanged is invalid shape", () => {
    expect(
      isObservabilityMessage({
        kind: "observability.delta",
        objectiveChanged: "hi" as unknown,
        emittedAt: 0,
      }),
    ).toBe(false)
    expect(
      isObservabilityMessage({
        kind: "observability.delta",
        objectiveChanged: [] as unknown,
        emittedAt: 0,
      }),
    ).toBe(false)
  })
})

describe("observability protocol — encode/decode round-trip", () => {
  test("snapshot round-trips byte-identically", () => {
    const msg: ObservabilitySnapshotMessage = {
      kind: "observability.snapshot",
      runs: [makeRun()],
      objective: makeObjective(),
      approvals: [makeApproval()],
      emittedAt: 17,
    }
    const wire = encodeObservabilityFrame(msg)
    const out = decodeObservabilityFrame(wire)
    expect(out).toEqual(msg as unknown as ObservabilityMessage)
  })

  test("delta with null arms round-trips", () => {
    const msg: ObservabilityDeltaMessage = {
      kind: "observability.delta",
      runChanges: [{ id: "r", entry: null }],
      objectiveChanged: null,
      approvalChanges: [{ id: "a", approval: null }],
      emittedAt: 33,
    }
    const wire = encodeObservabilityFrame(msg)
    const out = decodeObservabilityFrame(wire)
    expect(out).toEqual(msg as unknown as ObservabilityMessage)
  })

  test("encoded frame carries the pinned version + envelope kind", () => {
    const wire = encodeObservabilityFrame({
      kind: "observability.delta",
      emittedAt: 0,
    })
    const parsed = JSON.parse(wire) as Record<string, unknown>
    expect(parsed.version).toBe(OBSERVABILITY_PROTOCOL_VERSION)
    expect(parsed.kind).toBe("observability")
    expect(typeof parsed.payload).toBe("object")
  })

  test("decodeObservabilityFrame returns null on non-string", () => {
    expect(decodeObservabilityFrame(0 as unknown)).toBeNull()
    expect(decodeObservabilityFrame(null)).toBeNull()
    expect(decodeObservabilityFrame(undefined)).toBeNull()
    expect(decodeObservabilityFrame({} as unknown)).toBeNull()
  })

  test("decodeObservabilityFrame returns null on invalid JSON", () => {
    expect(decodeObservabilityFrame("{ not json")).toBeNull()
    expect(decodeObservabilityFrame("")).toBeNull()
  })

  test("decodeObservabilityFrame returns null on wrong envelope kind", () => {
    const wire = JSON.stringify({
      version: OBSERVABILITY_PROTOCOL_VERSION,
      kind: "event",
      payload: {
        kind: "observability.snapshot",
        runs: [],
        objective: null,
        approvals: [],
        emittedAt: 0,
      },
    })
    expect(decodeObservabilityFrame(wire)).toBeNull()
  })

  test("decodeObservabilityFrame returns null when version missing/empty", () => {
    const wire = JSON.stringify({
      kind: "observability",
      payload: {
        kind: "observability.snapshot",
        runs: [],
        objective: null,
        approvals: [],
        emittedAt: 0,
      },
    })
    expect(decodeObservabilityFrame(wire)).toBeNull()
    const wireEmpty = JSON.stringify({
      version: "",
      kind: "observability",
      payload: {
        kind: "observability.snapshot",
        runs: [],
        objective: null,
        approvals: [],
        emittedAt: 0,
      },
    })
    expect(decodeObservabilityFrame(wireEmpty)).toBeNull()
  })

  test("decodeObservabilityFrame returns null on missing payload tag", () => {
    const wire = JSON.stringify({
      version: OBSERVABILITY_PROTOCOL_VERSION,
      kind: "observability",
      payload: { runs: [], approvals: [], objective: null, emittedAt: 0 },
    })
    expect(decodeObservabilityFrame(wire)).toBeNull()
  })

  test("decodeObservabilityFrame returns null on payload not object", () => {
    const wire = JSON.stringify({
      version: OBSERVABILITY_PROTOCOL_VERSION,
      kind: "observability",
      payload: 42,
    })
    expect(decodeObservabilityFrame(wire)).toBeNull()
  })

  test("decodeObservabilityFrame accepts forward-compatible extra fields", () => {
    // Extra fields on the payload are tolerated — the guard validates the
    // shape of recognized fields without rejecting unknown ones.
    const wire = JSON.stringify({
      version: OBSERVABILITY_PROTOCOL_VERSION,
      kind: "observability",
      payload: {
        kind: "observability.snapshot",
        runs: [],
        objective: null,
        approvals: [],
        emittedAt: 0,
        // unknown future field — must NOT make the guard reject the payload
        forwardCompat: { foo: "bar" },
      },
    })
    const out = decodeObservabilityFrame(wire)
    expect(out).not.toBeNull()
    expect(out?.kind).toBe("observability.snapshot")
  })
})
