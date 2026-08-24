/**
 * Tier 2 — SWE-bench Verified adapter. Composes `eval` over the existing
 * `src/apps/bench/` harness rather than re-implementing it. We don't import
 * `bench/index.ts` (it's a CLI entry); instead we drive the same dataset path
 * the bench CLI uses and surface a summary the eval store understands.
 *
 * INTENTIONALLY THIN: this file is a *bridge*, not a re-implementation. If you
 * need a knob the bench CLI exposes (best-of-N, repair rounds, python harness
 * verification), wire it through here as a passthrough — do NOT duplicate
 * runner logic.
 *
 * Current iteration: stub that reads the existing `bench-report.json` (if a
 * prior `bun run bench` produced one) and translates it into eval records.
 * The full direct-spawn path is the documented next step in
 * `rfc/0003-eval-architecture.md` §5.
 */
import { existsSync, readFileSync } from "node:fs"
import { errMessage, logger } from "@/shared"
import { makeRunId, ResultStore } from "../../storage"
import type { Verdict } from "../../types"
import { findMapping } from "../mapping"

export interface SwebenchAdapterOpts {
  /** Path to a `bench-report.json` produced by `bun run bench`. */
  reportPath?: string
  /** Override store dir. */
  storeDir?: string
  now?: () => number
}

export interface SwebenchAdapterSummary {
  runId: string
  total: number
  counts: Record<Verdict, number>
  durationMs: number
}

const DEFAULT_REPORT = "bench-report.json"

interface RawInstance {
  id?: string
  resolved?: boolean
  durationMs?: number
}

interface RawReport {
  instances?: RawInstance[]
  summary?: { passed?: number; failed?: number; degraded?: number; total?: number }
}

/**
 * Map SWE-bench's tri-state `resolved` flag to a verdict.
 *
 * A unit because the third state is the whole point: `undefined` means the
 * bench has not graded the instance yet — that is NOT a fail, it is missing
 * data. Recording it as `error` keeps un-evaluated rows out of the pass rate.
 */
const swebenchVerdict = (resolved: boolean | undefined): Verdict =>
  resolved === true ? "pass" : resolved === false ? "fail" : "error"

/** Read a bench-report.json and translate each instance into a `PublicPayload`
 *  keyed under the SWE-bench primary use case. Missing/malformed report ⇒
 *  empty run that records ONE warning record so the operator notices. */
export const runSwebenchAdapter = async (
  opts: SwebenchAdapterOpts = {},
): Promise<SwebenchAdapterSummary> => {
  const start = Date.now()
  const reportPath = opts.reportPath ?? DEFAULT_REPORT
  const store = new ResultStore({
    ...(opts.storeDir !== undefined ? { dir: opts.storeDir } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  })
  const runId = makeRunId("public", opts.now)
  const mapping = findMapping("swebench-verified")
  if (mapping === undefined) {
    // Mapping must exist — its absence would mean the adapter is wired but
    // there's no taxonomy mapping, so records would silently land in a
    // hardcoded default. Fail loud instead.
    throw new Error("eval.public.swebench: no mapping for 'swebench-verified' in MAPPINGS")
  }
  const usecase = mapping.primary
  const counts: Record<Verdict, number> = {
    pass: 0,
    partial: 0,
    fail: 0,
    error: 0,
    skipped: 0,
  }
  if (!existsSync(reportPath)) {
    logger.warn("eval.public.swebench: report not found; run `bun run bench` first", {
      reportPath,
    })
    // Intentionally do NOT call store.finish() here — writing an empty run
    // summary would create a phantom "successful empty run" indistinguishable
    // in the report from a real zero-instance bench. The store stays clean
    // for this run id so report() shows no public column instead of false-OK.
    return { runId, total: 0, counts, durationMs: Date.now() - start }
  }
  let report: RawReport
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8")) as RawReport
  } catch (e) {
    logger.warn("eval.public.swebench: malformed report", {
      reportPath,
      error: errMessage(e),
    })
    // Same posture as missing report: don't fabricate an empty run summary.
    return { runId, total: 0, counts, durationMs: Date.now() - start }
  }
  const instances = Array.isArray(report.instances) ? report.instances : []
  for (const inst of instances) {
    if (typeof inst.id !== "string") continue
    const v = swebenchVerdict(inst.resolved)
    counts[v] += 1
    await store.append(runId, {
      tier: "public",
      usecase,
      payload: {
        kind: "public",
        bench: "swebench-verified",
        instanceId: inst.id,
        verdict: v,
        durationMs: typeof inst.durationMs === "number" ? inst.durationMs : 0,
      },
    })
  }
  const durationMs = Date.now() - start
  await store.finish({ runId, tier: "public", argv: process.argv.slice(2), counts, durationMs })
  return { runId, total: instances.length, counts, durationMs }
}
