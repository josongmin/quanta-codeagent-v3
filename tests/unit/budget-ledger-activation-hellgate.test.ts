/**
 * HELLGATE — L4 cross-run ledger ACTIVATION seam (anti-theater).
 *
 * The ledger's record + hard-breach enforcement is wired into the loop, but
 * nothing CONSTRUCTED a `config.budgetLedger` in production — so the whole L4
 * layer was unreachable (wired-but-inert). This proves the composition-root
 * activation seam: `QUANTA_BUDGET_LEDGER=1` + at least one HARD USD cap mints a
 * real, ENFORCING ledger; absent gate / no cap leaves the slot unset
 * (byte-identical default-OFF, no-heuristics on the cap value).
 */
import { describe, expect, test } from "bun:test"
import { type AssemblerEnv, assembleAgentConfig } from "@/host/runtime/agent-config-assembler"
import type { RuntimeAgentConfigBase } from "@/sdk/runtime"

const baseConfig = (): RuntimeAgentConfigBase =>
  ({ cwd: "/tmp" }) as unknown as RuntimeAgentConfigBase
const assembleWith = (env: AssemblerEnv) =>
  assembleAgentConfig({ mode: "interactive", base: baseConfig() }, env)

describe("HELLGATE L4 — budget-ledger activation seam", () => {
  test("gate unset ⇒ budgetLedger UNSET (byte-identical default-OFF)", () => {
    expect(assembleWith({}).budgetLedger).toBeUndefined()
  })

  test("ANTI-THEATER: gate + session cap ⇒ assembler mints an ENFORCING ledger", () => {
    const cfg = assembleWith({
      QUANTA_BUDGET_LEDGER: "1",
      QUANTA_BUDGET_LEDGER_SESSION_USD: "1",
    })
    expect(cfg.budgetLedger).toBeDefined()
    // It actually enforces: record spend past the $1 session cap ⇒ hard breach.
    cfg.budgetLedger?.record({
      model: "gpt-5.4",
      inputTokens: 1_000_000, // $2.5 input >> $1 cap
      outputTokens: 0,
      sessionId: "s",
      at: 0,
    })
    expect(cfg.budgetLedger?.hardBreach()?.kind).toBe("session-hard")
  })

  test("gate + daily cap ⇒ ledger present (daily scope is the non-redundant value)", () => {
    const cfg = assembleWith({
      QUANTA_BUDGET_LEDGER: "1",
      QUANTA_BUDGET_LEDGER_DAILY_USD: "10.50",
    })
    expect(cfg.budgetLedger).toBeDefined()
  })

  test("enabled but NO cap ⇒ UNSET (no-heuristics: the cap is operator-supplied)", () => {
    expect(assembleWith({ QUANTA_BUDGET_LEDGER: "1" }).budgetLedger).toBeUndefined()
  })

  test("cap but gate OFF ⇒ UNSET (strict opt-in)", () => {
    expect(assembleWith({ QUANTA_BUDGET_LEDGER_SESSION_USD: "5" }).budgetLedger).toBeUndefined()
  })

  test("non-positive / garbage cap ⇒ UNSET (parse rejects)", () => {
    for (const bad of ["0", "-3", "abc", ""]) {
      expect(
        assembleWith({ QUANTA_BUDGET_LEDGER: "1", QUANTA_BUDGET_LEDGER_SESSION_USD: bad })
          .budgetLedger,
      ).toBeUndefined()
    }
  })
})
