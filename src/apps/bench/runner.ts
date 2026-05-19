/**
 * Single-instance SWE-bench-style runner.
 *
 * Prepares an isolated sandbox copy of the instance repo (the corpus is NEVER
 * mutated), runs a real agent (runAgent + defaultTools) against the problem
 * statement, then runs the instance's testCmd to decide pass/fail and captures
 * a unified diff of the sandbox as the produced patch.
 *
 * Shell exec is a tiny local Bun.spawn helper, but it spawns children with the
 * single-source `@/runtime` `scrubEnv()` allowlist (NOT raw `process.env`) so a
 * bench child can never inherit `OPENAI_API_KEY`/tokens — that is what makes
 * the trajectory's `envPolicyVersion` stamp truthful (C9). Apps may import
 * slices (RFC §3.1); reusing scrubEnv keeps ONE env policy, not a fork.
 */
import { writeFileSync } from "node:fs"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSystemPrompt, runAgent } from "@/agent"
import type { LLMPort, Message } from "@/llm"
import type { PermissionContext } from "@/permission"
import { scrubEnv } from "@/runtime"
import { redactValue, type SandboxData } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { TeeStream } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"
import {
  type AttemptObservation,
  BenchObserver,
  countDiff,
  finalizeRun,
  type RunObservation,
  type RunSummary,
  UsageTap,
  verifyLogTail,
} from "./observe"
import { evaluateWithPythonSwebench, type PySwebenchOpts } from "./python-swebench"
import type { Instance, InstanceResult } from "./types"

export type { RunObservation, RunSummary }
export { finalizeRun }

/** StreamPort that swallows every event — silent benchmark runs. */
export class NullStream implements StreamPort {
  emit(_event: AgentEvent): void {
    // intentionally empty
  }
}

export interface RunInstanceDeps {
  llm: LLMPort
  /** Hard ceiling on agent turns per attempt. */
  maxTurns: number
  /** Wall-clock budget (ms) for the whole instance. */
  timeoutMs: number
  /**
   * Official-harness verifier. When present AND the instance carries swebench
   * metadata, the captured patch is graded by the Python harness instead of
   * the local `testCmd`. Absent (default) ⇒ unchanged local testCmd path.
   * `opts` is forwarded to `evaluateWithPythonSwebench` (injectable spawn/probe
   * keep tests hermetic). index.ts gates this behind `QUANTA_SWEBENCH_PYTHON=1`.
   */
  pythonSwebench?: {
    evaluate?: typeof evaluateWithPythonSwebench
    opts?: PySwebenchOpts
  }
  /**
   * RFC-0002 §8 observability. ABSENT (default) ⇒ `NullStream`, byte-identical
   * to pre-W-D behavior — no files written. PRESENT ⇒ the agent stream is
   * `TeeStream([NullStream, JsonlRecorder(<run>/<id>.<attempt>.jsonl)])` with
   * `strict:true` (eval), plus bench-produced `sandbox`/`patch_generated`/
   * `verify` lines. A strict recorder failure ⇒ `verdict:"degraded"`.
   */
  observe?: AttemptObservation
}

interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Minimal `bash -c` exec via Bun.spawn with a hard timeout. C9: children are
 * spawned with the single-source `scrubEnv()` allowlist (PATH/HOME/proxy/
 * locale/TMPDIR preserved so git/bun/node still work) — the parent's secrets
 * (`OPENAI_API_KEY`/tokens) are NEVER inherited. This makes the `sandbox`
 * trajectory event's `envPolicyVersion` claim true.
 */
