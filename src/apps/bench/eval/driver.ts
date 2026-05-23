/**
 * Single-instance SWE-bench-style runner — top-level orchestration.
 *
 * Prepares an isolated sandbox copy of the instance repo (the corpus is NEVER
 * mutated), runs a real agent (runAgent + defaultTools) against the problem
 * statement, then runs the instance's testCmd (or the Python harness) to
 * decide pass/fail and captures a unified diff of the sandbox as the produced
 * patch.
 *
 * This file is the ONLY place that ties the eval sub-slice together:
 *   sandbox.create → env-prep.run → snapshot.withSnapshot(runAgent) →
 *   verdict.verify → report.emit*. Each step lives in its own sibling module
 *   (sandbox.ts / env-prep.ts / snapshot.ts / verdict.ts / report.ts / exec.ts).
 *
 * Behavior is byte-identical to the pre-decompose `src/apps/bench/runner.ts`;
 * this is a pure structural refactor.
 */
import { type AgentConfig, buildSystemPrompt, lspNavToolList, runAgent } from "@/agent"
import type { LLMPort, Message } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { buildDefaultTools, ToolRegistry } from "@/tool"
import { type AttemptObservation, BenchObserver, UsageTap } from "../observe"
import type { evaluateWithPythonSwebench, PySwebenchOpts } from "../python-swebench"
import type { Instance, InstanceResult } from "../types"
import { runEnvPrep } from "./env-prep"
import { exec } from "./exec"
import { buildRepairContext } from "./repair/context"
import { runRepairRounds } from "./repair/index"
import type {
  BuildRepairContextArgs,
  RunOnceResult,
  ValidateArgs,
  ValidatorResult,
} from "./repair/types"
import { validate as defaultValidate } from "./repair/validator"
import {
  buildWiring,
  emitPatch,
  emitSandbox,
  emitVerify,
  NullStream,
  ObservationError,
  type Wiring,
} from "./report"
import { cleanupSandbox, copyRepo, createSandbox } from "./sandbox"
import { gitStageAndDiffCached, withGitSnapshot } from "./snapshot"
import { verify } from "./verdict"

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
  /**
   * b2 — External repair rounds (RFC §16, ADR-0014). ABSENT (default) ⇒ feature
   * OFF / byte-identical single-pass; same gating posture as `pythonSwebench?`/
   * `observe?`. When present AND `instance.swebench` is set, the runner wraps
   * `runAgentPhase` in `runRepairRounds`: rounds share ONE sandbox (continue-
   * from-patched-tree, no git reset between rounds), the official `verify()`
   * runs EXACTLY ONCE at the end (no-leak invariant — never fed back to the
   * agent), and the seed message handed to round ≥1 is built from the agent's
   * own validator failure tail (NOT from any dataset hidden field).
   * `validate`/`buildContext` are injectable test seams; production defaults
   * are the G1 implementations.
   */
  repair?: {
    maxRounds?: number
    validate?: (args: ValidateArgs) => Promise<ValidatorResult>
    buildContext?: (args: BuildRepairContextArgs) => string
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

/**
 * BENCH-INTENTIONAL OPT-OUTS (Codex absorption Phases 0-8 + Round 3):
 * the SWE-bench grader is byte-sensitive (the official Python harness diffs
 * the agent's patch against the reference), so the bench harness deliberately
 * omits every optional Codex-absorption knob below. The agent runs in the
 * *plainest possible posture* — only the cache lever (ADR-0004), compaction
 * (ADR-0011), and `verifyGuard` (ADR-0013, when explicitly enabled by the
 * caller) are touched. The omissions are NOT oversight; reintroducing them
 * would change measurement integrity:
 *
 *   - `mode`             — bench is plain "default" (no plan/review/audit
 *                          posture forcing); the agent's task is the diff,
 *                          not the report shape.
 *   - `repoRules`        — sandbox repo's own `CONTRIBUTING.md`/etc. is not
 *                          loaded as agent authority; bench measures the
 *                          agent's intrinsic skill, not its rule-reading.
 *   - `hitl`             — bench is unattended (`acceptEdits` permission);
 *                          a HITL gate would deadlock on every confirm.
 *   - `closeoutGuard`    — closeout reminders shape report text, not patch
 *                          contents; bench measures patches.
 *   - `workingState`     — L3 scratchpad rides the reminder and changes the
 *                          turn-context bytes; bench keeps a stable prompt.
 *   - `skills`           — skill discovery + active-skills block likewise
 *                          shifts the per-turn reminder.
 *
 * Opt-in flags added (A/B measurement; default-OFF preserves byte-identity):
 *   - QUANTA_BENCH_LSP=1       wire LSP nav tools (OR with QUANTA_LSP_TOOLS=full)
 *   - QUANTA_BENCH_SUBAGENT=1  wire `subagent` AgentConfig block
 *   - QUANTA_BENCH_SKILLS=1    wire `skills` AgentConfig block (bundled-only)
 *  See {@link benchOptIns} (just below) for the resolver — the BENCH-INTENTIONAL
 *  posture is unchanged when all three are unset. If a future bench mode wants
 *  any of the other listed knobs, add another opt-in flag — do NOT remove this
 *  comment block without an accompanying measurement-integrity ADR.
 */

/** SWE-bench A/B opt-in resolver. EVERY flag default-OFF; an unset env yields
 *  `{ lspNav:false, subagent:undefined, skills:undefined }` and `buildConfig`
 *  is byte-identical to the BENCH-INTENTIONAL posture above. Exported for
 *  direct unit testing — three independent env reads, no cross-coupling.
 *
 *  Slice-isolation choice: the CLI has cousins (`buildSubagentConfig` /
 *  `buildSkillsConfig` in `src/apps/cli/internal.ts`) but they read DIFFERENT
 *  env keys (`QUANTA_SUBAGENT` / `QUANTA_SKILLS_DIR` + a `--skills` argv
 *  check). Bench needs its OWN bench-only gate so a `QUANTA_SUBAGENT=1`
 *  exported in a dev shell does NOT silently leak into measurement runs.
 *  Inline duplication is intentional: ~3 lines per builder, isolated test
 *  surface, no `apps/bench → apps/cli` import dependency. */
export const benchOptIns = (): {
  lspNav: boolean
  subagent: AgentConfig["subagent"] | undefined
  skills: AgentConfig["skills"] | undefined
} => {
  // ADR-0015 LSP-nav: original gate `QUANTA_LSP_TOOLS=full` (same as CLI) OR
  // the new bench-only gate `QUANTA_BENCH_LSP=1`. Either one ⇒ tools wired.
  const lspNav = process.env.QUANTA_LSP_TOOLS === "full" || process.env.QUANTA_BENCH_LSP === "1"
  // Subagent: bench-only `QUANTA_BENCH_SUBAGENT=1`. Empty block ⇒ runner default
  // applies (no per-bench maxDepth tuning — keep the surface minimal until a
  // measured reason appears).
  const subagent: AgentConfig["subagent"] | undefined =
    process.env.QUANTA_BENCH_SUBAGENT === "1" ? {} : undefined
  // Skills: bench-only `QUANTA_BENCH_SKILLS=1`. Empty block ⇒ bundled system
  // skills ONLY (ADR-0045) — bench never points at a user dir (measurement
  // integrity). `changedPaths` is left unset (full inventory).
  const skills: AgentConfig["skills"] | undefined =
    process.env.QUANTA_BENCH_SKILLS === "1" ? {} : undefined
  return { lspNav, subagent, skills }
}

export const buildConfig = (
  instance: Instance,
  deps: RunInstanceDeps,
  sandbox: string,
  signal: AbortSignal,
  stream: StreamPort,
  seedMsg?: string,
) => {
  // ADR-0015 LSP-nav: opt-in via `QUANTA_LSP_TOOLS=full` (same gate as CLI) OR
  // the bench-only `QUANTA_BENCH_LSP=1`. When the language-server binary
  // (`pyright-langserver` / `typescript-language-server`) is absent the
  // per-call probe in `lsp-bridge` makes the tools emit a clean `ok:false` —
  // registration is harmless without a server. Default-OFF preserves
  // byte-identical bench behavior.
  const opt = benchOptIns()
  const lspNavTools = opt.lspNav ? lspNavToolList() : []
  // DIP factory: bench driver runs against the default port surface; the
  // per-instance sandbox is enforced by cwd, not by injected fs ports.
  const registry = new ToolRegistry([...buildDefaultTools(), ...lspNavTools])
  const permission: PermissionContext = { mode: "acceptEdits" }
  const base = `${instance.problemStatement}\n\nWork inside ${sandbox}. When done, stop.`
  // Default behavior (no seedMsg) is byte-identical to the pre-b2 prompt: the
  // user message is `base` (+ SWEBENCH_DIRECTIVE for swebench instances). A
  // seedMsg ⇒ appended after a blank line ONLY for repair rounds ≥1.
  const baseText = instance.swebench ? `${base}${SWEBENCH_DIRECTIVE}` : base
  const text = seedMsg !== undefined && seedMsg !== "" ? `${baseText}\n\n${seedMsg}` : baseText
  const messages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text }],
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
    // Verify-guard (ADR-0013): observed bench failure — agent edits a
    // source file then declares "done" with 0 verification → wrong fix ships.
    // Gated exactly like SWEBENCH_DIRECTIVE (real SWE-bench only; custom-corpus
    // byte-identical). Absent ⇒ guard OFF, loop unchanged. Pass `{}` so the
    // current `DEFAULT_MAX_TRIPS` (1) applies; the prior explicit `2` produced
    // the negative empirical that motivated ADR-0013's default reduction —
    // inheriting the default makes the lesson actually apply on the bench path.
    ...(instance.swebench ? { verifyGuard: {} } : {}),
    // Bench A/B opt-ins (default-OFF; all three unset ⇒ keys omitted entirely,
    // exactOptionalPropertyTypes-friendly, AgentConfig byte-identical).
    ...(opt.subagent !== undefined ? { subagent: opt.subagent } : {}),
    ...(opt.skills !== undefined ? { skills: opt.skills } : {}),
  }
}

