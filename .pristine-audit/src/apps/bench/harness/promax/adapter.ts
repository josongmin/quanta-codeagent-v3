/**
 * PMX-03 — ONE pinned-evaluator run → ONE generic official-grade receipt.
 *
 * This is the only place that turns `pass_rate.json` into runner-visible
 * dispositions. Two boundaries are enforced here rather than trusted:
 *
 * INFRASTRUCTURE vs MODEL. A crashed evaluator, an absent output file, a
 * non-zero exit, or a drifted schema means WE cannot grade — every assigned
 * instance becomes `infra_invalid`, and the raw streams are retained as the
 * evidence. It never becomes a model failure, and it never becomes `missing`
 * either: `missing` means "never observed", and here we observed a failure.
 *
 * GRADER-ONLY BYTES STOP HERE. The evaluator's `stdout`/`stderr` — including the
 * reference side's — stay on the receipt's evaluator metadata and in the raw
 * artifact on disk. They are deliberately absent from every per-instance
 * disposition, so no report, dashboard, or prompt can carry them onward.
 */
import { sha256Hex } from "@/apps/bench/promax/provenance"
import type {
  OfficialEvaluatorIdentity,
  OfficialEvaluatorSummary,
  OfficialGradeDisposition,
  OfficialGradeEvaluatorMeta,
  OfficialGradeReason,
  OfficialGradeReceiptFailure,
  OfficialGradeReceiptResult,
  RawArtifactRef,
} from "@/runner/batch/eval/official-grade"
import {
  buildOfficialGradeReceipt,
  GRADING_VALID_BY_STATE,
} from "@/runner/batch/eval/official-grade"
import { classifyOfficialPair } from "./classify"
import type { OfficialRowParse, OfficialSideDrift } from "./official-result"
import { parseOfficialPassRateDocument } from "./official-result"

/** What the wrapper observed when it ran the pinned evaluator. */
export interface ProMaxEvaluatorRun {
  /** `null` when the process never delivered an exit status (killed/crashed). */
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  /** contents of `--output`, or `null` when the file was never written. */
  readonly outputJsonText: string | null
  readonly outputPath: string
}

export interface ProMaxGradeInput {
  /** the campaign denominator. Coverage is measured against exactly this set. */
  readonly assignedInstanceIds: readonly string[]
  readonly evaluator: OfficialEvaluatorIdentity
  readonly run: ProMaxEvaluatorRun
  /**
   * AUDIT-ONLY. Instances whose submitted prediction carried no patch bytes.
   * Recorded on the disposition for the legacy `emptyPatch` bucket; it never
   * changes a state or reason — golden authority still decides.
   */
  readonly emptyPredictionInstanceIds?: readonly string[] | undefined
}

const summaryOf = (
  passed: boolean | null,
  model: OfficialSideDrift | null,
  golden: OfficialSideDrift | null,
): OfficialEvaluatorSummary => ({ passed, model, golden })

/**
 * Evaluator-level failure, if any. Ordered most-fundamental first: a process
 * that never exited tells us nothing about its file, and an absent file tells
 * us nothing about its schema.
 */
const evaluatorFailureReason = (run: ProMaxEvaluatorRun): OfficialGradeReason | null => {
  if (run.exitCode === null) return "evaluator_unavailable"
  if (run.outputJsonText === null) return "evaluator_no_output"
  if (run.exitCode !== 0) return "evaluator_nonzero_exit"
  return null
}

const disposition = (
  instanceId: string,
  state: OfficialGradeDisposition["state"],
  reason: OfficialGradeReason,
  rawArtifact: RawArtifactRef | null,
  evaluator: OfficialEvaluatorSummary,
  predictionEmpty: boolean,
): OfficialGradeDisposition => ({
  instanceId,
  state,
  reason,
  gradingValid: GRADING_VALID_BY_STATE[state],
  rawArtifact,
  evaluator,
  ...(predictionEmpty ? { predictionEmpty: true } : {}),
})

