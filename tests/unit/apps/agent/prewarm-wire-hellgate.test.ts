/**
 * ADR-0452 jun-02 wire hellgate — `QUANTA_PREWARM` is LIVE at the agent
 * composition root (`buildBaseFromArgs`), not merely a library seam.
 *
 * Round-2 audit found the prewarm slice was implemented + tested but NEVER
 * activated: no composition root read `QUANTA_PREWARM`, so `config.prewarm` was
 * always `undefined` and the gated loop prewarm + `quanta.startup.*` TTFM metric
 * could never fire (a dead seam, the fc L3 claim was false). This proves the
 * wire:
 *
 *   HELL-PW-01  knob UNSET ⇒ `base.prewarm` ABSENT (default-OFF byte-identical:
 *               no clock read, no warm, no TTFM key).
 *   HELL-PW-02  `QUANTA_PREWARM=1` ⇒ `base.prewarm.enabled === true` + a real
 *               injected `now` clock (the TTFM observability is genuinely live).
 *   HELL-PW-03  an UNRECOGNIZED value ⇒ ABSENT (fail toward off).
 */
import { afterEach, describe, expect, it } from "bun:test"
import { buildBaseFromArgs } from "@/../src/apps/agent/index"
import { pinHermeticBootCredential } from "../../../_support/boot-credential"

const PRIOR = process.env.QUANTA_PREWARM

afterEach(() => {
  if (PRIOR === undefined) delete process.env.QUANTA_PREWARM
  else process.env.QUANTA_PREWARM = PRIOR
})

// This suite builds a REAL boot port, so it must satisfy provider selection.
// It brings its own credential rather than borrowing the operator's — see the
// helper for the 13 cases this was silently hiding on a clean checkout.
pinHermeticBootCredential()

describe("ADR-0452 wire — QUANTA_PREWARM at the agent composition root", () => {
  it("HELL-PW-01: knob unset ⇒ base.prewarm absent (default-OFF byte-identical)", () => {
    delete process.env.QUANTA_PREWARM
    const base = buildBaseFromArgs({ mode: "interactive", dials: {} }) as {
      prewarm?: unknown
    }
    expect(base.prewarm).toBeUndefined()
  })

  it("HELL-PW-02: QUANTA_PREWARM=1 ⇒ enabled true + a real injected clock", () => {
    process.env.QUANTA_PREWARM = "1"
    const base = buildBaseFromArgs({ mode: "interactive", dials: {} }) as {
      prewarm?: { enabled: boolean; now?: () => number }
    }
    expect(base.prewarm).toBeDefined()
    expect(base.prewarm?.enabled).toBe(true)
    expect(typeof base.prewarm?.now).toBe("function")
    // The injected clock returns a real epoch ms (monotone, positive).
    expect(base.prewarm?.now?.()).toBeGreaterThan(0)
  })

  it("HELL-PW-03: unrecognized value ⇒ absent (fail toward off)", () => {
    process.env.QUANTA_PREWARM = "maybe"
    const base = buildBaseFromArgs({ mode: "interactive", dials: {} }) as {
      prewarm?: unknown
    }
    expect(base.prewarm).toBeUndefined()
  })
})