interface Phase {
  patch: string
  turns: number
}

/**
 * Capture the agent's LAST `bash`/`test_runner` tool call argument by
 * wrapping a downstream `StreamPort` and intercepting `tool_call` events. Pure
 * tap: every event is forwarded unchanged; the bench can read `lastVerifyCmd`
 * after `runAgent` returns. For `bash`, `input.command` carries the shell
 * string; for `test_runner` the tool name itself counts as a verification — we
 * record the tool name (no command string is associated) so the validator can
 * still fall back to the agent's `reproPath` (or return degenerate).
 */
class LastVerifyCmdTap implements StreamPort {
  lastVerifyCmd: string | undefined
  constructor(private readonly downstream: StreamPort) {}
  emit(event: AgentEvent): void {
    if (event.type === "tool_call") {
      if (event.name === "bash") {
        const input = event.input
        if (typeof input === "object" && input !== null && "command" in input) {
          const cmd = (input as { command: unknown }).command
          if (typeof cmd === "string" && cmd !== "") this.lastVerifyCmd = cmd
        }
      } else if (event.name === "test_runner") {
        // test_runner has no shell-equivalent string; treat the tool-call name
        // as a sentinel so the orchestrator knows the agent DID verify (the
        // validator falls back to reproPath / degenerate when cmd is unset).
        this.lastVerifyCmd = "test_runner"
      }
    }
    this.downstream.emit(event)
  }
}

