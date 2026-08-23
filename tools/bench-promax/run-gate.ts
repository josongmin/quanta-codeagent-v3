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

const renderJudged = (result: Extract<ProMaxGateRunResult, { outcome: "judged" }>): string => {
  const s = result.summary
  const lines = [
    `GATE gold-sentinel — ${result.gate.ok ? "PASS" : "FAIL"}`,
    `  assigned ${s.assigned} | gradingValid ${s.gradingValid} | coverage ${s.coverage} | ` +
      `missing ${s.missing} | infraInvalid ${s.infraInvalid}`,
    `  evaluator exit ${String(result.observation.exitCode)}`,
    "  verdicts",
    ...result.verdictCounts.map(
      (v) => `    ${String(v.count).padStart(4)}/${s.assigned}  ${v.state} / ${v.reason}`,
    ),
  ]
  if (!result.gate.ok) {
    lines.push(`  gate failures (${result.gate.failures.length})`)
    for (const f of result.gate.failures.slice(0, 20)) {
      lines.push(`    [${f.code}] ${f.instanceId}`)
    }
  }
  lines.push("  artifacts", `    receipt      ${result.receiptPath}`)
  lines.push(`    predictions  ${result.predictionsPath}`)
  lines.push(`    evaluator    ${result.outputPath}`)
  return lines.join("\n")
}

export const renderGateResult = (result: ProMaxGateRunResult): RunGateResult =>
  result.outcome === "refused"
    ? { exitCode: 1, output: renderRefused(result) }
    : { exitCode: result.gate.ok ? 0 : 1, output: renderJudged(result) }

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

export const buildRunGateInput = (argv: readonly string[]): ProMaxGateRunInput => {
  // EVERY required flag is resolved before any file is touched. Reading the
  // golden first made a missing `--pinned-root` surface as an ENOENT about a
  // different file — a refusal that misattributes its own cause.
  const campaignId = required(argv, "--campaign")
  const pinnedRoot = required(argv, "--pinned-root")
  const goldenPath = required(argv, "--golden")
  const workDir = required(argv, "--work-dir")
  const pythonExecutable = required(argv, "--python")

  const explicit = flag(argv, "--ids")
  return {
    campaignId,
    assignedInstanceIds:
      explicit === undefined
        ? readAssignedIdsFromGolden(goldenPath)
        : explicit
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s !== ""),
    pinnedRoot,
    goldenPath,
    workDir,
    pythonExecutable,
  }
}

export const runGateCli = (argv: readonly string[]): RunGateResult =>
  renderGateResult(runProMaxGate(buildRunGateInput(argv), makeRunGatePorts()))

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