const dispositionForRow = (
  row: OfficialRowParse,
  rawArtifact: RawArtifactRef | null,
  isEmpty: (id: string) => boolean,
): OfficialGradeDisposition | null => {
  if (row.ok) {
    const outcome = classifyOfficialPair(row.golden.finalResult, row.model.finalResult)
    return disposition(
      row.instanceId,
      outcome.state,
      outcome.reason,
      rawArtifact,
      summaryOf(row.passed, row.model, row.golden),
      isEmpty(row.instanceId),
    )
  }
  if (row.instanceId === null) return null
  // structurally readable but drifted: attribute it, keep the verbatim strings
  return disposition(
    row.instanceId,
    "infra_invalid",
    "schema_invalid",
    rawArtifact,
    summaryOf(row.passed, row.model, row.golden),
    isEmpty(row.instanceId),
  )
}

/**
 * Build the receipt. Fails closed on anything the generic contract refuses
 * (duplicate rows, a row for an unassigned instance, an unattributable row).
 */
const artifactOf = (run: ProMaxEvaluatorRun): RawArtifactRef | null =>
  run.outputJsonText === null
    ? null
    : {
        path: run.outputPath,
        sha256: sha256Hex(run.outputJsonText),
        byteLength: Buffer.byteLength(run.outputJsonText, "utf8"),
      }

/**
 * The evaluator-level verdict for the whole run: a crash, an absent output
 * file, a non-zero exit, or a document that is not the JSON array upstream
 * always writes. `rows` is present only when the run is trustworthy enough to
 * read per-instance.
 */
type WholeRunVerdict =
  | { readonly reason: OfficialGradeReason; readonly rows?: undefined }
  | { readonly reason: null; readonly rows: readonly OfficialRowParse[] }

const readWholeRun = (run: ProMaxEvaluatorRun): WholeRunVerdict => {
  const processFailure = evaluatorFailureReason(run)
  if (processFailure !== null) return { reason: processFailure }
  // `evaluatorFailureReason` already refused a null output file above.
  const document = parseOfficialPassRateDocument(run.outputJsonText ?? "")
  return document.ok ? { reason: null, rows: document.rows } : { reason: "schema_invalid" }
}

export const buildProMaxOfficialGradeReceipt = (
  input: ProMaxGradeInput,
): OfficialGradeReceiptResult => {
  const { run } = input
  const artifact = artifactOf(run)
  const evaluator: OfficialGradeEvaluatorMeta = {
    ...input.evaluator,
    exitCode: run.exitCode,
    stdout: run.stdout,
    stderr: run.stderr,
    outputArtifact: artifact,
  }
  const emptySet = new Set(input.emptyPredictionInstanceIds ?? [])
  const isEmpty = (id: string): boolean => emptySet.has(id)

  // Evaluator-level failure: every assigned instance is infrastructure-invalid,
  // with the raw streams and artifact retained on the receipt as the evidence.
  // It is NOT `missing` — we observed the failure.
  const verdict = readWholeRun(run)
  if (verdict.reason !== null) {
    const blanketReason = verdict.reason
    return buildOfficialGradeReceipt({
      assignedInstanceIds: input.assignedInstanceIds,
      dispositions: input.assignedInstanceIds.map((id) =>
        disposition(
          id,
          "infra_invalid",
          blanketReason,
          artifact,
          summaryOf(null, null, null),
          isEmpty(id),
        ),
      ),
      evaluator,
    })
  }

  const extra: OfficialGradeReceiptFailure[] = []
  const dispositions: OfficialGradeDisposition[] = []
  for (const row of verdict.rows) {
    const d = dispositionForRow(row, artifact, isEmpty)
    if (d === null) {
      extra.push({
        code: "row_unattributable",
        message:
          "evaluator emitted a result row with no usable instance_id " +
          `(${row.ok ? "" : row.detail}) — it cannot be scored or ignored safely`,
      })
      continue
    }
    dispositions.push(d)
  }

  const built = buildOfficialGradeReceipt({
    assignedInstanceIds: input.assignedInstanceIds,
    dispositions,
    evaluator,
  })
  if (extra.length === 0) return built
  return { ok: false, failures: [...extra, ...(built.ok ? [] : built.failures)] }
}
