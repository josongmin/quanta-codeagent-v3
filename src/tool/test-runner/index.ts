import { z } from "zod"
import { runShell } from "@/runtime"
import { fileExists, readFile } from "@/storage"
import type { Tool, ToolContext, ToolEvent, ToolResultEvidence } from "../types"

const schema = z.object({
  command: z.string().optional().describe("Explicit test command (skips auto-detection)"),
  path: z.string().optional().describe("Optional path/filter passed to the detected runner"),
  timeout_ms: z.number().optional().describe("Timeout in ms (default 120000, max 600000)"),
})

type Input = z.infer<typeof schema>

const DEFAULT_TIMEOUT = 120_000
const MAX_TIMEOUT = 600_000
const TAIL_CAP = 12_000
/** Local stderr-tail cap on `evidence.stderr`. Dispatch re-trims to its own
 *  smaller `STDERR_TAIL_CAP` (2000) as a defense-in-depth backstop. */
const STDERR_EVIDENCE_CAP = 4_000

const has = async (cwd: string, name: string): Promise<boolean> => fileExists(`${cwd}/${name}`)

type PackageJsonLike = {
  scripts?: Record<string, string>
  packageManager?: string
}

/** Read package.json (if any). Returns null on absence or parse failure. */
const readPackageJson = async (cwd: string): Promise<PackageJsonLike | null> => {
  if (!(await has(cwd, "package.json"))) return null
  try {
    return JSON.parse(await readFile(`${cwd}/package.json`)) as PackageJsonLike
  } catch {
    return null
  }
}

/** Auto-detect a test command. Order: bun (lockb/bunfig/pkg-test-script) →
 *  npm (package.json only) → pytest (pytest.ini/pyproject/setup.py). */
const detectCommand = async (
  cwd: string,
  path: string | undefined,
): Promise<string | undefined> => {
  const suffix = path ? ` ${path}` : ""
  const npmSuffix = path ? ` -- ${path}` : ""
  const pkg = await readPackageJson(cwd)
  const bunMarker =
    (await has(cwd, "bun.lockb")) ||
    (await has(cwd, "bunfig.toml")) ||
    pkg?.packageManager?.toLowerCase().startsWith("bun@") === true
  if (bunMarker) return `bun test${suffix}`
  if (pkg !== null) return `npm test${npmSuffix}`
  const py =
    (await has(cwd, "pytest.ini")) ||
    (await has(cwd, "pyproject.toml")) ||
    (await has(cwd, "setup.py"))
  if (py) return `pytest${suffix}`
  return undefined
}

/** Heuristic one-line verdict from runner output + exit/timeout state. */
const verdict = (combined: string, exitCode: number, timedOut: boolean): string => {
  if (timedOut) return "timed out"
  const text = combined.toLowerCase()
  if (/\b\d+\s+fail|\bfailed\b|✗|✖/.test(text) && exitCode !== 0) return "failed"
  if (exitCode === 0 && /\bpass|\bok\b|✓|✔|\b\d+\s+passed\b/.test(text)) return "passed"
  if (exitCode === 0) return "passed"
  if (exitCode !== 0) return "failed"
  return "unknown"
}

/**
 * Run a project's test suite. Uses an explicit `command` when given, else
 * auto-detects (bun → npm → pytest). NOT read-only and NOT concurrency-safe:
 * arbitrary project tests have side effects and may contend for resources.
 */
export const testRunnerTool: Tool<Input> = {
  name: "test_runner",
  description:
    "Run the project's tests (explicit command or auto-detected: bun/npm/pytest). " +
    "Returns the resolved command, exit status, a trimmed tail, and a verdict.",
  inputSchema: schema,
  isReadOnly: () => false,
  // Executes a test suite with arbitrary side effects; always serialize.
  isConcurrencySafe: () => false,
  // HITL secure-by-default (ADR-0020 follow-up): running the project's own
  // test suite is the canonical inner-loop action — pre-approval covers it.
  // Without this opt-in, the `inferToolTier` fallback for mutating tools
  // would force confirmation on every `bun test` even in `bypass`.
  hitlTier: (): "pre-approval-ok" => "pre-approval-ok",

  async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const resolved = input.command ?? (await detectCommand(ctx.cwd, input.path))
    if (!resolved) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: "could not auto-detect a test command; pass `command` explicitly",
        },
      }
      return
    }

    yield { type: "progress", message: `running: ${resolved}` }

    const timeoutMs = Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT, MAX_TIMEOUT)
    const r = await runShell(resolved, { cwd: ctx.cwd, signal: ctx.signal, timeoutMs })

    const combined = [r.stdout, r.stderr].filter(Boolean).join("\n").trimEnd()
    const tail =
      combined.length > TAIL_CAP
        ? `… (truncated ${combined.length - TAIL_CAP} chars)\n${combined.slice(-TAIL_CAP)}`
        : combined
    const status = r.timedOut ? "timed out" : `exit ${r.exitCode}`
    const v = verdict(combined, r.exitCode, r.timedOut)
    const ok = r.exitCode === 0 && !r.timedOut

    // RFC-0002 §5.2 evidence (CR3: typed, not duck-smuggled). Conditional
    // spread keeps `exactOptionalPropertyTypes` happy when stderr is empty.
    const evidence: ToolResultEvidence = {
      ...(r.stderr ? { stderr: r.stderr.slice(-STDERR_EVIDENCE_CAP) } : {}),
      exitCode: r.exitCode,
    }

    yield {
      type: "result",
      result: {
        ok,
        output: `$ ${resolved}\n[${status}] verdict: ${v}\n${tail || "(no output)"}`,
        evidence,
      },
    }
  },
}
