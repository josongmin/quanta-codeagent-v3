/**
 * PMX-04 operator tool — run ONE ProMax gate end to end and leave the receipt
 * on disk.
 *
 * Like `assemble-bundle.ts` and `verify-bundle.ts`, this is a THIN shell over a
 * single owner. It hashes nothing, classifies nothing, decides no verdict, and
 * knows no argv: all of that is `@/apps/bench/harness/promax`'s `runProMaxGate`.
 * What lives here is only what a pure module cannot do — read a file, write a
 * file, start a process, and render the result for a human.
 *
 * Usage:
 *   bun run tools/bench-promax/run-gate.ts \
 *     --campaign  <campaign id>      \
 *     --pinned-root <verified upstream checkout>  \
 *     --golden    <campaign-golden.json>          \
 *     --work-dir  <output directory>              \
 *     --python    <dedicated interpreter>         \
 *     [--ids <a,b,c>]            # default: every instance in the golden file
 *
 * `--python` must be a DEDICATED interpreter of Python >=3.10, and the tool now
 * CHECKS it before spawning anything: the pinned evaluator uses PEP 604
 * (`int | None`) in an annotation and dies on 3.9 with
 * `TypeError: unsupported operand type(s) for |: 'type' and 'NoneType'` — a
 * traceback pointing at the evaluator's own source, which reads like a broken
 * grader rather than a wrong interpreter.
 *
 * 🔴 It is a TypeError, NOT a SyntaxError (this comment said otherwise until it
 * was measured): the module COMPILES cleanly on 3.9 and fails at import, when
 * the annotation is evaluated. No syntax check can catch it — only the version.
 *
 * The evaluator's own concurrency is NOT exposed. It stays at the pinned 1 until
 * a measured concurrency campaign changes it at the owner.
 *
 * SPEND: Gate 1 (gold sentinel) spends NO model tokens — it submits a synthetic
 * patch that cannot apply. It does require the campaign's images to be present.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import {
  type ProMaxGateRunInput,
  type ProMaxGateRunPorts,
  type ProMaxGateRunResult,
  type ProMaxSubmittedPatch,
  runProMaxGate,
} from "@/apps/bench/harness/promax"

export interface RunGateResult {
  readonly exitCode: number
  readonly output: string
}

/**
 * Real effects. `spawnSync` is deliberate: the evaluator is the only thing
 * running, its output is a file, and a gate that returned before its grader
 * finished would report on an absent artifact.
 *
 * `maxBuffer` is raised because the pinned evaluator streams every container's
 * build and test output through stdout; the default 1 MiB truncates it and the
 * truncation lands in the receipt's replay evidence.
 */
export const makeRunGatePorts = (): ProMaxGateRunPorts => ({
  readBytes: (path) => (existsSync(path) ? new Uint8Array(readFileSync(path)) : null),
  readText: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
  writeText: (path, text) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  },
  probePython: (pythonExecutable) => {
    const proc = spawnSync(pythonExecutable, ["--version"], { encoding: "utf8" })
    return {
      // A missing executable surfaces as an ERROR with no status; that is a
      // failed probe, not a version-zero interpreter.
      exitCode: proc.error !== undefined ? 127 : proc.status,
      stdout: proc.stdout ?? "",
      // `--version` went to stderr before Python 3.4; both streams are read.
      stderr: proc.stderr ?? "",
    }
  },
  spawn: (argv, cwd) => {
    const [command, ...rest] = argv
    if (command === undefined) throw new Error("promax run-gate: empty argv")
    const proc = spawnSync(command, rest, {
      cwd,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
    })
    return {
      // `status` is null when the process was signalled rather than exiting.
      exitCode: proc.status,
      stdout: proc.stdout ?? "",
      stderr: proc.stderr ?? "",
    }
  },
  now: () => new Date().toISOString(),
})

const renderRefused = (result: Extract<ProMaxGateRunResult, { outcome: "refused" }>): string =>
  [
    `REFUSED at stage "${result.stage}" — the gate did NOT run (${result.failures.length} failure(s)):`,
    ...result.failures.map((f) => `  [${f.code}] ${f.message}`),
  ].join("\n")

/** The counts + artifact block both completed outcomes share. */
const renderProduced = (
  result: Extract<ProMaxGateRunResult, { outcome: "judged" | "graded" }>,
): string[] => {
  const s = result.summary
  return [
    `  assigned ${s.assigned} | gradingValid ${s.gradingValid} | coverage ${s.coverage} | ` +
      `missing ${s.missing} | infraInvalid ${s.infraInvalid}`,
    `  evaluator exit ${String(result.observation.exitCode)}`,
    "  verdicts",
    ...result.verdictCounts.map(
      (v) => `    ${String(v.count).padStart(4)}/${s.assigned}  ${v.state} / ${v.reason}`,
    ),
  ]
}

