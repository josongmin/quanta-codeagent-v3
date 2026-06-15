/**
 * Epic-2 `run_tests` — detect the project toolchain, run its test suite, and
 * report a NORMALIZED {passed, failed:[{name,file,line,message}]}. The
 * failure-evidence half of the Evidence Packet Builder.
 *
 * HIGH RISK: running a suite EXECUTES the project's (test) code, so the tool is
 * default-OFF (QUANTA_TEST_RUNNER) + always-confirm (like bash / debug_inspect).
 * NEVER throws — detection / spawn / parse faults collapse to ok:false.
 */
import { z } from "zod"
import { applyLocalEnv, DEFAULT_ENV_ALLOWLIST, scrubEnv } from "@/runtime"
import { errMessage } from "@/shared"
import { defaultFileSystemPort, type FileSystemPort } from "@/storage"
import type { Tool, ToolContext, ToolEvent } from "../types"
import { detectToolchain } from "./detect"
import {
  parseCargo,
  parseCtest,
  parseGoJson,
  parseNodeTest,
  parsePytest,
  parsePythonUnittest,
} from "./parse"
import type { TestRunResult, Toolchain } from "./types"

/** Process carrier (injectable so the parsers/dispatch are unit-testable without
 *  spawning; the real port uses Bun.spawn). */
export interface TestRunPort {
  run(
    command: readonly string[],
    cwd: string,
    signal?: AbortSignal,
    localEnv?: ToolContext["localEnv"],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>
}

/** Cap per-stream capture so a runaway suite (fuzzing / infinite log loop)
 *  cannot OOM the host. Generous — real suite output is far smaller. */
const MAX_STREAM_BYTES = 8 * 1024 * 1024 // 8 MiB

/** Read a stream up to a byte cap, then stop pulling (the child's writes block
 *  / are dropped — we already have enough to parse the verdict + failures). */
const readCapped = async (
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> => {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) {
        chunks.push(value)
        total += value.length
        if (total >= maxBytes) break
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // stream already closed
    }
  }
  return Buffer.concat(chunks).toString("utf8")
}

export const defaultTestRunPort: TestRunPort = {
  async run(command, cwd, signal, localEnv) {
    const [cmd, ...args] = command
    if (cmd === undefined) return { stdout: "", stderr: "empty command", exitCode: -1 }
    const child = Bun.spawn([cmd, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: applyLocalEnv(scrubEnv(), localEnv, DEFAULT_ENV_ALLOWLIST),
      ...(signal ? { signal } : {}),
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      readCapped(child.stdout, MAX_STREAM_BYTES),
      readCapped(child.stderr, MAX_STREAM_BYTES),
      child.exited,
    ])
    return { stdout, stderr, exitCode }
  },
}

const schema = z.object({
  cwd: z
    .string()
    .optional()
    .describe("Project root (defaults to the session cwd). Detection reads its marker files."),
  command: z
    .array(z.string())
    .optional()
    .describe("Override the detected test command (argv). Output is parsed generically."),
})
type Input = z.infer<typeof schema>

const err = (output: string): ToolEvent => ({
  type: "result",
  result: { ok: false, output, failure: { mode: "error", modelVisibleError: output } },
})

/** Apply the toolchain's parser to the combined output. unittest writes to
 *  STDERR, go/cargo mostly to STDOUT — so parsers see both. */
const parseFor = (
  tc: Toolchain,
  stdout: string,
  stderr: string,
  exitCode: number,
): TestRunResult => {
  const combined = `${stdout}\n${stderr}`
  let r: TestRunResult
  switch (tc.parser) {
    case "go":
      r = parseGoJson(stdout)
      break
    case "cargo":
      r = parseCargo(combined)
      break
    case "python-unittest":
      r = parsePythonUnittest(combined)
      break
    case "pytest":
      r = parsePytest(combined)
      break
    case "node":
      r = parseNodeTest(combined)
      break
    case "ctest":
      r = parseCtest(combined)
      break
    default:
      // generic: no structured parse — exit code is the only verdict.
      r = {
        runner: "generic",
        passed: 0,
        failed: exitCode === 0 ? [] : [{ name: "(suite failed — see output)" }],
        ok: exitCode === 0,
      }
  }
  // FALSE-GREEN SAFETY NET (adversarial-audit): a NON-ZERO exit with no parsed
  // failures means the suite failed for a reason the parser didn't model (a
  // compile error, an early panic, a harness crash). NEVER report that green.
  if (exitCode !== 0 && r.failed.length === 0) {
    return { ...r, ok: false, failed: [{ name: `(suite failed — exit ${exitCode}, see output)` }] }
  }
  // Symmetric guard: parser said failures exist ⇒ ok must be false regardless.
  return { ...r, ok: r.failed.length === 0 && r.ok }
}

