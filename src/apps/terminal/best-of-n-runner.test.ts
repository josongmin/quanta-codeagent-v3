/**
 * Lever #3 — best-of-N N-RUNNER hellgate (RFC jul-2-terminal-bench-levers/04).
 *
 * The bounded wrapper {@link runTerminalBrainBestOfN} around the per-attempt brain runner. The brain
 * runner is INJECTED (a scripted `RunOnce` stub) so this hellgate exercises the ORCHESTRATION the
 * wrapper owns — N production, per-attempt isolation, fair selection, single deliverable write,
 * boundedness — deterministically, WITHOUT standing up the full agent loop. What the wrapper delegates
 * to the loop (a real brain attempt) is the loop's own coverage; what is NEW here is the orchestration.
 *
 * Proven invariants:
 *   - RED / DEFAULT-OFF: N unset / 1 / blank / invalid ⇒ a SINGLE `runOnce(opts)` call with the opts
 *     PASSED THROUGH UNMODIFIED (no forced verify-gate env, no seed rewrite, no extra call) ⇒ byte-
 *     identical to calling the brain directly.
 *   - N≥2: N candidates produced; the FAIR selector picks the L1-verified one, NOT a fake-green
 *     (scripted set: attempt-1 claims success/unverifiable, attempt-2 is verified-pass).
 *   - Per-attempt isolation: each attempt's verify-gate is forced ON (fair signal) and its report is
 *     NOT written to the real sink — only the WINNER is materialized (exactly one deliverable write).
 *   - R2 cost bound: N is HARD-capped at `BEST_OF_N_MAX`.
 *   - Honest: all-fake-green ⇒ unverifiable winner (never a claimed pass).
 *
 * Surface-isolation: stays inside `src/apps/terminal/**`.
 */
import { describe, expect, test } from "bun:test"
import {
  BEST_OF_N_MAX,
  type RunOnce,
  resolveBestOfN,
  runTerminalBrainBestOfN,
  TB_BEST_OF_N_ENV,
} from "./best-of-n-runner"
import type { RunTerminalBrainOpts, TerminalBrainReport } from "./brain-mode"
import { TB_VERIFY_GATE_ENV } from "./brain-mode"
import type { VerificationStamp } from "./verify-gate"

/** Minimal opts (the scripted `RunOnce` ignores the IO seams; they exist only to satisfy the type). */
const baseOpts = (env?: Record<string, string>): RunTerminalBrainOpts => ({
  instruction: "solve it",
  reportOut: "/tmp/bon.json",
  stdin: (async function* () {})(),
  stdout: { write: () => undefined },
  llm: { model: "f", provider: "t", authMode: "f", async *stream() {} },
  writeReport: () => undefined,
  ...(env !== undefined ? { env } : {}),
})

/** A scripted per-attempt brain: attempt i produces a report with the given verification stamp (its
 *  fair signal) + records the opts it was called with (so the test can assert isolation / passthrough).
 *  It honors `opts.writeReport` exactly as the real brain does (writing the attempt's report to
 *  whatever sink the wrapper handed it). */
const scriptedRunOnce = (
  stampFor: (attempt: number) => VerificationStamp | undefined,
  log: { calls: RunTerminalBrainOpts[] },
): RunOnce => {
  let attempt = -1
  return async (opts: RunTerminalBrainOpts) => {
    attempt += 1
    log.calls.push(opts)
    const stamp = stampFor(attempt)
    const report: TerminalBrainReport = {
      instruction: opts.instruction,
      turns: attempt + 1,
      tokens: { input: 0, output: 0 },
      cost_usd: 0,
      final: `attempt ${attempt}`,
      ...(stamp !== undefined ? { verification: stamp } : {}),
    }
    opts.writeReport(opts.reportOut, report)
    opts.closeStdout?.()
    return { turns: report.turns, report }
  }
}

const stamp = (state: VerificationStamp["state"]): VerificationStamp => ({
  state,
  evidence: `evidence:${state}`,
  followUpFired: false,
})

describe("best-of-N knob parse (bounded, default-off)", () => {
  test("unset / blank / invalid / ≤1 ⇒ 1 (single run); ≥2 ⇒ clamped to [2, MAX]", () => {
    expect(resolveBestOfN({})).toBe(1)
    expect(resolveBestOfN({ [TB_BEST_OF_N_ENV]: "" })).toBe(1)
    expect(resolveBestOfN({ [TB_BEST_OF_N_ENV]: "  " })).toBe(1)
    expect(resolveBestOfN({ [TB_BEST_OF_N_ENV]: "abc" })).toBe(1)
    expect(resolveBestOfN({ [TB_BEST_OF_N_ENV]: "1" })).toBe(1)
    expect(resolveBestOfN({ [TB_BEST_OF_N_ENV]: "0" })).toBe(1)
    expect(resolveBestOfN({ [TB_BEST_OF_N_ENV]: "-3" })).toBe(1)
    expect(resolveBestOfN({ [TB_BEST_OF_N_ENV]: "3" })).toBe(3)
    expect(resolveBestOfN({ [TB_BEST_OF_N_ENV]: "3.9" })).toBe(3)
    // R2 hard cap: a fat value cannot fan out unboundedly.
    expect(resolveBestOfN({ [TB_BEST_OF_N_ENV]: "999" })).toBe(BEST_OF_N_MAX)
  })
})

