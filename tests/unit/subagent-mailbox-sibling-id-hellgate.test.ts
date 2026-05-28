/**
 * ADR-0416 sibling-identity hellgate — structural fix for the depth-label
 * identity collapse (audit H).
 *
 * THE BUG (before this slice):
 *   `senderId` in `@/tool/subagent-mailbox` derived an agent's mailbox identity
 *   from `ctx.depth` ALONE: root ⇒ "root", any child at depth N ⇒
 *   "agent@depth-N". So TWO siblings forked at the same depth shared ONE label.
 *   A DIRECT message `to: "agent@depth-1"` carried a SINGLE `deliveredAt`
 *   stamp — whichever sibling read first marked it delivered, and the OTHER
 *   sibling (identical label) NEVER saw it. Reliable channels were therefore
 *   only root↔single-child and broadcast; multi-sibling direct was dead.
 *
 * THE FIX (two layers):
 *   1. STABLE PER-AGENT ID: the subagent runner mints a deterministic child id
 *      (`parentId/seq` — replay-friendly ordinal counter, NOT a random uuid /
 *      clock) and threads it onto the child config; the dispatch seam surfaces
 *      it onto `ToolContext.agentLabel`. The mailbox tools prefer this stable
 *      label, falling back to the depth-derived label when absent (so legacy
 *      callers that set only `ctx.depth` stay byte-identical).
 *   2. PER-RECIPIENT DIRECT DELIVERY: the store tracks delivery per
 *      (messageId, recipientId) instead of a single `deliveredAt` stamp, so two
 *      DISTINCT recipients each receive their own DIRECT mail independently.
 *
 * Dimensions:
 *   A. STORE per-recipient DIRECT (the structural core).
 *   B. TOOL identity prefers `ctx.agentLabel`, falls back to depth.
 *   C. End-to-end: 2 siblings + direct mail → EACH receives its OWN message.
 *   D. Regression: broadcast / correlation / root↔child still hold.
 */

import { describe, expect, test } from "bun:test"
import { createSubagentMailbox, type MailboxPort } from "@/agent/subagent-mailbox"
import type { Tool, ToolContext } from "@/tool"
import { subagentMailboxTools } from "@/tool/subagent-mailbox"

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  cwd: "/tmp",
  signal: new AbortController().signal,
  ...over,
})

const drain = async (
  tool: Tool,
  input: unknown,
  c: ToolContext = ctx(),
): Promise<{ ok: boolean; output: string }> => {
  let last: { ok: boolean; output: string } | undefined
  for await (const ev of tool.execute(input as never, c)) {
    if (ev.type === "result") last = { ok: ev.result.ok, output: ev.result.output }
  }
  if (last === undefined) throw new Error("tool yielded no terminal result")
  return last
}

const findTool = (tools: readonly Tool[], name: string): Tool => {
  const t = tools.find((x) => x.name === name)
  if (t === undefined) throw new Error(`tool not found: ${name}`)
  return t
}

const sendToolFor = (port: MailboxPort): Tool =>
  findTool(subagentMailboxTools(port), "subagent_send_message")
const readToolFor = (port: MailboxPort): Tool =>
  findTool(subagentMailboxTools(port), "subagent_read_messages")

const tick = () => {
  let n = 1000
  return () => ++n
}

// ─────────────────────────────────────────────────────────────────────────────
// A. STORE — per-recipient DIRECT delivery (two DISTINCT recipients)
// ─────────────────────────────────────────────────────────────────────────────

