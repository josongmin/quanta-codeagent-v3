/**
 * DOF-22 — RAIL-1 (LOCAL behavior-regression) SWEEP across the behavioral-flip
 * gates, using the EXISTING paired A/B harness (`./_ab-default-harness.ts`,
 * `runPairedAB`) UNMODIFIED. This suite is the rail-1 clearance record: for each
 * behavioral gate it runs the SAME scripted-LLM scenario twice through the REAL
 * `runAgent` (delta = the wire env handed to `wireOptionalAgentPorts`) and pins
 * a paired verdict.
 *
 * WHAT RAIL-1 CLEARS (and what it does NOT)
 * -----------------------------------------
 * Rail-1 = "does the ON path regress the OFF path's OBSERVABLE behavior on a
 * neutral scenario?" A NO-REGRESSION on a NEUTRAL scenario proves the gate's
 * default-OFF is byte-identical THROUGH THE WIRE SEAM. Rail-2 (SWE picks A/B
 * efficacy, EC2, operator-only) is a SEPARATE, EXPENSIVE rail and is NOT run
 * here — clearing rail-1 is necessary-not-sufficient to flip a gate default-ON.
 *
 * NON-VACUITY DISCIPLINE (why a NEUTRAL NO-REGRESSION alone is not enough)
 * -----------------------------------------------------------------------
 * A NEUTRAL NO-REGRESSION is only meaningful if the harness CAN see the gate
 * when it DOES fire — otherwise NO-REGRESSION could be a false pass from a gate
 * the harness structurally cannot reach. So for every gate that flows through
 * `wireOptionalAgentPorts` we ALSO pin a TRIGGERING scenario that yields CHANGED
 * (gate fires ⇒ observable delta on a real axis: recoveryEvents / reason /
 * llmCalls), plus a RED-ON-INJECTION control (force the gate OFF on the SAME
 * triggering scenario ⇒ the delta VANISHES ⇒ NO-REGRESSION), which binds the
 * CHANGED verdict to the gate itself, not to the scenario shape.
 *
 * REACHABILITY (the load-bearing finding of this sweep)
 * -----------------------------------------------------
 * `runPairedAB` varies ONLY the env argument to `wireOptionalAgentPorts`. It
 * never mutates `process.env` and never touches the `@/shared` knob-override
 * store. THEREFORE only gates whose behavior flows through
 * `wireOptionalAgentPorts(base, env)` are reachable by this harness:
 *
 *   REACHABLE (wired via wireOptionalAgentPorts):
 *     - QUANTA_REFUSAL_FALLBACK  (wireRefusalFallback → cfg.refusalFallback) —
 *         FULLY reachable: env alone flips behavior end-to-end (refusal→recover).
 *     - QUANTA_CLOSEOUT_CRITIC   (wireCloseoutCritic  → cfg.closeoutCritic.critic)
 *         — PARTIALLY reachable: the env WIRES the critic PORT, but
 *         `maybeRunCloseoutCritic` also needs `closeoutCritic.enabled:true`, set
 *         by a SEPARATE knob-apply seam (wireInteractiveKnobs) this harness does
 *         NOT run — so the env gate does NOT fire the critic END-TO-END here
 *         (empirically probed: on.recovery=0 even with a subagent block). What
 *         IS proven: the recoveryEvents AXIS is live (caller-override critic port).
 *         Follow-up: a knob-apply+subagent factory to gate closeout end-to-end.
 *
 *   UNREACHABLE via this harness (ride `runtimeConfig()` / an assembler env,
 *   i.e. `process.env`, NOT the wire env — verified against src on base
 *   ccb8480b7; see the `unreachable` describe block, which does NOT fabricate a
 *   verdict but instead PROVES vacuity):
 *     - QUANTA_CAP_ENFORCE        (loop-helpers#attachCapEnforcer →
 *                                  buildCapEnforcer → runtimeConfig().capEnforce)
 *     - QUANTA_ADAPTIVE_THINKING  (loop/skill-gate → runtimeConfig().adaptiveThinking)
 *     - QUANTA_EDIT_REPAIR_LOOP   (host/agent-config-assembler#editRepairLoopEnabled(env)
 *                                  + dispatch/edit-repair → runtimeConfig().editRepairLoop)
 *     - prompt-directive bundle   (buildSystemPrompt → runtimeConfig().directive*)
 *     - QUANTA_SUBAGENT_DELEGATE_SUPPRESS (delegation-policy → gateOn over the
 *                                  assembler env / tool-description projection)
 *
 * For the UNREACHABLE gates the FOLLOW-UP is a SEPARATE rail: a runtimeConfig-
 * seam paired factory (drive `__resetRuntimeConfig()` around a `process.env`
 * snapshot, or the knob-override store) — NOT this wire-env harness. This suite
 * demonstrates the vacuity so a maintainer does not mistake a wire-env
 * NO-REGRESSION for a real rail-1 clearance on those gates.
 *
 * HERMETIC: no network, no box, no `process.env` mutation. Deterministic.
 */

