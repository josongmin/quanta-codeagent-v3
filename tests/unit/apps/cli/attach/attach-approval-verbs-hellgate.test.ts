/**
 * ★ HELLGATE — Wave-4 verbs cluster (jul-10 uiux structural), attach surface:
 *
 *   UUX-1-19 — attach approval verbs. The attach prompt was y/N-only while the
 *   wire (`ApprovalRespondCommand`) already carries `scope` + `steer` and the
 *   kernel scheduler forwards BOTH to `host.resolveApproval`. The prompt now
 *   offers [y]/[a]lways-session/[N]/deny+s[t]eer and the client sends the rich
 *   decision on the wire.
 *
 *   C3 (mitigation) — queued-line claim inversion: a line the operator typed
 *   BEFORE the approval prompt rendered must flow to the SESSION, never be
 *   eaten as the prompt's answer. `createApprovalLineGate` tracks line-arrival
 *   order vs prompt-render order; `claimApprovalLine` consults it.
 */

import { describe, expect, test } from "bun:test"
import { type AttachSocket, type AttachSocketCtor, attachToDaemon } from "@/apps/cli/attach"
import { buildChannelApprovalPrompt, createApprovalLineGate } from "@/apps/cli/attach-cmd"
import { createMidTurnApprovalChannel } from "@/apps/cli/repl/mid-turn-approval-channel"
import {
  encodeSessionTransportMessage,
  type SessionTransportMessage,
  tryDecodeSessionTransportMessage,
} from "@/ipc/session"
import type { SessionEvent } from "@/protocol/session"

const captureStderr = async (fn: () => Promise<unknown>): Promise<string> => {
  const orig = process.stderr.write.bind(process.stderr)
  let buf = ""
  process.stderr.write = ((chunk: unknown) => {
    buf += String(chunk)
    return true
  }) as typeof process.stderr.write
  try {
    await fn()
  } finally {
    process.stderr.write = orig
  }
  return buf
}

/** Drive the prompt with a scripted line sequence via the REAL channel. */
const drivePrompt = async (
  reason: string,
  lines: readonly string[],
): Promise<{ answer: unknown; out: string }> => {
  const channel = createMidTurnApprovalChannel()
  channel.active = true
  const gate = createApprovalLineGate(channel)
  const prompt = buildChannelApprovalPrompt(channel, gate)
  let answer: unknown
  const out = await captureStderr(async () => {
    const run = prompt(reason)
    for (const line of lines) {
      // Let the prompt arm its waiter, then type.
      await new Promise((r) => setTimeout(r, 1))
      gate.noteLineArrival()
      expect(gate.claim(line)).toBe(true)
    }
    answer = await run
  })
  return { answer, out }
}

// ── UUX-1-19 — verb upgrade ──────────────────────────────────────────────────

describe("HELLGATE UUX-1-19 — attach approval verbs (wire carries scope+steer)", () => {
  test("RED pin: the prompt offers [a]lways session and deny+s[t]eer (not y/N-only)", async () => {
    const { out } = await drivePrompt("run git push", ["y"])
    expect(out).toContain("[a]lways session")
    expect(out).toContain("deny+s[t]eer")
  })

  test("'y' ⇒ {decision:'approve'}", async () => {
    const { answer } = await drivePrompt("run git push", ["y"])
    expect(answer).toEqual({ decision: "approve" })
  })

  test("'a' ⇒ {decision:'approve', scope:'session'} — the wire's standing-grant verb", async () => {
    const { answer } = await drivePrompt("run git push", ["a"])
    expect(answer).toEqual({ decision: "approve", scope: "session" })
  })

  test("empty answer ⇒ fail-closed plain deny", async () => {
    const { answer } = await drivePrompt("run git push", [""])
    expect(answer).toEqual({ decision: "deny" })
  })

  test("'t' + steer text ⇒ {decision:'deny', steer} — the steer survives to the wire shape", async () => {
    const { answer } = await drivePrompt("run git push", ["t", "use --dry-run first"])
    expect(answer).toEqual({ decision: "deny", steer: "use --dry-run first" })
  })

  test("UUX-2-18 attach half: empty steer re-prompts once, then carries the retyped steer", async () => {
    const { answer, out } = await drivePrompt("run git push", ["t", "", "push to a fork instead"])
    expect(out).toContain("steer text required (or N to deny)")
    expect(answer).toEqual({ decision: "deny", steer: "push to a fork instead" })
  })

  test("UUX-2-18 attach half: empty steer twice ⇒ plain deny (no phantom steer)", async () => {
    const { answer } = await drivePrompt("run git push", ["t", "", ""])
    expect(answer).toEqual({ decision: "deny" })
  })

  test("a typed channel RELEASE mid-prompt ⇒ fail-closed deny", async () => {
    const channel = createMidTurnApprovalChannel()
    channel.active = true
    const gate = createApprovalLineGate(channel)
    const prompt = buildChannelApprovalPrompt(channel, gate)
    let answer: unknown
    await captureStderr(async () => {
      const run = prompt("run rm -rf")
      await new Promise((r) => setTimeout(r, 1))
      channel.clear("turn_teardown")
      answer = await run
    })
    expect(answer).toEqual({ decision: "deny" })
  })
})

