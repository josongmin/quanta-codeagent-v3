/**
 * Hellgate — web-daemon readout SOURCES (UUX-1-11: kill the readout stubs).
 *
 * `GET /readout/:name` served 9 recognized names as "not wired" stubs. This
 * gate pins the REAL source-backed resolver `resolveReadout(name, snapshot,
 * sources)`:
 *
 *   RS-01..06  each source-backed readout (agents / plan / skills / memory /
 *              cost / context) renders LIVE data from its injected accessor —
 *              wired:true + concrete field content (drop a field ⇒ RED).
 *   RS-07      an ABSENT accessor degrades to wired:false with copy that NAMES
 *              the missing piece (not a bare "not wired").
 *   RS-08      the three SKIPPED readouts (mcp / why / branches) name exactly
 *              WHAT is missing on this surface.
 *   RS-09 ADV  a THROWING / REJECTING accessor degrades to a graceful payload
 *              (wired:false, isError:false, never a thrown error ⇒ the route
 *              can never 500 on a readout).
 *   RS-10      unknown names stay isError (typo ≠ pending) through the resolver.
 *   RS-11      snapshot-served names (state / capabilities) resolve identically
 *              through the resolver (single route entry point).
 */
import { describe, expect, test } from "bun:test"
import type { Plan } from "@/agent/plan/types"
import {
  type AgentFleetReadoutRow,
  type CostReadoutTotals,
  type MemoryReadoutEntry,
  resolveReadout,
  type WebReadoutSources,
} from "@/apps/web-daemon/readout"
import type { CapabilityManifest, SessionSnapshotLite } from "@/protocol/session"

const CAPS: CapabilityManifest = {
  approvals: "operator",
  tools: true,
  memory: false,
  artifacts: true,
  subagents: true,
  automation: false,
  shellSnapshot: true,
  transport: "websocket",
}

const snap = (): SessionSnapshotLite => ({
  sessionId: "s1",
  revision: 3,
  seq: 9,
  state: {
    status: "running",
    draftInput: "",
    permissionMode: "default",
    modelSlug: "gpt-5",
    messageCount: 7,
  },
  capabilities: CAPS,
  pendingApproval: null,
  openArtifacts: [],
})

const NOW = 1_760_000_000_000

