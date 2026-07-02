/**
 * `@/apps/terminal/brain-mode` — the terminal "brain-mode" entry-point (RFC jun-29 §13, spec B3).
 *
 * The BRAIN process speaks line-delimited JSON over **stdio** to a separate HANDS process (the
 * Python harbor `serve` adapter). This module assembles the BASE-free terminal tool surface over a
 * `JsonLineDuplex` built from the brain's own stdin/stdout, drives the REAL agent loop (the SAME
 * `@/host/bootstrap` + `@/sdk/runtime` + `@/runner/*` cores the CLI/headless surfaces use) with
 * those tools + the operator capability guide, and on completion writes a report JSON to
 * `--report-out` and signals EOF on stdout so the hands-side `serve` loop ends.
 *
 * WIRE CONTRACT (brain ⇄ hands, line-delimited JSON):
 *   - brain → stdout : `{"id":N,"type":"exec","command":"…"}` / `{"id":N,"type":"cancel"}`
 *   - brain ← stdin  : `{"id":N,"type":"exec_result","stdout":…,"stderr":…,"code":N}`
 *                      / `{"id":N,"type":"error","message":"…"}`
 *   These frames are produced/consumed by `containerExecOverIpc` (see `@/tool/container-exec`).
 *
 * stdout is RESERVED for protocol frames ONLY — every log / diagnostic goes to stderr. The
 * testable core ({@link runTerminalBrain}) takes ALL of stdio / LLM / fs as injected deps (no
 * `process.*` reads); the thin process-level `main()` behind `import.meta.main` parses argv and
 * binds the real `process.stdin` / `process.stdout` / real LLM. This mirrors how `apps/cli` and
 * `apps/headless` separate the pure entry from the `import.meta.main` shim.
 *
 * SURFACE ISOLATION (biome fence `src/apps/terminal/**`): this root composes ONLY `@/tool` ports +
 * the shared agent-loop cores (`@/host/bootstrap`, `@/sdk/runtime`, `@/runner/*`, `@/llm`,
 * `@/stream`, `@/agent` types). It MUST NOT import sibling app surfaces (apps/cli / apps/bench /
 * apps/agent / apps/headless / …) — the minimal fake bootstrap deps the headless surface uses are
 * REPLICATED locally here so this slice never reaches across the fence.
 */