const exec = async (cmd: string, cwd: string, timeoutMs: number): Promise<ExecResult> => {
  const proc = Bun.spawn(["bash", "-c", cmd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: scrubEnv(),
  })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Snapshot helper: take a pre-image, run the agent, then diff.
 *
 * If the sandbox already contains a `.git` (real swebench cache repos do) and
 * `baseCommit` is supplied, we hard-checkout that commit FIRST so the agent
 * starts from the canonical buggy tree, then commit it as the pristine base.
 * Otherwise we `git init` a fresh repo over the copied files. After the agent
 * runs, `git add -A && git diff --cached` yields a proper unified
 * `diff --git a/… b/…` patch — exactly the SWE-bench prediction format. `git`
 * is opportunistic; absence/failure ⇒ "" rather than throwing.
 */
const withGitSnapshot = async (
  sandbox: string,
  timeoutMs: number,
  baseCommit: string | undefined,
  body: () => Promise<void>,
): Promise<string> => {
  const G = "git -c user.email=b@b -c user.name=b -c commit.gpgsign=false"
  const hasGit = (await exec("git rev-parse --git-dir", sandbox, timeoutMs)).code === 0
  const prep =
    hasGit && baseCommit
      ? `${G} checkout -q -f ${baseCommit} && ${G} reset -q --hard ${baseCommit} && ${G} clean -qfdx`
      : `git init -q . && ${G} add -A && ${G} commit -q -m base --allow-empty`
  const init = await exec(prep, sandbox, timeoutMs)
  await body()
  if (init.code !== 0) return ""
  const diff = await exec(`${G} add -A && ${G} diff --cached --no-color`, sandbox, timeoutMs)
  return diff.code === 0 ? sourceOnlyDiff(diff.stdout) : ""
}

/** SWE-bench predictions must be SOURCE-only: the official harness applies its
 *  own gold `test_patch`, so any test-file hunk a model emits is at best
 *  discarded and at worst conflicts with / skews grading (observed: agents
 *  editing `tests/` produced large diffs that failed PASS_TO_PASS). Drop the
 *  per-file sections of a unified `git diff` whose path is a test file/dir.
 *  Pure, order-preserving; non-test (source) hunks pass through verbatim. */
const TEST_PATH_RE = /(^|\/)tests?\//i
const TEST_FILE_RE = /(^|\/)(test_[^/]+|[^/]+_test|conftest)\.(py|js|ts|tsx)$/i
export const sourceOnlyDiff = (diff: string): string => {
  if (diff.trim() === "") return diff
  const out: string[] = []
  let skip = false
  for (const line of diff.split("\n")) {
    const m = line.match(/^diff --git a\/\S+ b\/(\S+)/)
    if (m) {
      const p = m[1] ?? ""
      skip = TEST_PATH_RE.test(p) || TEST_FILE_RE.test(p)
    }
    if (!skip) out.push(line)
  }
  return out.join("\n")
}

/**
 * Env-scrub policy version tied to the sandbox allowlist. Bumped only when the
 * scrub allowlist changes; stamped into every `sandbox` event so a trajectory
 * records which policy governed the run. `sandbox.v2` (Group A coordinated):
 * the allowlist no longer carries NODE_OPTIONS/NODE_EXTRA_CA_CERTS, and bench
 * `exec()` now spawns children with `scrubEnv()` — so the stamp is truthful.
 */
const ENV_POLICY_VERSION = "sandbox.v2"

const trimOut = (r: ExecResult): string => (r.code === 0 ? r.stdout.trim() : "")

/** Best-effort `<bin> --version` → first line, or undefined. */
const probeVersion = async (bin: string, sandbox: string, timeoutMs: number): Promise<string> => {
  const r = await exec(`${bin} --version 2>&1 | head -n1`, sandbox, timeoutMs)
  return trimOut(r)
}

/**
 * One-shot sandbox snapshot (RFC §5.2 `sandbox`). Gathered AFTER the repo is
 * copied + base-checked-out and BEFORE the agent runs, so `repoCommit` is the
 * pristine pre-agent HEAD. `git` is opportunistic — absence ⇒ empty commits,
 * never throws. `python` is best-effort/optional.
 */
const gatherSandbox = async (
  sandbox: string,
  baseCommit: string | undefined,
  timeoutMs: number,
): Promise<SandboxData> => {
  const head = await exec("git rev-parse HEAD", sandbox, timeoutMs)
  const status = await exec("git status --porcelain", sandbox, timeoutMs)
  const [bun, node, python] = await Promise.all([
    probeVersion("bun", sandbox, timeoutMs),
    probeVersion("node", sandbox, timeoutMs),
    probeVersion("python3", sandbox, timeoutMs),
  ])
  const runtime: { bun?: string; node?: string; python?: string } = {
    ...(bun !== "" ? { bun } : {}),
    ...(node !== "" ? { node } : {}),
    ...(python !== "" ? { python } : {}),
  }
  return {
    repoCommit: trimOut(head),
    baseCommit: baseCommit ?? trimOut(head),
    worktreeDirty: status.code === 0 && status.stdout.trim() !== "",
    runtime,
    envPolicyVersion: ENV_POLICY_VERSION,
  }
}

/** Solve directive for real SWE-bench tasks, grounded in observed 0/5 failure
 *  modes: full-file rewrites → 180KB diffs that break PASS_TO_PASS; agents
 *  editing tests/ (discarded by the source-only grader); plausible-but-wrong
 *  fixes with no verification loop. Appended to the task message only when
 *  `instance.swebench` is set (custom-corpus runs unaffected). */
const SWEBENCH_DIRECTIVE = [
  "",
  "",
  "You are fixing a real defect in this repository; an automated grader runs",
  "hidden tests against ONLY your source changes. Hard rules:",
  "- Change library/source code ONLY. NEVER create, edit, or delete any test",
  "  file or anything under a tests/ or test/ dir — the grader supplies its own",
  "  tests; your test edits are discarded and only waste turns.",
  "- Make the SMALLEST correct change. Use `edit` for targeted hunks. Do NOT",
  "  rewrite or reformat whole files; do NOT `write` over an existing file.",
  "- NEVER run `git checkout`/`reset`/`clean`/`stash`/`restore`, re-clone, or",
  "  any command that discards your own edits. Your final git diff IS the",
  "  submission — do not let bash commands wipe it.",
  "- Reproduce first: from the issue, construct the concrete failing scenario",
  "  (the exact input/call the issue describes) and confirm it currently",
  "  misbehaves before you edit.",
  "- Infer the EXACT required behavior (signatures, error messages, return",
  "  values, edge cases) from the issue and match it precisely — a fix that is",
  "  close but not exact still fails the hidden test.",
  "- MANDATORY before you stop: after your final edit, run the repository's",
  "  existing test(s) most specific to the changed code AND your reproduction",
  "  of the issue. If anything fails, iterate. Do NOT stop right after an edit",
  "  without running tests — an unverified edit is the #1 cause of failure.",
  "- Keep the final diff minimal and isolated to the fix.",
].join("\n")

const buildConfig = (
  instance: Instance,
  deps: RunInstanceDeps,
  sandbox: string,
  signal: AbortSignal,
  stream: StreamPort,
) => {
  const registry = new ToolRegistry(defaultTools)
  const permission: PermissionContext = { mode: "acceptEdits" }
  const base = `${instance.problemStatement}\n\nWork inside ${sandbox}. When done, stop.`
  const messages: Message[] = [
    {
      role: "user",
      content: [
        { type: "text", text: instance.swebench ? `${base}${SWEBENCH_DIRECTIVE}` : base },
      ],
    },
  ]
  return {
    llm: deps.llm,
    registry,
    stream,
    permission,
    messages,
    system: buildSystemPrompt(sandbox),
    cwd: sandbox,
    maxTurns: deps.maxTurns,
    signal,
    onConfirm: async () => false,
    // Real SWE-bench repos blow the context window over a long trajectory.
    // Enable proactive + reactive compaction (RFC §8 / ADR-0004 robustness):
    // without this, large-repo instances PTL-die instead of compacting.
    compaction: {},
    // SOTA++ verify-guard (ADR-0013): observed bench failure — agent edits a
    // source file then declares "done" with 0 verification → wrong fix ships.
    // Gated exactly like SWEBENCH_DIRECTIVE (real SWE-bench only; custom-corpus
    // byte-identical). Absent ⇒ guard OFF, loop unchanged.
    ...(instance.swebench ? { verifyGuard: { maxTrips: 2 } } : {}),
  }
}

/** Pass/fail + the evidence a `verify` trajectory event needs (RFC §5.2). */
interface VerifyOutcome {
  passed: boolean
  error?: string
  /** The grading command (testCmd, or the python-harness pseudo-command). */
  command: string
  exitCode: number
  failedTests: string[]
  logTail: string
  reportPath: string
}

/**
 * Decide pass/fail for the captured patch. When the Python harness is wired
 * AND the instance has swebench metadata, grade officially; otherwise (the
 * default) run the local `testCmd`. Never throws — a harness error degrades to
 * passed=false with the cause in `error`. Returns rich evidence so the caller
 * can emit a `verify` trajectory event; pass/fail semantics are unchanged.
 */
const verify = async (
  instance: Instance,
  patch: string,
  sandbox: string,
  deps: RunInstanceDeps,
): Promise<VerifyOutcome> => {
  if (deps.pythonSwebench && instance.swebench) {
    const evaluate = deps.pythonSwebench.evaluate ?? evaluateWithPythonSwebench
    const r = await evaluate(instance, patch, deps.pythonSwebench.opts ?? {})
    const command = `python -m swebench.harness.run_evaluation (${instance.swebench.instanceId})`
    return {
      passed: r.resolved,
      ...(r.resolved ? {} : { error: r.log.slice(0, 500) }),
      command,
      exitCode: r.resolved ? 0 : 1,
      failedTests: [],
      logTail: r.log.slice(-2000),
      reportPath: "",
    }
  }
  const test = await exec(instance.testCmd, sandbox, deps.timeoutMs)
  return {
    passed: test.code === 0,
    command: instance.testCmd,
    exitCode: test.code,
    failedTests: [],
    logTail: `${test.stdout}\n${test.stderr}`.slice(-2000),
    reportPath: "",
  }
}

/** Marker thrown when a strict (eval) recorder/observer write fails so the
 *  outer catch can map it to `verdict:"degraded"` (RFC §3/§8/§12). */
class ObservationError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = "ObservationError"
  }
}

