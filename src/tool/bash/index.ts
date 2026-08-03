import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { maybeEmitPassiveVcs, type PassiveVcsHookCtx } from "@/git/passive-classify"
import {
  type BackgroundDetachSeam,
  type OsSandboxProfile,
  runShell,
  type ShellOptions,
} from "@/runtime"
import { getBashBgRegistry } from "@/runtime/bash-bg-registry"
import { classifyCommandShape } from "@/security"
import { runtimeConfig } from "@/shared"
import { matchVerifyCommand } from "@/shared/verify-command-shape"
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
  ShellToolContext,
  Tool,
  ToolEvent,
  ToolFailure,
  ToolResult,
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
   *  The OS is the enforcer for sandbox safety. A separate preflight rejects
   *  shared-registry verification/reproduction commands in read mode because
   *  they are not passive inspection and frequently require runtime syscalls /
   *  temp/cache writes; it never auto-downgrades to write mode.
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
  /** ADR-0296 (Cursor `TimeoutBehavior.BACKGROUND` absorption). Per-call
   *  override of the session default (`QUANTA_BASH_AUTO_BACKGROUND`, default
   *  `"background"`). `"background"` DETACHES the still-running process when the
   *  deadline elapses, returning `{ shellId, status: "running", outputSoFar }`
   *  so the model resumes it via `bash_await` / `bash_kill`. `"kill"` is the
   *  legacy SIGTERM-on-deadline + typed `timeout` ToolFailure. `"prompt"` asks
   *  the operator for one-keystroke consent before detaching (degrades to
   *  `background` where no interactive surface is wired). Optional (not
   *  `.default()`) so the schema's input and output types match; absent ⇒ the
   *  session default applies. */
  timeout_behavior: z
    .enum(["kill", "background", "prompt"])
    .optional()
    .describe(
      "Per-call override of the session default (default 'background'). " +
        "background = on deadline, detach and return { shellId } — use bash_await/bash_kill later. " +
        "kill = SIGTERM on deadline (legacy). prompt = ask before detaching.",
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
 * The foreground path (`formatRunBody`) now returns the raw stdout/stderr body
 * verbatim (ADR-0296 routes a deadline-detached command's COMPLETION through the
 * same foreground path). The registry caps via head+tail, persisting the full
 * payload to `.quanta/tool-output/<uuid>.txt` when over budget.
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
const READ_MODE_VERIFY_REJECT_REASON = "read_mode_verification_command"

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
  ctx: ShellToolContext,
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

/** `mode="read"` is for passive inspection. Test/reproducer commands are still
 *  shell commands, but they execute language runtimes that may allocate guard
 *  pages, load native modules, write caches, or create temp files. Running those
 *  under the read-only per-call sandbox produced false infra failures in
 *  SWE-bench (django__django-11138). Do not silently relax the sandbox here:
 *  reject the invalid mode/command pairing and tell the model to rerun with an
 *  explicit write-capable execution mode. */
const rejectReadModeVerificationCommand = (
  mode: "read" | "write",
  command: string,
): ToolResult | null => {
  if (mode !== "read") return null
  const match = matchVerifyCommand(command)
  if (match === null) return null
  return {
    ok: false,
    output: [
      "[read-mode incompatible]",
      `Command classified as verification/reproduction: ${match.id} (${match.ecosystem}).`,
      'bash mode="read" is for passive inspection only. Rerun this verifier with bash mode="write" or use the dedicated test_runner/run_tests tool if available.',
      "No command was spawned.",
    ].join("\n"),
    failure: { mode: "rejected", reason: READ_MODE_VERIFY_REJECT_REASON },
  }
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

/** RFC02-4 (C2) — the executor-known DEADLINE facts for a COMPLETED run's
 *  evidence. Pure: a timed-out (kill-mode) command surfaces the `timedOut` flag
 *  and the ms the executor applied (`input.timeout_ms`), together, from the ONE
 *  evidence source. NOT parsed from stderr / the command string. Empty object
 *  when the run completed inline (no deadline reached). */
const deadlineEvidence = (
  timedOut: boolean,
  timeoutMs: number | undefined,
): Pick<ToolResultEvidence, "timedOut" | "timeoutMs"> => {
  if (!timedOut) return {}
  return { timedOut: true, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }
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
        // RFC02-4 (C2) — executor-known detach facts from the ONE evidence
        // source: the shell id from `adopt()`, the deadline the executor set,
        // and the `detached` control flag. CLI/model/recorder each project
        // these; no stderr/command parsing.
        detached: true,
        backgroundShellId: snap.id,
        timeoutMs,
      },
    },
  }
}

