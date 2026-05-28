/**
 * ADR-0416 hellgate — Managed-subagent mailbox (`MailboxPort`) + the
 * `subagent_send_message` LLM tool.
 *
 * Three dimensions:
 *
 *   A. PORT (store invariants):
 *      - read marks undelivered → delivered; idempotent re-read.
 *      - broadcast `to:"*"` delivered ONCE per agent (per-agent cursor),
 *        never to its own sender.
 *      - peek does NOT mark.
 *      - ack marks a specific message; unknown id ⇒ null.
 *      - list filters by from/to/kind.
 *      - pendingFor(unknown) === 0; send(to:unknown) succeeds (sits unread).
 *      - LRU evicts delivered-before-undelivered past maxRetained; retentionMs.
 *      - snapshot replace-not-merge; multi-agent isolation; NO-THROW on hostile.
 *
 *   B. WIRE (structural):
 *      - tier1 barrel re-exports `buildSubagentMailboxBlock`.
 *      - `AgentConfig.subagentMailbox` slot accepts a `MailboxPort`.
 *      - `FeaturesConfig` Pick union includes `"subagentMailbox"`.
 *      - slot ABSENT ⇒ tool NOT in extraTools (default-OFF byte-identical).
 *      - slot WIRED ⇒ tool lands in extraTools (same-port binding).
 *
 *   C. TOOL (execute path):
 *      - send round-trips through the bound port (read sees it).
 *      - `"parent"` target resolves to the parent's derived label.
 *      - `"*"` broadcast passes through.
 *      - schema rejection (missing body / bad kind / too-long body) ⇒ ok:false.
 *      - NO-THROW on a throwing fake port ⇒ ok:false "send failed".
 *      - HITL tier surface = "pre-approval-ok".
 */

import { describe, expect, test } from "bun:test"
import { buildSessionFeatures } from "@/agent/features"
import {
  createSubagentMailbox,
  type MailboxPort,
  type MailboxSnapshot,
} from "@/agent/subagent-mailbox"
import { buildSubagentMailboxBlock } from "@/agent/tier1"
import type { AgentConfig, FeaturesConfig } from "@/agent/types"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { StreamPort } from "@/stream"
import { defaultTools, type Tool, type ToolContext, ToolRegistry } from "@/tool"
import { subagentMailboxTools } from "@/tool/subagent-mailbox"

const baseCfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    registry: new ToolRegistry(defaultTools),
    stream: { emit() {} } as StreamPort,
    permission: { mode: "acceptEdits" } as PermissionContext,
    messages: [],
    system: "test",
    cwd: "/tmp",
    maxTurns: 1,
    signal: new AbortController().signal,
    llm: { model: "scripted", async *stream() {} } as unknown as LLMPort,
    ...over,
  }) as AgentConfig

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  cwd: "/tmp",
  signal: new AbortController().signal,
  ...over,
})

/** Drive a tool to its terminal `result` event and return `{ok, output}`. */
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

/** Monotonic clock seam so every `send` gets a distinct, ordered `sentAt`. */
const tick = () => {
  let n = 1000
  return () => ++n
}

// ─────────────────────────────────────────────────────────────────────────────
// A. PORT — delivery semantics
// ─────────────────────────────────────────────────────────────────────────────

