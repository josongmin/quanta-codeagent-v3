import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { maybeEmitPassiveVcs, type PassiveVcsHookCtx } from "@/git/passive-classify"
import { type OsSandboxProfile, runShell, type ShellOptions } from "@/runtime"
import { type BashBgRegistry, getBashBgRegistry } from "@/runtime/bash-bg-registry"
import { classifyCommandShape } from "@/security"
import { statFile } from "@/storage"
import {
  isWriteCommand,
  type MtimeObservation,
  renderStaleReminder,
  staleAfterBash,
} from "../stale-read-guard"
import type {
  HITLTier,
  SandboxViolationReason,
  Tool,
  ToolContext,
  ToolEvent,
  ToolFailure,
  ToolResultEvidence,
} from "../types"
import { resolveBashCwd } from "../worktree/cwd-override"
import { lowerSimpleHereDocForReadMode } from "./heredoc-lowering"
import { getBashPerCallSandboxFactory } from "./per-call-factory"
import { getBashSandboxEscalationHandler } from "./sandbox-escalation-wire"

const schema = z.object({
  command: z.string().describe("Shell command to run via bash -lc"),
  timeout_ms: z.number().optional().describe("Timeout in ms (default 120000)"),
  /** ADR-0295 — Cursor-pattern absorption. CLOSED 2-arm enum, OPTIONAL.
   *   - `"read"`  : wrap THIS call with an OS-enforced read-only sandbox
   *                 (Seatbelt `read-only` profile on macOS). The kernel
   *                 rejects any write/exec-of-new-binary attempt with
   *                 EACCES / "Operation not permitted"; the tool surfaces
   *                 a typed `sandbox_violation` failure. Use for audit /
   *                 accident-proof inspection. Concurrency stays serialized
   *                 (the SOTA invariant — parallel-safety is a future ADR).
   *   - `"write"` : current behavior (default). No per-call sandbox wrap.
   *  The OS is the enforcer — there is NO command-pattern heuristic.
   *
   *  `mode` is OPTIONAL on the wire (callers may omit) so the input *type*
   *  keeps the field optional — every existing call site that omits `mode`
   *  still type-checks. The default is applied INSIDE `execute()`. */
  mode: z
    .enum(["read", "write"])
    .optional()
    .describe(
      "read = per-call read-only OS sandbox wrap (Seatbelt/Landlock enforces no writes). Parallel-safe-ready (concurrency still serialized for now). write = current behavior (default).",
    ),
  /** ADR-0296 (Cursor `TimeoutBehavior.BACKGROUND` absorption). `"kill"`
   *  (default — absent ⇒ "kill") preserves the legacy behavior: SIGTERM on
   *  the deadline + typed `timeout` ToolFailure. `"background"` DETACHES the
   *  process when the deadline elapses, returning `{ shellId, status:
   *  "running", outputSoFar }` so the model can resume control of it later
   *  via `bash_await` / `bash_kill`. Optional (not `.default()`) so the
   *  schema's input and output types match — keeps the existing zod-cast
   *  pattern that other tools rely on (see `Tool<Input>` shape contract). */
  timeout_behavior: z
    .enum(["kill", "background"])
    .optional()
    .describe(
      "kill (default; absent ⇒ kill) = SIGTERM on deadline (current). " +
        "background = on deadline, detach and return { shellId } — use bash_await later.",
    ),
})

type Input = z.infer<typeof schema>

/**
 * ADR-0411 — bash no longer head-only-truncates its own output.
 *
 * The previous `MAX_OUTPUT = 30_000` head-only slice was applied INSIDE bash
 * before the registry's authoritative head+tail `capToolOutput` (default
 * 200 K via `DEFAULT_TOOL_OUTPUT_MAX`) ever saw the result. That meant:
 *   - the registry's head+tail layer had nothing left to cut (bash had
 *     already discarded the tail), so determinator-bearing tails (errors,
 *     exit summaries) were silently lost;
 *   - the truncation message format was bash-specific (`(truncated, N more
 *     chars)`), divergent from the registry's `<persisted-output>` wrapper
 *     that the rest of the toolchain emits.
 *
 * Foreground (`formatRunBody`) and bg-completed (`buildBackgroundCompletedResult`)
 * paths now return the raw stdout/stderr body verbatim. The registry caps
 * via head+tail, persisting the full payload to `.quanta/tool-output/<uuid>.txt`
 * when over budget.
 *
 * Memory note: the underlying `runShell` call already buffers stdout/stderr
 * in memory; removing the post-buffering slice is memory-neutral. The
 * background placeholder path (`buildBackgroundPlaceholderResult`) keeps its
 * TAIL-only `tailMaxOutput` cap because it samples an in-flight, unbounded
 * stream — semantically distinct from a completed buffer.
 */
