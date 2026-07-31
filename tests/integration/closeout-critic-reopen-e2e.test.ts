import { describe, expect, test } from "bun:test"
import type { CloseoutCritic, CloseoutCriticVerdict } from "@/agent"
import { runAgent } from "@/agent"
import type { StreamEvent } from "@/llm"
import { cfg, eventsOf, FakeLLM, RecordingStream, text, toolUse, withTimeout } from "./_harness"

/**
 * TRUE end-to-end for the `closeout-critic-gate` feature, driven by a FAKE LLM
 * through the REAL agent loop (`runAgent`) — NOT the isolated
 * `maybeRunCloseoutCritic` / `runCloseoutCritic` port the unit tests exercise.
 * This closes the `runAgent × scripted == 0` gap the catalog records.
 *
 * The prompt that commissioned this test HYPOTHESISED the subagent-cleanup bug
 * shape: a critic DENY at the completed-seal RE-OPENS the loop (another turn
 * runs). It does NOT. The closeout critic is, by DELIBERATE DESIGN, ADVISORY
 * and NEVER-BLOCKING:
 *
 *   - YAML (closeout-critic-gate.yaml): "'denied' verdict는 … 절대 완료를
 *     차단하지 않음(advisory data only, 제어흐름 불변)".
 *   - wire docstring (closeout-critic-wire.ts): "It is NEVER inspected for
 *     control flow; the loop seals `completed` regardless of the verdict."
 *   - unit hellgate case (c): "DENIED verdict ⇒ advisory event, turn STILL
 *     completes".
 *
 * So the completed-seal-adjacent invariant that IS observable only end-to-end
 * — and that a subagent-cleanup-class regression WOULD break — is the OPPOSITE
 * of a re-open: the DENY must surface as structured data AND the seal must NOT
 * be re-opened (no phantom second turn, no inflated turn count, no corrupted
 * completion). We assert exactly that through the real loop:
 *
 *   1. DENY at the seal ⇒ the critic is REALLY invoked at the seal (proof the
 *      wiring is live through runAgent), the DENY surfaces as a real
 *      `recovery`/`closeout` event with the `critic:` prefix, AND the run
 *      still settles `completed` in exactly ONE turn (the LLM is called EXACTLY
 *      ONCE — no re-open, no phantom re-drive).
 *   2. ALLOW at the seal ⇒ settles cleanly, still one turn, advisory event
 *      carries the approval — no infinite re-open either.
 *   3. Non-vacuity mutation (in-test): a critic that is NEVER wired at all
 *      (knob off) emits ZERO closeout events and the run is byte-identical —
 *      so the assertions in (1)/(2) are load-bearing (they'd go RED if the
 *      seam stopped invoking the critic).
 */

const denyOnce = (): { critic: CloseoutCritic; calls: () => number } => {
  let n = 0
  const critic: CloseoutCritic = async (): Promise<CloseoutCriticVerdict> => {
    n += 1
    return { outcome: "denied", rationale: "unverified claims", riskLevel: "high" }
  }
  return { critic, calls: () => n }
}

const alwaysAllow = (): { critic: CloseoutCritic; calls: () => number } => {
  let n = 0
  const critic: CloseoutCritic = async (): Promise<CloseoutCriticVerdict> => {
    n += 1
    return { outcome: "approved", rationale: "looks good" }
  }
  return { critic, calls: () => n }
}

// A single assistant turn that finishes with plain text (no tool_use) ⇒ the
// loop reaches a completed-seal, which is where the critic gate fires.
const FINISH: StreamEvent[] = text("all done, task complete")

