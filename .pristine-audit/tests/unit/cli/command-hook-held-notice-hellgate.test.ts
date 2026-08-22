/**
 * WS-G item 6 (UUX-4-20) — a `needsReview` command hook HELD by the trust gate
 * was silent: the runner filtered it out (correct — fail-closed security) but
 * the operator never learned their configured hook did not fire. Fix: one
 * LATCHED warn per held binding on the operator-notice bus, naming the hook.
 *
 * Red-on-injection: held binding + event ⇒ one warn naming the command;
 * repeat events do NOT spam (latched per binding). Controls: an APPROVED
 * binding and a trusted (user) binding emit NOTHING.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  type CommandHookBinding,
  type CommandHookExecOpts,
  type CommandHookExecPort,
  type CommandHookExecResult,
  type CommandHookPermissionPort,
  normalizeCommandHookGate,
  runCommandHooks,
} from "@/agent"
import { __resetHeldHookNoticesForTest } from "@/agent/command-hooks/runner"
import {
  __resetOperatorNoticeSinkForTest,
  installOperatorNoticeSink,
  type OperatorNotice,
} from "@/shared"

const fakeExec = (): { port: CommandHookExecPort; calls: CommandHookExecOpts[] } => {
  const calls: CommandHookExecOpts[] = []
  return {
    calls,
    port: {
      exec: async (opts): Promise<CommandHookExecResult> => {
        calls.push(opts)
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false }
      },
    },
  }
}

const allowPermission: CommandHookPermissionPort = { isAllowed: () => true }

const importedBinding: CommandHookBinding = {
  event: "PreToolUse",
  command: "imported-hook.sh",
  source: "imported",
  needsReview: true,
}
const userBinding: CommandHookBinding = {
  event: "PreToolUse",
  command: "user-hook.sh",
  source: "user",
  needsReview: false,
}

const armed = (bindings: readonly CommandHookBinding[]) =>
  normalizeCommandHookGate({
    enabled: true,
    acknowledgedRisk: "operator armed for WS-G notice test",
    bindings,
    trustGate: true,
  })

const fire = (
  gate: ReturnType<typeof normalizeCommandHookGate>,
  port: CommandHookExecPort,
  review?: { isApproved: (b: CommandHookBinding) => boolean | Promise<boolean> },
) =>
  runCommandHooks(
    gate,
    { exec: port, permission: allowPermission, cwd: "/tmp", ...(review ? { review } : {}) },
    { type: "pre_tool_use", toolName: "write", payload: { x: 1 } },
  )

const notices: OperatorNotice[] = []

beforeEach(() => {
  // The latch is module-level (session-chrome de-dup) — another suite in the
  // same process may already have latched the same binding key.
  __resetHeldHookNoticesForTest()
})

afterEach(() => {
  __resetOperatorNoticeSinkForTest()
  __resetHeldHookNoticesForTest()
  notices.length = 0
})

describe("held command-hook notice (UUX-4-20)", () => {
  test("held binding ⇒ ONE warn naming the hook, latched across repeat events", async () => {
    installOperatorNoticeSink((n) => notices.push(n))
    const { port, calls } = fakeExec()
    const gate = armed([importedBinding])
    await fire(gate, port) // no review port ⇒ held (fail-closed)
    await fire(gate, port) // second event — must not re-notice
    expect(calls).toHaveLength(0)
    const warns = notices.filter((n) => n.source === "command-hooks")
    expect(warns).toHaveLength(1)
    expect(warns[0]?.severity).toBe("warn")
    expect(warns[0]?.message).toContain("imported-hook.sh")
  })

  test("paired control: approved binding fires with NO notice", async () => {
    installOperatorNoticeSink((n) => notices.push(n))
    const { port, calls } = fakeExec()
    await fire(armed([importedBinding]), port, { isApproved: () => true })
    expect(calls).toHaveLength(1)
    expect(notices).toHaveLength(0)
  })

  test("paired control: trusted user binding fires with NO notice", async () => {
    installOperatorNoticeSink((n) => notices.push(n))
    const { port, calls } = fakeExec()
    await fire(armed([userBinding]), port)
    expect(calls).toHaveLength(1)
    expect(notices).toHaveLength(0)
  })
})