const CMD_PREVIEW = 80
/** Tail-only cap for the in-flight bg PLACEHOLDER snapshot (not the
 *  completed result). Streaming child processes can grow without bound, so
 *  the placeholder samples the most-recent {@link MAX_BG_PLACEHOLDER_OUTPUT}
 *  bytes only. Completed bodies bypass this cap and delegate to the registry. */
const MAX_BG_PLACEHOLDER_OUTPUT = 30_000
/** Local stderr-tail cap on `evidence.stderr`. Dispatch re-trims to its own
 *  smaller `STDERR_TAIL_CAP` (2000) as a defense-in-depth backstop, so this
 *  cap only bounds the per-tool attachment size. */
const STDERR_CAP = 4_000
const READ_MODE_TMP_PREFIX = "quanta-bash-read-"

/**
 * ADR-0297 — sandbox-driven HITL. The previous `ALWAYS_CONFIRM_PATTERNS`
 * regex list (curl/wget/gh api/git push/send-pack/fetch/commit --amend/
 * reset --hard, hardened with a GIT_PREFIX matcher against legal git
 * global-option bypasses) inspected the command string to guess risk —
 * a textbook heuristic with both false-positive (`echo "git push"`) and
 * false-negative (`scp`, `nc`, `aws s3 cp`, …) failure modes. Deleted.
 *
 * The tier is now a closed-enum switch over the operator-chosen
 * `OsSandboxProfile`. The OS sandbox layer is the authoritative gate;
 * confirmation is layered ON TOP of it as audit ceremony, not in place
 * of it.
 *
 * | profile               | tier             | why                                                        |
 * |-----------------------|------------------|------------------------------------------------------------|
 * | `read-only`           | `pre-approval-ok`| OS itself refuses mutation — confirm is redundant          |
 * | `workspace-write`     | `pre-approval-ok`| operator already accepted cwd writes                       |
 * | `workspace-write-net` | `always-confirm` | net egress opted in, each call audited                     |
 * | `danger-full-access`  | `pre-approval-ok`| explicit release — operator owns the risk                  |
 * | `off` / undefined     | `always-confirm` | no sandbox → unknown command risk → conservative           |
 */
const tierForProfile = (profile: OsSandboxProfile | undefined): HITLTier => {
  switch (profile) {
    case "read-only":
    case "workspace-write":
    case "danger-full-access":
      return "pre-approval-ok"
    case "workspace-write-net":
      return "always-confirm"
    case "off":
    case undefined:
      return "always-confirm"
  }
}

/** ADR-0474 — post-bash stale-read reminder. After a write-class command
 *  (`bun`/`make`/`prettier`/…), re-stat the files the agent has READ this run
 *  and, for any whose mtime advanced (the command rewrote a file the agent is
 *  relying on), append a model-facing reminder listing them so the model
 *  re-reads before editing. Returns `null` (no append) when the guard is unwired
 *  (`ctx.readFileState` absent) or the command is not a write-marker. NO-THROW:
 *  a file that vanished/became unreadable mid-run is skipped, never thrown. */
const buildPostBashStaleReminder = async (
  ctx: ToolContext,
  command: string,
): Promise<string | null> => {
  const state = ctx.readFileState
  if (state === undefined || !isWriteCommand(command)) return null
  const observations: MtimeObservation[] = []
  for (const path of state.paths()) {
    try {
      const info = await statFile(path, ctx.cwd)
      observations.push({ path, currentMtimeMs: info.mtimeMs })
    } catch {
      // File deleted / unreadable since it was read — drop the baseline so it
      // cannot resurface as a phantom stale entry, and skip it here.
      state.forget(path)
    }
  }
  const stale = staleAfterBash(state, command, observations)
  return stale.length > 0 ? renderStaleReminder(stale) : null
}

/** Derive a TYPED {@link ToolFailure} from the existing `ShellResult` shape
 *  WITHOUT touching `runtime/shell.ts` (owned by another track). */
