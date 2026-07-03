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
import { SELF_TEST_DISCIPLINE, TERMINAL_OPERATOR_GUIDE, type Tool, ToolRegistry } from "@/tool"
import type { JsonLineDuplex } from "@/tool/container-exec"
import type { PtySessionPort } from "@/tool/pty"
import { gateOn } from "@/shared/env-flag"
import { terminalSurfaceOverDuplex } from "./index"
import {
  comparedToReference,
  deriveVerificationState,
  inspectExerciseEvidence,
  inspectSelfTest,
  outputContractVerdict,
  type SelfTestReceipt,
  type VerificationStamp,
} from "./verify-gate"

const TERMINAL_BRAIN_SESSION_ID = "terminal-brain-session"

/** Lever #2 knob (RFC `jul-2-terminal-bench-levers/02`): the verify-before-finalize gate.
 *  DEFAULT-OFF ⇒ byte-identical today (no `verification` field, no extra turn). When ON, the brain
 *  inspects the trajectory for an end-to-end exercise of the deliverable and, if none is found,
 *  injects EXACTLY ONE bounded follow-up turn, then stamps an honest verification trichotomy. */
export const TB_VERIFY_GATE_ENV = "QUANTA_TB_VERIFY_GATE"

/** OC1 (RFC 07) — output-contract sub-lever. When ON (and the verify-gate is ON), the single bounded
 *  RUN nudge ({@link VERIFY_GATE_FOLLOWUP}) ALSO fires when an exercised deliverable ran to a DIRTY
 *  exit (crashed), not only when it was never exercised at all (catches sam-cell-seg exit 2). Default-OFF
 *  ⇒ the gate only fires on never-exercised. Separate knob so its effect is measured in isolation (A/B). */
export const TB_OUTPUT_CONTRACT_ENV = "QUANTA_TB_OUTPUT_CONTRACT"

/** S1 self-test discipline (RFC jul-3). When ON, appends {@link SELF_TEST_DISCIPLINE} to the instruction
 *  turn — steering the agent to build a spec-derived, range-covering executable self-test and iterate the
 *  deliverable to green (targets the measured synthesis-convergence bottleneck: polyglot/sam consistent
 *  0/3). Default-OFF ⇒ the instruction turn is byte-identical. Efficacy is measure-first (box A/B). */
export const TB_SELF_TEST_ENV = "QUANTA_TB_SELF_TEST"

/** Cassette knob (RFC 07). Trajectory recording is ON by DEFAULT — set `QUANTA_TB_TRAJECTORY=0`
 *  (or `false`/`off`) to suppress it. Default-on because the jul-3 regression could not be RCA'd
 *  without a record of what the agent actually did. */
export const TB_TRAJECTORY_ENV = "QUANTA_TB_TRAJECTORY"

/** Resolve whether to record the trajectory. Default TRUE; only an explicit `0`/`false`/`off` disables. */
export const resolveTrajectoryOn = (env: Record<string, string | undefined>): boolean => {
  const raw = (env[TB_TRAJECTORY_ENV] ?? "").trim().toLowerCase()
  return raw !== "0" && raw !== "false" && raw !== "off"
}

/** Max trajectory steps recorded (bound the report size); the last N are kept (the tail is where a
 *  finalize/regression happens). Preview per step is truncated to keep the JSON readable. */
const TRAJECTORY_MAX_STEPS = 200
const TRAJECTORY_PREVIEW_MAX = 240

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

/** B2 knob (RFC jul-3): the `container_write_file` tool. DEFAULT-OFF ⇒ byte-identical tool menu
 *  (`container_exec` + `pty_*` only). When ON, the surface additionally mints exact-byte file
 *  authoring over the SAME container transport (base64-inert content + fresh-readback verify) —
 *  the heredoc-mangle escape hatch for file-is-the-deliverable tasks (polyglot / code-from-image
 *  class). Measure-first: flips on only for A/B arms until the smoke battery proves it. */
export const TB_WRITE_TOOL_ENV = "QUANTA_TB_WRITE_TOOL"

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