import { beforeEach, describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { __resetCloseoutCriticWarning, wireOptionalAgentPorts } from "@/agent/optional-ports"
import type { LLMPort, StreamEvent, StreamInput, SystemPromptInput } from "@/llm"
import {
  runPairedAB,
  type Scenario,
  type ScenarioFactory,
} from "./_ab-default-harness"
import { cfg, FakeLLM, RecordingStream } from "./_harness"

// ── scripted-LLM building blocks (same idiom as the harness self-test) ───────

const refusalScript = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "message_stop", stop_reason: "refusal" },
]
const successScript = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "message_stop", stop_reason: "end_turn" },
]

/** Strict scripted LLM: replays scripts in order, THROWS when over-called (so an
 *  over-retrying loop surfaces RED, never a silent spin). Records the call count
 *  + first system prompt so the harness's systemBytes axis is fed. */
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

/** Build a Scenario from a scripts list + optional per-side config overrides. */
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

beforeEach(() => {
  // The closeout-critic "knob on but no reviewer" warning is once-per-process;
  // reset so each closeout case exercises the same fresh path deterministically.
  __resetCloseoutCriticWarning()
})

// ─────────────────────────────────────────────────────────────────────────────
// REACHABLE GATE 1 — refusal-fallback (QUANTA_REFUSAL_FALLBACK)
//   TRIGGER: an LLM turn that stops with stop_reason:"refusal", followed by a
//            success script. OFF ⇒ refusal terminal (1 call). ON ⇒ the loop
//            forks + re-prompts once ⇒ the 2nd (success) script completes
//            (2 calls, +recovery event).
// ─────────────────────────────────────────────────────────────────────────────

