/** N3 host-wire e2e hellgate — drives the REAL composition end to end:
 *
 *    fake MCP server(s) over the transport seam
 *      → real `@/agent/mcp-bridge#loadMcpTools` (builds the aggregate
 *        `ResourcesHandle` over the live clients)
 *      → `mcpResourcesTools(handle)` registered through the mcp-origin array
 *      → real `dispatchTool` returns the live server's entries.
 *
 *  Pins the claims the wire makes:
 *    (1) knob-ON + a capable server ⇒ the five `mcp_*` tools register AND a
 *        dispatch through `mcp_list_resources` returns the server's resources;
 *    (2) MULTI-client ⇒ `listResources`/`listPrompts` CONCAT across servers and
 *        `readResource`/`getPrompt` ROUTE to the owning server;
 *    (3) knob-OFF / zero capable servers ⇒ the aggregate is `undefined` ⇒ the
 *        tools are ABSENT ⇒ the registry is byte-identical to the bare default;
 *    (4) the output is `mcp`-origin ⇒ the H2 `<untrusted-source>` envelope wraps
 *        it (the security invariant these tools depend on).
 */

import { describe, expect, test } from "bun:test"
import { aggregateResourcesHandle, loadMcpTools, resourcesHandleFor } from "@/agent/mcp-bridge"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"
import type { McpTransport } from "@/mcp/transports/port"
import {
  buildDefaultTools,
  deriveProvenance,
  mcpResourcesTools,
  type ResourcesHandle,
  type Tool,
  type ToolContext,
  type ToolEvent,
  ToolRegistry,
} from "@/tool"

const flush = async (): Promise<void> => {
  for (let i = 0; i < 32; i++) await Promise.resolve()
}

/** A minimal real MCP server over the transport seam. `caps` controls what the
 *  `initialize` response advertises so a test can build a server that speaks
 *  resources only, prompts only, both, or neither. `tools/list` always answers
 *  empty so `loadMcpTools` keeps the server (a `tools/list` failure would make
 *  the bridge skip it). The `resources`/`prompts` catalog is per-instance so the
 *  multi-client routing test can give each server its own URIs/names. */
class FakeServer implements McpTransport {
  private handler: ((msg: JsonRpcMessage) => void) | null = null

  constructor(
    private readonly caps: { resources?: boolean; prompts?: boolean },
    private readonly catalog: {
      resources?: Array<{ uri: string; name?: string; mimeType?: string }>
      contents?: Record<string, { mimeType?: string; text?: string }>
      prompts?: Array<{ name: string }>
      promptText?: Record<string, string>
    } = {},
  ) {}

  start(): Promise<void> {
    return Promise.resolve()
  }
  send(payload: unknown): Error | null {
    const msg = payload as Record<string, unknown>
    if (typeof msg.id === "number" && typeof msg.method === "string") {
      queueMicrotask(() => this.answer(msg.id as number, msg.method as string, msg.params))
    }
    return null
  }
  onMessage(handler: (msg: JsonRpcMessage) => void): () => void {
    this.handler = handler
    return () => {
      this.handler = null
    }
  }
  onExit(_handler: () => void): () => void {
    return () => {}
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
  private emit(msg: JsonRpcMessage): void {
    this.handler?.(msg)
  }

  private answer(id: number, method: string, params: unknown): void {
    switch (method) {
      case "initialize": {
        const capabilities: Record<string, unknown> = { tools: {} }
        if (this.caps.resources) capabilities.resources = {}
        if (this.caps.prompts) capabilities.prompts = {}
        this.emit({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-06-18",
            serverInfo: { name: "fake", version: "1.0" },
            capabilities,
          },
        })
        return
      }
      case "tools/list":
        this.emit({ jsonrpc: "2.0", id, result: { tools: [] } })
        return
      case "resources/list":
        this.emit({ jsonrpc: "2.0", id, result: { resources: this.catalog.resources ?? [] } })
        return
      case "resources/read": {
        const uri = (params as { uri: string }).uri
        const c = this.catalog.contents?.[uri]
        if (c === undefined) {
          this.emit({ jsonrpc: "2.0", id, error: { code: -32602, message: "no such resource" } })
          return
        }
        this.emit({ jsonrpc: "2.0", id, result: { contents: [{ uri, ...c }] } })
        return
      }
      case "prompts/list":
        this.emit({ jsonrpc: "2.0", id, result: { prompts: this.catalog.prompts ?? [] } })
        return
      case "prompts/get": {
        const name = (params as { name: string }).name
        const text = this.catalog.promptText?.[name]
        if (text === undefined) {
          this.emit({ jsonrpc: "2.0", id, error: { code: -32602, message: "no such prompt" } })
          return
        }
        this.emit({
          jsonrpc: "2.0",
          id,
          result: { messages: [{ role: "user", content: { type: "text", text } }] },
        })
        return
      }
      default:
        this.emit({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } })
    }
  }
}

