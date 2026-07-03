/**
 * `runConvergeLoop` policy hellgate — the bounded converge-to-green loop over FAKE ports (no LLM, no
 * session). Pins the two independent over-persist bounds (rounds AND turn-watchdog), the honest stop
 * `reason`, exactly-one-follow-up-per-round, and the no-signal early stops. RED-on-injection: break
 * any bound and a test fails.
 */
import { describe, expect, test } from "bun:test"
import type { Message } from "@/llm"
import { type ConvergePorts, runConvergeLoop, type SelfTestReceipt } from "./index"

/** A scripted receipt sequence: the loop re-reads `inspect()` each round, so `receipts[i]` is what
 *  round i observes. `fed` records every feedback string the loop chose to feed back. */
const fakePorts = (
  receipts: readonly SelfTestReceipt[],
  opts: { turnsPerFollowUp?: number; fairFailNull?: boolean } = {},
): { ports: ConvergePorts; fed: string[]; inspectCalls: () => number } => {
  const fed: string[] = []
  let idx = 0
  let inspectCalls = 0
  const receiptAt = (i: number): SelfTestReceipt =>
    receipts[Math.min(i, receipts.length - 1)] ?? { executed: false, green: false }
  const ports: ConvergePorts = {
    inspect: () => {
      const r = receiptAt(idx)
      inspectCalls += 1
      return r
    },
    fairFail: (receipt) =>
      opts.fairFailNull ? null : { feedback: `fix: ${receipt.evidence ?? "red"}` },
    runFollowUpTurn: async (text) => {
      fed.push(text)
      idx += 1 // next round observes the NEXT scripted receipt
      return { turns: opts.turnsPerFollowUp ?? 1, messages: [] as readonly Message[] }
    },
  }
  return { ports, fed, inspectCalls: () => inspectCalls }
}

const RED: SelfTestReceipt = { executed: true, green: false, evidence: "self-test failed" }
const GREEN: SelfTestReceipt = { executed: true, green: true, evidence: "self-test passed" }
const NONE: SelfTestReceipt = { executed: false, green: false }

describe("runConvergeLoop — bounded converge-to-green policy", () => {
  test("converges: red → (1 follow-up) → green ⇒ converged, rounds=1, reason=green", async () => {
    const { ports, fed } = fakePorts([RED, GREEN])
    const r = await runConvergeLoop(ports, { maxRounds: 4, maxTurns: 100 }, { turnsConsumed: 5, messages: [] })
    expect(r.converged).toBe(true)
    expect(r.rounds).toBe(1)
    expect(r.reason).toBe("green")
    expect(fed).toHaveLength(1) // exactly one follow-up fed back this round
    expect(r.turnsConsumed).toBe(6) // 5 + 1 follow-up turn
  })

  test("no-signal: an UNEXECUTED self-test ⇒ no follow-up, rounds=0, reason=no-signal", async () => {
    const { ports, fed } = fakePorts([NONE])
    const r = await runConvergeLoop(ports, { maxRounds: 4, maxTurns: 100 }, { turnsConsumed: 3, messages: [] })
    expect(r.rounds).toBe(0)
    expect(r.reason).toBe("no-signal")
    expect(fed).toHaveLength(0)
    expect(r.converged).toBe(false)
  })

  test("no-signal: executed-red but fairFail returns null ⇒ never loops blind", async () => {
    const { ports, fed } = fakePorts([RED, RED], { fairFailNull: true })
    const r = await runConvergeLoop(ports, { maxRounds: 4, maxTurns: 100 }, { turnsConsumed: 0, messages: [] })
    expect(r.reason).toBe("no-signal")
    expect(fed).toHaveLength(0)
  })

  test("ROUND bound: stays red every round ⇒ stops at maxRounds, reason=rounds-exhausted", async () => {
    const { ports, fed } = fakePorts([RED, RED, RED, RED, RED, RED])
    const r = await runConvergeLoop(ports, { maxRounds: 3, maxTurns: 100 }, { turnsConsumed: 0, messages: [] })
    expect(r.rounds).toBe(3) // exactly maxRounds — never more
    expect(r.reason).toBe("rounds-exhausted")
    expect(fed).toHaveLength(3) // one follow-up per round, never more
    expect(r.converged).toBe(false)
  })

  test("WATCHDOG bound: turn budget trips BEFORE maxRounds ⇒ reason=watchdog, independent bound", async () => {
    // 10 turns per follow-up, budget 25 ⇒ round0(0<25 ok→10), round1(10<25 ok→20), round2(20<25 ok→30),
    // round3(30>=25 watchdog). Rounds capped by turns, not by maxRounds(=10).
    const { ports, fed } = fakePorts([RED, RED, RED, RED, RED], { turnsPerFollowUp: 10 })
    const r = await runConvergeLoop(ports, { maxRounds: 10, maxTurns: 25 }, { turnsConsumed: 0, messages: [] })
    expect(r.reason).toBe("watchdog")
    expect(fed).toHaveLength(3) // 3 follow-ups fired (0,10,20) then 30>=25 stops
    expect(r.rounds).toBe(3)
    expect(r.converged).toBe(false)
  })

  test("exactly ONE inspect per round decision + a FINAL inspect (no double-drive)", async () => {
    // red,green: round0 inspect(red)→fairFail→follow-up; round1 inspect(green)→break; +final inspect.
    const { ports, inspectCalls } = fakePorts([RED, GREEN])
    await runConvergeLoop(ports, { maxRounds: 4, maxTurns: 100 }, { turnsConsumed: 0, messages: [] })
    expect(inspectCalls()).toBe(3) // round0 + round1 + final converged-check
  })

  test("maxRounds=0 (caller passed a non-positive clamp) ⇒ immediate rounds-exhausted, no turns", async () => {
    const { ports, fed } = fakePorts([RED])
    const r = await runConvergeLoop(ports, { maxRounds: 0, maxTurns: 100 }, { turnsConsumed: 7, messages: [] })
    expect(r.rounds).toBe(0)
    expect(fed).toHaveLength(0)
    expect(r.turnsConsumed).toBe(7) // untouched
  })
})
