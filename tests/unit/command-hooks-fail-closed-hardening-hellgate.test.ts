/**
 * HELLGATE — command-hook fail-closed boundary hardening (DOF-40, SECURITY).
 *
 * Command hooks execute ARBITRARY operator shell on HookBus events. This is the
 * highest-risk mutating/security feature under the default-OFF SOTA++ board.
 * These proofs make the fail-closed boundary BULLETPROOF: silent execution of
 * an unacknowledged / misconfigured hook must be impossible, and the ONE
 * unbounded surface (the JSON we write to the arbitrary-shell child's stdin) is
 * now capped. ALL exec goes through a FAKE spawn port — NO real shell runs in
 * CI.
 *
 * The load-bearing controls (each a SEPARATE assertion):
 *   FC-1  enabled + EMPTY ack ⇒ THROWS at config time (not silently disabled),
 *         and the throw fires BEFORE any handler is armed on the bus.
 *   FC-2  armed-toggle default (enabled + ack but ZERO bindings) ⇒ the spawn
 *         port is NOT called (no exec until a binding is explicitly configured).
 *   FC-3  unset config ⇒ ZERO HookBus subscription (byte-identical, no handler).
 *
 * ON-proof (the real path): arm a hook through the real config → gate →
 * installCommandHooks → HookBus.emit chain and assert the INJECTED spawn port
 * receives the EXACT event (command verbatim + payload only on stdin JSON).
 *
 * STDIN-BOUND (the new hardening): a pathological / oversized payload can never
 * produce an unbounded stdin write — the envelope is capped at the gate's IO
 * bound; over-cap ⇒ payload dropped, `payload_truncated:true` marker, hook
 * still fires (fail-safe, bounded). Red-on-injection proves the cap is live.
 *
 * Source under test: src/agent/command-hooks/{gate,runner,install}.ts.
 */

import { describe, expect, test } from "bun:test"
import {
  COMMAND_HOOKS_ENABLED_WITHOUT_ACK_MESSAGE,
  type CommandHookConfig,
  CommandHookConfigError,
  type CommandHookExecOpts,
  type CommandHookExecPort,
  type CommandHookExecResult,
  type CommandHookPermissionPort,
  HookBus,
  installCommandHooks,
  normalizeCommandHookGate,
  runCommandHooks,
} from "@/agent"
import { nth } from "../_helpers/expect-present"

// ---- fake spawn port (records exactly what the child would receive) ---------

interface RecordedCall {
  readonly command: string
  readonly stdinJson: string
  readonly maxOutputBytes: number
}

const recordingExec = (
  reply: (opts: CommandHookExecOpts) => CommandHookExecResult = () => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
  }),
): { port: CommandHookExecPort; calls: RecordedCall[] } => {
  const calls: RecordedCall[] = []
  return {
    calls,
    port: {
      exec: async (opts) => {
        calls.push({
          command: opts.command,
          stdinJson: opts.stdinJson,
          maxOutputBytes: opts.maxOutputBytes,
        })
        return reply(opts)
      },
    },
  }
}

const allow: CommandHookPermissionPort = { isAllowed: () => true }

/** The canonical "operator armed it correctly" config. */
const ARMED_CONFIG: CommandHookConfig = {
  enabled: true,
  acknowledgedRisk: "operator explicitly acknowledged arbitrary-shell hooks",
  bindings: [{ event: "PreToolUse", matcher: "write", command: "policy-guard.sh --strict" }],
}

// ---- ON-PROOF — real config→gate→bus→port, exact event delivered -----------

