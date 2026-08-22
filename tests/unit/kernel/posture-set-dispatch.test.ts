/**
 * RFC-05 E4 — kernel dispatch of `session.posture.set` + the
 * `session.permission.set` compatibility adapter.
 *
 * RED rail (b): the command must NOT report success through an ABSENT optional
 * host method — a host without `setPosture` yields a TYPED negative
 * (`SessionPostureUnsupportedError`), never a silent success echo. Also pins:
 *   - `ok` ⇒ the scheduler reconciles the fresh posture projection from
 *     `describe()` onto the state echo at the same revision;
 *   - a stale `expectedPostureRevision` ⇒ `SessionPostureConflictError`;
 *   - `session.permission.set` funnels through the SAME `setPosture` projection
 *     (adapter: `{ mode }` patch, `scope: "current"`).
 */
import { describe, expect, test } from "bun:test"
import {
  createKernelSessionState,
  dispatchSessionCommand,
  InMemorySessionEventLog,
  type SessionHost,
} from "@/kernel/session"
import {
  buildPermissionSet,
  buildPostureSet,
  type PostureCommandOutcome,
  type PostureProjectionView,
  SessionPostureConflictError,
  SessionPostureUnsupportedError,
} from "@/protocol/session"
import { capabilitiesFor } from "../../support/session-fixtures"

const manifest = capabilitiesFor({ approvals: "operator", tools: true, artifacts: true })
const clock = { now: () => new Date("2026-08-22T00:00:00.000Z") }

const projection = (
  revision: number,
  mode: "default" | "acceptEdits" | "bypass" | "auto",
): PostureProjectionView => ({
  revision,
  requested: { preset: null, patch: { mode } },
  effective: {
    threadPermission: {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "read-only" },
    },
    reviewerRoute: "user",
    askOutsidePlan: true,
    effectiveMode: mode,
  },
  locks: [],
})

const baseHost = (over: Partial<SessionHost>): SessionHost => ({
  describe: () => ({ sessionId: "s1", permissionMode: "default", capabilityManifest: manifest }),
  runTurn: async () => ({ outcome: { reason: "completed", turns: 0, messages: [] }, messages: [] }),
  close: async () => undefined,
  ...over,
})

const freshState = () =>
  createKernelSessionState({
    sessionId: "s1",
    permissionMode: "default",
    capabilityManifest: manifest,
  })

describe("session.posture.set — kernel dispatch", () => {
  test("ABSENT host.setPosture ⇒ typed negative (NOT a silent success echo)", async () => {
    const cmd = buildPostureSet({ sessionId: "s1", clock }, { mode: "auto" }, "current", undefined)
    await expect(
      dispatchSessionCommand(freshState(), cmd, {
        clock,
        eventLog: new InMemorySessionEventLog(),
        host: baseHost({}), // no setPosture wired
      }),
    ).rejects.toBeInstanceOf(SessionPostureUnsupportedError)
  })

  test("ABSENT host.setPosture on the LEGACY permission.set adapter ⇒ same typed negative", async () => {
    const cmd = buildPermissionSet({ sessionId: "s1", clock }, "bypass", undefined)
    await expect(
      dispatchSessionCommand(freshState(), cmd, {
        clock,
        eventLog: new InMemorySessionEventLog(),
        host: baseHost({}),
      }),
    ).rejects.toBeInstanceOf(SessionPostureUnsupportedError)
  })

  test("ok ⇒ reconciles the fresh posture projection onto the state echo at the same revision", async () => {
    const seen: Array<{ patch: unknown; scope: string; expectedRevision?: number }> = []
    let live = projection(0, "default")
    const host = baseHost({
      describe: () => ({
        sessionId: "s1",
        permissionMode: live.effective.effectiveMode,
        capabilityManifest: manifest,
        posture: live,
      }),
      setPosture: (args): PostureCommandOutcome => {
        seen.push(args as { patch: unknown; scope: string; expectedRevision?: number })
        live = projection(
          1,
          (args.patch as { mode?: "default" | "acceptEdits" | "bypass" | "auto" }).mode ??
            "default",
        )
        return { ok: true }
      },
    })
    const cmd = buildPostureSet({ sessionId: "s1", clock }, { mode: "auto" }, "current", undefined)
    const result = await dispatchSessionCommand(freshState(), cmd, {
      clock,
      eventLog: new InMemorySessionEventLog(),
      host,
    })
    expect(seen).toEqual([{ patch: { mode: "auto" }, scope: "current" }])
    const echo = result.events.at(-1)
    expect(echo?.type).toBe("session.state.updated")
    // the echo carries the resolved posture (requested/effective/locks) AND the
    // reconciled effectiveMode, at the same event revision
    expect(echo).toMatchObject({
      type: "session.state.updated",
      state: {
        permissionMode: "auto",
        posture: { revision: 1, effective: { effectiveMode: "auto" } },
      },
    })
  })

  test("scheduler forwards expectedPostureRevision as the CAS target", async () => {
    let seenRev: number | undefined = -1
    const host = baseHost({
      setPosture: ({ expectedRevision }): PostureCommandOutcome => {
        seenRev = expectedRevision
        return { ok: true }
      },
    })
    const cmd = buildPostureSet({ sessionId: "s1", clock }, { mode: "auto" }, "current", {
      expectedPostureRevision: 7,
    })
    await dispatchSessionCommand(freshState(), cmd, {
      clock,
      eventLog: new InMemorySessionEventLog(),
      host,
    })
    expect(seenRev).toBe(7)
  })

  test("a stale posture revision ⇒ typed conflict (no clobber)", async () => {
    const host = baseHost({
      setPosture: (): PostureCommandOutcome => ({
        ok: false,
        kind: "stale_revision",
        expected: 2,
        actual: 5,
      }),
    })
    const cmd = buildPostureSet({ sessionId: "s1", clock }, { mode: "auto" }, "current", {
      expectedPostureRevision: 2,
    })
    await expect(
      dispatchSessionCommand(freshState(), cmd, {
        clock,
        eventLog: new InMemorySessionEventLog(),
        host,
      }),
    ).rejects.toBeInstanceOf(SessionPostureConflictError)
  })

  test("permission.set adapter funnels a { mode } patch at scope current into setPosture", async () => {
    const seen: Array<{ patch: unknown; scope: string }> = []
    const host = baseHost({
      setPosture: (args): PostureCommandOutcome => {
        seen.push(args as { patch: unknown; scope: string })
        return { ok: true }
      },
    })
    const cmd = buildPermissionSet({ sessionId: "s1", clock }, "bypass", undefined)
    await dispatchSessionCommand(freshState(), cmd, {
      clock,
      eventLog: new InMemorySessionEventLog(),
      host,
    })
    expect(seen).toEqual([{ patch: { mode: "bypass" }, scope: "current" }])
  })
})
