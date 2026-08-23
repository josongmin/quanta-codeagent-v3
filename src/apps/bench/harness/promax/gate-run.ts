/**
 * PMX-04 — the ProMax gate RUN: the process boundary PMX-03 deferred.
 *
 * PMX-03 built every pure piece of a gate (the sentinel patch, the predictions
 * file, the argv, the classification, the receipt, the gate verdict) and stopped
 * exactly where an effect was required. This module is that missing step, and
 * NOTHING ELSE: it owns the ORDER the pieces compose in and the four process
 * facts the receipt is total over. Every verdict it reports is computed by the
 * PMX-03 owner it delegates to.
 *
 * Effects arrive through {@link ProMaxGateRunPorts}, so the whole composition —
 * including the refusals — is testable without a daemon, an image, or a process.
 *
 * ## Four things learned by RUNNING the first real gate
 *
 * 0. **The interpreter is a precondition, not a preference.** The pinned
 *    evaluator needs Python >=3.10 and the system `python3` here is 3.9, so the
 *    first attempt died with a `TypeError` pointing at the evaluator's own
 *    source — a wrong-interpreter failure wearing a broken-evaluator costume.
 *    The floor is now checked ahead of the spawn (see `evaluator-python.ts`),
 *    because a requirement recorded only in a doc comment is folklore.
 * 1. **Verify before you spawn.** The evaluator's bytes are hash-pinned by
 *    PMX-00. A gate that runs an *unverified* evaluator is not evidence, so the
 *    hash check is a REFUSAL that happens before the spawn, not a warning
 *    printed after it.
 * 2. **A gate must leave evidence.** The first Gate-1 pass existed only in a
 *    terminal. The receipt is therefore persisted on the way out — and it is
 *    persisted when the gate FAILS too, because a failed gate is precisely the
 *    one an operator needs the artifact for.
 * 3. **All four process facts, always.** exit code, stdout, stderr and the
 *    output file are handed to the receipt builder together. That builder is
 *    total over crash / no-output / non-zero / schema drift, and it can only
 *    stay total if the caller never pre-filters those cases into a throw.
 *
 * ## What this module deliberately does NOT do
 *
 * It does not classify a verdict, does not know what `apply_failed` means, does
 * not format a report, and does not reimplement one line of `test_run.py`.
 */
import { posix } from "node:path"
import { sha256Hex } from "@/apps/bench/promax/provenance"
import {
  PROMAX_V1_SNAPSHOT,
  PROMAX_V1_UPSTREAM_PATHS,
} from "@/apps/bench/promax/provenance/frozen-snapshot"
import type {
  OfficialEvaluatorIdentity,
  OfficialGradeReceipt,
  OfficialGradeSummary,
} from "@/runner/batch/eval/official-grade"
import {
  serializeOfficialGradeReceipt,
  summarizeOfficialGrade,
} from "@/runner/batch/eval/official-grade"
import { byteCompare } from "@/shared/byte-compare"
import {
  describePythonFloorRefusal,
  meetsPythonFloor,
  parsePythonVersion,
} from "../../profiles/python-version"
import { buildProMaxOfficialGradeReceipt } from "./adapter"
import { PROMAX_EVALUATOR_PYTHON_FLOOR } from "./evaluator-python"
import type { GoldSentinelGateFailure, GoldSentinelGateResult } from "./gold-sentinel"
import { buildGoldSentinelPatch, evaluateGoldSentinelGate } from "./gold-sentinel"
import {
  buildProMaxEvaluatorInvocation,
  PROMAX_EVAL_META_RELATIVE_PATH,
  PROMAX_EVALUATOR_RELATIVE_PATH,
  serializeProMaxPredictions,
} from "./invocation"

/** The gate this module runs. Gate 2+ consume the same boundary. */
export const PROMAX_GOLD_SENTINEL_GATE = "gold-sentinel"

export const PROMAX_PREDICTIONS_FILENAME = "preds.json"
export const PROMAX_PASS_RATE_FILENAME = "pass-rate.json"
export const PROMAX_GATE_RECEIPT_FILENAME = "gate-receipt.json"

/**
 * The pinned bytes a gate is allowed to execute.
 *
 * These are the PMX-00 frozen values, referenced rather than re-typed: a second
 * hand-written copy of a hash is a second thing that can drift from upstream.
 */
export interface ProMaxEvaluatorPins {
  readonly evaluatorSha256: string
  readonly evalMetaSha256: string
}

