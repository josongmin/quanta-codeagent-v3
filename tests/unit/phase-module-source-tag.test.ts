import { describe, expect, test } from "bun:test"
import { CLEAN_SELECTOR } from "@/runner/batch/eval/posture/capability-profiles"
import { withKnobModules } from "@/runner/batch/eval/posture/knob-module"
import { resolveBenchKnobs } from "@/runner/batch/eval/knobs-bench"

// Wave-3 obligation 3: a controller-injected phase-module value is tagged
// `phase-module` (not `preset`), so the report never misattributes it to a named
// preset that did not set it.

describe("phase-module source tag (obligation 3)", () => {
  test("a module-folded value is tagged `phase-module`; a preset value stays `preset`", () => {
    const base = resolveBenchKnobs({ envVars: { QUANTA_BENCH_PRESET: "agentless-v3-thin-strict" } })
    // thin-strict sets `lsp` ⇒ source "preset"; it does NOT set `selector-mode`.
    expect(base.values.get("lsp")?.source).toBe("preset")
    expect(base.values.has("selector-mode")).toBe(false)

    const folded = withKnobModules(base, [CLEAN_SELECTOR]) // selector-mode:clean

    // the controller-injected value is tagged phase-module …
    expect(folded.values.get("selector-mode")?.source).toBe("phase-module")
    expect(folded.values.get("selector-mode")?.value).toBe("clean")
    // … and the preset-set value is untouched (paired control).
    expect(folded.values.get("lsp")?.source).toBe("preset")
  })
})
