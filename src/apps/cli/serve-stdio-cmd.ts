/**
 * `apps/cli/serve-stdio-cmd.ts` — the `quanta serve --stdio` composition root
 * (jul-16 transport-unified SDK, ticket 02).
 *
 * Makes quanta a session.v1 SERVER an IDE / sidecar drives over the child's
 * stdin/stdout (the Codex app-server shape). It is the production consumer of
 * ticket 01's stdio transport stack: the client speaks `connect()` +
 * `transports.stdio(...)` from `@/sdk`, this process answers.
 *
 * POSTURE
 *   - MATURITY GATE (not a security story — stdio is a parent-child trust
 *     boundary): `QUANTA_SERVE_STDIO === "1"` (STRICT direct-env check — NOT a
 *     CLI_FEATURE_GATES array entry, whose absent-⇒"1" seed would default-ON
 *     this half-built surface). Off ⇒ exit 64, guidance on stderr, stdout NEVER
 *     touched (the protocol channel stays byte-empty so a mis-gated child fails
 *     the client's handshake FAST + TYPED rather than hanging).
 *   - PROTOCOL CHANNEL: stdout carries ONLY session.v1 frames. The repo logger
 *     is already stderr-only; the risk the stdout-purity ratchet guards is a
 *     child tool/MCP process inheriting stdout — the default tools spawn with
 *     piped (not inherited) child stdio, so their bytes never reach ours.
 *   - WIRING: `createSessionStdioTransport({reader: stdin, writer: stdout})` is
 *     injected through `openHeadlessRuntimeSession`'s `input.transport` slot
 *     (the SAME attach seam the headless smoke uses — the bridge does the
 *     `attachSessionTransport`). We supply REAL deps: a real LLM (env-resolved,
 *     replay-honoring) + the default tool set. `sessionTransport: "stdio"`
 *     stamps `capabilities.transport` (GAP-3 seam).
 *   - LIFECYCLE: stdin EOF (parent closed the pipe) or SIGTERM ⇒ graceful
 *     `session.close()` (releases the JsonlSessionEventLog lock + reaps child
 *     PTYs) ⇒ exit 0. Never a signal death.
 *
 * NO-THROW at the boundary: {@link runServeStdioCmd} returns a numeric exit code
 * and never rejects (mirrors `mcp-server-setup.ts`).
 */

import type { SessionBootstrapDeps, SessionRuntimeConfigShape } from "@/host/bootstrap"
import { resolveGatedObjectiveAuthority } from "@/host/runtime/objective-store-wire"
import { createSessionStdioTransport } from "@/ipc/session"
import type { ImageBlock, LLMPort, Message } from "@/llm"
import { type BootSelection, resolveBootSelection, tryCreateLLM } from "@/llm"
import {
  type ActionAssessment,
  type ApprovalDecision,
  isPermissionMode,
  type PermissionMode,
} from "@/permission"
import { buildSessionAuthorities } from "@/runner/assemble/session-authorities"
import type { ResolveResumeInput, ResumeResolution } from "@/runner/orchestrate/resume-fsm"
import { errMessage, gateOnStrict } from "@/shared"
import type { StreamPort } from "@/stream"
import { buildDefaultTools, ToolRegistry } from "@/tool"

/** EX_USAGE — gate-off / argument / assembly fault (BSD sysexits). */
const EXIT_USAGE = 64
const EXIT_OK = 0

const SERVE_STDIO_SESSION_ID = "serve-stdio-session"

/** Minimal IO seam — injected so a future unit drives the command without
 *  touching real process streams. Production binds the real process streams. */
