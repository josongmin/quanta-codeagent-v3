/**
 * Hellgate — adversarial inputs for every individual knob's `parse`.
 *
 * Each knob's `parse` is a CLOSED PORT — it receives a raw string (or
 * undefined) and returns a typed value or undefined. The contract is:
 *
 *   - Garbage / empty / whitespace / unicode / oversized inputs ⇒ undefined.
 *   - Out-of-range numeric inputs ⇒ undefined.
 *   - Strictly enumerated knobs ⇒ undefined for unknown alternatives.
 *   - Boolean-truthy knobs ⇒ undefined for anything outside the closed set.
 *
 * No parser may THROW on adversarial input (other than test fixtures that
 * deliberately wrap to assert KnobParseError) — that would break the resolver's
 * fall-through.
 */
import { describe, expect, test } from "bun:test"
import { benchInLoopExecKnob } from "@/runner/knobs/knobs/bench-in-loop-exec"
import { branchSearchKnob } from "@/runner/knobs/knobs/branch-search"
import { closeoutGuardKnob } from "@/runner/knobs/knobs/closeout-guard"
import { hooksKnob } from "@/runner/knobs/knobs/hooks"
import { issueHintKnob } from "@/runner/knobs/knobs/issue-hint"
import { localizePhaseKnob } from "@/runner/knobs/knobs/localize-phase"
import { lspKnob } from "@/runner/knobs/knobs/lsp"
import { mustPassKnob } from "@/runner/knobs/knobs/must-pass"
import { patchBudgetStrictKnob } from "@/runner/knobs/knobs/patch-budget-strict"
import { personaKnob } from "@/runner/knobs/knobs/persona"
import { reproDoubtKnob } from "@/runner/knobs/knobs/repro-doubt"
import { reproTestKnob } from "@/runner/knobs/knobs/repro-test"
import { selectorModeKnob } from "@/runner/knobs/knobs/selector-mode"
import { skillsKnob } from "@/runner/knobs/knobs/skills"
import { subagentKnob } from "@/runner/knobs/knobs/subagent"
import { verifySelectKnob } from "@/runner/knobs/knobs/verify-select"
import { verifySelectConcurrencyKnob } from "@/runner/knobs/knobs/verify-select-concurrency"
import { verifySelectCounterfactualKnob } from "@/runner/knobs/knobs/verify-select-counterfactual"
import { verifySelectEarlyAcceptKnob } from "@/runner/knobs/knobs/verify-select-early-accept"
import { verifySelectLlmRiskGateKnob } from "@/runner/knobs/knobs/verify-select-llm-risk-gate"
import { verifySelectRegressionKnob } from "@/runner/knobs/knobs/verify-select-regression"
import { verifySelectReproKnob } from "@/runner/knobs/knobs/verify-select-repro"
import { verifySelectRiskGateKnob } from "@/runner/knobs/knobs/verify-select-risk-gate"
import { workingStateKnob } from "@/runner/knobs/knobs/working-state"

/** Set of adversarial raw strings every parser should reject. */
const UNIVERSAL_GARBAGE = [
  "",
  " ",
  "\t",
  "\n",
  "  \t\n",
  "garbage",
  "0\0",
  "1\n",
  "TRUE", // wrong case for strict truthy knobs
  "True",
  "yes",
  "YES",
  "Y",
  "y",
  "enable",
  "enabled",
  "off-but-also-on",
  "1; rm -rf /",
  "\x00",
  "\\",
  "💥",
  "héllo",
  "1abc",
  "0xff",
  "1e3", // scientific notation — explicit closed-port rejects
] as const

const OVERSIZED = "x".repeat(10_000)

