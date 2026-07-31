/**
 * W2-1 (jul-15) HELLGATE — peer/side-agent message SURFACING (Codex "Sent from
 * another task" parity). The `surfaceNotifyMailbox` decorator emits a
 * `peer_message` display event at ENQUEUE time for mail addressed to the session
 * owner; the host sink adapts the notice to the AgentEvent; the assembler wires it
 * default-OFF.
 *
 * Coverage:
 *   1. DECORATOR — emits iff `to === recipientId` (or `"*"`), NOT for other
 *      targets; ALWAYS delegates `send` to inner (message still enqueued).
 *   2. PROVENANCE — a plain peer send ⇒ `{source:"peer"}`; the side-agent adapter
 *      (`mailboxToSideAgentMailbox`) ⇒ `{source:"side-agent", daemonId}`.
 *   3. REDACTION — a planted secret in the body is scrubbed before the notice.
 *   4. NO-THROW — a throwing sink can never break `send`.
 *   5. HOST SINK — `createPeerMessageStreamSink` maps a notice → a `peer_message`
 *      AgentEvent on the stream (byte-shape).
 *   6. ORDERING (red-on-injection) — with the team decorator OUTSIDE the notifier,
 *      a cross-team DENIED send NEVER reaches the notifier ⇒ NO display event.
 *   7. COMPOSITION — the REAL assembler emits `peer_message` on `cfg.stream` for a
 *      root-addressed send when the knob is on; NOTHING when the knob is off
 *      (byte-identical default).
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { mailboxToSideAgentMailbox } from "@/agent/side-agent-runner"
import {
  createSubagentMailbox,
  type MailboxPort,
  type PeerMessageNotice,
  ROOT_MAILBOX_AGENT_ID,
  surfaceNotifyMailbox,
  teamScopedMailbox,
} from "@/agent/subagent-mailbox"
import { type AssembleRequest, assembleAgentConfig } from "@/host/runtime/agent-config-assembler"
import {
  createPeerMessageStreamSink,
  maybeWirePeerMessageSurface,
} from "@/host/runtime/peer-message-sink-wire"
import { __resetRuntimeConfig } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"

const mkSink = () => {
  const notices: PeerMessageNotice[] = []
  return { sink: { emit: (n: PeerMessageNotice) => void notices.push(n) }, notices }
}

const ROOT = ROOT_MAILBOX_AGENT_ID

// ── 1. decorator emit selectivity + delegation ──────────────────────────────────

describe("W2-1 — surfaceNotifyMailbox emit selectivity", () => {
  test("emits a notice for a send addressed to the session owner AND enqueues it", () => {
    const inner = createSubagentMailbox()
    const { sink, notices } = mkSink()
    const port = surfaceNotifyMailbox(inner, { recipientId: ROOT, sink })

    port.send({ from: "root/1", to: ROOT, kind: "request", body: "compute the sum" })

    expect(notices).toHaveLength(1)
    expect(notices[0]?.from).toBe("root/1")
    expect(notices[0]?.body).toBe("compute the sum")
    // Delegation: the message is REALLY enqueued for the owner (surfacing is additive).
    expect(inner.pendingFor(ROOT)).toBe(1)
  })

  test("does NOT emit for a send addressed to a DIFFERENT agent (still enqueues)", () => {
    const inner = createSubagentMailbox()
    const { sink, notices } = mkSink()
    const port = surfaceNotifyMailbox(inner, { recipientId: ROOT, sink })

    port.send({ from: "root/1", to: "root/2", kind: "request", body: "sibling only" })

    expect(notices).toHaveLength(0)
    expect(inner.pendingFor("root/2")).toBe(1)
  })

  test("emits for a broadcast (reaches everyone incl. the owner)", () => {
    const inner = createSubagentMailbox()
    const { sink, notices } = mkSink()
    const port = surfaceNotifyMailbox(inner, { recipientId: ROOT, sink })
    port.send({ from: "root/1", to: "*", kind: "broadcast", body: "all hands" })
    expect(notices).toHaveLength(1)
  })
})

// ── 2. provenance ───────────────────────────────────────────────────────────────

describe("W2-1 — provenance attribution", () => {
  test("a plain peer send defaults to source:peer", () => {
    const { sink, notices } = mkSink()
    const port = surfaceNotifyMailbox(createSubagentMailbox(), { recipientId: ROOT, sink })
    port.send({ from: "root/1", to: ROOT, kind: "request", body: "hi" })
    expect(notices[0]?.provenance).toEqual({ source: "peer" })
  })

  test("the side-agent adapter tags source:side-agent + daemonId", () => {
    const { sink, notices } = mkSink()
    const port = surfaceNotifyMailbox(createSubagentMailbox(), { recipientId: ROOT, sink })
    // The side-agent finding channel writes through the adapter → provenance rides.
    mailboxToSideAgentMailbox(port).send({
      from: "sa-daemon-9",
      to: ROOT,
      kind: "finding",
      summary: "BUILD BROKEN",
    })
    expect(notices).toHaveLength(1)
    expect(notices[0]?.provenance).toEqual({ source: "side-agent", daemonId: "sa-daemon-9" })
  })
})

// ── 3. redaction + 4. no-throw ──────────────────────────────────────────────────

describe("W2-1 — redaction + no-throw", () => {
  test("a redactor scrubs the body before the notice", () => {
    const { sink, notices } = mkSink()
    const redact = (s: string) => s.replace(/SECRET-\w+/g, "‹redacted›")
    const port = surfaceNotifyMailbox(createSubagentMailbox(), { recipientId: ROOT, sink, redact })
    port.send({ from: "root/1", to: ROOT, kind: "request", body: "token=SECRET-abc123 ok" })
    expect(notices[0]?.body).toBe("token=‹redacted› ok")
  })

  test("a THROWING sink never breaks send (message still enqueued)", () => {
    const inner = createSubagentMailbox()
    const port = surfaceNotifyMailbox(inner, {
      recipientId: ROOT,
      sink: {
        emit() {
          throw new Error("sink exploded")
        },
      },
    })
    expect(() => port.send({ from: "root/1", to: ROOT, kind: "request", body: "x" })).not.toThrow()
    expect(inner.pendingFor(ROOT)).toBe(1)
  })
})

// ── 5. host sink → AgentEvent shape ─────────────────────────────────────────────

describe("W2-1 — createPeerMessageStreamSink maps a notice to a peer_message event", () => {
  test("notice → peer_message AgentEvent (byte-shape)", () => {
    const events: AgentEvent[] = []
    const stream: StreamPort = { emit: (e) => void events.push(e) }
    createPeerMessageStreamSink(stream).emit({
      from: "root/1",
      to: ROOT,
      kind: "response",
      body: "done",
      correlationId: "c1",
      sentAt: 42,
      provenance: { source: "side-agent", daemonId: "d1" },
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      type: "peer_message",
      from: "root/1",
      to: ROOT,
      kind: "response",
      body: "done",
      correlationId: "c1",
      sentAt: 42,
      provenance: { source: "side-agent", daemonId: "d1" },
    })
  })
})

// ── 6. ordering: team-denied send does NOT surface (red-on-injection) ────────────

describe("W2-1 — team decorator OUTSIDE notifier: a denied send never surfaces", () => {
  test("cross-team (un-teamed) send is denied before it reaches the notifier ⇒ NO notice", () => {
    const { sink, notices } = mkSink()
    // Layering: team-scoped(OUTER) → surface-notify → raw store (the wiring order).
    const notified = surfaceNotifyMailbox(createSubagentMailbox(), { recipientId: ROOT, sink })
    const teamGated = teamScopedMailbox(notified, {
      sameTeam: () => false, // un-teamed ⇒ every direct send denied
      membersOf: () => [],
    })

    const m = teamGated.send({ from: "root/1", to: ROOT, kind: "request", body: "compute" })

    expect(m.denied).toBe("cross-team") // team gate dropped it
    expect(notices).toHaveLength(0) // ...so it NEVER reached the display seam
  })
})

// ── 7. composition (assembler): default-OFF byte-identity + on-path emit ─────────

const baseReq = (sessionId: string, stream: StreamPort): AssembleRequest["base"] => ({
  llm: {
    stream() {
      throw new Error("unexpected stream()")
    },
  } as unknown as AgentConfig["llm"],
  registry: {
    register: () => undefined,
    get: () => undefined,
    list: () => [],
  } as unknown as AgentConfig["registry"],
  stream,
  permission: { mode: "default" },
  messages: [],
  system: "test",
  cwd: process.cwd(),
  maxTurns: 1,
  signal: new AbortController().signal,
  sessionId,
})

describe("W2-1 — assembler composition", () => {
  test("knob ON ⇒ a root-addressed send emits peer_message on cfg.stream", () => {
    const events: AgentEvent[] = []
    const cfg = assembleAgentConfig(
      { mode: "interactive", base: baseReq("sess-w2-on", { emit: (e) => void events.push(e) }) },
      { QUANTA_SUBAGENT_MAILBOX: "1", QUANTA_PEER_MSG_SURFACE: "1" },
    )
    const mailbox = (cfg as AgentConfig & { subagentMailbox?: MailboxPort }).subagentMailbox
    if (mailbox === undefined) throw new Error("expected subagentMailbox wired")

    mailbox.send({ from: "root/1", to: ROOT, kind: "request", body: "surfaced!" })

    const peer = events.filter((e) => e.type === "peer_message")
    expect(peer).toHaveLength(1)
    expect(peer[0]).toMatchObject({
      type: "peer_message",
      from: "root/1",
      to: ROOT,
      body: "surfaced!",
    })
  })

  test("knob OFF ⇒ NO peer_message events (byte-identical default)", () => {
    const events: AgentEvent[] = []
    const cfg = assembleAgentConfig(
      { mode: "interactive", base: baseReq("sess-w2-off", { emit: (e) => void events.push(e) }) },
      { QUANTA_SUBAGENT_MAILBOX: "1" }, // surface knob unset
    )
    const mailbox = (cfg as AgentConfig & { subagentMailbox?: MailboxPort }).subagentMailbox
    if (mailbox === undefined) throw new Error("expected subagentMailbox wired")

    mailbox.send({ from: "root/1", to: ROOT, kind: "request", body: "not surfaced" })

    expect(events.filter((e) => e.type === "peer_message")).toHaveLength(0)
  })

  // audit W2-SEC-1 — the assembler's redactor strips secrets AND ANSI/control.
  test("the assembler redactor scrubs a secret AND ANSI/control from the surfaced body", () => {
    const events: AgentEvent[] = []
    const cfg = assembleAgentConfig(
      { mode: "interactive", base: baseReq("sess-w2-sec", { emit: (e) => void events.push(e) }) },
      { QUANTA_SUBAGENT_MAILBOX: "1", QUANTA_PEER_MSG_SURFACE: "1" },
    )
    const mailbox = (cfg as AgentConfig & { subagentMailbox?: MailboxPort }).subagentMailbox
    if (mailbox === undefined) throw new Error("expected subagentMailbox wired")

    // A hostile body: an ANSI CSI escape + a BEL control char that would forge a
    // fake attribution line / ring the terminal bell.
    mailbox.send({
      from: "root/1",
      to: ROOT,
      kind: "request",
      body: "line1\x1b[31m\x07 forged line2",
    })
    const peer = events.filter((e) => e.type === "peer_message")
    expect(peer).toHaveLength(1)
    const body = (peer[0] as Extract<AgentEvent, { type: "peer_message" }>).body
    // The ESC (ANSI CSI) sequence + BEL control char are stripped; visible text kept.
    expect(body).not.toContain("\x1b")
    expect(body).not.toContain("\x07")
    expect(body).toContain("line1")
    expect(body).toContain("line2")
  })

  // audit W2-TEST-1 — exercise the REAL assembler wiring ORDER (team OUTSIDE notify)
  // rather than a hand-composed stack: an un-teamed cross-team send is denied by
  // the team gate and NEVER surfaces. (The team wrap reads `runtimeConfig().teamPeerMsg`
  // from process.env, so we set it + reset the cached config around the case.)
  test("REAL assembler order: team-denied cross-team send emits NO peer_message", () => {
    const events: AgentEvent[] = []
    process.env.QUANTA_TEAM_PEER_MSG = "1"
    __resetRuntimeConfig()
    try {
      const cfg = assembleAgentConfig(
        {
          mode: "interactive",
          base: baseReq("sess-w2-order", { emit: (e) => void events.push(e) }),
        },
        {
          QUANTA_SUBAGENT_MAILBOX: "1",
          QUANTA_PEER_MSG_SURFACE: "1",
          QUANTA_TEAM_PEER_MSG: "1", // team gate ON, but no team_create ⇒ un-teamed
        },
      )
      const mailbox = (cfg as AgentConfig & { subagentMailbox?: MailboxPort }).subagentMailbox
      if (mailbox === undefined) throw new Error("expected subagentMailbox wired")

      const m = mailbox.send({ from: "root/1", to: ROOT, kind: "request", body: "denied mail" })

      expect(m.denied).toBe("cross-team") // team gate (OUTER) dropped it
      expect(events.filter((e) => e.type === "peer_message")).toHaveLength(0) // never surfaced
    } finally {
      delete process.env.QUANTA_TEAM_PEER_MSG
      __resetRuntimeConfig()
    }
  })
})

// audit W2-A1 — the session owner's OWN send/broadcast is NOT surfaced (the store
// never delivers a message to its own sender, so surfacing it would show the user
// mail the model will never receive, self-labeled "from another task").
describe("W2-1 — owner's own send is not surfaced (matches delivery)", () => {
  test("a send FROM the owner TO the owner does NOT emit a notice", () => {
    const { sink, notices } = mkSink()
    const port = surfaceNotifyMailbox(createSubagentMailbox(), { recipientId: ROOT, sink })
    port.send({ from: ROOT, to: ROOT, kind: "request", body: "note to self" })
    expect(notices).toHaveLength(0)
  })

  test("a broadcast FROM the owner does NOT emit a notice", () => {
    const { sink, notices } = mkSink()
    const port = surfaceNotifyMailbox(createSubagentMailbox(), { recipientId: ROOT, sink })
    port.send({ from: ROOT, to: "*", kind: "broadcast", body: "all" })
    expect(notices).toHaveLength(0)
  })

  test("a peer's send TO the owner still surfaces (control — not over-suppressed)", () => {
    const { sink, notices } = mkSink()
    const port = surfaceNotifyMailbox(createSubagentMailbox(), { recipientId: ROOT, sink })
    port.send({ from: "root/1", to: ROOT, kind: "request", body: "for you" })
    expect(notices).toHaveLength(1)
  })
})