describe("resolveReadout — source-backed readouts serve live data", () => {
  test("RS-01: /agents renders the fleet rows (id + status + description, running first)", async () => {
    const rows: AgentFleetReadoutRow[] = [
      {
        id: "task_b",
        description: "settled research task",
        agentType: "researcher",
        status: "completed",
        startedAt: NOW - 60_000,
        endedAt: NOW - 30_000,
      },
      {
        id: "task_a",
        description: "live refactor task",
        status: "running",
        startedAt: NOW - 10_000,
      },
    ]
    const r = await resolveReadout("agents", snap(), { agents: () => rows, now: () => NOW })
    expect(r.wired).toBe(true)
    expect(r.isError).toBe(false)
    expect(r.output).toContain("task_a")
    expect(r.output).toContain("running")
    expect(r.output).toContain("live refactor task")
    expect(r.output).toContain("task_b")
    expect(r.output).toContain("completed")
    expect(r.output).toContain("researcher")
    // running-first ordering (the live task paints above the settled one)
    expect(r.output.indexOf("task_a")).toBeLessThan(r.output.indexOf("task_b"))
  })

  test("RS-01b: /agents with an empty registry is wired (honest 'no tasks yet', not a stub)", async () => {
    const r = await resolveReadout("agents", snap(), { agents: () => [] })
    expect(r.wired).toBe(true)
    expect(r.isError).toBe(false)
    expect(r.output).toContain("no subagent tasks")
  })

  test("RS-02: /plan renders the live plan body (name + todo statuses)", async () => {
    const plan: Plan = {
      version: 4,
      name: "ship the readouts",
      overview: "wire all nine",
      isProject: false,
      todos: {
        t1: {
          id: "t1",
          content: "wire the plan store",
          status: "completed",
          createdAt: NOW,
          updatedAt: NOW,
          dependencies: [],
        },
        t2: {
          id: "t2",
          content: "render the panel",
          status: "in_progress",
          createdAt: NOW,
          updatedAt: NOW,
          dependencies: [],
        },
      },
      phases: [],
      createdAt: NOW,
      updatedAt: NOW,
    }
    const r = await resolveReadout("plan", snap(), { plan: () => plan })
    expect(r.wired).toBe(true)
    expect(r.output).toContain("ship the readouts")
    expect(r.output).toContain("wire the plan store")
    expect(r.output).toContain("render the panel")
    expect(r.output).toContain("in_progress")
  })

  test("RS-02b: /plan with no plan yet is wired (honest empty state)", async () => {
    const r = await resolveReadout("plan", snap(), { plan: () => null })
    expect(r.wired).toBe(true)
    expect(r.isError).toBe(false)
    expect(r.output).toContain("no plan")
  })

  test("RS-03: /skills renders the discovered inventory", async () => {
    const r = await resolveReadout("skills", snap(), {
      skills: async () => [
        { name: "deep-research", description: "fan-out web searches" },
        { name: "verify", description: "run the app and observe" },
      ],
    })
    expect(r.wired).toBe(true)
    expect(r.output).toContain("deep-research")
    expect(r.output).toContain("fan-out web searches")
    expect(r.output).toContain("verify")
    expect(r.output).toContain("2 skill")
  })

  test("RS-04: /memory renders recent entries + tier counts from the durable store", async () => {
    const entries: MemoryReadoutEntry[] = [
      {
        id: "m1",
        tier: "episodic",
        text: "user prefers tabs over spaces",
        importance: 0.8,
        createdAt: NOW - 1000,
      },
      { id: "m2", tier: "semantic", text: "repo uses bun test", createdAt: NOW - 2000 },
    ]
    const r = await resolveReadout("memory", snap(), { memory: async () => entries })
    expect(r.wired).toBe(true)
    expect(r.output).toContain("m1")
    expect(r.output).toContain("user prefers tabs over spaces")
    expect(r.output).toContain("episodic")
    expect(r.output).toContain("semantic")
    expect(r.output).toContain("2")
  })

  test("RS-05: /cost renders the cumulative session totals", async () => {
    const totals: CostReadoutTotals = {
      turns: 3,
      promptTokens: 1200,
      completionTokens: 400,
      totalTokens: 1600,
      costMicroUsd: 12_500,
      modelSlug: "gpt-5",
    }
    const r = await resolveReadout("cost", snap(), { cost: () => totals })
    expect(r.wired).toBe(true)
    expect(r.output).toContain("3") // turns
    expect(r.output).toContain("1200")
    expect(r.output).toContain("400")
    expect(r.output).toContain("1600")
    expect(r.output).toContain("0.0125") // 12_500 µUSD = $0.0125
    expect(r.output).toContain("gpt-5")
  })

  test("RS-06: /context renders the segmented usage breakdown", async () => {
    const r = await resolveReadout("context", snap(), {
      context: () => ({
        segments: [
          { id: "System", tokens: 900, chars: 3600, color: "cyan" },
          { id: "Conversation", tokens: 2100, chars: 8400, color: "green" },
        ],
        total: 3000,
        max: 200_000,
        model: "gpt-5",
      }),
    })
    expect(r.wired).toBe(true)
    expect(r.output).toContain("System")
    expect(r.output).toContain("900")
    expect(r.output).toContain("Conversation")
    expect(r.output).toContain("2100")
    expect(r.output).toContain("3000")
    expect(r.output).toContain("200000")
  })

  test("RS-06b: /context before the first prompt assembly is wired (honest empty state)", async () => {
    const r = await resolveReadout("context", snap(), { context: () => undefined })
    expect(r.wired).toBe(true)
    expect(r.isError).toBe(false)
    expect(r.output).toContain("no prompt assembled yet")
  })
})

describe("resolveReadout — degrade copy NAMES what is missing", () => {
  test("RS-07: absent accessor ⇒ wired:false + copy naming the missing piece", async () => {
    const cases: readonly [string, string][] = [
      ["agents", "task registry"],
      ["plan", "plan store"],
      ["skills", "skills discovery"],
      ["memory", "memory store"],
      ["cost", "usage aggregator"],
      ["context", "context-usage"],
    ]
    for (const [name, needle] of cases) {
      const r = await resolveReadout(name, snap(), {})
      expect(r.wired, `${name} not wired`).toBe(false)
      expect(r.isError, `${name} graceful`).toBe(false)
      expect(r.output.toLowerCase(), `${name} names its missing source`).toContain(needle)
    }
  })

  test("RS-08: the SKIPPED readouts name exactly what this surface lacks", async () => {
    const mcp = await resolveReadout("mcp", snap(), {})
    expect(mcp.wired).toBe(false)
    expect(mcp.isError).toBe(false)
    expect(mcp.output).toContain("MCP")
    expect(mcp.output.toLowerCase()).toContain("no mcp")

    const why = await resolveReadout("why", snap(), {})
    expect(why.wired).toBe(false)
    expect(why.output).toContain("LLM")
    expect(why.output.toLowerCase()).toContain("read-only")

    const branches = await resolveReadout("branches", snap(), {})
    expect(branches.wired).toBe(false)
    expect(branches.output).toContain("branch_search")
  })
})

