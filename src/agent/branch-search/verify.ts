import { errMessage } from "@/shared"
/**
 * Concrete verifiers for speculative branch search (ADR-0084). Each shells
 * against a candidate's ISOLATED workspace via `@/runtime/shell#runShell`
 * (env-scrubbed, timeout-bounded) and returns ONE `VerifierSignal`. Verifiers
 * are READ-ONLY w.r.t. the workspace (negative invariant) — analysis only.
 * `combineVerifiers` runs a tier in PARALLEL and concatenates.
 */

import { runShell } from "@/runtime"
import type { Verifier, VerifierSignal } from "./types"

type Clock = () => number
const wallClock: Clock = () => Date.now()

const timed = async <T>(
  clock: Clock,
  body: () => Promise<T>,
): Promise<{ value: T; durationMs: number }> => {
  const t0 = clock()
  const value = await body()
  return { value, durationMs: Math.max(0, clock() - t0) }
}

const firstLine = (s: string, cap = 200): string => {
  const line = s.split("\n").find((l) => l.trim().length > 0) ?? ""
  return line.trim().slice(0, cap)
}

const countErrors = (s: string): number => (s.match(/error/gi) ?? []).length

export const tscVerifier =
  (opts?: { tscCmd?: string; timeoutMs?: number; clock?: Clock }): Verifier =>
  async (cand) => {
    const clock = opts?.clock ?? wallClock
    const cmd = opts?.tscCmd ?? "tsc --noEmit"
    const { value: r, durationMs } = await timed(clock, () =>
      runShell(cmd, {
        cwd: cand.workspace,
        ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      }),
    )
    const pass = r.exitCode === 0 && !r.timedOut
    return [
      {
        kind: "tsc",
        pass,
        detail: pass ? "tsc clean" : r.timedOut ? "tsc timed out" : firstLine(r.stdout || r.stderr),
        durationMs,
      },
    ]
  }

export const testVerifier =
  (opts?: { testCmd?: string; pattern?: string; timeoutMs?: number; clock?: Clock }): Verifier =>
  async (cand) => {
    const clock = opts?.clock ?? wallClock
    const base = opts?.testCmd ?? "bun test"
    const cmd = opts?.pattern ? `${base} ${opts.pattern}` : base
    const { value: r, durationMs } = await timed(clock, () =>
      runShell(cmd, {
        cwd: cand.workspace,
        ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      }),
    )
    const pass = r.exitCode === 0 && !r.timedOut
    return [
      {
        kind: "test",
        pass,
        detail: pass
          ? "tests pass"
          : r.timedOut
            ? "tests timed out"
            : firstLine(r.stdout || r.stderr),
        durationMs,
      },
    ]
  }

export const lintVerifier =
  (opts?: { lintCmd?: string; errorScale?: number; timeoutMs?: number; clock?: Clock }): Verifier =>
  async (cand) => {
    const clock = opts?.clock ?? wallClock
    const cmd = opts?.lintCmd ?? "biome check ."
    const scale = opts?.errorScale ?? 10
    const { value: r, durationMs } = await timed(clock, () =>
      runShell(cmd, {
        cwd: cand.workspace,
        ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      }),
    )
    const errors = r.exitCode === 0 ? 0 : countErrors(r.stdout || r.stderr)
    const pass = r.exitCode === 0
    const magnitude = Math.max(0, 1 - Math.min(1, errors / scale))
    return [
      {
        kind: "lint",
        pass,
        magnitude,
        detail: pass ? "lint clean" : `${errors} lint issue(s): ${firstLine(r.stdout || r.stderr)}`,
        durationMs,
      },
    ]
  }

/** Injected diagnostics port so `@/agent/branch-search` need not import `@/lsp`
 *  directly (port + test injection). pass ⇔ zero error-severity diagnostics. */
export type DiagnosePort = (workspace: string) => Promise<{ errorCount: number; first?: string }>

export const lspDiagVerifier =
  (diagnose: DiagnosePort, opts?: { clock?: Clock }): Verifier =>
  async (cand) => {
    const clock = opts?.clock ?? wallClock
    const { value: d, durationMs } = await timed(clock, () => diagnose(cand.workspace))
    const pass = d.errorCount === 0
    return [
      {
        kind: "lsp_diag",
        pass,
        detail: pass ? "no diagnostics" : `${d.errorCount} diagnostic(s): ${d.first ?? ""}`,
        durationMs,
      },
    ]
  }

/** Compose verifiers — run in PARALLEL, concatenate signals. A verifier that
 *  THROWS becomes a failed signal (counts against the candidate) rather than
 *  failing the whole pipeline (`Promise.allSettled`). */
export const combineVerifiers =
  (...verifiers: ReadonlyArray<Verifier>): Verifier =>
  async (cand) => {
    const settled = await Promise.allSettled(verifiers.map((v) => v(cand)))
    const out: VerifierSignal[] = []
    for (const s of settled) {
      if (s.status === "fulfilled") {
        out.push(...s.value)
      } else {
        out.push({
          kind: "lint",
          pass: false,
          detail: `verifier crashed: ${errMessage(s.reason)}`,
          durationMs: 0,
        })
      }
    }
    return out
  }
