/**
 * DOF-22 — self-test + gate demonstrations for the LOCAL paired A/B measurement
 * harness (`./_ab-default-harness.ts`).
 *
 * WHAT THIS PROVES
 * ----------------
 * The harness is the CHEAP, LOCAL, HERMETIC behavior-regression rail that
 * DOF-22 requires before any behavioral default-OFF gate may flip to
 * default-ON. This suite pins three things:
 *
 *   (A) SELF-TEST — the harness verdict logic is CORRECT:
 *       - byte-identical ON==OFF          ⇒ NO-REGRESSION
 *       - ON differs (non-degrading)      ⇒ CHANGED
 *       - ON degrades the terminal outcome ⇒ REGRESSION  (red-on-injection:
 *         the CHANGED-detector must NOT swallow a real degradation)
 *       - the scenario factory is invoked ONCE PER SIDE (no state bleed)
 *
 *   (B) CHANGED demonstration on a REAL gate (refusal-fallback via the true
 *       `wireOptionalAgentPorts(cfg, {QUANTA_REFUSAL_FALLBACK:"on"})` env seam):
 *       on a scripted refusal→success scenario the OFF side terminates as a
 *       refusal (1 LLM call) while the ON side re-prompts once and completes
 *       (2 LLM calls, +recovery event). The harness reports CHANGED — the
 *       regression-detection rail SEES the behavior move.
 *
 *   (C) NO-REGRESSION demonstrations on REAL gates (the default-OFF ledger's
 *       byte-identical claim, proven locally):
 *       - refusal-fallback ON on a NON-refusal scenario ⇒ gate never fires ⇒
 *         byte-identical ⇒ NO-REGRESSION.
 *       - closeout-critic ON with NO reviewer subagent ⇒ fail-open ⇒
 *         byte-identical ⇒ NO-REGRESSION.
 *
 * HERMETIC: no network, no box, no `process.env` mutation. Every gate is
 * flipped through the explicit-env `wireOptionalAgentPorts` seam and every LLM
 * is a scripted double. Deterministic under repeated runs.
 *
 * NOT PROVEN HERE (by design): answer QUALITY / efficacy. That is the EXPENSIVE
 * SWE picks A/B rail (operator-run, EC2). This harness only clears rail (1).
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput, SystemPromptInput } from "@/llm"
import {
  AB_AXES,
  computePairedVerdict,
  formatPairedResult,
  runPairedAB,
  type Scenario,
  type ScenarioFactory,
  type SideObservation,
} from "./_ab-default-harness"
import { cfg, RecordingStream } from "./_harness"

// ── scripted-LLM building blocks (same idiom as the refusal hellgate) ────────

const refusalScript = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "message_stop", stop_reason: "refusal" },
]
const successScript = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "message_stop", stop_reason: "end_turn" },
]

/** Strict scripted LLM: replays scripts in order, THROWS when over-called (so an
 *  over-retrying loop surfaces red, never a silent spin). Records call count +
 *  the first system prompt so the harness can read prompt bytes. */
class ScriptLLM implements LLMPort {
  readonly model = "ab-scripted"
  calls = 0
  firstSystem: SystemPromptInput | undefined
  private seenFirst = false
  constructor(private readonly scripts: StreamEvent[][]) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    if (!this.seenFirst) {
      this.firstSystem = input.system
      this.seenFirst = true
    }
    const script = this.scripts[this.calls]
    this.calls += 1
    if (script === undefined) {
      throw new Error(`ScriptLLM: unexpected call #${this.calls} (scripts exhausted)`)
    }
    for (const e of script) yield e
  }
}

const systemBytesOf = (s: SystemPromptInput | undefined): number => {
  if (s === undefined) return -1
  if (typeof s === "string") return Buffer.byteLength(s, "utf8")
  return s.reduce((n, b) => n + Buffer.byteLength(b.text, "utf8"), 0)
}

/** Build a Scenario from a scripts list + optional config overrides. */
const scenarioOf =
  (scripts: StreamEvent[][], over: Partial<AgentConfig> = {}): ScenarioFactory =>
  (): Scenario => {
    const llm = new ScriptLLM(scripts.map((s) => [...s]))
    const stream = new RecordingStream()
    const config = cfg({ llm, stream, maxTurns: 5, ...over })
    return {
      config,
      stream,
      llmCalls: () => llm.calls,
      firstSystemBytes: () => systemBytesOf(llm.firstSystem),
    }
  }

// ── (A) SELF-TEST — verdict logic correctness ────────────────────────────────

