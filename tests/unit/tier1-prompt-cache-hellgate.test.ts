/**
 * Hellgate for the jun-04 prompt_cache_status wiring (ADR-0182).
 *
 * Pins the three seams that turn the formerly-orphan `prompt_cache_status` tool
 * into a live capability:
 *   1. `buildPromptCacheBlock` — default-OFF (no observer ⇒ no tool), ON when
 *      `config.promptCacheObserver` is wired.
 *   2. SHARED INSTANCE — the tool the block builds reads the SAME observer the
 *      loop's `emitUsage` feeds, so a recorded `CacheHitEvent` is visible in the
 *      tool snapshot (wiring the tool against a DIFFERENT observer would surface
 *      an empty report — the bug this guard exists to prevent).
 *   3. SOURCE FIDELITY — `buildUsageEvent` carries `cacheCreationTokens` only
 *      when the provider reported that bucket (the adapter→StreamEvent leg the
 *      observer's hit-rate / savings math depends on).
 */

import { describe, expect, test } from "bun:test"
import { buildPromptCacheBlock } from "@/agent/tier1"
import type { AgentConfig } from "@/agent/types"
import { buildUsageEvent } from "@/llm/adapters/shared"
import type { CacheHitEvent } from "@/observability/prompt-cache"
import { defaultPromptCacheObserver } from "@/observability/prompt-cache"
import type { Tool, ToolContext, ToolEvent } from "@/tool"

const cfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({ cwd: "/repo", signal: new AbortController().signal, ...over }) as AgentConfig

const ctx = (): ToolContext =>
  ({ cwd: "/repo", signal: new AbortController().signal }) as ToolContext

const runTool = async (tool: Tool, input: unknown): Promise<string> => {
  let out = ""
  for await (const ev of tool.execute(input, ctx()) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") out = ev.result.output
  }
  return out
}

const hit = (over: Partial<CacheHitEvent> = {}): CacheHitEvent => ({
  model: "claude-opus-4-7",
  sessionId: "s1",
  turnIndex: 0,
  atMs: 1,
  inputTokens: 1000,
  cacheCreationTokens: 0,
  cacheReadTokens: 9000,
  outputTokens: 500,
  ...over,
})

describe("tier1 prompt-cache block — default-OFF / default-ON", () => {
  test("no observer ⇒ no tool (byte-identical default-OFF)", () => {
    expect(buildPromptCacheBlock(cfg())).toEqual([])
  })

  test("observer wired ⇒ exactly the prompt_cache_status tool", () => {
    const tools = buildPromptCacheBlock(cfg({ promptCacheObserver: defaultPromptCacheObserver() }))
    expect(tools.map((t) => t.name)).toEqual(["prompt_cache_status"])
    expect(tools[0]?.isReadOnly?.()).toBe(true)
  })
})

describe("tier1 prompt-cache block — SHARED observer instance (the empty-snapshot trap)", () => {
  test("the tool reads the SAME observer the loop feed records into", async () => {
    const observer = defaultPromptCacheObserver()
    // The loop's emitUsage would call observer.record(...) with the per-turn
    // cache buckets; simulate one such record.
    observer.record(hit({ cacheReadTokens: 9000, inputTokens: 1000 }))
    const [tool] = buildPromptCacheBlock(cfg({ promptCacheObserver: observer }))
    const out = await runTool(tool as Tool, {})
    // The recorded tokens must surface — proving block-tool and loop-feed share
    // ONE instance. A separate observer would render "0" everywhere.
    expect(out).toContain("Prompt cache report")
    expect(out).toContain("cache read")
    expect(out).not.toContain("Hit rate:        0.0%")
  })

  test("a fresh, unfed observer renders an empty (all-zero) snapshot", async () => {
    const [tool] = buildPromptCacheBlock(cfg({ promptCacheObserver: defaultPromptCacheObserver() }))
    const out = await runTool(tool as Tool, {})
    expect(out).toContain("Hit rate:        0.0%")
  })
})

describe("usage-event source fidelity — cacheCreationTokens leg", () => {
  test("cacheCreationTokens is carried when the provider reported it", () => {
    const ev = buildUsageEvent({ inputTokens: 100, outputTokens: 10, cacheCreationTokens: 64 })
    expect(ev).not.toBeNull()
    expect(ev && "cacheCreationTokens" in ev ? ev.cacheCreationTokens : undefined).toBe(64)
  })

  test("cacheCreationTokens is OMITTED when absent (never an undefined/zero injection)", () => {
    const ev = buildUsageEvent({ inputTokens: 100, outputTokens: 10 })
    expect(ev).not.toBeNull()
    expect(ev && "cacheCreationTokens" in ev).toBe(false)
  })
})