const renderArtifacts = (
  result: Extract<ProMaxGateRunResult, { outcome: "judged" | "graded" }>,
): string[] => [
  "  artifacts",
  `    receipt      ${result.receiptPath}`,
  `    predictions  ${result.predictionsPath}`,
  `    evaluator    ${result.outputPath}`,
]

const renderJudged = (result: Extract<ProMaxGateRunResult, { outcome: "judged" }>): string => {
  const lines = [
    `GATE gold-sentinel — ${result.gate.ok ? "PASS" : "FAIL"}`,
    ...renderProduced(result),
  ]
  if (!result.gate.ok) {
    lines.push(`  gate failures (${result.gate.failures.length})`)
    for (const f of result.gate.failures.slice(0, 20)) {
      lines.push(`    [${f.code}] ${f.instanceId}`)
    }
  }
  lines.push(...renderArtifacts(result))
  return lines.join("\n")
}

/**
 * A model stage. Says GRADED, never PASS/FAIL.
 *
 * The verdict is not this tool's to give: Gate 2's clauses need the frozen
 * campaign record, so `campaign-gates.ts` judges it from the receipt below.
 * Printing a PASS here — or reusing the sentinel gate, which would report PASS
 * for "the patches did not apply" — would be an authoritative-looking verdict
 * that no gate actually issued.
 */
const renderGraded = (result: Extract<ProMaxGateRunResult, { outcome: "graded" }>): string =>
  [
    "STAGE model-smoke — GRADED (not judged here)",
    ...renderProduced(result),
    ...renderArtifacts(result),
    "  next: judge it with",
    "    bun tools/bench-promax/campaign-gates.ts gate --gate gate2_pmx7_model \\",
    "      --record <campaign-record.json> --evidence <evidence.json> --out gate2.result.json",
  ].join("\n")

export const renderGateResult = (result: ProMaxGateRunResult): RunGateResult => {
  if (result.outcome === "refused") return { exitCode: 1, output: renderRefused(result) }
  // A graded-but-unjudged stage exits 0: the RUN succeeded. Exiting non-zero
  // would read as "the model stage failed", which is a verdict this tool is
  // explicitly not entitled to make.
  if (result.outcome === "graded") return { exitCode: 0, output: renderGraded(result) }
  return { exitCode: result.gate.ok ? 0 : 1, output: renderJudged(result) }
}

