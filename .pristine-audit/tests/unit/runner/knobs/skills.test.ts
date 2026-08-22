/**
 * Knob: `skills` — parse + apply + surface filter.
 *
 * Locks behavior migrated from `QUANTA_BENCH_SKILLS=1` in
 * `src/runner/batch/eval/driver.ts`.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { skillsKnob } from "@/runner/knobs/knobs/skills"

const baseCfg = (): AgentConfig => ({}) as AgentConfig

describe("skills knob — parse", () => {
  test("`1`/`on`/`true` ⇒ true (strict truthy)", () => {
    expect(skillsKnob.parse("1")).toBe(true)
    expect(skillsKnob.parse("on")).toBe(true)
    expect(skillsKnob.parse("true")).toBe(true)
  })

  test("everything else ⇒ undefined (no heuristics)", () => {
    expect(skillsKnob.parse(undefined)).toBeUndefined()
    expect(skillsKnob.parse("")).toBeUndefined()
    expect(skillsKnob.parse("yes")).toBeUndefined()
    expect(skillsKnob.parse("True")).toBeUndefined()
    expect(skillsKnob.parse("garbage")).toBeUndefined()
  })
})

describe("skills knob — apply", () => {
  test("bench / agent-batch / agent-interactive all wire `skills: {}`", () => {
    for (const s of ["bench", "agent-batch", "agent-interactive"] as const) {
      const out = skillsKnob.apply(baseCfg(), true, { surface: s })
      expect(out.skills).toEqual({})
    }
  })

  test("preserves caller-provided skills block (cfg.skills ?? {})", () => {
    const cfg: AgentConfig = { skills: { dir: "/x" } } as AgentConfig
    const out = skillsKnob.apply(cfg, true, { surface: "bench" })
    expect(out.skills).toEqual({ dir: "/x" })
  })

  test("ide / cli surfaces filtered out ⇒ cfg unchanged", () => {
    for (const s of ["ide", "cli"] as const) {
      const out = skillsKnob.apply(baseCfg(), true, { surface: s })
      expect(out.skills).toBeUndefined()
    }
  })
})

describe("skills knob — metadata", () => {
  test("registry id / env / category / surfaces pinned", () => {
    expect(skillsKnob.id).toBe("skills")
    expect(skillsKnob.envKey).toBe("QUANTA_BENCH_SKILLS")
    expect(skillsKnob.category).toBe("agent")
    expect(skillsKnob.surfaces).toEqual(["bench", "agent-batch", "agent-interactive"])
    expect(skillsKnob.source).toBe("ADR-0045")
  })
})
