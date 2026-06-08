/** Track C hellgate — inbound MCP elicitation wiring + single-flight lease.
 *
 *  Adversarial coverage:
 *   - an inbound `elicitation/create` request gets a RESPONSE (not dropped);
 *   - no prompter injected → proper `{action:"decline"}` response (the
 *     headless default), never a silent drop;
 *   - an inbound NON-elicitation request gets a JSON-RPC `-32601` error, not a
 *     drop;
 *   - a notification (method, no id) is ignored (no reply);
 *   - the lease coalesces two concurrent same-key prompts into ONE underlying
 *     call, both callers get the same result;
 *   - different lease keys → both prompt;
 *   - accept / decline / cancel envelope shapes are correct;
 *   - a malformed inbound request declines rather than throwing/dropping.
 */

import { describe, expect, it } from "bun:test"
import { McpClient } from "@/mcp/client"
import {
  isElicitationMethod,
  MCP_ELICITATION_METHOD,
  routeElicitation,
} from "@/mcp/elicitation/inbound-router"
import { ElicitationLeasePool } from "@/mcp/elicitation/lease"
import type { ElicitationPrompter, ElicitationResult } from "@/mcp/elicitation/port"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"
import type { McpTransport } from "@/mcp/transports/port"

/** Drain enqueued microtasks so an inbound request's async route + reply has
 *  fully settled before we assert on what was sent. A handful of ticks covers
 *  `routeElicitation` (await prompter) → `.then` (send). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** Scripted transport: tests push inbound messages and inspect every send. */
class ScriptedTransport implements McpTransport {
  private messageHandler: ((msg: JsonRpcMessage) => void) | null = null
  readonly sent: Array<Record<string, unknown>> = []

  start(): Promise<void> {
    return Promise.resolve()
  }
  send(payload: unknown): Error | null {
    this.sent.push(payload as Record<string, unknown>)
    return null
  }
  onMessage(handler: (msg: JsonRpcMessage) => void): () => void {
    this.messageHandler = handler
    return () => {
      this.messageHandler = null
    }
  }
  onExit(_handler: () => void): () => void {
    return () => {}
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
  emit(msg: JsonRpcMessage): void {
    this.messageHandler?.(msg)
  }
}

const startReady = async (client: McpClient, transport: ScriptedTransport): Promise<void> => {
  const startP = client.start()
  await flush()
  const init = transport.sent[0] as { id: number }
  transport.emit({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: "2025-06-18" } })
  await startP
}

/** Spy prompter recording calls and returning a scripted result. */
const spyPrompter = (
  result: ElicitationResult<string>,
): { prompter: ElicitationPrompter; calls: () => number } => {
  let n = 0
  const ret = async () => {
    n += 1
    return result
  }
  return {
    calls: () => n,
    prompter: {
      promptString: ret,
      promptNumber: async () => result as unknown as ElicitationResult<number>,
      promptInteger: async () => result as unknown as ElicitationResult<number>,
      promptBoolean: async () => result as unknown as ElicitationResult<boolean>,
      promptEnum: ret,
      promptMultiEnum: async () => result as unknown as ElicitationResult<ReadonlyArray<string>>,
      promptSingleEnum: ret,
      promptUrl: ret,
    },
  }
}

const lastSend = (t: ScriptedTransport): Record<string, unknown> =>
  t.sent[t.sent.length - 1] as Record<string, unknown>

const stringSchema = { properties: { name: { type: "string" } } }