/** Run a detected toolchain's suite and return the NORMALIZED result (the
 *  reusable run+parse core — `run_tests` renders this; the Evidence Packet
 *  Builder consumes it structurally). NEVER throws. */
export const runToolchain = async (
  tc: Toolchain,
  cwd: string,
  port: TestRunPort = defaultTestRunPort,
  signal?: AbortSignal,
  localEnv?: ToolContext["localEnv"],
): Promise<TestRunResult> => {
  try {
    const { stdout, stderr, exitCode } = await port.run(tc.command, cwd, signal, localEnv)
    return parseFor(tc, stdout, stderr, exitCode)
  } catch {
    return {
      runner: tc.parser,
      passed: 0,
      failed: [{ name: "(test run faulted — see logs)" }],
      ok: false,
    }
  }
}

/** Ceiling for the `canRun` probe spawn — a wedged interpreter can't stall
 *  detection longer than this before the probe forces a non-zero exit code. */
const CANRUN_PROBE_TIMEOUT_MS = 5_000

/** Probe whether a command runs successfully (exit 0) in `cwd`, with a 5s
 *  ceiling so a wedged interpreter can't stall detection. Used by the detector's
 *  `canRun` to prefer pytest when it is installed. NEVER throws. */
export const commandRunsOk = async (
  command: readonly string[],
  cwd: string,
  localEnv?: ToolContext["localEnv"],
): Promise<boolean> => {
  const [cmd, ...args] = command
  if (cmd === undefined) return false
  try {
    const proc = Bun.spawn([cmd, ...args], {
      cwd,
      stdout: "ignore",
      stderr: "ignore",
      env: applyLocalEnv(scrubEnv(), localEnv, DEFAULT_ENV_ALLOWLIST),
    })
    const code = await Promise.race([
      proc.exited,
      new Promise<number>((r) => setTimeout(() => r(-1), CANRUN_PROBE_TIMEOUT_MS)),
    ])
    try {
      proc.kill()
    } catch {
      // already exited
    }
    return code === 0
  } catch {
    return false
  }
}

const render = (tc: Toolchain, r: TestRunResult): string => {
  const head = `${r.runner}: ${r.passed} passed, ${r.failed.length} failed (${tc.command.join(" ")})`
  if (r.failed.length === 0) return `✓ ${head}`
  const lines = [head, "FAILED:"]
  for (const f of r.failed) {
    const loc = f.file ? ` (${f.file}${f.line !== undefined ? `:${f.line}` : ""})` : ""
    lines.push(`  ${f.name}${loc}${f.message ? ` — ${f.message}` : ""}`)
  }
  return lines.join("\n")
}

export interface RunTestsDeps {
  readonly fs?: FileSystemPort
  readonly port?: TestRunPort
}

export const makeRunTestsTool = (deps: RunTestsDeps = {}): Tool<Input> => {
  const fs = deps.fs ?? defaultFileSystemPort
  const port = deps.port ?? defaultTestRunPort
  return {
    name: "run_tests",
    description:
      "Detect the project's test toolchain (Cargo.toml→cargo, go.mod→go, pyproject/setup.py→python pytest if " +
      "installed else unittest, package.json→npm) and run the suite, returning a normalized pass/fail summary with the failing tests' " +
      "names + file:line + message. Pass `command` to override the detected runner.",
    inputSchema: schema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    // Running a test suite executes project code ⇒ confirm (like bash).
    hitlTier: (): "always-confirm" => "always-confirm",

    async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
      if (ctx.signal?.aborted === true) {
        yield err("aborted before start")
        return
      }
      const cwd = input.cwd ?? ctx.cwd
      // Detection probes marker files THROUGH the FS jail (baseDir = cwd); the
      // canRun probe lets it prefer pytest over unittest when pytest is installed.
      const existsPort = {
        fileExists: (name: string) => fs.fileExists(name, cwd),
        canRun: (c: readonly string[]) => commandRunsOk(c, cwd, ctx.localEnv),
      }
      let toolchain: Toolchain | null
      if (input.command !== undefined && input.command.length > 0) {
        toolchain = { kind: "node", command: input.command, parser: "generic" }
      } else {
        toolchain = await detectToolchain(cwd, existsPort).catch(() => null)
      }
      if (toolchain === null) {
        yield err(
          "run_tests: no recognized test toolchain (looked for Cargo.toml / go.mod / pyproject.toml / setup.py / package.json). Pass `command` to run an explicit suite.",
        )
        return
      }
      try {
        const result = await runToolchain(toolchain, cwd, port, ctx.signal, ctx.localEnv)
        yield { type: "result", result: { ok: result.ok, output: render(toolchain, result) } }
      } catch (e) {
        yield err(`run_tests: ${errMessage(e)}`)
      }
    },
  }
}

export const runTestsTool: Tool<Input> = makeRunTestsTool()
