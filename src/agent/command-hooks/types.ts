/**
 * Disk-configured command hooks — port + config types (ADR-0454, T4).
 *
 * WHAT THIS IS — quanta's {@link HookBus} (src/agent/hooks.ts) is purely
 * in-process TS callbacks. Claude Code, by contrast, lets a user author shell
 * commands in `settings.json#hooks` that the harness EXECUTES on a hook event.
 * The migration translator (src/migration/translators/claude-code-config.ts)
 * already PARSES those `{type:"command", command}` entries into
 * {@link TranslatedHook}, but quanta only counts them — there is no executor.
 *
 * This slice adds the missing executor: a {@link CommandHookRunner} that, on a
 * matching hook event, runs the configured shell command(s) ONE-SHOT through an
 * injected {@link CommandHookExecPort} (a stdin-capable, env-scrubbed,
 * timeout-bounded spawn port), passing the hook event payload as JSON on stdin
 * (the Claude Code contract). The command's exit code / stdout maps back to a
 * {@link HookEmitResult}-compatible verdict (deny / updatedInput).
 *
 * SECURITY — command hooks execute ARBITRARY user shell. The whole slice is
 * DEFAULT-OFF and is gated by THREE independent guards (see
 * {@link CommandHookGate}):
 *   1. an explicit opt-in toggle (`enabled === true`);
 *   2. a non-empty `acknowledgedRisk` string (mirrors the redaction-disable
 *      acknowledgement in src/security/redaction-config.ts — an audit-grade
 *      reason the operator typed, surfaced so "shell hooks are armed" is never
 *      invisible);
 *   3. a permission decision (injected {@link CommandHookPermissionPort}) — a
 *      command hook is treated as a privileged operation and routes through the
 *      same approve/deny gate the rest of the agent uses.
 * When ANY guard is absent the runner NEVER spawns — `run` returns the legacy
 * `{ deny: null }` and the HookBus path is byte-identical (zero command exec).
 *
 * INJECTION-SAFETY — the user command is the argv tail handed to the spawn
 * port verbatim; it is NEVER string-concatenated with the event payload. The
 * payload reaches the command exclusively as JSON written to the child's stdin.
 * There is therefore no interpolation surface through which event content
 * (which can be model- or tool-derived) could alter the command string.
 */

/** Provenance of a command-hook binding (T04 trust gate, Codex `source`).
 *  DERIVED from the config layer (or the migration importer) by TRUSTED code —
 *  NEVER read from disk in a loosening direction (a hostile repo cannot stamp
 *  `"user"` to skip review; the disk parser strips the key and the merge
 *  re-stamps it authoritatively from the layer name). The split that matters:
 *  machine-owned (`managed`/`user`) is trusted; repo-shippable / externally
 *  imported (`project`/`imported`) is review-gated. See {@link sourceNeedsReview}. */
export type CommandHookSource = "managed" | "user" | "project" | "imported"

/** Machine-owned sources that an operator already controls — a hook from one
 *  of these never needs review (it is not attacker-shippable in a cloned repo).
 *  Everything else (repo-local `project`, migration-`imported`, or an unknown
 *  provenance) is review-gated when the trust gate is armed. */
const TRUSTED_HOOK_SOURCES: ReadonlySet<CommandHookSource> = new Set<CommandHookSource>([
  "managed",
  "user",
])

/** Whether a binding of this provenance must be reviewed before it may fire,
 *  when the trust gate is armed. `managed`/`user` ⇒ false (trusted). Repo /
 *  imported / `undefined` (legacy, un-provenanced) ⇒ the binding is NOT review-
 *  gated by source ALONE — `undefined` returns false so the legacy path stays
 *  byte-identical; a review requirement on the legacy path comes ONLY from the
 *  migration `needsReview:true` marker, never from an inferred source. */
export const sourceNeedsReview = (source: CommandHookSource | undefined): boolean =>
  source !== undefined && !TRUSTED_HOOK_SOURCES.has(source)

/** A single resolved command-hook binding. Mirrors the translator's
 *  {@link TranslatedHook} shape (event + optional matcher + command) but is
 *  flattened to ONE command per binding so the runner iterates a flat list
 *  in deterministic order. */
