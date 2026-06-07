/**
 * `apps/cli/batch-cmd.ts` — `quanta batch` standalone subcommand (ADR-0463 bind).
 *
 * WHY: the `@/agent/batch-jobs` slice (CSV fan-out → one subagent per row →
 * results CSV) is fully built + tested but NOT reachable from any host today —
 * its `RowDispatchPort` / `JobStorePort` are injected ports with no composition
 * root. This file is that composition root: it builds the `RowDispatchPort`
 * adapter OVER the real subagent dispatcher (`SubagentRunner`, the same port
 * `@/subagent` consumes), drives `BatchJobRunner` + an `InMemoryJobStore`, and
 * writes the output CSV.
 *
 * GATE: an EXPLICIT `quanta batch …` invocation. The CLI entrypoint routes
 * `process.argv[2] === "batch"` here (mirroring the `session` / `remote`
 * subcommand short-circuits in `apps/cli/index.ts`). NOTHING in this module
 * runs, allocates, or makes any LLM / subagent / FS call until {@link
 * runBatchCmd} is explicitly called — a process that never types `quanta batch`
 * sees zero behaviour change (default-OFF, RFC §1.2). There is NO env flag and
 * NO auto-trigger; the subcommand IS the gate.
 *
 * No-throw at the boundary: {@link runBatchCmd} returns a numeric exit code and
 * NEVER rejects. Argument errors → usage + exit 64 (EX_USAGE). A row dispatch
 * failure is surfaced per-row in the output CSV's `_status`/`_error` columns
 * (the runner already retries up to the attempt cap then marks the row
 * `failed`) — a single bad row never aborts the whole job. A store / FS write
 * fault → exit 1 with a logged reason.
 *
 * Slice posture: composition root (`@/apps` — the ONLY place concrete adapters
 * are constructed, ARCHITECTURE.md §intro). Imports `@/agent/batch-jobs` (the
 * pure slice barrel), the `SubagentRunner` PORT TYPE from `@/subagent`, and
 * `node:fs` for the file read/write. The real `SubagentRunner` is INJECTED by
 * the caller (`apps/cli/index.ts` builds it from the assembled agent config) —
 * this file does not assemble an agent loop itself, so it stays a leaf.
 */

import { randomBytes } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import {
  BatchJobRunner,
  type BatchJobSpec,
  compileRowSchema,
  DEFAULT_POOL_SIZE,
  InMemoryJobStore,
  parseRowsFromCsv,
  type RowDispatchPort,
  type RowDispatchResult,
} from "@/agent/batch-jobs"
import { buildRowDispatchAdapter } from "@/agent/batch-jobs-dispatch"
import { err, errMessage, ok, type Result } from "@/shared"
import type { SubagentRunner } from "@/subagent"

/** EX_USAGE — a usage/argument error (matches the BSD sysexits convention the
 *  rest of the CLI maps argument faults to). */
const EXIT_USAGE = 64
/** Generic failure (store / FS write fault). */
const EXIT_FAILURE = 1
const EXIT_OK = 0

/** Default per-item attempt cap. NOT a silent heuristic — `--max-attempts` is
 *  the operator lever; this is the single named default the CLI references when
 *  the flag is omitted. One attempt + zero retries is the least-surprising
 *  default for an interactive batch run (the operator opts INTO retries). */
const DEFAULT_MAX_ATTEMPTS = 1

/** Minimal IO surface — injected so the hellgate test can drive the command
 *  without touching the real filesystem or process streams. */
export interface BatchCmdIo {
  readonly readFile: (path: string) => string
  readonly writeFile: (path: string, data: string) => void
  readonly out: (s: string) => void
  readonly err: (s: string) => void
}

/** Options for {@link runBatchCmd}. The `runner` is the REAL subagent
 *  dispatcher, injected by the composition root (`apps/cli/index.ts`). */
export interface BatchCmdOptions {
  /** Real subagent dispatcher. ONE call = ONE row's child agent loop. */
  readonly runner: SubagentRunner
  /** IO surface. Defaults to `node:fs` + `process.std{out,err}`. */
  readonly io?: BatchCmdIo
  /** Monotonic clock injection (deterministic in tests). Default `Date.now`. */
  readonly now?: () => number
  /** Id minting injection (deterministic in tests). Default a counter+random. */
  readonly newId?: () => string
  readonly logger?: { warn: (m: string) => void; error: (m: string) => void }
}

