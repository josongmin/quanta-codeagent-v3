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
import { defaultConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import type { SessionBootstrapDeps, SessionRuntimeConfigShape } from "@/host/bootstrap"
import { bootstrapSession } from "@/host/bootstrap"
import type { ImageBlock, LLMPort, Message } from "@/llm"
import { defaultResponsesContinuationStore } from "@/llm/responses-continuation-store"
import type { ResolveResumeInput, ResumeResolution } from "@/runner/orchestrate/resume-fsm"
import { runSessionTurn } from "@/runner/orchestrate/session-turn-driver"
import { createRuntimeFromBootstrap } from "@/sdk/runtime"
import type { AgentEvent, StreamPort } from "@/stream"
import { type Tool, ToolRegistry } from "@/tool"
import type { JsonLineDuplex } from "@/tool/container-exec"
import type { PtySessionPort } from "@/tool/pty"
import { terminalSurfaceOverDuplex } from "./index"

const TERMINAL_BRAIN_SESSION_ID = "terminal-brain-session"

/** Report JSON the hands side reads into harbor's `AgentContext` (spec B3). Trajectory optional. */
export interface TerminalBrainReport {
  readonly instruction: string
  readonly turns: number
  readonly tokens: { readonly input: number; readonly output: number }
  readonly cost_usd: number
  readonly final: string
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
  idleMs: 60_000,
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

  let outcomeTurns = 0
  let messages: readonly Message[] = []
  let runError: unknown
  try {
    const boot = await bootstrapSession(deps, runtime, {})
    if (opts.signal) {
      if (opts.signal.aborted) boot.abort.abort()
      else opts.signal.addEventListener("abort", () => boot.abort.abort(), { once: true })
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

  // ORDER MATTERS (spec B3): write the report FIRST, THEN signal EOF on stdout — the hands-side
  // `serve` loop ends on EOF and immediately reads the report file, so EOF before the write would
  // race a missing/stale report.
  const tokens = totalTokens(stream.events)
  const report: TerminalBrainReport = {
    instruction: opts.instruction,
    turns: outcomeTurns,
    tokens,
    // cost is computed host-side from a pricing table the brain surface does not own; the report
    // carries 0 here and the hands/orchestrator may enrich it. Kept explicit so the shape is fixed.
    cost_usd: 0,
    final: finalAssistantText(messages),
  }
  opts.writeReport(opts.reportOut, report)
  opts.closeStdout?.()

  if (runError !== undefined) throw runError
  return { turns: outcomeTurns, report }
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

  await runTerminalBrain({
    instruction,
    ...(model !== undefined ? { model } : {}),
    reportOut,
    stdin: stdinLines,
    // stdout is RESERVED for protocol frames; all logs go to stderr.
    stdout: { write: (line) => process.stdout.write(line) },
    llm: await buildRealLlm(model),
    writeReport: (path, obj) => writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`),
    closeStdout: () => process.stdout.end(),
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
