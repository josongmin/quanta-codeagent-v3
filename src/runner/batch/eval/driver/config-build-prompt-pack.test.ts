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
import { buildConfig } from "./config-build"
import type { RunInstanceDeps } from "./context-types"
import { composeBaseText } from "./prompt-directives"

const BATCH_RULE_MARKER = "[R-NO-EXPLORE-OVER-EDIT]"

const stubLlm: LLMPort = {
  model: "stub",
  // eslint-disable-next-line require-yield
  // biome-ignore lint/correctness/useYield: stream must be an async generator to satisfy the LLM port; this wiring-test stub throws without yielding
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
    const config = buildConfig(
      instance,
      makeDeps(),
      sandbox,
      new AbortController().signal,
      nullStream,
    )
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
    String(
      buildConfig(i, makeDeps(), process.cwd(), new AbortController().signal, nullStream).system,
    )

  test("ON + SWE ⇒ [R-GRADER-ONLY] present AND every local-verification body rule suppressed (conflict fix WIRING)", () => {
    withGrader("1", () => {
      const sys = sysFor(makeSwebenchInstance(process.cwd()))
      expect(sys).toContain("[R-GRADER-ONLY]")
      expect(sys).not.toContain("first reproduce the failure with the smallest")
      expect(sys).not.toContain("Completion bar: finish only when")
      // R4 self-audit: the Verification report block also presupposes a local run — suppressed too
      expect(sys).not.toContain(
        "Verification report (use when you ran or considered running verification)",
      )
      expect(sys).not.toContain(REPRODUCE_FIRST_MARKER) // opposite posture never coexists
    })
  })
  test("OFF ⇒ no grader rule; body repro/completion/verification-report intact (byte-identical default)", () => {
    withGrader(undefined, () => {
      const sys = sysFor(makeSwebenchInstance(process.cwd()))
      expect(sys).not.toContain("[R-GRADER-ONLY]")
      expect(sys).toContain("Completion bar: finish only when")
      expect(sys).toContain(
        "Verification report (use when you ran or considered running verification)",
      )
    })
  })

  // R5 self-audit: coherence across BOTH prompt surfaces. grader-only is a system-side
  // posture, but the USER directive carries its own verify posture via `inLoopExecMode`
  // (default FULL ⇒ "run the tests, an unverified edit is the #1 cause of failure"). If
  // the two diverge, grader-only ON re-creates the L1↔L8 conflict on the user surface.
  // The fix: grader-only DRIVES the user directive to NOEXEC. These assertions pin that
  // the two surfaces agree — and the mutually-exclusive posture strings make it non-vacuous.
  const userMsgFor = (i: Instance): string =>
    String(
      (
        buildConfig(i, makeDeps(), process.cwd(), new AbortController().signal, nullStream)
          .messages[0]?.content[0] as { text?: string } | undefined
      )?.text ?? "",
    )
  const FULL_VERIFY_DEMAND = "an unverified edit is the #1 cause of failure"
  const NOEXEC_POSTURE = "Do NOT run the test suite, pytest, or tox yourself"
  const NOEXEC_UNVERIFIED_OK = "an unverified edit is fine — the grader decides"

  test("R5 coherence: grader-only ON ⇒ USER directive flips to NOEXEC (agrees with the system rule)", () => {
    withGrader("1", () => {
      const user = userMsgFor(makeSwebenchInstance(process.cwd()))
      // the user surface now MATCHES grader-only: no local run, unverified is fine
      expect(user).toContain(NOEXEC_POSTURE)
      expect(user).toContain(NOEXEC_UNVERIFIED_OK)
      // and the conflicting FULL "you MUST run the tests" demand is GONE from the user msg
      expect(user).not.toContain(FULL_VERIFY_DEMAND)
    })
  })
  test("R5 control: grader-only OFF ⇒ USER directive keeps the default FULL verify demand (non-vacuous + byte-identical)", () => {
    withGrader(undefined, () => {
      const user = userMsgFor(makeSwebenchInstance(process.cwd()))
      // proves the flip above is load-bearing: default really does demand verification
      expect(user).toContain(FULL_VERIFY_DEMAND)
      expect(user).not.toContain(NOEXEC_UNVERIFIED_OK)
    })
  })

  // F1 (jul-6 final audit): exec-mode is the SSOT for verify posture. Shipped presets
  // (agentless-v3-thin-strict / v5-thin-and-expanded) + capability profiles set
  // `bench-in-loop-exec: off`, which emits the NOEXEC user directive ("do NOT run pytest").
  // Before F1 the SYSTEM still carried its verify demands ⇒ the EXACT captured L1↔L8 conflict
  // shipped in those presets. F1: exec=off ⇒ grader-only automatically, NO opt-in knob.
  const withExec = <T>(value: string | undefined, fn: () => T): T => {
    const k = "QUANTA_BENCH_IN_LOOP_EXEC"
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

  test("F1: exec=off (NO grader knob) ⇒ BOTH surfaces coherent grader-only (fixes the shipped-preset conflict)", () => {
    // grader knob explicitly UNSET — coherence must come from exec-mode alone.
    withGrader(undefined, () =>
      withExec("off", () => {
        const inst = makeSwebenchInstance(process.cwd())
        const sys = sysFor(inst)
        const user = userMsgFor(inst)
        // SYSTEM auto-adopts grader-only and drops every local-verification demand …
        expect(sys).toContain("[R-GRADER-ONLY]")
        expect(sys).not.toContain("Completion bar: finish only when")
        expect(sys).not.toContain(
          "Verification report (use when you ran or considered running verification)",
        )
        // … and the USER directive is NOEXEC — the two agree, no conflict.
        expect(user).toContain(NOEXEC_POSTURE)
        expect(user).not.toContain(FULL_VERIFY_DEMAND)
      }),
    )
  })
  test("F1 control: exec=full (default, no knob) ⇒ NO grader rule; verify demands intact (byte-identical, non-vacuous)", () => {
    withGrader(undefined, () =>
      withExec("full", () => {
        const inst = makeSwebenchInstance(process.cwd())
        const sys = sysFor(inst)
        // proves F1 is exec-gated, not blanket: full keeps the coherent verify posture
        expect(sys).not.toContain("[R-GRADER-ONLY]")
        expect(sys).toContain("Completion bar: finish only when")
        expect(userMsgFor(inst)).toContain(FULL_VERIFY_DEMAND)
      }),
    )
  })

  // 100-point coherence INVARIANT (jul-6 adversarial round-2): codify the exhaustive truth table
  // as a PERMANENT guard. For EVERY (hidden-grader knob × exec-mode) combo on a SWE instance, the
  // SYSTEM (grader-only rule) and the USER directive (NOEXEC) MUST agree — that mutual-equivalence
  // (system ⟺ user) is exactly what `isGraderOnlyPosture` (the single SSOT read by both surfaces)
  // guarantees, and its absence was the original L1↔L8 conflict. If any future edit re-splits the
  // derivation, one of these rows flips one surface without the other and fails LOUD.
  const GRADER_COMBOS: ReadonlyArray<{
    knob: string | undefined
    exec: string
    graderOnly: boolean
  }> = [
    { knob: undefined, exec: "full", graderOnly: false },
    { knob: undefined, exec: "repro-only", graderOnly: false },
    { knob: undefined, exec: "off", graderOnly: true }, // F1: exec=off ⇒ grader-only, no knob
    { knob: "1", exec: "full", graderOnly: true }, // knob forces grader-only under any exec
    { knob: "1", exec: "repro-only", graderOnly: true },
    { knob: "1", exec: "off", graderOnly: true },
  ]
  for (const c of GRADER_COMBOS) {
    test(`INVARIANT: knob=${c.knob ?? "off"} × exec=${c.exec} ⇒ system grader-only === user NOEXEC === ${c.graderOnly} (both surfaces agree)`, () => {
      withGrader(c.knob, () =>
        withExec(c.exec, () => {
          const inst = makeSwebenchInstance(process.cwd())
          const sysGrader = sysFor(inst).includes("[R-GRADER-ONLY]")
          const userNoexec = userMsgFor(inst).includes(NOEXEC_POSTURE)
          // both surfaces reflect the SAME resolved posture …
          expect(sysGrader).toBe(c.graderOnly)
          expect(userNoexec).toBe(c.graderOnly)
          // … and the load-bearing invariant: they are mutually equivalent (never diverge).
          expect(sysGrader).toBe(userNoexec)
        }),
      )
    })
  }
})

