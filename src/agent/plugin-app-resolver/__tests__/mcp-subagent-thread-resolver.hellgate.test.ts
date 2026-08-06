/**
 * RFC-12-2 — mcp / subagent / thread sub-resolver hellgate + composite wiring.
 *
 *   A. mcp resolver (hit / unknown / empty / cap / NO-THROW)
 *   B. subagent resolver (hit / miss / no-registry / NO-THROW / no-lineage-leak)
 *   C. thread resolver (hit / miss / no-port / NO-THROW / provenance)
 *   D. composite wiring + red-on-injection (drop a dep ⇒ that kind vanishes)
 *   E. byte-identical default: no deps ⇒ no new methods on the port shape
 *
 * Every fake owner is INJECTED (canned MCP listing port / NamedAgentRegistry /
 * thread summary port) so replay is deterministic — no live client, no fs.
 */

import { describe, expect, test } from "bun:test"
import { buildInjectionFragments, parseMentions } from "@/agent/mention-injection"
import { NamedAgentRegistry } from "@/agent/named-agent-registry"
import {
  createCompositeMentionResolver,
  createMcpResolver,
  createSubagentResolver,
  createThreadResolver,
  type McpServerListingPort,
  type ThreadSummaryPort,
} from "@/agent/plugin-app-resolver"

// ── shared fakes ────────────────────────────────────────────────────────

const mcpPort =
  (
    map: Record<string, { name: string; description?: string }[] | undefined>,
  ): McpServerListingPort =>
  async (server) =>
    map[server] ?? null

const registry = () =>
  new NamedAgentRegistry([
    {
      agentType: "explorer",
      system: "Read-only codebase explorer\nDo not write files.",
      sourcePath: "/repo/.quanta/agents/explorer.md",
    },
  ])

const threadPort =
  (
    map: Record<
      string,
      | { id: string; title: string; cwd?: string; gitBranch?: string; threadSource?: string }
      | undefined
    >,
  ): ThreadSummaryPort =>
  async (id) =>
    map[id] ?? null

// ── A. mcp resolver ─────────────────────────────────────────────────────

describe("createMcpResolver", () => {
  test("A1 — known server ⇒ header + one line per tool", async () => {
    const r = createMcpResolver({
      listing: mcpPort({
        github: [{ name: "create_pr", description: "Open a PR\nmore" }, { name: "list_issues" }],
      }),
    })
    const out = await r("github")
    expect(out?.bodyText).toBe("mcp: github\n- create_pr — Open a PR\n- list_issues")
  })

  test("A2 — unknown server ⇒ null (skip), NOT an empty stub", async () => {
    const r = createMcpResolver({ listing: mcpPort({ github: [] }) })
    expect(await r("nope")).toBeNull()
  })

  test("A3 — known-but-toolless ⇒ header-only body (distinct from unknown)", async () => {
    const r = createMcpResolver({ listing: mcpPort({ github: [] }) })
    expect((await r("github"))?.bodyText).toBe("mcp: github")
  })

  test("A4 — maxTools caps the tool lines and appends a remainder marker", async () => {
    const tools = Array.from({ length: 5 }, (_, i) => ({ name: `t${i}` }))
    const r = createMcpResolver({ listing: mcpPort({ s: tools }), maxTools: 2 })
    const body = (await r("s"))?.bodyText ?? ""
    expect(body).toBe("mcp: s\n- t0\n- t1\n… (3 more tools)")
  })

  test("A5 — a throwing listing port ⇒ null (NO-THROW)", async () => {
    const r = createMcpResolver({
      listing: async () => {
        throw new Error("boom")
      },
    })
    expect(await r("x")).toBeNull()
  })
})

// ── B. subagent resolver ────────────────────────────────────────────────

describe("createSubagentResolver", () => {
  test("B1 — known handle ⇒ handle + first line of the role system prompt", async () => {
    const r = createSubagentResolver(registry())
    expect((await r("explorer"))?.bodyText).toBe("subagent: explorer\nRead-only codebase explorer")
  })

  test("B2 — unknown handle ⇒ null (skip)", async () => {
    const r = createSubagentResolver(registry())
    expect(await r("ghost")).toBeNull()
  })

  test("B3 — no registry injected ⇒ null (graceful omit)", async () => {
    const r = createSubagentResolver(undefined)
    expect(await r("explorer")).toBeNull()
  })

  test("B4 — hostile registry that throws ⇒ null (NO-THROW)", async () => {
    const r = createSubagentResolver({
      resolve: () => {
        throw new Error("boom")
      },
    })
    expect(await r("explorer")).toBeNull()
  })

  test("B5 — no foreign-lineage leak: only repo-registered handles resolve", async () => {
    // The registry is the repo-controlled named-agent set; a handle that a
    // DIFFERENT task might have spawned but this registry never declared is a
    // clean miss — there is no cross-task child roster to surface.
    const r = createSubagentResolver(registry())
    expect(await r("some-other-tasks-child")).toBeNull()
  })
})