describe("command-hooks ON-proof (real HookBus path, injected spawn port)", () => {
  test("armed hook fires through HookBus.emit; spawn port gets the EXACT event", async () => {
    // Real chain: normalize the operator config → install onto a real HookBus →
    // emit a real pre_tool_use event → assert the injected port ran the exact
    // command with the payload delivered ONLY on stdin.
    const gate = normalizeCommandHookGate(ARMED_CONFIG)
    expect(gate.armed).toBe(true)

    const bus = new HookBus()
    const { port, calls } = recordingExec(() => ({
      stdout: JSON.stringify({ decision: "block", reason: "denied by policy" }),
      stderr: "",
      exitCode: 0,
      timedOut: false,
    }))
    installCommandHooks(bus, gate, { exec: port, permission: allow, cwd: "/repo" })

    const res = await bus.emit({
      type: "pre_tool_use",
      name: "write",
      input: { path: "/etc/passwd", contents: "x" },
    })

    // The injected spawn port — and ONLY it — executed the hook.
    expect(calls.length).toBe(1)
    const call = nth(calls, 0, "call")
    // Command is the operator config VERBATIM (never concatenated with payload).
    expect(call.command).toBe("policy-guard.sh --strict")
    // The tool input reaches the child ONLY as JSON on stdin.
    const envelope = JSON.parse(call.stdinJson)
    expect(envelope.hook_event_name).toBe("pre_tool_use")
    expect(envelope.tool_name).toBe("write")
    expect(envelope.payload.input.path).toBe("/etc/passwd")
    // The command string carries none of the payload.
    expect(call.command).not.toContain("passwd")
    // The verdict round-trips back through the real bus.
    expect(res.deny?.deny).toBe("denied by policy")
  })
})

// ---- FC-1 — enabled + empty ack THROWS, and BEFORE arming ------------------

