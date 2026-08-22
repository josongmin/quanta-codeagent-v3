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
import {
  createSkillMcpSession,
  type SkillMcpDepsEnv,
  type SkillMcpSession,
} from "@/skill/skill-mcp-deps"

// --- leaf-port fakes (mirror skill-mcp-attach-adapter-hellgate) -------------

type LaunchMode = "ok" | "not-ready" | "throw"
type ConnectMode = "ok" | "reject"

const fakeLauncher = (
  mode: LaunchMode = "ok",
): {
  port: McpLauncherPort
  launches: number
  stops: Map<string, number>
} => {
  let launches = 0
  const stops = new Map<string, number>()
  const port: McpLauncherPort = {
    launch: async (_spec, opts) => {
      launches++
      if (mode === "throw") throw new Error("spawn refused")
      const serverId = `${opts.pluginId}::${opts.serverName}`
      const handle: McpServerHandle = {
        serverId,
        ready: mode === "ok",
        ...(mode === "not-ready" ? { error: "boom" } : {}),
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

const fakeHttpConnect = (
  mode: ConnectMode = "ok",
): {
  port: HttpMcpConnectPort
  connects: number
  stops: Map<string, number>
} => {
  let connects = 0
  const stops = new Map<string, number>()
  const port: HttpMcpConnectPort = {
    connect: async (_spec, id) => {
      connects++
      if (mode === "reject") throw new Error("connect refused")
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
const wire = (
  env: SkillMcpDepsEnv = GATE_ON,
  modes: { launch?: LaunchMode; connect?: ConnectMode } = {},
) => {
  const launcher = fakeLauncher(modes.launch ?? "ok")
  const http = fakeHttpConnect(modes.connect ?? "ok")
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
    // A config that carries NO skillMcpSession must be a graceful no-op: the
    // reconcile resolves (returns undefined) instead of throwing on the missing
    // session carrier.
    await expect(
      reconcileSkillMcpDepsForTurn({} as AgentConfig, skillWithBothDeps),
    ).resolves.toBeUndefined()
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
    const sentinel: SkillMcpSession = {
      reconcile: async () => ({ attached: [], detached: [] }),
      shutdownAll: async () => {},
      attachedIdentities: () => [],
    }
    const cfg = assembleAgentConfigWithEnv(
      {
        mode: "interactive",
        base: { ...baseReq("sess-mcp-pre"), skillMcpSession: sentinel },
      },
      { QUANTA_SKILL_MCP_DEPS: "1" },
    )
    expect(cfg.skillMcpSession).toBe(sentinel)
  })
})

// ---------------------------------------------------------------------------
// D. Adversarial / NO-THROW hardening — the turn must NEVER break.
// ---------------------------------------------------------------------------

describe("D. malformed / hostile inputs degrade gracefully (never throw, never break a turn)", () => {
  const cases: ReadonlyArray<{ label: string; raw: unknown }> = [
    { label: "non-object rawDependencies (string)", raw: "nope" },
    { label: "null rawDependencies", raw: null },
    { label: "array rawDependencies", raw: [1, 2, 3] },
    { label: "tools not an array", raw: { tools: "x" } },
    {
      label: "tool entries malformed (missing fields / wrong type)",
      raw: { tools: [{}, 7, null] },
    },
    { label: "non-mcp tool kind", raw: { tools: [{ type: "skill", value: "other" }] } },
  ]
  for (const c of cases) {
    test(`D-malformed — ${c.label} ⇒ no throw, nothing attached`, async () => {
      const { config, launcher, http } = wire()
      await reconcileSkillMcpDepsForTurn(config, [{ name: "s", rawDependencies: c.raw }])
      expect(launcher.launches).toBe(0)
      expect(http.connects).toBe(0)
    })
  }

  test("D1 — a malformed dep alongside a VALID one ⇒ the valid one still attaches", async () => {
    const { config, launcher } = wire()
    await reconcileSkillMcpDepsForTurn(config, [
      {
        name: "mixed",
        rawDependencies: {
          tools: [
            { type: "mcp", value: "bad", transport: "stdio" }, // missing command ⇒ malformed
            stdioTool, // valid
          ],
        },
      },
    ])
    expect(launcher.launches).toBe(1)
  })

  test("D2 — a hostile active-skill entry (throwing `name` getter) is dropped, valid kept", async () => {
    const { config, launcher } = wire()
    const hostile = {
      get name(): string {
        throw new Error("gotcha")
      },
      rawDependencies: { tools: [httpTool] },
    }
    const valid = { name: "ok", rawDependencies: { tools: [stdioTool] } }
    // Must NOT throw despite the hostile getter; the valid skill still attaches.
    await reconcileSkillMcpDepsForTurn(config, [hostile, valid] as never)
    expect(launcher.launches).toBe(1)
  })

  test("D3 — a non-string `name` entry is skipped (not coerced into a bogus skillId)", async () => {
    const { config, launcher } = wire()
    await reconcileSkillMcpDepsForTurn(config, [
      { name: 42 as unknown as string, rawDependencies: { tools: [stdioTool] } },
    ])
    // skillId must be a string; a numeric name is dropped ⇒ nothing attaches.
    expect(launcher.launches).toBe(0)
  })

  test("D4 — session.reconcile that THROWS is swallowed (turn proceeds)", async () => {
    let reconcileCalled = false
    const throwingSession = {
      reconcile: async () => {
        reconcileCalled = true
        throw new Error("coordinator exploded")
      },
      shutdownAll: async () => {},
      attachedIdentities: () => [],
    }
    const config = { skillMcpSession: throwingSession } as unknown as AgentConfig
    // The hook wraps the coordinator — the throwing reconcile IS reached (proving
    // we exercised the swallow path, not an early return) yet the call resolves
    // instead of rejecting the turn.
    await expect(reconcileSkillMcpDepsForTurn(config, skillWithBothDeps)).resolves.toBeUndefined()
    expect(reconcileCalled).toBe(true)
  })

  test("D5 — failed launch (ready:false) ⇒ untracked, no crash, retried NEXT turn", async () => {
    const { config, launcher } = wire(GATE_ON, { launch: "not-ready" })
    await reconcileSkillMcpDepsForTurn(config, [
      { name: "s", rawDependencies: { tools: [stdioTool] } },
    ])
    // first attempt launched (and got ready:false ⇒ left untracked)
    expect(launcher.launches).toBe(1)
    // because it stayed UNTRACKED, the next reconcile RE-tries (not deduped away)
    await reconcileSkillMcpDepsForTurn(config, [
      { name: "s", rawDependencies: { tools: [stdioTool] } },
    ])
    expect(launcher.launches).toBe(2)
  })

  test("D6 — a launcher that THROWS ⇒ swallowed, nothing tracked, no turn break", async () => {
    const { config, launcher } = wire(GATE_ON, { launch: "throw" })
    await reconcileSkillMcpDepsForTurn(config, [
      { name: "s", rawDependencies: { tools: [stdioTool] } },
    ])
    expect(launcher.launches).toBe(1) // attempted
    // retried next turn (never tracked)
    await reconcileSkillMcpDepsForTurn(config, [
      { name: "s", rawDependencies: { tools: [stdioTool] } },
    ])
    expect(launcher.launches).toBe(2)
  })

  test("D7 — a rejecting HTTP connect ⇒ untracked + retried, valid stdio still attaches", async () => {
    const { config, launcher, http } = wire(GATE_ON, { connect: "reject" })
    await reconcileSkillMcpDepsForTurn(config, skillWithBothDeps)
    expect(launcher.launches).toBe(1) // stdio attached
    expect(http.connects).toBe(1) // http attempted (rejected ⇒ untracked)
    await reconcileSkillMcpDepsForTurn(config, skillWithBothDeps)
    expect(launcher.launches).toBe(1) // stdio stays attached (deduped)
    expect(http.connects).toBe(2) // http retried
  })

  test("D8 — partial-overlap turn transition: A+B then A+C ⇒ keep A, detach B, attach C", async () => {
    const { config, launcher } = wire()
    const A = { type: "mcp", value: "svc-a", transport: "stdio", command: "a" }
    const B = { type: "mcp", value: "svc-b", transport: "stdio", command: "b" }
    const C = { type: "mcp", value: "svc-c", transport: "stdio", command: "c" }
    await reconcileSkillMcpDepsForTurn(config, [{ name: "s", rawDependencies: { tools: [A, B] } }])
    expect(launcher.launches).toBe(2) // A, B
    await reconcileSkillMcpDepsForTurn(config, [{ name: "s", rawDependencies: { tools: [A, C] } }])
    expect(launcher.launches).toBe(3) // +C only (A deduped)
    // B detached exactly once; A NOT detached (still desired)
    expect(launcher.stops.get("skill-mcp-deps::svc-b")).toBe(1)
    expect(launcher.stops.get("skill-mcp-deps::svc-a")).toBeUndefined()
  })

  test("D9 — shutdownAll is idempotent (double call ⇒ no double-stop, no throw)", async () => {
    const { config, session, launcher } = wire()
    await reconcileSkillMcpDepsForTurn(config, [
      { name: "s", rawDependencies: { tools: [stdioTool] } },
    ])
    await session.shutdownAll()
    await session.shutdownAll() // second call must be a clean no-op
    expect([...launcher.stops.values()].reduce((a, b) => a + b, 0)).toBe(1)
  })

  test("D10 — reconcile AFTER shutdownAll re-attaches (session is reusable, not poisoned)", async () => {
    const { config, session, launcher } = wire()
    await reconcileSkillMcpDepsForTurn(config, [
      { name: "s", rawDependencies: { tools: [stdioTool] } },
    ])
    await session.shutdownAll()
    await reconcileSkillMcpDepsForTurn(config, [
      { name: "s", rawDependencies: { tools: [stdioTool] } },
    ])
    expect(launcher.launches).toBe(2) // re-attached after teardown
  })
})