const deriveBashFailure = (
  r: { exitCode: number; timedOut: boolean; stderr: string },
  timeoutMs: number | undefined,
): ToolFailure | undefined => {
  if (r.timedOut) {
    return timeoutMs !== undefined ? { mode: "timeout", timeoutMs } : { mode: "timeout" }
  }
  if (r.exitCode === 127 && /command not found/i.test(r.stderr)) {
    return { mode: "spawn_error", error: r.stderr.trim().slice(-STDERR_CAP) || "command not found" }
  }
  if (r.exitCode === 126 && /permission denied/i.test(r.stderr)) {
    return { mode: "permission_denied" }
  }
  return undefined
}

/** ADR-0295 — classify an OS-sandbox denial from the spawn result. Only runs
 *  when the caller selected `mode="read"`. Reads the OS signal (`stderr` +
 *  non-zero exit) and maps it to a CLOSED-enum {@link SandboxViolationReason}.
 *  NEVER inspects the original `command` string — the OS is the enforcer. */
const classifySandboxStderr = (stderr: string): SandboxViolationReason | undefined => {
  if (stderr.length === 0) return undefined
  const s = stderr.toLowerCase()
  if (s.includes("exec format") || s.includes("not executable")) return "exec_denied"
  if (s.includes("network") && (s.includes("denied") || s.includes("not permitted"))) {
    return "network_denied"
  }
  if (
    s.includes("operation not permitted") ||
    s.includes("sandbox:") ||
    s.includes("permission denied")
  ) {
    return "write_denied"
  }
  return undefined
}

const deriveSandboxViolation = (
  mode: "read" | "write",
  r: { exitCode: number; timedOut: boolean; stderr: string },
): ToolFailure | undefined => {
  if (mode !== "read") return undefined
  if (r.timedOut) return undefined
  if (r.exitCode === 0) return undefined
  const reason = classifySandboxStderr(r.stderr)
  if (reason === undefined) return undefined
  return { mode: "sandbox_violation", reason }
}

/** ADR-0295 — acquire the per-call sandbox port for `mode="read"` and probe
 *  its `availability()`. Returns:
 *   - `{ port }`               when the OS can enforce — caller proceeds.
 *   - `{ unavailableResult }`  when the OS cannot enforce — caller MUST yield
 *                              this ToolResult and return (fail-closed). */
const acquirePerCallPort = (
  mode: "read" | "write",
  opts?: { readonly extraWritePaths?: ReadonlyArray<string> },
):
  | {
      readonly port: ReturnType<ReturnType<typeof getBashPerCallSandboxFactory>>
      readonly unavailableResult?: undefined
    }
  | {
      readonly port?: undefined
      readonly unavailableResult: { ok: false; output: string; failure: ToolFailure }
    }
  | { readonly port?: undefined; readonly unavailableResult?: undefined } => {
  if (mode !== "read") return {}
  const port = getBashPerCallSandboxFactory()(
    "read-only",
    opts?.extraWritePaths !== undefined ? { extraWritePaths: opts.extraWritePaths } : undefined,
  )
  const avail = port.availability()
  if (!avail.supported) {
    return {
      unavailableResult: {
        ok: false,
        output: `[sandbox unavailable]\n${avail.reason}`,
        failure: { mode: "sandbox_unavailable", reason: avail.reason },
      },
    }
  }
  return { port }
}

interface ReadModeTempScope {
  readonly path: string
  readonly localEnv: NonNullable<ShellOptions["localEnv"]>
  readonly extraWritePaths: readonly string[]
  readonly cleanup: () => void
}

const withTrailingSlash = (path: string): string => (path.endsWith("/") ? path : `${path}/`)

/** Shells implement here-docs and Python/Ruby/etc. implement tempfiles by
 *  writing under TMPDIR. A strict read-only Seatbelt profile therefore needs a
 *  narrow caller-owned scratch directory, not broad `/tmp` write access. */
const createReadModeTempScope = (
  mode: "read" | "write",
  baseLocalEnv: ShellOptions["localEnv"],
): ReadModeTempScope | undefined => {
  if (mode !== "read") return undefined
  const path = mkdtempSync(join(tmpdir(), READ_MODE_TMP_PREFIX))
  return {
    path,
    extraWritePaths: [path],
    localEnv: {
      vars: { ...(baseLocalEnv?.vars ?? {}), TMPDIR: withTrailingSlash(path) },
      pathPrepend: baseLocalEnv?.pathPrepend ?? [],
    },
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  }
}