export interface CommandHookBinding {
  /** Claude Code event name as written in `settings.json#hooks` (e.g.
   *  `PreToolUse`, `PostToolUse`, `UserPromptSubmit`). Mapped to the quanta
   *  {@link HookEventType} by {@link mapClaudeEvent}. */
  readonly event: string
  /** Optional tool-name matcher (Claude `matcher` field). Absent ⇒ matches
   *  every tool for a tool-shaped event. Non-tool events ignore it. */
  readonly matcher?: string
  /** The user-authored shell command, run verbatim as the argv tail. NEVER
   *  concatenated with the payload. */
  readonly command: string
  /** Provenance (T04). Derived from the config layer / importer by trusted
   *  code. Absent on the legacy un-provenanced path. */
  readonly source?: CommandHookSource
  /** When true, this binding must be APPROVED (via the review store) before the
   *  runner will spawn it — but ONLY when the gate's trust gate is armed
   *  ({@link CommandHookGate.trustGate}). Absent / false ⇒ fires as usual.
   *  Set by trusted code from {@link sourceNeedsReview} or the migration
   *  importer's `needsReview` marker; the on-disk loosening direction
   *  (`false`) is never honored. */
  readonly needsReview?: boolean
}

/** Result of running one command hook, normalized to the HookBus channels.
 *  `deny` short-circuits the tool (non-null reason); `updatedInput` rewrites
 *  the tool args (presence-of-key is the signal, mirroring
 *  {@link HookUpdatedInput}). Both omitted ⇒ the command was an observer. */
export interface CommandHookVerdict {
  /** Non-null when the command voted to block (exit≠0, or stdout JSON carried
   *  `{deny}` / `{decision:"block"}`). The string is the reason surfaced to
   *  the model. */
  readonly deny: { reason: string } | null
  /** Present (key included) only when stdout JSON carried `{updatedInput}`.
   *  The value is opaque — the tool re-validates its own schema. */
  readonly updatedInput?: unknown
  /** True when the command exceeded its timeout (killed). A timed-out command
   *  is treated as a DENY (fail-closed — an unbounded hook must not silently
   *  pass the tool through). */
  readonly timedOut: boolean
}

/** One-shot command execution result. Deliberately a SUBSET of the runtime
 *  {@link ShellResult} shape so a {@link LocalSandbox}-backed adapter maps
 *  trivially, but typed locally so the slice does not depend on a tool runner. */
export interface CommandHookExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  readonly timedOut: boolean
}

/** Options for one {@link CommandHookExecPort.exec} call. */
export interface CommandHookExecOpts {
  /** The user command, run as the argv tail (NEVER concatenated with stdin). */
  readonly command: string
  /** JSON-serialized hook event payload written to the child's stdin and then
   *  the stdin is closed (EOF). The Claude Code contract. */
  readonly stdinJson: string
  /** Exact set of env var names allowed through to the child. The adapter
   *  scrubs everything else (reuse `scrubEnv` / `DEFAULT_ENV_ALLOWLIST` from
   *  src/runtime/sandbox.ts — the single source of truth for the allowlist). */
  readonly envAllowlist: readonly string[]
  /** Wall-clock budget (ms). The child is killed past this and `timedOut` set. */
  readonly timeoutMs: number
  /** Hard cap on combined captured stdout/stderr bytes. */
  readonly maxOutputBytes: number
  /** Working directory for the child. */
  readonly cwd: string
  /** Abort the run early. */
  readonly signal?: AbortSignal
}

/** The closed port the runner spawns through. The PRODUCTION adapter is
 *  {@link createSandboxCommandHookExec} (src/agent/command-hooks/sandbox-exec.ts),
 *  which wraps the SAME `LocalSandbox` env-scrub / timeout / output-cap the
 *  shell tool uses, extended with stdin delivery. Tests inject a fake so NO
 *  real shell runs in CI. */
export interface CommandHookExecPort {
  exec(opts: CommandHookExecOpts): Promise<CommandHookExecResult>
}

/** Permission gate for arming a command hook. A command hook is a privileged
 *  operation; the runner asks this port BEFORE the first spawn for an event.
 *  Returning false ⇒ the runner does not spawn (treated as no command hooks
 *  for that event). Injected so the slice does not depend on the concrete
 *  permission store. */
export interface CommandHookPermissionPort {
  /** Resolve whether command hooks for `event` (optionally for tool `name`)
   *  are permitted to run. Implementations route this through the normal
   *  approve/deny path. */
  isAllowed(input: { event: string; toolName?: string }): Promise<boolean> | boolean
}

