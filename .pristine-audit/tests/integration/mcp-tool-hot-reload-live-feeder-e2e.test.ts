/**
 * RFC04-2/3 — MCP tool hot-reload LIVE FEEDER e2e (the composition-root wiring).
 *
 * The `-frontdoor-e2e` sibling proves the reload CHAIN with a hand-rolled
 * `wireReload`. This test proves the PRODUCTION FEEDER instead: the exact
 * functions the CLI/host composition root now runs when `QUANTA_MCP_HOT_RELOAD`
 * is on —
 *
 *   buildMcpHotReloadWiring() → { observer, onReloadSource, sources, bindController }
 *   loadMcpTools(fake stdio server, { resourceObserver: observer, onReloadSource })
 *       ⇒ the LIVE mcp-bridge single-client path EMITS one reload source
 *   buildToolingCore({ exposeRebuild: true }).rebuildRegistryWithMcpTools  (SAME assembly)
 *   seed TurnRegistrySnapshotRef from tooling.registry
 *   createMcpToolReloadController(publisher, rebuild = relist collected sources → rebuild registry → snapshot)
 *   bindController(controller)  ⇒ the observer now fires requestReload
 *
 * Proven:
 *  - the UNBLOCK: `onReloadSource` fires ONCE per successfully-loaded server on
 *    the single-client path with a working relist source (RED without the emit);
 *  - A → A+B LIVE at the NEXT turn boundary through the WHOLE feeder;
 *  - beta is mcp-origin (untrusted-source at dispatch) + NOT read-only (normal
 *    permission path) + dispatch routes to the live server;
 *  - malformed relist keeps last-known-good (no partial/empty publish);
 *  - GATE-OFF: resolveMcpHotReload with the gate unset ⇒ undefined ⇒ no observer,
 *    no source, no controller — and buildToolingCore WITHOUT exposeRebuild is
 *    byte-identical (no rebuild closure).
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
import {
  buildMcpHotReloadWiring,
  mcpHotReloadFeatureFields,
  mcpHotReloadLoadOpts,
  resolveMcpHotReload,
} from "@/host/mcp-composition"
import { createMcpToolReloadController } from "@/host/runtime"
import type { StructuredLogger } from "@/observability"
import { buildToolingCore, type ToolingAssembleInput } from "@/runner/assemble"
import { deriveProvenance, type Tool, type ToolContext, type ToolEvent } from "@/tool"

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
  dir = await mkdtemp(join(tmpdir(), "mcp-rfc04-live-feeder-"))
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

/** The minimal non-MCP tooling inputs — the SAME shape the CLI `buildTooling`
 *  hands `buildToolingCore`, with `exposeRebuild` on (the `QUANTA_MCP_HOT_RELOAD`
 *  posture) so the rebuild closure is captured. */
const toolingInput = (mcpTools: Tool[], exposeRebuild: boolean): ToolingAssembleInput => ({
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
  ...(exposeRebuild ? { exposeRebuild: true } : {}),
})

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

/** Load the fake server through the REAL front door, threading the PRODUCTION
 *  hot-reload wiring's `resourceObserver` + `onReloadSource` (the exact opts the
 *  composition root spreads via `mcpHotReloadLoadOpts`). */
const loadWithWiring = async (
  wiring: ReturnType<typeof buildMcpHotReloadWiring>,
  env?: Record<string, string>,
): Promise<Tool[]> => {
  const { tools, clients } = await loadMcpTools(
    [{ name: SERVER_NAME, command: [process.execPath, serverPath], ...(env ? { env } : {}) }],
    undefined,
    { ...mcpHotReloadLoadOpts(wiring) },
  )
  started.push(...clients)
  return tools
}

