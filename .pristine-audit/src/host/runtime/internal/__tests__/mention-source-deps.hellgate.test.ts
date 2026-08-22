/**
 * RFC-12-2 WIRING — RESOLVER-side composition-root integration hellgate for the
 * three `@`-mention kinds (`@mcp:` / `@subagent:` / `@thread:`) that RFC-12-2
 * built but left DARK. Drives the REAL resolver seam —
 * `buildMentionResolverOwners` → `buildDefaultMentionResolver` →
 * `buildInjectionFragments` — with LIVE-shaped sources, and pins:
 *
 *   RED (pre-wire): with owners NOT injected, every kind is dark.
 *   GREEN: injected owners resolve context.
 *   Kill-switch: each `QUANTA_MENTION_*=off` darkens ONLY its kind.
 *   Byte-identical: absent source ⇒ omitted owner.
 *   Red-on-injection: drop one owner ⇒ ONLY its kind goes dark.
 *   Foreign-lineage: the subagent source is the repo registry — no leak.
 *
 * The PROVIDER side (`buildMentionProviderListers` → `createCompositeAtProvider`)
 * lives in `apps/cli/repl/surface-compose/__tests__/mention-provider-listers.hellgate.test.ts`
 * (the host layer cannot import `apps/cli/at-autocomplete` — slice isolation).
 */

import { describe, expect, test } from "bun:test"
import { buildInjectionFragments, parseMentions } from "@/agent/mention-injection"
import { buildDefaultMentionResolver } from "@/agent/mention-runner"
import { NamedAgentRegistry } from "@/agent/named-agent-registry"
import type { ThreadSummary } from "@/agent/plugin-app-resolver"
import {
  buildMentionResolverOwners,
  type McpServerSnapshot,
  type MentionLiveSources,
} from "../mention-source-deps"

const cwd = "/tmp/rfc12-2-wire"

const mcpServers: readonly McpServerSnapshot[] = [
  { name: "github", tools: [{ name: "create_pr", description: "Open a PR\nmore" }] },
  { name: "empty-srv", tools: [] },
]

const registry = () =>
  new NamedAgentRegistry([
    {
      agentType: "explorer",
      system: "Read-only explorer role\nsecond line",
      sourcePath: "/repo/.quanta/agents/explorer.md",
    },
  ])

const sessions: readonly ThreadSummary[] = [
  { id: "abc-1", title: "Prior thread", cwd: "/work", gitBranch: "feat/x" },
]

const liveSources = (): MentionLiveSources => ({
  mcpServers,
  subagents: registry(),
  sessions: async () => sessions,
  // B4 lineage — the caller IS `abc-1` (a self-mention is trivially in-lineage),
  // so these baseline cases keep resolving `@thread:abc-1`. The dedicated lineage
  // security hellgate (mention-thread-lineage.hellgate.test.ts) pins sibling-refusal.
  selfThreadId: "abc-1",
})

// ── RESOLVER side (submit-time context injection) ───────────────────────────

const resolveFrags = async (
  text: string,
  sources: MentionLiveSources,
  env: Record<string, string | undefined>,
) => {
  const resolver = buildDefaultMentionResolver({
    cwd,
    env,
    ...buildMentionResolverOwners(sources),
  })
  return buildInjectionFragments(parseMentions(text), resolver)
}

describe("RFC-12-2 wiring — resolver owners from live sources", () => {
  test("RED — NO sources wired ⇒ all three kinds dark (byte-identical pre-wire)", async () => {
    const frags = await resolveFrags("@mcp:github @subagent:explorer @thread:abc-1", {}, {})
    expect(frags).toEqual([])
  })

  test("GREEN — live sources wired ⇒ all three resolve into context", async () => {
    const frags = await resolveFrags(
      "@mcp:github @subagent:explorer @thread:abc-1",
      liveSources(),
      {},
    )
    expect(frags.map((f) => f.kind)).toEqual(["mcp", "subagent", "thread"])
    expect(frags[0]?.bodyText).toContain("mcp: github")
    expect(frags[0]?.bodyText).toContain("create_pr")
    // first-line-only projection (no "more")
    expect(frags[0]?.bodyText).not.toContain("more")
    expect(frags[1]?.bodyText).toContain("subagent: explorer")
    expect(frags[1]?.bodyText).toContain("Read-only explorer role")
    expect(frags[2]?.bodyText).toContain("thread: Prior thread")
    expect(frags[2]?.bodyText).toContain("id: abc-1")
  })

  test("kill-switch — QUANTA_MENTION_MCP=off darkens ONLY mcp", async () => {
    const frags = await resolveFrags("@mcp:github @subagent:explorer", liveSources(), {
      QUANTA_MENTION_MCP: "off",
    })
    expect(frags.map((f) => f.kind)).toEqual(["subagent"])
  })

  test("kill-switch — QUANTA_MENTION_SUBAGENT=off darkens ONLY subagent", async () => {
    const frags = await resolveFrags("@subagent:explorer @thread:abc-1", liveSources(), {
      QUANTA_MENTION_SUBAGENT: "off",
    })
    expect(frags.map((f) => f.kind)).toEqual(["thread"])
  })

  test("kill-switch — QUANTA_MENTION_THREAD=off darkens ONLY thread", async () => {
    const frags = await resolveFrags("@thread:abc-1 @mcp:github", liveSources(), {
      QUANTA_MENTION_THREAD: "off",
    })
    expect(frags.map((f) => f.kind)).toEqual(["mcp"])
  })

  test("red-on-injection — drop the MCP source ⇒ ONLY mcp dark, others live", async () => {
    const dropped: MentionLiveSources = {
      subagents: registry(),
      sessions: async () => sessions,
      selfThreadId: "abc-1",
    }
    const frags = await resolveFrags("@mcp:github @subagent:explorer @thread:abc-1", dropped, {})
    expect(frags.map((f) => f.kind)).toEqual(["subagent", "thread"])
  })

  test("red-on-injection — drop the subagent source ⇒ ONLY subagent dark", async () => {
    const dropped: MentionLiveSources = {
      mcpServers,
      sessions: async () => sessions,
      selfThreadId: "abc-1",
    }
    const frags = await resolveFrags("@mcp:github @subagent:explorer @thread:abc-1", dropped, {})
    expect(frags.map((f) => f.kind)).toEqual(["mcp", "thread"])
  })

  test("red-on-injection — drop the session source ⇒ ONLY thread dark", async () => {
    const dropped: MentionLiveSources = { mcpServers, subagents: registry() }
    const frags = await resolveFrags("@mcp:github @subagent:explorer @thread:abc-1", dropped, {})
    expect(frags.map((f) => f.kind)).toEqual(["mcp", "subagent"])
  })

  test("miss — unknown mcp server / thread id resolve null (no fabricated stub)", async () => {
    const frags = await resolveFrags("@mcp:nope @thread:missing", liveSources(), {})
    expect(frags).toEqual([])
  })

  test("known-but-empty — an MCP server with zero tools resolves a header-only body", async () => {
    const frags = await resolveFrags("@mcp:empty-srv", liveSources(), {})
    expect(frags.map((f) => f.kind)).toEqual(["mcp"])
    expect(frags[0]?.bodyText).toContain("mcp: empty-srv")
  })
})
