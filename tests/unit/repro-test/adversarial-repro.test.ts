/**
 * Hellgate — `adversarial-repro` knob (jun-19, #10999 under-fix class).
 *
 * RCA: django-10999 had ownerHit + a base-RED repro yet ended UNRESOLVED — the
 * agent copied the issue's incomplete suggested regex and the weak (happy-path)
 * repro printed "Issue resolved" on that under-fix (false-GREEN). The lever is a
 * STRONGER repro: a prompt block forcing boundary / must-reject / consistency
 * cases and an explicit "do NOT copy the issue's proposed fix", so a shallow
 * patch stays RED.
 *
 * Teeth (each fails if the wiring is severed):
 *   1. OFF byte-identical — prompt with adversarial falsy === pre-feature prompt,
 *      and contains NO adversarial markers. (default-OFF safety)
 *   2. ON superset — adversarial prompt contains every OFF line PLUS the block.
 *   3. ON content — the load-bearing directives are present (red-on-injection:
 *      delete the block ⇒ these assertions fail).
 *   4. generate() threads `adversarial` into the LLM message (wiring proof).
 *   5. driver `prepareReproTestDetailed` threads `deps.adversarial` into generate.
 *   6. posture: QUANTA_BENCH_ADVERSARIAL_REPRO ⇒ adversarialRepro, default OFF,
 *      isolated from siblings.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import "@/runner/knobs/knobs"
import { prepareReproTestDetailed } from "@/runner/batch/eval/driver"
import { type BenchPosture, benchPostureFromState } from "@/runner/batch/eval/knobs-bench"
import { resolveBenchKnobs } from "@/runner/batch/eval/driver"
import { __resetKnobOverrides } from "@/shared/knob-overrides"
import {
  buildReproTestPrompt,
  generateReproTests,
} from "../../../src/agent/repro-test/generate"
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

describe("adversarial-repro — prompt", () => {
  test("OFF is byte-identical (undefined === false) and carries no adversarial markers", () => {
    const off = buildReproTestPrompt(ISSUE)
    expect(buildReproTestPrompt(ISSUE, undefined, false)).toBe(off)
    expect(off).not.toContain("ADVERSARIAL")
    expect(off).not.toContain("do NOT copy")
  })

  test("ON is a SUPERSET — every OFF line survives, plus the block", () => {
    const off = buildReproTestPrompt(ISSUE)
    const on = buildReproTestPrompt(ISSUE, undefined, true)
    expect(on.length).toBeGreaterThan(off.length)
    // Issue body + the three-marker contract must still be intact.
    for (const line of off.split("\n")) {
      if (line.trim() === "") continue
      expect(on).toContain(line)
    }
  })

  test("ON content — load-bearing directives present (red-on-injection)", () => {
    const on = buildReproTestPrompt(ISSUE, undefined, true)
    expect(on).toContain("ADVERSARIAL")
    expect(on).toContain('must STILL print "Issue reproduced"')
    expect(on).toContain("rejected") // must-reject cases
    expect(on).toContain("boundary")
    expect(on).toMatch(/Do\s+NOT copy any fix, regex, or patch the issue itself proposes/)
  })
})

describe("adversarial-repro — generate() wiring", () => {
  test("adversarial:true reaches the LLM prompt; absent ⇒ not", async () => {
    const on = new CapturingLLM()
    await generateReproTests({ issue: ISSUE, llm: on, config: { samples: 1 }, adversarial: true })
    expect(userTextOf(on.lastInput)).toContain("ADVERSARIAL")

    const off = new CapturingLLM()
    await generateReproTests({ issue: ISSUE, llm: off, config: { samples: 1 } })
    expect(userTextOf(off.lastInput)).not.toContain("ADVERSARIAL")
  })
})

describe("adversarial-repro — driver wiring", () => {
  const instance = {
    id: "django__django-10999",
    problemStatement: ISSUE,
  } as unknown as Parameters<typeof prepareReproTestDetailed>[0]

  test("deps.adversarial=true ⇒ generate receives adversarial:true", async () => {
    let seen: boolean | undefined
    const fakeGenerate = (async (args: { adversarial?: boolean }) => {
      seen = args.adversarial
      return [] as readonly string[] // empty ⇒ early return, no execute needed
    }) as unknown as typeof generateReproTests
    await prepareReproTestDetailed(instance, "/tmp/sbx", 5, {
      llm: new CapturingLLM(),
      generate: fakeGenerate,
      adversarial: true,
    })
    expect(seen).toBe(true)
  })

  test("deps.adversarial unset ⇒ generate receives no adversarial flag", async () => {
    let seen: boolean | undefined = "untouched" as unknown as boolean
    const fakeGenerate = (async (args: { adversarial?: boolean }) => {
      seen = args.adversarial
      return [] as readonly string[]
    }) as unknown as typeof generateReproTests
    await prepareReproTestDetailed(instance, "/tmp/sbx", 5, {
      llm: new CapturingLLM(),
      generate: fakeGenerate,
    })
    expect(seen).toBeUndefined()
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