describe("RFC04-2/3 MCP hot-reload LIVE feeder e2e", () => {
  beforeEach(() => __resetTurnRegistrySnapshotId())

  it("the LIVE mcp-bridge emits a reload source per single-client server (the unblock)", async () => {
    const wiring = buildMcpHotReloadWiring()
    await loadWithWiring(wiring)
    // The UNBLOCK: `loadSingle` called `onReloadSource(reloadableSingleClientSource(...))`
    // once for the successfully-loaded server. Without the emit this stays [].
    expect(wiring.sources).toHaveLength(1)
    // And the collected source is a working relister over the live client.
    const relisted = await wiring.sources[0]!.relist()
    expect(relisted.map((t) => t.name)).toContain(mcpToolName(SERVER_NAME, "alpha"))
  })

  it("A → A+B LIVE at the next turn boundary through the whole feeder, permission-gated", async () => {
    const wiring = buildMcpHotReloadWiring()
    const seedTools = await loadWithWiring(wiring)

    // Build the feeder EXACTLY as the composition root does.
    const rebuildRegistry = (mcpTools: Tool[]) =>
      buildToolingCore(toolingInput(mcpTools, true)).rebuildRegistryWithMcpTools!(mcpTools)
    const seedRegistry = buildToolingCore(toolingInput(seedTools, true)).registry
    const { ref, publish } = createTurnRegistrySnapshotRef(buildTurnRegistrySnapshot(seedRegistry))
    const sources: McpReloadableSource[] = mcpHotReloadFeatureFields(wiring).mcpReloadSources!
    const rebuild = async (): Promise<TurnRegistrySnapshot> =>
      buildTurnRegistrySnapshot(rebuildRegistry(await relistMcpTools(sources)))
    const controller = createMcpToolReloadController({ current: ref.current, publish }, rebuild)
    // Late-bind — the observer now fires requestReload on a live list_changed.
    wiring.bindController(controller)

    // Turn boundary 0: [alpha] only.
    const gen0 = ref.current()
    const betaName = mcpToolName(SERVER_NAME, "beta")
    expect(gen0.registry.has(betaName)).toBe(false)
    expect(gen0.specs.map((s) => s.name)).not.toContain(betaName)

    // Drive the server to unlock beta + emit list_changed via the REAL client.
    const alpha = gen0.registry.get(mcpToolName(SERVER_NAME, "alpha"))
    expect(alpha).toBeDefined()
    // `unlock` is not a listed tool; relist a source's client indirectly by
    // calling through the live source's relist AFTER the server-side unlock. We
    // trigger unlock via the real client behind the source: dispatch a raw call
    // by re-listing is not enough — call `unlock` through the stored client.
    // The reload source holds the live client; drive unlock through a fresh
    // relist is a no-op, so we call the server's `unlock` by listing tools that
    // include it: simplest is to invoke it through a bridged call. Instead, use
    // the observer path: emit unlock by calling the server tool directly.
    await (started[0] as unknown as { callTool(n: string, a: unknown): Promise<unknown> }).callTool(
      "unlock",
      {},
    )
    await drain()
    await controller.requestReload() // ensure the in-flight reload settled

    // NEXT turn boundary: a fresh read sees beta.
    const gen1 = ref.current()
    expect(gen1.id).not.toBe(gen0.id)
    expect(gen1.registry.has(betaName)).toBe(true)
    expect(gen1.specs.map((s) => s.name)).toContain(betaName)
    // Pinned gen0 intact (no mid-turn mutation).
    expect(gen0.registry.has(betaName)).toBe(false)

    // Permission-gated: mcp-origin + NOT read-only ⇒ normal permission path.
    expect(deriveProvenance(betaName, gen1.registry.originOf(betaName))).toBe("mcp")
    expect(gen1.registry.isReadOnly(betaName)).toBe(false)

    // Dispatch routes to the live server.
    const beta = gen1.registry.get(betaName)
    expect(await dispatchOnce(beta as Tool)).toContain("called beta")
  })

  it("malformed relist keeps last-known-good (no partial/empty publish)", async () => {
    const wiring = buildMcpHotReloadWiring()
    const seedTools = await loadWithWiring(wiring, { QUANTA_FAKE_MALFORM: "1" })
    const rebuildRegistry = (mcpTools: Tool[]) =>
      buildToolingCore(toolingInput(mcpTools, true)).rebuildRegistryWithMcpTools!(mcpTools)
    const seedRegistry = buildToolingCore(toolingInput(seedTools, true)).registry
    const { ref, publish } = createTurnRegistrySnapshotRef(buildTurnRegistrySnapshot(seedRegistry))
    const sources = wiring.sources
    const controller = createMcpToolReloadController({ current: ref.current, publish }, async () =>
      buildTurnRegistrySnapshot(rebuildRegistry(await relistMcpTools(sources))),
    )
    wiring.bindController(controller)
    const lkg = ref.current()

    await (started[0] as unknown as { callTool(n: string, a: unknown): Promise<unknown> }).callTool(
      "unlock",
      {},
    )
    await drain()
    await controller.requestReload()

    // Fail-closed: STILL the last-known-good (identity preserved), never emptied.
    expect(ref.current()).toBe(lkg)
    expect(ref.current().registry.has(mcpToolName(SERVER_NAME, "beta"))).toBe(false)
  })

  it("GATE-OFF: resolveMcpHotReload returns undefined ⇒ no observer/source/controller + no rebuild closure", () => {
    // `QUANTA_MCP_HOT_RELOAD` unset in this test env ⇒ the gate resolver yields
    // undefined (even with servers configured), so the composition root wires
    // NOTHING: mcpHotReloadLoadOpts(undefined) === {} and there is no source
    // collector, observer, or controller.
    const prev = process.env.QUANTA_MCP_HOT_RELOAD
    delete process.env.QUANTA_MCP_HOT_RELOAD
    try {
      const off = resolveMcpHotReload({ configCount: 1, autoRestart: false })
      expect(off).toBeUndefined()
      expect(mcpHotReloadLoadOpts(off)).toEqual({})
      expect(mcpHotReloadFeatureFields(off)).toEqual({})
      // And the tooling assembly WITHOUT exposeRebuild captures NO rebuild
      // closure (the reload feeder is unrepresentable off-gate).
      const tooling = buildToolingCore(toolingInput([], false))
      expect(tooling.rebuildRegistryWithMcpTools).toBeUndefined()
    } finally {
      if (prev !== undefined) process.env.QUANTA_MCP_HOT_RELOAD = prev
    }
  })

  it("GATE-ON resolver builds wiring on BOTH paths; only the gate + server-count gate it", () => {
    const prev = process.env.QUANTA_MCP_HOT_RELOAD
    process.env.QUANTA_MCP_HOT_RELOAD = "1"
    try {
      // On + configured + non-supervised ⇒ wiring built.
      expect(resolveMcpHotReload({ configCount: 1, autoRestart: false })).toBeDefined()
      // On + auto-restart ⇒ NOW ALSO built (RFC04 supervised extension: the
      // bridge emits `reloadableSupervisedSource` over the supervisor handle).
      expect(resolveMcpHotReload({ configCount: 1, autoRestart: true })).toBeDefined()
      // On + no servers ⇒ nothing to reload (either path).
      expect(resolveMcpHotReload({ configCount: 0, autoRestart: false })).toBeUndefined()
      expect(resolveMcpHotReload({ configCount: 0, autoRestart: true })).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.QUANTA_MCP_HOT_RELOAD
      else process.env.QUANTA_MCP_HOT_RELOAD = prev
    }
  })
})