describe("hellgate / parsers — universal garbage rejection (no parser throws or crashes)", () => {
  const knobs = [
    ["lsp", lspKnob],
    ["subagent", subagentKnob],
    ["skills", skillsKnob],
    ["localize-phase", localizePhaseKnob],
    ["branch-search", branchSearchKnob],
    ["bench-in-loop-exec", benchInLoopExecKnob],
    ["issue-hint", issueHintKnob],
    ["repro-doubt", reproDoubtKnob],
    ["repro-test", reproTestKnob],
    ["must-pass", mustPassKnob],
    ["patch-budget-strict", patchBudgetStrictKnob],
    ["persona", personaKnob],
    ["working-state", workingStateKnob],
    ["closeout-guard", closeoutGuardKnob],
    ["hooks", hooksKnob],
    ["verify-select", verifySelectKnob],
    ["verify-select-concurrency", verifySelectConcurrencyKnob],
    ["verify-select-counterfactual", verifySelectCounterfactualKnob],
    ["verify-select-early-accept", verifySelectEarlyAcceptKnob],
    ["verify-select-llm-risk-gate", verifySelectLlmRiskGateKnob],
    ["selector-mode", selectorModeKnob],
    ["verify-select-regression", verifySelectRegressionKnob],
    ["verify-select-repro", verifySelectReproKnob],
    ["verify-select-risk-gate", verifySelectRiskGateKnob],
  ] as const

  for (const [id, knob] of knobs) {
    test(`${id}.parse — empty string returns undefined`, () => {
      expect(knob.parse("")).toBeUndefined()
    })
    test(`${id}.parse — undefined returns undefined`, () => {
      expect(knob.parse(undefined)).toBeUndefined()
    })
    test(`${id}.parse — 10k-char garbage returns undefined`, () => {
      expect(() => knob.parse(OVERSIZED)).not.toThrow()
      expect(knob.parse(OVERSIZED)).toBeUndefined()
    })
    test(`${id}.parse — emoji + unicode garbage returns undefined or value (no throw)`, () => {
      expect(() => knob.parse("💥🚀")).not.toThrow()
      expect(() => knob.parse("\x00")).not.toThrow()
    })
    test(`${id}.parse — does not throw on any universal-garbage value`, () => {
      for (const v of UNIVERSAL_GARBAGE) {
        expect(() => knob.parse(v)).not.toThrow()
      }
    })
  }
})

describe("patch-budget-strict — closed truthy bool", () => {
  test("accepted truthy forms parse to true", () => {
    expect(patchBudgetStrictKnob.parse("1")).toBe(true)
    expect(patchBudgetStrictKnob.parse("on")).toBe(true)
    expect(patchBudgetStrictKnob.parse("true")).toBe(true)
  })

  test("false/garbage forms stay undefined", () => {
    expect(patchBudgetStrictKnob.parse("0")).toBeUndefined()
    expect(patchBudgetStrictKnob.parse("off")).toBeUndefined()
    expect(patchBudgetStrictKnob.parse("false")).toBeUndefined()
    expect(patchBudgetStrictKnob.parse("TRUE")).toBeUndefined()
  })
})

describe("verify-select — domain bounds [1,8] integer", () => {
  test("in-range integers parse to the number", () => {
    expect(verifySelectKnob.parse("1")).toBe(1)
    expect(verifySelectKnob.parse("5")).toBe(5)
    expect(verifySelectKnob.parse("8")).toBe(8)
  })
  test("out-of-range / non-integer / non-numeric ⇒ undefined", () => {
    expect(verifySelectKnob.parse("0")).toBeUndefined() // below min
    expect(verifySelectKnob.parse("9")).toBeUndefined() // above max
    expect(verifySelectKnob.parse("-1")).toBeUndefined()
    expect(verifySelectKnob.parse("2.5")).toBeUndefined() // non-integer
    expect(verifySelectKnob.parse("abc")).toBeUndefined()
  })
})