const obs = (over: Partial<SideObservation> = {}): SideObservation => ({
  reason: "completed",
  turns: 1,
  llmCalls: 1,
  toolEvents: 0,
  recoveryEvents: 0,
  systemBytes: 100,
  finalText: "done",
  eventDigest: "done×1",
  ...over,
})

describe("DOF-22 A/B harness — self-test (verdict logic)", () => {
  test("byte-identical ON==OFF ⇒ NO-REGRESSION (no vacuous CHANGED)", () => {
    const r = computePairedVerdict("QUANTA_X", obs(), obs())
    expect(r.verdict).toBe("NO-REGRESSION")
    expect(r.diffs).toHaveLength(0)
    expect(formatPairedResult(r)).toContain("NO-REGRESSION")
  })

  test("ON differs (non-degrading) ⇒ CHANGED, with the differing axes surfaced", () => {
    // ON did one extra LLM call + emitted a recovery, but STILL completed — the
    // outcome did not degrade, so this is CHANGED (surface for efficacy), not a
    // regression.
    const r = computePairedVerdict(
      "QUANTA_X",
      obs({ llmCalls: 1, recoveryEvents: 0 }),
      obs({ llmCalls: 2, recoveryEvents: 1 }),
    )
    expect(r.verdict).toBe("CHANGED")
    expect(r.regression).toBeUndefined()
    const axes = r.diffs.map((d) => d.axis).sort()
    expect(axes).toEqual(["llmCalls", "recoveryEvents"])
  })

  test("RED-ON-INJECTION: ON degrades terminal outcome ⇒ REGRESSION (not swallowed as CHANGED)", () => {
    // OFF completes, ON does NOT (aborted). The CHANGED-detector MUST escalate
    // this to REGRESSION — the whole point of the rail. If this flipped to
    // CHANGED the rail would greenlight a broken flip.
    const r = computePairedVerdict(
      "QUANTA_X",
      obs({ reason: "completed" }),
      obs({ reason: "aborted" }),
    )
    expect(r.verdict).toBe("REGRESSION")
    expect(r.regression?.axis).toBe("reason")
    expect(r.regression?.why).toContain("outcome regressed")
  })

  test("RED-ON-INJECTION: ON spins (more turns, no terminal-OK) ⇒ REGRESSION", () => {
    const r = computePairedVerdict(
      "QUANTA_X",
      obs({ reason: "max_turns", turns: 2 }),
      obs({ reason: "max_turns", turns: 5 }),
    )
    expect(r.verdict).toBe("REGRESSION")
    expect(r.regression?.axis).toBe("turns")
  })

  test("every captured axis participates in the diff (no dead axis)", () => {
    // Flip each axis one at a time; each must appear as a diff ⇒ CHANGED (or
    // REGRESSION for reason/turns). Guards against an axis being captured but
    // never compared (a vacuous NO-REGRESSION source).
    for (const axis of AB_AXES) {
      const base = obs()
      const flipped: SideObservation =
        axis === "reason"
          ? obs({ reason: "error" })
          : axis === "finalText"
            ? obs({ finalText: "different" })
            : axis === "eventDigest"
              ? obs({ eventDigest: "done×2" })
              : obs({ [axis]: (base[axis] as number) + 1 } as Partial<SideObservation>)
      const r = computePairedVerdict("QUANTA_X", base, flipped)
      expect(r.diffs.some((d) => d.axis === axis)).toBe(true)
    }
  })
})

describe("DOF-22 A/B harness — factory hygiene (no state bleed between sides)", () => {
  test("scenarioFactory is invoked exactly ONCE PER SIDE (fresh state each side)", async () => {
    let factoryCalls = 0
    const factory: ScenarioFactory = () => {
      factoryCalls += 1
      return scenarioOf([successScript("ok")])()
    }
    await runPairedAB("QUANTA_REFUSAL_FALLBACK", factory)
    expect(factoryCalls).toBe(2) // one OFF side + one ON side, no reuse
  })
})

// ── (B) CHANGED demonstration on a REAL gate ─────────────────────────────────

