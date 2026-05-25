/**
 * Knob: `working-state` — parse/apply/surface/exactOptional invariants.
 *
 * Covers:
 *   1. parse — TRUTHY tokens (1, on, true) ⇒ true.
 *   2. parse — undefined / empty / garbage / "0" / "off" / "false" ⇒ undefined
 *      (strict gate, no silent off).
 *   3. apply on an allowed surface sets `cfg.workingState.enabled = true`.
 *   4. apply preserves existing workingState fields (idempotent flip).
 *   5. surface filter — `bench` is excluded ⇒ cfg unchanged.
 *   6. exactOptionalPropertyTypes — when filtered out, cfg returned by REF;
 *      when applied, only `workingState` key added/updated.
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { workingStateKnob } from "@/runner/knobs/knobs/working-state"

const baseCfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({ cwd: "/repo", ...over }) as AgentConfig

describe("knob: working-state", () => {
  test("parse accepts TRUTHY tokens", () => {
    expect(workingStateKnob.parse("1")).toBe(true)
    expect(workingStateKnob.parse("on")).toBe(true)
    expect(workingStateKnob.parse("true")).toBe(true)
  })

  test("parse rejects falsy / empty / garbage", () => {
    expect(workingStateKnob.parse(undefined)).toBeUndefined()
    expect(workingStateKnob.parse("")).toBeUndefined()
    expect(workingStateKnob.parse("0")).toBeUndefined()
    expect(workingStateKnob.parse("off")).toBeUndefined()
    expect(workingStateKnob.parse("false")).toBeUndefined()
    expect(workingStateKnob.parse("yes")).toBeUndefined()
    expect(workingStateKnob.parse(" 1 ")).toBeUndefined()
  })

  test("apply flips workingState.enabled on an allowed surface", () => {
    const out = workingStateKnob.apply(baseCfg(), true, { surface: "cli" })
    expect(out.workingState).toEqual({ enabled: true })
  })

  test("apply preserves any caller-supplied workingState fields", () => {
    // A future host may extend WorkingStateBlock; the knob must NOT clobber.
    const cfg = baseCfg({
      workingState: { enabled: false, ...({ extra: "carry-me" } as object) } as never,
    })
    const out = workingStateKnob.apply(cfg, true, { surface: "agent-batch" })
    expect(out.workingState).toMatchObject({ enabled: true, extra: "carry-me" })
  })

  test("surface filter — bench is excluded, cfg returned by ref", () => {
    const cfg = baseCfg()
    const out = workingStateKnob.apply(cfg, true, { surface: "bench" })
    expect(out).toBe(cfg)
    expect(out.workingState).toBeUndefined()
  })

  test("exactOptional — non-applied surface preserves identity; applied adds only the key", () => {
    const cfg = baseCfg()
    const ide = workingStateKnob.apply(cfg, true, { surface: "agent-interactive" })
    expect(ide).not.toBe(cfg)
    expect(Object.keys(ide).sort()).toEqual(["cwd", "workingState"].sort())
    // value:true is only honored when truthy was passed (sanity)
    expect(ide.workingState?.enabled).toBe(true)
  })
})