describe("verify-select-early-accept — closed truthy bool", () => {
  test("accepted truthy forms parse to true", () => {
    expect(verifySelectEarlyAcceptKnob.parse("1")).toBe(true)
    expect(verifySelectEarlyAcceptKnob.parse("on")).toBe(true)
    expect(verifySelectEarlyAcceptKnob.parse("true")).toBe(true)
  })

  test("false/garbage forms stay undefined", () => {
    expect(verifySelectEarlyAcceptKnob.parse("0")).toBeUndefined()
    expect(verifySelectEarlyAcceptKnob.parse("off")).toBeUndefined()
    expect(verifySelectEarlyAcceptKnob.parse("false")).toBeUndefined()
    expect(verifySelectEarlyAcceptKnob.parse("TRUE")).toBeUndefined()
  })
})

describe("verify-select-risk-gate — closed truthy bool", () => {
  test("accepted truthy forms parse to true", () => {
    expect(verifySelectRiskGateKnob.parse("1")).toBe(true)
    expect(verifySelectRiskGateKnob.parse("on")).toBe(true)
    expect(verifySelectRiskGateKnob.parse("true")).toBe(true)
  })

  test("false/garbage forms stay undefined", () => {
    expect(verifySelectRiskGateKnob.parse("0")).toBeUndefined()
    expect(verifySelectRiskGateKnob.parse("off")).toBeUndefined()
    expect(verifySelectRiskGateKnob.parse("false")).toBeUndefined()
    expect(verifySelectRiskGateKnob.parse("TRUE")).toBeUndefined()
  })
})

describe("verify-select-counterfactual — closed truthy/falsy bool", () => {
  test("accepted truthy forms parse to true", () => {
    expect(verifySelectCounterfactualKnob.parse("1")).toBe(true)
    expect(verifySelectCounterfactualKnob.parse("on")).toBe(true)
    expect(verifySelectCounterfactualKnob.parse("true")).toBe(true)
  })

  test("accepted falsy forms parse to false (explicit, not fall-through)", () => {
    expect(verifySelectCounterfactualKnob.parse("0")).toBe(false)
    expect(verifySelectCounterfactualKnob.parse("off")).toBe(false)
    expect(verifySelectCounterfactualKnob.parse("false")).toBe(false)
  })

  test("undefined / empty / garbage / case-variants stay undefined", () => {
    expect(verifySelectCounterfactualKnob.parse(undefined)).toBeUndefined()
    expect(verifySelectCounterfactualKnob.parse("")).toBeUndefined()
    expect(verifySelectCounterfactualKnob.parse("TRUE")).toBeUndefined()
    expect(verifySelectCounterfactualKnob.parse("On")).toBeUndefined()
    expect(verifySelectCounterfactualKnob.parse("yes")).toBeUndefined()
    expect(verifySelectCounterfactualKnob.parse("counterfactual")).toBeUndefined()
  })
})

describe("verify-select-llm-risk-gate — closed mode enum", () => {
  test("accepted modes normalize to canonical values", () => {
    expect(verifySelectLlmRiskGateKnob.parse("shadow")).toBe("shadow")
    expect(verifySelectLlmRiskGateKnob.parse("on")).toBe("on")
    expect(verifySelectLlmRiskGateKnob.parse("1")).toBe("on")
    expect(verifySelectLlmRiskGateKnob.parse("true")).toBe("on")
  })

  test("false/garbage forms stay undefined", () => {
    expect(verifySelectLlmRiskGateKnob.parse("0")).toBeUndefined()
    expect(verifySelectLlmRiskGateKnob.parse("off")).toBeUndefined()
    expect(verifySelectLlmRiskGateKnob.parse("false")).toBeUndefined()
    expect(verifySelectLlmRiskGateKnob.parse("critic")).toBeUndefined()
  })
})

