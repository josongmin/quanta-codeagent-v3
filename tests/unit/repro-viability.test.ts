/**
 * HARD RED e2e for the observe-only post-fix repro-viability review
 * (`QUANTA_BENCH_REPRO_VIABILITY`). Spec step-5 "cheap fix-free post-fix-viability":
 * label whether the captured patch is STRUCTURALLY viable against the ACTUAL repro
 * test source before any expensive re-grade. Observe-only — never mutates the
 * instance result / control flow (fail-open, typed 3rd `unparseable` state, no THROW).
 *
 * Contract fences (each is a mutation the real code must survive):
 *  1. prompt builder consumes the REAL repro source body (not the boilerplate hint) —
 *     inert-by-boilerplate red-guard.
 *  2. parser returns a typed verdict; off-spec ⇒ `unparseable` (NEVER throws).
 *  3. wire fail-open: a stream throw ⇒ `unparseable` (no propagation).
 *  4. off-path byte-identical: gate unset ⇒ helper returns `undefined` AND
 *     `llm.stream` is called 0 times (paired-control for the on-path).
 *  5. red-on-injection: gate ON + valid reply ⇒ a review is returned.
 *  6. empty reproSources + gate ON ⇒ typed `unparseable` (instance kill = 0).
 */

import { afterEach, describe, expect, it } from "bun:test"
import type { LLMPort, StreamEvent } from "@/llm"
import {
  buildReproViabilityPrompt,
  parseReproViabilityReply,
  type ReproViabilityReview,
} from "@/runner/batch/eval/repro-viability"
import {
  buildReproViabilityFromPort,
  maybeReviewReproViability,
  resolveReproViabilityMode,
} from "@/runner/batch/eval/repro-viability-wire"

const KNOB = "QUANTA_BENCH_REPRO_VIABILITY"

const REAL_REPRO_SOURCE = [
  "import pytest",
  "def test_issue_reproduces():",
  "    from pkg.mod import boom",
  "    with pytest.raises(ValueError):",
  "        boom(unique_marker_42)",
].join("\n")

// The boilerplate hint that MUST NOT be fed to the classifier (repro-test-prep.ts
// style: a generic "a script has been placed" banner). Its presence in the prompt
// would mean the classifier can't see the real repro structure ⇒ inert.
const BOILERPLATE = "A reproduction script has been placed"

/** One-shot text stream (a single text_delta), like the LLM port yields. */
const textStream = (text: string): LLMPort["stream"] => {
  return () =>
    (async function* () {
      const ev: StreamEvent = { type: "text_delta", delta: text } as StreamEvent
      yield ev
    })()
}

const throwingStream: LLMPort["stream"] = () =>
  // biome-ignore lint/correctness/useYield: must be an async generator to satisfy LLMPort["stream"]; this stub throws immediately to exercise the error path and never yields
  (async function* () {
    throw new Error("stream boom")
  })()

const spyPort = (): { port: LLMPort; calls: () => number } => {
  let calls = 0
  const port = {
    stream: (...args: Parameters<LLMPort["stream"]>) => {
      calls += 1
      return textStream("VIABLE|reaches the fixed code path")(...args)
    },
  } as unknown as LLMPort
  return { port, calls: () => calls }
}

const savedKnob = process.env[KNOB]
afterEach(() => {
  if (savedKnob === undefined) delete process.env[KNOB]
  else process.env[KNOB] = savedKnob
})

describe("buildReproViabilityPrompt (pure, no-heuristic)", () => {
  it("includes the real repro source body, the problem statement, and the patch", () => {
    const prompt = buildReproViabilityPrompt(
      "The issue: boom() should raise ValueError",
      [REAL_REPRO_SOURCE],
      "--- a/pkg/mod.py\n+++ b/pkg/mod.py\n@@\n+raise ValueError",
    )
    expect(prompt).toContain("unique_marker_42") // real repro source body
    expect(prompt).toContain("boom() should raise ValueError") // problem statement
    expect(prompt).toContain("raise ValueError") // captured patch
  })

  it("NEVER embeds the boilerplate placement banner (inert-by-boilerplate guard)", () => {
    const prompt = buildReproViabilityPrompt("ps", [REAL_REPRO_SOURCE], "patch")
    expect(prompt).not.toContain(BOILERPLATE)
  })
})

