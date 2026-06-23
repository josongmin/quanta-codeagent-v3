/**
 * Hellgate — `adversarial-repro` knob (jun-19 #10999 under-fix class, RE-PURPOSED
 * jun-23 canonical/hardening split).
 *
 * jun-19 RCA: django-10999 ended UNRESOLVED because a weak happy-path repro
 * false-GREENed an under-fix. The jun-19 lever made the repro adversarial.
 *
 * jun-23 MEASURED DEFECT: folding that over-strict "print 'Issue resolved' ONLY
 * if EVERY case behaves correctly" into the SUBMIT oracle made it a 75% gold
 * false-NEGATIVE — the canonical-correct GOLD fix could not satisfy the many
 * incidental cases, so `verify-select-proof-required` WITHHELD the correct patch
 * (django-11138 / 14315 measured: 3/4 reproducing repros stay RED on gold).
 *
 * FIX (this knob's new contract): the over-strict coverage moves to a SEPARATE
 * ADVISORY `hardening` set; the SUBMIT-gate `canonical` set keeps the plain
 * core-symptom contract so a minimal correct fix can flip it green.
 *
 * Teeth (each fails if the split is severed):
 *   1. CANONICAL (default) carries NO over-strict markers — the submit oracle is
 *      never the FN-inducing adversarial prompt (red-on-injection on the fix).
 *   2. HARDENING is a SUPERSET — every canonical line survives PLUS the block.
 *   3. HARDENING content — load-bearing adversarial directives present.
 *   4. generate() threads `kind` into the LLM message (wiring proof).
 *   5. driver `prepareReproTestDetailed`: deps.adversarial=true ⇒ generate runs
 *      for BOTH canonical AND hardening; unset ⇒ canonical-only.
 *   6. posture: QUANTA_BENCH_ADVERSARIAL_REPRO ⇒ adversarialRepro, default OFF,
 *      isolated from siblings.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import "@/runner/knobs/knobs"
import { prepareReproTestDetailed, resolveBenchKnobs } from "@/runner/batch/eval/driver"
import { type BenchPosture, benchPostureFromState } from "@/runner/batch/eval/knobs-bench"
import { __resetKnobOverrides } from "@/shared/knob-overrides"
import { buildReproTestPrompt, generateReproTests } from "../../../src/agent/repro-test/generate"
import type { LLMPort, StreamEvent, StreamInput } from "../../../src/llm"

const ISSUE = "Fix parse_duration() for some negative durations. It doesn't match negatives."

class CapturingLLM implements LLMPort {
  lastInput: StreamInput | undefined
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.lastInput = input
    yield { type: "text_delta", delta: "print('Issue reproduced')" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const userTextOf = (input: StreamInput | undefined): string => {
  const msg = input?.messages?.[0]
  const part = msg?.content?.[0]
  return part !== undefined && "text" in part ? part.text : ""
}

// The over-strict directive that induced the 75% gold false-negative (P1: now a
// pytest "every assertion must hold" demand, not a sentinel print). It MUST be
// absent from the canonical (submit-gate) prompt and present in hardening.
const OVERSTRICT = "pytest passes ONLY if EVERY assertion holds"

describe("adversarial-repro — canonical/hardening prompt split", () => {
  test("CANONICAL (default) carries NO over-strict adversarial markers (the FN fix)", () => {
    const canonical = buildReproTestPrompt(ISSUE)
    // Default kind is canonical and is byte-identical to an explicit canonical.
    expect(buildReproTestPrompt(ISSUE, undefined, "canonical")).toBe(canonical)
    expect(canonical).not.toContain("ADVERSARIAL")
    expect(canonical).not.toContain("do NOT copy")
    expect(canonical).not.toContain(OVERSTRICT)
    // ...and it POSITIVELY instructs the core-symptom-only contract so a minimal
    // correct fix can flip it green (red-on-injection on the canonical block).
    expect(canonical).toContain("CORE symptom only")
  })

  test("HARDENING is a SUPERSET — issue + pytest contract survive, plus the block", () => {
    const canonical = buildReproTestPrompt(ISSUE)
    const hardening = buildReproTestPrompt(ISSUE, undefined, "hardening")
    expect(hardening.length).toBeGreaterThan(canonical.length)
    // Hardening drops the canonical-only "CORE symptom" line (it wants MORE than
    // the core), so compare on the shared scaffold, not line-for-line.
    expect(hardening).toContain(ISSUE)
    expect(hardening).toContain("def test_")
    expect(hardening).toContain("pytest.main")
    // P1: the removed self-judged sentinel must not have leaked into hardening.
    expect(hardening).not.toContain("Issue reproduced")
    expect(hardening).not.toContain("Issue resolved")
  })

  test("HARDENING content — load-bearing adversarial directives present (red-on-injection)", () => {
    const hardening = buildReproTestPrompt(ISSUE, undefined, "hardening")
    expect(hardening).toContain("ADVERSARIAL")
    // P1: a shallow fix must leave an ASSERTION FAILING (was: still print "Issue reproduced").
    expect(hardening).toContain("at least one assertion FAILING")
    expect(hardening).toContain("rejected") // must-reject cases
    expect(hardening).toContain("boundary")
    expect(hardening).toContain(OVERSTRICT)
    expect(hardening).toMatch(/Do\s+NOT copy any fix, regex, or patch the issue itself proposes/)
  })
})

describe("adversarial-repro — generate() wiring", () => {
  test("kind:hardening reaches the LLM prompt; canonical default ⇒ not", async () => {
    const on = new CapturingLLM()
    await generateReproTests({ issue: ISSUE, llm: on, config: { samples: 1 }, kind: "hardening" })
    expect(userTextOf(on.lastInput)).toContain("ADVERSARIAL")

    const off = new CapturingLLM()
    await generateReproTests({ issue: ISSUE, llm: off, config: { samples: 1 } })
    expect(userTextOf(off.lastInput)).not.toContain("ADVERSARIAL")
    expect(userTextOf(off.lastInput)).toContain("CORE symptom only")
  })
})

describe("adversarial-repro — driver wiring", () => {
  const instance = {
    id: "django__django-10999",
    problemStatement: ISSUE,
  } as unknown as Parameters<typeof prepareReproTestDetailed>[0]

  test("deps.adversarial=true ⇒ generate runs for BOTH canonical AND hardening", async () => {
    const kinds: (string | undefined)[] = []
    const fakeGenerate = (async (args: { kind?: string }) => {
      kinds.push(args.kind)
      return [] as readonly string[] // empty ⇒ early return, no execute needed
    }) as unknown as typeof generateReproTests
    await prepareReproTestDetailed(instance, "/tmp/sbx", 5, {
      llm: new CapturingLLM(),
      generate: fakeGenerate,
      adversarial: true,
    })
    // Both kinds requested — the submit oracle (canonical) AND advisory (hardening).
    expect(kinds).toContain("canonical")
    expect(kinds).toContain("hardening")
  })

  test("deps.adversarial unset ⇒ canonical-only (no hardening generation)", async () => {
    const kinds: (string | undefined)[] = []
    const fakeGenerate = (async (args: { kind?: string }) => {
      kinds.push(args.kind)
      return [] as readonly string[]
    }) as unknown as typeof generateReproTests
    await prepareReproTestDetailed(instance, "/tmp/sbx", 5, {
      llm: new CapturingLLM(),
      generate: fakeGenerate,
    })
    expect(kinds).toContain("canonical")
    expect(kinds).not.toContain("hardening")
  })
})

describe("adversarial-repro — posture wiring (default-OFF)", () => {
  const ENV_KEYS = ["QUANTA_BENCH_ADVERSARIAL_REPRO", "QUANTA_BENCH_PRESET", "QUANTA_KNOBS_PRESET"]
  let saved: Map<string, string | undefined>
  beforeEach(() => {
    saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]))
    for (const k of ENV_KEYS) delete process.env[k]
    __resetKnobOverrides()
  })
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    __resetKnobOverrides()
  })

  const posture = (env: Record<string, string>): BenchPosture => {
    const e = env as unknown as NodeJS.ProcessEnv
    return benchPostureFromState(resolveBenchKnobs({ envVars: e }), e)
  }

  test("unset ⇒ adversarialRepro false (byte-identical baseline)", () => {
    expect(posture({}).adversarialRepro).toBe(false)
  })

  test("QUANTA_BENCH_ADVERSARIAL_REPRO=1 ⇒ adversarialRepro true", () => {
    expect(posture({ QUANTA_BENCH_ADVERSARIAL_REPRO: "1" }).adversarialRepro).toBe(true)
  })

  test("off/0/false ⇒ adversarialRepro false (strict gate)", () => {
    expect(posture({ QUANTA_BENCH_ADVERSARIAL_REPRO: "0" }).adversarialRepro).toBe(false)
    expect(posture({ QUANTA_BENCH_ADVERSARIAL_REPRO: "off" }).adversarialRepro).toBe(false)
    expect(posture({ QUANTA_BENCH_ADVERSARIAL_REPRO: "false" }).adversarialRepro).toBe(false)
  })
})
