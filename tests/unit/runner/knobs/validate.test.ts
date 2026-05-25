/**
 * `validateKnobs` — relationship checks (conflicts / requires).
 *
 * The resolver calls this internally; we exercise it directly here so we
 * can drive curated active-knob sets without orchestrating layer inputs.
 */
import { describe, expect, test } from "bun:test"
import {
  type AnyKnob,
  type Knob,
  KnobConflictError,
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

describe("validateKnobs — conflicts", () => {
  test("no conflicts → no throw", () => {
    expect(() => validateKnobs(valuesOf("a"), knobsOf(mk("a")))).not.toThrow()
  })

  test("two active knobs in mutual conflict throw", () => {
    expect(() =>
      validateKnobs(
        valuesOf("a", "b"),
        knobsOf(mk("a", { conflicts: ["b"] }), mk("b", { conflicts: ["a"] })),
      ),
    ).toThrow(KnobConflictError)
  })

  test("one-sided conflict still fires", () => {
    expect(() =>
      validateKnobs(valuesOf("a", "b"), knobsOf(mk("a", { conflicts: ["b"] }), mk("b"))),
    ).toThrow(KnobConflictError)
  })

  test("conflict with inactive knob is fine", () => {
    expect(() =>
      validateKnobs(valuesOf("a"), knobsOf(mk("a", { conflicts: ["b"] }), mk("b"))),
    ).not.toThrow()
  })

  test("conflict pairs deduped (a↔b reported once)", () => {
    let err: KnobConflictError | undefined
    try {
      validateKnobs(
        valuesOf("a", "b"),
        knobsOf(mk("a", { conflicts: ["b"] }), mk("b", { conflicts: ["a"] })),
      )
    } catch (e) {
      err = e as KnobConflictError
    }
    expect(err).toBeDefined()
    expect(err?.conflicts.length).toBe(1)
  })

  test("transitive A↔B, B↔C with A+C active is fine", () => {
    // A conflicts with B; B conflicts with C. Only A and C are active.
    // We DO NOT chain through B — A and C have no direct conflict declared.
    expect(() =>
      validateKnobs(
        valuesOf("a", "c"),
        knobsOf(
          mk("a", { conflicts: ["b"] }),
          mk("b", { conflicts: ["a", "c"] }),
          mk("c", { conflicts: ["b"] }),
        ),
      ),
    ).not.toThrow()
  })
})

describe("validateKnobs — requires", () => {
  test("required peer active → no throw", () => {
    expect(() =>
      validateKnobs(valuesOf("a", "b"), knobsOf(mk("a", { requires: ["b"] }), mk("b"))),
    ).not.toThrow()
  })

  test("required peer absent → throws KnobMissingRequiredError", () => {
    expect(() =>
      validateKnobs(valuesOf("a"), knobsOf(mk("a", { requires: ["b"] }), mk("b"))),
    ).toThrow(KnobMissingRequiredError)
  })

  test("error payload carries knobId + missingRequired", () => {
    try {
      validateKnobs(valuesOf("a"), knobsOf(mk("a", { requires: ["b"] }), mk("b")))
      expect(true).toBe(false)
    } catch (e) {
      const err = e as KnobMissingRequiredError
      expect(err.knobId).toBe("a")
      expect(err.missingRequired).toBe("b")
    }
  })

  test("requires checked before conflicts (requires throws first)", () => {
    // Both a missing-required AND a conflict are present; requires wins.
    expect(() =>
      validateKnobs(
        valuesOf("a", "b"),
        knobsOf(mk("a", { requires: ["missing"], conflicts: ["b"] }), mk("b"), mk("missing")),
      ),
    ).toThrow(KnobMissingRequiredError)
  })

  test("circular requires (A↔B) with BOTH active is satisfied", () => {
    expect(() =>
      validateKnobs(
        valuesOf("a", "b"),
        knobsOf(mk("a", { requires: ["b"] }), mk("b", { requires: ["a"] })),
      ),
    ).not.toThrow()
  })

  test("circular requires (A↔B) with only A active throws", () => {
    expect(() =>
      validateKnobs(
        valuesOf("a"),
        knobsOf(mk("a", { requires: ["b"] }), mk("b", { requires: ["a"] })),
      ),
    ).toThrow(KnobMissingRequiredError)
  })
})

describe("validateKnobs — degenerate", () => {
  test("empty values → no throw", () => {
    expect(() => validateKnobs(new Map(), knobsOf(mk("a")))).not.toThrow()
  })

  test("active id unknown in knobs map is skipped", () => {
    expect(() => validateKnobs(valuesOf("ghost"), knobsOf(mk("a")))).not.toThrow()
  })

  test("knob with empty conflicts/requires arrays is no-op", () => {
    expect(() =>
      validateKnobs(valuesOf("a"), knobsOf(mk("a", { conflicts: [], requires: [] }))),
    ).not.toThrow()
  })
})
