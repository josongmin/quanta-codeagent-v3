/**
 * Knob: `hooks` — parse/apply/surface/exactOptional invariants.
 *
 * Covers:
 *   1. parse — "1" / "on" ⇒ true (brief-locked).
 *   2. parse — undefined / "true" / garbage / "0" ⇒ undefined.
 *   3. apply on an allowed surface installs a HookBus instance.
 *   4. apply preserves a caller-supplied bus (no overwrite).
 *   5. surface filter — `bench` AND `ide` excluded; identity preserved.
 *   6. exactOptionalPropertyTypes — applied result shape contains only `hooks`
 *      addition; non-applied surface returns SAME ref.
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { HookBus } from "@/agent"
import { hooksKnob } from "@/runner/knobs/knobs/hooks"

const baseCfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({ cwd: "/repo", ...over }) as AgentConfig

describe("knob: hooks", () => {
  test("parse accepts strict TRUTHY tokens (1 / on)", () => {
    expect(hooksKnob.parse("1")).toBe(true)
    expect(hooksKnob.parse("on")).toBe(true)
  })

  test("parse rejects undefined / 'true' (brief-locked) / garbage / falsy", () => {
    expect(hooksKnob.parse(undefined)).toBeUndefined()
    // The brief says "1"|"on" → true; "true" is NOT in the set here.
    expect(hooksKnob.parse("true")).toBeUndefined()
    expect(hooksKnob.parse("yes")).toBeUndefined()
    expect(hooksKnob.parse("0")).toBeUndefined()
    expect(hooksKnob.parse("off")).toBeUndefined()
    expect(hooksKnob.parse("")).toBeUndefined()
  })

  test("apply installs a HookBus on cli / agent-batch", () => {
    const cli = hooksKnob.apply(baseCfg(), true, { surface: "cli" })
    expect(cli.hooks).toBeInstanceOf(HookBus)
    const batch = hooksKnob.apply(baseCfg(), true, { surface: "agent-batch" })
    expect(batch.hooks).toBeInstanceOf(HookBus)
  })

  test("apply preserves caller-supplied bus (no overwrite)", () => {
    const existing = new HookBus()
    const cfg = baseCfg({ hooks: existing })
    const out = hooksKnob.apply(cfg, true, { surface: "cli" })
    // Defensive identity preservation — see knob comment for rationale.
    expect(out).toBe(cfg)
    expect(out.hooks).toBe(existing)
  })

  test("surface filter — bench AND ide are excluded; identity preserved", () => {
    const cfg = baseCfg()
    const bench = hooksKnob.apply(cfg, true, { surface: "bench" })
    expect(bench).toBe(cfg)
    expect(bench.hooks).toBeUndefined()
    const ide = hooksKnob.apply(cfg, true, { surface: "ide" })
    expect(ide).toBe(cfg)
    expect(ide.hooks).toBeUndefined()
    // agent-interactive is ALSO excluded for this knob per the task brief.
    const interactive = hooksKnob.apply(cfg, true, { surface: "agent-interactive" })
    expect(interactive).toBe(cfg)
  })

  test("exactOptional — applied result is new object with only `hooks` added", () => {
    const cfg = baseCfg()
    const out = hooksKnob.apply(cfg, true, { surface: "cli" })
    expect(out).not.toBe(cfg)
    expect(Object.keys(out).sort()).toEqual(["cwd", "hooks"].sort())
  })
})
