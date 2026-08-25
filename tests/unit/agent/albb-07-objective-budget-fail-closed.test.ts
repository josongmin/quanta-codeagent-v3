/**
 * ALBB-07 Claim 3 — `objectiveBudgetExhausted` advisory-guard hardening.
 *
 * DIRECTIONAL ADVISORY hardening ONLY (documented in the ticket): with
 * `objectiveBudgetEnforce` ON, a throwing objective store previously returned
 * `false` ("not exhausted") ⇒ fail-OPEN. Its blast radius is only the advisory
 * "Resuming after mid-turn compaction" next-actions nudge in the reactive
 * compact branch — NOT the loop-continuation enforcement gate (that lives in
 * `objective/continuation.ts` and is independently fail-closed on a throwing
 * store). This is NOT an enforcement-bypass fix.
 *
 * Fix: with enforce ON and a throwing store, fail-CLOSED (`return true` ⇒ treat
 * as exhausted ⇒ skip the advisory nudge) and keep the `logger.warn`.
 *
 * Mutation guard: reverting the catch to `return false` turns the enforce-ON
 * throwing-store case RED.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { objectiveBudgetExhausted } from "@/agent/loop/emit-helpers"
import { __resetRuntimeConfig } from "@/shared"

const THREAD = "thread-1"

const throwingObjective = (): NonNullable<AgentConfig["objective"]> =>
  ({
    get() {
      throw new Error("objective store boom")
    },
    setNextActions: () => null,
  }) as unknown as NonNullable<AgentConfig["objective"]>

const cfgWith = (objective: AgentConfig["objective"]): AgentConfig =>
  ({ objective, sessionId: THREAD }) as unknown as AgentConfig

const originalEnforce = process.env.QUANTA_OBJECTIVE_BUDGET_ENFORCE

beforeEach(() => {
  __resetRuntimeConfig()
})

afterEach(() => {
  if (originalEnforce === undefined) delete process.env.QUANTA_OBJECTIVE_BUDGET_ENFORCE
  else process.env.QUANTA_OBJECTIVE_BUDGET_ENFORCE = originalEnforce
  __resetRuntimeConfig()
})

describe("ALBB-07 claim 3 — objectiveBudgetExhausted advisory fail-closed", () => {
  test("enforce ON + throwing store ⇒ fail-CLOSED (returns true)", () => {
    process.env.QUANTA_OBJECTIVE_BUDGET_ENFORCE = "1"
    __resetRuntimeConfig()
    expect(objectiveBudgetExhausted(cfgWith(throwingObjective()), THREAD)).toBe(true)
  })

  test("enforce OFF ⇒ short-circuits to false BEFORE touching the store (byte-identical)", () => {
    process.env.QUANTA_OBJECTIVE_BUDGET_ENFORCE = "0"
    __resetRuntimeConfig()
    // Store would throw if consulted; the enforce-OFF guard returns false first.
    expect(objectiveBudgetExhausted(cfgWith(throwingObjective()), THREAD)).toBe(false)
  })

  test("enforce ON + non-throwing NON-exhausted store ⇒ false (happy path unchanged)", () => {
    process.env.QUANTA_OBJECTIVE_BUDGET_ENFORCE = "1"
    __resetRuntimeConfig()
    const okObjective = {
      get: () => ({ status: "active" }),
      setNextActions: () => null,
    } as unknown as NonNullable<AgentConfig["objective"]>
    expect(objectiveBudgetExhausted(cfgWith(okObjective), THREAD)).toBe(false)
  })
})