// ── attach-client: rich answer → wire ────────────────────────────────────────

type Listeners = {
  message: Array<(event: { data: unknown }) => void>
  open: Array<() => void>
  close: Array<() => void>
  error: Array<() => void>
}

interface FakeSocket extends AttachSocket {
  readonly sent: SessionTransportMessage[]
  deliver(message: SessionTransportMessage): void
  fireOpen(): void
}

const makeFakeSocket = (): FakeSocket => {
  const listeners: Listeners = { message: [], open: [], close: [], error: [] }
  const sent: SessionTransportMessage[] = []
  let readyState = 0
  return {
    get readyState() {
      return readyState
    },
    send(data: string) {
      const msg = tryDecodeSessionTransportMessage(data)
      if (msg !== undefined) sent.push(msg)
    },
    close() {
      readyState = 3
    },
    addEventListener(type: "message" | "open" | "close" | "error", handler: never) {
      ;(listeners[type] as unknown[]).push(handler)
    },
    removeEventListener(type, handler) {
      const bucket = listeners[type]
      const idx = bucket.indexOf(handler as never)
      if (idx >= 0) bucket.splice(idx, 1)
    },
    sent,
    deliver(message) {
      const data = encodeSessionTransportMessage(message)
      for (const h of [...listeners.message]) h({ data })
    },
    fireOpen() {
      readyState = 1
      for (const h of [...listeners.open]) h()
    },
  }
}

const snapshotMsg = (sid: string): SessionTransportMessage => ({
  kind: "snapshot",
  snapshot: {
    sessionId: sid,
    revision: 1,
    seq: 1,
    state: { status: "idle", draftInput: "", permissionMode: "default", messageCount: 0 },
    capabilities: {
      approvals: "none",
      tools: false,
      memory: false,
      artifacts: false,
      subagents: false,
      automation: false,
      shellSnapshot: false,
      transport: "websocket",
    },
    pendingApproval: null,
    openArtifacts: [],
  },
})

const approvalEvent = (approvalId: string): SessionTransportMessage => ({
  kind: "event",
  event: {
    eventId: `e-${approvalId}`,
    seq: 5,
    revision: 1,
    emittedAt: "t",
    type: "approval.requested",
    approval: { approvalId, reason: "run git push", requestedAt: "t" },
  } as SessionEvent,
})

const parkedStdin = (): AsyncIterable<string> =>
  (async function* () {
    await new Promise<void>(() => {})
  })()

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))

const attachWithPrompter = async (
  sid: string,
  promptApproval: (reason: string) => Promise<never>,
): Promise<{ socket: FakeSocket; close: () => Promise<void> }> => {
  const socket = makeFakeSocket()
  const ctor = function (this: unknown, _url: string) {
    return socket
  } as unknown as AttachSocketCtor
  const session = await attachToDaemon({
    url: "ws://127.0.0.1:0/",
    stdin: parkedStdin(),
    write: () => undefined,
    promptApproval: promptApproval as never,
    webSocketCtor: ctor,
  })
  socket.fireOpen()
  socket.deliver(snapshotMsg(sid))
  await flush()
  return { socket, close: () => session.close() }
}

const commandsOf = (socket: FakeSocket) =>
  socket.sent.flatMap((m) => (m.kind === "command" ? [m.command] : []))