/** The single bounded follow-up nudge (S4, RFC jul-3). Fired AT MOST ONCE, only when the run NEVER
 *  ran the produced deliverable end-to-end (`!exercised`). It is RUN-ONLY: it asks the model to run
 *  and OBSERVE its own deliverable — it does NOT tell it to "diff against a reference" (the old blunt
 *  compare push reworked already-refined solutions and was gamed by a shallow one-value compare;
 *  substantive verification is the S1 self-test's job, not this nudge). No-leak by construction:
 *  contains none of {test, verifier, grader, hidden, answer key}. */
export const VERIFY_GATE_FOLLOWUP =
  "Before finalizing: you have NOT run your produced deliverable end-to-end. Run it EXACTLY as the " +
  "task says it will be invoked, and OBSERVE that it completes and produces the outputs the task asks " +
  "for. This is a CHECK — run and observe your own deliverable; do not consult any concealed " +
  "evaluation materials, and do not rework a solution that already runs and produces its outputs."

// NOTE (S4, RFC jul-3): the old OUTPUT_CONTRACT_FOLLOWUP was RETIRED. It forced a "DIFF your output
// against that reference" step — the exact compare-forcing language that regressed path-tracing
// (reworked a working deliverable) and was gamed by polyglot (shallow fib(0) self-compare). Under S4
// BOTH trigger cases (never-exercised AND OC1 dirty-exit) fire the single RUN-only {@link
// VERIFY_GATE_FOLLOWUP}. Substantive comparison moves to S1's spec-derived self-test loop, not a nudge.

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
  /** S1b (`QUANTA_TB_SELF_TEST`): OBSERVE-ONLY self-test receipt. PRESENT ONLY when the self-test
   *  discipline was applied (knob ON) — absent ⇒ byte-identical. Records whether the agent ran an
   *  authored self-test and whether it went green; NEVER gates. The top-line S1 metric (self-test↔
   *  hidden alignment) is computed by pairing `green` with the harbor reward off-line. */
  readonly selfTest?: SelfTestReceipt
  /** Lever #1 (`QUANTA_TB_ENV_OWNED`): stamped `"owned"` ONLY when the owned posture was applied
   *  (knob ON) — absent ⇒ byte-identical to the pre-lever report. Lets per-task A/B analysis confirm
   *  the owned prompt actually rendered for this task (guards against a silent env-plumbing miss). */
  readonly envPosture?: "owned"
  /** Lever #3 (`QUANTA_TB_BEST_OF_N`): PRESENT ONLY when best-of-N ran (N≥2, set by the
   *  `best-of-n-runner` wrapper) — absent ⇒ byte-identical single-run report. Records how many
   *  attempts ran, which won, and the FAIR (no-hidden-test) selection rationale, for A/B attribution.
   *  The single `runTerminalBrain` core never sets this; only the outer wrapper does. */
  readonly bestOfN?: {
    /** attempts ACTUALLY run (adaptive early-stop may be < cap). */
    readonly attempts: number
    /** the ceiling requested via `QUANTA_TB_BEST_OF_N` (cost analysis). */
    readonly cap?: number
    readonly winnerIndex: number
    readonly rationale: string
  }
  /** Cassette (RFC 07): a COMPACT, ordered trajectory of the run — every tool_call command paired
   *  with its result (ok / exit code / truncated stdout) plus assistant text turns. Present by DEFAULT
   *  (the pain of jul-3: a regression could not be RCA'd because nothing recorded WHAT the agent did);
   *  suppressed only by `QUANTA_TB_TRAJECTORY=0`. Bounded (event cap + preview truncation) so it never
   *  bloats the report. No-leak: it records only the model's own actions, never a hidden test. */
  readonly trajectory?: readonly TrajectoryStep[]
}