export interface ServeStdioCmdIo {
  /** The session.v1 protocol channel (newline-framed frames only). */
  readonly writer: { write(chunk: string): unknown }
  /** Inbound frames from the parent (data-only; EOF is wired separately). The
   *  `off` detach is the transport's teardown path. */
  readonly reader: {
    on(event: "data", handler: (chunk: Buffer | string) => void): unknown
    off(event: "data", handler: (chunk: Buffer | string) => void): unknown
  }
  /** Diagnostics channel. */
  readonly err: (s: string) => void
  /** Register an EOF / lifecycle listener (stdin `end`/`close`, process signals). */
  readonly onShutdown: (handler: () => void) => void
  /** Release any buffered early inbound frames to the now-subscribed transport
   *  bridge. Called ONCE after the session is attached. Absent (injected test
   *  IO) ⇒ no-op. */
  readonly flushInbound?: () => void
}

/** An early-buffering `StdioReader` over `process.stdin`.
 *
 * WHY: the parent (the SDK spawn transport) may write the very first `connect`
 * frame the instant the child is spawned — BEFORE the child has finished
 * booting + attaching the session transport (LLM build + bootstrap take real
 * time). If the transport's `on("data")` listener is not yet attached when that
 * chunk arrives, the byte is lost and the client's handshake hangs forever.
 *
 * This shim attaches to `process.stdin` at the EARLIEST point (command entry,
 * before any await) and buffers every chunk. When the session transport later
 * subscribes via `on("data")`, the shim REPLAYS the buffered chunks in order and
 * then forwards live ones — so no early frame is ever dropped. `off` detaches
 * the downstream handler (the transport's own teardown path). */
interface EarlyBufferingReader {
  readonly reader: {
    on(event: "data", handler: (chunk: Buffer | string) => void): unknown
    off(event: "data", handler: (chunk: Buffer | string) => void): unknown
  }
  /** Replay every buffered chunk to the subscribed handler, then forward live
   *  ones. Called ONCE, AFTER the bridge has subscribed to the transport — the
   *  transport subscribes to THIS reader at construction, but the bridge's own
   *  frame handler is only attached later (during `attachSessionTransport`), so
   *  an immediate replay would dispatch to zero handlers and drop the frame. */
  flush(): void
}

const createEarlyBufferingStdinReader = (): EarlyBufferingReader => {
  const buffered: Array<Buffer | string> = []
  let downstream: ((chunk: Buffer | string) => void) | undefined
  let flushed = false
  // Attach IMMEDIATELY (synchronously) so no byte written before the transport
  // subscribes is lost. Adding a `data` listener also switches stdin to flowing
  // mode, so buffered kernel bytes drain here rather than into the void. Live
  // chunks are forwarded straight through ONCE flushed; before that they queue.
  process.stdin.on("data", (chunk: Buffer | string) => {
    if (flushed && downstream !== undefined) downstream(chunk)
    else buffered.push(chunk)
  })
  return {
    reader: {
      on(_event, handler) {
        // Register only — do NOT replay here. The transport calls this at its
        // OWN construction, before the bridge frame handler exists downstream.
        downstream = handler
      },
      off(_event, handler) {
        if (downstream === handler) downstream = undefined
      },
    },
    flush() {
      if (flushed) return
      flushed = true
      if (downstream === undefined) return
      for (const chunk of buffered.splice(0)) downstream(chunk)
    },
  }
}

/** Default IO bound to the real process. stdin is the reader (data-only frames);
 *  stdout is the pure protocol writer; stderr is diagnostics; EOF + SIGTERM are
 *  the two graceful-shutdown triggers. */
const defaultIo = (): ServeStdioCmdIo => {
  // The early-buffering reader is created HERE (defaultIo is called at command
  // entry, before any await) so it captures the parent's first frame even if it
  // lands before the session transport attaches. `flush` is deferred until the
  // bridge subscribes (see serveOverStdio).
  const buffering = createEarlyBufferingStdinReader()
  return {
    writer: process.stdout,
    reader: buffering.reader,
    flushInbound: () => buffering.flush(),
    err: (s) => {
      process.stderr.write(s)
    },
    onShutdown: (handler) => {
      // stdin EOF: the parent closed our input pipe (the app-server shutdown
      // signal). `end` fires on clean EOF; `close` is the belt-and-braces reap.
      process.stdin.on("end", handler)
      process.stdin.on("close", handler)
      // Ensure the stream is flowing so `end` actually fires (a paused stdin never
      // emits EOF). The transport's own `data` listener also resumes it, but a
      // gate-idle server with no frames yet must still hear the parent's hangup.
      process.stdin.resume()
      process.on("SIGTERM", handler)
      process.on("SIGINT", handler)
    },
  }
}

