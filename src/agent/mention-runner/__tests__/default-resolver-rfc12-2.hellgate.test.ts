/**
 * RFC-12-2 — front-door proof at the DRY composition seam
 * (`buildDefaultMentionResolver`): with the real owners injected (a canned MCP
 * listing port, a real `NamedAgentRegistry`, a canned thread-summary port) an
 * `@mcp:` / `@subagent:` / `@thread:` mention is resolved into the assembled
 * injection fragments. Also pins the per-kind kill-switch knobs + the
 * byte-identical default (no owner injected ⇒ that kind resolves to null).
 */

import { describe, expect, test } from "bun:test"
import { buildInjectionFragments, parseMentions } from "@/agent/mention-injection"
import { NamedAgentRegistry } from "@/agent/named-agent-registry"
import type { McpServerListingPort, ThreadSummaryPort } from "@/agent/plugin-app-resolver"
import { buildDefaultMentionResolver } from "../default-resolver"

const cwd = "/tmp/rfc12-2-seam"

const mcpListing: McpServerListingPort = async (s) =>
  s === "github" ? [{ name: "create_pr", description: "Open a PR" }] : null

const subagents = () =>
  new NamedAgentRegistry([
    {
      agentType: "explorer",
      system: "Read-only explorer",
      sourcePath: "/repo/.quanta/agents/explorer.md",
    },
  ])

const threadSummary: ThreadSummaryPort = async (id) =>
  id === "abc-1" ? { id: "abc-1", title: "Prior thread" } : null

const inject = async (text: string, env: Record<string, string | undefined>) => {
  const resolver = buildDefaultMentionResolver({
    cwd,
    env,
    mcpListing,
    subagents: subagents(),
    threadSummary,
  })
  return buildInjectionFragments(parseMentions(text), resolver)
}

describe("buildDefaultMentionResolver — RFC-12-2 front door", () => {
  test("F1 — default env (knobs unset ⇒ ON) resolves all three kinds", async () => {
    const frags = await inject("@mcp:github @subagent:explorer @thread:abc-1", {})
    expect(frags.map((f) => f.kind)).toEqual(["mcp", "subagent", "thread"])
    expect(frags[0]?.bodyText).toContain("mcp: github")
    expect(frags[0]?.bodyText).toContain("create_pr")
    expect(frags[1]?.bodyText).toContain("subagent: explorer")
    expect(frags[2]?.bodyText).toContain("thread: Prior thread")
  })

  test("F2 — QUANTA_MENTION_MCP=off disables ONLY mcp (kill-switch)", async () => {
    const frags = await inject("@mcp:github @subagent:explorer", { QUANTA_MENTION_MCP: "off" })
    expect(frags.map((f) => f.kind)).toEqual(["subagent"])
  })

  test("F3 — QUANTA_MENTION_SUBAGENT=off disables ONLY subagent", async () => {
    const frags = await inject("@mcp:github @subagent:explorer", { QUANTA_MENTION_SUBAGENT: "off" })
    expect(frags.map((f) => f.kind)).toEqual(["mcp"])
  })

  test("F4 — QUANTA_MENTION_THREAD=off disables ONLY thread", async () => {
    const frags = await inject("@thread:abc-1 @mcp:github", { QUANTA_MENTION_THREAD: "off" })
    expect(frags.map((f) => f.kind)).toEqual(["mcp"])
  })

  test("F5 — no owners injected ⇒ every RFC-12-2 kind resolves to null (byte-identical)", async () => {
    const resolver = buildDefaultMentionResolver({ cwd, env: {} })
    // even with the knobs ON, the ABSENT owner path means the methods are not
    // attached ⇒ nothing is injected.
    expect(resolver.resolveMcp).toBeUndefined()
    expect(resolver.resolveSubagent).toBeUndefined()
    expect(resolver.resolveThread).toBeUndefined()
    const frags = await buildInjectionFragments(
      parseMentions("@mcp:github @subagent:explorer @thread:abc-1"),
      resolver,
    )
    expect(frags).toEqual([])
  })
})