describe("inbound elicitation wiring (Track C, GOAL 1)", () => {
  it("inbound elicitation/create gets a RESPONSE — not dropped (default headless → decline)", async () => {
    const transport = new ScriptedTransport()
    const client = new McpClient({ name: "t", command: ["x"] }, { transport })
    await startReady(client, transport)
    const before = transport.sent.length

    transport.emit({
      jsonrpc: "2.0",
      id: 99,
      method: MCP_ELICITATION_METHOD,
      params: { message: "Your name?", requestedSchema: stringSchema },
    })
    await flush()

    expect(transport.sent.length).toBe(before + 1)
    const reply = lastSend(transport)
    expect(reply.id).toBe(99)
    expect(reply.result).toEqual({ action: "decline" })
    await client.stop()
  })

  it("injected prompter that accepts → {action:'accept', content:{name:value}}", async () => {
    const transport = new ScriptedTransport()
    const { prompter } = spyPrompter({ ok: true, value: "Ada" })
    const client = new McpClient(
      { name: "t", command: ["x"] },
      { transport, elicitationPrompter: prompter },
    )
    await startReady(client, transport)

    transport.emit({
      jsonrpc: "2.0",
      id: 7,
      method: MCP_ELICITATION_METHOD,
      params: { message: "Your name?", requestedSchema: stringSchema },
    })
    await flush()

    const reply = lastSend(transport)
    expect(reply.id).toBe(7)
    expect(reply.result).toEqual({ action: "accept", content: { name: "Ada" } })
    await client.stop()
  })

  it("genuinely-unknown inbound request → JSON-RPC -32601, not dropped", async () => {
    // NB: `sampling/createMessage` (ADR-0470) AND `roots/list` (H19) are now
    // RECOGNIZED inbound methods — they route to their handlers, not -32601. So
    // this -32601 case uses a method none of elicitation/sampling/roots handles.
    const transport = new ScriptedTransport()
    const client = new McpClient({ name: "t", command: ["x"] }, { transport })
    await startReady(client, transport)
    const before = transport.sent.length

    transport.emit({ jsonrpc: "2.0", id: 5, method: "totally/unknown", params: {} })
    await flush()

    expect(transport.sent.length).toBe(before + 1)
    const reply = lastSend(transport)
    expect(reply.id).toBe(5)
    expect((reply.error as { code: number }).code).toBe(-32601)
    await client.stop()
  })

  it("notification (method, no id) is ignored — no reply", async () => {
    const transport = new ScriptedTransport()
    const client = new McpClient({ name: "t", command: ["x"] }, { transport })
    await startReady(client, transport)
    const before = transport.sent.length

    transport.emit({ jsonrpc: "2.0", method: "notifications/somethingHappened", params: {} })
    await flush()

    expect(transport.sent.length).toBe(before)
    await client.stop()
  })

  it("malformed inbound elicitation (no requestedSchema) declines, never throws/drops", async () => {
    const transport = new ScriptedTransport()
    const { prompter, calls } = spyPrompter({ ok: true, value: "x" })
    const client = new McpClient(
      { name: "t", command: ["x"] },
      { transport, elicitationPrompter: prompter },
    )
    await startReady(client, transport)

    transport.emit({ jsonrpc: "2.0", id: 1, method: MCP_ELICITATION_METHOD, params: {} })
    await flush()

    const reply = lastSend(transport)
    expect(reply.result).toEqual({ action: "decline" })
    expect(calls()).toBe(0) // never reached the prompter
    await client.stop()
  })
})