describe("HELLGATE UUX-1-19 — attach client sends the RICH decision on the wire", () => {
  test("approve+session reaches approval.respond with scope INTACT, then re-runs the turn", async () => {
    const { socket, close } = await attachWithPrompter("rich-1", (async () => ({
      decision: "approve",
      scope: "session",
    })) as never)
    socket.deliver(approvalEvent("ap-rich"))
    await flush()
    const cmds = commandsOf(socket)
    const respond = cmds.find((c) => c.type === "approval.respond")
    expect(respond).toBeDefined()
    if (respond?.type !== "approval.respond") throw new Error("narrow")
    expect(respond.decision).toBe("approve")
    expect(respond.scope).toBe("session")
    // approve ⇒ a bare turn.run claims the grant (web parity).
    const idx = cmds.indexOf(respond)
    expect(cmds.slice(idx + 1).some((c) => c.type === "turn.run")).toBe(true)
    await close()
  })

  test("deny+steer reaches approval.respond with the steer INTACT and does NOT re-run", async () => {
    const { socket, close } = await attachWithPrompter("rich-2", (async () => ({
      decision: "deny",
      steer: "use --dry-run first",
    })) as never)
    socket.deliver(approvalEvent("ap-steer"))
    await flush()
    const cmds = commandsOf(socket)
    const respond = cmds.find((c) => c.type === "approval.respond")
    expect(respond).toBeDefined()
    if (respond?.type !== "approval.respond") throw new Error("narrow")
    expect(respond.decision).toBe("deny")
    expect(respond.steer).toBe("use --dry-run first")
    const idx = cmds.indexOf(respond)
    expect(cmds.slice(idx + 1).some((c) => c.type === "turn.run")).toBe(false)
    await close()
  })

  test("LEGACY compat: a string 'y' answer still approves (old prompter shape)", async () => {
    const { socket, close } = await attachWithPrompter("legacy-1", (async () => "y") as never)
    socket.deliver(approvalEvent("ap-legacy"))
    await flush()
    const respond = commandsOf(socket).find((c) => c.type === "approval.respond")
    if (respond?.type !== "approval.respond") throw new Error("narrow")
    expect(respond.decision).toBe("approve")
    expect(respond.scope).toBeUndefined()
    await close()
  })

  test("a THROWING prompter still fail-safes to a plain deny", async () => {
    const { socket, close } = await attachWithPrompter("throw-1", (async () => {
      throw new Error("tty exploded")
    }) as never)
    socket.deliver(approvalEvent("ap-throw"))
    await flush()
    const respond = commandsOf(socket).find((c) => c.type === "approval.respond")
    if (respond?.type !== "approval.respond") throw new Error("narrow")
    expect(respond.decision).toBe("deny")
    expect(respond.steer).toBeUndefined()
    await close()
  })
})

// ── WIRING — runAttachCmd threads prompt + claim through the SAME gate ───────

describe("HELLGATE — runAttachCmd wires the verb prompt and the claim gate together", () => {
  test("the wired promptApproval resolves the RICH shape and the wired claim answers it", async () => {
    const { runAttachCmd } = await import("@/apps/cli/attach-cmd")
    let captured:
      | {
          promptApproval: (reason: string) => Promise<unknown>
          claimApprovalLine?: (line: string) => boolean
        }
      | undefined
    const code = await runAttachCmd([], {
      attach: (async (opts: never) => {
        captured = opts
        return {
          sessionId: "wire-1",
          done: Promise.resolve(),
          close: async () => undefined,
        }
      }) as never,
    })
    expect(code).toBe(0)
    expect(captured).toBeDefined()
    expect(captured?.claimApprovalLine).toBeDefined()
    // No prompt visible ⇒ the wired claim lets a line flow to the session.
    expect(captured?.claimApprovalLine?.("hello agent")).toBe(false)
    // Render the prompt, answer through the wired claim, get the RICH shape —
    // this proves promptApproval and claimApprovalLine share ONE channel+gate.
    const out = await captureStderr(async () => {
      const run = captured?.promptApproval("run git push")
      await new Promise((r) => setTimeout(r, 1))
      expect(captured?.claimApprovalLine?.("a")).toBe(true)
      expect(await run).toEqual({ decision: "approve", scope: "session" })
    })
    expect(out).toContain("deny+s[t]eer")
  })
})

// ── C3 — queued-line claim inversion (mitigation) ────────────────────────────

