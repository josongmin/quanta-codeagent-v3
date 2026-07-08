/**
 * `runConvergeProtocol` generic hellgate — the surface-neutral converge policy over a FAKE verdict
 * type (no self-test, no patch, no LLM). Pins the two over-persist bounds (rounds AND turn-watchdog),
 * the honest stop `reason`, `actionable` gating, and carry threading — independent of ANY surface
 * vocabulary. loop.test.ts pins the terminal SPECIALIZATION on top of this.
 */
import { describe, expect, test } from "bun:test"
import { type ConvergeProtocol, runConvergeProtocol } from "./protocol"

/** A minimal fake verdict + protocol driven by a scripted verdict sequence. `carry` is a plain
 *  string counter so we can assert threading without any surface type. */
interface FakeVerdict {
  readonly green: boolean
  readonly actionable: boolean
}
const fake = (
  verdicts: readonly FakeVerdict[],
  opts: { turnsPerGen?: number; feedbackNull?: boolean } = {},
): { proto: ConvergeProtocol<FakeVerdict, string>; gens: string[] } => {
  const gens: string[] = []
  let idx = 0
  const at = (i: number): FakeVerdict => verdicts[Math.min(i, verdicts.length - 1)] ?? { green: false, actionable: false }
  const proto: ConvergeProtocol<FakeVerdict, string> = {
    judge: () => at(idx),
    feedback: () => (opts.feedbackNull ? null : { feedback: "fix" }),
    generate: async (text) => {
      gens.push(text)
      idx += 1
      return { turns: opts.turnsPerGen ?? 1, carry: `gen${idx}` }
    },
  }
  return { proto, gens }
}

const RED: FakeVerdict = { green: false, actionable: true }
const GREEN: FakeVerdict = { green: true, actionable: true }
const INERT: FakeVerdict = { green: false, actionable: false }

describe("runConvergeProtocol — surface-neutral bounded convergence", () => {
  test("converges: red → 1 gen → green ⇒ reason=green, converged, carry threaded", async () => {
    const { proto, gens } = fake([RED, GREEN])
    const o = await runConvergeProtocol(proto, { maxRounds: 4, maxTurns: 100 }, { turnsConsumed: 5, carry: "init" })
    expect(o.converged).toBe(true)
    expect(o.reason).toBe("green")
    expect(o.rounds).toBe(1)
    expect(o.turnsConsumed).toBe(6)
    expect(o.carry).toBe("gen1") // carry updated by the one generation
    expect(gens).toHaveLength(1)
  })

  // ALBB-21 — the maxRounds=1 RED→green case. The maxRounds=4 test above has
  // SLACK: the in-loop `verdict.green` break fires on the RE-ENTERED round so
  // `reason` gets set to "green" by the loop body. With maxRounds=1 the single
  // round judges RED → repairs to green → `rounds=1`, and the `while` guard
  // `1 < 1` EXITS via the bound BEFORE the green break can run. The terminal
  // judge is green ⇒ `converged: true`, but a bug that leaves `reason` at the
  // loop body's last value telemetries a CONVERGED run as "rounds-exhausted".
  // reason/converged MUST both derive from the ONE final judge.
  test("maxRounds=1: red → 1 gen → green ⇒ converged AND reason=green (no rounds-exhausted mask)", async () => {
    const { proto, gens } = fake([RED, GREEN])
    const o = await runConvergeProtocol(proto, { maxRounds: 1, maxTurns: 100 }, { turnsConsumed: 0, carry: "init" })
    expect(o.converged).toBe(true)
    expect(o.reason).toBe("green")
    expect(o.rounds).toBe(1)
    expect(gens).toHaveLength(1)
  })

  test("non-actionable verdict ⇒ no-signal, 0 rounds, carry untouched", async () => {
    const { proto, gens } = fake([INERT])
    const o = await runConvergeProtocol(proto, { maxRounds: 4, maxTurns: 100 }, { turnsConsumed: 3, carry: "init" })
    expect(o.reason).toBe("no-signal")
    expect(o.rounds).toBe(0)
    expect(o.carry).toBe("init")
    expect(gens).toHaveLength(0)
  })

  test("feedback null ⇒ no-signal (never loops blind)", async () => {
    const { proto, gens } = fake([RED, RED], { feedbackNull: true })
    const o = await runConvergeProtocol(proto, { maxRounds: 4, maxTurns: 100 }, { turnsConsumed: 0, carry: "x" })
    expect(o.reason).toBe("no-signal")
    expect(gens).toHaveLength(0)
  })

  test("ROUND bound: stays red ⇒ exactly maxRounds gens, reason=rounds-exhausted", async () => {
    const { proto, gens } = fake([RED, RED, RED, RED, RED])
    const o = await runConvergeProtocol(proto, { maxRounds: 3, maxTurns: 100 }, { turnsConsumed: 0, carry: "x" })
    expect(o.rounds).toBe(3)
    expect(o.reason).toBe("rounds-exhausted")
    expect(gens).toHaveLength(3)
    expect(o.converged).toBe(false)
  })

  test("WATCHDOG bound: turn budget trips before maxRounds (independent bound)", async () => {
    const { proto, gens } = fake([RED, RED, RED, RED, RED], { turnsPerGen: 10 })
    const o = await runConvergeProtocol(proto, { maxRounds: 10, maxTurns: 25 }, { turnsConsumed: 0, carry: "x" })
    expect(o.reason).toBe("watchdog")
    expect(gens).toHaveLength(3) // 0,10,20 fire; 30>=25 stops
    expect(o.rounds).toBe(3)
  })

  test("maxRounds=0 ⇒ immediate rounds-exhausted, no gen, carry/turns untouched", async () => {
    const { proto, gens } = fake([RED])
    const o = await runConvergeProtocol(proto, { maxRounds: 0, maxTurns: 100 }, { turnsConsumed: 7, carry: "init" })
    expect(o.rounds).toBe(0)
    expect(o.turnsConsumed).toBe(7)
    expect(o.carry).toBe("init")
    expect(gens).toHaveLength(0)
  })
})