/** Run `loadMcpTools` over the given fake servers, flushing the microtask queue
 *  so each client's `initialize` + `tools/list` round-trip completes. */
const loadOver = async (
  servers: ReadonlyArray<{ name: string; transport: McpTransport }>,
): Promise<{ tools: Tool[]; resources?: ResourcesHandle; stop: () => Promise<void> }> => {
  const byName = new Map(servers.map((s) => [s.name, s.transport]))
  const p = loadMcpTools(
    servers.map((s) => ({ name: s.name, command: ["x"] })),
    undefined,
    { transportFor: (cfg) => byName.get(cfg.name) as never },
  )
  // The transports answer on microtasks; flush so start()/listTools() resolve.
  for (let i = 0; i < 8; i++) await flush()
  const res = await p
  return {
    tools: res.tools,
    ...(res.resources !== undefined ? { resources: res.resources } : {}),
    stop: async () => {
      for (const c of res.clients) await c.stop().catch(() => undefined)
    },
  }
}

const ctx = (): ToolContext => ({ cwd: "/repo", signal: new AbortController().signal })

const run = async (tool: Tool, input: unknown): Promise<{ ok: boolean; output: string }> => {
  let last = { ok: false, output: "no result" }
  for await (const ev of tool.execute(input as never, ctx()) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") last = { ok: ev.result.ok, output: ev.result.output }
  }
  return last
}

const byName = (tools: Tool[], name: string): Tool | undefined => tools.find((t) => t.name === name)

const N3_TOOLS = [
  "mcp_list_resources",
  "mcp_list_resource_templates",
  "mcp_read_resource",
  "mcp_read_resource_dir", // B4
  "mcp_list_prompts",
  "mcp_get_prompt",
] as const

// ── (1) knob-ON + a capable server activates over the live client ────────────

describe("N3 host-wire — live single client activates the five tools", () => {
  test("a server that advertises resources+prompts ⇒ aggregate built, tools dispatch over the live client", async () => {
    const server = new FakeServer(
      { resources: true, prompts: true },
      {
        resources: [{ uri: "mem://readme", name: "README" }],
        contents: { "mem://readme": { mimeType: "text/markdown", text: "# Hello" } },
        prompts: [{ name: "greet" }],
        promptText: { greet: "Say hi" },
      },
    )
    const loaded = await loadOver([{ name: "s1", transport: server }])
    try {
      expect(loaded.resources).toBeDefined()
      const tools = mcpResourcesTools(loaded.resources as ResourcesHandle)
      expect(tools.map((t) => t.name).sort()).toEqual([...N3_TOOLS].sort())

      const list = await run(byName(tools, "mcp_list_resources") as Tool, {})
      expect(list.ok).toBe(true)
      expect(list.output).toContain("mem://readme")

      const read = await run(byName(tools, "mcp_read_resource") as Tool, { uri: "mem://readme" })
      expect(read.ok).toBe(true)
      expect(read.output).toContain("# Hello")

      const prompts = await run(byName(tools, "mcp_list_prompts") as Tool, {})
      expect(prompts.ok).toBe(true)
      expect(prompts.output).toContain("greet")
    } finally {
      await loaded.stop()
    }
  })
})

// ── (2) multi-client concat + routing ───────────────────────────────────────

