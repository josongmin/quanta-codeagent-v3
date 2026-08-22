/**
 * RFC-03 C3 — protocol arm for the `session.objective.mutate` command.
 *
 * Pins the ONE command-union version added under the A4-successor protocol lock:
 *   - the builder mints a well-formed command carrying the closed mutation +
 *     the optional `expectedRevision` CAS target;
 *   - the type guard + `SESSION_COMMAND_TYPES` recognize it;
 *   - the codec round-trips it and FAILS CLOSED on a malformed mutation payload
 *     (a scalar/array mutation, or a mutation with no string `kind`).
 */
import { describe, expect, test } from "bun:test"
import {
  buildObjectiveMutate,
  type CommandBuildDeps,
  decodeSessionCommand,
  encodeSessionCommand,
  isSessionCommandType,
  SESSION_COMMAND_TYPES,
} from "@/protocol/session"

const deps: CommandBuildDeps = {
  sessionId: "sess-1",
  clock: { now: () => new Date("2026-08-22T00:00:00.000Z") },
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe("session.objective.mutate — protocol arm", () => {
  test("is a recognized command type", () => {
    expect(SESSION_COMMAND_TYPES).toContain("session.objective.mutate")
    expect(isSessionCommandType("session.objective.mutate")).toBe(true)
  })

  test("builder mints a well-formed command with the closed mutation", () => {
    const cmd = buildObjectiveMutate(deps, { kind: "set", goal: "ship it" }, undefined)
    expect(cmd.type).toBe("session.objective.mutate")
    expect(cmd.sessionId).toBe("sess-1")
    expect(cmd.commandId).toMatch(UUID_RE)
    expect(cmd.issuedAt).toBe("2026-08-22T00:00:00.000Z")
    expect(cmd.mutation).toEqual({ kind: "set", goal: "ship it" })
    expect("expectedRevision" in cmd).toBe(false)
  })

  test("builder threads an explicit expectedObjectiveRevision CAS target (distinct from the envelope revision)", () => {
    const cmd = buildObjectiveMutate(
      deps,
      { kind: "updateStatus", status: "paused" },
      {
        expectedObjectiveRevision: 4,
      },
    )
    expect(cmd.expectedObjectiveRevision).toBe(4)
    // the envelope's session-level `expectedRevision` stays absent
    expect("expectedRevision" in cmd).toBe(false)
  })

  test("codec round-trips the command", () => {
    const cmd = buildObjectiveMutate(
      deps,
      { kind: "set", goal: "g" },
      {
        expectedObjectiveRevision: 2,
      },
    )
    const decoded = decodeSessionCommand(encodeSessionCommand(cmd))
    expect(decoded).toEqual(cmd)
  })

  test("codec FAILS CLOSED on a scalar mutation payload", () => {
    const raw = JSON.stringify({
      version: "session.v1",
      kind: "command",
      payload: {
        sessionId: "s",
        commandId: "c",
        issuedAt: "2026-08-22T00:00:00.000Z",
        type: "session.objective.mutate",
        mutation: "not-an-object",
      },
    })
    expect(() => decodeSessionCommand(raw)).toThrow()
  })

  test("codec FAILS CLOSED on a mutation with no string kind", () => {
    const raw = JSON.stringify({
      version: "session.v1",
      kind: "command",
      payload: {
        sessionId: "s",
        commandId: "c",
        issuedAt: "2026-08-22T00:00:00.000Z",
        type: "session.objective.mutate",
        mutation: { goal: "g" },
      },
    })
    expect(() => decodeSessionCommand(raw)).toThrow()
  })
})
