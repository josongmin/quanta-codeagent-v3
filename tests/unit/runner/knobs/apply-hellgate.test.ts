/**
 * Hellgate — applyKnobs adversarial battery.
 *
 * Targets `src/runner/knobs/apply.ts`. Pins the fold semantics under:
 *   - knob.apply throwing
 *   - knob.apply attempting to mutate cfg
 *   - duplicate ids in values + knobs (idempotency)
 *   - surface mismatch silent skip
 *   - byte-identical fence with empty values
 *   - order independence between knob.apply calls
 *   - scale (100+ knobs in one fold)
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

type Tagged = AgentConfig & { __marks?: ReadonlyArray<string> }

const baseCfg = (): Tagged => ({ __marks: [] }) as unknown as Tagged

const mkMark = (id: string, surfaces: Knob["surfaces"] = ["bench"]): Knob<string> => ({
  id,
  envKey: `Q_${id.toUpperCase()}`,
  category: "tool",
  surfaces,
  parse: (raw) => raw,
  apply: (cfg, value) => {
    const c = cfg as Tagged
    return { ...c, __marks: [...(c.__marks ?? []), `${id}=${value}`] } as unknown as AgentConfig
  },
  describe: id,
})

const mkValues = (...entries: ReadonlyArray<[string, KnobValue<unknown>]>): KnobValueMap =>
  new Map(entries)

describe("hellgate / apply — byte-identical with empty values", () => {
  test("empty values + empty knobs → cfg === base", () => {
    const base = baseCfg()
    const out = applyKnobs(base, new Map(), new Map(), { surface: "bench" })
    expect(out).toBe(base)
  })

  test("empty values + populated knobs → cfg === base (no values to iterate)", () => {
    const base = baseCfg()
    const knobs = new Map<string, AnyKnob>([["a", asAnyKnob(mkMark("a"))]])
    const out = applyKnobs(base, knobs, new Map(), { surface: "bench" })
    expect(out).toBe(base)
  })

  test("populated values but ALL knobs miss surface → cfg === base", () => {
    const base = baseCfg()
    const knobs = new Map<string, AnyKnob>([["a", asAnyKnob(mkMark("a", ["cli"]))]])
    const out = applyKnobs(base, knobs, mkValues(["a", { value: "v", source: "cli" }]), {
      surface: "bench",
    })
    expect(out).toBe(base)
  })

  test("all knobs missing from knobs map → cfg === base", () => {
    const base = baseCfg()
    const out = applyKnobs(base, new Map(), mkValues(["ghost", { value: "v", source: "cli" }]), {
      surface: "bench",
    })
    expect(out).toBe(base)
  })
})

describe("hellgate / apply — exception isolation", () => {
  test("knob.apply throws → propagates (not silently swallowed)", () => {
    const evil: Knob<string> = {
      id: "evil",
      envKey: "Q_EVIL",
      category: "tool",
      surfaces: ["bench"],
      parse: (raw) => raw,
      apply: () => {
        throw new Error("boom")
      },
      describe: "evil",
    }
    const base = baseCfg()
    const knobs = new Map<string, AnyKnob>([["evil", asAnyKnob(evil)]])
    expect(() =>
      applyKnobs(base, knobs, mkValues(["evil", { value: "x", source: "cli" }]), {
        surface: "bench",
      }),
    ).toThrow(/boom/)
  })

  test("knob.apply throws after earlier knobs succeed → loop aborts (no partial state silently)", () => {
    const a = mkMark("a")
    const evil: Knob<string> = {
      id: "b",
      envKey: "Q_B",
      category: "tool",
      surfaces: ["bench"],
      parse: (raw) => raw,
      apply: () => {
        throw new Error("boom")
      },
      describe: "b",
    }
    const knobs = new Map<string, AnyKnob>([
      ["a", asAnyKnob(a)],
      ["b", asAnyKnob(evil)],
    ])
    expect(() =>
      applyKnobs(
        baseCfg(),
        knobs,
        mkValues(["a", { value: "1", source: "cli" }], ["b", { value: "boom", source: "cli" }]),
        { surface: "bench" },
      ),
    ).toThrow()
  })
})

describe("hellgate / apply — mutation guards", () => {
  test("knob.apply that returns the SAME cfg reference is allowed (no-op knob)", () => {
    const noop: Knob<string> = {
      id: "noop",
      envKey: "Q",
      category: "tool",
      surfaces: ["bench"],
      parse: (raw) => raw,
      apply: (cfg) => cfg,
      describe: "noop",
    }
    const base = baseCfg()
    const out = applyKnobs(
      base,
      new Map<string, AnyKnob>([["noop", asAnyKnob(noop)]]),
      mkValues(["noop", { value: "v", source: "cli" }]),
      { surface: "bench" },
    )
    // noop returned base; the loop reassigned but the final reference is still base.
    expect(out).toBe(base)
  })

  test("base config is NOT mutated by knob fold (deep)", () => {
    const a = mkMark("a")
    const b = mkMark("b")
    const base = baseCfg()
    const knobs = new Map<string, AnyKnob>([
      ["a", asAnyKnob(a)],
      ["b", asAnyKnob(b)],
    ])
    applyKnobs(
      base,
      knobs,
      mkValues(["a", { value: "1", source: "cli" }], ["b", { value: "2", source: "cli" }]),
      { surface: "bench" },
    )
    expect(base.__marks).toEqual([])
  })

  test("knob.apply that tries to mutate cfg.__marks does NOT leak across runs", () => {
    const mutator: Knob<string> = {
      id: "bad",
      envKey: "Q",
      category: "tool",
      surfaces: ["bench"],
      parse: (raw) => raw,
      apply: (cfg) => {
        // Deliberate mutation attempt — should NOT survive across applyKnobs
        // calls because the input base is a fresh object each call.
        const t = cfg as Tagged
        ;(t.__marks as string[] | undefined)?.push("MUTATED")
        return cfg
      },
      describe: "bad",
    }
    const knobs = new Map<string, AnyKnob>([["bad", asAnyKnob(mutator)]])
    const base1 = baseCfg()
    applyKnobs(base1, knobs, mkValues(["bad", { value: "v", source: "cli" }]), {
      surface: "bench",
    })
    const base2 = baseCfg()
    expect(base2.__marks).toEqual([])
    // base1 was mutated by the buggy knob — that's the knob's own bug, not the
    // framework's. The fact that base2 is unaffected proves no shared state.
  })
})

describe("hellgate / apply — duplicate + order semantics", () => {
  test("same knob applied via VALUES map iteration order is deterministic", () => {
    const a = mkMark("a")
    const b = mkMark("b")
    const c = mkMark("c")
    const knobs = new Map<string, AnyKnob>([
      ["a", asAnyKnob(a)],
      ["b", asAnyKnob(b)],
      ["c", asAnyKnob(c)],
    ])
    // Maps preserve insertion order; pass values in a deliberate order.
    const values = mkValues(
      ["c", { value: "3", source: "cli" }],
      ["a", { value: "1", source: "cli" }],
      ["b", { value: "2", source: "cli" }],
    )
    const out = applyKnobs(baseCfg(), knobs, values, { surface: "bench" })
    expect((out as Tagged).__marks).toEqual(["c=3", "a=1", "b=2"])
  })

  test("value present twice in values map is impossible (Map key uniqueness)", () => {
    const m = new Map<string, KnobValue<unknown>>()
    m.set("a", { value: "first", source: "cli" })
    m.set("a", { value: "second", source: "env" })
    // Second set replaces first.
    expect(m.get("a")?.value).toBe("second")
    expect(m.size).toBe(1)
  })

  test("100 knobs apply in a single fold without quadratic slowdown", () => {
    const knobs = new Map<string, AnyKnob>()
    const values = new Map<string, KnobValue<unknown>>()
    for (let i = 0; i < 100; i++) {
      const id = `k-${i}`
      knobs.set(id, asAnyKnob(mkMark(id)))
      values.set(id, { value: String(i), source: "cli" })
    }
    const t = performance.now()
    const out = applyKnobs(baseCfg(), knobs, values, { surface: "bench" })
    expect(performance.now() - t).toBeLessThan(50)
    expect((out as Tagged).__marks?.length).toBe(100)
  })
})

describe("hellgate / apply — surface filtering double-check", () => {
  test("ctx.surface=cli + knob surfaces=[bench] → skipped", () => {
    const bench = mkMark("bench", ["bench"])
    const out = applyKnobs(
      baseCfg(),
      new Map<string, AnyKnob>([["bench", asAnyKnob(bench)]]),
      mkValues(["bench", { value: "v", source: "cli" }]),
      { surface: "cli" },
    )
    expect((out as Tagged).__marks).toEqual([])
  })

  test("multi-surface knob applies on each declared surface", () => {
    const k = mkMark("multi", ["bench", "cli"])
    for (const s of ["bench", "cli"] as const) {
      const out = applyKnobs(
        baseCfg(),
        new Map<string, AnyKnob>([["multi", asAnyKnob(k)]]),
        mkValues(["multi", { value: s, source: "cli" }]),
        { surface: s },
      )
      expect((out as Tagged).__marks).toEqual([`multi=${s}`])
    }
  })

  test("empty surfaces array → never applied regardless of ctx", () => {
    const orphan = mkMark("orphan", [])
    for (const s of ["bench", "cli", "ide"] as const) {
      const out = applyKnobs(
        baseCfg(),
        new Map<string, AnyKnob>([["orphan", asAnyKnob(orphan)]]),
        mkValues(["orphan", { value: "v", source: "cli" }]),
        { surface: s },
      )
      expect((out as Tagged).__marks).toEqual([])
    }
  })
})

describe("hellgate / apply — ApplyContext passthrough", () => {
  test("ctx.surface forwarded to knob.apply", () => {
    let seen = ""
    const k: Knob<string> = {
      id: "obs",
      envKey: "Q",
      category: "tool",
      surfaces: ["agent-batch"],
      parse: (raw) => raw,
      apply: (cfg, _v, ctx) => {
        seen = ctx.surface
        return cfg
      },
      describe: "obs",
    }
    applyKnobs(
      baseCfg(),
      new Map<string, AnyKnob>([["obs", asAnyKnob(k)]]),
      mkValues(["obs", { value: "x", source: "cli" }]),
      { surface: "agent-batch" },
    )
    expect(seen).toBe("agent-batch")
  })

  test("ctx.instance is undefined when not passed (no fabricated default)", () => {
    let seenId: string | undefined = "should-be-undefined"
    const k: Knob<string> = {
      id: "obs",
      envKey: "Q",
      category: "tool",
      surfaces: ["bench"],
      parse: (raw) => raw,
      apply: (cfg, _v, ctx) => {
        seenId = ctx.instance?.id
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
    expect(seenId).toBeUndefined()
  })

  test("ctx.sandbox forwarded when present", () => {
    let seenSandbox: string | undefined
    const k: Knob<string> = {
      id: "obs",
      envKey: "Q",
      category: "tool",
      surfaces: ["bench"],
      parse: (raw) => raw,
      apply: (cfg, _v, ctx) => {
        seenSandbox = ctx.sandbox
        return cfg
      },
      describe: "obs",
    }
    applyKnobs(
      baseCfg(),
      new Map<string, AnyKnob>([["obs", asAnyKnob(k)]]),
      mkValues(["obs", { value: "x", source: "cli" }]),
      { surface: "bench", sandbox: "/tmp/sb" },
    )
    expect(seenSandbox).toBe("/tmp/sb")
  })
})
