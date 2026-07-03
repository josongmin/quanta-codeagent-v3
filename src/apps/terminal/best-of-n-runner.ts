/**
 * `@/apps/terminal/best-of-n-runner` — the bounded N-runner that wraps {@link runTerminalBrain} from
 * OUTSIDE (Lever #3, RFC `jul-2-terminal-bench-levers/04`). It runs the brain N independent times
 * (fresh session per attempt) and feeds the candidates to the PURE, FAIR selector
 * ({@link selectBestCandidate}) — which picks the winner by each candidate's OWN verify-gate signal,
 * NEVER a hidden test. The winning attempt's report is the single deliverable materialized to the real
 * `--report-out`; the others are discarded.
 *
 * WHY A WRAPPER (not a brain-mode edit). The runner does NOT touch `runTerminalBrain`'s internals — it
 * composes it. Each attempt is a full, isolated `runTerminalBrain` call with its OWN report sink + a
 * no-op stdout-close, so an attempt cannot leak protocol frames past its own turn or race the hands
 * side. Only after the winner is chosen does the runner write the winner's report to the real sink and
 * close stdout ONCE (preserving the spec-B3 write-then-close ordering the brain guarantees).
 *
 * FAIR SIGNAL PER CANDIDATE. So that EVERY attempt yields the fair acceptance signal the selector
 * ranks on, the runner forces the inner verify-before-finalize gate ON per attempt (env
 * `QUANTA_TB_VERIFY_GATE=1`) — reusing Lever #2's stamp as best-of-N's selector (the RFC's "v2 is
 * best-of-N's selector" composition). No hidden test is consulted anywhere.
 *
 * BOUNDED (R2 — cost blowup). Default N=1 (off): a single `runTerminalBrain` passthrough, BYTE-
 * IDENTICAL to today (same opts, same report, same stdout close — no extra runs, no forced gate, no
 * env mutation). N is parsed from `QUANTA_TB_BEST_OF_N`, floored to an integer, and HARD-capped at
 * {@link BEST_OF_N_MAX} so a fat env value cannot fan out unboundedly. Invalid / ≤1 ⇒ single run.
 *
 * DETERMINISM (R3). Attempts run SERIALLY (never concurrent — jun-19 concurrent-grading false-neg). A
 * per-attempt seed is threaded into the instruction so attempts diverge reproducibly.
 */

import type { AgentEvent } from "@/stream"
import { type BestOfNCandidate, selectBestCandidate } from "./best-of-n"
import {
  type RunTerminalBrainOpts,
  runTerminalBrain,
  TB_VERIFY_GATE_ENV,
  type TerminalBrainReport,
  type TerminalBrainResult,
} from "./brain-mode"

/** Lever #3 knob (RFC `jul-2-terminal-bench-levers/04`): best-of-N fair candidate selection.
 *  INTEGER. Unset / blank / non-integer / ≤1 ⇒ a SINGLE brain run, byte-identical to today. A value
 *  ≥2 runs that many independent attempts and selects the best via the fair (no-leak) selector. Hard-
 *  capped at {@link BEST_OF_N_MAX} (cost bound). */
export const TB_BEST_OF_N_ENV = "QUANTA_TB_BEST_OF_N"

/** HARD cap on N (R2 — cost blowup). N× LLM cost + turns per attempt; the RFC caps at ≤4. A larger
 *  env value is clamped to this — a fat `QUANTA_TB_BEST_OF_N=999` cannot fan out unboundedly. */
export const BEST_OF_N_MAX = 4

/**
 * Resolve the requested attempt count from the env. Unset / blank / non-finite / ≤1 ⇒ `1` (single run,
 * byte-identical). Otherwise floored to an integer and clamped to [2, {@link BEST_OF_N_MAX}]. PURE.
 */
export const resolveBestOfN = (env: Record<string, string | undefined>): number => {
  const raw = env[TB_BEST_OF_N_ENV]
  if (raw === undefined || raw.trim() === "") return 1
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 1) return 1
  return Math.min(Math.floor(n), BEST_OF_N_MAX)
}

/** One attempt's captured output: the brain result (report incl. its verify-gate stamp) + optionally
 *  the attempt's event stream (for the selector's tie-break). */
interface AttemptOutcome {
  readonly result: TerminalBrainResult
  readonly events?: readonly AgentEvent[]
}

/** The per-attempt brain runner — injected so the hellgate can drive the orchestration
 *  (N production, isolation, fair selection, single-write) with a scripted candidate stub WITHOUT
 *  standing up the full agent loop. Production binds {@link runTerminalBrain} verbatim. */
export type RunOnce = (opts: RunTerminalBrainOpts) => Promise<TerminalBrainResult>

/**
 * Run the terminal brain with best-of-N fair selection when `QUANTA_TB_BEST_OF_N` ≥ 2; otherwise a
 * single passthrough of {@link runTerminalBrain} (byte-identical default).
 *
 * DEFAULT (N unset/1): returns `runTerminalBrain(opts)` verbatim — same report, same stdout close,
 * no forced gate, no env mutation, no extra runs.
 *
 * N ≥ 2: runs N attempts SERIALLY, each with an isolated report sink + a no-op stdout close and the
 * inner verify-gate forced on (fair signal); selects the winner via {@link selectBestCandidate}; writes
 * the WINNER's report to the real `opts.reportOut` and closes stdout once (spec-B3 write-then-close).
 */
