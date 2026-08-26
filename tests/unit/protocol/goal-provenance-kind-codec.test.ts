/**
 * GOAL-08 — the wire codec pins the CLOSED set of host-minted goal provenance
 * kinds. A forged kind must fail closed at decode (a raw client cannot invent
 * a third attribution); both real kinds round-trip byte-for-byte.
 */

import { describe, expect, test } from "bun:test"
import { decodeSessionCommand } from "@/protocol/session"

const raw = (kind: string): string =>
  JSON.stringify({
    version: "session.v1",
    kind: "command",
    payload: {
      sessionId: "s",
      commandId: "c",
      issuedAt: "2026-08-27T00:00:00.000Z",
      type: "turn.submit",
      text: "continue",
      expectedSessionRevision: 1,
      provenance: { kind, objectiveId: "o", objectiveRevision: 2, attemptId: "a" },
    },
  })

describe("GOAL-08 — goal provenance kind is a closed set at the codec", () => {
  test.each(["goal-continuation", "user-requested-goal-work"])("%s decodes", (kind) => {
    const decoded = decodeSessionCommand(raw(kind))
    expect(decoded.type).toBe("turn.submit")
    expect((decoded as { provenance?: { kind?: string } }).provenance?.kind).toBe(kind)
  })

  test.each([
    "forged",
    "autonomous-continuation",
    "GOAL-CONTINUATION",
    "",
  ])("%j FAILS CLOSED with bad_command_provenance_kind", (kind) => {
    expect(() => decodeSessionCommand(raw(kind))).toThrow(/bad_command_provenance_kind/)
  })
})
