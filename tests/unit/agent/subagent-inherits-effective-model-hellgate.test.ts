/**
 * ★ HELLGATE (MR-06) — a subagent inherits the model the parent is ACTUALLY
 * running, not the one it booted on.
 *
 * `resolveChildLlm` read `parent.llm` — and `parent` is the session BASE, whose
 * `llm` is the boot port. So every child spawned after a `/model` switch (or in a
 * session that booted onto a persisted pick) ran the model the parent had
 * abandoned. It was invisible because the obs projection
 * (`subagent-runner.ts` → `resolvedModel`) reads the same function, so it reported
 * the same wrong id: consistent, and consistently wrong.
 *
 * The role resolver has the same input: its documented "a role that falls through
 * to the parent model ⇒ no swap" rule was comparing against the boot model.
 *
 * RED-on-injection: `const parentModel = parent.llm.model` ⇒ cases 1/2/4 red.
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { inMemoryStickyModelStore } from "@/agent/sticky-model"
import { resolveChildLlm } from "@/agent/subagent-runner-overrides"
import type { LLMPort } from "@/llm"

const port = (model: string): LLMPort => ({ model }) as unknown as LLMPort
const BOOT = port("boot-model")
const PICKED = port("gpt-4o")
const ROLE = port("o3")

/** A parent whose SESSION has switched to `gpt-4o` (the sticky slot publishes it),
 *  while `llm` is still the boot port — the exact production shape. */
const switchedParent = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    llm: BOOT,
    modelCandidates: [
      { id: "gpt-4o", port: PICKED },
      { id: "o3", port: ROLE },
    ],
    stickyModelStore: {
      store: inMemoryStickyModelStore({ "openai:default": "gpt-4o" }),
      provider: "openai",
      effectiveModel: () => "gpt-4o",
    },
    ...over,
  }) as unknown as AgentConfig

describe("MR-06 · subagents inherit the parent's EFFECTIVE model", () => {
  test("1. no override ⇒ the child runs the parent's CURRENT model, not the boot one", () => {
    const child = resolveChildLlm(switchedParent(), {} as never)
    expect(child).toBe(PICKED)
    expect(child.model).toBe("gpt-4o")
  })

  test("2. the ROLE resolver is handed the effective model as `parentModel`", () => {
    const seen: string[] = []
    const parent = switchedParent({
      roleModelResolver: {
        resolve: (_role: string, parentModel: string) => {
          seen.push(parentModel)
          return parentModel // "falls through to the parent" ⇒ no swap
        },
      },
    } as never)
    const child = resolveChildLlm(parent, { role: "reviewer" } as never)
    expect(seen).toEqual(["gpt-4o"])
    // Falling through must yield the parent's EFFECTIVE port, not the boot one.
    expect(child).toBe(PICKED)
  })

  test("3. an explicit req.model still wins over the inherited one", () => {
    const child = resolveChildLlm(switchedParent(), { model: "o3" } as never)
    expect(child).toBe(ROLE)
  })

  test("4. paired control — an UNSWITCHED parent hands down its boot port, by identity", () => {
    const parent = { llm: BOOT, modelCandidates: [{ id: "gpt-4o", port: PICKED }] } as never
    expect(resolveChildLlm(parent, {} as never)).toBe(BOOT)
  })

  test("5. degrade — a selection with no candidate port falls back to the parent's own port", () => {
    // An inherited model is not a REQUIREMENT the way an explicit `req.model` is
    // (that one fails closed), so a missing candidate must not kill the child.
    const parent = {
      llm: BOOT,
      modelCandidates: [],
      stickyModelStore: { effectiveModel: () => "vanished-model" },
    } as never
    expect(resolveChildLlm(parent, {} as never)).toBe(BOOT)
  })
})