/** Usage text. Pure data — no I/O, no assembly. */
export const serveStdioUsage = (): string =>
  `quanta serve --stdio — speak session.v1 over stdin/stdout (ticket 02)

USAGE
  QUANTA_SERVE_STDIO=1 quanta serve --stdio [--cwd <dir>] [--model <slug>] [--permission-mode <mode>]

DESCRIPTION
  Runs quanta as a single-session session.v1 SERVER an IDE / sidecar drives over
  the child's stdin/stdout (the Codex app-server shape). Attach with the SDK:
  \`connect({ transport: transports.stdio({ command: [...] }) })\`.

GATE
  QUANTA_SERVE_STDIO=1        REQUIRED (strict === '1'). A MATURITY gate (this is
                             a parent-child channel, not a network attack
                             surface): unset ⇒ this command exits 64 and serves
                             NOTHING (stdout stays byte-empty; the client's
                             connect fails fast + typed).

OPTIONS
  --cwd <dir>                Working directory the session operates from.
  --model <slug>             Model slug (default: the env-resolved default).
  --permission-mode <mode>   default | acceptEdits | bypass | auto.
                             Unattended callers want bypass/acceptEdits; an
                             onApproval client wants default (HITL).

APPROVALS
  This surface always delegates approval prompts to the wire client. Its
  explicit wire-delivery contract takes precedence over an inherited
  QUANTA_INLINE_APPROVAL_RESOLVER=1, so onApproval cannot be silently bypassed.

CHANNELS
  • stdout is PURE session.v1 (never written to directly).
  • stderr carries diagnostics.

  --help, -h                 Print this help and exit.
`

/** Parsed serve flags. `--stdio` is required (the only serve transport in v1). */
interface ServeStdioArgs {
  readonly cwd: string
  readonly model: string | undefined
  readonly permissionMode: PermissionMode
}

/**
 * MR-01 — the served session's BOOT provider + model, through the ONE authority.
 *
 * INTENDED BEHAVIOUR CHANGE: `--model` was previously an ABSOLUTE pin and
 * `QUANTA_MODEL` was ignored on this surface. It is now the documented middle
 * rung — `--model` > `QUANTA_MODEL` > canonical `DEFAULT_MODEL[provider]` —
 * matching the REPL, headless, web and bench roots. `--model` still wins over
 * the env, so no existing `serve --stdio --model <id>` invocation changes.
 *
 * Exported so the MR-01 producer hellgate drives the REAL line (`serveOverStdio`
 * calls exactly this; no other boot-model resolution exists on this surface).
 */
export const resolveServeStdioBoot = (
  env: Record<string, string | undefined>,
  args: { readonly model: string | undefined },
): BootSelection =>
  resolveBootSelection({
    env,
    ...(args.model !== undefined ? { modelArg: args.model } : {}),
  })

