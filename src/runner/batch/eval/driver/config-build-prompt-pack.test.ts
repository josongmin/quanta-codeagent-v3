/**
 * A2 (jul-3 strategy-audit) WIRING proof — the batch eval driver threads
 * `promptPack:"batch"` into the agent's SYSTEM prompt, so a graded bench run
 * carries the `R-NO-EXPLORE-OVER-EDIT` rule (stop exploring once you have a
 * coherent edit + verify step).
 *
 * This is a WIRING test, not a re-assertion of `buildSystemPrompt`: it drives
 * the real `buildConfig` (the exact seam the driver uses) and reads back the
 * assembled `config.system`. RED before the fix: `buildConfig` called
 * `buildSystemPrompt(sandbox)` (no pack) ⇒ the rule was ABSENT.
 *
 * Guard: the interactive default MUST NOT carry the batch-only rule (proves
 * the pack selection is load-bearing, not a rule that leaked into core).
 */

import { describe, expect, test } from "bun:test"
import { buildSystemPrompt } from "@/agent"
import type { LLMPort } from "@/llm"
import type { StreamPort } from "@/stream"
import type { Instance } from "../../types"
import type { RunInstanceDeps } from "./context-types"
import { buildConfig } from "./config-build"

const BATCH_RULE_MARKER = "[R-NO-EXPLORE-OVER-EDIT]"

const stubLlm: LLMPort = {
  model: "stub",
  // eslint-disable-next-line require-yield
  async *stream() {
    throw new Error("stub llm should not be streamed in a wiring test")
  },
}

const nullStream: StreamPort = { emit() {} }

const makeInstance = (sandbox: string): Instance => ({
  id: "wiring__a2-prompt-pack",
  repoPath: sandbox,
  problemStatement: "wiring probe: assert the batch pack threads into config.system",
  testCmd: "true",
})

/** A SWE instance (has `swebench` meta) — the reproduce-first knob only engages
 *  on these (reproduce-first needs a reported failure to reproduce). */
const makeSwebenchInstance = (sandbox: string): Instance => ({
  ...makeInstance(sandbox),
  id: "wiring__reproduce-first",
  swebench: {
    instanceId: "wiring__reproduce-first",
    repo: "acme/widget",
    baseCommit: "0000000000000000000000000000000000000000",
  },
})

const REPRODUCE_FIRST_MARKER = "[R-REPRODUCE-FIRST]"

const makeDeps = (): RunInstanceDeps => ({
  llm: stubLlm,
  maxTurns: 1,
  timeoutMs: 1,
})

describe("A2 — batch eval driver threads promptPack:'batch' into config.system", () => {
  test("buildConfig().system carries the batch-only R-NO-EXPLORE-OVER-EDIT rule (WIRING)", () => {
    const sandbox = process.cwd()
    const config = buildConfig(
      makeInstance(sandbox),
      makeDeps(),
      sandbox,
      new AbortController().signal,
      nullStream,
    )
    expect(typeof config.system).toBe("string")
    expect(config.system).toContain(BATCH_RULE_MARKER)
  })

  test("GUARD: the interactive default prompt does NOT carry the batch-only rule (pack selection is load-bearing)", () => {
    // If the rule leaked into CORE_RULES the WIRING test above would pass
    // vacuously; pin that the default (no pack) path is CLEAN.
    expect(buildSystemPrompt(process.cwd())).not.toContain(BATCH_RULE_MARKER)
    // And the exact pack the driver selects DOES carry it (the seam value).
    expect(buildSystemPrompt(process.cwd(), { promptPack: "batch" })).toContain(BATCH_RULE_MARKER)
  })
})

describe("verify axis (jul-4) — QUANTA_BENCH_REPRODUCE_FIRST gates reproduce-first into config.system", () => {
  const KNOB = "QUANTA_BENCH_REPRODUCE_FIRST"
  const withKnob = <T>(value: string | undefined, fn: () => T): T => {
    const prev = process.env[KNOB]
    if (value === undefined) delete process.env[KNOB]
    else process.env[KNOB] = value
    try {
      return fn()
    } finally {
      if (prev === undefined) delete process.env[KNOB]
      else process.env[KNOB] = prev
    }
  }
  const systemFor = (instance: Instance): string => {
    const sandbox = process.cwd()
    const config = buildConfig(instance, makeDeps(), sandbox, new AbortController().signal, nullStream)
    return String(config.system)
  }

  test("OFF (knob unset) ⇒ config.system does NOT carry reproduce-first (byte-identical default)", () => {
    withKnob(undefined, () => {
      expect(systemFor(makeSwebenchInstance(process.cwd()))).not.toContain(REPRODUCE_FIRST_MARKER)
    })
  })
  test("ON + SWE instance ⇒ config.system carries the reproduce-first rule (WIRING)", () => {
    withKnob("1", () => {
      expect(systemFor(makeSwebenchInstance(process.cwd()))).toContain(REPRODUCE_FIRST_MARKER)
    })
  })
  test("ON but NON-swebench instance ⇒ reproduce-first stays OFF (gate needs a reported failure)", () => {
    // The knob is guarded by `instance.swebench !== undefined`; a plain local instance
    // has no reported failure to reproduce, so the rule must not inject.
    withKnob("1", () => {
      expect(systemFor(makeInstance(process.cwd()))).not.toContain(REPRODUCE_FIRST_MARKER)
    })
  })
})

describe("verify axis (P6) — QUANTA_SWE_HIDDEN_GRADER gates grader-only + suppresses conflicts", () => {
  const withGrader = <T>(value: string | undefined, fn: () => T): T => {
    const k = "QUANTA_SWE_HIDDEN_GRADER"
    const prev = process.env[k]
    if (value === undefined) delete process.env[k]
    else process.env[k] = value
    try {
      return fn()
    } finally {
      if (prev === undefined) delete process.env[k]
      else process.env[k] = prev
    }
  }
  const sysFor = (i: Instance): string =>
    String(buildConfig(i, makeDeps(), process.cwd(), new AbortController().signal, nullStream).system)

  test("ON + SWE ⇒ [R-GRADER-ONLY] present AND body repro/completion suppressed (conflict fix WIRING)", () => {
    withGrader("1", () => {
      const sys = sysFor(makeSwebenchInstance(process.cwd()))
      expect(sys).toContain("[R-GRADER-ONLY]")
      expect(sys).not.toContain("first reproduce the failure with the smallest")
      expect(sys).not.toContain("Completion bar: finish only when")
      expect(sys).not.toContain(REPRODUCE_FIRST_MARKER) // opposite posture never coexists
    })
  })
  test("OFF ⇒ no grader rule; body repro/completion intact (byte-identical default)", () => {
    withGrader(undefined, () => {
      const sys = sysFor(makeSwebenchInstance(process.cwd()))
      expect(sys).not.toContain("[R-GRADER-ONLY]")
      expect(sys).toContain("Completion bar: finish only when")
    })
  })
})
