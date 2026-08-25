/**
 * S1 (jul-16 SDK ticket 01) — protocol-slice command-builder SSOT.
 *
 * The builders MOVED here from `src/sdk/runtime/session/commands.ts` (whose
 * behavior the existing sdk/attach suites pin unchanged); this file covers what
 * is NEW at the hoist site: the `buildTurnCancel` builder (the command existed
 * in the 8-command union all along but had no builder) and the meta/minting
 * contract at its new home.
 */
import { describe, expect, test } from "bun:test"
import {
  buildApprovalRespond,
  buildInputAppend,
  buildTurnCancel,
  buildTurnRun,
  buildTurnSubmit,
  type CommandBuildDeps,
  continuationCommandIdForApproval,
  isSessionCommandType,
} from "@/protocol/session"

const fixedDeps: CommandBuildDeps = {
  sessionId: "builder-session",
  clock: { now: () => new Date("2026-07-16T12:00:00.000Z") },
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe("protocol session builders (hoisted SSOT)", () => {
  test("buildTurnCancel mints a well-formed turn.cancel from the deps clock", () => {
    const command = buildTurnCancel(fixedDeps, undefined)
    expect(command.type).toBe("turn.cancel")
    expect(isSessionCommandType(command.type)).toBe(true)
    expect(command.sessionId).toBe("builder-session")
    expect(command.commandId).toMatch(UUID_RE)
    expect(command.issuedAt).toBe("2026-07-16T12:00:00.000Z")
    expect("expectedRevision" in command).toBe(false)
  })

  test("B-MED-7: continuationCommandIdForApproval is a DETERMINISTIC, approvalId-derived id (SSOT prediction)", () => {
    expect(continuationCommandIdForApproval("ap-1")).toBe("approval-continuation:ap-1")
    // Deterministic (same input ⇒ same id) and injective per approvalId.
    expect(continuationCommandIdForApproval("ap-1")).toBe(continuationCommandIdForApproval("ap-1"))
    expect(continuationCommandIdForApproval("ap-2")).not.toBe(
      continuationCommandIdForApproval("ap-1"),
    )
  })

  test("B-MED-7: buildTurnRun forwards causedByApprovalId when present; omits it otherwise (byte-identical)", () => {
    const stamped = buildTurnRun(fixedDeps, {
      commandId: continuationCommandIdForApproval("ap-7"),
      causedByApprovalId: "ap-7",
    })
    expect(stamped).toEqual({
      sessionId: "builder-session",
      type: "turn.run",
      commandId: "approval-continuation:ap-7",
      issuedAt: "2026-07-16T12:00:00.000Z",
      causedByApprovalId: "ap-7",
    })
    const bare = buildTurnRun(fixedDeps, { commandId: "r-bare" })
    expect("causedByApprovalId" in bare).toBe(false)
  })

  test("buildTurnCancel honors explicit meta overrides (id / issuedAt / expectedRevision)", () => {
    const command = buildTurnCancel(fixedDeps, {
      commandId: "cancel-7",
      issuedAt: "2026-01-01T00:00:00.000Z",
      expectedRevision: 4,
    })
    expect(command).toEqual({
      sessionId: "builder-session",
      type: "turn.cancel",
      commandId: "cancel-7",
      issuedAt: "2026-01-01T00:00:00.000Z",
      expectedRevision: 4,
    })
  })

  test("buildTurnSubmit preserves the complete atomic prompt and provenance", () => {
    expect(
      buildTurnSubmit(
        fixedDeps,
        {
          text: "continue",
          expectedSessionRevision: 7,
          provenance: {
            kind: "goal-continuation",
            objectiveId: "goal-1",
            objectiveRevision: 3,
            attemptId: "attempt-secret",
          },
        },
        { commandId: "submit-1" },
      ),
    ).toEqual({
      sessionId: "builder-session",
      type: "turn.submit",
      text: "continue",
      expectedSessionRevision: 7,
      provenance: {
        kind: "goal-continuation",
        objectiveId: "goal-1",
        objectiveRevision: 3,
        attemptId: "attempt-secret",
      },
      commandId: "submit-1",
      issuedAt: "2026-07-16T12:00:00.000Z",
    })
  })

  test("two mints never share a commandId (dedup-window safety)", () => {
    const a = buildTurnCancel(fixedDeps, undefined)
    const b = buildTurnCancel(fixedDeps, undefined)
    expect(a.commandId).not.toBe(b.commandId)
  })

  test("sibling builders keep their exact shapes at the new home (input.append / turn.run / approval.respond)", () => {
    const append = buildInputAppend(fixedDeps, "  raw line  ", { commandId: "a-1" })
    expect(append).toEqual({
      sessionId: "builder-session",
      type: "input.append",
      text: "  raw line  ", // untrimmed — the builder never rewrites payload text
      commandId: "a-1",
      issuedAt: "2026-07-16T12:00:00.000Z",
    })

    const run = buildTurnRun(fixedDeps, { commandId: "r-1" })
    expect(run).toEqual({
      sessionId: "builder-session",
      type: "turn.run",
      commandId: "r-1",
      issuedAt: "2026-07-16T12:00:00.000Z",
    })

    // scope/steer forwarding (ADR-0512 P3) survives the hoist.
    const respond = buildApprovalRespond(fixedDeps, "ap-1", "deny", {
      commandId: "d-1",
      steer: "use the safe variant",
    })
    expect(respond).toEqual({
      sessionId: "builder-session",
      type: "approval.respond",
      approvalId: "ap-1",
      decision: "deny",
      steer: "use the safe variant",
      commandId: "d-1",
      issuedAt: "2026-07-16T12:00:00.000Z",
    })
  })
})
