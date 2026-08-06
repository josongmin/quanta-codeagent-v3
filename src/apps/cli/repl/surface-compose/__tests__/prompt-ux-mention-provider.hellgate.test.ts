/**
 * RFC-12-2 WIRING — front-door proof that `buildPromptUx` threads the LIVE
 * mention sources onto the `@`-autocomplete `atProvider`. Drives the REAL
 * production composition (`buildPromptUx` → `buildAtProvider` →
 * `createCompositeAtProvider`) and asserts:
 *
 *   - `QUANTA_AT_AUTOCOMPLETE=1` + sources ⇒ the atProvider surfaces mcp /
 *     subagent / thread candidates with the round-tripping insertText.
 *   - Gate OFF (`QUANTA_AT_AUTOCOMPLETE` unset) ⇒ NO atProvider at all
 *     (byte-identical), even with sources present.
 *   - Red-on-injection: drop a source ⇒ ONLY its kind's candidates disappear.
 */

import { describe, expect, test } from "bun:test"
import { NamedAgentRegistry } from "@/agent/named-agent-registry"
import type { MentionLiveSources } from "@/host/runtime/internal/mention-source-deps"
import type { CliFeatureConfig } from "../../cli-feature-config"
import { buildPromptUx } from "../prompt-ux"

const featureCfg: CliFeatureConfig = {
  history: { enabled: false, maxLines: 100 },
  multiline: { enabled: false },
} as unknown as CliFeatureConfig

const registry = () =>
  new NamedAgentRegistry([
    {
      agentType: "explorer",
      system: "Read-only explorer\nx",
      sourcePath: "/r/.quanta/agents/e.md",
    },
  ])

const liveSources = (): MentionLiveSources => ({
  mcpServers: [{ name: "github", tools: [{ name: "create_pr", description: "Open a PR" }] }],
  subagents: registry(),
  sessions: async () => [{ id: "abc-1", title: "Prior thread", cwd: "/w" }],
})

const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  ({ QUANTA_AT_AUTOCOMPLETE: "1", ...over }) as NodeJS.ProcessEnv

describe("buildPromptUx — RFC-12-2 @-autocomplete mention listers wired", () => {
  test("surfaces mcp / subagent / thread candidates through the real atProvider", async () => {
    const ux = await buildPromptUx(
      featureCfg,
      "/tmp/rfc122-pux",
      env(),
      undefined,
      undefined,
      undefined,
      liveSources(),
    )
    expect(ux.atProvider).toBeDefined()
    const [mcp, sub, thread] = await Promise.all([
      ux.atProvider?.list("git"),
      ux.atProvider?.list("explorer"),
      ux.atProvider?.list("prior"),
    ])
    expect(mcp?.find((c) => c.kind === "mcp")?.insertText).toBe("@mcp:github")
    expect(sub?.find((c) => c.kind === "subagent")?.insertText).toBe("@subagent:explorer")
    const th = thread?.find((c) => c.kind === "thread")
    expect(th?.label).toBe("Prior thread")
    expect(th?.insertText).toBe("@thread:abc-1")
  })

  test("gate OFF (QUANTA_AT_AUTOCOMPLETE unset) ⇒ NO atProvider even with sources", async () => {
    const ux = await buildPromptUx(
      featureCfg,
      "/tmp/rfc122-pux",
      env({ QUANTA_AT_AUTOCOMPLETE: undefined }),
      undefined,
      undefined,
      undefined,
      liveSources(),
    )
    expect(ux.atProvider).toBeUndefined()
  })

  test("red-on-injection — drop the subagent source ⇒ ONLY subagent candidates gone", async () => {
    const dropped: MentionLiveSources = {
      mcpServers: liveSources().mcpServers,
      sessions: async () => [{ id: "abc-1", title: "Prior thread" }],
    }
    const ux = await buildPromptUx(
      featureCfg,
      "/tmp/rfc122-pux",
      env(),
      undefined,
      undefined,
      undefined,
      dropped,
    )
    const sub = await ux.atProvider?.list("explorer")
    const mcp = await ux.atProvider?.list("git")
    expect(sub?.some((c) => c.kind === "subagent")).toBe(false)
    expect(mcp?.some((c) => c.kind === "mcp")).toBe(true)
  })
})