export const PROMAX_V1_EVALUATOR_PINS: ProMaxEvaluatorPins = Object.freeze({
  evaluatorSha256: PROMAX_V1_SNAPSHOT.evaluator_sha256,
  evalMetaSha256: PROMAX_V1_SNAPSHOT.eval_sha256,
})

/** What the wrapper observed of the spawned process. Mirrors `ProMaxEvaluatorRun`'s process half. */
export interface ProMaxSpawnObservation {
  /** `null` when the process never delivered an exit status (killed/crashed). */
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Every effect a gate needs. Injected, so a test drives the whole composition —
 * including the spawn — with no daemon and no real filesystem.
 */
export interface ProMaxGateRunPorts {
  /** raw bytes, for hashing. `null` when the file is absent. */
  readonly readBytes: (absPath: string) => Uint8Array | null
  /** text, for the evaluator's output document. `null` when never written. */
  readonly readText: (absPath: string) => string | null
  readonly writeText: (absPath: string, text: string) => void
  /**
   * Ask an interpreter for its version (`<exe> --version`).
   *
   * A port of its OWN, not a second call through {@link spawn}, because the two
   * are asked different questions and a test must be able to answer them
   * separately: every gate test would otherwise have to make its evaluator fake
   * also impersonate a version banner, and the ones that did not would fail for
   * a reason unrelated to what they pin.
   */
  readonly probePython: (pythonExecutable: string) => ProMaxSpawnObservation
  readonly spawn: (argv: readonly string[], cwd: string) => ProMaxSpawnObservation
  readonly now: () => string
}

export interface ProMaxGateRunInput {
  readonly campaignId: string
  /** the campaign denominator — coverage is measured against exactly this set. */
  readonly assignedInstanceIds: readonly string[]
  /** absolute root of the verified pinned checkout. */
  readonly pinnedRoot: string
  /** campaign golden file. GRADER-ONLY; never an agent-visible path. */
  readonly goldenPath: string
  /** absolute directory the gate's artifacts are written into. */
  readonly workDir: string
  /**
   * The DEDICATED interpreter for the pinned evaluator.
   *
   * Its version is CHECKED against {@link PROMAX_EVALUATOR_PYTHON_FLOOR} before
   * the evaluator is spawned — this used to be a doc comment saying "≥3.10" and
   * nothing more, which is how a 3.9 box got as far as producing a traceback
   * that blamed the evaluator.
   */
  readonly pythonExecutable: string
}

/**
 * Where a run stopped. Each stage owns a disjoint set of refusal codes, so an
 * operator reads WHAT failed from the stage and WHY from the code.
 */
export type ProMaxGateStage =
  | "verify-evaluator"
  | "python"
  | "work-dir"
  | "predictions"
  | "invocation"
  | "identity"
  | "receipt"

export interface ProMaxGateRefusal {
  readonly code: string
  readonly message: string
}

export interface ProMaxVerdictCount {
  readonly state: string
  readonly reason: string
  readonly count: number
}

export interface ProMaxGateRefused {
  readonly outcome: "refused"
  readonly stage: ProMaxGateStage
  readonly failures: readonly ProMaxGateRefusal[]
}

export interface ProMaxGateJudged {
  readonly outcome: "judged"
  readonly gate: GoldSentinelGateResult
  readonly summary: OfficialGradeSummary
  readonly receipt: OfficialGradeReceipt
  readonly receiptPath: string
  readonly predictionsPath: string
  readonly outputPath: string
  readonly observation: ProMaxSpawnObservation
  readonly verdictCounts: readonly ProMaxVerdictCount[]
}

export type ProMaxGateRunResult = ProMaxGateJudged | ProMaxGateRefused

/** The pinned files a gate verifies before it runs anything. */
export interface ProMaxVerifiedEvaluator {
  readonly evaluatorPath: string
  readonly evaluatorSha256: string
  readonly evalMetaPath: string
  readonly evalMetaSha256: string
}

export type ProMaxVerifyResult =
  | { readonly ok: true; readonly verified: ProMaxVerifiedEvaluator }
  | { readonly ok: false; readonly failures: readonly ProMaxGateRefusal[] }

interface PinnedFileCheck {
  readonly path: string
  readonly expected: string
  readonly absentCode: string
  readonly mismatchCode: string
  readonly label: string
}

const checkPinnedFile = (
  ports: ProMaxGateRunPorts,
  check: PinnedFileCheck,
  sink: ProMaxGateRefusal[],
): string | null => {
  const bytes = ports.readBytes(check.path)
  if (bytes === null) {
    sink.push({
      code: check.absentCode,
      message:
        `the pinned ${check.label} is absent at ${check.path} — the campaign cannot grade against ` +
        "a file it does not have",
    })
    return null
  }
  const observed = sha256Hex(bytes)
  if (observed !== check.expected) {
    sink.push({
      code: check.mismatchCode,
      message:
        `the pinned ${check.label} at ${check.path} hashes to ${observed}, not the frozen ` +
        `${check.expected}. REFUSING — a gate that runs an unverified evaluator is not evidence.`,
    })
    return null
  }
  return observed
}

/**
 * Hash-verify the staged evaluator AND the eval metadata it reads, against the
 * frozen pins.
 *
 * Both are verified because both are inputs to the verdict: a correct
 * `test_run.py` reading a drifted `eval.json` grades the wrong thing.
 */
export const verifyPinnedEvaluator = (
  ports: ProMaxGateRunPorts,
  pinnedRoot: string,
  pins: ProMaxEvaluatorPins = PROMAX_V1_EVALUATOR_PINS,
): ProMaxVerifyResult => {
  const root = pinnedRoot.replace(/\/+$/, "")
  const evaluatorPath = posix.join(root, PROMAX_EVALUATOR_RELATIVE_PATH)
  const evalMetaPath = posix.join(root, PROMAX_EVAL_META_RELATIVE_PATH)
  const failures: ProMaxGateRefusal[] = []

  const evaluatorSha256 = checkPinnedFile(
    ports,
    {
      path: evaluatorPath,
      expected: pins.evaluatorSha256,
      absentCode: "evaluator_file_absent",
      mismatchCode: "evaluator_sha256_mismatch",
      label: "evaluator",
    },
    failures,
  )
  const evalMetaSha256 = checkPinnedFile(
    ports,
    {
      path: evalMetaPath,
      expected: pins.evalMetaSha256,
      absentCode: "eval_meta_file_absent",
      mismatchCode: "eval_meta_sha256_mismatch",
      label: "eval metadata",
    },
    failures,
  )

  if (evaluatorSha256 === null || evalMetaSha256 === null) return { ok: false, failures }
  return { ok: true, verified: { evaluatorPath, evaluatorSha256, evalMetaPath, evalMetaSha256 } }
}

/**
 * Refuse an interpreter that cannot run the pinned evaluator, BEFORE it is asked
 * to.
 *
 * The floor is a property of the pinned evaluator's bytes
 * ({@link PROMAX_EVALUATOR_PYTHON_FLOOR}), so this is the same class of check as
 * the hash verification above: establish that the thing about to run is the
 * thing that can run, and refuse with a named reason rather than letting the OS
 * produce a traceback that blames the evaluator.
 *
 * Two distinct refusals, because they need different operator actions: an
 * interpreter that ANSWERS and is too old, and one whose probe produced nothing
 * readable (absent executable, non-zero exit, a wrapper that prints something
 * else). Fail-closed — unreadable is a refusal, never an assumed pass.
 */
export const checkProMaxGatePython = (
  ports: ProMaxGateRunPorts,
  pythonExecutable: string,
): readonly ProMaxGateRefusal[] => {
  const probe = ports.probePython(pythonExecutable)
  const observed =
    probe.exitCode === 0 ? parsePythonVersion(`${probe.stdout}${probe.stderr}`) : null
  if (observed === null) {
    return [
      {
        code: "python_version_unreadable",
        message: describePythonFloorRefusal({
          label: "evaluator interpreter",
          executable: pythonExecutable,
          observed: null,
          floor: PROMAX_EVALUATOR_PYTHON_FLOOR,
        }),
      },
    ]
  }
  if (meetsPythonFloor(observed, PROMAX_EVALUATOR_PYTHON_FLOOR.minimum)) return []
  return [
    {
      code: "python_below_floor",
      message: describePythonFloorRefusal({
        label: "evaluator interpreter",
        executable: pythonExecutable,
        observed,
        floor: PROMAX_EVALUATOR_PYTHON_FLOOR,
      }),
    },
  ]
}

/** Stable grader id for this family, derived from the pinned upstream layout. */
export const PROMAX_EVALUATOR_ID = `swe-bench-promax/${PROMAX_V1_UPSTREAM_PATHS.evaluator}`

export interface ProMaxIdentityInput {
  readonly evaluatorPath: string
  readonly evaluatorSha256: string
  readonly argv: readonly string[]
  readonly cwd: string
}

export type ProMaxIdentityResult =
  | { readonly ok: true; readonly identity: OfficialEvaluatorIdentity }
  | { readonly ok: false; readonly failures: readonly ProMaxGateRefusal[] }

/**
 * Mint the SIX-field evaluator identity from real, observed values.
 *
 * The receipt builder refuses a receipt whose identity is incomplete, and that
 * refusal is correct — it is what keeps a receipt replayable. This function
 * therefore never substitutes a placeholder to get past it: it refuses first,
 * with its own name, so the failure is attributed to the caller that had no
 * value rather than to the receipt layer.
 *
 * `evaluatorSha256` is the VERIFIED hash from {@link verifyPinnedEvaluator};
 * it is never accepted from a caller's assertion.
 */
export const buildProMaxEvaluatorIdentity = (input: ProMaxIdentityInput): ProMaxIdentityResult => {
  const failures: ProMaxGateRefusal[] = []
  const blank = (value: unknown): boolean => typeof value !== "string" || value.trim() === ""
  const missing: string[] = []
  if (blank(input.evaluatorPath)) missing.push("evaluatorPath")
  if (blank(input.evaluatorSha256)) missing.push("evaluatorSha256")
  if (blank(input.cwd)) missing.push("cwd")
  if (!Array.isArray(input.argv) || input.argv.length === 0) missing.push("argv")
  if (missing.length > 0) {
    failures.push({
      code: "identity_incomplete",
      message:
        `cannot mint an evaluator identity: ${missing.join(", ")} absent or blank. Every field is ` +
        "replay evidence, and a placeholder would make the receipt lie about what ran.",
    })
    return { ok: false, failures }
  }
  return {
    ok: true,
    identity: {
      evaluatorId: PROMAX_EVALUATOR_ID,
      upstreamCommit: PROMAX_V1_SNAPSHOT.upstream_git_commit,
      evaluatorPath: input.evaluatorPath,
      evaluatorSha256: input.evaluatorSha256,
      argv: input.argv,
      cwd: input.cwd,
    },
  }
}

/** Per-(state, reason) tallies — the shape an operator reads a gate by. */
export const countVerdicts = (receipt: OfficialGradeReceipt): readonly ProMaxVerdictCount[] => {
  // The (state, reason) pair is carried IN the bucket rather than parsed back
  // out of a joined key. Every state and reason is underscore-only today, so a
  // string key round-trip happens to work — and would silently mis-tally the
  // first time either contains the separator. Nothing here needs to know that.
  const counts = new Map<string, ProMaxVerdictCount>()
  for (const id of receipt.assignedInstanceIds) {
    const d = receipt.dispositionsByInstanceId.get(id)
    const state = d === undefined ? "missing" : d.state
    const reason = d === undefined ? "-" : d.reason
    const key = `${state}\u0000${reason}`
    const seen = counts.get(key)
    counts.set(key, { state, reason, count: (seen?.count ?? 0) + 1 })
  }
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || byteCompare(a.state, b.state) || byteCompare(a.reason, b.reason),
  )
}