import { createActivityStore } from "@/activity"
import { composeSystemPromptForSurface, type SurfaceProfile } from "@/agent"
import { defaultConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import type { SessionBootstrapDeps, SessionRuntimeConfigShape } from "@/host/bootstrap"
import { bootstrapSession } from "@/host/bootstrap"
import type { ImageBlock, LLMPort, Message } from "@/llm"
import { defaultResponsesContinuationStore } from "@/llm/responses-continuation-store"
import type { ResolveResumeInput, ResumeResolution } from "@/runner/orchestrate/resume-fsm"
import { runSessionTurn } from "@/runner/orchestrate/session-turn-driver"
import { createRuntimeFromBootstrap } from "@/sdk/runtime"
import type { AgentEvent, StreamPort } from "@/stream"
import { TERMINAL_OPERATOR_GUIDE, type Tool, ToolRegistry } from "@/tool"
import type { JsonLineDuplex } from "@/tool/container-exec"
import type { PtySessionPort } from "@/tool/pty"
import { gateOn } from "@/shared/env-flag"
import { terminalSurfaceOverDuplex } from "./index"
import {
  deriveVerificationState,
  inspectExerciseEvidence,
  type VerificationStamp,
} from "./verify-gate"

const TERMINAL_BRAIN_SESSION_ID = "terminal-brain-session"

/** Lever #2 knob (RFC `jul-2-terminal-bench-levers/02`): the verify-before-finalize gate.
 *  DEFAULT-OFF ⇒ byte-identical today (no `verification` field, no extra turn). When ON, the brain
 *  inspects the trajectory for an end-to-end exercise of the deliverable and, if none is found,
 *  injects EXACTLY ONE bounded follow-up turn, then stamps an honest verification trichotomy. */
export const TB_VERIFY_GATE_ENV = "QUANTA_TB_VERIFY_GATE"

/** Lever #1 knob (RFC `jul-2-terminal-bench-levers/01`): the environment posture.
 *  DEFAULT-OFF ⇒ byte-identical today (the brain's system prompt keeps the frozen
 *  SWE-bench env guardrails — R-ENV / R-STOP-ENV). When ON, the brain rebuilds its
 *  SYSTEM prompt with the `owned` posture (install/configure/build freely — a working
 *  environment IS the deliverable), which the install-gated Terminal-Bench tasks need.
 *  PROMPT-TEXT-ONLY: this swaps rendered rule text via `boot.systemSource`; it does NOT
 *  set any `SandboxMode` / `SandboxPolicy` and does NOT loosen host enforcement — the
 *  brain's tools stay `container_exec` / `pty_*` over the duplex (the container is the
 *  isolation boundary). */
export const TB_ENV_OWNED_ENV = "QUANTA_TB_ENV_OWNED"

/** The terminal brain's DECLARED surface profile (RFC `jul-2-terminal-bench-levers/00` §X).
 *  The terminal entry point is a *deployment fact*: it owns its container, so its profile
 *  declares `envPosture: "owned"` + the terminal operator guide. Declaring it here — rather
 *  than an inline `buildSystemPrompt({ envPosture: "owned" })` at the launch site — keeps the
 *  prompt core a pure composer (no per-surface `if`) and lets OTHER surfaces (CLI / bench /
 *  web-daemon) declare their own profile later without a core edit. PROMPT-TEXT-ONLY: this is
 *  a string value object; it sets NO `SandboxPolicy` / `SandboxMode` and never touches host
 *  enforcement. The `QUANTA_TB_ENV_OWNED` knob GATES whether this profile is applied at launch
 *  (default-OFF ⇒ the frozen default ⇒ byte-identical to today). */
export const TERMINAL_SURFACE_PROFILE: SurfaceProfile = {
  envPosture: "owned",
  operatorGuide: TERMINAL_OPERATOR_GUIDE,
}

/** The single bounded follow-up nudge. References ONLY the task's own success criterion — never a
 *  hidden test / answer key (honors `no-answer-key-regex-heuristics`). Fired AT MOST ONCE. */
export const VERIFY_GATE_FOLLOWUP =
  "You are about to finalize. Exercise your deliverable end-to-end against the task's success " +
  "criterion (run it and observe the result), then report the observed outcome as pass / fail / " +
  "could-not-verify."

/** Report JSON the hands side reads into harbor's `AgentContext` (spec B3). Trajectory optional. */
export interface TerminalBrainReport {
  readonly instruction: string
  readonly turns: number
  readonly tokens: { readonly input: number; readonly output: number }
  readonly cost_usd: number
  readonly final: string
  /** Lever #2 (`QUANTA_TB_VERIFY_GATE`): the verify-before-finalize verdict. PRESENT ONLY when the
   *  gate ran (knob ON) — absent ⇒ byte-identical to the pre-lever report. `unverifiable` /
   *  `verified-fail` finalize immediately (the honest exits that make over-persistence impossible). */
  readonly verification?: VerificationStamp
  /** Lever #1 (`QUANTA_TB_ENV_OWNED`): stamped `"owned"` ONLY when the owned posture was applied
   *  (knob ON) — absent ⇒ byte-identical to the pre-lever report. Lets per-task A/B analysis confirm
   *  the owned prompt actually rendered for this task (guards against a silent env-plumbing miss). */
  readonly envPosture?: "owned"
}

/** Result returned to the caller (and to the process `main()`) after one brain run. */
export interface TerminalBrainResult {
  readonly turns: number
  readonly report: TerminalBrainReport
}

/** Fully-injected inputs for the testable brain core. Every IO seam is a dep so the hellgate can
 *  drive a network-free, fs-free run. */
export interface RunTerminalBrainOpts {
  /** The task instruction (the single user turn). */
  readonly instruction: string
  /** Model id surfaced in telemetry / the report. Default `"terminal-brain"`. */
  readonly model?: string
  /** Path the report JSON is written to (the `--report-out` value). */
  readonly reportOut: string
  /** The brain's read side — inbound `exec_result` / `error` frames from the hands process. */
  readonly stdin: AsyncIterable<string>
  /** The brain's write side — outbound protocol frames ONLY. The duplex appends the `\n`. */
  readonly stdout: { write(line: string): void }
  /** The agent LLM port (real adapter in production; a scripted fake in the hellgate). */
  readonly llm: LLMPort
  /** Persist the report. Injected so the core stays fs-free; `main()` binds a real fs writer. */
  readonly writeReport: (path: string, report: TerminalBrainReport) => void
  /** Optional interactive PTY backend bound to the same container. Absent ⇒ no `pty_*` tools. */
  readonly ptySession?: PtySessionPort
  /** Signal EOF on stdout so the hands-side `serve` loop ends. Injected so the core is IO-free;
   *  `main()` binds `() => process.stdout.end()`. Absent ⇒ no-op (the duplex still drained). */
  readonly closeStdout?: () => void
  /** Bounded turn cap forwarded into the assembled loop. Default 30. */
  readonly maxTurns?: number
  /** Working directory the run reports operate from. Default `"/"` (container root). */
  readonly cwd?: string
  /** Caller abort signal. Default: never abort. */
  readonly signal?: AbortSignal
  /** Env THREADED from the composition root (`main()` binds `process.env`) so the verify-gate knob
   *  (`QUANTA_TB_VERIFY_GATE`) is read here, not from an ambient `process.env`. Default `{}` ⇒ gate
   *  OFF ⇒ byte-identical (no `verification` field, no extra turn). */
  readonly env?: Record<string, string | undefined>
}

/** Capture stream: the loop emits every `AgentEvent` here so the core can total token usage for the
 *  report without re-deriving it from the message stream. */
class CapturingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

/** Build a complete, offline {@link SessionBootstrapDeps} bundle wired to the injected LLM, capture
 *  stream, and the terminal tool registry. REPLICATES the headless `buildFakeBootstrapDeps` shape
 *  (cannot import `@/apps/headless` across the terminal fence) — the deps the agent loop needs that
 *  the brain surface does not own (memory store / subagents / reviewer / MCP / images) are leanest
 *  valid stubs. */
const buildTerminalBootstrapDeps = (
  llm: LLMPort,
  stream: StreamPort,
  tools: readonly Tool[],
): SessionBootstrapDeps => {
  const registry = new ToolRegistry([...tools])
  return {
    buildLifecycleBundle: () => ({
      pills: { update: () => undefined },
      taskRegistry: undefined,
      followUpQueue: undefined,
      activityStore: createActivityStore(),
    }),
    deriveMcpPillServers: () => [],
    buildCostPanelOrUndefined: () => undefined,
    buildBranchProgressOrUndefined: () => undefined,
    buildPlanStoreOrUndefined: () => undefined,
    buildWorkMetricsSink: () => undefined,
    buildLlm: () => llm,
    buildAutoTitlePort: () => undefined,
    buildStreaming: () => ({ stream, run: undefined }),
    buildTooling: () => ({
      store: undefined,
      embedder: undefined,
      sessionId: TERMINAL_BRAIN_SESSION_ID,
      registry,
      memoryConfig: undefined,
      subagentConfig: undefined,
      skillsConfig: undefined,
      compactionBreakerConfig: undefined,
      verifyGuardConfig: undefined,
    }),
    loadFeatures: async () => ({
      planMode: false,
      metrics: undefined,
      state: undefined,
      resume: undefined,
      mcpTools: [],
      mcpClients: [],
      mcpConfigs: [],
      lspTools: [],
      lspNavTools: [],
      gitToolList: [],
      astGrepTools: [],
    }),
    loadImageBlock: (): ImageBlock => ({ type: "image", data: "", mediaType: "image/png" }),
    pickIdentity: () => undefined,
    pickPersona: () => "default",
    resolveResume: async (_: ResolveResumeInput): Promise<ResumeResolution> => ({
      sessionId: TERMINAL_BRAIN_SESSION_ID,
      history: [] as Message[],
      idMeta: undefined,
      inIdMode: false,
      conflictError: undefined,
      missingIdError: undefined,
    }),
    composeShellEvent: () => undefined,
    switchToSessionCwd: (cwd) => cwd,
    materializeReviewerAgent: () => undefined,
    createSubagentBackedGuardianReview: () => (async () => ({})) as never,
    createSubagentBackedGuardianAssess: () => (async () => ({})) as never,
    buildMcpSurfaceInfo: () => undefined,
    buildIdleGuards: () => ({
      idleMonitor: { markActive: () => undefined },
      rejectCounter: { recordAccept: () => undefined, recordDeny: () => undefined },
    }),
  }
}

/** Idle-input timeout for the offline brain runtime. There is NO human at the
 *  keyboard on the box, so this only bounds "no inbound frame" — 60s is long
 *  enough that a slow model turn or tool exec is not mistaken for idle, short
 *  enough that a genuinely wedged run surfaces instead of hanging the box.
 *  Named (no-magic-timeout guard). */
const TERMINAL_BRAIN_IDLE_TIMEOUT_MS = 60_000

/** Build the leanest valid {@link SessionRuntimeConfigShape} for an offline brain run. No
 *  `process.*` reads — the surface entry threads argv-derived values in. */
const buildTerminalRuntime = (opts: RunTerminalBrainOpts): SessionRuntimeConfigShape => ({
  // Config-label only — the ACTUAL provider is whatever the injected `llm` adapter is. The runtime
  // shape constrains this to the `LLMProvider` enum, so we carry the headless precedent's `"openai"`
  // placeholder; the brain never dispatches on it (the surface tools + injected LLM own behavior).
  provider: "openai",
  model: opts.model ?? "terminal-brain",
  mode: "acceptEdits",
  maxTurns: opts.maxTurns ?? 30,
  cwd: opts.cwd ?? "/",
  env: {},
  homeDir: "/tmp",
  stdinIsTTY: false,
  stdoutIsTTY: false,
  newSession: false,
  title: undefined,
  idleMs: TERMINAL_BRAIN_IDLE_TIMEOUT_MS,
  snoozeDefaultMs: 300_000,
  rejectLimit: 20,
  idleSuppressOn: false,
  observeDir: undefined,
  pendingImagePaths: [],
  mcpConfigPath: undefined,
  argPrompt: undefined,
  spinnerIntervalMs: "80",
})

/** A `JsonLineDuplex` over the brain's stdio: read inbound frames from `stdin`, write outbound
 *  frames to `stdout` (appending the line terminator). */
const duplexOverStdio = (
  stdin: AsyncIterable<string>,
  stdout: { write(line: string): void },
): JsonLineDuplex => ({
  write: (line) => stdout.write(`${line}\n`),
  lines: stdin,
})

/** Total input/output tokens from the captured `usage` AgentEvents (terminal usage owns billing —
 *  transient `output_progress` is intentionally skipped). */
const totalTokens = (events: readonly AgentEvent[]): { input: number; output: number } => {
  let input = 0
  let output = 0
  for (const ev of events) {
    if (ev.type === "usage") {
      input += ev.inputTokens
      output += ev.outputTokens
    }
  }
  return { input, output }
}

/** The final assistant SAY: concatenated visible text of the LAST assistant message. Empty when the
 *  model finished with a tool call / no text (the hands side renders an empty `final` then). */
const finalAssistantText = (messages: readonly Message[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role !== "assistant") continue
    return msg.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("")
  }
  return ""
}