describe("selector-mode — closed mode enum", () => {
  test("accepted modes normalize to canonical values", () => {
    expect(selectorModeKnob.parse("clean")).toBe("clean")
    expect(selectorModeKnob.parse("research")).toBe("research")
  })

  test("garbage / truthy / case-variant forms stay undefined", () => {
    expect(selectorModeKnob.parse("0")).toBeUndefined()
    expect(selectorModeKnob.parse("1")).toBeUndefined()
    expect(selectorModeKnob.parse("on")).toBeUndefined()
    expect(selectorModeKnob.parse("off")).toBeUndefined()
    expect(selectorModeKnob.parse("heuristic")).toBeUndefined()
    expect(selectorModeKnob.parse("strict")).toBeUndefined()
  })
})

describe("bench-in-loop-exec — closed mode enum", () => {
  test("accepted modes normalize to canonical values", () => {
    expect(benchInLoopExecKnob.parse("1")).toBe("full")
    expect(benchInLoopExecKnob.parse("on")).toBe("full")
    expect(benchInLoopExecKnob.parse("true")).toBe("full")
    expect(benchInLoopExecKnob.parse("full")).toBe("full")
    expect(benchInLoopExecKnob.parse("repro-only")).toBe("repro-only")
    expect(benchInLoopExecKnob.parse("repro")).toBe("repro-only")
    expect(benchInLoopExecKnob.parse("off")).toBe("off")
    expect(benchInLoopExecKnob.parse("0")).toBe("off")
    expect(benchInLoopExecKnob.parse("false")).toBe("off")
  })

  test("unknown modes reject", () => {
    expect(benchInLoopExecKnob.parse("focused")).toBeUndefined()
    expect(benchInLoopExecKnob.parse("tests-only")).toBeUndefined()
    expect(benchInLoopExecKnob.parse("suite")).toBeUndefined()
  })
})

describe("verify-select-regression — closed mode enum", () => {
  test("accepted modes normalize to canonical values", () => {
    expect(verifySelectRegressionKnob.parse("discovered")).toBe("discovered")
    expect(verifySelectRegressionKnob.parse("repo")).toBe("discovered")
    expect(verifySelectRegressionKnob.parse("native")).toBe("discovered")
    expect(verifySelectRegressionKnob.parse("gold")).toBe("gold")
    expect(verifySelectRegressionKnob.parse("pass-to-pass")).toBe("gold")
    expect(verifySelectRegressionKnob.parse("off")).toBe("off")
    expect(verifySelectRegressionKnob.parse("0")).toBe("off")
    expect(verifySelectRegressionKnob.parse("false")).toBe("off")
  })

  test("unknown modes reject", () => {
    expect(verifySelectRegressionKnob.parse("oracle")).toBeUndefined()
    expect(verifySelectRegressionKnob.parse("generated")).toBeUndefined()
    expect(verifySelectRegressionKnob.parse("hidden")).toBeUndefined()
  })
})

describe("verify-select-repro — closed mode enum", () => {
  test("accepted modes normalize to canonical values", () => {
    expect(verifySelectReproKnob.parse("hard")).toBe("hard")
    expect(verifySelectReproKnob.parse("gate")).toBe("hard")
    expect(verifySelectReproKnob.parse("positive")).toBe("positive")
    expect(verifySelectReproKnob.parse("soft")).toBe("positive")
    expect(verifySelectReproKnob.parse("off")).toBe("off")
    expect(verifySelectReproKnob.parse("0")).toBe("off")
    expect(verifySelectReproKnob.parse("false")).toBe("off")
  })

  test("unknown modes reject", () => {
    expect(verifySelectReproKnob.parse("oracle")).toBeUndefined()
    expect(verifySelectReproKnob.parse("generated")).toBeUndefined()
    expect(verifySelectReproKnob.parse("vote")).toBeUndefined()
  })
})

