/**
 * Batch-jobs DISPATCH adapters (GAP7-4) — the `@/subagent` bridge.
 *
 * The `@/agent/batch-jobs` domain slice is deliberately `@/shared`-only (port-
 * free, testable). This sibling module is the composition glue that imports
 * `@/subagent`: it adapts a {@link SubagentRunner} into the slice's
 * {@link RowDispatchPort} (ONE row = ONE child) and assembles a ready-to-run
 * {@link BatchRunPort} over an in-memory store (the agent-initiated, in-session
 * fan-out path; the durable sqlite path lives at the CLI composition root).
 *
 * Plane: `@/agent` may import `@/subagent` + `@/tool` (both below it) + its own
 * `batch-jobs` slice. NO-THROW: a thrown child becomes a typed dispatch failure
 * so the runner's retry/fail path owns it.
 */
import { err, errMessage, ok } from "@/shared"
import type { SubagentRequest, SubagentResult, SubagentRunner } from "@/subagent"
import { createJobResultReporter, reportJobResultTool } from "@/tool/report-job-result"
import type { BatchRunOutcome, BatchRunPort } from "@/tool/spawn-agents-csv"
import {
  type BatchJobItem,
  BatchJobRunner,
  DEFAULT_POOL_SIZE,
  InMemoryJobStore,
  parseRowsFromCsv,
  type RowDispatchPort,
  type RowDispatchResult,
} from "./batch-jobs"

/** Parse a child's final text into a structured value: strict JSON first (a
 *  child that emits `{...}` is taken verbatim), else `{ text }`. */
export const parseChildValue = (finalText: string): unknown => {
  const trimmed = finalText.trim()
  if (trimmed.length === 0) return { text: "" }
  try {
    return JSON.parse(trimmed)
  } catch {
    return { text: finalText }
  }
}

/**
 * Build a {@link RowDispatchPort} OVER a {@link SubagentRunner}. ONE call = ONE
 * row's subagent task (depth-1 child). NO-THROW: a runner rejection / failed
 * child / aborted dispatch resolves a typed `Err`, never rejects.
 */
export const buildRowDispatchAdapter = (
  runner: SubagentRunner,
  // GAP7-4 audit F1 — the depth to dispatch each row's child AT. The runner's
  // recursion guard (`req.depth > maxDepth`) is the authoritative fan-out bound;
  // a hardcoded `1` made it NEVER advance, so a batch child that itself ran a
  // batch recursed unbounded. The caller threads `parentDepth + 1` so a batch of
  // batches is capped by `maxDepth` exactly like normal `agent` recursion.
  childDepth = 1,
): RowDispatchPort => {
  return async (req) => {
    if (req.signal?.aborted) return err({ kind: "aborted" as const })
    const prompt = `${req.instruction}\n\n## Row ${req.rowIndex} (JSON)\n${req.rowJson}`
    // GAP7-2: give the child a per-row `report_agent_job_result` (via the
    // extraTools seam) so it can report a STRUCTURED result by tool-call; if it
    // does, that wins over parsing the free-text final message (more reliable).
    const captured = createJobResultReporter()
    const childReq: SubagentRequest = {
      prompt,
      depth: childDepth,
      taskKind: "read",
      extraTools: [reportJobResultTool(captured.reporter)],
      ...(req.signal ? { signal: req.signal } : {}),
    }
    let result: SubagentResult
    try {
      result = await runner(childReq)
    } catch (e) {
      return err({ kind: "store-failed" as const, reason: errMessage(e) })
    }
    if (req.signal?.aborted) return err({ kind: "aborted" as const })
    if (!result.ok) {
      return err({
        kind: "store-failed" as const,
        reason: result.finalText || "subagent dispatch failed",
      })
    }
    const taken = captured.taken()
    const value: RowDispatchResult = {
      value: taken.reported ? taken.value : parseChildValue(result.finalText),
    }
    return ok(value)
  }
}

const countByStatus = (
  items: ReadonlyArray<BatchJobItem>,
): Omit<BatchRunOutcome, "outputCsv" | "jobId"> => ({
  total: items.length,
  done: items.filter((i) => i.status === "done").length,
  failed: items.filter((i) => i.status === "failed").length,
})

/**
 * Build a {@link BatchRunPort} for AGENT-initiated batches: parse the CSV, run it
 * over an ephemeral {@link InMemoryJobStore} + the runner-backed dispatch, return
 * a results-CSV summary. (The durable sqlite + resume path is the human CLI's.)
 * NO-THROW: every fault resolves `{ ok:false, reason }`.
 */
export const buildInMemoryBatchRunPort = (
  runner: SubagentRunner,
  // GAP7-4 audit F1 — the depth of the agent INITIATING this batch. Each row's
  // child runs at `parentDepth + 1` so the runner's maxDepth guard bounds a
  // batch-of-batches (a child that calls spawn_agents_on_csv again).
  parentDepth = 0,
  // Injected clock (the `opts.now ?? Date.now` discipline — bare reference, not a
  // `Date.now()` literal, so the domain-clock ratchet stays clean). The batch
  // timestamps are job provenance, not model-facing replay.
  now: () => number = Date.now,
): BatchRunPort => ({
  run: async (input, signal) => {
    const parsed = parseRowsFromCsv(input.csv)
    if (!parsed.ok) return { ok: false, reason: `csv parse failed (${parsed.error.kind})` }
    const store = new InMemoryJobStore()
    const jobRunner = new BatchJobRunner({
      store,
      dispatch: buildRowDispatchAdapter(runner, parentDepth + 1),
      clock: now,
      newId: () => crypto.randomUUID(),
    })
    const submitted = await jobRunner.submit({
      name: input.name,
      instruction: input.instruction,
      rows: parsed.value.rows,
      headers: parsed.value.headers,
      poolSize: input.poolSize ?? DEFAULT_POOL_SIZE,
      maxAttempts: input.maxAttempts ?? 1,
    })
    if (!submitted.ok) {
      return {
        ok: false,
        reason:
          submitted.error.kind === "invalid-spec" ? submitted.error.reason : submitted.error.kind,
      }
    }
    const jobId = submitted.value
    // GAP7-4 audit F3 — surface an abort as a FAILURE. `runToEnd` returns
    // `Err({kind:"aborted"})` + leaves the job `cancelled`; discarding it would
    // report "0/N done" as a success and hide the cancellation from the agent.
    const ran = await jobRunner.runToEnd(jobId, signal)
    if (!ran.ok && ran.error.kind === "aborted") {
      return { ok: false, reason: "batch aborted" }
    }
    const snap = await jobRunner.snapshot(jobId)
    if (!snap.ok) return { ok: false, reason: `snapshot failed (${snap.error.kind})` }
    const csv = await jobRunner.exportCsv(jobId)
    if (!csv.ok) return { ok: false, reason: `export failed (${csv.error.kind})` }
    return {
      ok: true,
      outcome: { ...countByStatus(snap.value.items), outputCsv: csv.value, jobId },
    }
  },
})