// ── C. thread resolver ──────────────────────────────────────────────────

describe("createThreadResolver", () => {
  test("C1 — known id ⇒ title + provenance lines", async () => {
    const r = createThreadResolver({
      summary: threadPort({
        "abc-1": {
          id: "abc-1",
          title: "Fix the parser",
          cwd: "/repo",
          gitBranch: "feat/x",
          threadSource: "resumed",
        },
      }),
    })
    expect((await r("abc-1"))?.bodyText).toBe(
      "thread: Fix the parser\nid: abc-1\ncwd: /repo\nbranch: feat/x\nsource: resumed",
    )
  })

  test("C2 — unknown id ⇒ null (skip)", async () => {
    const r = createThreadResolver({ summary: threadPort({}) })
    expect(await r("nope")).toBeNull()
  })

  test("C3 — untitled thread ⇒ (untitled) placeholder, still resolves", async () => {
    const r = createThreadResolver({ summary: threadPort({ z: { id: "z", title: "" } }) })
    expect((await r("z"))?.bodyText).toBe("thread: (untitled)\nid: z")
  })

  test("C4 — a throwing summary port ⇒ null (NO-THROW)", async () => {
    const r = createThreadResolver({
      summary: async () => {
        throw new Error("boom")
      },
    })
    expect(await r("x")).toBeNull()
  })
})

// ── D. composite wiring + red-on-injection ──────────────────────────────

describe("composite resolver — RFC-12-2 wiring", () => {
  const fullDeps = () => ({
    mcp: { listing: mcpPort({ github: [{ name: "create_pr" }] }) },
    subagents: registry(),
    threads: { summary: threadPort({ "abc-1": { id: "abc-1", title: "Prior" } }) },
  })

  const inject = async (
    text: string,
    deps: Parameters<typeof createCompositeMentionResolver>[0],
  ) => {
    const resolver = createCompositeMentionResolver(deps)
    return buildInjectionFragments(parseMentions(text), resolver)
  }

  test("D1 — all three deps wired ⇒ all three kinds inject their context", async () => {
    const frags = await inject("@mcp:github @subagent:explorer @thread:abc-1", fullDeps())
    expect(frags.map((f) => f.kind)).toEqual(["mcp", "subagent", "thread"])
    expect(frags[0]?.bodyText).toContain("mcp: github")
    expect(frags[1]?.bodyText).toContain("subagent: explorer")
    expect(frags[2]?.bodyText).toContain("thread: Prior")
  })

  test("D2 — RED-ON-INJECTION: drop the mcp dep ⇒ ONLY the mcp kind vanishes", async () => {
    const { subagents, threads } = fullDeps()
    const frags = await inject("@mcp:github @subagent:explorer @thread:abc-1", {
      subagents,
      threads,
    })
    // mcp gone; the OTHER two still resolve (paired control — proves the drop
    // is surgical, not a blanket wipe).
    expect(frags.map((f) => f.kind)).toEqual(["subagent", "thread"])
  })

  test("D3 — RED-ON-INJECTION: drop the subagent dep ⇒ ONLY subagent vanishes", async () => {
    const { mcp, threads } = fullDeps()
    const frags = await inject("@mcp:github @subagent:explorer @thread:abc-1", { mcp, threads })
    expect(frags.map((f) => f.kind)).toEqual(["mcp", "thread"])
  })

  test("D4 — RED-ON-INJECTION: drop the thread dep ⇒ ONLY thread vanishes", async () => {
    const { mcp, subagents } = fullDeps()
    const frags = await inject("@mcp:github @subagent:explorer @thread:abc-1", { mcp, subagents })
    expect(frags.map((f) => f.kind)).toEqual(["mcp", "subagent"])
  })
})

// ── E. byte-identical default ───────────────────────────────────────────

describe("composite resolver — byte-identical default-OFF", () => {
  test("E1 — no RFC-12-2 deps ⇒ port has NO resolveMcp/Subagent/Thread methods", () => {
    const port = createCompositeMentionResolver({})
    expect(port.resolveMcp).toBeUndefined()
    expect(port.resolveSubagent).toBeUndefined()
    expect(port.resolveThread).toBeUndefined()
  })

  test("E2 — no deps ⇒ every RFC-12-2 mention resolves to null (injects nothing)", async () => {
    const port = createCompositeMentionResolver({})
    const frags = await buildInjectionFragments(
      parseMentions("@mcp:github @subagent:explorer @thread:abc-1"),
      port,
    )
    expect(frags).toEqual([])
  })
})
