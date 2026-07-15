/**
 * W1-a (jul-15) HELLGATE — side-agent finding recipient SSOT (F1 dead-letter).
 *
 * F1: the side-agent daemon finding WRITE recipient fell back to the literal
 * `"main"` (host assembler `maybeWireSideAgent`) while the root session READS its
 * mailbox under `"root"` (the turn-top peer-inbox drain `pollPeerInbox` + the
 * `subagent_read_messages` tool's depth fallback). A published finding was stored
 * `to:"main"` and NEVER matched `read("root")` — the advertised "daemons push
 * findings via the mailbox" channel was a silent dead letter in EVERY root
 * session (only a child session, which sets `mailboxAgentId`, happened to match).
 *
 * Fix: `rootMailboxRecipient(mailboxAgentId) = mailboxAgentId ?? "root"` — the
 * SSOT used by BOTH ends, so the WRITE recipient and the READ id can never drift
 * to different literals again.
 *
 * This hellgate:
 *   1. DELIVERY (behavioral, REAL wiring): drives the SAME `wireSideAgentDaemons`
 *      seam the assembler calls (real registry + real `mailboxToSideAgentMailbox`
 *      + real `createSubagentMailbox` + real `createPeerInboxDrain`) with fake
 *      timers + a stub `SubagentRunner` leaf. A published finding reaches the
 *      root drain IFF the recipient matches. The BUG-CONTROL arm (recipient
 *      `"main"`, the exact old literal) → root drain EMPTY + the mail lands under
 *      `"main"` instead: red-on-injection that LOCKS why the old value
 *      dead-lettered.
 *   2. READ id (control-poll): `pollPeerInbox` drains under
 *      `rootMailboxRecipient(cfg.mailboxAgentId)` — pinned with a spy drain (root
 *      ⇒ `"root"`, child ⇒ its stable label).
 *   3. ASSEMBLER wiring SMOKE: the REAL `assembleAgentConfig` wires the side-agent
 *      registry over the SAME `cfg.subagentMailbox` instance the root drains (so a
 *      finding written to that mailbox is root-drainable). This proves SHARED-
 *      INSTANCE wiring only — it does NOT observe the assembler's private
 *      `mainRecipient` choice (see coverage boundary below).
 *
 * COVERAGE BOUNDARY (honest, per jul-15 hellaudit finding f1-*): the assembler's
 * WRITE recipient is a private field on `SideAgentDaemonOpts`, consumed only
 * inside the registry's `publish` closure (side-agent/registry.ts) and never
 * surfaced on the returned registry. Observing it would require driving a REAL
 * finding through the assembler's registry, which bakes REAL interval timers +
 * an internal LLM runner — not unit-drivable. So the write literal is NOT
 * directly regression-guarded here; it is correct-BY-CONSTRUCTION (the assembler
 * and every read path now share the ONE `rootMailboxRecipient` SSOT helper, so
 * they cannot resolve to different strings), and its FAILURE MODE (arm 1
 * bug-control) + the READ id (arm 2) ARE guarded. Arm 3 is a wiring smoke, not a
 * recipient-literal guard.
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { wireSideAgentDaemons } from "@/agent/side-agent-runner"
import {
  createPeerInboxDrain,
  createSubagentMailbox,
  type MailboxPort,
  ROOT_MAILBOX_AGENT_ID,
  rootMailboxRecipient,
} from "@/agent/subagent-mailbox"
import { pollPeerInbox } from "@/agent/loop/control-poll"
import { type AssembleRequest, assembleAgentConfig } from "@/host/runtime/agent-config-assembler"
import type { SubagentRunner } from "@/subagent"

// ── fakes ──────────────────────────────────────────────────────────────────────

/** Manual interval clock — `setInterval` registers a handler; `fireLatest`
 *  invokes the most-recently-armed one (the single daemon's). */
const mkTimers = () => {
  const handlers = new Map<number, () => void>()
  let next = 0
  return {
    setInterval: (h: () => void, _ms: number): unknown => {
      const id = ++next
      handlers.set(id, h)
      return id
    },
    clearInterval: (_h: unknown): void => {},
    fireLatest: (): void => {
      const h = handlers.get(next)
      if (h !== undefined) h()
    },
  }
}

/** A stub `SubagentRunner` (the LLM leaf) that yields ONE finding-shaped result
 *  per pass. Everything ABOVE it in the pipeline (`subagentRunnerToSidePass` →
 *  registry `publish` → `mailboxToSideAgentMailbox` → real mailbox) is REAL. */
const findingRunner = (finalText: string): SubagentRunner =>
  (async () => ({ ok: true, finalText, turns: 1 })) as unknown as SubagentRunner

const flush = () => new Promise((r) => setTimeout(r, 0))

const FINDING = "BUILD BROKEN at foo.ts:12"

/** Wire the REAL side-agent registry over `mailbox` with `mainRecipient`, spawn
 *  one interval daemon, fire its wake, and let the finding publish settle. */