/**
 * Run the agent ONCE in the sandbox (no git wrap — caller controls snapshot
 * boundaries). Returns the cumulative diff + turns + lastVerifyCmd captured
 * from the stream. Used both by the single-pass path and by the per-round
 * `runOnce` closure of the repair orchestrator (continue-from-patched-tree).
 */
const runAgentOnce = async (
  instance: Instance,
  deps: RunInstanceDeps,
  sandbox: string,
  signal: AbortSignal,
  w: Wiring,
  seedMsg: string | undefined,
  timeoutMs: number,
): Promise<RunOnceResult> => {
  const tap = new LastVerifyCmdTap(w.stream)
  const outcome = await runAgent(buildConfig(instance, deps, sandbox, signal, tap, seedMsg))
  // Capture the cumulative diff CURRENTLY in the worktree (without resetting
  // the index): mirrors `withGitSnapshot`'s final diff step. `git` is
  // opportunistic — absence ⇒ "". T2: cache/build paths pruned at source.
  const patch = await gitStageAndDiffCached(sandbox, timeoutMs)
  const result: RunOnceResult = {
    patch,
    turns: outcome.turns,
    ...(tap.lastVerifyCmd !== undefined ? { lastVerifyCmd: tap.lastVerifyCmd } : {}),
  }
  return result
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

/**
 * Repair-path phase: ONE `withGitSnapshot` wraps ALL rounds (so the prior
 * round's edits persist into round N+1 — no `git reset/clean` between rounds).
 * The official `verify()` is NEVER invoked here — it runs ONCE outside, on the
 * cumulative final patch (no-leak invariant). The validator/buildContext are
 * injectable; production defaults are G1's `validate`/`buildRepairContext`.
 */
const runRepairPhase = async (
  instance: Instance,
  deps: RunInstanceDeps,
  sandbox: string,
  signal: AbortSignal,
  w: Wiring,
  repair: NonNullable<RunInstanceDeps["repair"]>,
): Promise<Phase> => {
  let turns = 0
  let finalPatch = ""
  const patch = await withGitSnapshot(
    sandbox,
    deps.timeoutMs,
    instance.swebench?.baseCommit,
    async () => {
      await emitSandbox(w.observer, sandbox, instance.swebench?.baseCommit, deps.timeoutMs)
      const out = await runRepairRounds({
        config: { ...(repair.maxRounds !== undefined ? { maxRounds: repair.maxRounds } : {}) },
        problem: instance.problemStatement,
        runOnce: (seedMsg) =>
          runAgentOnce(instance, deps, sandbox, signal, w, seedMsg, deps.timeoutMs),
        validate: repair.validate ?? defaultValidate,
        buildContext: repair.buildContext ?? buildRepairContext,
        sandbox,
        exec,
        timeoutMs: deps.timeoutMs,
      })
      turns = out.turns
      finalPatch = out.patch
    },
  )
  // `patch` (from withGitSnapshot's final diff) is the canonical capture; if
  // available we prefer it (it reflects the worktree at end of all rounds).
  // `finalPatch` is the orchestrator's view of the last round's diff — they
  // agree by construction (continue-from-patched-tree, single sandbox).
  return { patch: patch !== "" ? patch : finalPatch, turns }
}

const okResult = (
  instance: Instance,
  phase: Phase,
  v: { passed: boolean; error?: string },
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
  const sandbox = await createSandbox(instance)
  const abort = new AbortController()
  const deadline = setTimeout(() => abort.abort(), deps.timeoutMs)
  const startedAt = Date.now()
  let phase: Phase = { patch: "", turns: 0 }
  let w: Wiring = { stream: new NullStream() }
  try {
    w = buildWiring(instance, deps.observe)
    await copyRepo(instance, sandbox)

    // T4 — per-instance env pre-preparation (fail-fast). When the instance
    // carries a `setupCmd`, run it in the sandbox copy BEFORE the agent. If
    // setup exits non-zero we fail-fast with a DISTINCT `env_prep_failed`
    // verdict and DO NOT run the agent — handing a half-prepared env to the
    // agent is exactly the failure this prevents.
    const prep = await runEnvPrep(instance, sandbox, deps.timeoutMs)
    if (!prep.ok) {
      return {
        id: instance.id,
        passed: false,
        patch: "",
        turns: 0,
        verdict: "env_prep_failed",
        error: `env prep (setupCmd) failed (code ${prep.code}): ${prep.stderr.slice(0, 500)}`,
      }
    }

    // b2 — Repair gating: ONLY when caller set `deps.repair` AND this is a
    // real SWE-bench instance (same posture as verifyGuard / SWEBENCH_DIRECTIVE).
    // ABSENT ⇒ existing single-pass path verbatim (byte-identical: same calls,
    // same buildConfig (no seedMsg), same single withGitSnapshot/runAgent,
    // same single verify()). The official verify() ALWAYS runs exactly once,
    // OUTSIDE the repair loop — its result is never fed back to the agent
    // (no-leak invariant; also enforced by code locality).
    phase =
      deps.repair !== undefined && instance.swebench !== undefined
        ? await runRepairPhase(instance, deps, sandbox, abort.signal, w, deps.repair)
        : await runAgentPhase(instance, deps, sandbox, abort.signal, w)
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
    await cleanupSandbox(sandbox)
  }
}

// Re-export the observation usage tap so test fixtures and other internals can
// continue to use bench's typed surface unchanged.
export { BenchObserver, UsageTap }