/**
 * Run the terminal brain ONCE: assemble the duplex-backed terminal surface, drive the real agent
 * loop with the operator guide + instruction, write the report, and signal EOF. Fully injected —
 * the hellgate drives it network-free / fs-free. Returns the turn count + the written report.
 */
/** Lever #2 — verify-before-finalize gate (STRUCTURAL/SELECTIVE/BOUNDED/HONEST,
 *  RFC jul-2). The harness (not a prompt line) inspects the recorded trajectory
 *  for evidence the deliverable was RUN AND OBSERVED; when absent AND the run has
 *  turn budget left, it fires the ONE follow-up (at most once — no loop, so the
 *  ~3× over-persist that got the prior blanket steer reverted is structurally
 *  impossible), then re-inspects and stamps a verified-pass/fail/unverifiable
 *  trichotomy. `followUpFired` rides the stamp for A/B attribution. Extracted
 *  from `runTerminalBrain` to keep it under the god-FUNCTION cap. */
const runVerifyBeforeFinalizeGate = async (args: {
  session: Parameters<typeof runSessionTurn>[0]["session"]
  stream: CapturingStream
  turnSignal: AbortSignal
  maxTurns: number
  outcomeTurns: number
  messages: readonly Message[]
}): Promise<{
  outcomeTurns: number
  messages: readonly Message[]
  verification: VerificationStamp
}> => {
  let outcomeTurns = args.outcomeTurns
  let messages = args.messages
  let followUpFired = false
  const preVerdict = inspectExerciseEvidence(args.stream.events)
  // Fire the ONE follow-up ONLY when there is no exercise evidence AND the run has
  // not already exhausted its turn budget (the budget guard is what stops a nudge
  // PAST the cap on an exhausted run — the over-persist the RFC forbids).
  if (!preVerdict.exercised && outcomeTurns < args.maxTurns) {
    const followUp = await runSessionTurn({
      session: args.session,
      resolveApproval: async () => "approve",
      text: VERIFY_GATE_FOLLOWUP,
      turnSignal: args.turnSignal,
      env: {},
    })
    outcomeTurns = followUp.outcome.turns
    messages = followUp.messages
    followUpFired = true
  }
  const verification = {
    ...deriveVerificationState(
      inspectExerciseEvidence(args.stream.events),
      finalAssistantText(messages),
    ),
    followUpFired,
  }
  return { outcomeTurns, messages, verification }
}

