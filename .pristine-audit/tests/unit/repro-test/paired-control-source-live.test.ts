/**
 * G2 paired-control — LIVE control-SOURCE generation + driver populate chain.
 *
 * BACKGROUND. The G2 merge made three things real-but-INERT:
 *   - `select.ts` admission tightens to `reproduced && baseControl === "green"`
 *     (proved live in repro-paired-control-hellgate.test.ts).
 *   - `execute.ts` runs supplied `controlTests` on base and folds the verdict
 *     into `baseControl` (proved live in repro-test/execute.test.ts).
 *   - the `paired-control` knob projects `posture.pairedControl`.
 * But NO caller ever GENERATED a control source or threaded `controlTests` into
 * the executor, so ON ⇒ every sample's `baseControl` was `undefined` ⇒ `"absent"`
 * ⇒ the gate fail-closed and REJECTED everything (a prod fail-close).
 *
 * THIS FILE closes that gap end-to-end. Teeth:
 *   1. Control prompt content (red-on-injection on the INVERSE oracle): the
 *      control asserts NORMAL behavior that PASSES on base — NOT the buggy /
 *      expected-after-fix behavior the symptom prompt asserts.
 *   2. `generateControlTests` wiring: the control system prompt + user text
 *      reach the LLM; the footer is guaranteed.
 *   3. Driver OFF=byte-identical: gate OFF ⇒ the control generator is NEVER
 *      called AND no `controlTests` reaches the executor ⇒ `baseControl` absent.
 *   4. Driver ON populate: gate ON ⇒ the control generator IS called, its sources
 *      are threaded to the executor as `controlTests`, the executor runs them on
 *      base and fills `baseControl` — and a GREEN control ADMITS the reproducer
 *      while a RED control REJECTS it (the false-red the gate exists to catch).
 *   5. gold never consulted: the control prompt is built from the PUBLIC issue
 *      text only; `instance.goldPatch` does not leak into the LLM input.
 */
import { describe, expect, test } from "bun:test"
import type { ExecuteReproTestsArgs } from "../../../src/agent/repro-test/execute"
import {
  buildControlTestPrompt,
  generateControlTests,
} from "../../../src/agent/repro-test/generate"
import type { ReproTestSample } from "../../../src/agent/repro-test/types"
import type { LLMPort, StreamEvent, StreamInput } from "../../../src/llm"
import { prepareReproTestDetailed } from "../../../src/runner/batch/eval/driver"
import type { Instance } from "../../../src/runner/batch/types"

const ISSUE =
  "parse_duration() returns None for negative durations like '-1 day'. It should parse them."
const GOLD =
  "SENTINEL_GOLD_PATCH_MUST_NOT_LEAK\n--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-buggy\n+fixed"

const mkInstance = (overrides: Partial<Instance> = {}): Instance => ({
  id: "django__django-1",
  repoPath: "/tmp/x",
  problemStatement: ISSUE,
  testCmd: "true",
  goldPatch: GOLD,
  ...overrides,
})