describe("HELLGATE C3 — a line typed BEFORE the approval prompt rendered is NOT eaten", () => {
  test("AUDIT SCENARIO: queued-before-render line flows to the session; the next line answers", async () => {
    const channel = createMidTurnApprovalChannel()
    channel.active = true
    const gate = createApprovalLineGate(channel)
    const prompt = buildChannelApprovalPrompt(channel, gate)

    // Operator typed a line; it is QUEUED (arrival noted) before any approval.
    gate.noteLineArrival() // "deploy the staging build"

    // approval.requested arrives → prompt renders → waiter pends.
    let answer: unknown
    await captureStderr(async () => {
      const run = prompt("run rm -rf")
      await new Promise((r) => setTimeout(r, 1))

      // The read loop now pulls the OLD queued line: it must NOT be eaten even
      // though a waiter is pending (this is exactly the inversion bug).
      expect(gate.claim("deploy the staging build")).toBe(false)

      // The operator's NEXT line (typed after the prompt) answers it.
      gate.noteLineArrival()
      expect(gate.claim("y")).toBe(true)
      answer = await run
    })
    expect(answer).toEqual({ decision: "approve" })
  })

  test("no prompt visible ⇒ never claims (lines always flow to the session)", () => {
    const channel = createMidTurnApprovalChannel()
    channel.active = true
    const gate = createApprovalLineGate(channel)
    gate.noteLineArrival()
    expect(gate.claim("hello agent")).toBe(false)
  })

  test("after the prompt is ANSWERED, later lines flow to the session again", async () => {
    const channel = createMidTurnApprovalChannel()
    channel.active = true
    const gate = createApprovalLineGate(channel)
    const prompt = buildChannelApprovalPrompt(channel, gate)
    await captureStderr(async () => {
      const run = prompt("run git push")
      await new Promise((r) => setTimeout(r, 1))
      gate.noteLineArrival()
      expect(gate.claim("y")).toBe(true)
      await run
    })
    gate.noteLineArrival()
    expect(gate.claim("next user turn")).toBe(false)
  })

  test("C2 re-verification: OVERLAPPING approvals — second renders at promotion, its answer claimed (no anchor clobber)", async () => {
    const channel = createMidTurnApprovalChannel()
    channel.active = true
    const gate = createApprovalLineGate(channel)
    const prompt = buildChannelApprovalPrompt(channel, gate)
    let a: unknown
    let b: unknown
    const out = await captureStderr(async () => {
      const runA = prompt("first ask")
      const runB = prompt("second ask") // C2: queues behind A (no supersede)
      await new Promise((r) => setTimeout(r, 1))
      gate.noteLineArrival()
      expect(gate.claim("y")).toBe(true) // answers A; B promotes + renders
      a = await runA // A's finally (markPromptAnswered) runs — must NOT clobber B's anchor
      gate.noteLineArrival()
      expect(gate.claim("a")).toBe(true) // typed after B's render ⇒ claimed for B
      b = await runB
    })
    expect(a).toEqual({ decision: "approve" })
    expect(b).toEqual({ decision: "approve", scope: "session" })
    // Render ordering: B's prompt appears strictly AFTER A's (head activation),
    // never interleaved while A was unanswered.
    const aIdx = out.indexOf('Approve "first ask"?')
    const bIdx = out.indexOf('Approve "second ask"?')
    expect(aIdx).toBeGreaterThanOrEqual(0)
    expect(bIdx).toBeGreaterThan(aIdx)
  })

  test("a PASTED 't\\n<steer>' burst is fully claimed by the prompt (steer prompt does not reset the gate)", async () => {
    const channel = createMidTurnApprovalChannel()
    channel.active = true
    const gate = createApprovalLineGate(channel)
    const prompt = buildChannelApprovalPrompt(channel, gate)
    let answer: unknown
    await captureStderr(async () => {
      const run = prompt("run git push")
      await new Promise((r) => setTimeout(r, 1))
      // Both lines arrive before the steer sub-prompt renders (paste).
      gate.noteLineArrival()
      gate.noteLineArrival()
      expect(gate.claim("t")).toBe(true)
      await new Promise((r) => setTimeout(r, 1))
      expect(gate.claim("fix the config instead")).toBe(true)
      answer = await run
    })
    expect(answer).toEqual({ decision: "deny", steer: "fix the config instead" })
  })
})
