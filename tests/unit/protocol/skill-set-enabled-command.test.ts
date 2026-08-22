/**
 * RFC-06 F5 — protocol arm for the `session.skill.set_enabled` command.
 *
 * RED rail: the codec must LOSSLESSLY round-trip the skill name, the boolean
 * enabled state, and the optional SKILL-domain revision — and FAIL CLOSED on a
 * mistyped name / non-boolean enabled / string revision. ONE new union arm; the
 * command is a recognized type.
 */
import { describe, expect, test } from "bun:test"
import {
  buildSkillSetEnabled,
  type CommandBuildDeps,
  decodeSessionCommand,
  encodeSessionCommand,
  isSessionCommandType,
  SESSION_COMMAND_TYPES,
} from "@/protocol/session"

const deps: CommandBuildDeps = {
  sessionId: "sess-1",
  clock: { now: () => new Date("2026-08-23T00:00:00.000Z") },
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const rawPayload = (payload: Record<string, unknown>): string =>
  JSON.stringify({ version: "session.v1", kind: "command", payload })

describe("session.skill.set_enabled — protocol arm", () => {
  test("is a recognized command type (ONE new union arm)", () => {
    expect(SESSION_COMMAND_TYPES).toContain("session.skill.set_enabled")
    expect(isSessionCommandType("session.skill.set_enabled")).toBe(true)
    // Exactly one new arm — the command-type tuple length grew by one over the
    // pre-F5 ten (approval/input/identity/objective/permission/posture/
    // transcript/tool_profile/turn.cancel/turn.run).
    expect(SESSION_COMMAND_TYPES.length).toBe(11)
  })

  test("builder mints a well-formed disable command (no CAS target)", () => {
    const cmd = buildSkillSetEnabled(deps, "rr", false, undefined)
    expect(cmd.type).toBe("session.skill.set_enabled")
    expect(cmd.sessionId).toBe("sess-1")
    expect(cmd.commandId).toMatch(UUID_RE)
    expect(cmd.issuedAt).toBe("2026-08-23T00:00:00.000Z")
    expect(cmd.name).toBe("rr")
    expect(cmd.enabled).toBe(false)
    expect("expectedSkillRevision" in cmd).toBe(false)
  })

  test("builder threads an explicit expectedSkillRevision (distinct from the envelope revision)", () => {
    const cmd = buildSkillSetEnabled(deps, "rr", true, { expectedSkillRevision: 7 })
    expect(cmd.enabled).toBe(true)
    expect(cmd.expectedSkillRevision).toBe(7)
    expect("expectedRevision" in cmd).toBe(false)
  })

  test("codec LOSSLESSLY round-trips name + enabled + skill revision", () => {
    const cmd = buildSkillSetEnabled(deps, "explain-code", false, { expectedSkillRevision: 3 })
    const decoded = decodeSessionCommand(encodeSessionCommand(cmd))
    expect(decoded).toEqual(cmd)
  })

  test("codec round-trips the no-CAS form byte-for-byte", () => {
    const cmd = buildSkillSetEnabled(deps, "explain-code", true, undefined)
    const decoded = decodeSessionCommand(encodeSessionCommand(cmd))
    expect(decoded).toEqual(cmd)
    expect("expectedSkillRevision" in decoded).toBe(false)
  })

  test("codec FAILS CLOSED on a non-string name", () => {
    expect(() =>
      decodeSessionCommand(
        rawPayload({
          sessionId: "s",
          commandId: "c",
          issuedAt: "2026-08-23T00:00:00.000Z",
          type: "session.skill.set_enabled",
          name: 42,
          enabled: true,
        }),
      ),
    ).toThrow()
  })

  test("codec FAILS CLOSED on a non-boolean enabled", () => {
    expect(() =>
      decodeSessionCommand(
        rawPayload({
          sessionId: "s",
          commandId: "c",
          issuedAt: "2026-08-23T00:00:00.000Z",
          type: "session.skill.set_enabled",
          name: "rr",
          enabled: "yes",
        }),
      ),
    ).toThrow()
  })

  test("codec FAILS CLOSED on a string skill revision", () => {
    expect(() =>
      decodeSessionCommand(
        rawPayload({
          sessionId: "s",
          commandId: "c",
          issuedAt: "2026-08-23T00:00:00.000Z",
          type: "session.skill.set_enabled",
          name: "rr",
          enabled: false,
          expectedSkillRevision: "3",
        }),
      ),
    ).toThrow()
  })
})