/** ADAPTIVE early-stop predicate (RFC jul-3): a CONFIDENT clean pass — `verified-pass` earned on the
 *  attempt's OWN evidence WITHOUT the bounded follow-up nudge (`followUpFired !== true`). A pass that
 *  only appeared AFTER the nudge is treated as uncertain (worth another fresh trial), and any
 *  fail/unverifiable escalates. PURE + no-leak: reads only the attempt's own stamp, never a hidden test. */
export const isConfidentCleanPass = (report: TerminalBrainReport | undefined): boolean => {
  const v = report?.verification
  return v?.state === "verified-pass" && v.followUpFired !== true
}

export const runTerminalBrainBestOfN = async (
  opts: RunTerminalBrainOpts,
  runOnce: RunOnce = runTerminalBrain,
): Promise<TerminalBrainResult> => {
  const n = resolveBestOfN(opts.env ?? {})
  // ── DEFAULT-OFF byte-identical: N=1 ⇒ the exact single run, untouched. ──
  if (n <= 1) return runOnce(opts)

  const attempts: AttemptOutcome[] = []
  for (let i = 0; i < n; i++) {
    // Each attempt is fully isolated: its report is captured (NOT written to the real sink), its
    // stdout close is a no-op (the runner closes the real channel once, after selection), and the
    // inner verify-gate is forced ON so this candidate carries the fair signal. The attempt env is a
    // per-attempt COPY (never mutating the caller's env object).
    let captured: TerminalBrainReport | undefined
    const attemptEnv: Record<string, string | undefined> = {
      ...(opts.env ?? {}),
      [TB_VERIFY_GATE_ENV]: "1",
    }
    const result = await runOnce({
      ...opts,
      // Diverse-but-reproducible: thread a seed marker so attempts explore differently (R3). The
      // brain treats it as leading instruction context; it does not alter the surface contract.
      instruction: seededInstruction(opts.instruction, i, n),
      env: attemptEnv,
      writeReport: (_path, report) => {
        captured = report
      },
      // Do NOT close the real stdout per attempt — the runner closes it once, post-selection.
      closeStdout: () => undefined,
    })
    attempts.push({ result: captured !== undefined ? { ...result, report: captured } : result })
    // ADAPTIVE EARLY-STOP (RFC jul-3): best-of-N is a COST-GATED escalation, not a fixed fan-out.
    // If THIS attempt is a CONFIDENT clean pass (verified-pass earned WITHOUT the follow-up nudge),
    // there is nothing a further attempt can improve — stop and select it. Only an UNCERTAIN attempt
    // (verified-fail / unverifiable / a pass that needed the nudge) escalates to more trials. So a
    // task the agent nails first-try costs ONE run; only the hard/variance-prone tasks spend N.
    if (isConfidentCleanPass(attempts[i]?.result.report)) break
  }

  // FAIR selection over the candidates' OWN verify-gate stamps (no hidden test anywhere).
  const candidates: BestOfNCandidate[] = attempts.map((a) => ({
    ...(a.result.report.verification !== undefined ? { stamp: a.result.report.verification } : {}),
    ...(a.events !== undefined ? { events: a.events } : {}),
  }))
  const selection = selectBestCandidate(candidates)
  const winner = attempts[selection.winnerIndex]
  if (winner === undefined) throw new Error("runTerminalBrainBestOfN: winner index out of range")

  // Materialize the WINNER as the single deliverable: write its report to the real sink, then close
  // stdout ONCE (spec-B3 ordering). The winning report is annotated with the fair rationale so per-task
  // A/B analysis can attribute a flip to best-of-N (never leaking a hidden test).
  const winningReport: TerminalBrainReport = {
    ...winner.result.report,
    instruction: opts.instruction,
    // `attempts` = the number ACTUALLY run (adaptive early-stop may be < n) so per-task A/B cost
    // analysis is truthful; `cap` records the ceiling requested.
    bestOfN: {
      attempts: attempts.length,
      cap: n,
      winnerIndex: selection.winnerIndex,
      rationale: selection.rationale,
    },
  }
  opts.writeReport(opts.reportOut, winningReport)
  opts.closeStdout?.()
  return { turns: winner.result.turns, report: winningReport }
}

/** Prefix the instruction with a per-attempt exploration marker so N attempts diverge reproducibly
 *  (R3). Attempt 0 gets the ORIGINAL instruction verbatim (attempt-1 = the honest baseline / R5
 *  floor). Later attempts append a short, task-agnostic "try a different approach" nudge with the
 *  attempt index — no hidden-test hint, no answer key. */
const seededInstruction = (instruction: string, attemptIndex: number, total: number): string => {
  if (attemptIndex === 0) return instruction
  return (
    `${instruction}\n\n` +
    `[best-of-${total} attempt ${attemptIndex + 1}/${total}] A previous independent attempt at this ` +
    `task did not clearly verify its deliverable. Try a genuinely different approach this time, and be ` +
    `sure to run and observe your deliverable against the task's own success criterion before finalizing.`
  )
}