describe("hellgate / parsers — lsp explicit boolean override", () => {
  test('lsp: "1" / "on" / "true" all accept as true', () => {
    expect(lspKnob.parse("1")).toBe(true)
    expect(lspKnob.parse("on")).toBe(true)
    expect(lspKnob.parse("true")).toBe(true)
  })
  test('lsp: "0" / "off" / "false" all accept as false', () => {
    expect(lspKnob.parse("0")).toBe(false)
    expect(lspKnob.parse("off")).toBe(false)
    expect(lspKnob.parse("false")).toBe(false)
  })
  test("lsp: case variants rejected", () => {
    expect(lspKnob.parse("ON")).toBeUndefined()
    expect(lspKnob.parse("On")).toBeUndefined()
    expect(lspKnob.parse("True")).toBeUndefined()
    expect(lspKnob.parse("TRUE")).toBeUndefined()
    expect(lspKnob.parse("OFF")).toBeUndefined()
  })
  test("lsp: yes/y/enable rejected", () => {
    expect(lspKnob.parse("yes")).toBeUndefined()
    expect(lspKnob.parse("y")).toBeUndefined()
    expect(lspKnob.parse("enable")).toBeUndefined()
  })
  test("lsp: leading/trailing whitespace rejected (no trim)", () => {
    expect(lspKnob.parse(" 1")).toBeUndefined()
    expect(lspKnob.parse("1 ")).toBeUndefined()
    expect(lspKnob.parse(" off")).toBeUndefined()
  })
})

describe("hellgate / parsers — strict truthy knobs (subagent/skills/working-state)", () => {
  const truthyKnobs = [
    ["subagent", subagentKnob],
    ["skills", skillsKnob],
    ["working-state", workingStateKnob],
  ] as const

  for (const [id, knob] of truthyKnobs) {
    test(`${id}: "1" / "on" / "true" all accept`, () => {
      expect(knob.parse("1")).toBe(true)
      expect(knob.parse("on")).toBe(true)
      expect(knob.parse("true")).toBe(true)
    })
    test(`${id}: "0" rejects (off is fall-through, not explicit false)`, () => {
      expect(knob.parse("0")).toBeUndefined()
    })
    test(`${id}: case variants rejected`, () => {
      expect(knob.parse("ON")).toBeUndefined()
      expect(knob.parse("On")).toBeUndefined()
      expect(knob.parse("True")).toBeUndefined()
      expect(knob.parse("TRUE")).toBeUndefined()
    })
    test(`${id}: yes/y/enable rejected`, () => {
      expect(knob.parse("yes")).toBeUndefined()
      expect(knob.parse("y")).toBeUndefined()
      expect(knob.parse("enable")).toBeUndefined()
    })
    test(`${id}: leading/trailing whitespace rejected (no trim)`, () => {
      expect(knob.parse(" 1")).toBeUndefined()
      expect(knob.parse("1 ")).toBeUndefined()
      expect(knob.parse(" on")).toBeUndefined()
    })
  }
})