const publishFindingVia = async (mailbox: MailboxPort, mainRecipient: string): Promise<void> => {
  const timers = mkTimers()
  const reg = wireSideAgentDaemons({
    runner: findingRunner(FINDING),
    mailbox,
    mainRecipient,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    now: () => 1000,
  })
  reg.spawn({
    task: "watch the build",
    trigger: { kind: "interval", everyMs: 1000 },
    maxWakes: 1,
    maxTurnsPerWake: 1,
  })
  timers.fireLatest()
  await flush()
}

// ── 1. DELIVERY invariant + bug-control (red-on-injection) ──────────────────────

describe("W1-a — side-agent finding delivery to the root drain", () => {
  test("finding published to the SSOT recipient IS surfaced by the root drain", async () => {
    const mailbox = createSubagentMailbox()
    await publishFindingVia(mailbox, rootMailboxRecipient(undefined))

    // The finding landed addressed to the root, undelivered until the root reads.
    expect(mailbox.pendingFor(ROOT_MAILBOX_AGENT_ID)).toBe(1)

    const drained = createPeerInboxDrain(mailbox).drainFor(rootMailboxRecipient(undefined))
    expect(drained).not.toBeNull()
    const text = drained?.content.map((c) => (c.type === "text" ? c.text : "")).join("") ?? ""
    expect(text).toContain(FINDING)

    // Delivered exactly once — a second drain is empty (mark-delivered cursor).
    expect(mailbox.pendingFor(ROOT_MAILBOX_AGENT_ID)).toBe(0)
  })

  test('BUG-CONTROL: the old literal "main" DEAD-LETTERS the finding (root drain empty)', async () => {
    const mailbox = createSubagentMailbox()
    // Reproduce the pre-fix assembler behavior EXACTLY: write recipient = "main".
    await publishFindingVia(mailbox, "main")

    // The mail exists — but addressed to "main", NOT the root's read id.
    expect(mailbox.pendingFor("main")).toBe(1)
    expect(mailbox.pendingFor(ROOT_MAILBOX_AGENT_ID)).toBe(0)

    // The root drain (reads under "root") finds nothing — the F1 dead letter.
    const drained = createPeerInboxDrain(mailbox).drainFor(rootMailboxRecipient(undefined))
    expect(drained).toBeNull()
  })
})

// ── 2. control-poll READ id uses the SSOT ───────────────────────────────────────

describe("W1-a — pollPeerInbox drains under rootMailboxRecipient", () => {
  const mkCfg = (mailboxAgentId: string | undefined, capture: (id: string) => void): AgentConfig =>
    ({
      peerInbox: {
        drainFor: (id: string) => {
          capture(id)
          return null
        },
      },
      mailboxAgentId,
      stream: { emit: () => undefined },
    }) as unknown as AgentConfig

  test("root session (mailboxAgentId unset) drains under the root id", () => {
    let captured: string | undefined
    pollPeerInbox(mkCfg(undefined, (id) => (captured = id)))
    expect(captured).toBe(ROOT_MAILBOX_AGENT_ID)
    expect(captured).toBe(rootMailboxRecipient(undefined))
  })

  test("child session drains under its OWN stable label (not the root id)", () => {
    let captured: string | undefined
    pollPeerInbox(mkCfg("root/2", (id) => (captured = id)))
    expect(captured).toBe("root/2")
    expect(captured).toBe(rootMailboxRecipient("root/2"))
  })
})

// ── 3. Assembler integration — shared mailbox, root-drainable finding ───────────

const baseReq = (sessionId: string): AssembleRequest["base"] => ({
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
  stream: { emit: () => undefined },
  permission: { mode: "default" },
  messages: [],
  system: "test",
  cwd: process.cwd(),
  maxTurns: 1,
  signal: new AbortController().signal,
  sessionId,
})

describe("W1-a — assembler wires a SHARED side-agent mailbox the root can drain (wiring smoke)", () => {
  test("side-agent registry + peer drain share cfg.subagentMailbox; a root-addressed finding drains at root", () => {
    const cfg = assembleAgentConfig(
      { mode: "interactive", base: baseReq("sess-w1a") },
      { QUANTA_SIDE_AGENT: "1", QUANTA_SUBAGENT_MAILBOX: "1" },
    )
    expect(cfg.sideAgentDaemons).toBeDefined()
    const mailbox = (cfg as AgentConfig & { subagentMailbox?: MailboxPort }).subagentMailbox
    expect(mailbox).toBeDefined()
    if (mailbox === undefined) throw new Error("expected subagentMailbox wired")

    // This asserts SHARED-INSTANCE wiring only: a finding written to the root id
    // over the assembler's OWN mailbox is drainable by the root. It does NOT
    // observe the assembler's private `mainRecipient` — see the file's COVERAGE
    // BOUNDARY note (that literal is correct-by-construction via the shared
    // `rootMailboxRecipient` SSOT; its failure mode is arm 1, its read id arm 2).
    mailbox.send({ from: "sa-daemon-1", to: ROOT_MAILBOX_AGENT_ID, kind: "broadcast", body: "finding X" })

    const drained = createPeerInboxDrain(mailbox).drainFor(rootMailboxRecipient(cfg.mailboxAgentId))
    expect(drained).not.toBeNull()
    const text = drained?.content.map((c) => (c.type === "text" ? c.text : "")).join("") ?? ""
    expect(text).toContain("finding X")
  })
})