const flag = (argv: readonly string[], name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const required = (argv: readonly string[], name: string): string => {
  const value = flag(argv, name)
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required — this tool never guesses a campaign path`)
  }
  return value
}

/**
 * Read the assigned ids from the campaign golden file.
 *
 * The golden document is GRADER-ONLY material; only its `instance_id` field is
 * read here, and nothing from it is ever printed.
 */
export const readAssignedIdsFromGolden = (goldenPath: string): readonly string[] => {
  const parsed = JSON.parse(readFileSync(goldenPath, "utf8")) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error(`golden document at ${goldenPath} is not a JSON array`)
  }
  return parsed.map((row, i) => {
    const id = (row as { instance_id?: unknown }).instance_id
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error(`golden row ${i} has no usable instance_id`)
    }
    return id
  })
}

/**
 * Read the AGENT's patches for a model stage (Gate 2+).
 *
 * The file is the official ProMax prediction shape — a JSON ARRAY of
 * `{instance_id, model_patch}` — which is what a ProMax agent run produces.
 *
 * Every row is PROJECTED to those two fields and re-serialized downstream; the
 * file is never copied through. That is the leak guard: a richer row carrying a
 * trajectory, a reasoning trace, or a `patch` field holding gold cannot ride
 * into the file the evaluator reads.
 *
 * `model_patch` may be EMPTY — an agent that produced nothing is a model miss,
 * which is a measurement. It is the ABSENT field that is refused, because that
 * is a malformed row rather than an empty result.
 */
export const readModelPatches = (predictionsPath: string): readonly ProMaxSubmittedPatch[] => {
  const parsed = JSON.parse(readFileSync(predictionsPath, "utf8")) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error(
      `predictions document at ${predictionsPath} is not a JSON array — ProMax predictions ` +
        "are an array of {instance_id, model_patch}, not the JSONL other families use",
    )
  }
  const rows = parsed.map((row, i) => {
    const r = row as { instance_id?: unknown; model_patch?: unknown }
    if (typeof r.instance_id !== "string" || r.instance_id.trim() === "") {
      throw new Error(`prediction row ${i} has no usable instance_id`)
    }
    if (typeof r.model_patch !== "string") {
      throw new Error(
        `prediction row ${i} (${r.instance_id}) has no model_patch string. An empty patch is ` +
          "valid and grades as a model miss; an ABSENT one is a malformed row and is refused " +
          "rather than guessed as empty.",
      )
    }
    return { instanceId: r.instance_id, modelPatch: r.model_patch }
  })
  // Caught HERE as well as downstream: the operator's mistake is in the file
  // they passed, so that is where the message is useful. Silently keeping one
  // copy would grade an arbitrarily chosen patch and lose which one produced the
  // number — the shape a concatenated shard file or a best-of-N export takes.
  const seen = new Set<string>()
  const duplicated = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.instanceId)) duplicated.add(row.instanceId)
    seen.add(row.instanceId)
  }
  if (duplicated.size > 0) {
    throw new Error(
      `predictions document at ${predictionsPath} names ${duplicated.size} instance(s) more ` +
        `than once: ${[...duplicated].join(", ")}. REFUSING — grading one arbitrarily chosen ` +
        "copy would leave no record of which patch produced the result.",
    )
  }
  return rows
}

/**
 * The note a NARROWED run prints, or `undefined` for a full one.
 *
 * `--ids a` on a 170-instance campaign printed `assigned 1 | coverage 1` and
 * exited 0 — a probe that reads exactly like a clean full gate. Coverage is
 * always 1.0 of whatever was assigned, so the only thing that distinguishes the
 * two is saying which set was assigned.
 */
export const renderNarrowedNote = (assigned: number, inGolden: number): string | undefined =>
  assigned >= inGolden
    ? undefined
    : `  ⚠️ NARROWED RUN — ${assigned} of the ${inGolden} instance(s) in the golden file. ` +
      "Coverage below is of the SELECTED set, not the campaign; this is not a campaign gate."

/** Resolve `--ids` against the golden, fail-closed.
 *
 *  An id the golden does not carry can never produce a row: the pinned evaluator
 *  looks golden up by id and `continue`s past what it cannot find. Accepting it
 *  would spend the whole run to report it as `missing`, so it is refused here as
 *  the typo it is. */
const resolveExplicitIds = (explicit: string, goldenPath: string): readonly string[] => {
  const requested = explicit
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
  const inGolden = new Set(readAssignedIdsFromGolden(goldenPath))
  const unknown = requested.filter((id) => !inGolden.has(id))
  if (unknown.length > 0) {
    throw new Error(
      `--ids names ${unknown.length} instance(s) the golden file does not carry: ` +
        `${unknown.join(", ")}. REFUSING — the pinned evaluator looks golden up by id and skips ` +
        "what it cannot find, so such an instance can NEVER be graded; it would cost the whole " +
        "run to come back as `missing`.",
    )
  }
  return requested
}

export const buildRunGateInput = (argv: readonly string[]): ProMaxGateRunInput => {
  // EVERY required flag is resolved before any file is touched. Reading the
  // golden first made a missing `--pinned-root` surface as an ENOENT about a
  // different file — a refusal that misattributes its own cause.
  const campaignId = required(argv, "--campaign")
  const pinnedRoot = required(argv, "--pinned-root")
  const goldenPath = required(argv, "--golden")
  const workDir = required(argv, "--work-dir")
  const pythonExecutable = required(argv, "--python")

  // ABSENT ⇒ Gate 1, the gold sentinel (byte-identical to before this flag
  // existed). PRESENT ⇒ a model stage: the agent's patches are submitted
  // instead, and the sentinel gate is NOT applied to the result.
  const modelPredictions = flag(argv, "--predictions")

  const explicit = flag(argv, "--ids")
  return {
    campaignId,
    submission:
      modelPredictions === undefined
        ? { kind: "gold-sentinel" }
        : { kind: "model", patches: readModelPatches(modelPredictions) },
    assignedInstanceIds:
      explicit === undefined
        ? readAssignedIdsFromGolden(goldenPath)
        : resolveExplicitIds(explicit, goldenPath),
    pinnedRoot,
    goldenPath,
    workDir,
    pythonExecutable,
  }
}

export const runGateCli = (argv: readonly string[]): RunGateResult => {
  const input = buildRunGateInput(argv)
  const rendered = renderGateResult(runProMaxGate(input, makeRunGatePorts()))
  // A NARROWED run must say so in the same block as its coverage number.
  // Coverage is always 1.0 of whatever was assigned, so without this a one-instance
  // probe is textually indistinguishable from a clean full gate.
  const note = renderNarrowedNote(
    input.assignedInstanceIds.length,
    readAssignedIdsFromGolden(flag(argv, "--golden") ?? required(argv, "--golden")).length,
  )
  return note === undefined ? rendered : { ...rendered, output: `${rendered.output}\n${note}` }
}

if (import.meta.main) {
  try {
    const { exitCode, output } = runGateCli(process.argv.slice(2))
    process.stdout.write(`${output}\n`)
    process.exit(exitCode)
  } catch (err) {
    process.stderr.write(`promax run-gate: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  }
}