/** A mutable holder the per-call wrap records its outcome into, so the bash
 *  result-handling site can know whether the sandbox was actually APPLIED (the
 *  load-bearing precondition for the RFC jun-6 sandbox-block classifier — a
 *  degraded/unapplied sandbox can never produce a "block"). */
interface PerCallWrapOutcome {
  sandboxApplied: boolean
}

/** ADR-0295 — adapt a {@link PerCallSandboxPort.wrap} call into the
 *  `ShellOptions.perCallWrap` shape. RFC jun-6 — also records the wrap outcome
 *  into `outcome` so the result-handling site can detect a sandbox BLOCK. */
const buildPerCallWrap =
  (
    port: ReturnType<ReturnType<typeof getBashPerCallSandboxFactory>>,
    outcome: PerCallWrapOutcome,
  ) =>
  async (argv: ReadonlyArray<string>, cwd: string) => {
    const w = await port.wrap(argv, cwd)
    // RFC jun-6 — record whether the sandbox was applied for this call (a
    // degrade ⇒ false ⇒ NEVER classified as a block).
    outcome.sandboxApplied = w.sandboxApplied
    return {
      argv: [...w.argv],
      sandboxApplied: w.sandboxApplied,
      ...(w.degradeReason !== undefined ? { degradeReason: w.degradeReason } : {}),
    }
  }

/** M4 (jun-7 Phase-2) — strip ANSI escape sequences + bare C0 controls from a
 *  model-facing body, PRESERVING `\n` and `\t` (layout the model legitimately
 *  reads). `npm`/`cargo`/`pytest` paint their output with SGR colour + cursor /
 *  erase CSI sequences; left verbatim they reach the LLM as token-wasting noise
 *  that also degrades parsing. Local to the bash slice (not `@/shared`'s
 *  `sanitizeLogText`, which strips `\n`/`\t` — wrong for a shell body — and not
 *  `@/ui`'s `stripAnsi`, which would cross the `@/tool` → `@/ui` fence).
 *
 *  Pure, surrogate-safe (the regexes never split a surrogate pair — they only
 *  match ASCII escape/control ranges), and idempotent (a cleaned body has no
 *  remaining match). `new RegExp(string)` avoids biome's
 *  `noControlCharactersInRegex` trip on the literal form. */
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const ANSI_OSC_DCS_RE = new RegExp(
  `${ESC}\\][\\s\\S]*?(?:${BEL}|${ESC}\\\\)|${ESC}[PX^_][\\s\\S]*?${ESC}\\\\`,
  "g",
)
const ANSI_CSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g")
// C0 controls EXCEPT `\t` (U+0009) and `\n` (U+000A), plus DEL (U+007F). `\r`
// (U+000D) IS stripped — a bare CR rewinds the line and is pure terminal noise
// to the model; the visible text after it survives.
// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matches C0 control chars to strip terminal noise from model output.
const C0_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g

export const stripModelControlChars = (s: string): string =>
  s.replace(ANSI_OSC_DCS_RE, "").replace(ANSI_CSI_RE, "").replace(C0_CONTROL_RE, "")

/** Format the combined stdout/stderr body + status banner.
 *
 *  ADR-0411: no length cap here. The registry's `capToolOutput` is the single
 *  authoritative truncator (head + tail, persists overflow). Bash returns the
 *  buffered body verbatim (after M4 ANSI/control strip). */
const formatRunBody = (r: {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}): { readonly status: string; readonly body: string } => {
  const body = stripModelControlChars([r.stdout, r.stderr].filter(Boolean).join("\n")).trimEnd()
  const status = r.timedOut ? "timed out" : r.exitCode === 0 ? "exit 0" : `exit ${r.exitCode}`
  return { status, body }
}

/** Default deadline mirror of {@link DEFAULT_TIMEOUT_MS} in `runtime/shell.ts`.
 *  Re-declared here (single literal, no import) so the background branch can
 *  decide the deadline WITHOUT calling `runShell` — `runShell` would kill on
 *  the deadline, which is exactly what `timeout_behavior:"background"`
 *  prevents. Keep this in sync with the runtime default. */
const DEFAULT_BG_TIMEOUT_MS = 120_000

/** Tail-truncate the in-flight placeholder buffer. Streaming-only — completed
 *  bodies delegate to the registry's head+tail `capToolOutput`. */
const tailMaxOutput = (s: string): string =>
  s.length > MAX_BG_PLACEHOLDER_OUTPUT ? s.slice(-MAX_BG_PLACEHOLDER_OUTPUT) : s