/** ADR-0296 auto-background — resolve the effective deadline behavior into an
 *  optional detach seam + the deadline (ms). A per-call `timeout_behavior` wins
 *  over the runtime-config default (`background`/`prompt` ⇒ detach; `kill` ⇒
 *  legacy SIGTERM). `prompt` additionally wires a `confirm` consent gate from
 *  the host (`ctx.requestBackgroundConsent`): approved ⇒ detach, declined ⇒
 *  kill. Absent that host surface, `prompt` degrades to plain `background`
 *  (auto-detach). An absent seam ⇒ kill-on-deadline (byte-identical legacy).
 *  The seam's `adopt` binds the still-running child to the process-wide bash bg
 *  registry. */
const resolveBgDetach = (
  input: Input,
  ctx: ShellToolContext,
): {
  readonly bgSeam?: { readonly seam: BackgroundDetachSeam; readonly timeoutMs: number }
  readonly deadlineMs: number
} => {
  const cfg = runtimeConfig()
  const behavior = input.timeout_behavior ?? cfg.bashAutoBackground
  const deadlineMs = input.timeout_ms ?? cfg.bashAutoBackgroundThresholdMs ?? DEFAULT_BG_TIMEOUT_MS
  if (behavior === "kill") return { deadlineMs }
  // PROMPT mode wires a consent gate ONLY when the host surfaced a requester;
  // otherwise (and for plain `background`) the seam has no `confirm` and detach
  // is immediate.
  const consent = ctx.requestBackgroundConsent
  const confirm =
    behavior === "prompt" && consent !== undefined
      ? (info: { command: string; elapsedMs: number }) => consent(info)
      : undefined
  return {
    bgSeam: {
      seam: {
        adopt: async (args) => {
          // RFC02-0 — stamp the STABLE session owner (from the dispatch ctx)
          // onto the detached shell so kill is owner-scoped. `runShell` does not
          // carry an owner, so the tool injects it here from the captured ctx.
          // ABSENT `ctx.ownerId` (no session id) ⇒ omitted ⇒ unowned shell
          // (byte-identical). Never derived from a shell id / PID / cwd.
          const { id } = await getBashBgRegistry().adopt({
            ...args,
            ...(ctx.ownerId !== undefined ? { ownerId: ctx.ownerId } : {}),
          })
          return { id }
        },
        ...(confirm !== undefined ? { confirm } : {}),
      },
      timeoutMs: deadlineMs,
    },
    deadlineMs,
  }
}

/** RFC jun-6 — the shell result shape `maybeEscalate` consumes/returns (a
 *  structural subset of `ShellResult`, kept local so this slice never imports
 *  `@/runtime/types`). */