describe("DOF-22 A/B harness — CHANGED demo (refusal-fallback, real env gate)", () => {
  test("refusal→success scenario: OFF terminates (refusal), ON re-prompts+completes ⇒ CHANGED", async () => {
    // OFF: wireOptionalAgentPorts(cfg,{}) leaves refusalFallback undefined ⇒ the
    //   refusal is TERMINAL (1 call, reason 'refusal').
    // ON:  wireOptionalAgentPorts(cfg,{QUANTA_REFUSAL_FALLBACK:'on'}) sets the
    //   fallback ⇒ the loop forks+re-prompts once ⇒ the 2nd (success) script
    //   completes (2 calls, reason 'completed', +recovery event).
    const factory = scenarioOf([refusalScript("I can't help with that."), successScript("done")])
    const r = await runPairedAB("QUANTA_REFUSAL_FALLBACK", factory)

    // OFF side — refusal terminal.
    expect(r.off.reason).toBe("refusal")
    expect(r.off.llmCalls).toBe(1)
    expect(r.off.recoveryEvents).toBe(0)

    // ON side — recovered.
    expect(r.on.reason).toBe("completed")
    expect(r.on.llmCalls).toBe(2)
    expect(r.on.recoveryEvents).toBeGreaterThanOrEqual(1)

    // Verdict — the rail SEES the behavior move, and it is NOT a regression
    // (ON's terminal outcome is completed, strictly not worse).
    expect(r.verdict).toBe("CHANGED")
    expect(r.regression).toBeUndefined()
    const axes = r.diffs.map((d) => d.axis)
    expect(axes).toContain("reason")
    expect(axes).toContain("llmCalls")
    expect(axes).toContain("recoveryEvents")
  })
})

// ── (C) NO-REGRESSION demonstrations on REAL gates ───────────────────────────

describe("DOF-22 A/B harness — NO-REGRESSION demos (byte-identical default-OFF)", () => {
  test("refusal-fallback ON on a NON-refusal scenario ⇒ gate never fires ⇒ NO-REGRESSION", async () => {
    // The gate only changes behavior WHEN a refusal occurs. On a clean success
    // scenario the ON path is byte-identical to OFF — exactly the ledger's
    // default-OFF safety claim, proven locally.
    const factory = scenarioOf([successScript("all good")])
    const r = await runPairedAB("QUANTA_REFUSAL_FALLBACK", factory)
    expect(r.verdict).toBe("NO-REGRESSION")
    expect(r.diffs).toHaveLength(0)
    expect(r.off.reason).toBe("completed")
    expect(r.on.reason).toBe("completed")
  })

  test("closeout-critic ON with NO reviewer subagent ⇒ fail-open ⇒ NO-REGRESSION", async () => {
    // wireOptionalAgentPorts(cfg,{QUANTA_CLOSEOUT_CRITIC:'on'}) finds no
    // config.subagent ⇒ materializeReviewerAgent returns undefined ⇒ NO critic
    // port wired ⇒ the completion seal stays byte-identical (fail-open). The
    // rail confirms the ledger's "knob ON but portless ⇒ byte-identical" claim.
    const factory = scenarioOf([successScript("finished the task")])
    const r = await runPairedAB("QUANTA_CLOSEOUT_CRITIC", factory)
    expect(r.verdict).toBe("NO-REGRESSION")
    expect(r.diffs).toHaveLength(0)
    expect(r.off.recoveryEvents).toBe(0)
    expect(r.on.recoveryEvents).toBe(0) // no closeout recovery fired
  })

  test("POSITIVE CONTROL (anti-vacuous): the harness's recovery axis IS live — a wired closeout critic ⇒ CHANGED", async () => {
    // Guards against a FALSE NO-REGRESSION on the closeout channel: if the
    // harness could never OBSERVE a closeout recovery, the fail-open demo above
    // would pass vacuously. Here we make the completion seam actually fire a
    // recovery by injecting a deterministic critic port DIRECTLY on the ON
    // side's base config (no subagent, no network) via the caller-override
    // precedence path, and confirm the harness escalates to CHANGED with a
    // recovery-axis diff. This proves the recoveryEvents axis is NON-vacuous.
    const criticThatDenies = async () => ({
      outcome: "denied" as const,
      rationale: "keep working — task looks incomplete",
      riskLevel: "medium" as const,
    })
    // OFF side: plain scenario (no critic). ON side: same scenario but base
    // config carries an enabled critic port, which wireOptionalAgentPorts
    // preserves (caller-override precedence) ⇒ the loop consults it at closeout
    // ⇒ a `recovery{reason:'closeout'}` event fires.
    let side = 0
    const factory: ScenarioFactory = () => {
      const withCritic = side === 1
      side += 1
      return scenarioOf(
        [successScript("draft answer")],
        withCritic ? { closeoutCritic: { enabled: true, critic: criticThatDenies } } : {},
      )()
    }
    const r = await runPairedAB("QUANTA_CLOSEOUT_CRITIC", factory)
    expect(r.on.recoveryEvents).toBeGreaterThanOrEqual(1)
    expect(r.off.recoveryEvents).toBe(0)
    expect(r.diffs.some((d) => d.axis === "recoveryEvents")).toBe(true)
    expect(r.verdict).toBe("CHANGED")
  })
})