/** Read a `--flag <value>` pair from argv. Returns undefined when absent. */
const flagValue = (argv: readonly string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

/** Parse the serve flags. An invalid `--permission-mode` is a usage fault
 *  (returns undefined) so the boundary exits 64 rather than silently defaulting
 *  a dangerous posture. */
const parseServeStdioArgs = (argv: readonly string[]): ServeStdioArgs | undefined => {
  const rawMode = flagValue(argv, "--permission-mode")
  if (rawMode !== undefined && !isPermissionMode(rawMode)) return undefined
  return {
    cwd: flagValue(argv, "--cwd") ?? process.cwd(),
    model: flagValue(argv, "--model"),
    // Default posture: `default` (HITL-capable). An onApproval client resolves
    // asks; an unattended one passes --permission-mode bypass/acceptEdits.
    permissionMode: (rawMode as PermissionMode | undefined) ?? "default",
  }
}

/** Build the REAL {@link SessionBootstrapDeps} for a served session: the
 *  env-resolved LLM (replay-honoring — the factory reads QUANTA_LLM_REPLAY) and
 *  the DEFAULT tool set. Mirrors the terminal brain's offline-deps shape (the
 *  headless fence forbids importing `@/apps/headless` fake-deps across surfaces,
 *  and those are fake anyway); every dep quanta's loop needs that this surface
 *  does not own (memory / subagents / reviewer / MCP / images) is a leanest
 *  valid stub. */
export const buildServeStdioDeps = (llm: LLMPort, stream: StreamPort): SessionBootstrapDeps => {
  const registry = new ToolRegistry([...buildDefaultTools()])
  return {
    // RFC-04 D4 — one session `ActivityStore` from the authority builder (DI; no
    // command-local `createActivityStore()`). A served session has no subagent
    // fleet, so `tasks` is omitted (attention arms stay absent).
    buildLifecycleBundle: () => ({
      pills: { update: () => undefined },
      taskRegistry: undefined,
      followUpQueue: undefined,
      activityStore: buildSessionAuthorities({ env: process.env }).activity,
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
      sessionId: SERVE_STDIO_SESSION_ID,
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
      sessionId: SERVE_STDIO_SESSION_ID,
      history: [] as Message[],
      idMeta: undefined,
      inIdMode: false,
      conflictError: undefined,
      missingIdError: undefined,
    }),
    composeShellEvent: () => undefined,
    switchToSessionCwd: (cwd) => cwd,
    materializeReviewerAgent: () => undefined,
    createSubagentBackedGuardianReview: () => async (): Promise<ApprovalDecision> => ({
      reviewer: "guardian_subagent",
      outcome: "guardian_denied",
      riskLevel: "high",
      rationale: "guardian not available on stdio surface",
      decidedAt: Date.now(),
    }),
    createSubagentBackedGuardianAssess: () => async (): Promise<ActionAssessment> => ({
      kind: "deny",
      rationale: "guardian not available on stdio surface",
      denyReason: {
        verdict: "deny",
        layer: "reviewer",
        safeReason: "guardian not available on stdio surface",
      },
    }),
    buildMcpSurfaceInfo: () => undefined,
    buildIdleGuards: () => ({
      idleMonitor: { markActive: () => undefined },
      rejectCounter: {
        recordAccept: () => undefined,
        recordDeny: () => 0,
        shouldAutoExit: () => false,
      },
    }),
  }
}

/** Build the {@link SessionRuntimeConfigShape} for the served session. No TTY
 *  (stdout is the protocol channel — the banner/ready logs are stderr-TTY-gated
 *  and stay off), no idle monitor. `provider` is a config-label; the injected
 *  LLM owns behavior. */
export const buildServeStdioRuntime = (
  args: ServeStdioArgs,
  provider: SessionRuntimeConfigShape["provider"],
  model: string,
): SessionRuntimeConfigShape => ({
  provider,
  model,
  mode: args.permissionMode,
  maxTurns: 30,
  cwd: args.cwd,
  env: process.env,
  homeDir: process.env.HOME ?? "/tmp",
  stdinIsTTY: false,
  stdoutIsTTY: false,
  stderrIsTTY: false,
  newSession: true,
  title: undefined,
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

/**
 * Run `quanta serve --stdio`. NO-THROW: returns a numeric exit code, never
 * rejects. `argv` is `process.argv.slice(3)` (everything after `quanta serve`).
 *
 * Order (deliberate for the maturity posture):
 *   1. `--help` returns BEFORE the gate (no assembly).
 *   2. The STRICT gate is checked BEFORE any assembly — gate-off does ZERO work
 *      (no LLM, no FS), so stdout stays byte-empty.
 *   3. `--stdio` presence is validated (v1 has no other serve transport).
 *   4. Only then do we build real deps, open the runtime session with the stdio
 *      transport injected, and block until stdin EOF / SIGTERM.
 */
export const runServeStdioCmd = async (
  argv: readonly string[],
  injectedIo?: ServeStdioCmdIo,
): Promise<number> => {
  const io = injectedIo ?? defaultIo()

  // 1. Help short-circuits before the gate + assembly.
  if (argv.includes("--help") || argv.includes("-h")) {
    io.err(serveStdioUsage())
    return EXIT_OK
  }

  // 2. STRICT maturity gate. Direct env read (NOT CLI_FEATURE_GATES — the
  //    absent-⇒"1" seed would default-ON this half-built surface). Default-OFF
  //    byte-identity: nothing assembled, stdout untouched. `gateOnStrict` is the
  //    EXACT-"1" SSOT (=== "1"), byte-identical to the old `!== "1"` while
  //    routing through the shared gate vocabulary.
  if (!gateOnStrict(process.env, "QUANTA_SERVE_STDIO")) {
    io.err(
      "quanta serve --stdio disabled (set QUANTA_SERVE_STDIO=1). This is a maturity gate for an early transport surface, not a security boundary.\n",
    )
    return EXIT_USAGE
  }

  // 3. `--stdio` is the only serve transport in v1.
  if (!argv.includes("--stdio")) {
    io.err("quanta serve: only --stdio is supported (v1). Usage: quanta serve --stdio\n")
    return EXIT_USAGE
  }

  const parsed = parseServeStdioArgs(argv)
  if (parsed === undefined) {
    io.err(
      "quanta serve --stdio: invalid --permission-mode (expected default|acceptEdits|bypass|auto)\n",
    )
    return EXIT_USAGE
  }

  // Arm lifecycle delivery BEFORE the first async assembly boundary. The
  // bridge can synchronously emit a response while `flushInbound()` runs; a
  // parent is then entitled to send SIGTERM immediately. Registering the
  // handler only after that flush left a signal-death race.
  const shutdown = new Promise<void>((resolve) => io.onShutdown(resolve))

  return await serveOverStdio(io, parsed, shutdown)
}

/** Assemble the real deps, open the runtime session with the stdio transport
 *  injected, and block until stdin EOF / SIGTERM. Split out so
 *  {@link runServeStdioCmd} owns only the help + gate + arg fast paths. */
const serveOverStdio = async (
  io: ServeStdioCmdIo,
  args: ServeStdioArgs,
  shutdown: Promise<void>,
): Promise<number> => {
  // The reusable session opener lives in `@/apps/headless` (the SECOND
  // consumer). Dynamic import keeps the heavy bootstrap off the gate-off fast
  // path above.
  const { openHeadlessRuntimeSession, RecordingStream } = await import("@/apps/headless")

  const boot = resolveServeStdioBoot(process.env, args)
  const provider = boot.provider
  const model = boot.modelId
  // `tryCreateLLM` returns null on a MISSING API key (never throws). NO-THROW
  // boundary: surface on stderr (NEVER stdout — the protocol channel) + exit 64.
  const llm = tryCreateLLM(provider, { model }, process.env)
  if (llm === null) {
    io.err(
      `quanta serve --stdio: no API key for provider '${provider}' — set the vendor key (or QUANTA_LLM_REPLAY for a scripted session)\n`,
    )
    return EXIT_USAGE
  }

  const stream = new RecordingStream()
  const deps = buildServeStdioDeps(llm, stream)
  const runtime = buildServeStdioRuntime(args, provider, model)

  // The served session is EPHEMERAL and owns no persistent memory store, so
  // disable the auto-memory consolidation lane (it would otherwise fire a
  // BACKGROUND second LLM call per session — wasted work here, and it shares the
  // session LLM). Mirrors the terminal brain's single-task box posture
  // (brain-mode.ts memoryAuto env). Only the memory-auto gate reads this key;
  // the LLM port is already built (replay/creds honored), so this is inert to
  // model selection.
  const sessionEnv: Record<string, string | undefined> = {
    ...process.env,
    QUANTA_MEMORY_AUTO: "0",
  }

  // serve-stdio objective parity — mint the ONE session-stable gated objective
  // authority for this served session and thread it onto the base (via the
  // headless `input.objective` → runtime overlay → `base.objective`). Without
  // this the served session had NO session-stable objective slot, so the model's
  // `objective_*` tools had no cross-turn store (goal amnesia). Ephemeral by
  // design: this served session owns no persistent store (QUANTA_MEMORY_AUTO=0
  // above), so a FRESH mint is correct — no durable restore. Headless / no inline
  // operator ⇒ `confirmationAvailable:false` (fail-closed under
  // QUANTA_PROPOSE_GOAL), the SAME posture the web daemon uses. Returns undefined
  // when `QUANTA_OBJECTIVE_TOOLS` is off ⇒ the slot is omitted (default-OFF,
  // byte-identical: no objective tools).
  const objective = resolveGatedObjectiveAuthority(sessionEnv, { confirmationAvailable: false })

  // The stdio transport over THIS process's stdin/stdout — stdout is the pure
  // protocol channel; the reader is data-only (EOF is wired below, not here).
  const transport = createSessionStdioTransport({ reader: io.reader, writer: io.writer })

  let bridge: Awaited<ReturnType<typeof openHeadlessRuntimeSession>> | undefined
  try {
    bridge = await openHeadlessRuntimeSession({
      input: {
        prompt: "", // The CLIENT drives turns via `input.append` + `turn.run`.
        transport,
        // GAP-3 — stamp the HONEST transport onto `capabilities.transport`.
        sessionTransport: "stdio",
        // 02 approval wire-delegation — this surface has NO inline operator; a
        // mid-turn ask is DEFERRED onto the wire (kernel `awaiting_approval` +
        // `approval.requested`) for the `connect({onApproval})` client to resolve
        // via `approval.respond` + a re-issued `turn.run`. This explicit surface
        // contract wins over an inherited inline auto-approve gate: a gated tool
        // always parks here rather than bypassing the wire operator.
        approvalDelivery: "wire",
        cwd: args.cwd,
        env: sessionEnv,
        homeDir: process.env.HOME ?? "/tmp",
        maxTurns: runtime.maxTurns,
        // serve-stdio objective parity — thread the session-stable authority
        // (undefined when QUANTA_OBJECTIVE_TOOLS off ⇒ omitted, byte-identical).
        ...(objective !== undefined ? { objective } : {}),
      },
      deps,
      runtime,
      stream,
    })
  } catch (e) {
    io.err(`quanta serve --stdio: cannot open session: ${errMessage(e)}\n`)
    // Best-effort: the transport was never attached to a live session.
    await transport.close().catch(() => undefined)
    return EXIT_USAGE
  }

  // The bridge is now subscribed to the transport — release any early inbound
  // frames the parent sent before boot completed (the buffering reader queued
  // them so the transport's zero-handler construction window never dropped one).
  io.flushInbound?.()

  io.err(`quanta serve --stdio · session ${bridge.session.sessionId} live\n`)

  // Block until stdin EOF / SIGTERM, then gracefully close (releases the
  // JsonlSessionEventLog lock + reaps any child PTYs) and exit 0.
  await shutdown

  // Graceful teardown: detach the transport bridge FIRST (stop accepting frames)
  // then close the session (host close → event-log lock release + child reap).
  await bridge.transportHandle?.close().catch(() => undefined)
  await bridge.session.close().catch(() => undefined)
  return EXIT_OK
}
