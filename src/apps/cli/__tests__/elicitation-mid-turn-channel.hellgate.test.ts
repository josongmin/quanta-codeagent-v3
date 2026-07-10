/**
 * ★ HELLGATE — WS-B (jul-10 uiux structural, UUX-1-05): a MID-TURN elicitation
 *   / ask_user read rides the session's single line source, never a second
 *   readline.
 *
 * Pinned bug: the CLI elicitation prompter opened its own
 * `readline.createInterface(process.stdin, …)` unconditionally. While a turn
 * streams, the in-turn reader owns stdin in raw mode — the second consumer
 * fought it, the question never received a usable line, and the ask
 * fail-closed ("입력창이 안 떠서" class, same root the approval prompts had).
 *
 * Contract under test:
 *   1. With the session channel REGISTERED and ACTIVE, the elicitation read
 *      resolves from the channel's routed line — no readline involved.
 *   2. A typed channel RELEASE (turn ended, ask unanswered) maps to `null`
 *      (the cancellation the retry wrapper already handles) — never a fake "".
 *   3. Channel inactive (between turns) ⇒ the legacy readline path is used
 *      (not exercised here — it needs a real stdin; the branch is pinned by
 *      the channel-active tests resolving WITHOUT stdin).
 */
import { describe, expect, test } from "bun:test"
import {
  buildCliElicitationPrompterFactory,
  readViaMidTurnChannelOrReadline,
} from "@/apps/cli/mcp-elicitation-prompter"
import {
  createMidTurnApprovalChannel,
  registerMidTurnApprovalChannel,
} from "@/apps/cli/repl/mid-turn-approval-channel"

describe("HELLGATE WS-B — elicitation rides the mid-turn channel", () => {
  test("active channel: the routed line resolves the elicitation read (no stdin)", async () => {
    const ch = createMidTurnApprovalChannel()
    registerMidTurnApprovalChannel(ch)
    ch.active = true
    const read = readViaMidTurnChannelOrReadline(new AbortController().signal)
    expect(ch.tryResolve("blue")).toBe(true)
    expect(await read).toBe("blue")
    ch.active = false
  })

  test("typed release (turn teardown) maps to null — cancellation, not a fake empty answer", async () => {
    const ch = createMidTurnApprovalChannel()
    registerMidTurnApprovalChannel(ch)
    ch.active = true
    const read = readViaMidTurnChannelOrReadline(new AbortController().signal)
    ch.clear("turn_teardown")
    expect(await read).toBeNull()
    ch.active = false
  })

  test("audit W3-C1: abort MID-AWAIT releases the waiter — the next line is NOT claimed by the dead ask", async () => {
    const ch = createMidTurnApprovalChannel()
    registerMidTurnApprovalChannel(ch)
    ch.active = true
    const ctrl = new AbortController()
    const read = readViaMidTurnChannelOrReadline(ctrl.signal)
    ctrl.abort() // MCP-side cancel while awaiting
    expect(await read).toBeNull()
    // The operator's next line must flow to normal routing, not the dead ask.
    expect(ch.tryResolve("my real follow-up")).toBe(false)
    ch.active = false
  })

  test("audit W3-C1: a QUEUED waiter is NOT clobbered by the aborted head's stale signal", async () => {
    const ch = createMidTurnApprovalChannel()
    registerMidTurnApprovalChannel(ch)
    ch.active = true
    const ctrl = new AbortController()
    const first = readViaMidTurnChannelOrReadline(ctrl.signal)
    const second = ch.awaitLine() // C2: queues BEHIND the elicitation (no supersede)
    ctrl.abort() // consumer cancel releases ONLY the elicitation waiter
    expect(await first).toBeNull()
    ch.tryResolve("for-second")
    expect(await second).toEqual({ kind: "line", line: "for-second" })
    ch.active = false
  })

  test("C2 (jul-10 audit): concurrent approval + elicitation asks are SERIALIZED — both answered, none lost", async () => {
    const ch = createMidTurnApprovalChannel()
    registerMidTurnApprovalChannel(ch)
    ch.active = true
    // An approval ask is pending FIRST; an elicitation arrives while it waits.
    const approval = ch.awaitLine(undefined, "approval")
    const elicitation = readViaMidTurnChannelOrReadline(new AbortController().signal)
    // The old one-waiter channel released the approval as a fail-closed deny
    // here — the operator LOST an ask. Queue: first routed line → approval.
    expect(ch.tryResolve("y")).toBe(true)
    expect(await approval).toEqual({ kind: "line", line: "y" })
    // Second routed line → elicitation. Order preserved, nothing destroyed.
    expect(ch.tryResolve("blue")).toBe(true)
    expect(await elicitation).toBe("blue")
    ch.active = false
  })

  test("already-aborted signal short-circuits to null without consuming the channel", async () => {
    const ch = createMidTurnApprovalChannel()
    registerMidTurnApprovalChannel(ch)
    ch.active = true
    const ctrl = new AbortController()
    ctrl.abort()
    expect(await readViaMidTurnChannelOrReadline(ctrl.signal)).toBeNull()
    // The channel has NO dangling waiter: a later line is not consumed.
    expect(ch.tryResolve("stray")).toBe(false)
    ch.active = false
  })

  test("C2 render ordering: the PRODUCTION prompter io HOLDS a queued elicitation's prompt text until it becomes head", async () => {
    const ch = createMidTurnApprovalChannel()
    registerMidTurnApprovalChannel(ch)
    ch.active = true
    const orig = process.stderr.write.bind(process.stderr)
    let out = ""
    process.stderr.write = ((chunk: unknown) => {
      out += String(chunk)
      return true
    }) as typeof process.stderr.write
    try {
      // The DEFAULT interactive io (no test io injected) — this pins the real
      // write-buffer wiring, not just the readVia seam.
      const factory = buildCliElicitationPrompterFactory({ interactive: true })
      if (factory === undefined) throw new Error("factory must exist when interactive")
      const prompter = factory("srv-1")
      const approval = ch.awaitLine(undefined, "approval") // approval holds the head
      const asked = prompter.promptString({ prompt: "Favorite color" })
      await new Promise((r) => setTimeout(r, 1))
      // Queued behind the approval ⇒ the question is NOT on screen yet.
      expect(out).not.toContain("Favorite color")
      expect(ch.tryResolve("y")).toBe(true) // approval answered ⇒ elicitation head
      expect(await approval).toEqual({ kind: "line", line: "y" })
      expect(out).toContain("Favorite color") // rendered at promotion
      expect(ch.tryResolve("blue")).toBe(true)
      expect(await asked).toEqual({ ok: true, value: "blue" })
    } finally {
      process.stderr.write = orig
      ch.active = false
    }
  })
})