/** Per-attempt observation wiring (or the no-op default). `obs` is undefined
 *  ⇒ NullStream, byte-identical to pre-W-D behavior. */
interface Wiring {
  stream: StreamPort
  observer?: BenchObserver
  usage?: UsageTap
}

/** Build the agent stream. Default-off ⇒ a bare `NullStream`. Observing ⇒
 *  `TeeStream([NullStream, JsonlRecorder, UsageTap], {strict:true})` so a
 *  recorder failure rethrows for `verdict:"degraded"` handling (RFC §8). */
const buildWiring = (instance: Instance, observe: AttemptObservation | undefined): Wiring => {
  if (observe === undefined) return { stream: new NullStream() }
  let observer: BenchObserver
  try {
    observer = new BenchObserver(observe, instance.id)
  } catch (e) {
    // Strict (eval): an unwritable observe dir is an observation failure, not
    // a silent fallback — surface it so the instance is marked degraded.
    throw new ObservationError(e)
  }
  const usage = new UsageTap()
  const stream = new TeeStream([new NullStream(), observer.recorder, usage], { strict: true })
  return { stream, observer, usage }
}

/** Emit the one-shot `sandbox` snapshot before the agent runs. Strict: a
 *  recorder failure becomes an {@link ObservationError}. */
const emitSandbox = async (
  observer: BenchObserver | undefined,
  sandbox: string,
  baseCommit: string | undefined,
  timeoutMs: number,
): Promise<void> => {
  if (observer === undefined) return
  const data = await gatherSandbox(sandbox, baseCommit, timeoutMs)
  try {
    observer.sandbox(data)
  } catch (e) {
    throw new ObservationError(e)
  }
}

