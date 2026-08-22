/**
 * HELLGATE — disk-configured command hooks (ADR-0454).
 *
 * Command hooks execute ARBITRARY user shell on HookBus events. These proofs
 * seal the security funnel + the verdict mapping with a FAKE exec port — NO
 * real shell ever runs in CI:
 *
 *   1. DEFAULT-OFF byte-identical: no config / toggle off ⇒ the runner never
 *      spawns and the HookBus emit is byte-identical (zero exec calls).
 *   2. OPT-IN + ACK enforced: `enabled:true` without a non-empty
 *      acknowledgedRisk THROWS at config time (fail fast, never mid-turn).
 *   3. PERMISSION-GATED: an armed gate whose permission port refuses NEVER
 *      spawns; the verdict is a deny.
 *   4. PAYLOAD-AS-STDIN, INJECTION-SAFE: the event payload reaches the command
 *      ONLY as JSON on stdin; the command string is the user config verbatim,
 *      never concatenated with payload content.
 *   5. EXIT≠0 ⇒ DENY (Claude Code contract).
 *   6. stdout {updatedInput} ⇒ REWRITE.
 *   7. stdout {decision:"block"} on exit 0 ⇒ DENY.
 *   8. TIMEOUT ⇒ fail-closed DENY.
 *   9. ENV-ALLOWLIST applied: the gate's allowlist is handed to exec verbatim.
 *  10. MATCHER selects the right event/tool; a non-matching tool never spawns.
 *  11. HookBus integration: an armed pre_tool_use command hook denies a tool
 *      through the real bus; an un-armed gate registers NO handlers.
 *
 * Source under test: src/agent/command-hooks/*.
 */

import { describe, expect, test } from "bun:test"
import {
  COMMAND_HOOKS_ENABLED_WITHOUT_ACK_MESSAGE,
  CommandHookConfigError,
  type CommandHookExecOpts,
  type CommandHookExecPort,
  type CommandHookExecResult,
  type CommandHookPermissionPort,
  HookBus,
  installCommandHooks,
  normalizeCommandHookGate,
  parseCommandHookBindings,
  runCommandHooks,
} from "@/agent"

// ---- fakes -----------------------------------------------------------------

interface RecordedCall {
  readonly command: string
  readonly stdinJson: string
  readonly envAllowlist: readonly string[]
  readonly timeoutMs: number
  readonly cwd: string
}

const fakeExec = (
  reply: (opts: CommandHookExecOpts) => CommandHookExecResult,
): { port: CommandHookExecPort; calls: RecordedCall[] } => {
  const calls: RecordedCall[] = []
  return {
    calls,
    port: {
      exec: async (opts) => {
        calls.push({
          command: opts.command,
          stdinJson: opts.stdinJson,
          envAllowlist: opts.envAllowlist,
          timeoutMs: opts.timeoutMs,
          cwd: opts.cwd,
        })
        return reply(opts)
      },
    },
  }
}

const allowPermission: CommandHookPermissionPort = { isAllowed: () => true }
const denyPermission: CommandHookPermissionPort = { isAllowed: () => false }

const ok = (stdout = ""): CommandHookExecResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
  timedOut: false,
})

// ---- 1. default-off byte-identical -----------------------------------------

describe("command hooks — default-OFF", () => {
  test("undefined config ⇒ disarmed, runner never spawns", async () => {
    const gate = normalizeCommandHookGate(undefined)
    expect(gate.armed).toBe(false)
    const { port, calls } = fakeExec(() => ok())
    const verdict = await runCommandHooks(
      gate,
      { exec: port, permission: allowPermission, cwd: "/tmp" },
      { type: "pre_tool_use", toolName: "write", payload: { x: 1 } },
    )
    expect(calls.length).toBe(0)
    expect(verdict).toEqual({ deny: null, timedOut: false })
  })

  test("toggle off but ack+bindings present ⇒ STILL disarmed (no accidental arm)", () => {
    const gate = normalizeCommandHookGate({
      enabled: false,
      acknowledgedRisk: "I accept",
      bindings: [{ event: "PreToolUse", command: "true" }],
    })
    expect(gate.armed).toBe(false)
    expect(gate.bindings.length).toBe(0)
  })

  test("armed=false ⇒ installCommandHooks registers NO handlers (bus byte-identical)", async () => {
    const bus = new HookBus()
    const { port, calls } = fakeExec(() => ok())
    installCommandHooks(bus, normalizeCommandHookGate(undefined), {
      exec: port,
      permission: allowPermission,
      cwd: "/tmp",
    })
    const res = await bus.emit({ type: "pre_tool_use", name: "write", input: {} })
    expect(res).toEqual({ deny: null })
    expect(calls.length).toBe(0)
  })
})

