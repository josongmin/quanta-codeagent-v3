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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

  test("QUANTA_MAX_COST_USD overrides the preset cost cap on any mode", () => {
    // interactive has NO preset maxCostUsd; the override pins one.
    expect(assembleWith({ QUANTA_MAX_COST_USD: "0.05" }).budgetMeter?.dials.maxCostUsd).toBe(0.05)
    // garbage ⇒ omitted (preset stands; interactive ⇒ undefined).
    expect(assembleWith({ QUANTA_MAX_COST_USD: "abc" }).budgetMeter?.dials.maxCostUsd).toBeUndefined()
  })

  test("QUANTA_MAX_COST_PER_TURN_USD override pins a per-turn ceiling", () => {
    expect(
      assembleWith({ QUANTA_MAX_COST_PER_TURN_USD: "0.01" }).budgetMeter?.dials.maxCostPerTurnUsd,
    ).toBe(0.01)
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

  test("PATH set ⇒ assembler wires a PERSISTING ledger (write-through to disk)", () => {
    const dir = mkdtempSync(join(tmpdir(), "budget-ledger-"))
    try {
      const path = join(dir, "budget.json")
      const cfg = assembleWith({
        QUANTA_BUDGET_LEDGER: "1",
        QUANTA_BUDGET_LEDGER_DAILY_USD: "10",
        QUANTA_BUDGET_LEDGER_PATH: path,
      })
      expect(cfg.budgetLedger).toBeDefined()
      expect(existsSync(path)).toBe(false)
      cfg.budgetLedger?.record({
        model: "gpt-5.4",
        inputTokens: 1_000_000,
        outputTokens: 0,
        sessionId: "s",
        at: 0,
      })
      // The record wrote through to the configured campaign file.
      expect(existsSync(path)).toBe(true)
      expect(readFileSync(path, "utf8")).toContain("gpt-5.4")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
