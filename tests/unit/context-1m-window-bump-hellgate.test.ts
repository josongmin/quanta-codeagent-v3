/**
 * Hellgate — 1M context-window bump through to compaction (GAP 3, ADR-0505).
 *
 * The factory already sends the context-1m beta header; this proves the WINDOW
 * actually reaches compaction + the usage gauge (previously they resolved the
 * 200k default because the API model is the stripped slug):
 *   - the Anthropic adapter pins `contextWindowKey = <model>-1m` when active, else undefined.
 *   - resolveWindowModel returns the -1m key ONLY when active model == base + key pinned.
 *   - resolveModelWindow over that key yields the 1M window (not 200k).
 *   - default-OFF: no knob/suffix ⇒ no key ⇒ 200k window (byte-identical).
 */
import { describe, expect, test } from "bun:test"
import { resolveWindowModel } from "@/agent/loop/emit-helpers"
import type { AgentConfig } from "@/agent/types"
import { createLLM } from "@/llm"
import type { AnthropicAdapter } from "@/llm/adapters/anthropic"
import { resolveModelWindow } from "@/llm/provider-metadata"

const KEY = { ANTHROPIC_API_KEY: "sk-ant-test" }
const adapter = (model: string, env: Record<string, string | undefined>): AnthropicAdapter =>
  createLLM("anthropic", { model }, { ...KEY, ...env }) as unknown as AnthropicAdapter

describe("1M window — adapter pins contextWindowKey when active", () => {
  test("QUANTA_CONTEXT_1M on an eligible model ⇒ <model>-1m key", () => {
    expect(adapter("claude-sonnet-4-5", { QUANTA_CONTEXT_1M: "1" }).contextWindowKey).toBe(
      "claude-sonnet-4-5-1m",
    )
  })
  test("[1m] suffix ⇒ key set, API model stripped", () => {
    const a = adapter("claude-sonnet-4-6[1m]", {})
    expect(a.contextWindowKey).toBe("claude-sonnet-4-6-1m")
    expect(a.model).toBe("claude-sonnet-4-6") // canonical API slug
  })
  test("default-OFF: no knob/suffix ⇒ contextWindowKey undefined (byte-identical)", () => {
    expect(adapter("claude-sonnet-4-5", {}).contextWindowKey).toBeUndefined()
  })
  test("ineligible model + knob ⇒ no key (eligibility is derived)", () => {
    expect(adapter("claude-opus-4-8", { QUANTA_CONTEXT_1M: "1" }).contextWindowKey).toBeUndefined()
  })
})

describe("1M window — resolveWindowModel + resolveModelWindow", () => {
  const llmWith = (key?: string): AgentConfig["llm"] =>
    ({
      model: "claude-sonnet-4-5",
      ...(key !== undefined ? { contextWindowKey: key } : {}),
    }) as AgentConfig["llm"]

  test("active base model + pinned key ⇒ resolves the 1M window", () => {
    const wm = resolveWindowModel(llmWith("claude-sonnet-4-5-1m"))
    expect(wm).toBe("claude-sonnet-4-5-1m")
    expect(resolveModelWindow(wm)?.contextWindow).toBe(1_000_000)
  })
  test("no pinned key ⇒ base model ⇒ 200k window (byte-identical)", () => {
    const wm = resolveWindowModel(llmWith(undefined))
    expect(wm).toBe("claude-sonnet-4-5")
    expect(resolveModelWindow(wm)?.contextWindow).toBeLessThan(1_000_000)
  })
  test("a skill/sticky SWAP (active != base) ⇒ active model, NOT the pinned key", () => {
    expect(resolveWindowModel(llmWith("claude-sonnet-4-5-1m"), "claude-opus-4-8")).toBe(
      "claude-opus-4-8",
    )
  })
})