describe("hellgate / parsers — branch-search numeric domain", () => {
  test("K in [2..8] accepted", () => {
    for (let k = 2; k <= 8; k++) {
      expect(branchSearchKnob.parse(String(k))?.defaultN).toBe(k)
    }
  })
  test("K=0 / 1 / -1 / -100 rejected", () => {
    expect(branchSearchKnob.parse("0")).toBeUndefined()
    expect(branchSearchKnob.parse("1")).toBeUndefined()
    expect(branchSearchKnob.parse("-1")).toBeUndefined()
    expect(branchSearchKnob.parse("-100")).toBeUndefined()
  })
  test("K=9..100 rejected (max=8)", () => {
    expect(branchSearchKnob.parse("9")).toBeUndefined()
    expect(branchSearchKnob.parse("100")).toBeUndefined()
    expect(branchSearchKnob.parse("1000000")).toBeUndefined()
  })
  test("Decimal / scientific / hex / NaN / Infinity rejected", () => {
    expect(branchSearchKnob.parse("2.5")).toBeUndefined()
    expect(branchSearchKnob.parse("2.0")).toBeUndefined()
    expect(branchSearchKnob.parse("2e0")).toBeUndefined()
    expect(branchSearchKnob.parse("0x2")).toBeUndefined()
    expect(branchSearchKnob.parse("NaN")).toBeUndefined()
    expect(branchSearchKnob.parse("Infinity")).toBeUndefined()
    expect(branchSearchKnob.parse("-Infinity")).toBeUndefined()
  })
  test("Partial-parse foot-gun: '2abc' is rejected (no parseInt prefix swallow)", () => {
    expect(branchSearchKnob.parse("2abc")).toBeUndefined()
    expect(branchSearchKnob.parse("abc2")).toBeUndefined()
  })
  test("Leading/trailing whitespace is TRIMMED then re-validated (branch-search ONLY)", () => {
    // Document the intentional asymmetry vs `localize-phase` (no trim): the
    // branch-search parser explicitly `raw.trim()`s before checking. Confirm
    // both that valid numbers survive trim and invalid ones still fail.
    expect(branchSearchKnob.parse("2 ")?.defaultN).toBe(2)
    expect(branchSearchKnob.parse(" 2")?.defaultN).toBe(2)
    expect(branchSearchKnob.parse(" 2\n")?.defaultN).toBe(2)
  })
  test("Internal whitespace rejected (between digits)", () => {
    expect(branchSearchKnob.parse("1 2")).toBeUndefined()
  })
  test("Trim-then-empty rejected", () => {
    expect(branchSearchKnob.parse("   ")).toBeUndefined()
    expect(branchSearchKnob.parse("\t\n")).toBeUndefined()
  })
})

describe("hellgate / parsers — repro-test numeric domain [1..40]", () => {
  test("K=1 accepted (min)", () => {
    expect(reproTestKnob.parse("1")?.samples).toBe(1)
  })
  test("K=40 accepted (max)", () => {
    expect(reproTestKnob.parse("40")?.samples).toBe(40)
  })
  test("K=0 rejected", () => {
    expect(reproTestKnob.parse("0")).toBeUndefined()
  })
  test("K=41 rejected (paper cap)", () => {
    expect(reproTestKnob.parse("41")).toBeUndefined()
    expect(reproTestKnob.parse("100")).toBeUndefined()
  })
  test("Negatives + NaN + Infinity + decimal rejected", () => {
    expect(reproTestKnob.parse("-1")).toBeUndefined()
    expect(reproTestKnob.parse("NaN")).toBeUndefined()
    expect(reproTestKnob.parse("Infinity")).toBeUndefined()
    expect(reproTestKnob.parse("5.5")).toBeUndefined()
  })
})

describe("hellgate / parsers — localize-phase numeric domain [1..20]", () => {
  test("N=0 accepted as explicit OFF sentinel", () => {
    expect(localizePhaseKnob.parse("0")?.phase1Turns).toBe(0)
  })
  test("N=1 accepted (min)", () => {
    expect(localizePhaseKnob.parse("1")?.phase1Turns).toBe(1)
  })
  test("N=20 accepted (max)", () => {
    expect(localizePhaseKnob.parse("20")?.phase1Turns).toBe(20)
  })
  test("negative rejected", () => {
    expect(localizePhaseKnob.parse("-1")).toBeUndefined()
  })
  test("N=21+ rejected (measurement cap)", () => {
    expect(localizePhaseKnob.parse("21")).toBeUndefined()
    expect(localizePhaseKnob.parse("100")).toBeUndefined()
  })
  test("Decimal / NaN / Infinity rejected", () => {
    expect(localizePhaseKnob.parse("1.5")).toBeUndefined()
    expect(localizePhaseKnob.parse("NaN")).toBeUndefined()
    expect(localizePhaseKnob.parse("Infinity")).toBeUndefined()
  })
  test("'1abc' / 'abc1' rejected (no parseInt foot-gun)", () => {
    expect(localizePhaseKnob.parse("1abc")).toBeUndefined()
    expect(localizePhaseKnob.parse("abc1")).toBeUndefined()
  })
})

