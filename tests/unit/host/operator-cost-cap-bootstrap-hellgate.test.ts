/**
 * HELLGATE — operator cost cap reaches the CLI / interactive (bootstrap-session)
 * surface.
 *
 * The autonomous modes get a cost cap from the mode-preset assembler, but the
 * CLI / interactive REPL is bootstrapped separately (bootstrap-session) and was
 * human-paced / uncapped — a real-LLM run proved the cap silently did NOT engage
 * there (config.budgetMeter was undefined). `parseOperatorCostDials` resolves the
 * `QUANTA_MAX_COST_USD` / `QUANTA_MAX_COST_PER_TURN_USD` knobs so a human can pin
 * a dollar ceiling on a long REPL session; bootstrap-session mints a meter with
 * these dials when present. Real-LLM end-to-end proof lives in the run log
 * (budget_exhausted at cost_usd used=$0.0046 limit=$0.0001).
 */
import { describe, expect, test } from "bun:test"
import { parseOperatorCostDials } from "@/host/bootstrap/bootstrap-session"

describe("HELLGATE — operator cost-cap dials (CLI/interactive surface)", () => {
  test("absent ⇒ empty dials (byte-identical: meter stays dial-less)", () => {
    expect(parseOperatorCostDials({})).toEqual({})
  })

  test("QUANTA_MAX_COST_USD ⇒ maxCostUsd dial", () => {
    expect(parseOperatorCostDials({ QUANTA_MAX_COST_USD: "0.05" })).toEqual({ maxCostUsd: 0.05 })
  })

  test("QUANTA_MAX_COST_PER_TURN_USD ⇒ maxCostPerTurnUsd dial", () => {
    expect(parseOperatorCostDials({ QUANTA_MAX_COST_PER_TURN_USD: "0.01" })).toEqual({
      maxCostPerTurnUsd: 0.01,
    })
  })

  test("both ⇒ both dials", () => {
    expect(
      parseOperatorCostDials({ QUANTA_MAX_COST_USD: "2", QUANTA_MAX_COST_PER_TURN_USD: "0.5" }),
    ).toEqual({ maxCostUsd: 2, maxCostPerTurnUsd: 0.5 })
  })

  test("garbage / non-positive ⇒ omitted (no-heuristics, no silent default)", () => {
    for (const bad of ["0", "-1", "abc", "", "  "]) {
      expect(parseOperatorCostDials({ QUANTA_MAX_COST_USD: bad })).toEqual({})
    }
  })
})