/** Persist the unified diff to `<run>/<id>.<attempt>.patch` and emit
 *  `patch_generated` (filesChanged:0 for an empty patch). Returns the patch
 *  file path so it lands in the summary. */
const emitPatch = (
  observe: AttemptObservation,
  instance: Instance,
  observer: BenchObserver,
  patch: string,
): string => {
  const attempt = observe.attempt ?? 0
  const diffPath = join(observe.dir, observe.runId, `${instance.id}.${attempt}.patch`)
  // S2: a committed `.env`/fixture token captured in the diff must NOT land
  // raw on disk. Scrub via the single-source @/shared redactor; countDiff runs
  // on the scrubbed text so filesChanged/hunks still reflect what we wrote.
  const safePatch = redactValue(patch) as string
  const { filesChanged, hunks } = countDiff(safePatch)
  try {
    writeFileSync(diffPath, safePatch)
    observer.patchGenerated({ diffPath, filesChanged, hunks, applyStatus: "generated" })
  } catch (e) {
    throw new ObservationError(e)
  }
  return diffPath
}

const emitVerify = (observer: BenchObserver | undefined, v: VerifyOutcome): void => {
  if (observer === undefined) return
  try {
    observer.verify({
      command: v.command,
      exitCode: v.exitCode,
      passed: v.passed,
      failedTests: v.failedTests,
      logTail: verifyLogTail(v.logTail),
      reportPath: v.reportPath,
    })
  } catch (e) {
    throw new ObservationError(e)
  }
}

