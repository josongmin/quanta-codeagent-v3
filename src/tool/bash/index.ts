import { z } from "zod"
import { runShell } from "@/runtime"
import { classifyCommandShape } from "@/security"
import type {
  HITLTier,
  SandboxViolationReason,
  Tool,
  ToolContext,
  ToolEvent,
  ToolFailure,
  ToolResultEvidence,
} from "../types"
import { getBashPerCallSandboxFactory } from "./per-call-factory"

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
})

type Input = z.infer<typeof schema>

const MAX_OUTPUT = 30_000
const CMD_PREVIEW = 80
/** Local stderr-tail cap on `evidence.stderr`. Dispatch re-trims to its own
 *  smaller `STDERR_TAIL_CAP` (2000) as a defense-in-depth backstop, so this
 *  cap only bounds the per-tool attachment size. */
const STDERR_CAP = 4_000

/* HITL tier patterns (Codex hitl-audit.md). HARD_DENY (RCE, root-rm, fork
 * bomb, …) is enforced upstream by @/permission and maps to hand-off-required
 * via the dispatch seam — bash itself only distinguishes "always-confirm"
 * (irreversible network egress + mutating git ops) from the default
 * "pre-approval-ok". `git -C <dir>` (capital C) is legit; only the listed
 * mutating subcommands escalate.
 *
 * SECURITY: the prefix matcher between `git` and the dangerous subcommand
 * must accept ALL legal git global-option forms — otherwise simple bypasses
 * like `git --no-pager push`, `git -C dir push`, `git -c k=v push`, and
 * `git --git-dir=. push` all look ordinary while sneaking past the gate. The
 * pattern below enumerates the three legal pre-subcommand token shapes:
 *   1. `-x` short option (with an optional operand: `-C dir`)
 *   2. `--long-option` (with optional `=value` or space-separated value)
 *   3. positional / env-prefix tokens (`FOO=1 git ... push`, environment
 *      already lives BEFORE `git` so this branch covers `git <subcommand>`
 *      where the matcher between is empty — i.e. zero global options at all)
 * Greedy zero-or-more of the three branches lets a chain of options through,
 * but the final mandatory subcommand boundary (`\bpush\b`, etc.) is what
 * actually identifies the dangerous call. */
const GIT_PREFIX = String.raw`(?:--[A-Za-z][A-Za-z0-9_-]*(?:=\S+)?\s+|-[A-Za-z](?:\s+\S+)?\s+|[^-\s]\S*\s+)*`

const ALWAYS_CONFIRM_PATTERNS: RegExp[] = [
  // Network egress: curl/wget/gh api/git push/git fetch.
  /\bcurl\b/,
  /\bwget\b/,
  /\bgh\s+api\b/,
  new RegExp(String.raw`\bgit\b\s+${GIT_PREFIX}push\b`),
  // `send-pack` is the low-level plumbing command behind `git push`; same
  // network egress, same irreversibility. A motivated bypass would reach for
  // it precisely because `push` is gated — escalate both paths identically.
  new RegExp(String.raw`\bgit\b\s+${GIT_PREFIX}send-pack\b`),
  // `git fetch` with NO remote argument fetches `origin` by default; `git
  // fetch upstream` is just as risky as `git fetch origin`. We deliberately
  // drop the `\borigin\b` requirement that previously narrowed this rule —
  // any fetch is a network egress that should ride the always-confirm tier.
  new RegExp(String.raw`\bgit\b\s+${GIT_PREFIX}fetch\b`),
  // Mutating git operations that are hard / impossible to undo locally.
  new RegExp(String.raw`\bgit\b\s+${GIT_PREFIX}commit\b[\s\S]*--amend\b`),
  new RegExp(String.raw`\bgit\b\s+${GIT_PREFIX}reset\b[\s\S]*--hard\b`),
]

/** Derive a TYPED {@link ToolFailure} from the existing `ShellResult` shape
 *  WITHOUT touching `runtime/shell.ts` (owned by another track). The classifier
 *  recognises three cleanly-recoverable bash exit shapes:
 *   - `timeout`: the runtime already flags `timedOut` — carry the deadline.
 *   - `spawn_error`: `bash -lc` exits 127 with `command not found` on stderr
 *     when the program can't be launched at all (Cursor `ShellSpawnError`). The
 *     127+stderr heuristic is the ONLY signal available without editing the
 *     runtime to surface a real spawn ENOENT; a script that legitimately exits
 *     127 without that stderr text is NOT misclassified.
 *   - `permission_denied`: `bash -lc` exits 126 with `Permission denied` on
 *     stderr when the file exists but the OS refused the exec (e.g. `chmod
 *     644` on a script, EACCES on `execve`). Distinct from `spawn_error` (the
 *     binary WAS found — the kernel refused), and from a session read-only
 *     mode refusal (`isReadonly` is explicitly absent here — real OS denial).
 *  Any other non-zero exit stays a plain command failure (no `failure` field —
 *  byte-identical to the pre-migration result). */
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
  // exit 126 + "Permission denied" on stderr is bash's standard EACCES-on-
  // execve diagnostic (POSIX shell convention). Narrowing on BOTH the exit
  // code AND the stderr text avoids misclassifying an unrelated 126 (POSIX
  // also reserves 126 for "command found but not executable" but the
  // matching stderr is the load-bearing signal).
  if (r.exitCode === 126 && /permission denied/i.test(r.stderr)) {
    return { mode: "permission_denied" }
  }
  return undefined
}