/** Build the bg-placeholder result when the deadline elapsed and the process
 *  is still running. */
const buildBackgroundPlaceholderResult = (
  snap: { id: string; stdout: string; stderr: string },
  timeoutMs: number,
): ToolEvent => {
  const outputSoFar = [tailMaxOutput(snap.stdout), tailMaxOutput(snap.stderr)]
    .filter((s) => s.length > 0)
    .join("\n")
    .trimEnd()
  return {
    type: "result",
    result: {
      ok: true,
      output:
        `[bash background] shellId=${snap.id} status=running\n` +
        `(deadline ${timeoutMs}ms elapsed — process detached; use bash_await or bash_kill)\n` +
        `--- output so far ---\n${outputSoFar || "(no output yet)"}`,
      evidence: {
        ...(snap.stderr ? { stderr: snap.stderr.slice(-STDERR_CAP) } : {}),
      },
    },
  }
}

/** Build the final result when the bg shell completed before the deadline.
 *
 *  ADR-0411: no length cap here. The registry's `capToolOutput` truncates
 *  oversized bodies with head+tail and persists the full payload to a
 *  spill file. */
const buildBackgroundCompletedResult = (snap: {
  status: string
  stdout: string
  stderr: string
  exitCode: number | null
  command: string
}): ToolEvent => {
  const body = stripModelControlChars(
    [snap.stdout, snap.stderr].filter(Boolean).join("\n"),
  ).trimEnd()
  const exit = snap.exitCode ?? -1
  const isKilled = snap.status === "killed" || snap.status === "aborted"
  const status = isKilled ? "killed" : `exit ${exit}`
  const evidence: ToolResultEvidence = {
    ...(snap.stderr ? { stderr: snap.stderr.slice(-STDERR_CAP) } : {}),
    exitCode: exit,
    executedCommand: snap.command,
  }
  return {
    type: "result",
    result: {
      ok: snap.status === "completed" && exit === 0,
      output: `[${status}]\n${body || "(no output)"}`,
      evidence,
    },
  }
}

const buildBackgroundResult = (
  registry: BashBgRegistry,
  cmd: string,
  shown: string,
  timeoutMs: number,
  signal: AbortSignal,
  cwd: string,
): AsyncIterable<ToolEvent> => {
  const gen = async function* (): AsyncGenerator<ToolEvent> {
    yield { type: "progress", message: `running (bg-capable): ${shown}` }
    const handle = await registry.register({ command: cmd, cwd, signal })
    const outcome = await registry.awaitHandle(handle.id, { timeoutMs, signal })
    if (outcome === null) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: `[bash background] handle ${handle.id} unexpectedly evicted before await completed`,
          failure: { mode: "error", modelVisibleError: "handle evicted" },
        },
      }
      return
    }
    const snap = outcome.snapshot
    yield snap.status === "running"
      ? buildBackgroundPlaceholderResult(snap, timeoutMs)
      : buildBackgroundCompletedResult({ ...snap, command: cmd })
  }
  return gen()
}

const buildReadModeBackgroundUnsupportedResult = (): ToolEvent => ({
  type: "result",
  result: {
    ok: false,
    output: "[sandbox unavailable]\nread-mode-background-unsupported",
    failure: {
      mode: "sandbox_unavailable",
      reason: "read-mode-background-unsupported",
    },
  },
})

const buildTimeoutBackgroundResult = (
  input: Input,
  mode: "read" | "write",
  cmd: string,
  shown: string,
  ctx: ToolContext,
  cwd: string,
): AsyncIterable<ToolEvent> => {
  if (mode === "read") {
    return (async function* (): AsyncGenerator<ToolEvent> {
      yield buildReadModeBackgroundUnsupportedResult()
    })()
  }
  return buildBackgroundResult(
    getBashBgRegistry(),
    cmd,
    shown,
    input.timeout_ms ?? DEFAULT_BG_TIMEOUT_MS,
    ctx.signal,
    cwd,
  )
}

/** RFC jun-6 — the shell result shape `maybeEscalate` consumes/returns (a
 *  structural subset of `ShellResult`, kept local so this slice never imports
 *  `@/runtime/types`). */
interface EscalatableShellResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