interface Phase {
  patch: string
  turns: number
}

/** Sandbox snapshot → agent (inside the git pre/post-image) → captured diff. */
const runAgentPhase = async (
  instance: Instance,
  deps: RunInstanceDeps,
  sandbox: string,
  signal: AbortSignal,
  w: Wiring,
): Promise<Phase> => {
  let turns = 0
  const patch = await withGitSnapshot(
    sandbox,
    deps.timeoutMs,
    instance.swebench?.baseCommit,
    async () => {
      await emitSandbox(w.observer, sandbox, instance.swebench?.baseCommit, deps.timeoutMs)
      const outcome = await runAgent(buildConfig(instance, deps, sandbox, signal, w.stream))
      turns = outcome.turns
    },
  )
  return { patch, turns }
}

const okResult = (
  instance: Instance,
  phase: Phase,
  v: VerifyOutcome,
  extra: Partial<InstanceResult>,
): InstanceResult => ({
  id: instance.id,
  passed: v.passed,
  patch: phase.patch,
  turns: phase.turns,
  ...(v.error !== undefined ? { error: v.error } : {}),
  ...extra,
})

/**
 * Run one instance once: sandbox → (setup) → agent → verify → diff. Always
 * cleans up the temp dir. Never throws for an instance-level failure — it is
 * reported via `InstanceResult.error` with passed=false.
 *
 * Observability (RFC §8) is a pure add-on gated on `deps.observe`: absent ⇒
 * `NullStream`, byte-identical to before (no files written). Present ⇒ the
 * agent stream is Tee'd into a strict `JsonlRecorder` plus bench `sandbox`/
 * `patch_generated`/`verify` lines; a strict observation failure yields
 * `verdict:"degraded"` (excluded from `resolved/total`).
 */
export const runInstance = async (
  instance: Instance,
  deps: RunInstanceDeps,
): Promise<InstanceResult> => {
  const sandbox = await mkdtemp(join(tmpdir(), `bench-${instance.id}-`))
  const abort = new AbortController()
  const deadline = setTimeout(() => abort.abort(), deps.timeoutMs)
  const startedAt = Date.now()
  let phase: Phase = { patch: "", turns: 0 }
  let w: Wiring = { stream: new NullStream() }
  try {
    w = buildWiring(instance, deps.observe)
    await cp(instance.repoPath, sandbox, { recursive: true })

    if (instance.setupCmd) {
      const setup = await exec(instance.setupCmd, sandbox, deps.timeoutMs)
      if (setup.code !== 0) {
        return {
          id: instance.id,
          passed: false,
          patch: "",
          turns: 0,
          error: `setup failed (code ${setup.code}): ${setup.stderr.slice(0, 500)}`,
        }
      }
    }

    phase = await runAgentPhase(instance, deps, sandbox, abort.signal, w)
    const v = await verify(instance, phase.patch, sandbox, deps)

    const extra: Partial<InstanceResult> = {}
    if (deps.observe && w.observer) {
      extra.verdict = "ok"
      extra.durationMs = Date.now() - startedAt
      extra.patchPath = emitPatch(deps.observe, instance, w.observer, phase.patch)
      emitVerify(w.observer, v)
      const usage = w.usage?.total()
      if (usage) extra.usage = usage
    }
    return okResult(instance, phase, v, extra)
  } catch (e) {
    if (e instanceof ObservationError) {
      return {
        id: instance.id,
        passed: false,
        patch: phase.patch,
        turns: phase.turns,
        verdict: "degraded",
        error: `observation failed (strict): ${e.message}`,
      }
    }
    return {
      id: instance.id,
      passed: false,
      patch: phase.patch,
      turns: phase.turns,
      error: (e as Error).message,
    }
  } finally {
    clearTimeout(deadline)
    w.observer?.close()
    await rm(sandbox, { recursive: true, force: true })
  }
}