describe("FC-1 — enabled without non-empty ack fails closed at config time", () => {
  test("empty-string ack ⇒ THROWS the exact contract message (not silently disabled)", () => {
    let threw: unknown
    try {
      normalizeCommandHookGate({ ...ARMED_CONFIG, acknowledgedRisk: "" })
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(CommandHookConfigError)
    expect((threw as Error).message).toBe(COMMAND_HOOKS_ENABLED_WITHOUT_ACK_MESSAGE)
  })

  test("missing ack ⇒ THROWS (not a silently-disarmed gate)", () => {
    expect(() =>
      normalizeCommandHookGate({
        enabled: true,
        bindings: [{ event: "PreToolUse", command: "x.sh" }],
      }),
    ).toThrow(CommandHookConfigError)
  })

  test("the throw fires BEFORE any handler is armed on the bus (fail-fast, never mid-turn)", async () => {
    const bus = new HookBus()
    const { port, calls } = recordingExec()
    // Simulate the composition-root order: normalize THEN install. The throw
    // must happen at normalize — installCommandHooks is never reached, so the
    // bus has zero handlers and a subsequent emit spawns nothing.
    let installed = false
    expect(() => {
      const gate = normalizeCommandHookGate({ ...ARMED_CONFIG, acknowledgedRisk: "   " })
      // Unreachable — proves arming happens strictly after the (throwing) gate.
      installCommandHooks(bus, gate, { exec: port, permission: allow, cwd: "/repo" })
      installed = true
    }).toThrow(CommandHookConfigError)
    expect(installed).toBe(false)
    const res = await bus.emit({ type: "pre_tool_use", name: "write", input: {} })
    expect(res).toEqual({ deny: null })
    expect(calls.length).toBe(0)
  })
})

// ---- FC-2 — armed-toggle default: no binding ⇒ no spawn --------------------

describe("FC-2 — armed toggle with no binding does not spawn", () => {
  test("enabled + valid ack + ZERO bindings ⇒ disarmed, spawn port NOT called", async () => {
    const gate = normalizeCommandHookGate({
      enabled: true,
      acknowledgedRisk: "acknowledged, but no bindings for this repo",
      bindings: [],
    })
    // Ack preserved for audit, but NOT armed — nothing to run yet.
    expect(gate.armed).toBe(false)
    expect(gate.acknowledgedRisk).toBe("acknowledged, but no bindings for this repo")

    const bus = new HookBus()
    const { port, calls } = recordingExec()
    installCommandHooks(bus, gate, { exec: port, permission: allow, cwd: "/repo" })
    await bus.emit({ type: "pre_tool_use", name: "write", input: {} })
    expect(calls.length).toBe(0)
  })
})

// ---- FC-3 — unset config ⇒ zero HookBus subscription -----------------------

describe("FC-3 — unset config subscribes nothing", () => {
  test("undefined config ⇒ disarmed ⇒ installCommandHooks registers NO handler", async () => {
    const gate = normalizeCommandHookGate(undefined)
    expect(gate.armed).toBe(false)

    const bus = new HookBus()
    const { port, calls } = recordingExec()
    const returned = installCommandHooks(bus, gate, {
      exec: port,
      permission: allow,
      cwd: "/repo",
    })
    expect(returned).toBe(bus)
    // Byte-identical to a bus with no command hooks: emit spawns nothing.
    const res = await bus.emit({ type: "pre_tool_use", name: "write", input: { a: 1 } })
    expect(res).toEqual({ deny: null })
    expect(calls.length).toBe(0)
  })
})

// ---- STDIN-BOUND — the new hardening ---------------------------------------

describe("stdin bound — oversized payload never produces an unbounded stdin write", () => {
  const smallCapGate = () =>
    normalizeCommandHookGate({
      ...ARMED_CONFIG,
      bindings: [{ event: "PreToolUse", command: "observe.sh" }],
      // Tiny IO cap so a modest payload trips the bound deterministically.
      maxOutputBytes: 256,
    })

  test("over-cap payload ⇒ payload DROPPED, truncation marker set, hook still fires", async () => {
    const gate = smallCapGate()
    expect(gate.maxOutputBytes).toBe(256)
    const { port, calls } = recordingExec()
    // A payload far larger than the 256B cap.
    const huge = { input: { blob: "A".repeat(50_000) } }
    const verdict = await runCommandHooks(
      gate,
      { exec: port, permission: allow, cwd: "/repo" },
      { type: "pre_tool_use", toolName: "write", payload: huge },
    )
    // The hook STILL fired (fail-safe) ...
    expect(calls.length).toBe(1)
    const call = nth(calls, 0, "call")
    // ... but the stdin write is BOUNDED — never the 50KB payload.
    expect(Buffer.byteLength(call.stdinJson, "utf8")).toBeLessThanOrEqual(gate.maxOutputBytes)
    const envelope = JSON.parse(call.stdinJson)
    // Event type / tool name preserved so the hook can still branch.
    expect(envelope.hook_event_name).toBe("pre_tool_use")
    expect(envelope.tool_name).toBe("write")
    // The oversized payload is DROPPED and explicitly marked.
    expect(envelope.payload).toBeNull()
    expect(envelope.payload_truncated).toBe(true)
    // The 50KB blob never reached the child's stdin.
    expect(call.stdinJson).not.toContain("AAAA")
    expect(verdict.deny).toBeNull()
  })

  test("within-cap payload ⇒ delivered in FULL (bound does not over-trigger)", async () => {
    const gate = smallCapGate()
    const { port, calls } = recordingExec()
    const small = { input: { path: "/x" } }
    await runCommandHooks(
      gate,
      { exec: port, permission: allow, cwd: "/repo" },
      { type: "pre_tool_use", toolName: "write", payload: small },
    )
    const envelope = JSON.parse(nth(calls, 0, "calls").stdinJson)
    // Full payload present, NO truncation marker.
    expect(envelope.payload.input.path).toBe("/x")
    expect("payload_truncated" in envelope).toBe(false)
  })

  test("RED-ON-INJECTION — a payload just over the cap is bounded (guards against a lifted cap)", async () => {
    // This asserts the cap is LOAD-BEARING: if the bound in serializePayload is
    // removed/disabled, the full oversized envelope flows to stdin and this
    // assertion (bytes ≤ cap AND payload dropped) goes RED.
    const gate = smallCapGate()
    const { port, calls } = recordingExec()
    // Just over 256B once wrapped in the envelope.
    const overshoot = { input: { s: "x".repeat(400) } }
    await runCommandHooks(
      gate,
      { exec: port, permission: allow, cwd: "/repo" },
      { type: "pre_tool_use", toolName: "write", payload: overshoot },
    )
    const call = nth(calls, 0, "call")
    expect(Buffer.byteLength(call.stdinJson, "utf8")).toBeLessThanOrEqual(256)
    expect(JSON.parse(call.stdinJson).payload).toBeNull()
  })
})