/** The persisted gate artifact. Plain JSON — a `Map` does not survive. */
export interface ProMaxGateReceiptDocument {
  readonly schema_version: 1
  readonly gate: typeof PROMAX_GOLD_SENTINEL_GATE
  readonly campaignId: string
  readonly producedAt: string
  readonly gateOk: boolean
  readonly gateFailures: readonly GoldSentinelGateFailure[]
  readonly summary: OfficialGradeSummary
  readonly verdictCounts: readonly ProMaxVerdictCount[]
  /** the generic receipt, exactly as its own owner serializes it. */
  readonly receipt: unknown
}

export const buildProMaxGateReceiptDocument = (input: {
  readonly campaignId: string
  readonly producedAt: string
  readonly gate: GoldSentinelGateResult
  readonly receipt: OfficialGradeReceipt
}): ProMaxGateReceiptDocument => ({
  schema_version: 1,
  gate: PROMAX_GOLD_SENTINEL_GATE,
  campaignId: input.campaignId,
  producedAt: input.producedAt,
  gateOk: input.gate.ok,
  gateFailures: input.gate.failures,
  summary: summarizeOfficialGrade(input.receipt),
  verdictCounts: countVerdicts(input.receipt),
  // composed, not reimplemented: the receipt's own owner decides its shape.
  receipt: JSON.parse(serializeOfficialGradeReceipt(input.receipt)) as unknown,
})

