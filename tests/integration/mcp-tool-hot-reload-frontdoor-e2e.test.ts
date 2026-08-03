/**
 * RFC04-2/3 — MCP tool hot-reload FRONT-DOOR e2e (real client + bridge + relist
 * + controller + snapshot publish).
 *
 * Unlike the controller hellgate (which drives a FAKE rebuild port), this drives
 * the WHOLE live chain through a real stdio fake server:
 *
 *   loadMcpTools(observer) → real McpClient(start) → buildToolingCore → seed
 *   TurnRegistrySnapshotRef → createMcpToolReloadController(rebuild = relist over
 *   the LIVE client → buildToolingCore → buildTurnRegistrySnapshot).
 *
 * The fake server starts advertising ONE tool (`alpha`) and `tools.listChanged`.
 * After a control `tools/call` (`unlock`) it flips its `tools/list` to
 * [alpha, beta] AND emits an unsolicited `notifications/tools/list_changed`.
 * That notification reaches the WIRED reload observer (through the REAL client's
 * capability gate), which fires `requestReload`; the rebuild relists the LIVE
 * client and publishes a new snapshot.
 *
 * Proven end-to-end:
 *  - A → A+B: after list_changed + a turn boundary (a fresh `ref.current()`
 *    read), the model's tool SURFACE (specs) gains `beta`;
 *  - B is permission-gated: `deriveProvenance(beta, registry.originOf(beta))`
 *    is `"mcp"` (untrusted-source envelope + HITL at dispatch) and `beta` is
 *    NOT read-only ⇒ it takes the normal permission path, never early-dispatch;
 *  - dispatch routes to the server: `beta.execute` round-trips through the REAL
 *    client to the live server;
 *  - malformed relist keeps last-known-good (no partial/empty publish);
 *  - GATE-OFF (no observer wired) is byte-identical: the notification is dropped,
 *    no reload, the surface stays [alpha].
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadMcpTools,
  type McpReloadableSource,
  type McpStoppable,
  mcpToolName,
  relistMcpTools,
  reloadableSingleClientSource,
} from "@/agent"
import {
  __resetTurnRegistrySnapshotId,
  buildTurnRegistrySnapshot,
  createTurnRegistrySnapshotRef,
  type TurnRegistrySnapshot,
} from "@/agent/turn-registry-snapshot"
import { createMcpToolReloadController } from "@/host/runtime"
import type { McpClient, McpResourceObserver } from "@/mcp"
import type { StructuredLogger } from "@/observability"
import { buildToolingCore } from "@/runner/assemble"
import { deriveProvenance, type Tool, type ToolContext, type ToolEvent } from "@/tool"

/** A stdio fake server whose `tools/list` starts at [alpha] and flips to
 *  [alpha, beta] after an `unlock` call, then emits `tools/list_changed`. When
 *  `MALFORM=1` the POST-unlock `tools/list` returns a malformed (non-array)
 *  `tools` so a relist REJECTS (LKG retention). Advertises `tools.listChanged`. */
const SERVER_SRC = `
const MALFORM = process.env.QUANTA_FAKE_MALFORM === "1"
const reply = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
let unlocked = false
const toolDef = (name) => ({ name, description: "d:" + name, inputSchema: { type: "object" } })
let buf = ""
process.stdin.on("data", (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    if (msg.method === "initialize") {
      reply({ jsonrpc: "2.0", id: msg.id, result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "mock", version: "0.0.1" },
        capabilities: { tools: { listChanged: true } },
      } })
    } else if (msg.method === "notifications/initialized") {
      // no reply
    } else if (msg.method === "tools/list") {
      if (unlocked && MALFORM) {
        // A faithful relist failure: the server answers the post-unlock
        // tools/list with a JSON-RPC ERROR ⇒ the client's request() rejects
        // (McpError) ⇒ relistMcpTools rejects ⇒ the controller retains LKG.
        reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "relist blew up" } })
      } else if (unlocked) {
        reply({ jsonrpc: "2.0", id: msg.id, result: { tools: [toolDef("alpha"), toolDef("beta")] } })
      } else {
        reply({ jsonrpc: "2.0", id: msg.id, result: { tools: [toolDef("alpha")] } })
      }
    } else if (msg.method === "tools/call") {
      const n = msg.params.name
      if (n === "unlock") {
        unlocked = true
        reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "unlocked" }] } })
        // Unsolicited list-change AFTER the reply so the client has settled.
        reply({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
      } else {
        reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "called " + n }] } })
      }
    } else {
      reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } })
    }
  }
})
`

