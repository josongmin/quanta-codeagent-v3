/**
 * RFC-05 E4 — protocol arm for the `session.posture.set` command + its
 * `session.permission.set` compatibility adapter.
 *
 * RED rail (a): the codec must LOSSLESSLY round-trip the posture patch, the
 * closed scope, and the optional POSTURE-domain revision — and FAIL CLOSED on a
 * scalar patch or an unknown scope.
 */
import { describe, expect, test } from "bun:test"
import {
  buildPostureSet,
  type CommandBuildDeps,
  decodeSessionCommand,
  encodeSessionCommand,
  isPostureCommandScope,
  isSessionCommandType,
  POSTURE_COMMAND_SCOPES,
  SESSION_COMMAND_TYPES,
} from "@/protocol/session"

const deps: CommandBuildDeps = {
  sessionId: "sess-1",
  clock: { now: () => new Date("2026-08-22T00:00:00.000Z") },
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe("session.posture.set — protocol arm", () => {
  test("is a recognized command type + closed scope surface", () => {
    expect(SESSION_COMMAND_TYPES).toContain("session.posture.set")
    expect(isSessionCommandType("session.posture.set")).toBe(true)
    expect([...POSTURE_COMMAND_SCOPES]).toEqual(["current", "default"])
    expect(isPostureCommandScope("current")).toBe(true)
    expect(isPostureCommandScope("default")).toBe(true)
    expect(isPostureCommandScope("future")).toBe(false)
  })

  test("builder mints a well-formed current-scope command with the lossless patch", () => {
    const cmd = buildPostureSet(deps, { mode: "acceptEdits" }, "current", undefined)
    expect(cmd.type).toBe("session.posture.set")
    expect(cmd.sessionId).toBe("sess-1")
    expect(cmd.commandId).toMatch(UUID_RE)
    expect(cmd.issuedAt).toBe("2026-08-22T00:00:00.000Z")
    expect(cmd.patch).toEqual({ mode: "acceptEdits" })
    expect(cmd.scope).toBe("current")
    expect("expectedPostureRevision" in cmd).toBe(false)
  })

  test("builder threads an explicit expectedPostureRevision CAS target (distinct from the envelope revision)", () => {
    const cmd = buildPostureSet(deps, { askOutsidePlan: false }, "default", {
      expectedPostureRevision: 4,
    })
    expect(cmd.scope).toBe("default")
    expect(cmd.expectedPostureRevision).toBe(4)
    expect("expectedRevision" in cmd).toBe(false)
  })

  test("codec LOSSLESSLY round-trips patch + scope + posture revision", () => {
    const cmd = buildPostureSet(
      deps,
      {
        approvalPolicy: "on-request",
        approvalsReviewer: "agent",
        sandboxPolicy: { type: "read-only" },
        askOutsidePlan: true,
        mode: "auto",
      },
      "current",
      { expectedPostureRevision: 2 },
    )
    const decoded = decodeSessionCommand(encodeSessionCommand(cmd))
    expect(decoded).toEqual(cmd)
  })

  test("codec FAILS CLOSED on a scalar patch payload", () => {
    const raw = JSON.stringify({
      version: "session.v1",
      kind: "command",
      payload: {
        sessionId: "s",
        commandId: "c",
        issuedAt: "2026-08-22T00:00:00.000Z",
        type: "session.posture.set",
        patch: "not-an-object",
        scope: "current",
      },
    })
    expect(() => decodeSessionCommand(raw)).toThrow()
  })

  test("codec FAILS CLOSED on an unknown scope", () => {
    const raw = JSON.stringify({
      version: "session.v1",
      kind: "command",
      payload: {
        sessionId: "s",
        commandId: "c",
        issuedAt: "2026-08-22T00:00:00.000Z",
        type: "session.posture.set",
        patch: { mode: "auto" },
        scope: "future",
      },
    })
    expect(() => decodeSessionCommand(raw)).toThrow()
  })

  test("codec FAILS CLOSED on a string posture revision", () => {
    const raw = JSON.stringify({
      version: "session.v1",
      kind: "command",
      payload: {
        sessionId: "s",
        commandId: "c",
        issuedAt: "2026-08-22T00:00:00.000Z",
        type: "session.posture.set",
        patch: { mode: "auto" },
        scope: "current",
        expectedPostureRevision: "2",
      },
    })
    expect(() => decodeSessionCommand(raw)).toThrow()
  })
})