/** RFC jun-6 — offer the user-gated sandbox-block escalation when a `mode="read"`
 *  sandboxed command exited nonzero. Delegates to the host-installed handler
 *  (`@/host/runtime` adapts the orchestrator + classifier + post-denial store +
 *  HITL gate). Returns the (possibly re-run) result + an optional model-facing
 *  note. DEFAULT-OFF / byte-identical: no handler installed, the sandbox was not
 *  applied (mode="write" / degraded), a zero exit, or a timeout ⇒ returns the
 *  ORIGINAL result with no note (the handler is never even consulted). */
const maybeEscalate = async (
  r: EscalatableShellResult,
  meta: {
    readonly command: string
    readonly cwd: string
    readonly sandboxApplied: boolean
    readonly timedOut: boolean
    readonly agentLabel?: string
    readonly turnId?: string
    readonly rerunUnsandboxed: () => Promise<{
      exitCode: number
      stdout: string
      stderr: string
      timedOut: boolean
    }>
  },
): Promise<{ readonly result: EscalatableShellResult; readonly note?: string }> => {
  // Fast default-OFF / not-a-block guards — the handler is consulted ONLY for an
  // applied-sandbox nonzero non-timeout exit. A timeout is never a sandbox block.
  if (!meta.sandboxApplied || r.exitCode === 0 || meta.timedOut) return { result: r }
  const handler = getBashSandboxEscalationHandler()
  if (handler === undefined) return { result: r }

  const outcome = await handler({
    command: meta.command,
    cwd: meta.cwd,
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    ...(meta.agentLabel !== undefined ? { agentLabel: meta.agentLabel } : {}),
    ...(meta.turnId !== undefined ? { turnId: meta.turnId } : {}),
    // The byte-same command, re-run WITHOUT the per-call sandbox wrap. The
    // handler only invokes this AFTER a complete post-denial override + a
    // gate-clear (escalation NEVER auto-grants — enforced in the machine).
    rerunUnsandboxed: async () => {
      const rr = await meta.rerunUnsandboxed()
      return { exitCode: rr.exitCode, stdout: rr.stdout, stderr: rr.stderr }
    },
  })
  // Not classified as a sandbox block (or handler declined) ⇒ byte-identical.
  if (outcome === undefined) return { result: r }
  // The re-run (when present) replaces the result; `timedOut` is false (a
  // completed unsandboxed spawn). Absent ⇒ keep the original blocked result.
  const result: EscalatableShellResult =
    outcome.rerun !== undefined ? { ...outcome.rerun, timedOut: false } : r
  return { result, note: outcome.note }
}

/** RFC jun-6 — run the foreground command and offer the sandbox-block
 *  escalation in one place (keeps `bashExecute` under the complexity cap). The
 *  per-call wrap records whether the sandbox was APPLIED; an applied-sandbox
 *  nonzero exit is handed to the host escalation handler, which (on approve +
 *  gate-clear) re-runs the BYTE-SAME command UNSANDBOXED. Knob-OFF / no handler
 *  / not-a-block ⇒ returns the ORIGINAL result with no note (byte-identical). */
const runShellWithEscalation = async (
  cmd: string,
  ctx: ToolContext,
  input: Input,
  perCallPort: ReturnType<ReturnType<typeof getBashPerCallSandboxFactory>> | undefined,
  // ticket-11 — the EFFECTIVE spawn cwd: the active worktree dir when a session
  // worktree is entered, else `ctx.cwd` (byte-identical legacy). Computed once in
  // `bashExecute` so the escalation re-run uses the SAME cwd.
  cwd: string,
  sandboxLocalEnv?: NonNullable<ShellOptions["localEnv"]>,
): Promise<{ readonly result: EscalatableShellResult; readonly note?: string }> => {
  const wrapOutcome: PerCallWrapOutcome = { sandboxApplied: false }
  // Build the runShell options ONCE so an approved unsandboxed re-run can
  // re-spawn the BYTE-SAME command with the per-call wrap REMOVED.
  const baseShellOpts = {
    cwd,
    signal: ctx.signal,
    ...(input.timeout_ms ? { timeoutMs: input.timeout_ms } : {}),
    ...(ctx.onShellEvent ? { onShellEvent: ctx.onShellEvent } : {}),
    ...(ctx.shellSnapshot ? { shellSnapshot: ctx.shellSnapshot } : {}),
    ...(ctx.proxyEnv ? { proxyEnv: ctx.proxyEnv } : {}),
    ...(ctx.localEnv ? { localEnv: ctx.localEnv } : {}),
  } as const

  const sandboxShellOpts: ShellOptions = {
    ...baseShellOpts,
    ...(sandboxLocalEnv !== undefined ? { localEnv: sandboxLocalEnv } : {}),
  }
  const sandboxCommand =
    input.mode === "read" && perCallPort !== undefined
      ? lowerSimpleHereDocForReadMode(cmd).command
      : cmd

  const r = await runShell(sandboxCommand, {
    ...sandboxShellOpts,
    ...(perCallPort !== undefined
      ? { perCallWrap: buildPerCallWrap(perCallPort, wrapOutcome) }
      : {}),
  })

  return maybeEscalate(r, {
    command: cmd,
    cwd,
    sandboxApplied: wrapOutcome.sandboxApplied,
    timedOut: r.timedOut,
    ...(ctx.agentLabel !== undefined ? { agentLabel: ctx.agentLabel } : {}),
    ...(ctx.turnId !== undefined ? { turnId: ctx.turnId } : {}),
    rerunUnsandboxed: () => runShell(cmd, baseShellOpts),
  })
}