describe("closeout-critic-gate — real loop (runAgent) + fake LLM end-to-end", () => {
  test("DENY at the completed-seal ⇒ advisory event surfaces, loop STILL completes in ONE turn (no re-open)", async () => {
    const llm = new FakeLLM([FINISH])
    const stream = new RecordingStream()
    const { critic, calls } = denyOnce()

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
          closeoutCritic: { enabled: true, critic },
          maxTurns: 5,
        }),
      ),
      10_000,
      "closeout-critic-deny-e2e",
    )

    // The run settled as a clean completion — NOT re-opened, NOT stuck, NOT
    // turned into an error/abort by the DENY.
    expect(out.reason).toBe("completed")

    // The critic actually ran AT THE SEAL through the real loop — exactly once.
    // (If the seam were dead, this would be 0 ⇒ the whole test is non-vacuous.)
    expect(calls()).toBe(1)

    // The DENY surfaced end-to-end as the EXISTING recovery/closeout event with
    // the `critic:` detail prefix — advisory data the host/UI can act on.
    const closeouts = eventsOf(stream, "recovery").filter((e) => e.reason === "closeout")
    expect(closeouts.length).toBe(1)
    expect(closeouts[0]?.detail).toContain("critic:denied")
    expect(closeouts[0]?.detail).toContain("unverified claims")

    // THE completed-seal-adjacent invariant: the DENY did NOT re-open the loop.
    // A subagent-cleanup-class regression (seal re-opened / re-driven) would
    // manifest as a SECOND LLM call and/or an inflated turn count. Both must be
    // exactly one.
    expect(llm.calls).toBe(1)
    expect(out.turns).toBe(1)
  })

  test("ALLOW at the completed-seal ⇒ settles cleanly in ONE turn, no infinite re-open", async () => {
    const llm = new FakeLLM([FINISH])
    const stream = new RecordingStream()
    const { critic, calls } = alwaysAllow()

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
          closeoutCritic: { enabled: true, critic },
          maxTurns: 5,
        }),
      ),
      10_000,
      "closeout-critic-allow-e2e",
    )

    expect(out.reason).toBe("completed")
    expect(calls()).toBe(1)
    // ALLOW still surfaces one advisory event carrying the approval; the run is
    // one turn (no re-open loop).
    const closeouts = eventsOf(stream, "recovery").filter((e) => e.reason === "closeout")
    expect(closeouts.length).toBe(1)
    expect(closeouts[0]?.detail).toContain("critic:approved")
    expect(llm.calls).toBe(1)
    expect(out.turns).toBe(1)
  })

  test("the DENY gate also fires at the SECOND seal site (no-tool-call proceed) end-to-end", async () => {
    // The gate is wired at BOTH completed-seal sites in applyAction. Drive a
    // turn that issues a tool_use first (so a tool_result round-trips) and THEN
    // finishes with plain text — exercising the loop past the tool path into
    // the no-tool-call completed seal. The critic must still fire exactly once
    // at the seal and the run completes without re-opening.
    const llm = new FakeLLM([toolUse("t1", "read_file", { path: "/tmp/x" }), FINISH])
    const stream = new RecordingStream()
    const { critic, calls } = denyOnce()

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
          closeoutCritic: { enabled: true, critic },
          maxTurns: 5,
        }),
      ),
      10_000,
      "closeout-critic-second-seal-e2e",
    )

    expect(out.reason).toBe("completed")
    // Two LLM turns (tool turn + finish turn), but the critic fires exactly
    // ONCE — only at the completed seal, not on the tool turn.
    expect(llm.calls).toBe(2)
    expect(calls()).toBe(1)
    const closeouts = eventsOf(stream, "recovery").filter((e) => e.reason === "closeout")
    expect(closeouts.length).toBe(1)
    expect(closeouts[0]?.detail).toContain("critic:denied")
  })

  test("NON-VACUITY: knob OFF (no closeoutCritic) ⇒ ZERO closeout events, run byte-identical", async () => {
    // Neuters the seam (the mutation that proves (1)/(2) are load-bearing): with
    // the critic UNWIRED the completed-seal emits NO closeout event and the run
    // still completes in one turn. If the assertions above were vacuous (e.g.
    // matching on some always-present event), this control would also emit a
    // closeout event and fail.
    const llm = new FakeLLM([FINISH])
    const stream = new RecordingStream()

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
          // closeoutCritic intentionally ABSENT ⇒ OFF gate.
          maxTurns: 5,
        }),
      ),
      10_000,
      "closeout-critic-off-e2e",
    )

    expect(out.reason).toBe("completed")
    expect(out.turns).toBe(1)
    expect(llm.calls).toBe(1)
    const closeouts = eventsOf(stream, "recovery").filter((e) => e.reason === "closeout")
    expect(closeouts.length).toBe(0)
  })
})