describe("resolveReadout — adversarial totality", () => {
  test("RS-09a: a synchronously THROWING accessor degrades to a graceful payload", async () => {
    const r = await resolveReadout("agents", snap(), {
      agents: () => {
        throw new Error("registry exploded")
      },
    })
    expect(r.wired).toBe(false)
    expect(r.isError).toBe(false) // graceful — the route must answer 200, not 500
    expect(r.output).toContain("registry exploded")
  })

  test("RS-09b: a REJECTING async accessor degrades the same way", async () => {
    const r = await resolveReadout("skills", snap(), {
      skills: async () => {
        throw new Error("disk scan failed")
      },
    })
    expect(r.wired).toBe(false)
    expect(r.isError).toBe(false)
    expect(r.output).toContain("disk scan failed")
  })

  test("RS-09c: resolveReadout NEVER rejects (total across every recognized name)", async () => {
    const boom = (): never => {
      throw new Error("boom")
    }
    const hostileSources: WebReadoutSources = {
      agents: boom,
      plan: boom,
      skills: async () => boom(),
      memory: async () => boom(),
      cost: boom,
      context: boom,
    }
    for (const name of [
      "agents",
      "plan",
      "skills",
      "mcp",
      "memory",
      "why",
      "cost",
      "context",
      "branches",
      "state",
      "capabilities",
      "",
      "??",
    ]) {
      const r = await resolveReadout(name, snap(), hostileSources)
      expect(r.output.length, `${name} non-empty`).toBeGreaterThan(0)
    }
  })

  test("RS-10: unknown name stays an error through the resolver", async () => {
    const r = await resolveReadout("doesnotexist", snap(), {})
    expect(r.isError).toBe(true)
    expect(r.wired).toBe(false)
  })

  test("RS-11: snapshot-served names resolve identically through the resolver", async () => {
    const state = await resolveReadout("state", snap(), {})
    expect(state.wired).toBe(true)
    expect(state.output).toContain("running")
    const caps = await resolveReadout("caps", snap(), {})
    expect(caps.name).toBe("capabilities")
    expect(caps.wired).toBe(true)
    expect(caps.output).toContain("websocket")
  })
})

// RS-12 (P4/P2, jul-11) — doctor readout: session-store health served LIVE from
// the injected accessor; absent ⇒ honest missing copy; a throw ⇒ graceful.
describe("doctor readout (session-store health)", () => {
  test("RS-12: a wired doctor accessor renders the verdict + counts", async () => {
    const sources: WebReadoutSources = {
      doctor: async () => ({
        root: "/tmp/x",
        verdict: "degraded",
        total: 3,
        ok: 2,
        corrupt: 1,
        unreadable: 0,
        files: [],
        guidance: "run `quanta doctor` to inspect",
      }),
    }
    const r = await resolveReadout("doctor", snap(), sources)
    expect(r.isError).toBe(false)
    expect(r.output).toContain("degraded")
    expect(r.output).toContain("run `quanta doctor`")
  })

  test("RS-12b: absent doctor accessor names what is missing", async () => {
    const r = await resolveReadout("doctor", snap(), {})
    expect(r.isError).toBe(false)
    expect(r.output).toContain("doctor")
    expect(r.output).not.toMatch(/^doctor: not wired$/)
  })

  test("RS-12c: a throwing doctor accessor degrades gracefully (never 500)", async () => {
    const r = await resolveReadout("doctor", snap(), {
      doctor: async () => {
        throw new Error("fs blew up")
      },
    })
    expect(r.isError).toBe(false)
  })
})

// RS-13 (P4, jul-11) — MCP readout goes LIVE now that the daemon composes MCP
// from @/host/mcp-composition (the fence violation is gone). Server list +
// health from the injected accessor; absent ⇒ honest missing copy.
describe("mcp readout (live server health)", () => {
  test("RS-13: a wired mcp accessor renders server rows + status", async () => {
    const sources: WebReadoutSources = {
      mcp: () => [
        { name: "fs", status: "up", toolCount: 4 },
        { name: "gh", status: "down", reason: "exited" },
      ],
    }
    const r = await resolveReadout("mcp", snap(), sources)
    expect(r.isError).toBe(false)
    expect(r.output).toContain("fs")
    expect(r.output).toContain("gh")
    expect(r.output).toContain("down")
  })

  test("RS-13b: absent mcp accessor names what is missing", async () => {
    const r = await resolveReadout("mcp", snap(), {})
    expect(r.isError).toBe(false)
    expect(r.output).toContain("mcp")
  })
})