/** One compact trajectory step (a tool call + its observed result, OR an assistant text turn). */
export interface TrajectoryStep {
  readonly kind: "exec" | "pty" | "text" | "tool"
  /** The command run (exec/pty) or a short label (tool); omitted for pure text. */
  readonly cmd?: string
  /** Result observation for a tool step: ok flag + exit code + truncated stdout preview. */
  readonly ok?: boolean
  readonly exitCode?: number
  readonly preview?: string
  /** Assistant text (truncated) for a text step. */
  readonly text?: string
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

/** Compact the captured event stream into a bounded, readable {@link TrajectoryStep}[] for the
 *  report cassette (RFC 07). Pairs each tool_call with its tool_result; keeps assistant text turns.
 *  Truncates previews and caps the step count (keeps the TAIL — where finalize/regression happens).
 *  PURE + no-leak: reads only the model's own calls/results/text. */
export const compactTrajectory = (events: readonly AgentEvent[]): TrajectoryStep[] => {
  const trunc = (s: string | undefined): string | undefined =>
    s === undefined || s === "" ? undefined : s.slice(0, TRAJECTORY_PREVIEW_MAX)
  const resultById = new Map<string, Extract<AgentEvent, { type: "tool_result" }>>()
  for (const ev of events) if (ev.type === "tool_result") resultById.set(ev.id, ev)
  const steps: TrajectoryStep[] = []
  // P1-E (RFC jul-3): coalesce consecutive assistant_text deltas (the model's reasoning/claims
  // BETWEEN tool calls) into one ordered `kind:"text"` step. Without this the cassette recorded only
  // commands — losing the intermediate "I verified it works" claims that fake-green RCA needs.
  let textBuf = ""
  const flushText = (): void => {
    const t = trunc(textBuf)
    if (t !== undefined) steps.push({ kind: "text", text: t })
    textBuf = ""
  }
  for (const ev of events) {
    if (ev.type === "assistant_text") {
      textBuf += ev.delta
      continue
    }
    if (ev.type === "tool_call") {
      flushText() // the text preceding this call is its own step, in order
      const res = resultById.get(ev.id)
      const obs =
        res !== undefined
          ? {
              ok: res.ok,
              ...(res.exitCode !== undefined ? { exitCode: res.exitCode } : {}),
              ...(trunc(res.preview) !== undefined ? { preview: trunc(res.preview) } : {}),
            }
          : {}
      if (ev.name === "container_exec") {
        const c = ((ev.input as { command?: unknown } | null)?.command ?? "") as string
        steps.push({ kind: "exec", cmd: trunc(c) ?? "", ...obs })
      } else if (ev.name.startsWith("pty_")) {
        const c = ((ev.input as { data?: unknown; command?: unknown } | null)?.data ??
          (ev.input as { command?: unknown } | null)?.command ??
          "") as string
        steps.push({ kind: "pty", cmd: trunc(String(c)) ?? "", ...obs })
      } else {
        steps.push({ kind: "tool", cmd: ev.name, ...obs })
      }
    }
  }
  flushText() // trailing reasoning after the last tool call (often the final "verified green" claim)
  return steps.length > TRAJECTORY_MAX_STEPS ? steps.slice(-TRAJECTORY_MAX_STEPS) : steps
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
  // INERT here: `idleMs` is only ever consulted by the interactive REPL path (repl.ts, gated on
  // `idleSuppressOn`), which the brain NEVER runs — so this value has no effect. Kept as a required
  // shape field with an explicit 0 (was a misleading `60_000` const whose comment claimed a live
  // "no inbound frame" bound that nothing enforces — P0-B). The real per-command bound is the
  // opt-in `timeoutMs` on the exec path; the task-level bound is harbor's AgentTimeout.
  idleMs: 0,
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
/** Lever #2 — verify-gate v2 (compare-to-reference; STRUCTURAL/SELECTIVE/BOUNDED/HONEST,
 *  RFC jul-2 §03). The harness (not a prompt line) inspects the recorded trajectory for an
 *  OBSERVED L1 COMPARISON — the deliverable's output diffed/checked against a distinct,
 *  non-test reference ({@link comparedToReference}). v1 fired on missing L0 (ran-or-not) and
 *  rubber-stamped a bare run as `verified-pass`; v2 fires on missing L1 (compared-or-not) and
 *  `verified-pass` is UNREACHABLE without an observed comparison. When L1 is absent AND the run
 *  has turn budget left, it fires the ONE §"Follow-up prompt" nudge (K=0 surface-only, at most
 *  once — no loop, so the ~3× over-persist that got the prior blanket steer reverted is
 *  structurally impossible), then re-inspects and stamps a verified-pass/fail/unverifiable
 *  trichotomy. `followUpFired` rides the stamp for A/B attribution. Extracted from
 *  `runTerminalBrain` to keep it under the god-FUNCTION cap.
 *
 *  TODO(R8, open risk): a BOUNDED ≤K recovery loop (K=2-3, hard counter) so the agent can ACT on
 *  a surfaced mismatch (diff→fix→re-diff), not just report it. Ships as a SEPARATE A/B arm with a
 *  hard-ceiling turn-budget watchdog — NOT here (K=0 surface-only first; the recovery loop
 *  re-introduces R2's over-persist and must be measured, never enabled by default). */
/** PURE follow-up decision (S4, RFC jul-3). Fires the RUN nudge ONLY on the unambiguous cases where the
 *  deliverable did not run to a clean end: `!exercised` (never ran it at all — extract-elf/sam fake-green)
 *  OR `outputContractOn && !ranClean` (ran but crashed — sam exit 2). It DELIBERATELY no longer fires on
 *  `!compared`: the box A/B + cassette RCA showed that blunt "go compare" nudge REGRESSES iterative tasks
 *  (path-tracing EXERCISED its tracer but our narrow L1 misses the image compare → false-positive rework
 *  that broke the refined image.c, 2/3→1/3) and is GAMED (polyglot self-compared fib(0) only). Substantive
 *  verification moves to S1's spec-derived self-test loop; this nudge only ensures the deliverable RAN.
 *  Never fires past the turn budget (no over-persist). */
export const decideGateFollowup = (args: {
  exercised: boolean
  ranClean: boolean
  outputContractOn: boolean
  budgetLeft: boolean
}): { fire: boolean; nudge: "run" | "none" } => {
  const notExercised = !args.exercised // extract-elf / sam: never ran the produced deliverable
  const crashed = args.outputContractOn && !args.ranClean // OC1: ran but no clean exit (sam exit 2)
  if (!args.budgetLeft || !(notExercised || crashed)) return { fire: false, nudge: "none" }
  return { fire: true, nudge: "run" }
}

const runVerifyBeforeFinalizeGate = async (args: {
  session: Parameters<typeof runSessionTurn>[0]["session"]
  stream: CapturingStream
  turnSignal: AbortSignal
  maxTurns: number
  outcomeTurns: number
  messages: readonly Message[]
  /** OC1 (RFC 07): when true, the RUN nudge ALSO fires on an exercised-but-dirty-exit run (crash).
   *  Default false ⇒ the nudge fires only on a never-exercised deliverable. */
  outputContractOn: boolean
}): Promise<{
  outcomeTurns: number
  messages: readonly Message[]
  verification: VerificationStamp
}> => {
  let outcomeTurns = args.outcomeTurns
  let messages = args.messages
  let followUpFired = false
  // S4 (RFC jul-3): the nudge fires on !EXERCISED (never ran the deliverable), NOT !compared.
  const preExercise = inspectExerciseEvidence(args.stream.events)
  // OC1: the output contract is unmet when the deliverable never ran end-to-end to a clean exit.
  const preContract = args.outputContractOn
    ? outputContractVerdict(args.stream.events)
    : { ranClean: true }
  const decision = decideGateFollowup({
    exercised: preExercise.exercised,
    ranClean: preContract.ranClean,
    outputContractOn: args.outputContractOn,
    budgetLeft: outcomeTurns < args.maxTurns,
  })
  if (decision.fire) {
    const followUp = await runSessionTurn({
      session: args.session,
      resolveApproval: async () => "approve",
      // RUN-only nudge (S4): run+observe the deliverable — no "compare to reference" (rework/gaming).
      text: VERIFY_GATE_FOLLOWUP,
      turnSignal: args.turnSignal,
      env: {},
    })
    // ACCUMULATE, don't overwrite: `AgentOutcome.turns` is PER-runAgent-CALL (the loop counter
    // resets to 1 each call — turn-loop.ts), so the follow-up's count must ADD to the main run's.
    // The overwrite bug made an M0 report say `turns:2` after a 20-turn main run (jul-3 audit R2),
    // poisoning per-task A/B turn analysis.
    outcomeTurns += followUp.outcome.turns
    messages = followUp.messages
    followUpFired = true
  }
  // Re-inspect AFTER the (single) follow-up. `verified-pass` requires an observed L1 comparison;
  // the L0 exercise verdict only colors the evidence line (ran-but-unchecked vs nothing-ran).
  const verification = {
    ...deriveVerificationState(
      comparedToReference(args.stream.events),
      finalAssistantText(messages),
      inspectExerciseEvidence(args.stream.events),
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
    // S1b (`QUANTA_TB_SELF_TEST`): the OBSERVE-ONLY self-test receipt rides with the lever it measures
    // — present only when the discipline was applied ⇒ byte-identical when the knob is OFF.
    ...(gateOn(opts.env ?? {}, TB_SELF_TEST_ENV)
      ? { selfTest: inspectSelfTest(stream.events) }
      : {}),
    ...(state.envOwnedApplied ? { envPosture: "owned" as const } : {}),
    // Cassette (RFC 07): record the compact trajectory by DEFAULT so a run is always RCA-able;
    // `QUANTA_TB_TRAJECTORY=0` opts out (then the field is absent ⇒ byte-identical to pre-cassette).
    ...(resolveTrajectoryOn(opts.env ?? {})
      ? { trajectory: compactTrajectory(stream.events) }
      : {}),
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
  // B2 (`QUANTA_TB_WRITE_TOOL`, default-OFF): gate read HERE (the env-threaded entry) so the
  // surface builder stays env-free; ON additionally mints `container_write_file` over the same
  // bridge instance.
  const surface = terminalSurfaceOverDuplex(duplex, opts.ptySession, {
    writeFile: gateOn(opts.env ?? {}, TB_WRITE_TOOL_ENV),
  })
  const stream = new CapturingStream()
  const deps = buildTerminalBootstrapDeps(opts.llm, stream, surface.tools)
  const runtime = buildTerminalRuntime(opts)

  // The operator capability guide rides as a leading block on the instruction turn so the model
  // sees its terminal-surface operating habits before the task. (The surface fence forbids reaching
  // a sibling host hook to splice it into the static system prompt; threading it onto the first user
  // turn is a real, observable injection and keeps this slice self-contained.)
  // S1 (`QUANTA_TB_SELF_TEST`, default-OFF): append the spec-derived self-test discipline between the
  // guide and the task. Default-OFF ⇒ the block is absent ⇒ turnText byte-identical to today.
  const selfTestOn = gateOn(opts.env ?? {}, TB_SELF_TEST_ENV)
  const guideBlock = selfTestOn
    ? `${surface.operatorGuide}\n\n${SELF_TEST_DISCIPLINE}`
    : surface.operatorGuide
  const turnText = `${guideBlock}\n\n# Task\n${opts.instruction}`

  const verifyGateOn = gateOn(opts.env ?? {}, TB_VERIFY_GATE_ENV)
  const outputContractOn = gateOn(opts.env ?? {}, TB_OUTPUT_CONTRACT_ENV)
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
      // The terminal brain owns NO persistent memory store (memoryConfig/store undefined) — it is a
      // single-task box run. `assembleMemoryAuto` DEFAULTS ON (QUANTA_MEMORY_AUTO absent ⇒ true), so an
      // empty env silently wired a session-start phase-2 consolidation LLM CALL: a wasted per-task LLM
      // round-trip in prod AND (jul-3 RED-8) it stole the first scripted turn from every fake-LLM fence
      // test (the consolidator's call landed as `seen[0]`, shifting the container_exec tool-call script).
      // Explicitly OFF: this surface has nothing to consolidate.
      memoryAuto: { env: { QUANTA_MEMORY_AUTO: "0" }, homeDir: "/tmp" },
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
          outputContractOn,
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
  // Lever #3 (`QUANTA_TB_BEST_OF_N`) is NOT run in-process here (structural RCA jul-2): the brain drives
  // ONE harbor `serve` connection (a single-use stdin duplex + a SINGLE container). Re-running the loop
  // N times in-process reuses that exhausted duplex (attempt ≥2 hangs waiting for exec results) AND
  // shares one container (attempts aren't independent). best-of-N is therefore a TRIAL-LEVEL concern —
  // the supervisor runs the task as N fresh harbor trials (fresh container + duplex each) and fair-
  // selects across their reports via the pure `best-of-n#selectBestCandidate`. The brain stays a single
  // clean run. (The `best-of-n.ts` selector + `resolveBestOfN` remain, consumed by the supervisor.)
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