/** Trust-review gate for a {@link CommandHookBinding} flagged
 *  {@link CommandHookBinding.needsReview} (T04). The runner consults this
 *  PER-BINDING — only when {@link CommandHookGate.trustGate} is armed — BEFORE
 *  spawning a review-gated hook. Returning false ⇒ the binding is HELD (the
 *  command never spawns; the tool still proceeds — a held hook does not deny,
 *  it simply has not been activated yet). Injected so the slice does not depend
 *  on the concrete approval store; the production adapter is backed by the
 *  on-disk hook-approval store the `/hooks` slash writes. */
export interface CommandHookReviewPort {
  /** Whether `binding` (review-gated) has been explicitly approved by the user.
   *  A fail-closed default (no record ⇒ false) keeps an un-reviewed imported
   *  hook from ever firing. */
  isApproved(binding: CommandHookBinding): Promise<boolean> | boolean
}

/** Injected dependencies for the runner. ALL spawning + any wall-clock timing
 *  lives behind {@link CommandHookExecPort} (the spawn port) — the runner
 *  itself reads NO clock and spawns NO process directly (NO-HEURISTICS
 *  directive: inject the spawn port; the production adapter owns the kill
 *  timer, exactly as `LocalSandbox` does). */
export interface CommandHookDeps {
  readonly exec: CommandHookExecPort
  readonly permission: CommandHookPermissionPort
  /** Working directory passed to every exec. */
  readonly cwd: string
  /** Trust-review gate (T04). Consulted ONLY for bindings flagged
   *  {@link CommandHookBinding.needsReview} when {@link CommandHookGate.trustGate}
   *  is armed. Absent ⇒ a review-gated binding is treated as NOT approved
   *  (fail-closed: an un-reviewed imported hook never fires). */
  readonly review?: CommandHookReviewPort
}

/** Frozen, validated gate produced by {@link normalizeCommandHookGate}. The
 *  runner consults this ONCE; an un-armed gate makes `run` a no-op. */
export interface CommandHookGate {
  /** All three guards satisfied AND at least one binding present. */
  readonly armed: boolean
  /** T04 trust gate. When true, a binding flagged
   *  {@link CommandHookBinding.needsReview} is HELD (does not spawn) until the
   *  injected {@link CommandHookReviewPort} approves it. When false (the
   *  DEFAULT), `needsReview` is purely informational and every armed binding
   *  fires as before — byte-identical to the pre-T04 behavior. */
  readonly trustGate: boolean
  /** The acknowledgement string (preserved for audit) when armed; else
   *  undefined. */
  readonly acknowledgedRisk: string | undefined
  /** The resolved bindings (empty when not armed). */
  readonly bindings: readonly CommandHookBinding[]
  /** Per-command timeout (ms). */
  readonly timeoutMs: number
  /** Per-command combined-output byte cap. */
  readonly maxOutputBytes: number
  /** Env allowlist handed to every exec. */
  readonly envAllowlist: readonly string[]
}

/** Raised when `enabled: true` is requested WITHOUT a non-empty
 *  `acknowledgedRisk`. A hard startup stop — arming arbitrary shell execution
 *  without an audit-grade acknowledgement must fail fast, never mid-turn.
 *  Mirrors `RedactionConfigError`. */
export class CommandHookConfigError extends Error {
  override readonly name = "CommandHookConfigError"
}

/** Exact error message — surfaced as the startup contract. Tests assert this
 *  verbatim; do not edit without bumping ADR + tests. */
export const COMMAND_HOOKS_ENABLED_WITHOUT_ACK_MESSAGE =
  "Command hooks enabled requires explicit acknowledgedRisk string. Refusing to arm shell hooks."

/** Default per-command wall-clock budget (ms). Rationale: a command hook is an
 *  inline gate on the agent loop (it can block a tool call), so it must be
 *  short enough to keep the loop responsive yet generous enough for a real
 *  policy script (lint/format/secret-scan a payload). 30s matches the shell
 *  tool's spinner-stall window class. Override via {@link CommandHookGate}. */
export const DEFAULT_COMMAND_HOOK_TIMEOUT_MS = 30_000

/** Default combined stdout/stderr byte cap per command. A command hook's
 *  meaningful output is a small JSON verdict; a multi-MB dump is pathological.
 *  1MB mirrors the HookBus `MAX_PAYLOAD_BYTES` so the two bounds agree. */
export const DEFAULT_COMMAND_HOOK_MAX_OUTPUT_BYTES = 1_048_576
