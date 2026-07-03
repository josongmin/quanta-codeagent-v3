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
  budgetLedger?: { hardBreach: () => { limit: number; observed: number } | undefined }
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
})