interface ParsedBatchArgs {
  readonly input: string
  readonly instruction: string
  readonly output: string
  readonly schema?: string
  readonly poolSize: number
  readonly maxAttempts: number
}

/** Default IO bound to the real process. Constructed ONLY when the caller does
 *  not inject one (i.e. only on an actual `quanta batch` invocation). */
const defaultIo = (): BatchCmdIo => ({
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, data) => {
    writeFileSync(path, data, "utf8")
  },
  out: (s) => {
    process.stdout.write(s)
  },
  err: (s) => {
    process.stderr.write(s)
  },
})

/** Usage text. Pure data — no I/O. */
export const batchUsage = (): string =>
  `quanta batch — run one subagent per CSV row, collect a results CSV (ADR-0463)

USAGE
  quanta batch --in <input.csv> --instruction <text> --out <output.csv> [options]

REQUIRED
  --in <path>            Input CSV (header row + one row per task)
  --instruction <text>   Instruction template handed to EACH row's subagent
  --out <path>           Output CSV (input columns + _status,_result,_error)

OPTIONS
  --schema <path>        JSON output-schema descriptor; each row's result is
                         validated against it (a row that fails is marked
                         failed, never aborts the job)
  --pool <int>           Max concurrent rows in flight (default ${DEFAULT_POOL_SIZE})
  --max-attempts <int>   Per-row attempt cap (default ${DEFAULT_MAX_ATTEMPTS})
  --help, -h             Print this help and exit

NOTES
  • Default-OFF: nothing runs unless this subcommand is invoked.
  • A single row failure is surfaced in the output CSV; it never aborts the run.
`

/** Read `argv[i+1]`; reject a missing value or a value that is itself a flag. */
const takeValue = (argv: readonly string[], i: number, flag: string): Result<string, string> => {
  const next = argv[i + 1]
  if (next === undefined || next.startsWith("--") || next === "-h") {
    return err(`flag '${flag}' requires a value`)
  }
  return ok(next)
}

/** Strict non-negative integer parse (mirrors cli-args discipline — no
 *  silent NaN, no overflow past the safe-integer boundary). */
const parsePositiveInt = (raw: string, flag: string): Result<number, string> => {
  if (!/^\d+$/.test(raw)) return err(`flag '${flag}' expects a positive integer, got '${raw}'`)
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n > Number.MAX_SAFE_INTEGER) {
    return err(`flag '${flag}' is out of range, got '${raw}'`)
  }
  if (n < 1) return err(`flag '${flag}' must be >= 1, got ${n}`)
  return ok(n)
}

/** Mutable accumulator the per-flag handlers write into. */
interface ArgsAcc {
  input?: string
  instruction?: string
  output?: string
  schema?: string
  poolSize: number
  maxAttempts: number
}

/** Table-driven flag handler. Each known flag consumes its value + writes the
 *  accumulator; returns `Err(reason)` on a missing/invalid value. Keeping this a
 *  flat lookup keeps {@link parseBatchArgs} below the cognitive-complexity cap. */
const FLAG_HANDLERS: Record<
  string,
  (acc: ArgsAcc, raw: string, flag: string) => Result<void, string>
> = {
  "--in": (acc, raw) => {
    acc.input = raw
    return ok(undefined)
  },
  "--instruction": (acc, raw) => {
    acc.instruction = raw
    return ok(undefined)
  },
  "--out": (acc, raw) => {
    acc.output = raw
    return ok(undefined)
  },
  "--schema": (acc, raw) => {
    acc.schema = raw
    return ok(undefined)
  },
  "--pool": (acc, raw, flag) => {
    const n = parsePositiveInt(raw, flag)
    if (!n.ok) return n
    acc.poolSize = n.value
    return ok(undefined)
  },
  "--max-attempts": (acc, raw, flag) => {
    const n = parsePositiveInt(raw, flag)
    if (!n.ok) return n
    acc.maxAttempts = n.value
    return ok(undefined)
  },
}

