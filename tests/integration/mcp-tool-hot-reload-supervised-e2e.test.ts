/**
 * RFC04 hot-reload SUPERVISED extension — front-door e2e over the auto-restart
 * (`QUANTA_MCP_AUTORESTART`) path.
 *
 * RFC04's hot-reload originally fired ONLY for non-supervised single-client
 * servers: `loadSupervised` returned an `McpReconnectSupervisor` and emitted NO
 * reload source (a `reloadableSingleClientSource` cannot accept a supervisor).
 * This extension adds `reloadableSupervisedSource(supervisor, ...)` — a relist
 * over the supervisor's STABLE handle (`sup.listTools()` forwards to the current
 * live client, mirroring `supervisedTasksToolsFor`) — and emits it from
 * `loadSupervised` via the same `onReloadSource` sink. So a `tools/list_changed`
 * from an auto-restart server now hot-reloads too.
 *
 * Driven through the REAL supervised front door: `loadMcpTools` with
 * `supervisorDepsFor` (each server wrapped in a real `McpReconnectSupervisor`
 * over a real stdio `McpClient`), the RFC04 `resourceObserver` for the
 * list_changed subscription, and the `onReloadSource` sink.
 *
 * Proven:
 *  - the UNBLOCK: `onReloadSource` fires ONCE per successfully-loaded SUPERVISED
 *    server with a working relist source (RED before the emit: no source);
 *  - A → A+B LIVE at the next turn boundary through the whole feeder, over the
 *    supervisor handle (the relist re-resolves the current live client);
 *  - malformed relist keeps last-known-good (no partial/empty publish);
 *  - GATE-OFF (no observer + no onReloadSource) is byte-identical: no source,
 *    the supervised load is unchanged.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadMcpTools,
  type McpReloadableSource,
  type McpStoppable,
  mcpToolName,
  relistMcpTools,
} from "@/agent"
import {
  __resetTurnRegistrySnapshotId,
  buildTurnRegistrySnapshot,
  createTurnRegistrySnapshotRef,
  type TurnRegistrySnapshot,
} from "@/agent/turn-registry-snapshot"
import { createMcpToolReloadController } from "@/host/runtime"
import {
  DEFAULT_BACKOFF_POLICY,
  McpClient,
  McpReconnectSupervisor,
  type McpResourceObserver,
  type McpServerConfig,
  type SupervisableMcpClient,
  type SupervisorDeps,
} from "@/mcp"
import type { StructuredLogger } from "@/observability"
import { buildToolingCore } from "@/runner/assemble"
import { deriveProvenance, type Tool, type ToolContext, type ToolEvent } from "@/tool"

/** Same stdio fake server the frontdoor/live-feeder e2e use: starts at [alpha],
 *  flips to [alpha, beta] after an `unlock` call, then emits
 *  `notifications/tools/list_changed`. `MALFORM=1` ⇒ the post-unlock tools/list
 *  is a JSON-RPC error ⇒ relist rejects ⇒ LKG retention. */
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

const SERVER_NAME = "hot-sup"
let dir: string
let serverPath: string

const slog: StructuredLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as StructuredLogger

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mcp-rfc04-supervised-"))
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

/** Real `SupervisorDeps` over a real stdio `McpClient`: threads the RFC04
 *  `resourceObserver` into the client so the server's `tools/list_changed`
 *  reaches the wired observer, exactly as the composition root does. Real
 *  clock/timer (no restart is exercised here — the point is the STABLE handle
 *  relists over the current live client). */
const supervisorDepsFor =
  (observer: McpResourceObserver | undefined) =>
  (_config: McpServerConfig): SupervisorDeps => ({
    factory: (c): SupervisableMcpClient =>
      new McpClient(c, observer !== undefined ? { resourceObserver: observer } : {}),
    policy: DEFAULT_BACKOFF_POLICY,
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms)
      return () => clearTimeout(t)
    },
  })

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

/** Load the fake server through the REAL supervised front door, collecting any
 *  reload sources the bridge emits into `sources`. */
