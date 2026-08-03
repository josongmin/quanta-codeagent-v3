/**
 * RFC07-1 real-front-door e2e — named `to:` delivery through the ACTUAL
 * composition path, not a unit fake.
 *
 * Drives `buildSubagentMailboxBlock(config)` (the tier-1 composition root that
 * threads the host resolver) → the real `subagent_send_message` tool → the real
 * `createSubagentMailbox` store. The registry holds two same-depth running named
 * children (`reviewer`, `tester`) owned by the caller lineage.
 *
 * Exit artifact (RFC07-1): parent sends to two same-depth named children;
 * exactly one target receives, ambiguity/foreign-lineage enqueue count is zero.
 *
 * Red-on-injection: dropping the owner-ledger filter (a foreign reviewer would
 * then deliver) or the unique-match check (a duplicate reviewer would then
 * deliver instead of failing) makes this gate RED.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { buildSubagentMailboxBlock } from "@/agent/tier1/subagent-mailbox"
import { createSubagentMailbox, type MailboxPort } from "@/agent/subagent-mailbox"
import { ownersForRegistry, TaskRegistry } from "@/subagent"
import type { Tool, ToolContext, ToolEvent } from "@/tool"

const runSend = async (
  tool: Tool,
  input: unknown,
  ctx: ToolContext,
): Promise<Extract<ToolEvent, { type: "result" }>["result"]> => {
  const events: ToolEvent[] = []
  for await (const ev of tool.execute(input as never, ctx)) events.push(ev)
  const last = events[events.length - 1]
  if (last?.type !== "result") throw new Error("no result event")
  return last.result
}

const sendTool = (tools: Tool[]): Tool => {
  const t = tools.find((x) => x.name === "subagent_send_message")
  if (t === undefined) throw new Error("subagent_send_message not built")
  return t
}

/** Register a running named child with a mailbox label owned by `owner`. */
const spawnNamed = (
  registry: TaskRegistry,
  opts: { name: string; label: string; owner: string },
): string => {
  const id = registry.newId()
  registry.register({ id, description: `child ${opts.name}`, agentType: opts.name })
  const rec = registry.get(id)
  if (rec !== undefined) rec.mailboxLabel = opts.label
  ownersForRegistry(registry).set(id, opts.owner)
  return id
}

/** Minimal AgentConfig carrying exactly the seams the mailbox block reads. */
const configWith = (
  mailbox: MailboxPort,
  registry: TaskRegistry,
  mailboxAgentId: string,
): AgentConfig =>
  ({
    subagentMailbox: mailbox,
    // The registry the introspect trio shares lives under `subagent.taskRegistry`.
    subagent: { taskRegistry: registry },
    mailboxAgentId,
  }) as unknown as AgentConfig

/** The parent's tool ctx: its lineage/label is "root" (system-minted). */
const parentCtx = (): ToolContext => ({
  cwd: "/tmp",
  signal: new AbortController().signal,
  agentLabel: "root",
})

