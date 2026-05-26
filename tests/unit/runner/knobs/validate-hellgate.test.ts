/**
 * Hellgate — validator adversarial battery.
 *
 * Targets `src/runner/knobs/validate.ts`. Pins behavior under self-references,
 * cycles, fan-out conflict graphs, missing-id references in requires/conflicts,
 * and large active-set scaling.
 */
import { describe, expect, test } from "bun:test"
import {
  type AnyKnob,
  type Knob,
  type KnobConflictError,
  KnobMissingRequiredError,
  type KnobValue,
  type KnobValueMap,
  validateKnobs,
} from "@/runner/knobs"

const mk = (id: string, opts: Partial<Knob<unknown>> = {}): AnyKnob => ({
  id,
  envKey: `Q_${id.toUpperCase()}`,
  category: "tool",
  surfaces: ["bench"],
  parse: (raw) => raw,
  apply: (cfg) => cfg,
  describe: id,
  ...opts,
})

const valuesOf = (...ids: ReadonlyArray<string>): KnobValueMap => {
  const m = new Map<string, KnobValue<unknown>>()
  for (const id of ids) m.set(id, { value: true, source: "cli" })
  return m
}

const knobsOf = (...ks: ReadonlyArray<AnyKnob>): ReadonlyMap<string, AnyKnob> =>
  new Map(ks.map((k) => [k.id, k]))

describe("hellgate / validate — self-reference oddities", () => {
  test("knob declares itself in conflicts → reports self-pair (active alone)", () => {
    // Self-conflict with only the knob itself active: the loop iterates active
    // ids, finds 'a' in its own conflicts array, and 'a' IS in active. The
    // pair key `${a} ${a}` is deterministic and dedup-stable.
    let err: KnobConflictError | undefined
    try {
      validateKnobs(valuesOf("a"), knobsOf(mk("a", { conflicts: ["a"] })))
    } catch (e) {
      err = e as KnobConflictError
    }
    // Document current behavior: self-conflict IS reported (single entry).
    expect(err).toBeDefined()
    expect(err?.conflicts.length).toBe(1)
  })

  test("knob declares itself in requires → satisfied (knob itself active)", () => {
    expect(() => validateKnobs(valuesOf("a"), knobsOf(mk("a", { requires: ["a"] })))).not.toThrow()
  })

  test("knob with requires=[self] but NOT active → no validation (validator only walks active)", () => {
    expect(() =>
      validateKnobs(valuesOf("b"), knobsOf(mk("a", { requires: ["a"] }), mk("b"))),
    ).not.toThrow()
  })
})

describe("hellgate / validate — missing referent in conflicts/requires", () => {
  test("requires points at NON-EXISTENT knob id → throws (active.has check is the gate)", () => {
    expect(() => validateKnobs(valuesOf("a"), knobsOf(mk("a", { requires: ["ghost"] })))).toThrow(
      KnobMissingRequiredError,
    )
  })

  test("conflicts points at NON-EXISTENT knob id → safe (not in active set)", () => {
    expect(() =>
      validateKnobs(valuesOf("a"), knobsOf(mk("a", { conflicts: ["ghost"] }))),
    ).not.toThrow()
  })

  test("active id not in knob map (orphan value) is skipped without throw", () => {
    expect(() => validateKnobs(valuesOf("ghost"), knobsOf(mk("a")))).not.toThrow()
  })
})

describe("hellgate / validate — large conflict + requires graphs", () => {
  test("star pattern: hub conflicts with 50 spokes, all active → 50 pairs", () => {
    const spokeIds = Array.from({ length: 50 }, (_, i) => `s-${i}`)
    const hub = mk("hub", { conflicts: spokeIds })
    const spokes = spokeIds.map((id) => mk(id))
    let err: KnobConflictError | undefined
    try {
      validateKnobs(valuesOf("hub", ...spokeIds), knobsOf(hub, ...spokes))
    } catch (e) {
      err = e as KnobConflictError
    }
    expect(err).toBeDefined()
    expect(err?.conflicts.length).toBe(50)
  })

  test("100 mutual conflicts deduped (full mesh emits N choose 2 unique pairs)", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `m-${i}`)
    const knobs = ids.map((id) => mk(id, { conflicts: ids.filter((x) => x !== id) }))
    let err: KnobConflictError | undefined
    try {
      validateKnobs(valuesOf(...ids), knobsOf(...knobs))
    } catch (e) {
      err = e as KnobConflictError
    }
    expect(err).toBeDefined()
    // 10 choose 2 = 45
    expect(err?.conflicts.length).toBe(45)
  })

  test("100 active knobs with no conflicts/requires resolves quickly", () => {
    const ids = Array.from({ length: 100 }, (_, i) => `n-${i}`)
    const knobs = ids.map((id) => mk(id))
    const t = performance.now()
    expect(() => validateKnobs(valuesOf(...ids), knobsOf(...knobs))).not.toThrow()
    expect(performance.now() - t).toBeLessThan(20)
  })
})