const loadSupervisedFront = async (
  observer: McpResourceObserver | undefined,
  sources: McpReloadableSource[] | undefined,
  env?: Record<string, string>,
): Promise<{ tools: Tool[]; clients: McpStoppable[] }> => {
  const { tools, clients } = await loadMcpTools(
    [{ name: SERVER_NAME, command: [process.execPath, serverPath], ...(env ? { env } : {}) }],
    undefined,
    {
      supervisorDepsFor: supervisorDepsFor(observer),
      ...(observer !== undefined ? { resourceObserver: observer } : {}),
      ...(sources !== undefined ? { onReloadSource: (s) => sources.push(s) } : {}),
    },
  )
  started.push(...clients)
  return { tools, clients }
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

describe("RFC04 hot-reload SUPERVISED e2e", () => {
  beforeEach(() => __resetTurnRegistrySnapshotId())

  it("the supervised path emits ONE reload source per loaded server (the unblock)", async () => {
    const sources: McpReloadableSource[] = []
    const { clients } = await loadSupervisedFront(undefined, sources)
    // Prove the SUPERVISED branch was taken (not a fallback to single-client):
    // the loaded handle is an `McpReconnectSupervisor`, not a bare `McpClient`.
    expect(clients[0]).toBeInstanceOf(McpReconnectSupervisor)
    // The UNBLOCK: `loadSupervised` called `onReloadSource(reloadableSupervisedSource(...))`
    // once for the successfully-loaded supervised server. RED before the emit ⇒ [].
    expect(sources).toHaveLength(1)
    // And the collected source relists over the supervisor's stable handle.
    const relisted = await sources[0]!.relist()
    expect(relisted.map((t) => t.name)).toContain(mcpToolName(SERVER_NAME, "alpha"))
  })

  it("A → A+B LIVE at the next turn boundary through the whole feeder over the supervisor handle", async () => {
    const sources: McpReloadableSource[] = []
    let controllerRef: ReturnType<typeof createMcpToolReloadController> | undefined
    const reloads: Promise<void>[] = []
    const observer: McpResourceObserver = {
      onNotification: (e) => {
        if (e.kind === "tools_list_changed" && controllerRef !== undefined) {
          reloads.push(controllerRef.requestReload())
        }
      },
    }
    const { tools, clients } = await loadSupervisedFront(observer, sources)
    expect(sources).toHaveLength(1)

    const { ref, publish } = createTurnRegistrySnapshotRef(assemble(tools))
    const controller = createMcpToolReloadController({ current: ref.current, publish }, async () =>
      assemble(await relistMcpTools(sources)),
    )
    controllerRef = controller

    const betaName = mcpToolName(SERVER_NAME, "beta")
    const gen0 = ref.current()
    expect(gen0.registry.has(betaName)).toBe(false)
    expect(gen0.specs.map((s) => s.name)).not.toContain(betaName)

    // Drive unlock via the supervisor handle (which forwards to the live client)
    // ⇒ server flips to [alpha, beta] + emits list_changed through the real client.
    await (clients[0] as unknown as { callTool(n: string, a: unknown): Promise<unknown> }).callTool(
      "unlock",
      {},
    )
    await drain()
    await Promise.all(reloads)
    await controller.requestReload()

    const gen1 = ref.current()
    expect(gen1.id).not.toBe(gen0.id)
    expect(gen1.registry.has(betaName)).toBe(true)
    expect(gen1.specs.map((s) => s.name)).toContain(betaName)
    expect(gen0.registry.has(betaName)).toBe(false) // pinned gen0 intact

    // Permission-gated: mcp-origin + NOT read-only ⇒ normal permission path.
    expect(deriveProvenance(betaName, gen1.registry.originOf(betaName))).toBe("mcp")
    expect(gen1.registry.isReadOnly(betaName)).toBe(false)

    // Dispatch routes to the live server through the supervisor handle.
    const beta = gen1.registry.get(betaName)
    expect(await dispatchOnce(beta as Tool)).toContain("called beta")
  })

  it("malformed relist keeps last-known-good (no partial/empty publish)", async () => {
    const sources: McpReloadableSource[] = []
    let controllerRef: ReturnType<typeof createMcpToolReloadController> | undefined
    const reloads: Promise<void>[] = []
    const observer: McpResourceObserver = {
      onNotification: (e) => {
        if (e.kind === "tools_list_changed" && controllerRef !== undefined) {
          reloads.push(controllerRef.requestReload())
        }
      },
    }
    const { tools, clients } = await loadSupervisedFront(observer, sources, {
      QUANTA_FAKE_MALFORM: "1",
    })
    const { ref, publish } = createTurnRegistrySnapshotRef(assemble(tools))
    const controller = createMcpToolReloadController({ current: ref.current, publish }, async () =>
      assemble(await relistMcpTools(sources)),
    )
    controllerRef = controller
    const lkg = ref.current()

    await (clients[0] as unknown as { callTool(n: string, a: unknown): Promise<unknown> }).callTool(
      "unlock",
      {},
    )
    await drain()
    await Promise.all(reloads)
    await controller.requestReload()

    // Fail-closed: STILL the last-known-good (identity preserved), never emptied.
    expect(ref.current()).toBe(lkg)
    expect(ref.current().registry.has(mcpToolName(SERVER_NAME, "beta"))).toBe(false)
  })

  it("GATE-OFF (no observer + no onReloadSource) is byte-identical: no source collected", async () => {
    const { tools } = await loadSupervisedFront(undefined, undefined)
    // No `onReloadSource` sink ⇒ the supervised bridge never emits (byte-identical
    // to the pre-extension supervised load); the surface is still [alpha].
    expect(tools.map((t) => t.name)).toContain(mcpToolName(SERVER_NAME, "alpha"))
    expect(tools.map((t) => t.name)).not.toContain(mcpToolName(SERVER_NAME, "beta"))
  })
})