describe("RFC07-1 named mailbox delivery — real front door", () => {
  test("parent to two same-depth named children: exactly one receives", async () => {
    const mailbox = createSubagentMailbox()
    const registry = new TaskRegistry()
    spawnNamed(registry, { name: "reviewer", label: "root/0", owner: "root" })
    spawnNamed(registry, { name: "tester", label: "root/1", owner: "root" })
    const tools = buildSubagentMailboxBlock(configWith(mailbox, registry, "root"))

    const res = await runSend(
      sendTool(tools),
      { to: "reviewer", kind: "request", body: "please review PR" },
      parentCtx(),
    )
    expect(res.ok).toBe(true)

    // Reviewer's REAL inbox (its mailbox label) got exactly the message.
    expect(mailbox.read("root/0").map((m) => m.body)).toEqual(["please review PR"])
    // Tester received nothing; the name string was never used as an address.
    expect(mailbox.pendingFor("root/1")).toBe(0)
    expect(mailbox.read("reviewer").map((m) => m.body)).toEqual([])
  })

  test("ambiguous name: zero enqueue, typed failure with candidate ids", async () => {
    const mailbox = createSubagentMailbox()
    const registry = new TaskRegistry()
    const a = spawnNamed(registry, { name: "reviewer", label: "root/0", owner: "root" })
    const b = spawnNamed(registry, { name: "reviewer", label: "root/1", owner: "root" })
    const tools = buildSubagentMailboxBlock(configWith(mailbox, registry, "root"))

    const res = await runSend(
      sendTool(tools),
      { to: "reviewer", kind: "request", body: "who am I?" },
      parentCtx(),
    )
    expect(res.ok).toBe(false)
    expect(res.output).toContain("ambiguous")
    expect(res.output).toContain(a)
    expect(res.output).toContain(b)
    // ZERO enqueue at either candidate address (and not at the raw name).
    expect(mailbox.pendingFor("root/0")).toBe(0)
    expect(mailbox.pendingFor("root/1")).toBe(0)
    expect(mailbox.pendingFor("reviewer")).toBe(0)
  })

  test("foreign-lineage-only name: no delivery, no disclosure — falls through to raw path", async () => {
    const mailbox = createSubagentMailbox()
    const registry = new TaskRegistry()
    // The only reviewer is owned by a SIBLING; the caller is root.
    spawnNamed(registry, { name: "reviewer", label: "sib/0", owner: "root/9" })
    const tools = buildSubagentMailboxBlock(configWith(mailbox, registry, "root"))

    const res = await runSend(
      sendTool(tools),
      { to: "reviewer", kind: "request", body: "leak?" },
      parentCtx(),
    )
    // No_match ⇒ verbatim fall-through: the literal "reviewer" is used as the
    // address (undisclosed foreign task), so the sibling's real inbox is UNTOUCHED.
    expect(res.ok).toBe(true)
    expect(mailbox.pendingFor("sib/0")).toBe(0)
    expect(mailbox.read("sib/0").map((m) => m.body)).toEqual([])
    // The failure/success text never leaks the foreign task id or its label.
    expect(res.output).not.toContain("sib/0")
  })

  test("concrete mailbox id + parent + broadcast keep their existing verbatim paths", async () => {
    const mailbox = createSubagentMailbox()
    const registry = new TaskRegistry()
    spawnNamed(registry, { name: "reviewer", label: "root/0", owner: "root" })
    const tools = buildSubagentMailboxBlock(configWith(mailbox, registry, "root"))

    // Concrete label address is NOT a name (no agentType "root/0") ⇒ verbatim.
    const direct = await runSend(
      sendTool(tools),
      { to: "root/0", kind: "request", body: "direct" },
      parentCtx(),
    )
    expect(direct.ok).toBe(true)
    expect(mailbox.read("root/0").map((m) => m.body)).toEqual(["direct"])

    // "parent" from a child resolves to its parent label, unchanged by RFC07-1.
    const childCtx: ToolContext = {
      cwd: "/tmp",
      signal: new AbortController().signal,
      agentLabel: "root/0",
      parentAgentLabel: "root",
    }
    const toParent = await runSend(
      sendTool(tools),
      { to: "parent", kind: "response", body: "to parent" },
      childCtx,
    )
    expect(toParent.ok).toBe(true)
    expect(mailbox.read("root").map((m) => m.body)).toEqual(["to parent"])
  })

  test("gate-OFF parity: no taskRegistry ⇒ named resolution inert, verbatim delivery", async () => {
    const mailbox = createSubagentMailbox()
    // Config WITHOUT taskRegistry ⇒ the block builds tools with no resolver.
    const cfg = { subagentMailbox: mailbox } as unknown as AgentConfig
    const tools = buildSubagentMailboxBlock(cfg)
    const res = await runSend(
      sendTool(tools),
      { to: "reviewer", kind: "request", body: "verbatim" },
      parentCtx(),
    )
    expect(res.ok).toBe(true)
    // "reviewer" is used verbatim as the address (no name resolution wired).
    expect(mailbox.read("reviewer").map((m) => m.body)).toEqual(["verbatim"])
  })
})