describe("hellgate / parsers — issue-hint enum", () => {
  test("'agentless' / '1' / 'on' accepted", () => {
    expect(issueHintKnob.parse("agentless")).toBe("agentless")
    expect(issueHintKnob.parse("1")).toBe("regex")
    expect(issueHintKnob.parse("on")).toBe("regex")
  })
  test("'true' rejected (closed set excludes generic truthy)", () => {
    expect(issueHintKnob.parse("true")).toBeUndefined()
  })
  test("'regex' literal rejected (only '1'/'on' map to regex)", () => {
    expect(issueHintKnob.parse("regex")).toBeUndefined()
  })
  test("'off' / '0' / case variants rejected", () => {
    expect(issueHintKnob.parse("off")).toBeUndefined()
    expect(issueHintKnob.parse("0")).toBeUndefined()
    expect(issueHintKnob.parse("AGENTLESS")).toBeUndefined()
    expect(issueHintKnob.parse("Agentless")).toBeUndefined()
  })
  test("'agentless ' with trailing space rejected (no trim)", () => {
    expect(issueHintKnob.parse("agentless ")).toBeUndefined()
    expect(issueHintKnob.parse(" agentless")).toBeUndefined()
  })
})

describe("hellgate / parsers — persona enum", () => {
  test("default / friendly / pragmatic accepted", () => {
    expect(personaKnob.parse("default")).toBe("default")
    expect(personaKnob.parse("friendly")).toBe("friendly")
    expect(personaKnob.parse("pragmatic")).toBe("pragmatic")
  })
  test("case variants rejected", () => {
    expect(personaKnob.parse("DEFAULT")).toBeUndefined()
    expect(personaKnob.parse("Default")).toBeUndefined()
    expect(personaKnob.parse("Friendly")).toBeUndefined()
  })
  test("unknown alternatives rejected", () => {
    expect(personaKnob.parse("strict")).toBeUndefined()
    expect(personaKnob.parse("aggressive")).toBeUndefined()
    expect(personaKnob.parse("")).toBeUndefined()
  })
  test("prefixes + suffixes rejected (strict equality)", () => {
    expect(personaKnob.parse("default ")).toBeUndefined()
    expect(personaKnob.parse(" default")).toBeUndefined()
    expect(personaKnob.parse("defaultx")).toBeUndefined()
    expect(personaKnob.parse("xdefault")).toBeUndefined()
  })
  test("__proto__ as raw rejected", () => {
    expect(personaKnob.parse("__proto__")).toBeUndefined()
    expect(personaKnob.parse("constructor")).toBeUndefined()
  })
})

describe("hellgate / parsers — must-pass enum + numeric subset", () => {
  test("'off' → mustPass false", () => {
    expect(mustPassKnob.parse("off")).toEqual({ mustPass: false })
  })
  test("'1' / 'on' / 'strict' / '2' all map to mustPass:true maxTrips:2", () => {
    expect(mustPassKnob.parse("1")).toEqual({ mustPass: true, maxTrips: 2 })
    expect(mustPassKnob.parse("on")).toEqual({ mustPass: true, maxTrips: 2 })
    expect(mustPassKnob.parse("strict")).toEqual({ mustPass: true, maxTrips: 2 })
    expect(mustPassKnob.parse("2")).toEqual({ mustPass: true, maxTrips: 2 })
  })
  test("'3' → maxTrips:3", () => {
    expect(mustPassKnob.parse("3")).toEqual({ mustPass: true, maxTrips: 3 })
  })
  test("'4' / '5' / negative / huge rejected", () => {
    expect(mustPassKnob.parse("4")).toBeUndefined()
    expect(mustPassKnob.parse("5")).toBeUndefined()
    expect(mustPassKnob.parse("100")).toBeUndefined()
    expect(mustPassKnob.parse("-1")).toBeUndefined()
  })
  test("'true' / 'yes' / 'OFF' rejected (strict allow-list)", () => {
    expect(mustPassKnob.parse("true")).toBeUndefined()
    expect(mustPassKnob.parse("yes")).toBeUndefined()
    expect(mustPassKnob.parse("OFF")).toBeUndefined()
    expect(mustPassKnob.parse("Off")).toBeUndefined()
  })
  test("'lenient' / 'soft' rejected (not in the closed enum)", () => {
    expect(mustPassKnob.parse("lenient")).toBeUndefined()
    expect(mustPassKnob.parse("soft")).toBeUndefined()
  })
})