// Directive de-dup regression guard (jul-6 #3): the three verbose SWEBENCH_DIRECTIVE variants were
// refactored to share ONE `SWE_DIR_HEAD`/`INFER_EXACT`/`MIN_TAIL`/`V4A` via spread. Pin that the
// shared HEAD stays byte-identical across variants (an edit to one that diverges the others fails
// LOUD) AND that each keeps its DISTINCT verify clause (guards against over-collapsing into one).
describe("SWEBENCH_DIRECTIVE de-dup (jul-6 #3) — shared HEAD identical, verify clauses distinct", () => {
  const EMPTY_STEERS = { lsp: "", findRefs: "", spec: "", simplicity: "", sibling: "" }
  const directive = (exec: "full" | "repro-only" | "off"): string =>
    composeBaseText("BASE_PROBLEM", true, exec, EMPTY_STEERS, false)
  const HEAD_END = "do not let bash commands wipe it."
  const sharedHead = (s: string): string => {
    const start = s.indexOf("You are fixing a real defect")
    const end = s.indexOf(HEAD_END) + HEAD_END.length
    return s.slice(start, end)
  }

  test("the 12-line HEAD is byte-identical across full / repro-only / off (de-dup did not diverge them)", () => {
    const full = sharedHead(directive("full"))
    expect(full.length).toBeGreaterThan(100) // non-vacuous: HEAD is substantial
    expect(sharedHead(directive("repro-only"))).toBe(full)
    expect(sharedHead(directive("off"))).toBe(full)
  })
  test("each variant keeps its DISTINCT verify clause (not over-collapsed into one directive)", () => {
    expect(directive("full")).toContain("MANDATORY before you stop")
    expect(directive("off")).toContain("an unverified edit is fine — the grader decides")
    expect(directive("repro-only")).toContain("you MAY run a tiny issue reproducer")
    expect(directive("full")).not.toBe(directive("off"))
    expect(directive("off")).not.toBe(directive("repro-only"))
  })
})
