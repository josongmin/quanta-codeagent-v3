/**
 * Knob: `issue-hint` — tri-state parse + noop apply + surface filter.
 *
 * Locks behavior migrated from the `QUANTA_BENCH_ISSUE_HINT` accept-list in
 * `src/runner/batch/eval/driver.ts`.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { issueHintKnob } from "@/runner/knobs/knobs/issue-hint"

const baseCfg = (): AgentConfig => ({}) as AgentConfig

describe("issue-hint knob — parse (tri-state)", () => {
  test("`agentless` ⇒ 'agentless'", () => {
    expect(issueHintKnob.parse("agentless")).toBe("agentless")
  })

  test("`1` / `on` ⇒ 'regex'", () => {
    expect(issueHintKnob.parse("1")).toBe("regex")
    expect(issueHintKnob.parse("on")).toBe("regex")
  })

  test("everything else ⇒ undefined (strict accept-list)", () => {
    expect(issueHintKnob.parse(undefined)).toBeUndefined()
    expect(issueHintKnob.parse("")).toBeUndefined()
    expect(issueHintKnob.parse("true")).toBeUndefined()
    expect(issueHintKnob.parse("yes")).toBeUndefined()
    expect(issueHintKnob.parse("Agentless")).toBeUndefined()
    expect(issueHintKnob.parse("regex")).toBeUndefined()
    expect(issueHintKnob.parse("0")).toBeUndefined()
    expect(issueHintKnob.parse("garbage")).toBeUndefined()
  })
})

describe("issue-hint knob — apply (noop)", () => {
  test("apply NEVER mutates cfg (consumed out-of-band by driver)", () => {
    const cfg = baseCfg()
    const out1 = issueHintKnob.apply(cfg, "agentless", { surface: "bench" })
    const out2 = issueHintKnob.apply(cfg, "regex", { surface: "bench" })
    expect(out1).toBe(cfg)
    expect(out2).toBe(cfg)
  })

  test("non-bench surface ⇒ still noop, cfg unchanged", () => {
    const cfg = baseCfg()
    const out = issueHintKnob.apply(cfg, "regex", { surface: "cli" })
    expect(out).toBe(cfg)
  })
})

describe("issue-hint knob — metadata", () => {
  test("category 'hint' / surfaces / source pinned", () => {
    expect(issueHintKnob.id).toBe("issue-hint")
    expect(issueHintKnob.envKey).toBe("QUANTA_BENCH_ISSUE_HINT")
    expect(issueHintKnob.category).toBe("hint")
    expect(issueHintKnob.surfaces).toEqual(["bench"])
    expect(issueHintKnob.source).toBe("Agentless paper §3.1")
  })
})