describe("subagent mailbox — per-recipient DIRECT delivery", () => {
  test("(1) two distinct recipients each receive their OWN direct mail", () => {
    const mb = createSubagentMailbox({ now: tick() })
    mb.send({ from: "root", to: "root/0", kind: "request", body: "for-0" })
    mb.send({ from: "root", to: "root/1", kind: "request", body: "for-1" })
    expect(mb.read("root/0").map((m) => m.body)).toEqual(["for-0"])
    expect(mb.read("root/1").map((m) => m.body)).toEqual(["for-1"])
  })

  test("(2) a recipient reading its OWN direct mail does NOT consume another recipient's", () => {
    const mb = createSubagentMailbox({ now: tick() })
    mb.send({ from: "root", to: "root/1", kind: "request", body: "only-1" })
    // a DIFFERENT agent reads first — must NOT mark root/1's message delivered
    expect(mb.read("root/0").length).toBe(0)
    expect(mb.pendingFor("root/1")).toBe(1)
    expect(mb.read("root/1").map((m) => m.body)).toEqual(["only-1"])
  })

  test("(3) per-recipient read is still idempotent for the addressed recipient", () => {
    const mb = createSubagentMailbox({ now: tick() })
    mb.send({ from: "root", to: "root/1", kind: "request", body: "x" })
    expect(mb.read("root/1").length).toBe(1)
    expect(mb.read("root/1").length).toBe(0)
  })

  test("(4) deliveredAt is still stamped on a direct read (public field preserved)", () => {
    const mb = createSubagentMailbox({ now: tick() })
    const sent = mb.send({ from: "root", to: "root/2", kind: "request", body: "y" })
    expect(sent.deliveredAt).toBeUndefined()
    const got = mb.read("root/2")
    expect(got[0]?.id).toBe(sent.id)
    expect(got[0]?.deliveredAt).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B. TOOL — identity prefers ctx.agentLabel, falls back to depth
// ─────────────────────────────────────────────────────────────────────────────

describe("subagent mailbox — stable agentLabel identity", () => {
  test("(5) sender id prefers ctx.agentLabel over depth-derived label", async () => {
    const port = createSubagentMailbox({ now: tick() })
    await drain(
      sendToolFor(port),
      { to: "x", kind: "request", body: "labeled" },
      ctx({ depth: 1, agentLabel: "root/0" }),
    )
    expect(port.list({ from: "root/0" }).length).toBe(1)
    // it did NOT collapse to the depth-derived "agent@depth-1"
    expect(port.list({ from: "agent@depth-1" }).length).toBe(0)
  })

  test("(6) read identity also prefers ctx.agentLabel (own inbox)", async () => {
    const port = createSubagentMailbox({ now: tick() })
    port.send({ from: "root", to: "root/0", kind: "request", body: "hello-0" })
    port.send({ from: "root", to: "root/1", kind: "request", body: "hello-1" })
    const r0 = await drain(readToolFor(port), {}, ctx({ depth: 1, agentLabel: "root/0" }))
    expect(r0.output).toContain("hello-0")
    expect(r0.output).not.toContain("hello-1")
  })

  test("(7) absent agentLabel ⇒ falls back to depth-derived label (byte-identical legacy)", async () => {
    const port = createSubagentMailbox({ now: tick() })
    await drain(sendToolFor(port), { to: "x", kind: "request", body: "legacy" }, ctx({ depth: 1 }))
    expect(port.list({ from: "agent@depth-1" }).length).toBe(1)
  })

  test('(8) "parent" prefers ctx.parentAgentLabel when present', async () => {
    const port = createSubagentMailbox({ now: tick() })
    await drain(
      sendToolFor(port),
      { to: "parent", kind: "response", body: "to-parent" },
      ctx({ depth: 2, agentLabel: "root/0/0", parentAgentLabel: "root/0" }),
    )
    expect(port.list({ to: "root/0" }).length).toBe(1)
    expect(port.read("root/0")[0]?.body).toBe("to-parent")
  })

  test('(9) "parent" falls back to depth math when parentAgentLabel absent', async () => {
    const port = createSubagentMailbox({ now: tick() })
    await drain(sendToolFor(port), { to: "parent", kind: "response", body: "p" }, ctx({ depth: 1 }))
    expect(port.list({ to: "root" }).length).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C. END-TO-END — two siblings, each receives its OWN direct mail (THE BUG)
// ─────────────────────────────────────────────────────────────────────────────

describe("subagent mailbox — two-sibling direct delivery (audit H)", () => {
  test("(10) parent direct-messages two siblings; EACH reads its own (before: 2nd lost)", async () => {
    const port = createSubagentMailbox({ now: tick() })
    const send = sendToolFor(port)
    const read = readToolFor(port)

    // Parent (root) addresses each sibling by its STABLE id.
    const parentCtx = ctx({ depth: 0, agentLabel: "root" })
    await drain(send, { to: "root/0", kind: "request", body: "do task A" }, parentCtx)
    await drain(send, { to: "root/1", kind: "request", body: "do task B" }, parentCtx)

    // Sibling 0 polls its inbox.
    const sib0 = ctx({ depth: 1, agentLabel: "root/0", parentAgentLabel: "root" })
    const r0 = await drain(read, {}, sib0)
    expect(r0.output).toContain("do task A")
    expect(r0.output).not.toContain("do task B")

    // Sibling 1 polls its inbox — MUST still see its own message (the bug:
    // sib0 reading first marked the single depth-1 stamp delivered → sib1 lost).
    const sib1 = ctx({ depth: 1, agentLabel: "root/1", parentAgentLabel: "root" })
    const r1 = await drain(read, {}, sib1)
    expect(r1.output).toContain("do task B")
    expect(r1.output).not.toContain("do task A")
  })

  test("(11) both siblings can independently respond to the parent (correlation intact)", async () => {
    const port = createSubagentMailbox({ now: tick() })
    const send = sendToolFor(port)
    const read = readToolFor(port)

    const sib0 = ctx({ depth: 1, agentLabel: "root/0", parentAgentLabel: "root" })
    const sib1 = ctx({ depth: 1, agentLabel: "root/1", parentAgentLabel: "root" })
    await drain(
      send,
      { to: "parent", kind: "response", body: "A done", correlation_id: "ta" },
      sib0,
    )
    await drain(
      send,
      { to: "parent", kind: "response", body: "B done", correlation_id: "tb" },
      sib1,
    )

    const parent = ctx({ depth: 0, agentLabel: "root" })
    const got = await drain(read, {}, parent)
    expect(got.output).toContain("A done")
    expect(got.output).toContain("B done")
    expect(got.output).toContain("ta")
    expect(got.output).toContain("tb")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D. REGRESSION — broadcast reaches every sibling, never the sender
// ─────────────────────────────────────────────────────────────────────────────

describe("subagent mailbox — broadcast regression with stable ids", () => {
  test("(12) broadcast reaches BOTH siblings exactly once; never the sender", async () => {
    const port = createSubagentMailbox({ now: tick() })
    const send = sendToolFor(port)
    const read = readToolFor(port)

    const parent = ctx({ depth: 0, agentLabel: "root" })
    await drain(send, { to: "*", kind: "broadcast", body: "all hands" }, parent)

    const sib0 = ctx({ depth: 1, agentLabel: "root/0", parentAgentLabel: "root" })
    const sib1 = ctx({ depth: 1, agentLabel: "root/1", parentAgentLabel: "root" })
    expect((await drain(read, {}, sib0)).output).toContain("all hands")
    expect((await drain(read, {}, sib1)).output).toContain("all hands")
    // idempotent for each
    expect((await drain(read, {}, sib0)).output).toContain("(no messages)")
    // sender never receives its own broadcast
    expect((await drain(read, {}, parent)).output).toContain("(no messages)")
  })
})