describe("hellgate / parsers — closeout-guard truthy + 4rule variant", () => {
  test("'1' / 'on' / 'true' → enable plain", () => {
    expect(closeoutGuardKnob.parse("1")).toEqual({ fourRule: false })
    expect(closeoutGuardKnob.parse("on")).toEqual({ fourRule: false })
    expect(closeoutGuardKnob.parse("true")).toEqual({ fourRule: false })
  })
  test("'4rule' → enable + fourRule:true", () => {
    expect(closeoutGuardKnob.parse("4rule")).toEqual({ fourRule: true })
  })
  test("Case + spacing variants rejected", () => {
    expect(closeoutGuardKnob.parse("4Rule")).toBeUndefined()
    expect(closeoutGuardKnob.parse("4RULE")).toBeUndefined()
    expect(closeoutGuardKnob.parse(" 4rule")).toBeUndefined()
  })
  test("'0' / 'off' / garbage rejected", () => {
    expect(closeoutGuardKnob.parse("0")).toBeUndefined()
    expect(closeoutGuardKnob.parse("off")).toBeUndefined()
    expect(closeoutGuardKnob.parse("yes")).toBeUndefined()
  })
})

describe("hellgate / parsers — hooks truthy (strict to '1'|'on' only)", () => {
  test("'1' / 'on' accept", () => {
    expect(hooksKnob.parse("1")).toBe(true)
    expect(hooksKnob.parse("on")).toBe(true)
  })
  test("'true' REJECTED (deliberately stricter than other truthy knobs)", () => {
    expect(hooksKnob.parse("true")).toBeUndefined()
  })
  test("'0' / 'off' / 'yes' / 'enable' rejected", () => {
    expect(hooksKnob.parse("0")).toBeUndefined()
    expect(hooksKnob.parse("off")).toBeUndefined()
    expect(hooksKnob.parse("yes")).toBeUndefined()
    expect(hooksKnob.parse("enable")).toBeUndefined()
  })
})

describe("hellgate / parsers — prototype-pollution raw values", () => {
  const allKnobs = [
    lspKnob,
    subagentKnob,
    skillsKnob,
    localizePhaseKnob,
    branchSearchKnob,
    issueHintKnob,
    reproTestKnob,
    mustPassKnob,
    personaKnob,
    workingStateKnob,
    closeoutGuardKnob,
    hooksKnob,
  ] as const

  test("'__proto__' literal as raw never yields a value", () => {
    for (const k of allKnobs) {
      expect(k.parse("__proto__")).toBeUndefined()
    }
  })
  test("'constructor' / 'prototype' literals as raw never yield a value", () => {
    for (const k of allKnobs) {
      expect(k.parse("constructor")).toBeUndefined()
      expect(k.parse("prototype")).toBeUndefined()
    }
  })
  test("JSON-injection raw `'{\"a\":1}'` never parses on numeric/enum knobs", () => {
    for (const k of [
      branchSearchKnob,
      reproTestKnob,
      localizePhaseKnob,
      issueHintKnob,
      personaKnob,
      mustPassKnob,
      closeoutGuardKnob,
    ]) {
      expect(k.parse('{"a":1}')).toBeUndefined()
    }
  })
})
