/**
 * ★ CONTRACT — `agentless-v6-oracle` preset (jun-29 synthesis-convergence lever).
 *
 * Evidence chain (docs/analysis/competitor-study + jun-29 memory): our SWE gap,
 * with measurement bugs removed, is SYNTHESIS CONVERGENCE — the agent emits a
 * plausible-but-wrong patch (under-edit / wrong-predicate) and, in single-pass
 * n=1, has NO execution feedback to learn it's wrong. The fix is the fail-to-pass
 * ORACLE LOOP, which ALREADY EXISTS+WIRED (repair/index.ts, gated by
 * `closure-repair`). The jun-28 `agentless-v6-closure-tuned` preset already bundles
 * the loop (`closure-repair`) + a round-0 false-green guard (`repair-spec-gate`).
 *
 * The adversarial audit of the Phase-0 plan found the ONE missing piece: the
 * validator re-runs the AGENT'S OWN repro (validator.ts:4-7 — deliberately NOT the
 * official FAIL_TO_PASS, which would be answer-key gaming), so the oracle's signal
 * quality is CAPPED by repro quality (~45% historical repro failure, jun-20). Thus
 * `repro-grounding` (the jun-29 co-lever that grounds repro generation) is a
 * PREREQUISITE, not an independent knob: a better repro → a real oracle signal.
 *
 * `agentless-v6-oracle` = `agentless-v6-closure-tuned` + `repro-grounding`. It is an
 * OPT-IN measurement arm (never a promoted default); the v6 winner and closure-tuned
 * stay byte-identical. The parity proof (preset-spec-parity-all) auto-covers the
 * spec⇄literal equality; this file pins the SEMANTIC composition.
 */
import { describe, expect, test } from "bun:test"
import { PRESET_SPECS } from "@/runner/batch/eval/kernel/preset-specs"
import { KNOB_PRESETS } from "@/runner/knobs/presets"

const ORACLE = "agentless-v6-oracle"
const TUNED = "agentless-v6-closure-tuned"
const V6 = "agentless-v6-singlepass-execfull"

describe("agentless-v6-oracle — the synthesis-convergence lever preset", () => {
  test("is registered as a PresetSpec", () => {
    expect(PRESET_SPECS[ORACLE]).toBeDefined()
    expect(PRESET_SPECS[ORACLE]?.id).toBe(ORACLE)
  })

  test("bundles the full oracle stack: loop + false-green guard + repro-grounding", () => {
    const p = PRESET_SPECS[ORACLE]?.params ?? {}
    // the fail-to-pass oracle LOOP (multi-round repair reinjection)
    expect(p["closure-repair"]).toBe("5")
    // round-0 false-green guard (a narrow patch can't falsely clear the loop)
    expect(p["repair-spec-gate"]).toBe("1")
    // THE audit-found prerequisite: repro grounding lifts the oracle's signal
    // (the validator runs the agent's repro, not the official test)
    expect(p["repro-grounding"]).toBe("1")
  })

  test("is closure-tuned PLUS exactly one added param (repro-grounding)", () => {
    const tuned = PRESET_SPECS[TUNED]?.params ?? {}
    const oracle = PRESET_SPECS[ORACLE]?.params ?? {}
    // every tuned param is preserved verbatim
    for (const [k, v] of Object.entries(tuned)) expect(oracle[k]).toBe(v)
    // the ONLY delta is repro-grounding
    const added = Object.keys(oracle).filter((k) => !(k in tuned))
    expect(added).toEqual(["repro-grounding"])
  })

  test("steps include the repro + repair phases the oracle depends on", () => {
    const steps = PRESET_SPECS[ORACLE]?.steps ?? []
    // repro phase ⇒ reproducing scripts exist for the validator/spec-gate;
    // repair phase ⇒ the loop scaffold runs.
    expect(steps).toContain("repro")
    expect(steps).toContain("repair")
  })

  test("frozen literal (KNOB_PRESETS) carries the same oracle stack", () => {
    const lit = KNOB_PRESETS[ORACLE] ?? {}
    expect(lit["closure-repair"]).toBe("5")
    expect(lit["repair-spec-gate"]).toBe("1")
    expect(lit["repro-grounding"]).toBe("1")
  })

  test("hardened arm = oracle + repro-vote + repair-strong-oracle (PUBLIC-only)", () => {
    const HARD = "agentless-v6-oracle-hardened"
    expect(PRESET_SPECS[HARD]).toBeDefined()
    const oracle = PRESET_SPECS[ORACLE]?.params ?? {}
    const hard = PRESET_SPECS[HARD]?.params ?? {}
    // every oracle param preserved
    for (const [k, v] of Object.entries(oracle)) expect(hard[k]).toBe(v)
    // exactly the two PUBLIC-only hardening knobs added
    const added = Object.keys(hard)
      .filter((k) => !(k in oracle))
      .sort()
    expect(added).toEqual(["repair-strong-oracle", "repro-vote"])
    // frozen literal matches
    expect(KNOB_PRESETS[HARD]?.["repro-vote"]).toBe("1")
    expect(KNOB_PRESETS[HARD]?.["repair-strong-oracle"]).toBe("1")
  })

  test("v7 multifile arm = hardened oracle + structural breadth/fanout bundle", () => {
    const HARD = "agentless-v6-oracle-hardened"
    const V7 = "agentless-v7-oracle-multifile"
    expect(PRESET_SPECS[V7]).toBeDefined()
    const hard = PRESET_SPECS[HARD]?.params ?? {}
    const v7 = PRESET_SPECS[V7]?.params ?? {}
    for (const [k, v] of Object.entries(hard)) expect(v7[k]).toBe(v)
    const added = Object.keys(v7)
      .filter((k) => !(k in hard))
      .sort()
    expect(added).toEqual([
      "acceptance",
      "adversarial-repro",
      "bench-location-fanout",
      "cha-multisite-general",
      "cha-multisite-steer",
      "model-lane-diversity",
      "paired-control",
      "repair-breadth",
    ])
    expect(KNOB_PRESETS[V7]?.["repair-breadth"]).toBe("3")
    expect(KNOB_PRESETS[V7]?.["bench-location-fanout"]).toBe("1")
    expect(KNOB_PRESETS[V7]?.["paired-control"]).toBe("1")
    expect(KNOB_PRESETS[V7]?.["adversarial-repro"]).toBe("1")
  })

  test("OPT-IN: the v6 winner and closure-tuned are NOT mutated", () => {
    // v6 must stay the byte-identical jun-24 winner (no oracle params leaked in)
    const v6 = PRESET_SPECS[V6]?.params ?? {}
    expect(v6["closure-repair"]).toBeUndefined()
    expect(v6["repro-grounding"]).toBeUndefined()
    // closure-tuned must stay WITHOUT repro-grounding (the delta lives only on oracle)
    expect(PRESET_SPECS[TUNED]?.params["repro-grounding"]).toBeUndefined()
  })
})