// ---- 2. opt-in + ack enforced ----------------------------------------------

describe("command hooks — opt-in + acknowledgement", () => {
  test("enabled without ack THROWS the exact contract message", () => {
    expect(() =>
      normalizeCommandHookGate({
        enabled: true,
        bindings: [{ event: "PreToolUse", command: "true" }],
      }),
    ).toThrow(CommandHookConfigError)
    try {
      normalizeCommandHookGate({ enabled: true, bindings: [] })
    } catch (e) {
      expect((e as Error).message).toBe(COMMAND_HOOKS_ENABLED_WITHOUT_ACK_MESSAGE)
    }
  })

  test("whitespace-only ack counts as empty ⇒ throws", () => {
    expect(() =>
      normalizeCommandHookGate({
        enabled: true,
        acknowledgedRisk: "   ",
        bindings: [{ event: "PreToolUse", command: "true" }],
      }),
    ).toThrow(CommandHookConfigError)
  })

  test("enabled + ack + ≥1 binding ⇒ ARMED, ack preserved for audit", () => {
    const gate = normalizeCommandHookGate({
      enabled: true,
      acknowledgedRisk: "operator approved shell hooks for CI",
      bindings: [{ event: "PreToolUse", command: "guard.sh" }],
    })
    expect(gate.armed).toBe(true)
    expect(gate.acknowledgedRisk).toBe("operator approved shell hooks for CI")
  })

  test("enabled + ack but ZERO bindings ⇒ disarmed (nothing to gate)", () => {
    const gate = normalizeCommandHookGate({
      enabled: true,
      acknowledgedRisk: "ok",
      bindings: [],
    })
    expect(gate.armed).toBe(false)
  })
})

// ---- 3. permission-gated ---------------------------------------------------

describe("command hooks — permission gate", () => {
  test("permission refuses ⇒ NO spawn, verdict is deny", async () => {
    const gate = normalizeCommandHookGate({
      enabled: true,
      acknowledgedRisk: "ok",
      bindings: [{ event: "PreToolUse", command: "guard.sh" }],
    })
    const { port, calls } = fakeExec(() => ok())
    const verdict = await runCommandHooks(
      gate,
      { exec: port, permission: denyPermission, cwd: "/tmp" },
      { type: "pre_tool_use", toolName: "write", payload: {} },
    )
    expect(calls.length).toBe(0)
    expect(verdict.deny).not.toBeNull()
  })
})

// ---- 4. payload-as-stdin, injection-safe -----------------------------------

describe("command hooks — injection safety", () => {
  test("payload reaches command ONLY via stdin JSON; command string is verbatim", async () => {
    const gate = normalizeCommandHookGate({
      enabled: true,
      acknowledgedRisk: "ok",
      bindings: [{ event: "PreToolUse", command: "guard.sh --check" }],
    })
    const { port, calls } = fakeExec(() => ok())
    // A hostile payload that, if string-concatenated into a shell command,
    // would execute `rm -rf /`.
    const hostile = { input: { path: "$(rm -rf /)`whoami`; echo pwned" } }
    await runCommandHooks(
      gate,
      { exec: port, permission: allowPermission, cwd: "/tmp" },
      {
        type: "pre_tool_use",
        toolName: "write",
        payload: hostile,
      },
    )
    expect(calls.length).toBe(1)
    const call = calls[0]!
    // The command string is EXACTLY the user config — payload never appended.
    expect(call.command).toBe("guard.sh --check")
    expect(call.command).not.toContain("rm -rf")
    // The hostile content is present ONLY inside the JSON stdin envelope.
    const envelope = JSON.parse(call.stdinJson)
    expect(envelope.hook_event_name).toBe("pre_tool_use")
    expect(envelope.tool_name).toBe("write")
    expect(envelope.payload.input.path).toContain("rm -rf")
  })

  test("circular payload ⇒ safe minimal envelope, never throws", async () => {
    const gate = normalizeCommandHookGate({
      enabled: true,
      acknowledgedRisk: "ok",
      bindings: [{ event: "PreToolUse", command: "guard.sh" }],
    })
    const { port, calls } = fakeExec(() => ok())
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const verdict = await runCommandHooks(
      gate,
      { exec: port, permission: allowPermission, cwd: "/tmp" },
      { type: "pre_tool_use", toolName: "write", payload: circular },
    )
    expect(verdict.deny).toBeNull()
    const envelope = JSON.parse(calls[0]!.stdinJson)
    expect(envelope.hook_event_name).toBe("pre_tool_use")
  })
})

// ---- 5-8. verdict mapping --------------------------------------------------

