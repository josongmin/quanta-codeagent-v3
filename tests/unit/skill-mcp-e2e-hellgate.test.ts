/**
 * ★ E2E CONTRACT — ADR-0476 skill→MCP auto-attach, full composition lifecycle.
 *
 * This is the END-TO-END proof that the absorbed slice is WIRED: it assembles
 * the REAL coordinator (`createSkillMcpSession`) over the REAL dual-transport
 * attach adapter (`createSkillMcpAttachAdapter`), with only the LEAF carriers
 * faked (stdio launcher + HTTP connect) — exactly the seam the composition root
 * (`buildSkillMcpSession`) fills with `@/agent/plugin-mcp-launcher` + `@/mcp`.
 * It then drives the SAME per-turn entry point the loop calls
 * (`reconcileSkillMcpDepsForTurn`) over a config, turn by turn, and pins the
 * whole lifecycle:
 *
 *   turn 1 — a skill with a stdio + an HTTP dep ⇒ ONE launch + ONE connect.
 *   turn 2 — same active set ⇒ NO re-launch / re-connect (idempotent dedupe).
 *   turn 3 — the skill goes inactive ⇒ BOTH carriers torn down (detach).
 *   shutdownAll ⇒ every remaining carrier stopped (session end).
 *   gate OFF ⇒ reconcile resolves the empty set ⇒ nothing ever attaches.
 *   assembler ⇒ `QUANTA_SKILL_MCP_DEPS=1` mints `cfg.skillMcpSession`; unset ⇒ none.
 *
 * Determinism: leaf ports are fakes with call-count + per-id stop-count maps; no
 * real process spawn, no socket. The reconcile path is the production one.
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { reconcileSkillMcpDepsForTurn } from "@/agent/loop-activation-hook"
import type { McpLauncherPort, McpServerHandle } from "@/agent/plugin-mcp-launcher"
import {
  createSkillMcpAttachAdapter,
  type HttpMcpConnectPort,
} from "@/agent/skill-mcp-attach-adapter"
import {
  type AssembleRequest,
  assembleAgentConfig as assembleAgentConfigWithEnv,
} from "@/host/runtime/agent-config-assembler"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { createSkillMcpSession, type SkillMcpDepsEnv } from "@/skill/skill-mcp-deps"

// --- leaf-port fakes (mirror skill-mcp-attach-adapter-hellgate) -------------

const fakeLauncher = (): {
  port: McpLauncherPort
  launches: number
  stops: Map<string, number>
} => {
  let launches = 0
  const stops = new Map<string, number>()
  const port: McpLauncherPort = {
    launch: async (_spec, opts) => {
      launches++
      const serverId = `${opts.pluginId}::${opts.serverName}`
      const handle: McpServerHandle = {
        serverId,
        ready: true,
        shutdown: async () => {
          stops.set(serverId, (stops.get(serverId) ?? 0) + 1)
        },
      }
      return handle
    },
  }
  return {
    port,
    get launches() {
      return launches
    },
    stops,
  }
}

const fakeHttpConnect = (): {
  port: HttpMcpConnectPort
  connects: number
  stops: Map<string, number>
} => {
  let connects = 0
  const stops = new Map<string, number>()
  const port: HttpMcpConnectPort = {
    connect: async (_spec, id) => {
      connects++
      return {
        id,
        stop: async () => {
          stops.set(id, (stops.get(id) ?? 0) + 1)
        },
      }
    },
  }
  return {
    port,
    get connects() {
      return connects
    },
    stops,
  }
}

const GATE_ON: SkillMcpDepsEnv = { QUANTA_SKILL_MCP_DEPS: "1" }

const stdioTool = { type: "mcp", value: "my-server", transport: "stdio", command: "bin" }
const httpTool = {
  type: "mcp",
  value: "remote",
  transport: "streamable_http",
  url: "https://mcp.example.com/v1",
}

/** Build a config carrying a REAL session over faked leaf carriers. */
const wire = (env: SkillMcpDepsEnv = GATE_ON) => {
  const launcher = fakeLauncher()
  const http = fakeHttpConnect()
  const adapter = createSkillMcpAttachAdapter({ launcher: launcher.port, httpConnect: http.port })
  const session = createSkillMcpSession(adapter.ports, env)
  const config = { skillMcpSession: session } as unknown as AgentConfig
  return { config, session, launcher, http, adapter }
}

const skillWithBothDeps = [{ name: "deploy", rawDependencies: { tools: [stdioTool, httpTool] } }]

// ---------------------------------------------------------------------------
// A. Full attach → dedupe → detach → shutdown lifecycle.
// ---------------------------------------------------------------------------