describe("elicitation response envelope mapping", () => {
  it("ok → accept+content (internal method keys on 'value')", async () => {
    const { prompter } = spyPrompter({ ok: true, value: "hi" })
    const r = await routeElicitation(prompter, "elicitation/promptString", { prompt: "p" })
    expect(r).toEqual({ action: "accept", content: { value: "hi" } })
  })

  it("cancelled → cancel", async () => {
    const { prompter } = spyPrompter({ ok: false, reason: "cancelled" })
    const r = await routeElicitation(prompter, "elicitation/promptString", { prompt: "p" })
    expect(r).toEqual({ action: "cancel" })
  })

  it("headless-denied / validation-error → decline", async () => {
    const denied = await routeElicitation(
      spyPrompter({ ok: false, reason: "headless-denied" }).prompter,
      "elicitation/promptString",
      { prompt: "p" },
    )
    expect(denied).toEqual({ action: "decline" })
    const invalid = await routeElicitation(
      spyPrompter({ ok: false, reason: "validation-error" }).prompter,
      "elicitation/promptString",
      { prompt: "p" },
    )
    expect(invalid).toEqual({ action: "decline" })
  })

  it("spec enum schema routes to promptEnum and accepts under the prop name", async () => {
    const { prompter } = spyPrompter({ ok: true, value: "red" })
    const r = await routeElicitation(prompter, MCP_ELICITATION_METHOD, {
      message: "pick",
      requestedSchema: { properties: { color: { type: "string", enum: ["red", "blue"] } } },
    })
    expect(r).toEqual({ action: "accept", content: { color: "red" } })
  })

  it("isElicitationMethod recognizes spec + internal, rejects others", () => {
    expect(isElicitationMethod(MCP_ELICITATION_METHOD)).toBe(true)
    expect(isElicitationMethod("elicitation/promptBoolean")).toBe(true)
    expect(isElicitationMethod("tools/call")).toBe(false)
    expect(isElicitationMethod("sampling/createMessage")).toBe(false)
  })

  it("multi-property requestedSchema declines (only single-primitive auto-mapped)", async () => {
    const { prompter, calls } = spyPrompter({ ok: true, value: "x" })
    const r = await routeElicitation(prompter, MCP_ELICITATION_METHOD, {
      message: "two things",
      requestedSchema: { properties: { a: { type: "string" }, b: { type: "string" } } },
    })
    expect(r).toEqual({ action: "decline" })
    expect(calls()).toBe(0)
  })
})

describe("inbound elicitation/promptUrl (ticket-22)", () => {
  it("valid url request → accept envelope (content keys on 'value')", async () => {
    const { prompter } = spyPrompter({ ok: true, value: "https://example.com" })
    const r = await routeElicitation(prompter, "elicitation/promptUrl", {
      prompt: "Open?",
      url: "https://example.com",
    })
    expect(r).toEqual({ action: "accept", content: { value: "https://example.com" } })
  })

  it("cancelled url prompt → cancel", async () => {
    const { prompter } = spyPrompter({ ok: false, reason: "cancelled" })
    const r = await routeElicitation(prompter, "elicitation/promptUrl", {
      prompt: "Open?",
      url: "https://example.com",
    })
    expect(r).toEqual({ action: "cancel" })
  })

  it("headless-denied url prompt → decline (never throws/drops)", async () => {
    const { prompter } = spyPrompter({ ok: false, reason: "headless-denied" })
    const r = await routeElicitation(prompter, "elicitation/promptUrl", {
      prompt: "Open?",
      url: "https://example.com",
    })
    expect(r).toEqual({ action: "decline" })
  })

  it("malformed url request (non-http scheme) → decline, prompter never reached", async () => {
    const { prompter, calls } = spyPrompter({ ok: true, value: "x" })
    const r = await routeElicitation(prompter, "elicitation/promptUrl", {
      prompt: "Open?",
      url: "javascript:alert(1)", // SECURITY: schema rejects non-http(s)
    })
    expect(r).toEqual({ action: "decline" })
    expect(calls()).toBe(0)
  })

  it("missing url field → decline (schema rejects, never throws)", async () => {
    const { prompter, calls } = spyPrompter({ ok: true, value: "x" })
    const r = await routeElicitation(prompter, "elicitation/promptUrl", { prompt: "Open?" })
    expect(r).toEqual({ action: "decline" })
    expect(calls()).toBe(0)
  })
})