describe("best-of-N runner — DEFAULT-OFF byte-identical (RED)", () => {
  test("N unset ⇒ EXACTLY ONE runOnce call with the opts passed through UNMODIFIED (no forced gate, no seed rewrite)", async () => {
    const log = { calls: [] as RunTerminalBrainOpts[] }
    const opts = baseOpts()
    const r = await runTerminalBrainBestOfN(
      opts,
      scriptedRunOnce(() => undefined, log),
    )
    // Exactly one attempt, and it received the SAME opts object (no wrapper mutation).
    expect(log.calls.length).toBe(1)
    expect(log.calls[0]).toBe(opts) // referential identity ⇒ truly untouched passthrough
    // No verify-gate was forced (the single-run path must not silently stamp verification).
    expect(log.calls[0]?.env?.[TB_VERIFY_GATE_ENV]).toBeUndefined()
    // Instruction was NOT seed-rewritten.
    expect(log.calls[0]?.instruction).toBe("solve it")
    // And no bestOfN annotation on a single run.
    expect(r.report.bestOfN).toBeUndefined()
  })

  test("N=1 explicit is also a single untouched passthrough", async () => {
    const log = { calls: [] as RunTerminalBrainOpts[] }
    const opts = baseOpts({ [TB_BEST_OF_N_ENV]: "1" })
    await runTerminalBrainBestOfN(
      opts,
      scriptedRunOnce(() => undefined, log),
    )
    expect(log.calls.length).toBe(1)
    expect(log.calls[0]).toBe(opts)
  })
})

describe("best-of-N runner — N≥2 picks the L1-verified candidate, not the fake-green (RED→GREEN)", () => {
  test("attempt-1 unverifiable (fake-green) but attempt-2 verified-pass ⇒ winner = attempt-2", async () => {
    const log = { calls: [] as RunTerminalBrainOpts[] }
    const stampFor = (a: number): VerificationStamp =>
      a === 0 ? stamp("unverifiable") : stamp("verified-pass")
    const written: Array<{ path: string; report: TerminalBrainReport }> = []
    const opts: RunTerminalBrainOpts = {
      ...baseOpts({ [TB_BEST_OF_N_ENV]: "2" }),
      writeReport: (path, report) => written.push({ path, report }),
    }
    const r = await runTerminalBrainBestOfN(opts, scriptedRunOnce(stampFor, log))
    // Two attempts ran.
    expect(log.calls.length).toBe(2)
    // The FAIR selector picked the L1-verified attempt-2, NOT the confident fake-green attempt-1.
    expect(r.report.verification?.state).toBe("verified-pass")
    expect(r.report.bestOfN?.attempts).toBe(2)
    expect(r.report.bestOfN?.winnerIndex).toBe(1)
    // The rationale never names a hidden test.
    expect(r.report.bestOfN?.rationale.toLowerCase()).not.toContain("hidden")
    expect(r.report.bestOfN?.rationale.toLowerCase()).not.toContain("answer")
  })

  test("per-attempt ISOLATION: each attempt's verify-gate is forced ON, and the caller env is not mutated", async () => {
    const log = { calls: [] as RunTerminalBrainOpts[] }
    const callerEnv = { [TB_BEST_OF_N_ENV]: "3" }
    const opts = baseOpts(callerEnv)
    await runTerminalBrainBestOfN(
      opts,
      scriptedRunOnce(() => stamp("unverifiable"), log),
    )
    // Every attempt got the verify-gate forced on (so it carries the fair signal).
    for (const c of log.calls) expect(c.env?.[TB_VERIFY_GATE_ENV]).toBe("1")
    // The caller's env object was NOT mutated (no verify-gate key leaked back onto it).
    expect(callerEnv).toEqual({ [TB_BEST_OF_N_ENV]: "3" })
    // Attempts >1 got a divergence seed appended (attempt-1 keeps the original instruction = R5 floor).
    expect(log.calls[0]?.instruction).toBe("solve it")
    expect(log.calls[1]?.instruction).toContain("attempt 2/3")
    expect(log.calls[2]?.instruction).toContain("attempt 3/3")
  })

  test("all attempts fake-green ⇒ HONEST unverifiable winner (never a claimed pass)", async () => {
    const log = { calls: [] as RunTerminalBrainOpts[] }
    const r = await runTerminalBrainBestOfN(
      baseOpts({ [TB_BEST_OF_N_ENV]: "3" }),
      scriptedRunOnce(() => stamp("unverifiable"), log),
    )
    expect(r.report.verification?.state).toBe("unverifiable")
    expect(r.report.bestOfN?.attempts).toBe(3)
  })

  test("R2 single deliverable: the real reportOut is written EXACTLY once (winner only; attempts use isolated sinks)", async () => {
    const log = { calls: [] as RunTerminalBrainOpts[] }
    const written: Array<{ path: string; report: TerminalBrainReport }> = []
    const opts: RunTerminalBrainOpts = {
      ...baseOpts({ [TB_BEST_OF_N_ENV]: "3" }),
      reportOut: "/tmp/bon-once.json",
      writeReport: (path, report) => written.push({ path, report }),
    }
    await runTerminalBrainBestOfN(
      opts,
      scriptedRunOnce(() => stamp("verified-pass"), log),
    )
    // 3 attempts ran, but the REAL sink saw exactly ONE deliverable (the winner) — the per-attempt
    // reports went to the wrapper's isolated capture sinks, not the caller's.
    expect(log.calls.length).toBe(3)
    expect(written.length).toBe(1)
    expect(written[0]?.path).toBe("/tmp/bon-once.json")
    expect(written[0]?.report.bestOfN?.attempts).toBe(3)
  })

  test("BOUNDEDNESS: a fat N is capped ⇒ at most BEST_OF_N_MAX attempts ever run", async () => {
    const log = { calls: [] as RunTerminalBrainOpts[] }
    await runTerminalBrainBestOfN(
      baseOpts({ [TB_BEST_OF_N_ENV]: "999" }),
      scriptedRunOnce(() => stamp("verified-fail"), log),
    )
    expect(log.calls.length).toBe(BEST_OF_N_MAX)
  })
})