describe("A. skill→MCP lifecycle across loop turns (production reconcile path)", () => {
  test("A1 — turn 1: a skill with stdio + http deps ⇒ exactly one launch + one connect", async () => {
    const { config, launcher, http } = wire()
    await reconcileSkillMcpDepsForTurn(config, skillWithBothDeps)
    expect(launcher.launches).toBe(1)
    expect(http.connects).toBe(1)
  })

  test("A2 — turn 2: SAME active set ⇒ idempotent (no re-launch / re-connect)", async () => {
    const { config, launcher, http } = wire()
    await reconcileSkillMcpDepsForTurn(config, skillWithBothDeps)
    await reconcileSkillMcpDepsForTurn(config, skillWithBothDeps)
    expect(launcher.launches).toBe(1)
    expect(http.connects).toBe(1)
  })

  test("A3 — turn 3: skill goes inactive ⇒ BOTH carriers torn down (detach)", async () => {
    const { config, launcher, http } = wire()
    await reconcileSkillMcpDepsForTurn(config, skillWithBothDeps)
    await reconcileSkillMcpDepsForTurn(config, []) // skill no longer active
    expect([...launcher.stops.values()].reduce((a, b) => a + b, 0)).toBe(1)
    expect([...http.stops.values()].reduce((a, b) => a + b, 0)).toBe(1)
  })

  test("A4 — shutdownAll at session end stops every still-attached carrier", async () => {
    const { config, session, launcher, http } = wire()
    await reconcileSkillMcpDepsForTurn(config, skillWithBothDeps)
    await session.shutdownAll()
    expect([...launcher.stops.values()].reduce((a, b) => a + b, 0)).toBe(1)
    expect([...http.stops.values()].reduce((a, b) => a + b, 0)).toBe(1)
    // attachedIdentities is now empty (everything detached)
    expect(session.attachedIdentities().length).toBe(0)
  })

  test("A5 — two skills declaring the SAME server ⇒ attached ONCE (cross-skill dedupe)", async () => {
    const { config, launcher } = wire()
    await reconcileSkillMcpDepsForTurn(config, [
      { name: "a", rawDependencies: { tools: [stdioTool] } },
      { name: "b", rawDependencies: { tools: [stdioTool] } },
    ])
    expect(launcher.launches).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// B. Gate OFF — resolver short-circuits ⇒ nothing attaches.
// ---------------------------------------------------------------------------

describe("B. gate OFF ⇒ byte-identical (no attach even with declared deps)", () => {
  test("B1 — session env without the gate ⇒ reconcile attaches nothing", async () => {
    const { config, launcher, http } = wire({}) // gate absent
    await reconcileSkillMcpDepsForTurn(config, skillWithBothDeps)
    expect(launcher.launches).toBe(0)
    expect(http.connects).toBe(0)
  })

  test("B2 — no skillMcpSession on the config ⇒ pure no-op", async () => {
    // Should not throw; nothing to assert but the absence of error + carriers.
    await reconcileSkillMcpDepsForTurn({} as AgentConfig, skillWithBothDeps)
    expect(true).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// C. Assembler composition — maybeWireSkillMcp gates session creation.
// ---------------------------------------------------------------------------

const inertLLM: LLMPort & { readonly model: string } = {
  model: "gpt-5",
  // biome-ignore lint/correctness/useYield: never invoked
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    throw new Error("unexpected stream()")
  },
}

const baseReq = (sessionId: string): AssembleRequest["base"] => ({
  llm: inertLLM,
  registry: {
    register: () => undefined,
    get: () => undefined,
    list: () => [],
  } as unknown as AgentConfig["registry"],
  stream: { emit: () => undefined },
  permission: { mode: "default" },
  messages: [],
  system: "test",
  cwd: "/repo",
  maxTurns: 1,
  signal: new AbortController().signal,
  sessionId,
})

describe("C. assembler maybeWireSkillMcp", () => {
  test("C1 — QUANTA_SKILL_MCP_DEPS=1 ⇒ cfg.skillMcpSession is minted", () => {
    const cfg = assembleAgentConfigWithEnv(
      { mode: "interactive", base: baseReq("sess-mcp-on") },
      { QUANTA_SKILL_MCP_DEPS: "1" },
    )
    expect(cfg.skillMcpSession).toBeDefined()
    expect(typeof cfg.skillMcpSession?.reconcile).toBe("function")
  })

  test("C2 — gate unset ⇒ no session (byte-identical default-OFF)", () => {
    const cfg = assembleAgentConfigWithEnv(
      { mode: "interactive", base: baseReq("sess-mcp-off") },
      {},
    )
    expect(cfg.skillMcpSession).toBeUndefined()
  })

  test("C3 — caller-supplied session is preserved (caller-override-precedence)", () => {
    const sentinel = { reconcile: async () => ({ attached: [], detached: [] }) }
    const cfg = assembleAgentConfigWithEnv(
      {
        mode: "interactive",
        base: { ...baseReq("sess-mcp-pre"), skillMcpSession: sentinel } as AssembleRequest["base"],
      },
      { QUANTA_SKILL_MCP_DEPS: "1" },
    )
    expect(cfg.skillMcpSession).toBe(sentinel as never)
  })
})