/** ADR-0295 — classify an OS-sandbox denial from the spawn result.
 *
 *  Only runs when the caller selected `mode="read"`. The classifier reads
 *  the OS signal (`stderr` + non-zero exit) and maps it to a CLOSED-enum
 *  {@link SandboxViolationReason}. It NEVER inspects the original `command`
 *  string — the OS is the enforcer; pattern-matching the command would be a
 *  heuristic.
 *
 *  Mapping (stderr patterns are the OS's own diagnostics — sandbox-exec and
 *  the Linux landlock wrappers both emit these literals on denial):
 *    - "Operation not permitted" / "Sandbox" → `write_denied`
 *      (the dominant Seatbelt diagnostic; we collapse write/exec/network
 *      under this default since the kernel doesn't pre-classify them).
 *    - "Permission denied"                    → `write_denied`
 *      (EACCES on filesystem; matches the common case of `> file`).
 *    - explicit "exec format" / "no exec"     → `exec_denied`
 *    - explicit "network" / "connection refused on sandbox" → `network_denied`
 *    - other non-zero exit                    → `unknown`
 *
 *  When the spawn EXITED 0 (succeeded), no violation — returns `undefined`.
 *  When mode is `"write"`, never runs (caller short-circuits).
 */
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

const classifySandboxStderr = (stderr: string): SandboxViolationReason | undefined => {
  // Empty stderr on a non-zero exit could be a legitimate `false`-style
  // command — don't claim a sandbox violation. The OS always emits a
  // diagnostic on a sandbox deny.
  if (stderr.length === 0) return undefined
  const s = stderr.toLowerCase()
  // The order matters: more-specific OS classes first, then the generic
  // "operation not permitted" sandbox banner.
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
  // On mode="read", any non-zero exit traveled through the wrapped argv. The
  // wrapped argv only fails when (a) the OS denied (covered above) or (b)
  // the user command legitimately failed (e.g. `false`, `grep` no-match).
  // Returning `undefined` here lets the legacy classifier (`deriveBashFailure`)
  // surface a non-sandbox failure when applicable — we never mis-claim a
  // violation.
  return undefined
}

/** ADR-0295 — acquire the per-call sandbox port for `mode="read"` and probe
 *  its `availability()`. Returns:
 *   - `{ port }`               when the OS can enforce — caller proceeds.
 *   - `{ unavailableResult }`  when the OS cannot enforce — caller MUST yield
 *                              this ToolResult and return (fail-closed; never
 *                              fall back to the unsandboxed spawn). */