/** Emit the brain's contract output (report file THEN stdout EOF — order matters,
 *  spec B3: the hands `serve` loop ends on EOF and immediately reads the report,
 *  so EOF before the write would race a missing/stale report) and produce the
 *  result. Re-throws a captured mid-run error AFTER the channel is closed so the
 *  process still exits non-zero. Extracted to keep `runTerminalBrain` under the
 *  god-FUNCTION cap. */
const finalizeTerminalBrain = (
  opts: RunTerminalBrainOpts,
  stream: CapturingStream,
  state: {
    outcomeTurns: number
    messages: readonly Message[]
    verification: VerificationStamp | undefined
    envOwnedApplied: boolean
    runError: unknown
  },
): TerminalBrainResult => {
  const tokens = totalTokens(stream.events)
  const report: TerminalBrainReport = {
    instruction: opts.instruction,
    turns: state.outcomeTurns,
    tokens,
    // cost is computed host-side from a pricing table the brain surface does not
    // own; the report carries 0 here and the hands/orchestrator may enrich it.
    cost_usd: 0,
    final: finalAssistantText(state.messages),
    // Lever #2 / #1 stamps — exact-optional spread ⇒ the field is entirely ABSENT
    // when the gate/posture is off, keeping the report byte-identical to pre-lever.
    ...(state.verification !== undefined ? { verification: state.verification } : {}),
    ...(state.envOwnedApplied ? { envPosture: "owned" as const } : {}),
  }
  opts.writeReport(opts.reportOut, report)
  opts.closeStdout?.()
  if (state.runError !== undefined) throw state.runError
  return { turns: state.outcomeTurns, report }
}

