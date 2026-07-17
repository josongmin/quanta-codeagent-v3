/**
 * DOF-40 / Wave-D security fix — command-hook exec-adapter throw is FAIL-CLOSED.
 *
 * The adversarial hardening pass found that `HookBus.runHandler` catches every
 * throwing handler and continues, so if the command-hook exec adapter throws
 * (EMFILE / sandbox-exec OOM / adapter bug) on a DENY-capable event, the guarded
 * tool would pass through as if no hook were configured — fail-OPEN on the exact
 * events whose whole purpose is to block.
 *
 * Fix (src/agent/command-hooks/install.ts): the installed handler now catches a
 * runner throw and, for deny-capable events (pre_tool_use / user_prompt_submit),
 * returns an explicit `{ deny }` (fail-CLOSED) instead of letting it reach the
 * bus's catch-and-continue. Observer events (which cannot block) stay non-fatal.
 *
 * Red-on-injection: reverting the try/catch in install.ts makes the first test
 * flip to `{ deny: null }` (fail-open) — the property is load-bearing.
 */
import { describe, expect, test } from "bun:test"
import {
  type CommandHookConfig,
  type CommandHookExecPort,
  type CommandHookPermissionPort,
  HookBus,
  installCommandHooks,
  normalizeCommandHookGate,
} from "@/agent"

const allow: CommandHookPermissionPort = { isAllowed: () => true }

/** A spawn port whose exec() always throws — models EMFILE / sandbox OOM / bug. */
const throwingExec = (message: string): CommandHookExecPort => ({
  exec: async () => {
    throw new Error(message)
  },
})

const ARMED: CommandHookConfig = {
  enabled: true,
  acknowledgedRisk: "operator explicitly acknowledged arbitrary-shell hooks",
  bindings: [{ event: "PreToolUse", matcher: "write", command: "policy-guard.sh --strict" }],
}

describe("command-hook exec throw ⇒ FAIL-CLOSED on deny-capable events", () => {
  test("pre_tool_use: exec throws ⇒ DENY (not a silent pass-through)", async () => {
    const gate = normalizeCommandHookGate(ARMED)
    expect(gate.armed).toBe(true)
    const bus = new HookBus()
    installCommandHooks(bus, gate, {
      exec: throwingExec("EMFILE: too many open files"),
      permission: allow,
      cwd: "/repo",
    })

    const res = await bus.emit({
      type: "pre_tool_use",
      name: "write",
      input: { path: "/etc/passwd", contents: "x" },
    })

    // LOAD-BEARING: the guarded write must be BLOCKED, not passed through.
    // The emit result's `.deny` is a HookDeny object; its `.deny` is the reason.
    expect(res.deny).not.toBeNull()
    expect(res.deny?.deny).toContain("fail-closed")
    expect(res.deny?.deny).toContain("EMFILE")
  })

  test("healthy exec still gates normally (control — throw path is not always-deny)", async () => {
    const gate = normalizeCommandHookGate(ARMED)
    const bus = new HookBus()
    installCommandHooks(bus, gate, {
      // healthy port that does NOT throw and votes allow (exit 0, no decision)
      exec: {
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
      },
      permission: allow,
      cwd: "/repo",
    })

    const res = await bus.emit({
      type: "pre_tool_use",
      name: "write",
      input: { path: "/tmp/ok", contents: "x" },
    })
    // No throw, hook votes allow ⇒ tool proceeds (deny null). Proves the
    // fail-closed deny is caused by the THROW, not applied unconditionally.
    expect(res.deny ?? null).toBeNull()
  })

  test("a tool NOT matching the binding ⇒ hook never runs ⇒ no false fail-closed deny", async () => {
    const gate = normalizeCommandHookGate(ARMED)
    const bus = new HookBus()
    installCommandHooks(bus, gate, {
      exec: throwingExec("would throw if it ran"),
      permission: allow,
      cwd: "/repo",
    })
    // matcher is "write"; a "read" tool must not trigger the hook, so a throwing
    // exec is never reached and the tool is not falsely denied.
    const res = await bus.emit({
      type: "pre_tool_use",
      name: "read",
      input: { path: "/tmp/ok" },
    })
    expect(res.deny ?? null).toBeNull()
  })
})