/** Pure argv parser for the `batch` subcommand. Returns `Err(reason)` on any
 *  propositional violation; the caller maps it to exit 64. NO I/O. */
export const parseBatchArgs = (argv: readonly string[]): Result<ParsedBatchArgs, string> => {
  const acc: ArgsAcc = { poolSize: DEFAULT_POOL_SIZE, maxAttempts: DEFAULT_MAX_ATTEMPTS }

  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === undefined) {
      i++
      continue
    }
    const handler = FLAG_HANDLERS[a]
    if (handler === undefined) return err(`unknown flag '${a}'`)
    const v = takeValue(argv, i, a)
    if (!v.ok) return v
    const applied = handler(acc, v.value, a)
    if (!applied.ok) return applied
    i += 2
  }

  if (acc.input === undefined) return err("--in <input.csv> is required")
  if (acc.instruction === undefined || acc.instruction.length === 0) {
    return err("--instruction <text> is required")
  }
  if (acc.output === undefined) return err("--out <output.csv> is required")

  return ok({
    input: acc.input,
    instruction: acc.instruction,
    output: acc.output,
    poolSize: acc.poolSize,
    maxAttempts: acc.maxAttempts,
    ...(acc.schema !== undefined ? { schema: acc.schema } : {}),
  })
}

// `parseChildValue` + `buildRowDispatchAdapter` moved to
// `@/agent/batch-jobs-dispatch` (the `@/subagent` bridge) so the agent-tool
// fan-out (`spawn_agents_on_csv`, tier1) and this human CLI share ONE adapter
// instead of duplicating it. Re-exported for callers importing it from here.
export { buildRowDispatchAdapter }

/** Counter-backed id minter (deterministic ordinal + a per-process salt so two
 *  concurrent runs never collide). Used only when the caller injects none. */
const defaultIdGen = (): (() => string) => {
  let seq = 0
  const salt = randomBytes(3).toString("hex")
  return () => `batch-${salt}-${(seq++).toString(36)}`
}

/**
 * Read + parse the input CSV (and the optional schema descriptor) into a
 * {@link BatchJobSpec}. Returns `Err(exitCode)` on a usage-class fault (after
 * emitting the diagnostic via `io.err`) so the caller can `return` it. NO-THROW
 * — every FS read is caught + converted.
 */
const buildSpec = (
  args: ParsedBatchArgs,
  io: BatchCmdIo,
): Result<{ spec: BatchJobSpec; outputSchemaJson?: string }, number> => {
  let csvSource: string
  try {
    csvSource = io.readFile(args.input)
  } catch (e) {
    io.err(`quanta batch: cannot read --in '${args.input}': ${errMessage(e)}\n`)
    return err(EXIT_USAGE)
  }
  const parsedCsv = parseRowsFromCsv(csvSource)
  if (!parsedCsv.ok) {
    io.err(
      `quanta batch: ${"reason" in parsedCsv.error ? parsedCsv.error.reason : parsedCsv.error.kind}\n`,
    )
    return err(EXIT_USAGE)
  }

  let outputSchemaJson: string | undefined
  if (args.schema !== undefined) {
    try {
      outputSchemaJson = io.readFile(args.schema)
    } catch (e) {
      io.err(`quanta batch: cannot read --schema '${args.schema}': ${errMessage(e)}\n`)
      return err(EXIT_USAGE)
    }
  }

  const spec: BatchJobSpec = {
    name: args.input,
    instruction: args.instruction,
    rows: parsedCsv.value.rows,
    headers: parsedCsv.value.headers,
    poolSize: args.poolSize,
    maxAttempts: args.maxAttempts,
    ...(outputSchemaJson !== undefined ? { outputSchemaJson } : {}),
  }
  return ok({ spec, ...(outputSchemaJson !== undefined ? { outputSchemaJson } : {}) })
}

/** Export the job's results CSV + write it + print the summary. Returns the
 *  exit code. NO-THROW — the write is caught. `cleanRun` is the job's terminal
 *  verdict (false ⇒ abort / store fault prevented completion). */