describe("DOF-22 rail-1 sweep — refusal-fallback (REACHABLE via wireOptionalAgentPorts)", () => {
  test("NEUTRAL (non-refusal success) ⇒ gate never fires ⇒ NO-REGRESSION (byte-identical default-OFF)", async () => {
    const factory = scenarioOf([successScript("all good")])
    const r = await runPairedAB("QUANTA_REFUSAL_FALLBACK", factory)
    expect(r.verdict).toBe("NO-REGRESSION")
    expect(r.diffs).toHaveLength(0)
    // Non-vacuity of the NEUTRAL pass is established by the TRIGGERING case
    // below (same env seam, same axes) — the harness DOES see this gate fire.
    expect(r.off.reason).toBe("completed")
    expect(r.on.reason).toBe("completed")
  })

  test("TRIGGERING (refusal→success) ⇒ gate fires ⇒ CHANGED (recovery + reason + llmCalls delta)", async () => {
    const factory = scenarioOf([refusalScript("I can't help with that."), successScript("done")])
    const r = await runPairedAB("QUANTA_REFUSAL_FALLBACK", factory)

    // OFF branch: gate absent ⇒ refusal is terminal (branch NOT entered).
    expect(r.off.reason).toBe("refusal")
    expect(r.off.llmCalls).toBe(1)
    expect(r.off.recoveryEvents).toBe(0)

    // ON branch ENTERED — the recovery event is the OBSERVABLE SIGNAL the
    // wireRefusalFallback branch actually ran (not a vacuous pass).
    expect(r.on.reason).toBe("completed")
    expect(r.on.llmCalls).toBe(2)
    expect(r.on.recoveryEvents).toBeGreaterThanOrEqual(1)

    expect(r.verdict).toBe("CHANGED")
    expect(r.regression).toBeUndefined()
    const axes = r.diffs.map((d) => d.axis)
    expect(axes).toContain("reason")
    expect(axes).toContain("recoveryEvents")
  })

  test("RED-ON-INJECTION: force the gate OFF on BOTH sides of the TRIGGERING scenario ⇒ delta VANISHES ⇒ NO-REGRESSION", async () => {
    // Bind the CHANGED verdict above to the GATE, not the scenario shape: the
    // ONLY thing runPairedAB varies is the env key. Sweep the SAME refusal→
    // success scenario under a DIFFERENT, unrelated env key so the ON side never
    // wires refusalFallback. Both sides now hit the refusal-terminal path ⇒
    // identical ⇒ NO-REGRESSION. If this were CHANGED, the CHANGED above would be
    // attributable to something other than the refusal gate — it is not.
    const factory = scenarioOf([refusalScript("nope"), successScript("done")])
    const r = await runPairedAB("QUANTA_UNRELATED_NOOP_ENV", factory)
    expect(r.verdict).toBe("NO-REGRESSION")
    expect(r.off.reason).toBe("refusal")
    expect(r.on.reason).toBe("refusal") // gate NOT wired ⇒ still terminal
    expect(r.on.recoveryEvents).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// REACHABLE GATE 2 — closeout-critic (QUANTA_CLOSEOUT_CRITIC)
//   AUDITED LIMITATION (verified against src, base ccb8480b7): the env key alone
//   does NOT fire closeout end-to-end through wireOptionalAgentPorts. Two reasons
//   stack:
//     (i)  with no reviewer subagent, wireCloseoutCritic materializes no port
//          (fail-open) — the env-only NEUTRAL path is byte-identical; AND
//     (ii) even WITH a `config.subagent` block, wireCloseoutCritic sets only
//          `closeoutCritic.critic`, NOT `closeoutCritic.enabled:true` — that
//          `enabled` flag comes from a SEPARATE knob-apply seam
//          (`wireInteractiveKnobs`) this harness does NOT run — and
//          `maybeRunCloseoutCritic` requires `enabled===true`, so the recovery
//          never fires via the env gate alone (empirically probed: on.recovery=0,
//          the review child is never even invoked).
//   So the closeout ENV GATE's end-to-end firing is NOT fully reachable by this
//   wire-env harness (it needs the knob-apply seam too — a follow-up, below).
//   What IS reachable + proven here: the harness's recoveryEvents AXIS is LIVE.
//   We prove that by injecting a deterministic `{enabled:true,critic}` port on the
//   ON side's BASE config (caller-override precedence, which wireCloseoutCritic
//   preserves) — the loop consults it at closeout and a recovery{reason:"closeout"}
//   event fires. This is the harness's own positive-control pattern
//   (ab-default-harness.test.ts) and binds the recovery axis to a real port, NOT
//   to the scenario shape.
// ─────────────────────────────────────────────────────────────────────────────

describe("DOF-22 rail-1 sweep — closeout-critic (REACHABLE via wireOptionalAgentPorts)", () => {
  test("NEUTRAL (env key only, no reviewer subagent) ⇒ fail-open ⇒ NO-REGRESSION (byte-identical default-OFF)", async () => {
    const factory = scenarioOf([successScript("finished the task")])
    const r = await runPairedAB("QUANTA_CLOSEOUT_CRITIC", factory)
    expect(r.verdict).toBe("NO-REGRESSION")
    expect(r.diffs).toHaveLength(0)
    expect(r.off.recoveryEvents).toBe(0)
    expect(r.on.recoveryEvents).toBe(0) // no closeout recovery fired
  })

  const criticThatDenies = async () => ({
    outcome: "denied" as const,
    rationale: "keep working — task looks incomplete",
    riskLevel: "medium" as const,
  })

  test("AXIS-LIVE (ON side carries an enabled critic port via caller-override) ⇒ closeout consulted ⇒ CHANGED (recovery{closeout})", async () => {
    // OFF side: plain scenario. ON side: SAME scenario but the base config
    // carries an ENABLED critic port. wireCloseoutCritic preserves it
    // (caller-override precedence) ⇒ the completion seam consults it ⇒ a
    // recovery event fires. This proves the recoveryEvents AXIS is LIVE — the
    // closeout branch CAN be observed when a real critic port is present. (It
    // does NOT by itself prove the ENV GATE fires end-to-end; see the AUDITED
    // LIMITATION above — that additionally needs the knob-apply `enabled:true`.)
    let side = 0
    const factory: ScenarioFactory = () => {
      const withCritic = side === 1 // 0 = OFF side, 1 = ON side
      side += 1
      return scenarioOf(
        [successScript("draft answer")],
        withCritic ? { closeoutCritic: { enabled: true, critic: criticThatDenies } } : {},
      )()
    }
    const r = await runPairedAB("QUANTA_CLOSEOUT_CRITIC", factory)
    expect(r.off.recoveryEvents).toBe(0)
    expect(r.on.recoveryEvents).toBeGreaterThanOrEqual(1)
    expect(r.diffs.some((d) => d.axis === "recoveryEvents")).toBe(true)
    expect(r.verdict).toBe("CHANGED")
  })

  test("RED-ON-INJECTION: DROP the injected critic (neither side carries it) ⇒ closeout delta VANISHES ⇒ NO-REGRESSION", async () => {
    // Bind the CHANGED above to the WIRED CRITIC PORT, not to the scenario shape:
    // run the SAME success scenario under QUANTA_CLOSEOUT_CRITIC but WITHOUT
    // injecting a critic on the ON side. wireCloseoutCritic under this env DOES
    // run, but with no reviewer subagent it fails open ⇒ no port ⇒ enabled never
    // set ⇒ maybeRunCloseoutCritic short-circuits ⇒ no recovery ⇒ NO-REGRESSION.
    // So the recovery delta above is caused by the injected critic PORT the loop
    // consults, NOT by the closeout env key. (This is also the exact NEUTRAL
    // env-only path — confirming the env key alone is byte-identical here.)
    const factory = scenarioOf([successScript("draft answer")])
    const r = await runPairedAB("QUANTA_CLOSEOUT_CRITIC", factory)
    expect(r.verdict).toBe("NO-REGRESSION")
    expect(r.off.recoveryEvents).toBe(0)
    expect(r.on.recoveryEvents).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// UNREACHABLE GATES — cap-enforce / adaptive-thinking / edit-repair-loop
//                     (+ prompt-directive / delegation-suppress noted in the
//                      file header). These ride runtimeConfig()/an assembler env
//                      (i.e. process.env), NOT the wireOptionalAgentPorts env.
//
// We do NOT fabricate a rail-1 verdict for them. Instead we PROVE the vacuity:
// running the harness across these env keys yields NO-REGRESSION on a NEUTRAL
// scenario NOT because the ON path was proven non-regressing, but because the
// env delta never reaches the gate (both sides identical for a reason unrelated
// to safety). A maintainer must NOT read these as rail-1 clearance.
//
// FOLLOW-UP (why + ROI): a separate runtimeConfig-seam paired factory — snapshot
// process.env, drive __resetRuntimeConfig() around a {gate:"1"} bag on the ON
// side (or use the @/shared knob-override store) — is required to actually
// exercise + regression-gate these gates locally. Without it, flipping any of
// them default-ON has NO local rail-1 proof. (This sweep's job is to make that
// gap explicit, not to paper over it.)
// ─────────────────────────────────────────────────────────────────────────────

describe("DOF-22 rail-1 sweep — UNREACHABLE gates (vacuity PROOF, not a verdict)", () => {
  const UNREACHABLE_ENV_KEYS = [
    "QUANTA_CAP_ENFORCE",
    "QUANTA_ADAPTIVE_THINKING",
    "QUANTA_EDIT_REPAIR_LOOP",
    "QUANTA_DIRECTIVE_AUTONOMOUS",
    "QUANTA_SUBAGENT_DELEGATE_SUPPRESS",
  ] as const

  test("STRUCTURAL PROOF of unreachability: wireOptionalAgentPorts leaves the config byte-identical under these env keys (the seam never applies the gate)", () => {
    // The LOAD-BEARING, non-tautological proof: for each unreachable key, wiring
    // the base config with `{key:"on"}` produces a config whose OWN keys AND
    // gate-relevant slot values are IDENTICAL to wiring with `{}`. i.e. the wire
    // seam does not even LOOK at these keys — so any A/B run over them is vacuous
    // by construction, not by coincidence of a neutral scenario. Contrast with a
    // REACHABLE key (refusal-fallback), which DOES mutate a slot — asserted last.
    const base = cfg({ llm: new FakeLLM() })
    for (const key of UNREACHABLE_ENV_KEYS) {
      const off = wireOptionalAgentPorts(base, {})
      const on = wireOptionalAgentPorts(base, { [key]: "on" })
      // Same own-key set (no slot added/removed by the gate).
      expect(Object.keys(on).sort()).toEqual(Object.keys(off).sort())
      // The gate's would-be config slots are untouched by the wire (they live on
      // runtimeConfig/an assembler env, not here).
      expect((on as Record<string, unknown>).capEnforce).toBe(
        (off as Record<string, unknown>).capEnforce,
      )
      expect((on as Record<string, unknown>).capEnforcer).toBe(
        (off as Record<string, unknown>).capEnforcer,
      )
    }
    // POSITIVE CONTROL — the SAME seam DOES mutate a slot for a REACHABLE key, so
    // the byte-identical result above is a property of the unreachable keys, not a
    // wire that ignores its env argument wholesale.
    const offR = wireOptionalAgentPorts(base, {})
    const onR = wireOptionalAgentPorts(base, { QUANTA_REFUSAL_FALLBACK: "on" })
    expect(offR.refusalFallback).toBeUndefined()
    expect(onR.refusalFallback?.enabled).toBe(true)
  })

  test("the wire-env seam does NOT reach these gates ⇒ NO-REGRESSION is VACUOUS (delta never applied)", async () => {
    // A neutral tool-free success scenario. For a gate the wire env COULD reach,
    // the ON/OFF result would still be NO-REGRESSION here (neutral) — but the
    // point is the OPPOSITE: even a maximally TRIGGERING scenario cannot move
    // these axes through this seam, because runPairedAB never sets process.env.
    // The proof that the env is inert for these keys is the same as it is for a
    // completely made-up key: NO-REGRESSION, identically. We assert exactly that
    // equivalence — the harness treats a real runtimeConfig key the same as a
    // nonexistent one, i.e. it cannot see it.
    for (const key of UNREACHABLE_ENV_KEYS) {
      const real = await runPairedAB(key, scenarioOf([successScript("neutral")]))
      const fake = await runPairedAB("QUANTA_TOTALLY_NONEXISTENT_KEY", scenarioOf([successScript("neutral")]))
      expect(real.verdict).toBe("NO-REGRESSION")
      // Same verdict + same diff shape as a nonexistent key ⇒ the harness is
      // BLIND to this gate through the wire-env seam (structural vacuity).
      expect(real.verdict).toBe(fake.verdict)
      expect(real.diffs).toHaveLength(fake.diffs.length)
    }
  })

  test("ANTI-VACUITY GUARD: the SAME harness+seam DOES distinguish a REACHABLE gate (control) — so the vacuity above is a property of the gate, not the harness", async () => {
    // If the harness were blind to EVERYTHING, the vacuity proof would be
    // meaningless. Control: a reachable gate on its triggering scenario yields
    // CHANGED through the exact same runPairedAB seam. So the NO-REGRESSION on
    // the unreachable keys is a fact about THOSE gates' wiring, not a dead harness.
    const reachable = await runPairedAB(
      "QUANTA_REFUSAL_FALLBACK",
      scenarioOf([refusalScript("no"), successScript("ok")]),
    )
    expect(reachable.verdict).toBe("CHANGED")
  })
})
