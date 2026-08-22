/**
 * `applyKnobs` — pure fold over `AgentConfig`.
 *
 * We don't need a full real AgentConfig: each test passes a tiny stub typed
 * as the shape under test. The fold mutates only what the knob mutates and
 * never touches anything else.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import {
  type AnyKnob,
  applyKnobs,
  asAnyKnob,
  type Knob,
  type KnobValue,
  type KnobValueMap,
} from "@/runner/knobs"

type CfgWithMarks = AgentConfig & {
  __marks?: ReadonlyArray<string>
}

const baseCfg = (): CfgWithMarks => ({ __marks: [] }) as unknown as CfgWithMarks

const makeMarkKnob = (id: string, surfaces: Knob["surfaces"] = ["bench"]): Knob<string> => ({
  id,
  envKey: `Q_${id.toUpperCase()}`,
  category: "tool",
  surfaces,
  parse: (raw) => raw,
  apply: (cfg, value) => {
    const c = cfg as CfgWithMarks
    return { ...c, __marks: [...(c.__marks ?? []), `${id}=${value}`] } as unknown as AgentConfig
  },
  describe: id,
})

const mkValues = (...entries: ReadonlyArray<[string, KnobValue<unknown>]>): KnobValueMap =>
  new Map(entries)

describe("applyKnobs", () => {
  test("empty values → returns base by reference", () => {
    const base = baseCfg()
    const out = applyKnobs(base, new Map(), new Map(), { surface: "bench" })
    expect(out).toBe(base)
  })

  test("single knob applies", () => {
    const k = makeMarkKnob("a")
    const out = applyKnobs(
      baseCfg(),
      new Map<string, AnyKnob>([["a", asAnyKnob(k)]]),
      mkValues(["a", { value: "1", source: "cli" }]),
      { surface: "bench" },
    )
    expect((out as CfgWithMarks).__marks).toEqual(["a=1"])
  })

  test("multiple knobs chained in iteration order", () => {
    const a = makeMarkKnob("a")
    const b = makeMarkKnob("b")
    const out = applyKnobs(
      baseCfg(),
      new Map<string, AnyKnob>([
        ["a", asAnyKnob(a)],
        ["b", asAnyKnob(b)],
      ]),
      mkValues(["a", { value: "1", source: "cli" }], ["b", { value: "2", source: "env" }]),
      { surface: "bench" },
    )
    expect((out as CfgWithMarks).__marks).toEqual(["a=1", "b=2"])
  })

  test("knob present in values but missing from knob map is skipped", () => {
    const out = applyKnobs(
      baseCfg(),
      new Map(),
      mkValues(["ghost", { value: "x", source: "cli" }]),
      { surface: "bench" },
    )
    expect((out as CfgWithMarks).__marks).toEqual([])
  })

  test("knob whose surface doesn't match ctx is skipped", () => {
    const cli = makeMarkKnob("cli-only", ["cli"])
    const out = applyKnobs(
      baseCfg(),
      new Map<string, AnyKnob>([["cli-only", asAnyKnob(cli)]]),
      mkValues(["cli-only", { value: "1", source: "cli" }]),
      { surface: "bench" },
    )
    expect((out as CfgWithMarks).__marks).toEqual([])
  })

  test("knob applies on matching surface", () => {
    const cli = makeMarkKnob("cli-only", ["cli"])
    const out = applyKnobs(
      baseCfg(),
      new Map<string, AnyKnob>([["cli-only", asAnyKnob(cli)]]),
      mkValues(["cli-only", { value: "1", source: "cli" }]),
      { surface: "cli" },
    )
    expect((out as CfgWithMarks).__marks).toEqual(["cli-only=1"])
  })

  test("apply does NOT mutate base config", () => {
    const a = makeMarkKnob("a")
    const base = baseCfg()
    applyKnobs(
      base,
      new Map<string, AnyKnob>([["a", asAnyKnob(a)]]),
      mkValues(["a", { value: "1", source: "cli" }]),
      { surface: "bench" },
    )
    expect(base.__marks).toEqual([])
  })

  test("ApplyContext.surface forwarded to knob.apply", () => {
    let observed = ""
    const k: Knob<string> = {
      id: "obs",
      envKey: "Q",
      category: "tool",
      surfaces: ["bench"],
      parse: (raw) => raw,
      apply: (cfg, _v, ctx) => {
        observed = ctx.surface
        return cfg
      },
      describe: "obs",
    }
    applyKnobs(
      baseCfg(),
      new Map<string, AnyKnob>([["obs", asAnyKnob(k)]]),
      mkValues(["obs", { value: "x", source: "cli" }]),
      { surface: "bench" },
    )
    expect(observed).toBe("bench")
  })

  test("ApplyContext.instance forwarded when present", () => {
    let observedId: string | undefined
    const k: Knob<string> = {
      id: "obs",
      envKey: "Q",
      category: "tool",
      surfaces: ["bench"],
      parse: (raw) => raw,
      apply: (cfg, _v, ctx) => {
        observedId = ctx.instance?.id
        return cfg
      },
      describe: "obs",
    }
    applyKnobs(
      baseCfg(),
      new Map<string, AnyKnob>([["obs", asAnyKnob(k)]]),
      mkValues(["obs", { value: "x", source: "cli" }]),
      {
        surface: "bench",
        instance: {
          id: "inst-1",
          repoPath: "/r",
          problemStatement: "p",
          testCmd: "true",
        },
      },
    )
    expect(observedId).toBe("inst-1")
  })

  test("multi-surface knob fires on each matching surface", () => {
    const k = makeMarkKnob("multi", ["bench", "cli"])
    const o1 = applyKnobs(
      baseCfg(),
      new Map<string, AnyKnob>([["multi", asAnyKnob(k)]]),
      mkValues(["multi", { value: "1", source: "cli" }]),
      { surface: "bench" },
    )
    const o2 = applyKnobs(
      baseCfg(),
      new Map<string, AnyKnob>([["multi", asAnyKnob(k)]]),
      mkValues(["multi", { value: "1", source: "cli" }]),
      { surface: "cli" },
    )
    expect((o1 as CfgWithMarks).__marks).toEqual(["multi=1"])
    expect((o2 as CfgWithMarks).__marks).toEqual(["multi=1"])
  })

  test("no-knob no-values path is byte-identical (===)", () => {
    const base = baseCfg()
    expect(applyKnobs(base, new Map(), new Map(), { surface: "bench" })).toBe(base)
    expect(applyKnobs(base, new Map(), new Map(), { surface: "cli" })).toBe(base)
  })
})
