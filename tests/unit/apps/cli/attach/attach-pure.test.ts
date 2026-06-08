/**
 * RED-first unit coverage for the CLI "attach to a running daemon" pure logic
 * (new slice `src/apps/cli/attach`). These tests exercise ONLY the
 * side-effect-free units — the session.v1 connect handshake driver, the
 * SessionEvent→terminal-text renderer, and the stdin-line / approval-answer →
 * SessionCommand builders. The socket/stdin orchestration (`attachToDaemon`)
 * is covered by the e2e test against an ephemeral in-process daemon.
 */

import { describe, expect, test } from "bun:test"
import type { SessionEvent } from "@/protocol/session"
import type { SessionTransportMessage } from "@/ipc/session"
import {
  buildApprovalRespondCommand,
  buildLineCommands,
  createAttachHandshake,
  renderSessionEvent,
} from "@/apps/cli/attach"

const HANDSHAKE_DISCOVERY_SESSION_ID = "ui-session"

const event = <T extends SessionEvent>(e: T): T => e

describe("attach handshake (discovery → adopt canonical sessionId)", () => {
  test("first connect frame carries the discovery sentinel (no canonical id yet)", () => {
    const hs = createAttachHandshake()
    const frame = hs.initialConnect()
    expect(frame.kind).toBe("connect")
    if (frame.kind !== "connect") throw new Error("narrow")
    expect(frame.sessionId).toBe(HANDSHAKE_DISCOVERY_SESSION_ID)
    expect(frame.resumeFromSeq).toBeUndefined()
    expect(hs.sessionId).toBeUndefined()
    expect(hs.ready).toBe(false)
  })

  test("a connect-rejected frame carrying the canonical id is adopted + re-handshakes", () => {
    const hs = createAttachHandshake()
    hs.initialConnect()
    const reaction = hs.onMessage({
      kind: "rejected",
      sessionId: "daemon-session-7",
      target: "connect",
      reason: "session_id_mismatch",
    })
    expect(hs.sessionId).toBe("daemon-session-7")
    // It must produce a fresh connect frame addressed to the canonical id.
    expect(reaction?.kind).toBe("connect")
    if (reaction?.kind !== "connect") throw new Error("narrow")
    expect(reaction.sessionId).toBe("daemon-session-7")
    // Still not "ready" — readiness is the snapshot, not the adoption.
    expect(hs.ready).toBe(false)
  })

  // finding #7: this slice has NO reconnect path (a daemon-initiated close now
  // exits the CLI cleanly — see attach-client.test.ts #1). The old "resume
  // cursor / across reconnects" lastSeq machinery implied a capability that was
  // never wired and never consumed. The cursor is removed; these tests pin that
  // (a) the re-handshake after id-adoption carries NO resume cursor even after
  // events have streamed, and (b) the handshake no longer advertises a `lastSeq`.
  test("the re-handshake never carries a resume cursor (no reconnect/resume in v1)", () => {
    const hs = createAttachHandshake()
    hs.initialConnect()
    // Some events stream by (seq 3, 4) — in a reconnect design these would seed
    // a resume cursor. Here there is no reconnect, so they must NOT.
    hs.onMessage({
      kind: "snapshot",
      snapshot: {
        sessionId: "sess-9",
        revision: 1,
        seq: 3,
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
    // A (hypothetical) second connect-reject — the re-handshake frame it emits
    // must still be a BARE connect (no resumeFromSeq), proving the dead cursor
    // is gone.
    const reaction = hs.onMessage({
      kind: "rejected",
      sessionId: "sess-10",
      target: "connect",
      reason: "session_id_mismatch",
    })
    expect(reaction?.kind).toBe("connect")
    if (reaction?.kind !== "connect") throw new Error("narrow")
    expect(reaction.resumeFromSeq).toBeUndefined()
    // The misleading public cursor field is removed — it no longer exists on the
    // type (this cast goes through `unknown` precisely because `lastSeq` is gone
    // from `AttachHandshake`) and is undefined at runtime.
    expect((hs as unknown as Record<string, unknown>).lastSeq).toBeUndefined()
  })

  test("a COMMAND-target rejected frame does not change the adopted id or re-handshake", () => {
    const hs = createAttachHandshake()
    hs.initialConnect()
    hs.onMessage({
      kind: "rejected",
      sessionId: "daemon-session-7",
      target: "connect",
      reason: "session_id_mismatch",
    })
    const reaction = hs.onMessage({
      kind: "rejected",
      sessionId: "daemon-session-7",
      target: "command",
      reason: "duplicate_command",
      commandId: "cmd-1",
    })
    expect(reaction).toBeUndefined()
    expect(hs.sessionId).toBe("daemon-session-7")
  })

  test("the snapshot frame marks the handshake ready and confirms the session id", () => {
    const hs = createAttachHandshake()
    hs.initialConnect()
    hs.onMessage({
      kind: "rejected",
      sessionId: "daemon-session-7",
      target: "connect",
      reason: "session_id_mismatch",
    })
    const snapshotMsg: SessionTransportMessage = {
      kind: "snapshot",
      snapshot: {
        sessionId: "daemon-session-7",
        revision: 1,
        seq: 4,
        state: {
          status: "idle",
          draftInput: "",
          permissionMode: "default",
          messageCount: 0,
        },
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
    }
    const reaction = hs.onMessage(snapshotMsg)
    expect(reaction).toBeUndefined()
    expect(hs.ready).toBe(true)
    expect(hs.sessionId).toBe("daemon-session-7")
  })

  test("a snapshot on a fresh handshake adopts the id directly (server skipped the reject)", () => {
    const hs = createAttachHandshake()
    hs.initialConnect()
    hs.onMessage({
      kind: "snapshot",
      snapshot: {
        sessionId: "direct-session",
        revision: 1,
        seq: 0,
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
    expect(hs.sessionId).toBe("direct-session")
    expect(hs.ready).toBe(true)
  })
})

describe("attach renderer (SessionEvent → terminal text)", () => {
  test("output.delta accumulates a streaming line", () => {
    const r1 = renderSessionEvent(
      event({
        eventId: "e1",
        seq: 1,
        revision: 1,
        emittedAt: "t",
        type: "turn.output.delta",
        delta: "Hello, ",
      }),
    )
    const r2 = renderSessionEvent(
      event({
        eventId: "e2",
        seq: 2,
        revision: 1,
        emittedAt: "t",
        type: "turn.output.delta",
        delta: "world",
      }),
    )
    expect(r1).toBe("Hello, ")
    expect(r2).toBe("world")
  })

  test("turn.started and turn.completed render visible boundaries", () => {
    const started = renderSessionEvent(
      event({
        eventId: "e1",
        seq: 1,
        revision: 1,
        emittedAt: "t",
        type: "turn.started",
        prompt: "do the thing",
      }),
    )
    const completed = renderSessionEvent(
      event({
        eventId: "e2",
        seq: 2,
        revision: 1,
        emittedAt: "t",
        type: "turn.completed",
        outcomeReason: "completed",
        assistantText: "done",
      }),
    )
    expect(started).not.toBe("")
    expect(completed).not.toBe("")
    // Completed should add a trailing newline so the next prompt starts clean.
    expect(completed).toContain("\n")
  })

  test("tool.invoked and tool.completed render the tool name + outcome", () => {
    const invoked = renderSessionEvent(
      event({
        eventId: "e1",
        seq: 1,
        revision: 1,
        emittedAt: "t",
        type: "tool.invoked",
        toolCallId: "tc1",
        toolName: "bash",
        argsPreview: "ls -la",
      }),
    )
    const completed = renderSessionEvent(
      event({
        eventId: "e2",
        seq: 2,
        revision: 1,
        emittedAt: "t",
        type: "tool.completed",
        toolCallId: "tc1",
        toolName: "bash",
        outcome: "ok",
      }),
    )
    expect(invoked).toContain("bash")
    expect(completed).toContain("bash")
    expect(completed).toContain("ok")
  })

  test("approval.requested renders the reason so the operator can decide", () => {
    const out = renderSessionEvent(
      event({
        eventId: "e1",
        seq: 1,
        revision: 1,
        emittedAt: "t",
        type: "approval.requested",
        approval: { approvalId: "ap1", reason: "run rm -rf", requestedAt: "t" },
      }),
    )
    expect(out).toContain("run rm -rf")
  })

  test("turn.failed renders the error message", () => {
    const out = renderSessionEvent(
      event({
        eventId: "e1",
        seq: 1,
        revision: 1,
        emittedAt: "t",
        type: "turn.failed",
        message: "boom",
      }),
    )
    expect(out).toContain("boom")
  })

  test("noisy/internal events (session.state.updated) render to empty (no terminal spam)", () => {
    const out = renderSessionEvent(
      event({
        eventId: "e1",
        seq: 1,
        revision: 1,
        emittedAt: "t",
        type: "session.state.updated",
        state: { status: "idle", draftInput: "", permissionMode: "default", messageCount: 0 },
      }),
    )
    expect(out).toBe("")
  })
})

describe("attach stdin-line → command builders", () => {
  test("a typed line becomes input.append + turn.run (mirrors the frontend two-command send)", () => {
    const cmds = buildLineCommands({
      sessionId: "s1",
      line: "hello there",
      newCommandId: (() => {
        let n = 0
        return () => `cmd-${++n}`
      })(),
      issuedAt: () => "2026-06-09T00:00:00.000Z",
    })
    expect(cmds).toHaveLength(2)
    const append = cmds[0]
    const run = cmds[1]
    if (append === undefined || run === undefined) throw new Error("narrow: expected two commands")
    if (append.type !== "input.append") throw new Error("narrow: first is input.append")
    expect(append.text).toBe("hello there")
    expect(append.sessionId).toBe("s1")
    expect(run.type).toBe("turn.run")
    expect(run.sessionId).toBe("s1")
    // Distinct command ids so the daemon's dedup window doesn't collapse them.
    expect(append.commandId).not.toBe(run.commandId)
  })

  test("a blank / whitespace-only line yields no commands (no empty turn)", () => {
    const cmds = buildLineCommands({
      sessionId: "s1",
      line: "   ",
      newCommandId: () => "cmd",
      issuedAt: () => "t",
    })
    expect(cmds).toHaveLength(0)
  })

  test("approval y/N maps to approve/deny respond commands", () => {
    const approve = buildApprovalRespondCommand({
      sessionId: "s1",
      approvalId: "ap1",
      answer: "y",
      commandId: "c1",
      issuedAt: "t",
    })
    expect(approve.type).toBe("approval.respond")
    expect(approve.decision).toBe("approve")
    expect(approve.approvalId).toBe("ap1")

    const deny = buildApprovalRespondCommand({
      sessionId: "s1",
      approvalId: "ap1",
      answer: "n",
      commandId: "c2",
      issuedAt: "t",
    })
    expect(deny.decision).toBe("deny")

    // Default (anything not an affirmative) denies — fail-safe for a dangerous op.
    const ambiguous = buildApprovalRespondCommand({
      sessionId: "s1",
      approvalId: "ap1",
      answer: "",
      commandId: "c3",
      issuedAt: "t",
    })
    expect(ambiguous.decision).toBe("deny")
  })

  // Strengthened (jun-09 audit, finding #4): the prior test never asserted that
  // a SPELLED-OUT affirmative ("yes") approves, and had NO "non-empty garbage ⇒
  // deny" case — so it was broadening-vacuous (a builder that always denied, or
  // always approved on "y" but ignored "yes", would still pass). These cases
  // pin BOTH directions of the fail-safe contract: only the two literal
  // affirmatives approve; everything else (including plausible-looking words
  // like "sure") denies.
  test("approval fail-safe: only literal y/yes approve; non-empty garbage denies", () => {
    const decide = (answer: string): "approve" | "deny" =>
      buildApprovalRespondCommand({
        sessionId: "s1",
        approvalId: "ap1",
        answer,
        commandId: "c",
        issuedAt: "t",
      }).decision

    // Affirmatives — the ONLY two answers that may approve.
    expect(decide("yes")).toBe("approve")
    expect(decide("y")).toBe("approve")
    expect(decide("YES")).toBe("approve") // case-insensitive
    expect(decide("  y  ")).toBe("approve") // trimmed

    // Non-empty garbage that is NOT a literal affirmative must fail-safe to deny
    // (a dangerous op awaiting confirmation is denied unless explicitly approved).
    expect(decide("sure")).toBe("deny")
    expect(decide("yep")).toBe("deny")
    expect(decide("ok")).toBe("deny")
    expect(decide("yeah")).toBe("deny")
    expect(decide("")).toBe("deny")
    expect(decide("n")).toBe("deny")
  })
})