describe("parseReproViabilityReply (pure, typed 3rd state, no THROW)", () => {
  it("parses VIABLE with a reason", () => {
    const r = parseReproViabilityReply("VIABLE|the patch edits the raising branch")
    expect(r.verdict).toBe("viable")
    expect(r.reason).toBe("the patch edits the raising branch")
  })

  it("parses NONVIABLE with a reason", () => {
    const r = parseReproViabilityReply("NONVIABLE|patch is unrelated to the fixture")
    expect(r.verdict).toBe("nonviable")
    expect(r.reason).toBe("patch is unrelated to the fixture")
  })

  it("off-spec text ⇒ unparseable and does NOT throw (observe-invariant)", () => {
    let r: ReproViabilityReview | undefined
    expect(() => {
      r = parseReproViabilityReply("gibberish with no verdict token")
    }).not.toThrow()
    expect(r?.verdict).toBe("unparseable")
  })
})

describe("resolveReproViabilityMode (env gate)", () => {
  it("unset ⇒ false", () => {
    delete process.env[KNOB]
    expect(resolveReproViabilityMode(process.env)).toBe(false)
  })
  it("truthy ⇒ true", () => {
    expect(resolveReproViabilityMode({ [KNOB]: "1" })).toBe(true)
  })
})

describe("buildReproViabilityFromPort (fail-open)", () => {
  it("stream throw ⇒ unparseable (no propagation)", async () => {
    const port = { stream: throwingStream } as unknown as LLMPort
    const review = await buildReproViabilityFromPort({
      llm: port,
      problemStatement: "ps",
      reproSources: [REAL_REPRO_SOURCE],
      capturedPatch: "patch",
    })
    expect(review.verdict).toBe("unparseable")
  })

  it("valid reply ⇒ typed verdict", async () => {
    const port = { stream: textStream("NONVIABLE|no overlap") } as unknown as LLMPort
    const review = await buildReproViabilityFromPort({
      llm: port,
      problemStatement: "ps",
      reproSources: [REAL_REPRO_SOURCE],
      capturedPatch: "patch",
    })
    expect(review.verdict).toBe("nonviable")
  })
})

describe("maybeReviewReproViability (wire, default-OFF byte-identical)", () => {
  const baseArgs = (port: LLMPort) => ({
    problemStatement: "ps",
    reproSources: [REAL_REPRO_SOURCE],
    capturedPatch: "patch",
    llm: port,
  })

  it("off-path: gate unset ⇒ undefined AND llm.stream called 0 times", async () => {
    delete process.env[KNOB]
    const { port, calls } = spyPort()
    const out = await maybeReviewReproViability(baseArgs(port))
    expect(out).toBeUndefined()
    expect(calls()).toBe(0)
  })

  it("red-on-injection: gate ON + valid reply ⇒ review returned", async () => {
    process.env[KNOB] = "1"
    const { port, calls } = spyPort()
    const out = await maybeReviewReproViability(baseArgs(port))
    expect(out).toBeDefined()
    expect(out?.verdict).toBe("viable")
    expect(calls()).toBe(1)
  })

  it("empty reproSources + gate ON ⇒ unparseable, no stream call (instance kill = 0)", async () => {
    process.env[KNOB] = "1"
    const { port, calls } = spyPort()
    const out = await maybeReviewReproViability({ ...baseArgs(port), reproSources: [] })
    expect(out?.verdict).toBe("unparseable")
    expect(out?.reason).toBe("no reproducing source")
    expect(calls()).toBe(0)
  })
})
