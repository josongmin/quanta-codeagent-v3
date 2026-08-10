/**
 * RFC-12-2 WIRING — PROVIDER-side composition hellgate. Lives in `apps/cli`
 * (which may import both the host `buildMentionProviderListers` AND the
 * `at-autocomplete` provider — the host test cannot, per slice isolation).
 * Drives the REAL provider seam — `buildMentionProviderListers` →
 * `createCompositeAtProvider` — with LIVE-shaped sources, pinning:
 *
 *   RED (pre-wire): NO sources ⇒ zero mcp/subagent/thread candidates.
 *   GREEN: injected sources surface candidates with round-tripping insertText.
 *   Kill-switch: each `QUANTA_MENTION_*=off` darkens ONLY its kind (provider
 *     parity with the resolver's downstream gate).
 *   NO-THROW: a rejecting session source ⇒ zero thread candidates, others intact.
 */

import { describe, expect, test } from "bun:test"
import { parseMentions } from "@/agent/mention-injection"
import { NamedAgentRegistry } from "@/agent/named-agent-registry"
import {
  buildMentionProviderListers,
  type MentionLiveSources,
} from "@/host/runtime/internal/mention-source-deps"
import { createCompositeAtProvider } from "../../../at-autocomplete/provider"

const cwd = "/tmp/rfc12-2-provider"

const mcpServers = [{ name: "github", tools: [{ name: "create_pr", description: "Open a PR" }] }]

const registry = () =>
  new NamedAgentRegistry([
    {
      agentType: "explorer",
      system: "Read-only explorer role",
      sourcePath: "/repo/.quanta/agents/explorer.md",
    },
  ])

const liveSources = (): MentionLiveSources => ({
  mcpServers,
  subagents: registry(),
  sessions: async () => [{ id: "abc-1", title: "Prior thread", cwd: "/work" }],
  // B4 lineage — the caller IS `abc-1`, so its own thread enumerates (self is
  // trivially in-lineage). Sibling-exclusion is pinned in the dedicated lineage
  // hellgate (mention-thread-lineage.hellgate.test.ts).
  selfThreadId: "abc-1",
})

const candidatesFor = async (
  query: string,
  sources: MentionLiveSources,
  env: Record<string, string | undefined>,
) => {
  const provider = createCompositeAtProvider({
    fileRoot: cwd,
    ...(await buildMentionProviderListers(sources, env)),
  })
  return provider.list(query)
}

describe("RFC-12-2 wiring — provider listers from live sources", () => {
  test("RED — NO sources wired ⇒ zero mcp/subagent/thread candidates", async () => {
    const cands = await candidatesFor("g", {}, {})
    const kinds = new Set(cands.map((c) => c.kind))
    expect(kinds.has("mcp")).toBe(false)
    expect(kinds.has("subagent")).toBe(false)
    expect(kinds.has("thread")).toBe(false)
  })

  test("GREEN — mcp candidate surfaces with @mcp: insertText round-trip", async () => {
    const cands = await candidatesFor("git", liveSources(), {})
    const mcp = cands.find((c) => c.kind === "mcp")
    expect(mcp?.label).toBe("github")
    expect(mcp?.insertText).toBe("@mcp:github")
    expect(parseMentions(mcp?.insertText ?? "")[0]?.kind).toBe("mcp")
  })

  test("GREEN — subagent candidate surfaces with @subagent: insertText", async () => {
    const cands = await candidatesFor("explorer", liveSources(), {})
    const sub = cands.find((c) => c.kind === "subagent")
    expect(sub?.label).toBe("explorer")
    expect(sub?.insertText).toBe("@subagent:explorer")
    expect(parseMentions(sub?.insertText ?? "")[0]?.kind).toBe("subagent")
  })

  test("GREEN — thread candidate: label=title, insertText carries opaque id", async () => {
    const cands = await candidatesFor("prior", liveSources(), {})
    const th = cands.find((c) => c.kind === "thread")
    expect(th?.label).toBe("Prior thread")
    expect(th?.insertText).toBe("@thread:abc-1")
    expect(parseMentions(th?.insertText ?? "")[0]?.target).toBe("abc-1")
  })

  test("kill-switch — QUANTA_MENTION_SUBAGENT=off ⇒ no subagent candidates", async () => {
    const cands = await candidatesFor("explorer", liveSources(), { QUANTA_MENTION_SUBAGENT: "off" })
    expect(cands.some((c) => c.kind === "subagent")).toBe(false)
  })

  test("kill-switch — QUANTA_MENTION_MCP=off ⇒ no mcp candidates", async () => {
    const cands = await candidatesFor("git", liveSources(), { QUANTA_MENTION_MCP: "off" })
    expect(cands.some((c) => c.kind === "mcp")).toBe(false)
  })

  test("kill-switch — QUANTA_MENTION_THREAD=off ⇒ no thread candidates", async () => {
    const cands = await candidatesFor("prior", liveSources(), { QUANTA_MENTION_THREAD: "off" })
    expect(cands.some((c) => c.kind === "thread")).toBe(false)
  })

  test("NO-THROW — a rejecting session source ⇒ zero thread candidates, others intact", async () => {
    const badSessions: MentionLiveSources = {
      mcpServers,
      subagents: registry(),
      sessions: async () => {
        throw new Error("index read failed")
      },
    }
    const cands = await candidatesFor("g", badSessions, {})
    expect(cands.some((c) => c.kind === "thread")).toBe(false)
    expect(cands.some((c) => c.kind === "mcp")).toBe(true)
  })
})