/**
 * Resolve the brain's per-run turn cap from the SHARED `QUANTA_MAX_TURNS` knob — the SAME env var the
 * CLI REPL (`session-runtime-config.ts`) and the bench runner (`runtime-config.ts` → `maxTurnsBatch`)
 * already honor. NOT a new knob (review: reuse, don't reinvent): the terminal brain was the only
 * surface that ignored it, hardcoding 30 (`buildTerminalRuntime`), while top TB scaffolds (Terminus 2)
 * run turns UNBOUNDED — a structural cap that made >30-turn tasks (e.g. make-mips-interpreter, which
 * hit exactly 30) unreachable. Absent / blank / non-positive ⇒ `undefined` ⇒ the core's default (30),
 * byte-identical to today. A positive integer raises (or lowers) the cap.
 */
export const resolveMaxTurnsFromEnv = (
  env: Record<string, string | undefined>,
): number | undefined => {
  const raw = env.QUANTA_MAX_TURNS
  if (raw === undefined || raw.trim() === "") return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

export const runTerminalBrain = async (
  opts: RunTerminalBrainOpts,
): Promise<TerminalBrainResult> => {
  const duplex = duplexOverStdio(opts.stdin, opts.stdout)
  const surface = terminalSurfaceOverDuplex(
    duplex,
    ...(opts.ptySession !== undefined ? [opts.ptySession] : []),
  )
  const stream = new CapturingStream()
  const deps = buildTerminalBootstrapDeps(opts.llm, stream, surface.tools)
  const runtime = buildTerminalRuntime(opts)

  // The operator capability guide rides as a leading block on the instruction turn so the model
  // sees its terminal-surface operating habits before the task. (The surface fence forbids reaching
  // a sibling host hook to splice it into the static system prompt; threading it onto the first user
  // turn is a real, observable injection and keeps this slice self-contained.)
  const turnText = `${surface.operatorGuide}\n\n# Task\n${opts.instruction}`

  const verifyGateOn = gateOn(opts.env ?? {}, TB_VERIFY_GATE_ENV)
  let outcomeTurns = 0
  let messages: readonly Message[] = []
  let verification: VerificationStamp | undefined
  let envOwnedApplied = false
  let runError: unknown
  try {
    const boot = await bootstrapSession(deps, runtime, {})
    if (opts.signal) {
      if (opts.signal.aborted) boot.abort.abort()
      else opts.signal.addEventListener("abort", () => boot.abort.abort(), { once: true })
    }

    // ── Lever #1 via the SurfaceProfile seam (default-OFF ⇒ this block is skipped, byte-identical) ──
    // The terminal entry point DECLARES its surface profile (`TERMINAL_SURFACE_PROFILE`,
    // envPosture:"owned"); `QUANTA_TB_ENV_OWNED` GATES whether it is applied at launch. When ON we
    // compose the SYSTEM prompt for that profile via the pure composer `composeSystemPromptForSurface`
    // (no per-surface `if` in the prompt core) and publish it through `boot.systemSource` — the SAME
    // mutable seam `refreshSystemPrompt` uses for identity swaps; the turn assembler reads
    // `systemSource.get()` every turn. This swaps ONLY the rendered env-rule TEXT (drops R-ENV /
    // R-STOP-ENV, adds R-ENV-OWNED / R-INSTALL-THRASH) — PROMPT-TEXT-ONLY: it sets NO SandboxMode /
    // SandboxPolicy and does NOT touch host enforcement. Composition mirrors bootstrap's own frozen
    // build for this surface exactly (persona "default", no identity), so the ONLY delta vs the frozen
    // prompt is the env-rule list. The `operatorGuide` field of the profile is injected per-turn on
    // the instruction (see `turnText`), kept off the cached system prefix on purpose.
    if (gateOn(opts.env ?? {}, TB_ENV_OWNED_ENV)) {
      boot.systemSource.set(
        composeSystemPromptForSurface(TERMINAL_SURFACE_PROFILE, {
          cwd: boot.cwd,
          persona: "default",
        }),
      )
      envOwnedApplied = true
    }
    const { runtime: facade } = await createRuntimeFromBootstrap({
      boot,
      stream,
      onConfirm: async () => false,
      execution: {
        history: boot.history,
        cwd: boot.cwd,
        convStore: defaultConversationCheckpointStore(),
        envSource: {},
        responsesStore: defaultResponsesContinuationStore(),
      },
      memoryAuto: { env: {}, homeDir: "/tmp" },
      history: [...boot.history],
      state: boot.features.state,
      idMeta: boot.idMeta,
      shutdown: boot.shutdownMcp,
    })
    const session = await facade.createSession({
      cwd: boot.cwd,
      model: boot.model,
      permissionMode: boot.mode,
    })
    try {
      const turnResult = await runSessionTurn({
        session,
        // No human operator on the box — auto-approve so a tool that requests approval does not
        // deadlock the run (same posture as headless).
        resolveApproval: async () => "approve",
        text: turnText,
        turnSignal: boot.abort.signal,
        env: {},
      })
      outcomeTurns = turnResult.outcome.turns
      messages = turnResult.messages

      // ── Lever #2: verify-before-finalize gate (default-OFF ⇒ skipped, brain byte-identical) ──
      // See {@link runVerifyBeforeFinalizeGate} for the STRUCTURAL/SELECTIVE/BOUNDED/HONEST contract.
      if (verifyGateOn) {
        const gated = await runVerifyBeforeFinalizeGate({
          session,
          stream,
          turnSignal: boot.abort.signal,
          maxTurns: opts.maxTurns ?? 30,
          outcomeTurns,
          messages,
        })
        outcomeTurns = gated.outcomeTurns
        messages = gated.messages
        verification = gated.verification
      }
    } finally {
      await session.close().catch(() => undefined)
      await facade.close().catch(() => undefined)
    }
  } catch (err) {
    // Capture (don't rethrow yet): the report + EOF below are the surface's contract output and MUST
    // be emitted even on a mid-run failure so the hands side never hangs waiting for frames from a
    // dead brain. The error is re-thrown AFTER the channel is closed so the process still exits
    // non-zero and the failure is observable.
    runError = err
  }

  return finalizeTerminalBrain(opts, stream, {
    outcomeTurns,
    messages,
    verification,
    envOwnedApplied,
    runError,
  })
}

/* c8 ignore start — process-level shim: argv / real stdio / real fs binding. The testable core
 *  above is exercised by the hellgate; this thin entry only wires `process.*` and is verified on
 *  the box (a fake-LLM unit cannot bind real fd 0/1). */
const runMain = async (): Promise<void> => {
  const { argv } = await import("node:process")
  const { readFileSync, writeFileSync } = await import("node:fs")
  const { createInterface } = await import("node:readline")
  const process = await import("node:process")

  const argOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
  }
  const instructionFile = argOf("--instruction-file")
  const reportOut = argOf("--report-out")
  const model = argOf("--model")
  if (instructionFile === undefined || reportOut === undefined) {
    process.stderr.write("terminal brain-mode: --instruction-file and --report-out are required\n")
    process.exit(2)
    return
  }
  const instruction = readFileSync(instructionFile, "utf8").trim()

  // Line-buffered stdin → an async iterable of JSON frame lines.
  const rl = createInterface({ input: process.stdin })
  const stdinLines: AsyncIterable<string> = rl as unknown as AsyncIterable<string>

  const maxTurns = resolveMaxTurnsFromEnv(process.env)
  await runTerminalBrain({
    instruction,
    ...(model !== undefined ? { model } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    reportOut,
    stdin: stdinLines,
    // stdout is RESERVED for protocol frames; all logs go to stderr.
    stdout: { write: (line) => process.stdout.write(line) },
    llm: await buildRealLlm(model),
    writeReport: (path, obj) => writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`),
    closeStdout: () => process.stdout.end(),
    // Thread the real env so the verify-gate knob (`QUANTA_TB_VERIFY_GATE`) is read here, not from
    // an ambient `process.env` inside the pure core. Default-OFF when unset ⇒ byte-identical.
    env: process.env,
  })
  rl.close()
}

/** Resolve the real production LLM adapter from the shared provider factory (the SAME
 *  `tryCreateLLM` path the non-interactive bench entry uses — env-key-resolved, no CLI permission
 *  composition). Deferred (dynamic import) so the testable core never pulls a network adapter into
 *  the unit graph; the unit tests inject a fake `llm` and never reach here. box-verify: the live
 *  provider call is exercised only on the box (needs creds/tokens + a container for the hands). */
const buildRealLlm = async (model: string | undefined): Promise<LLMPort> => {
  const { DEFAULT_MODEL, pickProvider, tryCreateLLM } = await import("@/llm")
  const provider = pickProvider(process.env)
  const resolvedModel = model ?? DEFAULT_MODEL[provider]
  // Reasoning models (gpt-5.5) must STREAM their reasoning or they trip the LLM idle-timeout
  // mid-think → silent-retry stall (same rationale as the bench entry). An explicit
  // QUANTA_REASONING_SUMMARY override still wins inside the factory.
  const llm = tryCreateLLM(provider, { model: resolvedModel, reasoningSummary: true }, process.env)
  if (!llm) {
    throw new Error(
      `terminal brain-mode: no API key for provider "${provider}". ` +
        "Set OPENAI_API_KEY or ANTHROPIC_API_KEY (forwarded into the container by the harbor adapter).",
    )
  }
  return llm
}

if (import.meta.main) {
  void runMain()
}
/* c8 ignore stop */