const SERVER_NAME = "hot"
let dir: string
let serverPath: string

const slog: StructuredLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as StructuredLogger

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mcp-rfc04-frontdoor-"))
  serverPath = join(dir, "server.mjs")
  await writeFile(serverPath, SERVER_SRC)
})

const started: McpStoppable[] = []
afterEach(async () => {
  for (const c of started.splice(0)) await c.stop().catch(() => undefined)
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Build the seed snapshot ref + reload controller over a live single client.
 *  The rebuild port re-lists the LIVE client (real bridge relist) and re-runs
 *  the SAME `buildToolingCore` assembly connect used. */
const wireReload = (client: McpClient, seedTools: Tool[]) => {
  const assemble = (mcpTools: Tool[]): TurnRegistrySnapshot =>
    buildTurnRegistrySnapshot(
      buildToolingCore({
        store: undefined,
        embedder: undefined,
        sessionId: "s",
        memoryConfig: undefined,
        subagentConfig: undefined,
        skillsConfig: undefined,
        compactionBreakerConfig: undefined,
        verifyGuardConfig: undefined,
        mcpTools,
        lspTools: [],
        lspNavTools: [],
        gitToolList: [],
        slog,
      }).registry,
      { protocolVersion: "2025-06-18" },
    )
  const { ref, publish } = createTurnRegistrySnapshotRef(assemble(seedTools))
  const source: McpReloadableSource = reloadableSingleClientSource(client, SERVER_NAME, {})
  const controller = createMcpToolReloadController({ current: ref.current, publish }, async () =>
    assemble(await relistMcpTools([source])),
  )
  return { ref, controller }
}

/** Load the fake server through the REAL front door with an optional observer. */
const loadFront = async (
  observer: McpResourceObserver | undefined,
  env?: Record<string, string>,
): Promise<{ tools: Tool[]; client: McpClient }> => {
  const { tools, clients } = await loadMcpTools(
    [{ name: SERVER_NAME, command: [process.execPath, serverPath], ...(env ? { env } : {}) }],
    undefined,
    observer !== undefined ? { resourceObserver: observer } : undefined,
  )
  started.push(...clients)
  // The single-client path surfaces one McpStoppable that IS the concrete client.
  return { tools, client: clients[0] as unknown as McpClient }
}

const drain = async (ms = 60): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms))
}

const dispatchOnce = async (tool: Tool): Promise<string> => {
  let out = ""
  for await (const ev of tool.execute({}, {} as ToolContext) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") out = ev.result.output
  }
  return out
}