const exportAndReport = async (
  runner: BatchJobRunner,
  jobId: string,
  args: ParsedBatchArgs,
  io: BatchCmdIo,
  cleanRun: boolean,
): Promise<number> => {
  const exported = await runner.exportCsv(jobId)
  if (!exported.ok) {
    io.err(`quanta batch: could not export results: ${describeError(exported.error)}\n`)
    return EXIT_FAILURE
  }
  try {
    io.writeFile(args.output, exported.value)
  } catch (e) {
    io.err(`quanta batch: cannot write --out '${args.output}': ${errMessage(e)}\n`)
    return EXIT_FAILURE
  }

  const snap = await runner.snapshot(jobId)
  if (snap.ok) {
    const total = snap.value.items.length
    const done = snap.value.items.filter((i) => i.status === "done").length
    const failed = snap.value.items.filter((i) => i.status === "failed").length
    io.out(`quanta batch: ${done}/${total} rows done, ${failed} failed → ${args.output}\n`)
  } else {
    io.out(`quanta batch: results written → ${args.output}\n`)
  }
  // A clean run with per-row failures is still exit 0 — row failures are data
  // (surfaced in the CSV), not a command-level failure. Only an abort / store
  // fault that prevented completion is a non-zero exit.
  return cleanRun ? EXIT_OK : EXIT_FAILURE
}

/**
 * Run the `quanta batch` subcommand. Parses argv, reads the input CSV, builds a
 * {@link BatchJobSpec}, drives a {@link BatchJobRunner} (over an
 * {@link InMemoryJobStore} + the injected-runner-backed {@link RowDispatchPort}),
 * writes the results CSV, and returns an exit code.
 *
 * NO-THROW: returns a numeric exit code, never rejects. `argv` is
 * `process.argv.slice(3)` (everything after `quanta batch`).
 */
export const runBatchCmd = async (
  argv: readonly string[],
  opts: BatchCmdOptions,
): Promise<number> => {
  const io = opts.io ?? defaultIo()
  const log = opts.logger ?? { warn: () => undefined, error: () => undefined }

  if (argv.includes("--help") || argv.includes("-h")) {
    io.out(batchUsage())
    return EXIT_OK
  }

  const parsed = parseBatchArgs(argv)
  if (!parsed.ok) {
    io.err(`quanta batch: ${parsed.error}\n\n${batchUsage()}`)
    return EXIT_USAGE
  }
  const args = parsed.value

  const built = buildSpec(args, io)
  if (!built.ok) return built.error

  const runner = new BatchJobRunner({
    store: new InMemoryJobStore(),
    dispatch: buildRowDispatchAdapter(opts.runner),
    clock: opts.now ?? Date.now,
    newId: opts.newId ?? defaultIdGen(),
    // Compile the schema only when present — the runner skips validation when
    // `schema` is omitted (byte-identical to a schema-less job).
    ...(built.value.outputSchemaJson !== undefined
      ? { schema: compileRowSchema(built.value.outputSchemaJson) }
      : {}),
  })

  const submitted = await runner.submit(built.value.spec)
  if (!submitted.ok) {
    log.error(`[batch] submit failed: ${submitted.error.kind}`)
    io.err(`quanta batch: invalid job — ${describeError(submitted.error)}\n`)
    return EXIT_USAGE
  }
  const jobId = submitted.value

  const ac = new AbortController()
  const onSig = () => {
    ac.abort()
  }
  process.on("SIGINT", onSig)
  process.on("SIGTERM", onSig)
  try {
    const final = await runner.runToEnd(jobId, ac.signal)
    if (!final.ok) {
      // `aborted` (Ctrl-C) or a job-level store fault — still try to export
      // whatever rows completed so partial progress is not lost.
      log.warn(`[batch] job did not complete cleanly: ${final.error.kind}`)
    }
    return await exportAndReport(runner, jobId, args, io, final.ok)
  } finally {
    process.off("SIGINT", onSig)
    process.off("SIGTERM", onSig)
  }
}

/** Human-readable rendering of a `BatchJobError` for the usage/error line. */
const describeError = (e: {
  readonly kind: string
  readonly reason?: string
  readonly jobId?: string
}): string => {
  if (e.kind === "invalid-spec" || e.kind === "store-failed") return e.reason ?? e.kind
  if (e.kind === "job-not-found") return `job not found: ${e.jobId ?? "?"}`
  return e.kind
}