describe("command hooks — verdict mapping", () => {
  const armed = () =>
    normalizeCommandHookGate({
      enabled: true,
      acknowledgedRisk: "ok",
      bindings: [{ event: "PreToolUse", command: "guard.sh" }],
    })

  test("exit≠0 ⇒ DENY", async () => {
    const { port } = fakeExec(() => ({ stdout: "", stderr: "nope", exitCode: 2, timedOut: false }))
    const v = await runCommandHooks(
      armed(),
      { exec: port, permission: allowPermission, cwd: "/tmp" },
      {
        type: "pre_tool_use",
        toolName: "write",
        payload: {},
      },
    )
    expect(v.deny?.reason).toContain("exited 2")
  })

  test("stdout {updatedInput} on exit 0 ⇒ REWRITE", async () => {
    const { port } = fakeExec(() => ok(JSON.stringify({ updatedInput: { path: "/safe" } })))
    const v = await runCommandHooks(
      armed(),
      { exec: port, permission: allowPermission, cwd: "/tmp" },
      {
        type: "pre_tool_use",
        toolName: "write",
        payload: {},
      },
    )
    expect(v.deny).toBeNull()
    expect("updatedInput" in v).toBe(true)
    expect(v.updatedInput).toEqual({ path: "/safe" })
  })

  test("stdout {decision:'block'} on exit 0 ⇒ DENY", async () => {
    const { port } = fakeExec(() => ok(JSON.stringify({ decision: "block", reason: "policy X" })))
    const v = await runCommandHooks(
      armed(),
      { exec: port, permission: allowPermission, cwd: "/tmp" },
      {
        type: "pre_tool_use",
        toolName: "write",
        payload: {},
      },
    )
    expect(v.deny?.reason).toBe("policy X")
  })

  test("timeout ⇒ fail-closed DENY", async () => {
    const { port } = fakeExec(() => ({ stdout: "", stderr: "", exitCode: 0, timedOut: true }))
    const v = await runCommandHooks(
      armed(),
      { exec: port, permission: allowPermission, cwd: "/tmp" },
      {
        type: "pre_tool_use",
        toolName: "write",
        payload: {},
      },
    )
    expect(v.timedOut).toBe(true)
    expect(v.deny?.reason).toContain("timed out")
  })

  test("first deny wins across multiple matching commands", async () => {
    const gate = normalizeCommandHookGate({
      enabled: true,
      acknowledgedRisk: "ok",
      bindings: [
        { event: "PreToolUse", command: "first.sh" },
        { event: "PreToolUse", command: "second.sh" },
      ],
    })
    let n = 0
    const { port } = fakeExec(() => {
      n += 1
      return n === 1
        ? ({ stdout: "", stderr: "", exitCode: 7, timedOut: false } as CommandHookExecResult)
        : ok(JSON.stringify({ deny: "later" }))
    })
    const v = await runCommandHooks(
      gate,
      { exec: port, permission: allowPermission, cwd: "/tmp" },
      {
        type: "pre_tool_use",
        toolName: "write",
        payload: {},
      },
    )
    expect(v.deny?.reason).toContain("exited 7")
  })
})

// ---- 9. env-allowlist ------------------------------------------------------

describe("command hooks — env allowlist", () => {
  test("custom allowlist is handed to exec verbatim", async () => {
    const gate = normalizeCommandHookGate({
      enabled: true,
      acknowledgedRisk: "ok",
      bindings: [{ event: "PreToolUse", command: "g.sh" }],
      envAllowlist: ["PATH", "HOME"],
    })
    const { port, calls } = fakeExec(() => ok())
    await runCommandHooks(
      gate,
      { exec: port, permission: allowPermission, cwd: "/tmp" },
      {
        type: "pre_tool_use",
        toolName: "write",
        payload: {},
      },
    )
    expect(calls[0]!.envAllowlist).toEqual(["PATH", "HOME"])
  })
})

// ---- 10. matcher selection -------------------------------------------------

describe("command hooks — matcher", () => {
  const gate = () =>
    normalizeCommandHookGate({
      enabled: true,
      acknowledgedRisk: "ok",
      bindings: [{ event: "PreToolUse", matcher: "write|edit", command: "g.sh" }],
    })

  test("matching tool ⇒ spawns", async () => {
    const { port, calls } = fakeExec(() => ok())
    await runCommandHooks(
      gate(),
      { exec: port, permission: allowPermission, cwd: "/tmp" },
      {
        type: "pre_tool_use",
        toolName: "edit",
        payload: {},
      },
    )
    expect(calls.length).toBe(1)
  })

  test("non-matching tool ⇒ NEVER spawns", async () => {
    const { port, calls } = fakeExec(() => ok())
    const v = await runCommandHooks(
      gate(),
      { exec: port, permission: allowPermission, cwd: "/tmp" },
      {
        type: "pre_tool_use",
        toolName: "read",
        payload: {},
      },
    )
    expect(calls.length).toBe(0)
    expect(v.deny).toBeNull()
  })

  test("wrong event ⇒ NEVER spawns", async () => {
    const { port, calls } = fakeExec(() => ok())
    await runCommandHooks(
      gate(),
      { exec: port, permission: allowPermission, cwd: "/tmp" },
      {
        type: "post_tool_use",
        toolName: "write",
        payload: {},
      },
    )
    expect(calls.length).toBe(0)
  })
})

