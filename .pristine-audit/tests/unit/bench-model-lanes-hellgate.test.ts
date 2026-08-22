/**
 * G1-live hellgate — `resolveModelLanes` / `parseModelLaneIds` (the
 * composition-root SUPPLY that fills `deps.llmLanes`). The driver-side consumer
 * (`resolveLaneLlm`) is covered separately in `model-lane-diversity-hellgate`.
 *
 * Teeth:
 *  - OFF (knob unset) ⇒ `undefined` ⇒ `deps.llmLanes` omitted ⇒ byte-identical.
 *  - A ghost lane (no credential ⇒ `buildLanePort` returns null) is DROPPED,
 *    never faked; if <2 survive the whole feature stays inert.
 *  - ON + ≥2 credentialed distinct ids ⇒ ≥2 DISTINCT ports (real diversity).
 *  Red-on-injection: each assertion flips if the drop/<2 guard is removed.
 */
import { describe, expect, test } from "bun:test"
import type { LLMPort } from "@/llm"
import { parseModelLaneIds, resolveModelLanes } from "../../src/apps/bench/model-lanes"

// Minimal distinct fake ports keyed by model id (object identity = the lane).
const fakePort = (model: string): LLMPort => ({ model }) as unknown as LLMPort
const buildAll = (model: string): LLMPort => fakePort(model)
const buildNone = (_model: string): LLMPort | null => null

describe("parseModelLaneIds", () => {
  test("OFF: unset / empty ⇒ undefined (byte-identical)", () => {
    expect(parseModelLaneIds({})).toBeUndefined()
    expect(parseModelLaneIds({ QUANTA_BENCH_MODEL_LANES: "" })).toBeUndefined()
    expect(parseModelLaneIds({ QUANTA_BENCH_MODEL_LANES: "   " })).toBeUndefined()
  })

  test("boolean-true ⇒ built-in default pair", () => {
    const ids = parseModelLaneIds({ QUANTA_BENCH_MODEL_LANES: "1" })
    expect(ids).toBeDefined()
    expect((ids ?? []).length).toBe(2)
  })

  test("explicit list ⇒ ordered, trimmed, de-duped (first-seen)", () => {
    expect(parseModelLaneIds({ QUANTA_BENCH_MODEL_LANES: "a, b ,a, c" })).toEqual(["a", "b", "c"])
  })
})

describe("resolveModelLanes", () => {
  test("OFF ⇒ undefined", () => {
    expect(resolveModelLanes({ env: {}, buildLanePort: buildAll })).toBeUndefined()
  })

  test("single id ⇒ undefined (no diversity)", () => {
    expect(
      resolveModelLanes({ env: { QUANTA_BENCH_MODEL_LANES: "only" }, buildLanePort: buildAll }),
    ).toBeUndefined()
  })

  test("≥2 distinct credentialed ids ⇒ ≥2 DISTINCT ports", () => {
    const lanes = resolveModelLanes({
      env: { QUANTA_BENCH_MODEL_LANES: "m1,m2" },
      buildLanePort: buildAll,
    })
    expect(lanes).toBeDefined()
    expect((lanes ?? []).length).toBe(2)
    expect(lanes?.[0]).not.toBe(lanes?.[1])
  })

  test("ghost lane (no credential) DROPPED; <2 survivors ⇒ undefined (not faked)", () => {
    // Both ids requested but none builds ⇒ inert, never a single faked lane.
    expect(
      resolveModelLanes({ env: { QUANTA_BENCH_MODEL_LANES: "m1,m2" }, buildLanePort: buildNone }),
    ).toBeUndefined()
    // One builds, one is a ghost ⇒ only 1 survivor ⇒ inert.
    const oneGhost = resolveModelLanes({
      env: { QUANTA_BENCH_MODEL_LANES: "real,ghost" },
      buildLanePort: (id) => (id === "real" ? fakePort("real") : null),
    })
    expect(oneGhost).toBeUndefined()
  })
})
