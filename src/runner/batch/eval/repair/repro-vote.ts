/**
 * #2 — Repro-VOTE validator (K-of-N resolved gate at validation time).
 *
 * Composes a drop-in `validate` for the repair orchestrator that re-runs the
 * REPRODUCING repro set (the scripts that printed "Issue reproduced" on the
 * un-patched tree) in the PATCHED sandbox and majority-votes the RESOLVED side
 * ({@link voteResolved}). This replaces the legacy single-script sentinel gate
 * for the false-NEGATIVE failure mode: one brittle reproducer can no longer
 * reject a correct patch when the majority of independently-phrased scripts
 * agree the bug is fixed.
 *
 * No-leak invariant preserved: the inputs are EXCLUSIVELY the agent-side repro
 * scripts (`@/agent/repro-test`) plus the sandbox path — never `FAIL_TO_PASS`,
 * `test_patch`, or the official report. The composed validate's signature is
 * still `(ValidateArgs) => ValidatorResult`, so the orchestrator is unchanged.
 *
 * Default-OFF / fail-open by construction:
 *   - empty `sources`          ⇒ `fallback(args)` (byte-identical legacy gate).
 *   - executeReproTests throws ⇒ `fallback(args)` (a broken exec must not be a
 *                                 silent pass; the legacy gate still runs).
 *   - vote `inconclusive`      ⇒ `fallback(args)` (tie / all-noisy: don't guess,
 *                                 defer to the single-sentinel / exit-code gate).
 *   - vote `resolved`          ⇒ `{ ok: true }`.
 *   - vote `reproduced`        ⇒ `{ ok: false, failTail }` (still buggy — seed
 *                                 the next round with a reproducing tail).
 *
 * ⚠️ MEASUREMENT NOTE (A/B comparability — read before interpreting telemetry).
 * When the VOTE decides a round, this validator returns a BARE result — it does
 * NOT set `observed` / `predicate`. The orchestrator's `isFalseRed` /
 * `isFalseGreen` instruments (repair/index.ts) read those fields, so for
 * vote-decided rounds `primary_false_red_rate` / `primary_false_green_rate` are
 * STRUCTURALLY ~0 — by construction, not because the vote empirically removed
 * false-reds. This is intentional: those instruments measure the EXIT-CODE-vs-
 * marker disagreement of the LEGACY gate, and the vote REPLACES that mechanism
 * (it gates on the marker majority, so the disagreement cannot arise). Therefore
 * do NOT compare `primary_false_red_rate` between `agentless-v2-repair` (legacy
 * gate, real signal) and `agentless-v2-reprovote` (vote, suppressed signal) — it
 * is apples-to-oranges. Compare RESOLUTION (the grader verdict) and repair-round
 * count instead; those are the metrics the vote is meant to move.
 */

import {
  executeReproTests,
  type ReproExecPort,
  type ReproWriteFilePort,
} from "@/agent/repro-test/execute"
import type { ReproTestConfig, ReproTestSample } from "@/agent/repro-test/types"
import { voteResolved } from "@/agent/repro-test/vote"
import type { ValidateArgs, ValidatorResult } from "./types"

const DEFAULT_TAIL = 2000

export interface ReproVoteValidateDeps {
  /** Reproducing scripts (outcome === "reproduced" on the un-patched tree). The
   *  vote is meaningless without them, so an empty set ⇒ pure fallback. */
  sources: readonly string[]
  /** Injected exec port (argv form) — SAME wiring the base-red check used. */
  exec: ReproExecPort
  /** Injected file-write port (writes each script under the sandbox). */
  writeFile: ReproWriteFilePort
  /** SWE-bench project-env argv builder (`uvx --with-editable . python <p>`),
   *  identical to the base-red run so imports resolve. Optional for fixtures. */
  buildArgv?: (scriptPath: string) => readonly string[]
  pythonBin?: string
  config?: ReproTestConfig
  /** Legacy gate, used for empty-set / fail-open / inconclusive. */
  fallback: (args: ValidateArgs) => Promise<ValidatorResult>
}

/** Tail of a representative still-reproducing sample, for the next-round seed. */
const reproducedTail = (samples: readonly ReproTestSample[], bound: number): string => {
  const rep = samples.find((s) => s.outcome === "reproduced")
  if (rep === undefined) return ""
  const combined = `${rep.stdout}\n${rep.stderr ?? ""}`
  return combined.length > bound ? combined.slice(-bound) : combined
}

export const makeReproVoteValidate =
  (deps: ReproVoteValidateDeps) =>
  async (args: ValidateArgs): Promise<ValidatorResult> => {
    if (deps.sources.length === 0) return deps.fallback(args)
    let samples: readonly ReproTestSample[]
    try {
      samples = await executeReproTests({
        tests: deps.sources,
        repoRoot: args.sandbox,
        exec: deps.exec,
        writeFile: deps.writeFile,
        ...(deps.config !== undefined ? { config: deps.config } : {}),
        ...(deps.buildArgv !== undefined ? { buildArgv: deps.buildArgv } : {}),
        ...(deps.pythonBin !== undefined ? { pythonBin: deps.pythonBin } : {}),
      })
    } catch {
      // A broken exec port must never be a silent pass — defer to the legacy gate.
      return deps.fallback(args)
    }
    const vote = voteResolved(samples)
    if (vote.verdict === "resolved") return { ok: true }
    if (vote.verdict === "reproduced") {
      const failTail = reproducedTail(samples, args.tailBytes ?? DEFAULT_TAIL)
      return { ok: false, failTail }
    }
    // Inconclusive (tie / all-noisy): don't guess — fall back to the legacy gate.
    return deps.fallback(args)
  }