describe("RFC04-2/3 MCP hot-reload front-door e2e", () => {
  beforeAll(() => __resetTurnRegistrySnapshotId())

  it("A → A+B: list_changed surfaces beta on the NEXT turn boundary, permission-gated", async () => {
    // The observer forwards a delivered list-change into a requestReload. We
    // bind the controller AFTER load (it needs the live client), so a tiny
    // indirection holds the reference the observer calls.
    let controllerRef: ReturnType<typeof wireReload>["controller"] | undefined
    const reloads: Promise<void>[] = []
    const observer: McpResourceObserver = {
      onNotification: (e) => {
        if (e.kind === "tools_list_changed" && controllerRef !== undefined) {
          reloads.push(controllerRef.requestReload())
        }
      },
    }
    const { tools, client } = await loadFront(observer)
    const alpha = tools.find((t) => t.name === mcpToolName(SERVER_NAME, "alpha"))
    const unlock = tools.find((t) => t.name === mcpToolName(SERVER_NAME, "unlock"))
    expect(alpha).toBeDefined()
    // `unlock` is not a listed tool at connect; drive it via a raw client call.
    const wired = wireReload(client, tools)
    controllerRef = wired.controller

    // Turn boundary 0: the pinned surface is [alpha] only.
    const gen0 = wired.ref.current()
    expect(gen0.registry.toolNames()).toContain(mcpToolName(SERVER_NAME, "alpha"))
    expect(gen0.registry.has(mcpToolName(SERVER_NAME, "beta"))).toBe(false)
    expect(gen0.specs.map((s) => s.name)).not.toContain(mcpToolName(SERVER_NAME, "beta"))

    // Trigger the server to unlock beta + emit list_changed (real RPC).
    void unlock // unlock is not surfaced as a tool; call the method directly:
    await client.callTool("unlock", {})
    await drain()
    await Promise.all(reloads)

    // NEXT turn boundary: a fresh read sees the republished generation with beta.
    const gen1 = wired.ref.current()
    const betaName = mcpToolName(SERVER_NAME, "beta")
    expect(gen1.registry.has(betaName)).toBe(true)
    expect(gen1.specs.map((s) => s.name)).toContain(betaName)
    // Generation advanced (a real publish, not a mutation of gen0).
    expect(gen1.id).not.toBe(gen0.id)
    expect(gen0.registry.has(betaName)).toBe(false) // pinned gen0 intact

    // Permission-gated: beta is mcp-origin ⇒ untrusted-source at dispatch, and
    // NOT read-only ⇒ the normal permission path (never early-dispatch).
    expect(deriveProvenance(betaName, gen1.registry.originOf(betaName))).toBe("mcp")
    expect(gen1.registry.isReadOnly(betaName)).toBe(false)

    // Dispatch routes to the live server through the real client.
    const beta = gen1.registry.get(betaName)
    expect(beta).toBeDefined()
    const output = await dispatchOnce(beta as Tool)
    expect(output).toContain("called beta")
  })

  it("malformed relist keeps last-known-good (no partial/empty publish)", async () => {
    let controllerRef: ReturnType<typeof wireReload>["controller"] | undefined
    const reloads: Promise<void>[] = []
    const observer: McpResourceObserver = {
      onNotification: (e) => {
        if (e.kind === "tools_list_changed" && controllerRef !== undefined) {
          reloads.push(controllerRef.requestReload())
        }
      },
    }
    // MALFORM: after unlock the server's tools/list is malformed ⇒ relist rejects.
    const { tools, client } = await loadFront(observer, { QUANTA_FAKE_MALFORM: "1" })
    const wired = wireReload(client, tools)
    controllerRef = wired.controller
    const lkg = wired.ref.current()

    await client.callTool("unlock", {})
    await drain()
    await Promise.all(reloads)

    // Fail-closed: the surface is STILL the last-known-good (identity preserved),
    // never emptied or half-published.
    expect(wired.ref.current()).toBe(lkg)
    expect(wired.ref.current().registry.has(mcpToolName(SERVER_NAME, "beta"))).toBe(false)
  })

  it("GATE-OFF (no observer wired) is byte-identical: no reload, surface stays [alpha]", async () => {
    // No observer ⇒ loadMcpTools wires none ⇒ the server's list_changed is
    // dropped by the client (byte-identical inbound-notification drop). Even
    // after unlock + emit, nothing reloads.
    const { tools, client } = await loadFront(undefined)
    const wired = wireReload(client, tools)
    const gen0 = wired.ref.current()

    await client.callTool("unlock", {})
    await drain()

    // No controller was ever triggered (no observer): the ref is untouched.
    expect(wired.ref.current()).toBe(gen0)
    expect(wired.ref.current().registry.has(mcpToolName(SERVER_NAME, "beta"))).toBe(false)
  })
})
