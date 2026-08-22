import { describe, expect, test } from "bun:test"
import {
  parseDatasetFamilyOrThrow,
  resolveBenchRunConfig,
  serializeFamilyForSubprocess,
} from "./run-config"

// T2 — the ONE typed run-config resolver at the bench composition root. It parses
// the family selector (argv wins, then env) EXACTLY ONCE into a typed field, and
// splits absent-default (verified) from explicit-invalid (error). No in-process
// env mutation is used as an authority channel; env may only SERIALIZE the
// resolved family across a real subprocess/SSH boundary.

describe("resolveBenchRunConfig — typed family field, parse-once", () => {
  test("absent selector ⇒ verified (byte-identical legacy default)", () => {
    const cfg = resolveBenchRunConfig({ argvFamily: undefined, env: {} })
    expect(cfg.datasetFamily).toBe("verified")
  })

  test("argv wins over env", () => {
    const cfg = resolveBenchRunConfig({
      argvFamily: "pro",
      env: { QUANTA_SWEBENCH_DATASET_FAMILY: "live" },
    })
    expect(cfg.datasetFamily).toBe("pro")
  })

  test("env is honored when argv absent", () => {
    const cfg = resolveBenchRunConfig({
      argvFamily: undefined,
      env: { QUANTA_SWEBENCH_DATASET_FAMILY: "live" },
    })
    expect(cfg.datasetFamily).toBe("live")
  })

  test("case-insensitive explicit selector", () => {
    expect(resolveBenchRunConfig({ argvFamily: "PRO", env: {} }).datasetFamily).toBe("pro")
    expect(
      resolveBenchRunConfig({ argvFamily: undefined, env: { QUANTA_SWEBENCH_DATASET_FAMILY: "LIVE" } })
        .datasetFamily,
    ).toBe("live")
  })

  // FAIL-CLOSED: an explicit-but-unknown selector is a genuine behavior change vs
  // the old resolveDatasetFamily (which silently mapped unknown → verified). This
  // is the load-bearing split the ticket requires.
  test("explicit-invalid argv family ⇒ THROW (does NOT silently fall back to verified)", () => {
    expect(() => resolveBenchRunConfig({ argvFamily: "bogus", env: {} })).toThrow()
  })

  test("explicit-invalid env family ⇒ THROW", () => {
    expect(() =>
      resolveBenchRunConfig({ argvFamily: undefined, env: { QUANTA_SWEBENCH_DATASET_FAMILY: "nope" } }),
    ).toThrow()
  })

  test("explicit-blank argv family ⇒ THROW (blank is explicit-invalid, not absent)", () => {
    expect(() => resolveBenchRunConfig({ argvFamily: "", env: {} })).toThrow()
  })

  // Contrast to prove the split: absent (undefined/absent env) stays verified.
  test("absent argv AND absent env ⇒ verified (NOT a throw)", () => {
    expect(() => resolveBenchRunConfig({ argvFamily: undefined, env: {} })).not.toThrow()
    expect(resolveBenchRunConfig({ argvFamily: undefined, env: {} }).datasetFamily).toBe("verified")
  })

  // All three valid families flow through (no vacuous single-literal narrowing).
  test("all valid families resolve to their own value", () => {
    for (const fam of ["verified", "live", "pro"] as const) {
      expect(resolveBenchRunConfig({ argvFamily: fam, env: {} }).datasetFamily).toBe(fam)
    }
  })
})

describe("parseDatasetFamilyOrThrow — explicit-only, fail-closed", () => {
  test("valid explicit values", () => {
    expect(parseDatasetFamilyOrThrow("verified")).toBe("verified")
    expect(parseDatasetFamilyOrThrow("live")).toBe("live")
    expect(parseDatasetFamilyOrThrow("pro")).toBe("pro")
    expect(parseDatasetFamilyOrThrow("Pro")).toBe("pro")
  })
  test("unknown explicit value throws with the offending token in the message", () => {
    expect(() => parseDatasetFamilyOrThrow("bogus")).toThrow(/bogus/)
  })
  test("blank throws", () => {
    expect(() => parseDatasetFamilyOrThrow("")).toThrow()
    expect(() => parseDatasetFamilyOrThrow("   ")).toThrow()
  })
})

describe("serializeFamilyForSubprocess — boundary serializer ONLY (env write is a wire encoder)", () => {
  test("writes the resolved family into the subprocess env envelope", () => {
    const env: Record<string, string | undefined> = {}
    serializeFamilyForSubprocess("pro", env)
    expect(env.QUANTA_SWEBENCH_DATASET_FAMILY).toBe("pro")
  })
  test("round-trips through resolveBenchRunConfig on the far side", () => {
    const wire: Record<string, string | undefined> = {}
    serializeFamilyForSubprocess("live", wire)
    // The subprocess re-resolves from its inherited env (no argv on that side).
    expect(resolveBenchRunConfig({ argvFamily: undefined, env: wire }).datasetFamily).toBe("live")
  })
})