interface EscalatableShellResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  /** ADR-0296 — present when the run hit its deadline under a `background`
   *  seam and the still-running child was DETACHED into the bg registry. The
   *  bash tool surfaces a `{ shellId }` placeholder and skips completion-only
   *  post-processing (evidence / passive-VCS / stale-read / escalation). */
  readonly detached?: { readonly shellId: string }
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
  // ADR-0296 — a detached run never completed, so it cannot be a sandbox block
  // (no exit code to classify). Short-circuit before the exit-code guard.
  if (r.detached !== undefined) return { result: r }
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
  ctx: ShellToolContext,
  input: Input,
  perCallPort: ReturnType<ReturnType<typeof getBashPerCallSandboxFactory>> | undefined,
  // ticket-11 — the EFFECTIVE spawn cwd: the active worktree dir when a session
  // worktree is entered, else `ctx.cwd` (byte-identical legacy). Computed once in
  // `bashExecute` so the escalation re-run uses the SAME cwd.
  cwd: string,
  sandboxLocalEnv?: NonNullable<ShellOptions["localEnv"]>,
  // ADR-0296 — when present, the FIRST (sandboxed) spawn detaches on its
  // deadline (`timeoutMs`) into the registry instead of being killed. The
  // unsandboxed escalation re-run deliberately omits this (it only fires for a
  // COMPLETED nonzero exit, never a detached run).
  bg?: { readonly seam: BackgroundDetachSeam; readonly timeoutMs: number },
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
    // ADR-0296 — detach-on-deadline. The resolved deadline overrides any
    // `timeoutMs` from `baseShellOpts` so the bg threshold (not the legacy kill
    // deadline) governs when the child detaches.
    ...(bg !== undefined ? { background: bg.seam, timeoutMs: bg.timeoutMs } : {}),
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
  // PDP capability (jun-10 P2-T3, activated jul-10 D-1 follow-through): with NO
  // sandbox profile the always-confirm tier exists because the command risk is
  // UNKNOWN (needs a sandbox), NOT because shell is inherently sensitive. The
  // capability declares that reason so the gate can split the two: asks under
  // default/acceptEdits when HITL is on, but an explicit `bypass` release
  // defers to mode policy (HARD_DENY still wins there). `workspace-write-net`'s
  // always-confirm is deliberate net-egress audit ceremony — NOT declared
  // needs-sandbox, so it keeps its confirm under bypass.
  const sandboxless = opts.sandboxProfile === undefined || opts.sandboxProfile === "off"
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
    ...(sandboxless ? { capability: () => ({ confirm: "needs-sandbox" as const }) } : {}),
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

async function* bashExecute(input: Input, ctx: ShellToolContext): AsyncIterable<ToolEvent> {
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

  // ADR-0296 auto-background — resolve the effective deadline behavior. When the
  // command outruns its deadline the run is DETACHED into the bg registry
  // (Claude-Code-style auto-background) instead of killed; the run still goes
  // through the SAME foreground path (sandbox / env / per-call read-wrap /
  // evidence on completion), so only the deadline diverges and nothing regresses.
  const { bgSeam, deadlineMs: detachDeadlineMs } = resolveBgDetach(input, ctx)

  yield {
    type: "progress",
    message: `running${bgSeam !== undefined ? " (bg-capable)" : ""}: ${shown}`,
  }

  const readModeRejection = rejectReadModeVerificationCommand(mode, cmd)
  if (readModeRejection !== null) {
    yield { type: "result", result: readModeRejection }
    return
  }

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
      bgSeam,
    )
  } finally {
    tempScope?.cleanup()
  }

  // ADR-0296 — the command outran its deadline and was DETACHED into the bg
  // registry. Surface the `{ shellId }` placeholder and STOP: there is no exit
  // code yet, so the completion-only post-processing below (evidence /
  // sandbox-violation derivation / passive-VCS / stale-read) does not apply.
  // The model resumes the shell via `bash_await` / `bash_kill`.
  if (escalated.result.detached !== undefined) {
    yield buildBackgroundPlaceholderResult(
      {
        id: escalated.result.detached.shellId,
        stdout: escalated.result.stdout,
        stderr: escalated.result.stderr,
      },
      detachDeadlineMs,
    )
    return
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
    // RFC02-4 (C2) — executor-known deadline facts (timedOut + the applied ms)
    // from the ONE evidence source; empty when the command completed inline.
    ...deadlineEvidence(rr.timedOut, input.timeout_ms),
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
  maybeEmitPassiveVcs(cmd, body, rr.exitCode, ctx as PassiveVcsHookCtx)

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
