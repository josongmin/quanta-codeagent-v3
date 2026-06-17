import { describe, expect, test } from "bun:test"
import "@/runner/knobs/knobs"
import { resolveBenchKnobs } from "@/runner/batch/eval/driver"
import { benchPostureFromState } from "@/runner/batch/eval/knobs-bench"

/**
 * Wiring proof (ratchet): LSP-nav GROUNDING steer is DEFAULT-ON whenever LSP nav
 * tools are on. `agentless-v1` (lsp:1) ⇒ `localizePhase.lspGroundingSteer:true`.
 * An explicit `QUANTA_BENCH_LSP_STEER=off` is the A/B baseline (suppresses the
 * steer with nav still on). Without nav (`baseline` preset) the steer is off
 * (pointless). Closes the measured ~0% LSP-nav-usage gap (owner-mislocation +
 * missed multi-file co-change, hard-tier causal audit).
 *
 * Red-on-injection: decouple steer from nav, or flip the default off, and the
 * v1-default test fails; stop honoring the off-switch and the baseline test fails.
 */
const posture = (env: Record<string, string>) => {
  const e = env as unknown as NodeJS.ProcessEnv
  return benchPostureFromState(resolveBenchKnobs({ envVars: e }), e)
}
const lp = (p: ReturnType<typeof posture>) =>
  p.localizePhase as { phase1Turns?: number; lspGroundingSteer?: boolean } | undefined

describe("LSP-nav grounding steer — default-ON when nav on", () => {
  test("agentless-v1 (lsp:1) steers by default: lspGroundingSteer:true", () => {
    const p = posture({ QUANTA_BENCH_PRESET: "agentless-v1" })
    expect(p.lspNav).toBe(true)
    expect(lp(p)?.phase1Turns).toBe(5)
    expect(lp(p)?.lspGroundingSteer).toBe(true)
  })

  test("A/B baseline: QUANTA_BENCH_LSP_STEER=off suppresses steer (nav still on)", () => {
    const p = posture({ QUANTA_BENCH_PRESET: "agentless-v1", QUANTA_BENCH_LSP_STEER: "off" })
    expect(p.lspNav).toBe(true)
    expect(lp(p)?.lspGroundingSteer).toBeUndefined()
  })

  test("no nav (baseline preset) ⇒ no steer (pointless without tools)", () => {
    const p = posture({ QUANTA_BENCH_PRESET: "baseline" })
    expect(p.lspNav).toBe(false)
    expect(p.localizePhase).toBeUndefined()
  })
})
