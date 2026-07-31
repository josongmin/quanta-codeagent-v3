/**
 * H3 (jul-4 hexagonal F2 / OCP) — the per-turn stop-condition registry. Pins each extracted
 * condition's gate + finish semantics over a minimal fake ctx (no loop, no LLM), and that the
 * default arrays hold exactly today's two conditions in order. RED-on-injection: a mis-gated
 * condition (fires when the meter/ledger is unset) fails; a reordered/removed default fails.
 */
import { describe, expect, test } from "bun:test"
import {
  costPreflightCondition,
  DEFAULT_POST_CONTINUE_STOP_CONDITIONS,
  DEFAULT_PRE_TURN_STOP_CONDITIONS,
  ledgerHardBreachCondition,
} from "./stop-conditions"
import type { RunAgentContext } from "./types"

/** Build a fake ctx exposing only the fields the conditions read. `cfg` is assembled via spread so
 *  an absent key is truly OMITTED (exactOptionalPropertyTypes: never an explicit `undefined`). */
const fakeCtx = (over: {
  budgetMeter?: unknown
  // `| undefined` on the optional field: the tests pass `{ budgetLedger: undefined }` to mean "unset",
  // which under exactOptionalPropertyTypes is NOT assignable to a bare `field?:` — the union permits
  // the explicit-undefined call form. (bun test never type-checks this file, so this only surfaces
  // under `typecheck:all`; caught by jul-4 audit R3.)
  budgetLedger?: { hardBreach: () => { limit: number; observed: number } | undefined } | undefined
}): RunAgentContext =>
  ({
    cfg: {
      ...(over.budgetMeter !== undefined ? { budgetMeter: over.budgetMeter } : {}),
      ...(over.budgetLedger !== undefined ? { budgetLedger: over.budgetLedger } : {}),
      decisionEmitter: undefined, // emitBudgetExhaustedDecision no-ops on an absent emitter
    },
    wm: {},
    session: { skillGate: undefined },
  }) as unknown as RunAgentContext

describe("stop-conditions registry (H3)", () => {
  test("default arrays hold exactly today's conditions, in order (OCP surface pin)", () => {
    expect(DEFAULT_PRE_TURN_STOP_CONDITIONS).toEqual([costPreflightCondition])
    expect(DEFAULT_POST_CONTINUE_STOP_CONDITIONS).toEqual([ledgerHardBreachCondition])
  })

  test("costPreflight: no budgetMeter ⇒ undefined (byte-identical default-OFF, no model resolve)", async () => {
    expect(await costPreflightCondition(fakeCtx({ budgetMeter: undefined }), 3)).toBeUndefined()
  })

  // FIRING-path turn contract (jul-4 audit F3): when costPreflight DOES fire it returns `turn - 1`
  // (this turn produced no model output), asymmetric to ledger's `turn`. The condition body is a
  // VERBATIM extract of the old loop's inline block (byte-identity verified), and its firing path
  // (priced model + an exceeded meter) is exercised by the loop e2e's `budget_exhausted` reason
  // assertions; a dedicated firing unit would have to stub the whole costUsd/sticky/candidates chain
  // for the same `turn - 1` the ledger test already contrasts against. Pinned here as the contract:
  test("costPreflight vs ledger turn asymmetry is intentional (turn-1 pre-model vs turn post-run)", () => {
    // ledger fires with `turn` (the turn ran); costPreflight, when it fires, uses `turn - 1`.
    const ledgerStop = ledgerHardBreachCondition(
      fakeCtx({ budgetLedger: { hardBreach: () => ({ limit: 1, observed: 2 }) } }),
      5,
    )
    expect(ledgerStop?.turns).toBe(5)
    // (the costPreflight `turn - 1` branch is the verbatim old-loop code; see comment above.)
  })

  test("ledgerHardBreach: no ledger ⇒ undefined (default-OFF)", () => {
    expect(ledgerHardBreachCondition(fakeCtx({ budgetLedger: undefined }), 3)).toBeUndefined()
  })

  test("ledgerHardBreach: no breach ⇒ undefined; a breach ⇒ stop at `turn` with budget_exhausted", () => {
    expect(
      ledgerHardBreachCondition(fakeCtx({ budgetLedger: { hardBreach: () => undefined } }), 3),
    ).toBeUndefined()
    const stop = ledgerHardBreachCondition(
      fakeCtx({ budgetLedger: { hardBreach: () => ({ limit: 10, observed: 12 }) } }),
      5,
    )
    expect(stop?.reason).toBe("budget_exhausted")
    expect(stop?.turns).toBe(5) // ledger uses `turn` (the turn DID run), not turn-1
  })

  // ALBB-17 claim 1 — budget label fidelity. A budget/cost-cap terminal must carry
  // a `budget`-bucket stopCategory (NOT `max_turns`), so a surface can distinguish a
  // cost-cap kill from an exhausted-turns stop. RED-on-injection: reverting either
  // firing site to `completedCategory("max_turns")` turns these red.
  test("ledgerHardBreach firing ⇒ stopCategory kind=budget, code budget.ledger_breach (NOT max_turns)", () => {
    const stop = ledgerHardBreachCondition(
      fakeCtx({ budgetLedger: { hardBreach: () => ({ limit: 10, observed: 12 }) } }),
      5,
    )
    expect(stop?.stopCategory.kind).toBe("budget")
    expect(stop?.stopCategory.reasonCode).toBe("budget.ledger_breach")
    expect(stop?.stopCategory.reasonCode.startsWith("budget.")).toBe(true)
    // paired control: the misleading maxTurns hint must be gone
    expect(stop?.stopCategory.hint).not.toBe("Reached the configured maxTurns limit.")
    expect(stop?.stopCategory.kind).not.toBe("max_turns")
  })

  // ALBB-17 claim 1 — L2 cost pre-flight firing site. Uses a priced model
  // (`gpt-5.4`) + a wm with content so `projectCostPreflight` computes a real
  // input floor, and a meter whose `wouldExceedCost` reports exhausted. RED-on-
  // injection: reverting :63 to `completedCategory("max_turns")` turns this red.
  test("costPreflight firing ⇒ stopCategory kind=budget, code budget.cost_cap (NOT max_turns)", async () => {
    const preflightCtx = {
      cfg: {
        llm: { model: "gpt-5.4" },
        budgetMeter: {
          wouldExceedCost: () => ({ exhausted: true, kind: "cost_usd", budget: 1, observed: 2 }),
        },
        decisionEmitter: undefined,
      },
      wm: {
        snapshot: () => [{ role: "user", content: [{ type: "text", text: "x".repeat(200) }] }],
      },
      session: { skillGate: undefined },
    } as unknown as RunAgentContext
    const stop = await costPreflightCondition(preflightCtx, 4)
    expect(stop?.reason).toBe("budget_exhausted")
    expect(stop?.turns).toBe(3) // preflight uses `turn - 1` (no model output this turn)
    expect(stop?.stopCategory.kind).toBe("budget")
    expect(stop?.stopCategory.reasonCode).toBe("budget.cost_cap")
    expect(stop?.stopCategory.kind).not.toBe("max_turns")
  })
})