/** ADR-0297 — factory-built bash tool. The HITL tier closes over the
 *  operator-chosen sandbox profile (NOT the command string). Composition
 *  roots that resolve a profile (`src/apps/cli/sandbox-wire.ts`) wire it
 *  through `buildDefaultTools({ sandboxProfile })`. Absent profile ⇒ the
 *  conservative `always-confirm` tier for ALL commands. */
export interface MakeBashToolOpts {
  readonly sandboxProfile?: OsSandboxProfile
}

export const makeBashTool = (opts: MakeBashToolOpts = {}): Tool<Input> => {
  const tier = tierForProfile(opts.sandboxProfile)
  return {
    name: "bash",
    description:
      "Run a shell command (bash). Returns combined stdout/stderr and exit code. " +
      "Non-zero exit is reported, not thrown. " +
      // ADR-0410 — steer the model toward the right tool for file ops. The
      // shell is for one-shot search/diff/exec; per-file read/edit lives in
      // dedicated tools that the dispatcher can audit and reverse.
      "Prefer `read`, `grep`, and `edit` for file inspection and modification — " +
      "use bash ONLY when the task finishes in a single shell command " +
      "(file search via rg/fd, diff/git inspection, scoped exec). " +
      "Do NOT use bash for cat/sed/awk over files — `read` covers file reading and " +
      "`edit` covers targeted in-file string replacement, with proper sandbox " +
      "and reversal semantics.",
    inputSchema: schema,
    isReadOnly: () => false,
    // Arbitrary shell side effects are unknowable; never run concurrently.
    isConcurrencySafe: () => false,
    // ADR-0297 — closed-enum profile lookup; NO command inspection.
    hitlTier: () => tier,
    // S16: expose the raw shell command so the permission policy applies the
    // HARD_DENY denylist UNIFORMLY to any tool that accepts a shell command.
    extractShellCommand: (input: Input): string => input.command ?? "",
    // PR-2 self-audit fix (ADR-0078): DECLARED source-class classifier.
    classifySource: (input: Input) => classifyCommandShape(input.command ?? ""),

    execute: bashExecute,
  }
}

/** Legacy singleton export. Constructed with NO sandbox profile —
 *  tier degrades to the conservative `always-confirm` (ADR-0297). Sites
 *  that want sandbox-driven tier semantics use `makeBashTool({...})`. */
export const bashTool: Tool<Input> = makeBashTool()

