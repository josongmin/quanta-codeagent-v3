/**
 * Knob: `subagent` — parse + apply + surface filter.
 *
 * Locks behavior migrated from `QUANTA_BENCH_SUBAGENT=1` in
 * `src/runner/batch/eval/driver.ts`.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { subagentKnob } from "@/runner/knobs/knobs/subagent"

const baseCfg = (): AgentConfig => ({}) as AgentConfig

describe("subagent knob — parse", () => {
  test("`1`/`on`/`true` ⇒ true (strict truthy)", () => {
    expect(subagentKnob.parse("1")).toBe(true)
    expect(subagentKnob.parse("on")).toBe(true)
    expect(subagentKnob.parse("true")).toBe(true)
  })

  test("everything else ⇒ undefined (no heuristics)", () => {
    expect(subagentKnob.parse(undefined)).toBeUndefined()
    expect(subagentKnob.parse("")).toBeUndefined()
    expect(subagentKnob.parse("0")).toBeUndefined()
    expect(subagentKnob.parse("yes")).toBeUndefined()
    expect(subagentKnob.parse("True")).toBeUndefined()
    expect(subagentKnob.parse(" 1")).toBeUndefined()
    expect(subagentKnob.parse("garbage")).toBeUndefined()
  })
})

describe("subagent knob — apply", () => {
  test("bench surface + true ⇒ cfg.subagent = {}", () => {
    const out = subagentKnob.apply(baseCfg(), true, { surface: "bench" })
    expect(out.subagent).toEqual({})
  })

  test("preserves caller-provided subagent block (cfg.subagent ?? {})", () => {
    const cfg: AgentConfig = { subagent: { maxDepth: 3 } } as AgentConfig
    const out = subagentKnob.apply(cfg, true, { surface: "bench" })
    expect(out.subagent).toEqual({ maxDepth: 3 })
  })

  test("non-bench surface ⇒ cfg unchanged (byte-identical)", () => {
    const cfg = baseCfg()
    const out = subagentKnob.apply(cfg, true, { surface: "cli" })
    expect(out).toEqual(cfg)
    expect(out.subagent).toBeUndefined()
  })

  test("ide / agent-batch / agent-interactive all filtered out", () => {
    for (const s of ["ide", "agent-batch", "agent-interactive"] as const) {
      const out = subagentKnob.apply(baseCfg(), true, { surface: s })
      expect(out.subagent).toBeUndefined()
    }
  })
})

describe("subagent knob — metadata", () => {
  test("registry id / env / category / source pinned", () => {
    expect(subagentKnob.id).toBe("subagent")
    expect(subagentKnob.envKey).toBe("QUANTA_BENCH_SUBAGENT")
    expect(subagentKnob.category).toBe("agent")
    expect(subagentKnob.surfaces).toEqual(["bench"])
    expect(subagentKnob.source).toBe("Codex absorption Phase 0-8")
  })
})