describe("ElicitationLeasePool single-flight (Track C, GOAL 2)", () => {
  /** A prompter whose call we can hold open until released, to force overlap. */
  const gatedPrompter = (): {
    prompter: ElicitationPrompter
    calls: () => number
    resolveAll: (value: string) => void
  } => {
    let n = 0
    const waiters: Array<(r: ElicitationResult<string>) => void> = []
    const gated = () => {
      n += 1
      return new Promise<ElicitationResult<string>>((res) => waiters.push(res))
    }
    return {
      calls: () => n,
      resolveAll: (value: string) => {
        for (const w of waiters) w({ ok: true, value })
        waiters.length = 0
      },
      prompter: {
        promptString: gated,
        promptNumber: async () => ({ ok: true, value: 0 }),
        promptInteger: async () => ({ ok: true, value: 0 }),
        promptBoolean: async () => ({ ok: true, value: true }),
        promptEnum: gated,
        promptMultiEnum: async () => ({ ok: true, value: [] }),
        promptSingleEnum: gated,
        promptUrl: gated,
      },
    }
  }

  it("two concurrent same-key prompts → prompter invoked ONCE, both get result", async () => {
    const { prompter, calls, resolveAll } = gatedPrompter()
    const pool = new ElicitationLeasePool(prompter)
    const bound = pool.forContext({ serverId: "srvA", leaseKey: "token" })

    const p1 = bound.promptString({ prompt: "Token?" })
    const p2 = bound.promptString({ prompt: "Token?" })
    await flush()

    expect(calls()).toBe(1) // single-flight coalesced
    resolveAll("secret")
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toEqual({ ok: true, value: "secret" })
    expect(r2).toEqual({ ok: true, value: "secret" })
    expect(calls()).toBe(1)
  })

  it("different lease keys → both prompt", async () => {
    const { prompter, calls, resolveAll } = gatedPrompter()
    const pool = new ElicitationLeasePool(prompter)
    const a = pool.forContext({ serverId: "srvA", leaseKey: "tokenA" })
    const b = pool.forContext({ serverId: "srvA", leaseKey: "tokenB" })

    const p1 = a.promptString({ prompt: "Token?" })
    const p2 = b.promptString({ prompt: "Token?" })
    await flush()

    expect(calls()).toBe(2)
    resolveAll("x")
    await Promise.all([p1, p2])
  })

  it("same key different serverId → both prompt (server-scoped)", async () => {
    const { prompter, calls, resolveAll } = gatedPrompter()
    const pool = new ElicitationLeasePool(prompter)
    const a = pool.forContext({ serverId: "srvA", leaseKey: "token" })
    const b = pool.forContext({ serverId: "srvB", leaseKey: "token" })

    const p1 = a.promptString({ prompt: "Token?" })
    const p2 = b.promptString({ prompt: "Token?" })
    await flush()

    expect(calls()).toBe(2)
    resolveAll("x")
    await Promise.all([p1, p2])
  })

  it("key freed after settle → a later same-key call re-prompts (no stale replay)", async () => {
    const { prompter, calls, resolveAll } = gatedPrompter()
    const pool = new ElicitationLeasePool(prompter)
    const bound = pool.forContext({ serverId: "srvA", leaseKey: "token" })

    const p1 = bound.promptString({ prompt: "Token?" })
    await flush()
    resolveAll("first")
    await p1
    expect(calls()).toBe(1)

    const p2 = bound.promptString({ prompt: "Token?" })
    await flush()
    expect(calls()).toBe(2) // re-prompted, not replayed
    resolveAll("second")
    expect(await p2).toEqual({ ok: true, value: "second" })
  })

  it("falls back to title/prompt when no explicit leaseKey is given", async () => {
    const { prompter, calls, resolveAll } = gatedPrompter()
    const pool = new ElicitationLeasePool(prompter)
    const bound = pool.forContext({ serverId: "srvA" })

    const p1 = bound.promptString({ prompt: "Same question" })
    const p2 = bound.promptString({ prompt: "Same question" })
    await flush()
    expect(calls()).toBe(1)
    resolveAll("x")
    await Promise.all([p1, p2])
  })
})