describe("subagent mailbox — port delivery (ADR-0416)", () => {
  test("(1) direct send → read by target marks delivered + returns it", () => {
    const mb = createSubagentMailbox({ now: tick() })
    const sent = mb.send({ from: "root", to: "agent@depth-1", kind: "request", body: "hi" })
    expect(sent.deliveredAt).toBeUndefined()
    const got = mb.read("agent@depth-1")
    expect(got.length).toBe(1)
    expect(got[0]?.id).toBe(sent.id)
    expect(got[0]?.body).toBe("hi")
    expect(got[0]?.deliveredAt).toBeDefined()
  })

  test("(2) re-read is idempotent — delivered message does not reappear", () => {
    const mb = createSubagentMailbox({ now: tick() })
    mb.send({ from: "root", to: "child", kind: "request", body: "x" })
    expect(mb.read("child").length).toBe(1)
    expect(mb.read("child").length).toBe(0)
  })

  test("(3) peek returns the message WITHOUT marking it delivered", () => {
    const mb = createSubagentMailbox({ now: tick() })
    mb.send({ from: "root", to: "child", kind: "request", body: "x" })
    expect(mb.peek("child").length).toBe(1)
    expect(mb.peek("child").length).toBe(1) // still there
    expect(mb.peek("child")[0]?.deliveredAt).toBeUndefined()
    // then a real read consumes it
    expect(mb.read("child").length).toBe(1)
    expect(mb.peek("child").length).toBe(0)
  })

  test("(4) pendingFor counts undelivered + drops to 0 after read", () => {
    const mb = createSubagentMailbox({ now: tick() })
    mb.send({ from: "root", to: "child", kind: "request", body: "a" })
    mb.send({ from: "root", to: "child", kind: "request", body: "b" })
    expect(mb.pendingFor("child")).toBe(2)
    mb.read("child")
    expect(mb.pendingFor("child")).toBe(0)
  })

  test("(5) pendingFor(unknown agent) is 0", () => {
    const mb = createSubagentMailbox({ now: tick() })
    mb.send({ from: "root", to: "child", kind: "request", body: "a" })
    expect(mb.pendingFor("nobody")).toBe(0)
    expect(mb.pendingFor("")).toBe(0)
  })

  test("(6) send(to: unknown) succeeds and sits unread until that agent reads", () => {
    const mb = createSubagentMailbox({ now: tick() })
    const m = mb.send({ from: "root", to: "future-agent", kind: "request", body: "later" })
    expect(m.id).toBeDefined()
    expect(mb.pendingFor("future-agent")).toBe(1)
    expect(mb.read("future-agent").length).toBe(1)
  })

  test("(7) broadcast delivered ONCE per agent (per-agent cursor)", () => {
    const mb = createSubagentMailbox({ now: tick() })
    mb.send({ from: "root", to: "*", kind: "broadcast", body: "all-hands" })
    // each distinct reader gets it exactly once
    expect(mb.read("a").length).toBe(1)
    expect(mb.read("a").length).toBe(0) // idempotent for a
    expect(mb.read("b").length).toBe(1) // b still gets its own copy
    expect(mb.read("b").length).toBe(0)
  })

  test("(8) broadcast is NEVER delivered to its own sender", () => {
    const mb = createSubagentMailbox({ now: tick() })
    mb.send({ from: "root", to: "*", kind: "broadcast", body: "hello" })
    expect(mb.read("root").length).toBe(0)
    expect(mb.pendingFor("root")).toBe(0)
  })

  test("(9) direct message is never delivered to self", () => {
    const mb = createSubagentMailbox({ now: tick() })
    mb.send({ from: "root", to: "root", kind: "request", body: "self" })
    expect(mb.read("root").length).toBe(0)
  })

  test("(10) read honors `since` watermark", () => {
    const clock = tick()
    const mb = createSubagentMailbox({ now: clock })
    const first = mb.send({ from: "root", to: "child", kind: "request", body: "first" })
    mb.send({ from: "root", to: "child", kind: "request", body: "second" })
    const after = mb.read("child", { since: first.sentAt })
    expect(after.length).toBe(1)
    expect(after[0]?.body).toBe("second")
  })

  test("(11) read honors `limit`", () => {
    const mb = createSubagentMailbox({ now: tick() })
    mb.send({ from: "root", to: "child", kind: "request", body: "a" })
    mb.send({ from: "root", to: "child", kind: "request", body: "b" })
    mb.send({ from: "root", to: "child", kind: "request", body: "c" })
    const got = mb.read("child", { limit: 2 })
    expect(got.length).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A2. PORT — ack / list / isolation
// ─────────────────────────────────────────────────────────────────────────────

describe("subagent mailbox — ack / list / isolation (ADR-0416)", () => {
  test("(12) ack marks a specific message delivered; returns it", () => {
    const mb = createSubagentMailbox({ now: tick() })
    const m = mb.send({ from: "root", to: "child", kind: "request", body: "x" })
    const acked = mb.ack(m.id)
    expect(acked?.id).toBe(m.id)
    expect(acked?.deliveredAt).toBeDefined()
    // after ack, a read no longer surfaces it
    expect(mb.read("child").length).toBe(0)
  })

  test("(13) ack(unknown id) returns null", () => {
    const mb = createSubagentMailbox({ now: tick() })
    expect(mb.ack("nope")).toBeNull()
    expect(mb.ack("")).toBeNull()
  })

  test("(14) list filters by from / to / kind", () => {
    const mb = createSubagentMailbox({ now: tick() })
    mb.send({ from: "root", to: "a", kind: "request", body: "1" })
    mb.send({ from: "a", to: "root", kind: "response", body: "2" })
    mb.send({ from: "root", to: "*", kind: "broadcast", body: "3" })
    expect(mb.list().length).toBe(3)
    expect(mb.list({ from: "root" }).length).toBe(2)
    expect(mb.list({ to: "root" }).length).toBe(1)
    expect(mb.list({ kind: "broadcast" }).length).toBe(1)
    expect(mb.list({ from: "root", kind: "request" }).length).toBe(1)
  })

  test("(15) multi-agent isolation — each agent reads only its own mail", () => {
    const mb = createSubagentMailbox({ now: tick() })
    mb.send({ from: "root", to: "a", kind: "request", body: "for-a" })
    mb.send({ from: "root", to: "b", kind: "request", body: "for-b" })
    const a = mb.read("a")
    const b = mb.read("b")
    expect(a.map((m) => m.body)).toEqual(["for-a"])
    expect(b.map((m) => m.body)).toEqual(["for-b"])
  })

  test("(16) correlationId round-trips on request/response pairs", () => {
    const mb = createSubagentMailbox({ now: tick() })
    const req = mb.send({ from: "root", to: "a", kind: "request", body: "?", correlationId: "c1" })
    expect(req.correlationId).toBe("c1")
    const resp = mb.send({
      from: "a",
      to: "root",
      kind: "response",
      body: "!",
      correlationId: "c1",
    })
    expect(resp.correlationId).toBe("c1")
    expect(mb.list({ to: "root" })[0]?.correlationId).toBe("c1")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A3. PORT — LRU / retention / snapshot / NO-THROW
// ─────────────────────────────────────────────────────────────────────────────

describe("subagent mailbox — LRU / retention / snapshot (ADR-0416)", () => {
  test("(17) LRU evicts past maxRetained, delivered-before-undelivered", () => {
    const mb = createSubagentMailbox({ now: tick(), maxRetained: 2 })
    // m1 delivered, m2 undelivered, then m3 forces eviction.
    const m1 = mb.send({ from: "root", to: "x", kind: "request", body: "1" })
    mb.read("x") // m1 delivered
    mb.send({ from: "root", to: "y", kind: "request", body: "2" }) // undelivered
    mb.send({ from: "root", to: "z", kind: "request", body: "3" }) // undelivered, evict triggers
    const ids = mb.list().map((m) => m.id)
    // the delivered m1 is the eviction victim, not the undelivered ones
    expect(ids).not.toContain(m1.id)
    expect(mb.list().length).toBe(2)
  })

  test("(18) retentionMs reclaims messages older than the window", () => {
    let t = 0
    const mb = createSubagentMailbox({ now: () => t, retentionMs: 100 })
    t = 10
    mb.send({ from: "root", to: "x", kind: "request", body: "old" })
    t = 500 // > 100ms past the old message
    mb.send({ from: "root", to: "x", kind: "request", body: "new" })
    const bodies = mb.list().map((m) => m.body)
    expect(bodies).toContain("new")
    expect(bodies).not.toContain("old")
  })

  test("(19) toSnapshot → fromSnapshot round-trips message log", () => {
    const mb = createSubagentMailbox({ now: tick() })
    mb.send({ from: "root", to: "a", kind: "request", body: "keep" })
    const snap = mb.toSnapshot()
    expect(snap.messages.length).toBe(1)
    const mb2 = createSubagentMailbox({ now: tick() })
    mb2.fromSnapshot(snap)
    expect(mb2.list().length).toBe(1)
    expect(mb2.pendingFor("a")).toBe(1)
  })

  test("(20) fromSnapshot REPLACES, does not merge", () => {
    const mb = createSubagentMailbox({ now: tick() })
    mb.send({ from: "root", to: "a", kind: "request", body: "existing" })
    expect(mb.list().length).toBe(1)
    mb.fromSnapshot({ messages: [] })
    expect(mb.list().length).toBe(0)
    expect(mb.pendingFor("a")).toBe(0)
  })

  test("(21) NO-THROW on hostile snapshot / inputs", () => {
    const mb = createSubagentMailbox({ now: tick() })
    expect(() => mb.fromSnapshot(undefined as unknown as MailboxSnapshot)).not.toThrow()
    expect(() => mb.fromSnapshot({ messages: null } as unknown as MailboxSnapshot)).not.toThrow()
    expect(() =>
      mb.fromSnapshot({ messages: [null, 42, "x"] } as unknown as MailboxSnapshot),
    ).not.toThrow()
    // hostile send args never throw and always return a message
    const m = mb.send({
      from: null,
      to: undefined,
      kind: "weird",
      body: 123,
    } as never)
    expect(m.id).toBeDefined()
    expect(m.kind).toBe("request") // bad kind degrades to default
    expect(() => mb.read(null as never)).not.toThrow()
    expect(() => mb.peek(123 as never)).not.toThrow()
    expect(mb.read(42 as never).length).toBe(0)
  })

  test("(22) returned messages are frozen (no post-return mutation leak)", () => {
    const mb = createSubagentMailbox({ now: tick() })
    const m = mb.send({ from: "root", to: "a", kind: "request", body: "x" })
    expect(Object.isFrozen(m)).toBe(true)
    expect(Object.isFrozen(mb.toSnapshot())).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B. WIRE
// ─────────────────────────────────────────────────────────────────────────────

describe("subagent mailbox — wire (ADR-0416)", () => {
  test("(23) tier1 barrel re-exports buildSubagentMailboxBlock", () => {
    expect(typeof buildSubagentMailboxBlock).toBe("function")
  })

  test("(24) AgentConfig.subagentMailbox slot accepts a MailboxPort", () => {
    const port = createSubagentMailbox()
    const cfg = baseCfg({ subagentMailbox: port })
    expect(cfg.subagentMailbox).toBe(port)
  })

  test("(25) FeaturesConfig Pick union includes 'subagentMailbox'", () => {
    const port = createSubagentMailbox()
    const fc: Pick<FeaturesConfig, "subagentMailbox"> = { subagentMailbox: port }
    expect(fc.subagentMailbox).toBe(port)
  })

  test("(26) slot ABSENT ⇒ subagent_send_message NOT in extraTools (default-OFF)", async () => {
    const features = await buildSessionFeatures(baseCfg())
    expect(features.extraTools.find((t) => t.name === "subagent_send_message")).toBeUndefined()
  })

  test("(27) builder returns [] when slot absent", () => {
    expect(buildSubagentMailboxBlock(baseCfg())).toEqual([])
  })

  test("(28) slot WIRED ⇒ subagent_send_message lands in extraTools", async () => {
    const features = await buildSessionFeatures(
      baseCfg({ subagentMailbox: createSubagentMailbox() }),
    )
    expect(features.extraTools.find((t) => t.name === "subagent_send_message")).toBeDefined()
  })

  test("(29) builder returns the tool bound to the SAME port instance", async () => {
    const port = createSubagentMailbox()
    const tools = buildSubagentMailboxBlock(baseCfg({ subagentMailbox: port }))
    // ADR-0419 added a sibling read tool, so the builder now returns 2; the
    // send tool is still present and bound to the SAME port instance.
    expect(tools.some((t) => t.name === "subagent_send_message")).toBe(true)
    const tool = findTool(tools, "subagent_send_message")
    await drain(tool, { to: "child", kind: "request", body: "via-builder" })
    // the SAME port observes the send
    expect(port.pendingFor("child")).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C. TOOL — execute path
// ─────────────────────────────────────────────────────────────────────────────

describe("subagent mailbox — tool execute (ADR-0416)", () => {
  const toolFor = (port: MailboxPort): Tool =>
    findTool(subagentMailboxTools(port), "subagent_send_message")

  test("(30) send round-trips through the bound port", async () => {
    const port = createSubagentMailbox({ now: tick() })
    const r = await drain(toolFor(port), { to: "child", kind: "request", body: "hello" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("sent message")
    const got = port.read("child")
    expect(got[0]?.body).toBe("hello")
  })

  test("(31) sender id derives from ctx.depth (root vs child)", async () => {
    const port = createSubagentMailbox({ now: tick() })
    await drain(toolFor(port), { to: "x", kind: "request", body: "from-root" }, ctx({ depth: 0 }))
    await drain(toolFor(port), { to: "y", kind: "request", body: "from-child" }, ctx({ depth: 1 }))
    expect(port.list({ from: "root" }).length).toBe(1)
    expect(port.list({ from: "agent@depth-1" }).length).toBe(1)
  })

  test('(32) "parent" target resolves to the parent label', async () => {
    const port = createSubagentMailbox({ now: tick() })
    // a depth-1 child addressing "parent" → root
    await drain(toolFor(port), { to: "parent", kind: "response", body: "done" }, ctx({ depth: 1 }))
    expect(port.list({ to: "root" }).length).toBe(1)
    // root can then read it
    expect(port.read("root")[0]?.body).toBe("done")
  })

  test('(33) "*" broadcast passes through verbatim', async () => {
    const port = createSubagentMailbox({ now: tick() })
    await drain(toolFor(port), { to: "*", kind: "broadcast", body: "all" }, ctx({ depth: 0 }))
    expect(port.list({ to: "*" }).length).toBe(1)
    expect(port.read("someone")[0]?.body).toBe("all")
  })

  test("(34) correlation_id threads into the sent message", async () => {
    const port = createSubagentMailbox({ now: tick() })
    const r = await drain(toolFor(port), {
      to: "x",
      kind: "request",
      body: "q",
      correlation_id: "abc",
    })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("correlation_id: abc")
    expect(port.list()[0]?.correlationId).toBe("abc")
  })

  test("(35) schema rejection — missing body ⇒ ok:false (no throw)", async () => {
    const port = createSubagentMailbox()
    const r = await drain(toolFor(port), { to: "x", kind: "request" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("invalid input")
  })

  test("(36) schema rejection — empty body ⇒ ok:false", async () => {
    const port = createSubagentMailbox()
    const r = await drain(toolFor(port), { to: "x", kind: "request", body: "" })
    expect(r.ok).toBe(false)
  })

  test("(37) schema rejection — bad kind ⇒ ok:false", async () => {
    const port = createSubagentMailbox()
    const r = await drain(toolFor(port), { to: "x", kind: "shout", body: "hi" })
    expect(r.ok).toBe(false)
  })

  test("(38) schema rejection — body over 8000 chars ⇒ ok:false", async () => {
    const port = createSubagentMailbox()
    const r = await drain(toolFor(port), { to: "x", kind: "request", body: "a".repeat(8001) })
    expect(r.ok).toBe(false)
  })

  test("(39) NO-THROW on a throwing fake port ⇒ ok:false 'send failed'", async () => {
    const throwingPort = {
      send() {
        throw new Error("boom")
      },
      read: () => [],
      peek: () => [],
      ack: () => null,
      list: () => [],
      pendingFor: () => 0,
      toSnapshot: () => ({ messages: [] }),
      fromSnapshot: () => {},
    } as MailboxPort
    const r = await drain(toolFor(throwingPort), { to: "x", kind: "request", body: "hi" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("send failed")
  })

  test("(40) HITL tier is pre-approval-ok; isReadOnly false", () => {
    const tool = toolFor(createSubagentMailbox())
    expect(tool.hitlTier?.({} as never)).toBe("pre-approval-ok")
    expect(tool.isReadOnly()).toBe(false)
  })
})