async function* bashExecute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
  const cmd = input.command
  // ADR-0295 — `mode` is optional on the wire; default to "write" here so
  // the rest of execute can switch on a CLOSED 2-arm enum.
  const mode: "read" | "write" = input.mode ?? "write"
  const shown = cmd.length > CMD_PREVIEW ? `${cmd.slice(0, CMD_PREVIEW)}…` : cmd

  // ticket-11 (P8 worktree edit-fence) — when a session worktree is active, the
  // shell spawns INSIDE the worktree directory so a RELATIVE command sees the
  // worktree's files. ABSENT (gate OFF / no active worktree) ⇒ `ctx.cwd`
  // unchanged (byte-identical). This is the spawn process cwd ONLY — the FS jail
  // governing read/write/edit is unaffected here (those tools jail themselves).
  const effectiveCwd = resolveBashCwd(ctx.cwd, ctx.activeWorktree)

  // ADR-0296 — when the caller opts into `timeout_behavior: "background"`,
  // delegate to the bg-registry path. The default `"kill"` falls through to
  // the legacy `runShell` branch BYTE-IDENTICALLY.
  if (input.timeout_behavior === "background") {
    yield* buildTimeoutBackgroundResult(input, mode, cmd, shown, ctx, effectiveCwd)
    return
  }

  yield { type: "progress", message: `running: ${shown}` }

  // ADR-0295 — mode="read" per-call sandbox short-circuit. The acquire helper
  // probes `availability()`; an unsupported host returns a fail-closed result.
  const tempScope = createReadModeTempScope(mode, ctx.localEnv)
  let escalated: { readonly result: EscalatableShellResult; readonly note?: string }
  try {
    const acq = acquirePerCallPort(
      mode,
      tempScope !== undefined ? { extraWritePaths: tempScope.extraWritePaths } : undefined,
    )
    if (acq.unavailableResult !== undefined) {
      yield { type: "result", result: acq.unavailableResult }
      return
    }
    const perCallPort = acq.port

    // PR-5 / ADR-0081 + ADR-0235 + RFC jun-6 — run the command (forwarding the
    // optional observer / snapshot / proxy / local-env seams) AND offer the
    // user-gated sandbox-block escalation when a `mode="read"` sandboxed call
    // exits nonzero. The helper keeps `bashExecute` under the complexity cap.
    escalated = await runShellWithEscalation(
      cmd,
      ctx,
      input,
      perCallPort,
      effectiveCwd,
      tempScope?.localEnv,
    )
  } finally {
    tempScope?.cleanup()
  }

  const { status, body } = formatRunBody(escalated.result)
  const escalationNote = escalated.note
  // The re-run (when it happened) replaces the original result for failure
  // derivation + evidence, so the model sees the UNSANDBOXED outcome.
  const rr = escalated.result

  // RFC-0002 §5.2 evidence. Attach via the typed `evidence` field. Uses the
  // post-escalation result `rr` (identical to `r` when no escalation occurred).
  const evidence: ToolResultEvidence = {
    ...(rr.stderr ? { stderr: rr.stderr.slice(-STDERR_CAP) } : {}),
    exitCode: rr.exitCode,
    executedCommand: cmd,
  }

  // ADR-0295 — when mode="read" and the spawn fails with an EACCES /
  // sandbox-style stderr, classify as `sandbox_violation` IN PREFERENCE to
  // a plain `permission_denied`. The OS is the enforcer. When the unsandboxed
  // re-run cleared the violation (exit 0), no sandbox_violation is derived.
  const failure = deriveSandboxViolation(mode, rr) ?? deriveBashFailure(rr, input.timeout_ms)

  // ADR-0474 — append a stale-read reminder when this (write-class) command
  // rewrote a file the agent had READ, so it re-reads before editing. No-op when
  // the guard is unwired (byte-identical output).
  const staleReminder = await buildPostBashStaleReminder(ctx, cmd)

  // H6 (jun-3-misc §3) — passive git/gh VCS classification. A SEPARATE,
  // additive post-exec hook (default-OFF: returns immediately when
  // `QUANTA_PASSIVE_VCS` is unset OR no `vcsEventSink` is wired). When ON it
  // classifies a completed git/gh command's stdout into a structured VCS event
  // and routes it onto the EXISTING turn-diff bus via the wired sink. The hook
  // is NO-THROW and does NOT alter the tool's `output` — pure observability, so
  // the result yielded below is byte-identical regardless of the hook outcome.
  // We pass the combined `body` (stdout+stderr) so the single regex sweep sees
  // both git's progress (stderr) and its `[branch sha]` / `Pull request #N`
  // (stdout) lines.
  maybeEmitPassiveVcs(cmd, body, rr.exitCode, ctx as ToolContext & PassiveVcsHookCtx)

  // RFC jun-6 — when the command was a sandbox block, append the model-facing
  // escalation note (e.g. "blocked by sandbox; re-ran unsandboxed" / "escalation
  // denied"). Absent ⇒ byte-identical (default-OFF / not-a-block).
  const noteSuffix = escalationNote !== undefined ? `\n${escalationNote}` : ""

  yield {
    type: "result",
    result: {
      ok: rr.exitCode === 0 && !rr.timedOut,
      output: `[${status}]\n${body || "(no output)"}${staleReminder ? `\n${staleReminder}` : ""}${noteSuffix}`,
      evidence,
      ...(failure ? { failure } : {}),
    },
  }
}