/**
 * Run one gold-sentinel gate end to end.
 *
 * The order is the contract: verify → predict → build argv → mint identity →
 * SPAWN → read output → receipt → gate → persist. Everything before the spawn
 * can refuse, and refusing there means no process ever started.
 */
export const runProMaxGate = (
  input: ProMaxGateRunInput,
  ports: ProMaxGateRunPorts,
  pins: ProMaxEvaluatorPins = PROMAX_V1_EVALUATOR_PINS,
): ProMaxGateRunResult => {
  const verified = verifyPinnedEvaluator(ports, input.pinnedRoot, pins)
  if (!verified.ok) {
    return { outcome: "refused", stage: "verify-evaluator", failures: verified.failures }
  }

  // SECOND, and still before anything is written or spawned: can the named
  // interpreter run the evaluator at all? The hash check keeps its place ahead
  // of this one — it spawns nothing, and "your evaluator is not the pinned one"
  // is the more urgent thing to be told.
  const pythonFailures = checkProMaxGatePython(ports, input.pythonExecutable)
  if (pythonFailures.length > 0) {
    return { outcome: "refused", stage: "python", failures: pythonFailures }
  }

  const patch = buildGoldSentinelPatch(input.campaignId)
  const predictions = serializeProMaxPredictions(
    input.assignedInstanceIds.map((instanceId) => ({ instanceId, modelPatch: patch })),
  )
  if (!predictions.ok) {
    return { outcome: "refused", stage: "predictions", failures: predictions.failures }
  }

  const workDir = input.workDir.replace(/\/+$/, "")
  const predictionsPath = posix.join(workDir, PROMAX_PREDICTIONS_FILENAME)
  const outputPath = posix.join(workDir, PROMAX_PASS_RATE_FILENAME)

  // A LEFTOVER output file is refused, never overwritten and never merged (the
  // same posture as `destination_not_empty` in bundle assembly). The evaluator
  // writes this file only on success, so if it dies early the reader below would
  // pick up the PREVIOUS run's verdicts and grade this run against them — a
  // green gate assembled from evidence that is not its own.
  if (ports.readText(outputPath) !== null) {
    return {
      outcome: "refused",
      stage: "work-dir",
      failures: [
        {
          code: "stale_output_present",
          message:
            `${outputPath} already exists. REFUSING — a gate that dies before writing its output ` +
            "would be graded against the previous run's verdicts. Use a fresh --work-dir, or " +
            "remove the leftover file deliberately.",
        },
      ],
    }
  }

  const invocation = buildProMaxEvaluatorInvocation({
    pinnedRoot: input.pinnedRoot,
    predictionsPath,
    goldenPath: input.goldenPath,
    outputPath,
    pythonExecutable: input.pythonExecutable,
    // `workers` is deliberately NOT plumbed: it stays at the owner's pinned 1
    // until a measured concurrency campaign changes it there.
  })
  if (!invocation.ok) {
    return { outcome: "refused", stage: "invocation", failures: invocation.failures }
  }

  const identity = buildProMaxEvaluatorIdentity({
    evaluatorPath: verified.verified.evaluatorPath,
    evaluatorSha256: verified.verified.evaluatorSha256,
    argv: invocation.invocation.argv,
    cwd: invocation.invocation.cwd,
  })
  if (!identity.ok) {
    return { outcome: "refused", stage: "identity", failures: identity.failures }
  }

  // Only now does anything execute.
  ports.writeText(predictionsPath, predictions.json)
  const observation = ports.spawn(invocation.invocation.argv, invocation.invocation.cwd)

  const built = buildProMaxOfficialGradeReceipt({
    assignedInstanceIds: input.assignedInstanceIds,
    evaluator: identity.identity,
    run: {
      exitCode: observation.exitCode,
      stdout: observation.stdout,
      stderr: observation.stderr,
      // absent output is a FACT handed to a total builder, never a throw here.
      outputJsonText: ports.readText(outputPath),
      outputPath,
    },
  })
  if (!built.ok) {
    return {
      outcome: "refused",
      stage: "receipt",
      failures: built.failures.map((f) => ({ code: f.code, message: f.message })),
    }
  }

  const receipt = built.receipt
  const gate = evaluateGoldSentinelGate(receipt)
  const receiptPath = posix.join(workDir, PROMAX_GATE_RECEIPT_FILENAME)
  const document = buildProMaxGateReceiptDocument({
    campaignId: input.campaignId,
    producedAt: ports.now(),
    gate,
    receipt,
  })
  // Persisted for a FAILED gate too — that is the one an operator needs.
  ports.writeText(receiptPath, `${JSON.stringify(document, null, 2)}\n`)

  return {
    outcome: "judged",
    gate,
    summary: document.summary,
    receipt,
    receiptPath,
    predictionsPath,
    outputPath,
    observation,
    verdictCounts: document.verdictCounts,
  }
}