// ---- 11. HookBus integration -----------------------------------------------

describe("command hooks — HookBus integration", () => {
  test("armed pre_tool_use command hook denies a tool through the real bus", async () => {
    const bus = new HookBus()
    const gate = normalizeCommandHookGate({
      enabled: true,
      acknowledgedRisk: "ok",
      bindings: [{ event: "PreToolUse", matcher: "write", command: "deny.sh" }],
    })
    const { port } = fakeExec(() => ({ stdout: "", stderr: "", exitCode: 1, timedOut: false }))
    installCommandHooks(bus, gate, { exec: port, permission: allowPermission, cwd: "/tmp" })
    const res = await bus.emit({ type: "pre_tool_use", name: "write", input: { path: "x" } })
    expect(res.deny).not.toBeNull()
    expect(res.deny?.deny).toContain("exited 1")
  })

  test("armed pre_tool_use command hook rewrites input through the real bus", async () => {
    const bus = new HookBus()
    const gate = normalizeCommandHookGate({
      enabled: true,
      acknowledgedRisk: "ok",
      bindings: [{ event: "PreToolUse", command: "rewrite.sh" }],
    })
    const { port } = fakeExec(() => ok(JSON.stringify({ updatedInput: { path: "/canon" } })))
    installCommandHooks(bus, gate, { exec: port, permission: allowPermission, cwd: "/tmp" })
    const res = await bus.emit({ type: "pre_tool_use", name: "write", input: { path: "raw" } })
    expect(res.deny).toBeNull()
    expect(res.updatedInput).toEqual({ path: "/canon" })
  })

  test("armed PostCompact command hook consumes real post_compact provenance through the bus", async () => {
    const bus = new HookBus()
    const gate = normalizeCommandHookGate({
      enabled: true,
      acknowledgedRisk: "operator approved compaction observer",
      bindings: [{ event: "PostCompact", command: "observe-compact.sh" }],
    })
    const { port, calls } = fakeExec(() => ok())
    installCommandHooks(bus, gate, { exec: port, permission: allowPermission, cwd: "/tmp" })

    await bus.emit({
      type: "post_compact",
      threadId: "thread-42",
      provenance: {
        reason: "token_budget_exceeded",
        tokensBefore: 12_000,
        tokensAfter: 2_000,
        turnsDropped: 3,
        turnsKept: 2,
        summaryRef: "summary-42",
        resumeStep: "resume work",
        compactedAt: 42,
      },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe("observe-compact.sh")
    expect(JSON.parse(calls[0]?.stdinJson ?? "{}")).toMatchObject({
      hook_event_name: "post_compact",
      payload: {
        type: "post_compact",
        threadId: "thread-42",
        provenance: { reason: "token_budget_exceeded" },
      },
    })
  })
})

// ---- settings loader -------------------------------------------------------

describe("command hooks — settings loader parse", () => {
  test("parses Claude settings.json#hooks shape into flat bindings", () => {
    const text = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Write|Edit",
            hooks: [
              { type: "command", command: "lint.sh" },
              { type: "command", command: "scan.sh" },
              { type: "other", command: "ignored.sh" },
            ],
          },
        ],
      },
    })
    const bindings = parseCommandHookBindings(text)
    expect(bindings.length).toBe(2)
    expect(bindings[0]).toEqual({ event: "PreToolUse", command: "lint.sh", matcher: "Write|Edit" })
    expect(bindings.map((b) => b.command)).toEqual(["lint.sh", "scan.sh"])
  })

  test("malformed JSON ⇒ empty (never throws)", () => {
    expect(parseCommandHookBindings("{not json")).toEqual([])
  })

  test("absent hooks block ⇒ empty", () => {
    expect(parseCommandHookBindings(JSON.stringify({ other: 1 }))).toEqual([])
  })

  test("empty/whitespace command dropped (no signal)", () => {
    const text = JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "  " }] }] },
    })
    expect(parseCommandHookBindings(text)).toEqual([])
  })
})