describe("N3 host-wire — multi-client aggregation", () => {
  test("listResources CONCAT across two servers; readResource/getPrompt ROUTE to the owner", async () => {
    const a = new FakeServer(
      { resources: true, prompts: true },
      {
        resources: [
          { uri: "a://one", name: "A1" },
          // B4 — a directory-shaped layout under `a://dir/` to exercise
          // readResourceDir over the LIVE client → aggregate (wiring-proof).
          { uri: "a://dir/", mimeType: "inode/directory" },
          { uri: "a://dir/child.txt" },
          { uri: "a://dir/sub", mimeType: "inode/directory" },
          { uri: "a://dir/sub/grandchild.txt" },
        ],
        contents: { "a://one": { text: "alpha" } },
        prompts: [{ name: "pa" }],
        promptText: { pa: "from-A" },
      },
    )
    const b = new FakeServer(
      { resources: true, prompts: true },
      {
        resources: [{ uri: "b://two", name: "B1" }],
        contents: { "b://two": { text: "bravo" } },
        prompts: [{ name: "pb" }],
        promptText: { pb: "from-B" },
      },
    )
    const loaded = await loadOver([
      { name: "sa", transport: a },
      { name: "sb", transport: b },
    ])
    try {
      const handle = loaded.resources as ResourcesHandle
      const list = await handle.listResources()
      expect(list.ok).toBe(true)
      if (!list.ok) throw new Error("unreachable")
      expect(list.value.map((r) => r.uri).sort()).toEqual([
        "a://dir/",
        "a://dir/child.txt",
        "a://dir/sub",
        "a://dir/sub/grandchild.txt",
        "a://one",
        "b://two",
      ])

      const prompts = await handle.listPrompts()
      expect(prompts.ok).toBe(true)
      if (!prompts.ok) throw new Error("unreachable")
      expect(prompts.value.map((p) => p.name).sort()).toEqual(["pa", "pb"])

      // routing — each uri/name is owned by exactly one server.
      const readB = await handle.readResource("b://two")
      expect(readB.ok).toBe(true)
      if (!readB.ok) throw new Error("unreachable")
      expect(readB.value[0]?.text).toBe("bravo")

      const getA = await handle.getPrompt("pa")
      expect(getA.ok).toBe(true)
      if (!getA.ok) throw new Error("unreachable")
      const msg = getA.value.messages[0]?.content as { text?: string }
      expect(msg.text).toBe("from-A")

      // a uri no server owns ⇒ a typed failure routed from the capable servers,
      // never a throw.
      const miss = await handle.readResource("z://nope")
      expect(miss.ok).toBe(false)

      // B4 — readResourceDir over the LIVE aggregate returns ONLY direct children
      // of `a://dir/` (the dir entry + grandchild excluded), and a subdir keeps
      // its inode/directory mimeType. This exercises McpClient.readResourceDir +
      // the concat aggregate, not a hand-rolled fake.
      const dir = await handle.readResourceDir("a://dir/")
      expect(dir.ok).toBe(true)
      if (!dir.ok) throw new Error("unreachable")
      expect(dir.value.map((e) => e.uri).sort()).toEqual(["a://dir/child.txt", "a://dir/sub"])
      const sub = dir.value.find((e) => e.uri === "a://dir/sub")
      expect(sub?.mimeType).toBe("inode/directory")
    } finally {
      await loaded.stop()
    }
  })
})

// ── (3) zero capable servers + knob-off byte-identity ───────────────────────

describe("N3 host-wire — absent / byte-identical when no capable server", () => {
  test("a server advertising NEITHER resources NOR prompts ⇒ aggregate undefined", async () => {
    const plain = new FakeServer({}, {})
    const loaded = await loadOver([{ name: "plain", transport: plain }])
    try {
      expect(loaded.resources).toBeUndefined()
    } finally {
      await loaded.stop()
    }
  })

  test("EMPTY client list ⇒ resourcesHandleFor === undefined", () => {
    expect(resourcesHandleFor([])).toBeUndefined()
  })

  test("registering with NO mcpResources slot is byte-identical to the bare default menu", () => {
    const bare = new ToolRegistry(buildDefaultTools())
    const bareNames = bare
      .all()
      .map((t) => t.name)
      .sort()
    // The N3 tools must NOT appear in the bare default menu (the knob-off /
    // no-capable-server registry path).
    for (const n of N3_TOOLS) expect(bareNames.includes(n)).toBe(false)
  })
})

// ── (4) provenance — the tools register through the mcp-origin array ─────────

describe("N3 host-wire — mcp-origin ⇒ H2 untrusted envelope", () => {
  test("registered via the mcpTools array, deriveProvenance(name,'mcp') === 'mcp'", () => {
    // Mirror the production wire: the five tools go into the mcp-origin array,
    // so the registry tags them `mcp` ⇒ dispatch wraps their output in the H2
    // envelope. (Routing through DefaultToolPorts would tag them `builtin` and
    // LOSE the envelope — the reason N3 is wired at the mcpTools layer.)
    const handle: ResourcesHandle = aggregateResourcesHandle([])
    const tools = mcpResourcesTools(handle)
    const origin = new Map<string, "mcp">(tools.map((t) => [t.name, "mcp"]))
    const registry = new ToolRegistry(tools, origin)
    for (const n of N3_TOOLS) {
      expect(deriveProvenance(n, registry.originOf(n))).toBe("mcp")
    }
  })
})