const acquirePerCallPort = (
  mode: "read" | "write",
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
  const port = getBashPerCallSandboxFactory()("read-only")
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

/** ADR-0295 — adapt a {@link PerCallSandboxPort.wrap} call into the
 *  `ShellOptions.perCallWrap` shape. Pulled out so the `execute` flow body
 *  stays linear (one statement per concern). */
const buildPerCallWrap =
  (port: ReturnType<ReturnType<typeof getBashPerCallSandboxFactory>>) =>
  async (argv: ReadonlyArray<string>, cwd: string) => {
    const w = await port.wrap(argv, cwd)
    return {
      argv: [...w.argv],
      sandboxApplied: w.sandboxApplied,
      ...(w.degradeReason !== undefined ? { degradeReason: w.degradeReason } : {}),
    }
  }

/** Format the combined stdout/stderr body + status banner. Pulled out so the
 *  cognitive complexity of `execute` stays under the slice ratchet. */
const formatRunBody = (r: {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}): { readonly status: string; readonly body: string } => {
  let body = [r.stdout, r.stderr].filter(Boolean).join("\n").trimEnd()
  if (body.length > MAX_OUTPUT) {
    body = `${body.slice(0, MAX_OUTPUT)}\n… (truncated, ${body.length - MAX_OUTPUT} more chars)`
  }
  const status = r.timedOut ? "timed out" : r.exitCode === 0 ? "exit 0" : `exit ${r.exitCode}`
  return { status, body }
}

const bashHitlTier = (input: Input): HITLTier => {
  const cmd = input.command ?? ""
  for (const pat of ALWAYS_CONFIRM_PATTERNS) {
    if (pat.test(cmd)) return "always-confirm"
  }
  return "pre-approval-ok"
}

export const bashTool: Tool<Input> = {
  name: "bash",
  description:
    "Run a shell command (bash). Returns combined stdout/stderr and exit code. " +
    "Non-zero exit is reported, not thrown.",
  inputSchema: schema,
  isReadOnly: () => false,
  // Arbitrary shell side effects are unknowable; never run concurrently.
  isConcurrencySafe: () => false,
  hitlTier: bashHitlTier,
  // S16: expose the raw shell command so the permission policy applies the
  // HARD_DENY denylist UNIFORMLY to any tool that accepts a shell command,
  // not just one whose `name === "bash"`. A future sibling shell tool
  // (`shell`/`exec`/MCP `run`) only needs to set this method to opt into the
  // same gate.
  extractShellCommand: (input: Input): string => input.command ?? "",
  // PR-2 self-audit fix (ADR-0078): DECLARED source-class classifier. Pre-fix
  // this lived as a hard-coded `COMMAND_TOOL_NAMES` set in `dispatch.ts`; now
  // the tool that runs the shell command declares its own classification —
  // a future `shell`/`exec`/MCP `run` tool opts into Layer-1 redaction by
  // implementing this same method (in parallel to its `extractShellCommand`).
  classifySource: (input: Input) => classifyCommandShape(input.command ?? ""),

  async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const cmd = input.command
    // ADR-0295 — `mode` is optional on the wire; default to "write" here so
    // the rest of execute can switch on a CLOSED 2-arm enum.
    const mode: "read" | "write" = input.mode ?? "write"
    const shown = cmd.length > CMD_PREVIEW ? `${cmd.slice(0, CMD_PREVIEW)}…` : cmd
    yield { type: "progress", message: `running: ${shown}` }

    // ADR-0295 — mode="read" per-call sandbox short-circuit. The acquire helper
    // probes `availability()`; an unsupported host returns a fail-closed result.
    const acq = acquirePerCallPort(mode)
    if (acq.unavailableResult !== undefined) {
      yield { type: "result", result: acq.unavailableResult }
      return
    }
    const perCallPort = acq.port

    // PR-5 / ADR-0081: forward the optional shell-event observer through to
    // `runShell`. Absent (default) ⇒ buffered legacy path, byte-identical.
    // ADR-0235: forward the optional per-turn shell-snapshot seam through to
    // `runShell`. The seam shape is structurally identical to
    // `ShellOptions.shellSnapshot` (both are `ShellSnapshotRestoreSeam`),
    // so the forward is pass-through. Absent ⇒ no restore wrapping, exact
    // byte-identical legacy spawn.
    const r = await runShell(cmd, {
      cwd: ctx.cwd,
      signal: ctx.signal,
      ...(input.timeout_ms ? { timeoutMs: input.timeout_ms } : {}),
      ...(ctx.onShellEvent ? { onShellEvent: ctx.onShellEvent } : {}),
      ...(ctx.shellSnapshot ? { shellSnapshot: ctx.shellSnapshot } : {}),
      ...(perCallPort !== undefined ? { perCallWrap: buildPerCallWrap(perCallPort) } : {}),
    })

    const { status, body } = formatRunBody(r)

    // RFC-0002 §5.2 evidence. Attach via the typed `evidence` field (CR3:
    // no more duck-typed extras on ToolResult). Each subfield is conditional-
    // spread so `exactOptionalPropertyTypes` never sees `undefined`.
    const evidence: ToolResultEvidence = {
      ...(r.stderr ? { stderr: r.stderr.slice(-STDERR_CAP) } : {}),
      exitCode: r.exitCode,
    }

    // Typed failure on the ok:false path only (additive; `output`+`evidence`
    // unchanged). Conditional-spread so a plain non-zero exit stays
    // byte-identical (no `failure` key at all).
    //
    // ADR-0295 — when mode="read" and the spawn fails with an EACCES /
    // sandbox-style stderr, classify as `sandbox_violation` IN PREFERENCE to
    // a plain `permission_denied` (the existing 126+EACCES classifier). The
    // OS is the enforcer; we trust its stderr signal here — there is no
    // command-pattern matching.
    const failure = deriveSandboxViolation(mode, r) ?? deriveBashFailure(r, input.timeout_ms)

    yield {
      type: "result",
      result: {
        ok: r.exitCode === 0 && !r.timedOut,
        output: `[${status}]\n${body || "(no output)"}`,
        evidence,
        ...(failure ? { failure } : {}),
      },
    }
  },
}