describe("hellgate / validate — error message + payload integrity", () => {
  test("KnobConflictError.conflicts is a non-empty readonly array", () => {
    try {
      validateKnobs(
        valuesOf("a", "b"),
        knobsOf(mk("a", { conflicts: ["b"] }), mk("b", { conflicts: ["a"] })),
      )
    } catch (e) {
      const err = e as KnobConflictError
      expect(Array.isArray(err.conflicts)).toBe(true)
      expect(err.conflicts.length).toBeGreaterThan(0)
      expect(err.message).toMatch(/conflicts/)
    }
  })

  test("KnobMissingRequiredError exposes knobId + missingRequired", () => {
    try {
      validateKnobs(valuesOf("a"), knobsOf(mk("a", { requires: ["needed"] })))
    } catch (e) {
      const err = e as KnobMissingRequiredError
      expect(err.knobId).toBe("a")
      expect(err.missingRequired).toBe("needed")
      expect(err.message).toContain("needed")
    }
  })

  test("conflict error contains both ids in message", () => {
    try {
      validateKnobs(
        valuesOf("alpha", "beta"),
        knobsOf(mk("alpha", { conflicts: ["beta"] }), mk("beta")),
      )
    } catch (e) {
      expect((e as Error).message).toContain("alpha")
      expect((e as Error).message).toContain("beta")
    }
  })
})

describe("hellgate / validate — degenerate inputs", () => {
  test("empty values + empty knobs → no throw", () => {
    expect(() => validateKnobs(new Map(), new Map())).not.toThrow()
  })

  test("empty values + non-empty knobs → no throw (no active set)", () => {
    expect(() => validateKnobs(new Map(), knobsOf(mk("a", { requires: ["b"] })))).not.toThrow()
  })

  test("knob with conflicts=[] is a no-op", () => {
    expect(() =>
      validateKnobs(valuesOf("a", "b"), knobsOf(mk("a", { conflicts: [] }), mk("b"))),
    ).not.toThrow()
  })

  test("knob with requires=[] is a no-op", () => {
    expect(() => validateKnobs(valuesOf("a"), knobsOf(mk("a", { requires: [] })))).not.toThrow()
  })

  test("knob with BOTH conflicts and requires populated still validates each axis", () => {
    expect(() =>
      validateKnobs(
        valuesOf("a", "b"),
        knobsOf(mk("a", { requires: ["b"], conflicts: ["c"] }), mk("b"), mk("c")),
      ),
    ).not.toThrow()
  })

  test("a knob with duplicate ids in its conflicts array still dedups", () => {
    let err: KnobConflictError | undefined
    try {
      validateKnobs(valuesOf("a", "b"), knobsOf(mk("a", { conflicts: ["b", "b", "b"] }), mk("b")))
    } catch (e) {
      err = e as KnobConflictError
    }
    expect(err).toBeDefined()
    // Even with redundant declarations, the seen-set dedups by sorted pair.
    expect(err?.conflicts.length).toBe(1)
  })
})

describe("hellgate / validate — order independence", () => {
  test("requires checked BEFORE conflicts (both present)", () => {
    // Pinned by existing test in validate.test.ts but re-asserted under
    // a different topology to lock in ordering. requires win.
    expect(() =>
      validateKnobs(
        valuesOf("a", "b"),
        knobsOf(mk("a", { requires: ["nope"], conflicts: ["b"] }), mk("b")),
      ),
    ).toThrow(KnobMissingRequiredError)
  })

  test("requires thrown is deterministic on iteration order", () => {
    // We don't promise WHICH requires throws first when multiple are missing,
    // but we do promise it's the same on repeated runs.
    const setup = () =>
      knobsOf(
        mk("a", { requires: ["mx"] }),
        mk("b", { requires: ["my"] }),
        mk("c", { requires: ["mz"] }),
      )
    const errs: string[] = []
    for (let i = 0; i < 3; i++) {
      try {
        validateKnobs(valuesOf("a", "b", "c"), setup())
      } catch (e) {
        errs.push((e as KnobMissingRequiredError).knobId)
      }
    }
    expect(errs.length).toBe(3)
    // All three runs throw the SAME knob id first.
    expect(new Set(errs).size).toBe(1)
  })
})
