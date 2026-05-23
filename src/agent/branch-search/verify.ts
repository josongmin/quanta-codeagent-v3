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

/** Patch-size verifier — emits a single `patch_size` PENALTY signal using
 *  `cand.delta` produced upstream by `shadowOdbAnchor`. The magnitude is
 *  log-scale-normalized total-changed-lines so a 10-line patch scores ~0.34,
 *  a 100-line patch scores ~0.67, and a 1000-line patch saturates at 1.0
 *  (the cap). When `cand.delta` is OMITTED (no anchor wired), the verifier
 *  emits magnitude 0 — penalty contribution is zero, so the candidate's
 *  reward is unaffected (byte-identical-when-absent invariant).
 *
 *  `pass` is ALWAYS true — patch size is a quality axis, not a gate. */
export const patchSizeVerifier =
  (opts?: { clock?: Clock }): Verifier =>
  async (cand) => {
    const clock = opts?.clock ?? wallClock
    const t0 = clock()
    if (cand.delta === undefined) {
      return [
        {
          kind: "patch_size",
          pass: true,
          magnitude: 0,
          detail: "no-delta",
          durationMs: Math.max(0, clock() - t0),
        },
      ]
    }
    const { addedLines, removedLines, changedFiles } = cand.delta
    const total = addedLines + removedLines
    // Domain note: log10(1+total)/3 is calibrated so the typical "small patch"
    // (1–20 lines) lives in [0, 0.4], "medium" (20–200) in [0.4, 0.75], "large"
    // (200+) approaches 1. The /3 divisor saturates at ~1000 lines, matching
    // the empirical observation that patches >1000 lines are uniformly bad.
    const magnitude = Math.min(1, Math.log10(1 + total) / 3)
    const filesLabel = `${changedFiles} file${changedFiles === 1 ? "" : "s"}`
    return [
      {
        kind: "patch_size",
        pass: true,
        magnitude,
        detail: `+${addedLines}/-${removedLines}, ${filesLabel}`,
        durationMs: Math.max(0, clock() - t0),
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
