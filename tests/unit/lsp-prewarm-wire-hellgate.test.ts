/**
 * Wire hellgate — RFC jun-17 `QUANTA_LSP_PREWARM` is LIVE at the agent
 * composition root (`buildBaseFromArgs`) and DOUBLE-GATED on the nav tools being
 * enabled. A dead seam (slot never set) would leave `config.lspPrewarm`
 * undefined and the session-start background warm could never fire.
 *
 *   LP-01  prewarm unset ⇒ slot ABSENT (default-OFF byte-identical).
 *   LP-02  prewarm=1 but nav DISABLED ⇒ ABSENT (the second gate: warming a
 *          server whose tools aren't exposed is wasted work).
 *   LP-03  prewarm=1 + QUANTA_LSP_TOOLS=full ⇒ enabled true.
 *   LP-04  prewarm=1 + QUANTA_BENCH_LSP=1 ⇒ enabled true.
 *   LP-05  nav enabled but prewarm unset ⇒ ABSENT (the first gate).
 */
import { afterEach, describe, expect, it } from "bun:test"
import { buildBaseFromArgs } from "@/../src/apps/agent/index"

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

describe("RFC jun-17 wire — QUANTA_LSP_PREWARM double-gate at the composition root", () => {
  it("LP-01: prewarm unset ⇒ slot absent", () => {
    clear()
    expect(base().lspPrewarm).toBeUndefined()
  })

  it("LP-02: prewarm=1 but nav disabled ⇒ absent (second gate)", () => {
    clear()
    process.env.QUANTA_LSP_PREWARM = "1"
    expect(base().lspPrewarm).toBeUndefined()
  })

  it("LP-03: prewarm=1 + QUANTA_LSP_TOOLS=full ⇒ enabled", () => {
    clear()
    process.env.QUANTA_LSP_PREWARM = "1"
    process.env.QUANTA_LSP_TOOLS = "full"
    expect(base().lspPrewarm?.enabled).toBe(true)
  })

  it("LP-04: prewarm=1 + QUANTA_BENCH_LSP=1 ⇒ enabled", () => {
    clear()
    process.env.QUANTA_LSP_PREWARM = "1"
    process.env.QUANTA_BENCH_LSP = "1"
    expect(base().lspPrewarm?.enabled).toBe(true)
  })

  it("LP-05: nav enabled but prewarm unset ⇒ absent (first gate)", () => {
    clear()
    process.env.QUANTA_LSP_TOOLS = "full"
    expect(base().lspPrewarm).toBeUndefined()
  })
})
