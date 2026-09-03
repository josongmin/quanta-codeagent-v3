/**
 * Wire hellgate — RFC jun-17 `QUANTA_LSP_PREWARM` is LIVE at the agent
 * composition root (`buildBaseFromArgs`). The prewarm is DEFAULT-ON, GATED on
 * the nav tools being enabled, with a `=0` off-switch. A dead seam (slot never
 * set) would leave `config.lspPrewarm` undefined and the warm could never fire.
 *
 *   LP-01  nav OFF + prewarm unset ⇒ ABSENT (nav gate; byte-identical legacy).
 *   LP-02  nav OFF + prewarm=1 ⇒ ABSENT (nav gate dominates — no wasted warm).
 *   LP-03  nav ON (QUANTA_LSP_TOOLS=full) + prewarm unset ⇒ ENABLED (default-on).
 *   LP-04  nav ON (QUANTA_BENCH_LSP=1) + prewarm unset ⇒ ENABLED (default-on).
 *   LP-05  nav ON + QUANTA_LSP_PREWARM=0 ⇒ ABSENT (off-switch / A/B cold arm).
 *   LP-06  nav ON + QUANTA_LSP_PREWARM=1 ⇒ ENABLED (explicit on).
 */
import { afterEach, describe, expect, it } from "bun:test"
import { buildBaseFromArgs } from "@/../src/apps/agent/index"
import { pinHermeticBootCredential } from "../_support/boot-credential"

const KEYS = ["QUANTA_LSP_PREWARM", "QUANTA_LSP_TOOLS", "QUANTA_BENCH_LSP"] as const
const PRIOR: Record<string, string | undefined> = {}
for (const k of KEYS) PRIOR[k] = process.env[k]

afterEach(() => {
  for (const k of KEYS) {
    if (PRIOR[k] === undefined) delete process.env[k]
    else process.env[k] = PRIOR[k]
  }
})

const clear = (): void => {
  for (const k of KEYS) delete process.env[k]
}

const base = (): { lspPrewarm?: { enabled: boolean } } =>
  buildBaseFromArgs({ mode: "interactive", dials: {} }) as { lspPrewarm?: { enabled: boolean } }

// This suite builds a REAL boot port, so it must satisfy provider selection.
// It brings its own credential rather than borrowing the operator's — see the
// helper for the 13 cases this was silently hiding on a clean checkout.
pinHermeticBootCredential()

describe("RFC jun-17 wire — QUANTA_LSP_PREWARM default-on, nav-gated, =0 off-switch", () => {
  it("LP-01: nav off + prewarm unset ⇒ absent (nav gate)", () => {
    clear()
    expect(base().lspPrewarm).toBeUndefined()
  })

  it("LP-02: nav off + prewarm=1 ⇒ absent (nav gate dominates)", () => {
    clear()
    process.env.QUANTA_LSP_PREWARM = "1"
    expect(base().lspPrewarm).toBeUndefined()
  })

  it("LP-03: nav on (QUANTA_LSP_TOOLS=full) + prewarm unset ⇒ enabled (default-on)", () => {
    clear()
    process.env.QUANTA_LSP_TOOLS = "full"
    expect(base().lspPrewarm?.enabled).toBe(true)
  })

  it("LP-04: nav on (QUANTA_BENCH_LSP=1) + prewarm unset ⇒ enabled (default-on)", () => {
    clear()
    process.env.QUANTA_BENCH_LSP = "1"
    expect(base().lspPrewarm?.enabled).toBe(true)
  })

  it("LP-05: nav on + QUANTA_LSP_PREWARM=0 ⇒ absent (off-switch / A/B cold arm)", () => {
    clear()
    process.env.QUANTA_LSP_TOOLS = "full"
    process.env.QUANTA_LSP_PREWARM = "0"
    expect(base().lspPrewarm).toBeUndefined()
  })

  it("LP-06: nav on + QUANTA_LSP_PREWARM=1 ⇒ enabled (explicit on)", () => {
    clear()
    process.env.QUANTA_LSP_TOOLS = "full"
    process.env.QUANTA_LSP_PREWARM = "1"
    expect(base().lspPrewarm?.enabled).toBe(true)
  })
})