/** Captures the LLM input so we can inspect the system + user message. */
class CapturingLLM implements LLMPort {
  inputs: StreamInput[] = []
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    yield { type: "text_delta", delta: "def test_control(): assert ok()" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const userTextOf = (input: StreamInput): string => {
  const part = input.messages?.[0]?.content?.[0]
  return part !== undefined && "text" in part ? part.text : ""
}

describe("G2 control prompt — INVERSE oracle content (red-on-injection)", () => {
  const prompt = buildControlTestPrompt(ISSUE)

  test("embeds the public issue text for project context", () => {
    expect(prompt).toContain(ISSUE)
  })

  test("asserts NORMAL behavior that PASSES on base, NOT the buggy/expected-after-fix path", () => {
    // The symptom prompt says "assert the EXPECTED (correct) behavior so it FAILS
    // on the buggy code". The control is the INVERSE: it must already PASS.
    expect(prompt).toContain("MUST PASS on the current code")
    expect(prompt).toContain("UNRELATED to the reported bug")
    // It must explicitly forbid asserting the after-fix behavior (that would make
    // it a second symptom test, not an env-health probe).
    expect(prompt).toContain("Do NOT assert the")
    expect(prompt).toContain("EXPECTED-AFTER-FIX")
    expect(prompt).toContain("Do NOT exercise the buggy behavior")
  })

  test("carries the self-driving pytest footer scaffold", () => {
    expect(prompt).toContain('if __name__ == "__main__":')
    expect(prompt).toContain("pytest.main")
    expect(prompt).toContain("def test_")
  })

  test("empty issue ⇒ generator returns [] (no LLM call)", async () => {
    const llm = new CapturingLLM()
    const out = await generateControlTests({ issue: "", llm })
    expect(out).toEqual([])
    expect(llm.inputs).toHaveLength(0)
  })
})

describe("G2 generateControlTests — wiring proof", () => {
  test("control system prompt + INVERSE user text reach the LLM; footer guaranteed", async () => {
    const llm = new CapturingLLM()
    const out = await generateControlTests({ issue: ISSUE, llm, controlCount: 1 })
    expect(out).toHaveLength(1)
    // The control SYSTEM message frames an env-health control, distinct from the
    // symptom system prompt ("reproduces a reported bug").
    expect(llm.inputs[0]?.system).toContain("CONTROL test")
    expect(llm.inputs[0]?.system).not.toContain("reproduces a reported bug")
    // The user text is the INVERSE-oracle control prompt.
    expect(userTextOf(llm.inputs[0] as StreamInput)).toContain("MUST PASS on the current code")
    // Footer is guaranteed even though the LLM emitted a footer-less stub.
    expect(out[0]).toContain('if __name__ == "__main__":')
    expect(out[0]).toContain("pytest.main")
  })

  test("controlCount caps how many controls are generated", async () => {
    const llm = new CapturingLLM()
    const out = await generateControlTests({ issue: ISSUE, llm, controlCount: 3 })
    expect(out).toHaveLength(3)
    expect(llm.inputs).toHaveLength(3)
  })
})

// --- Driver end-to-end: gen control source → execute on base → populate
// baseControl → admit/reject. This is the chain the field-population seam needs.

/** A deterministic generator double: returns one footer-bearing symptom source. */
const fakeGenerate = (async () =>
  ["def test_symptom(): assert wrong()"] as readonly string[]) as never

/** Records whether the control generator was invoked, and what it returns. */
const makeFakeControlGen = (sources: readonly string[]) => {
  const calls: { issue: string }[] = []
  const gen = (async (args: { issue: string }) => {
    calls.push({ issue: args.issue })
    return sources
  }) as never
  return { gen, calls }
}

/** A deterministic executor double that asserts on the threaded `controlTests`
 *  and synthesises samples whose `baseControl` reflects a chosen control verdict
 *  — exactly what the real `evaluateControls` would compute, without spawning
 *  python. The point of THIS test is the DRIVER threading, not re-testing the
 *  executor (that lives in execute.test.ts with a real exec port). */
const makeFakeExecute = (controlVerdict: ReproTestSample["baseControl"]) => {
  const seen: {
    controlTests: ExecuteReproTestsArgs["controlTests"]
    /** Whether the `controlTests` KEY was present at all (OFF must omit it, not
     *  pass `undefined`, so the executor call is byte-identical to legacy). */
    hadControlTestsKey: boolean
  } = { controlTests: undefined, hadControlTestsKey: false }
  const execute = (async (args: ExecuteReproTestsArgs) => {
    seen.controlTests = args.controlTests
    seen.hadControlTestsKey = "controlTests" in args
    return args.tests.map((source): ReproTestSample => {
      // If controls were threaded for this sample, attach the chosen verdict —
      // mirrors `evaluateControls` folding controlTests[i] into baseControl.
      const hasControls = (args.controlTests?.[0]?.length ?? 0) > 0
      const base: ReproTestSample = { source, stdout: "", outcome: "reproduced" }
      return hasControls && controlVerdict !== undefined
        ? { ...base, baseControl: controlVerdict }
        : base
    })
  }) as never
  return { execute, seen }
}

describe("G2 driver — OFF=byte-identical (no control generation, no threading)", () => {
  test("gate OFF ⇒ control generator NEVER called and no controlTests reaches the executor", async () => {
    const control = makeFakeControlGen(["def test_ctl(): assert healthy()"])
    const exec = makeFakeExecute("green")
    const detail = await prepareReproTestDetailed(mkInstance(), "/tmp/sb", 1, {
      llm: new CapturingLLM(),
      generate: fakeGenerate,
      generateControl: control.gen,
      execute: exec.execute,
      // pairedControl omitted ⇒ OFF
    })
    // The control generator must not fire.
    expect(control.calls).toHaveLength(0)
    // No controlTests key threaded ⇒ legacy executor call shape. The KEY must be
    // OMITTED (not passed as `undefined`) so OFF is byte-identical to legacy.
    expect(exec.seen.hadControlTestsKey).toBe(false)
    expect(exec.seen.controlTests).toBeUndefined()
    // Sample has no baseControl ⇒ "absent" — but with the gate OFF the legacy
    // filter admits the reproducer anyway (byte-identical legacy behavior).
    expect(detail.selection?.samples[0]?.baseControl).toBeUndefined()
    expect(detail.selection?.selected).not.toBeNull()
  })
})

describe("G2 driver — ON populates baseControl and gates on it (live proof)", () => {
  test("gate ON ⇒ control generator fires, sources threaded to executor as controlTests", async () => {
    const control = makeFakeControlGen(["def test_ctl(): assert healthy()"])
    const exec = makeFakeExecute("green")
    const detail = await prepareReproTestDetailed(mkInstance(), "/tmp/sb", 1, {
      llm: new CapturingLLM(),
      generate: fakeGenerate,
      generateControl: control.gen,
      execute: exec.execute,
      pairedControl: true,
    })
    // The control generator fired with the PUBLIC issue text.
    expect(control.calls).toHaveLength(1)
    expect(control.calls[0]?.issue).toBe(ISSUE)
    // The generated control source was threaded to the executor, attached to the
    // (single) symptom candidate by position.
    expect(exec.seen.controlTests).toBeDefined()
    expect(exec.seen.controlTests?.[0]).toEqual(["def test_ctl(): assert healthy()"])
    // baseControl got populated (green) ⇒ the admission gate ADMITS the reproducer.
    expect(detail.selection?.samples[0]?.baseControl).toBe("green")
    expect(detail.selection?.selected).not.toBeNull()
    expect(detail.selection?.controlRejectedCount).toBe(0)
  })

  test("env-broken false-red: control RED ⇒ baseControl red ⇒ reproducer REJECTED", async () => {
    const control = makeFakeControlGen(["def test_ctl(): import broken_dep"])
    const exec = makeFakeExecute("red")
    const detail = await prepareReproTestDetailed(mkInstance(), "/tmp/sb", 1, {
      llm: new CapturingLLM(),
      generate: fakeGenerate,
      generateControl: control.gen,
      execute: exec.execute,
      pairedControl: true,
    })
    // The reproducing symptom is base-RED but the env is broken (control failed),
    // so the gate must REJECT it — the astropy-13033 false-red the feature exists
    // to catch. RED-ON-INJECTION: if the driver did not thread controls, baseControl
    // would be undefined and (under OFF) admitted; here it is populated red.
    expect(detail.selection?.samples[0]?.baseControl).toBe("red")
    expect(detail.selection?.selected).toBeNull()
    expect(detail.selection?.controlRejectedCount).toBe(1)
  })

  test("gold patch never leaks into the control LLM input", async () => {
    // Use the REAL control generator with a capturing LLM so we see the full
    // prompt. The instance carries a sentinel gold patch that must NOT appear.
    const llm = new CapturingLLM()
    const realControlGen = generateControlTests
    const exec = makeFakeExecute("green")
    await prepareReproTestDetailed(mkInstance(), "/tmp/sb", 1, {
      llm,
      generate: fakeGenerate,
      generateControl: realControlGen,
      execute: exec.execute,
      pairedControl: true,
    })
    expect(llm.inputs.length).toBeGreaterThan(0)
    for (const input of llm.inputs) {
      expect(userTextOf(input)).not.toContain("SENTINEL_GOLD_PATCH_MUST_NOT_LEAK")
      expect(input.system ?? "").not.toContain("SENTINEL_GOLD_PATCH_MUST_NOT_LEAK")
    }
  })
})
