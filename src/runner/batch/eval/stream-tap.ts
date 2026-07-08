/**
 * Bench stream tap (SSOT). Both bench drivers — the runner core
 * (`runner/batch/eval/driver.ts`) and the prod SDK wrapper
 * (`apps/bench/eval/driver.ts`) — previously each carried a private
 * `LastVerifyCmdTap` copy; they drifted by construction. This module is the
 * single definition both import.
 *
 * The tap is a PURE pass-through `StreamPort`: every event is forwarded to the
 * downstream unchanged. It only OBSERVES, accumulating run-shape signals the
 * orchestrator / closure-diagnostics read AFTER `runAgent` returns:
 *   - `lastVerifyCmd`  — the validator re-exec target (bash / test_runner),
 *   - `firstEditFile` + `turnsToFirstEdit` — T-202 owner-match / localize latency,
 *   - `editCount`      — F6 attempted-edit churn signal (#10914-class over-editing),
 *   - `sourceAppliedEditCount` — successful SOURCE edits for capture diagnostics.
 *
 * With a `NullStream` downstream (a non-observed run) the tap emits zero new
 * bytes, so the default-OFF posture stays byte-identical.
 */
import { relative, sep } from "node:path"
import { isVerifyOutputFailing, isVerifySignalCommand, mutatingToolKind } from "@/agent"
import { isTestFilePath } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { normalizeRepoPath } from "./impacted-test-discovery"
import { isBenchReproArtifactPath } from "./repro-artifacts"

type ToolCallEvent = Extract<AgentEvent, { type: "tool_call" }>
type ToolResultEvent = Extract<AgentEvent, { type: "tool_result" }>

/** Does an edit target a file that would SURVIVE into the source-only diff? This
 *  MUST agree with `snapshot.ts` `sourceOnlyDiff` EXACTLY (same `isTestFilePath`
 *  SSOT + bench-repro-artifact strip, NOTHING else) — if the count-predicate and
 *  the survival-predicate disagree, a real source edit lost to a fork desync gets
 *  miscounted ⇒ classified `empty-no-work` ⇒ a genuine infra failure is laundered
 *  as a model miss in the solve-rate denominator.
 *
 *  Bench repro scripts and their `.pytest-report.json` sidecars never survive
 *  into the source patch, so an edit to one must not count as source work either.
 *
 *  NOTE: there is deliberately NO `/tmp` rule. `sourceOnlyDiff` has none either —
 *  it identifies scratch via git-tree membership, not path strings. A previous
 *  `includes("/tmp/")` arm broke the contract two ways: it false-excluded an
 *  in-tree `src/tmp/x.py`, and it collapsed `sourceEditCount` to 0 for an entire
 *  run when the sandbox itself is rooted under `/tmp` (a common CI/EC2 layout) —
 *  re-creating the exact laundered-infra confound this guard exists to fence.
 *  `isTestFilePath` matches on segment boundaries, so an absolute sandbox path is
 *  classified correctly without prefix stripping. */
export const isSourceEditPath = (raw: string): boolean => {
  const rel = normalizeRepoPath(raw)
  if (rel === "") return false
  if (isTestFilePath(rel)) return false
  if (isBenchReproArtifactPath(rel)) return false
  return true
}

/**
 * Target path of a single file-mutating tool_call, or undefined for non-edit
 * tools / unparseable input. The mutating set is read from the
 * `write_filesystem` classification in `MUTATING_TOOL_TABLE` (the SSOT — never a
 * private re-list), so a newly added edit tool is captured the moment it is
 * classified there. Path is raw (relativization is the caller's concern — only
 * the caller knows the sandbox root).
 */
export const editTargetOf = (name: string, input: unknown): string | undefined => {
  if (mutatingToolKind(name) !== "write_filesystem") return undefined
  if (typeof input !== "object" || input === null) return undefined
  const o = input as Record<string, unknown>
  for (const key of ["file_path", "path", "notebook_path"]) {
    const v = o[key]
    if (typeof v === "string" && v !== "") return v
  }
  // apply_patch (V4A): pull the first touched path out of the patch body.
  const patch = o.patch ?? o.input ?? o.diff
  if (typeof patch === "string") {
    const m =
      patch.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m) ??
      patch.match(/^[+]{3}\s+(?:b\/)?(\S+)/m)
    if (typeof m?.[1] === "string" && m[1] !== "") return m[1]
  }
  return undefined
}

/**
 * Relativize a captured edit path against the sandbox root, normalising to
 * forward slashes so it matches gold patch paths (always repo-relative). A path
 * that is already relative, or resolves outside the sandbox, is returned
 * normalised-but-unchanged rather than guessed at.
 */
export const relFromSandbox = (sandbox: string, p: string | undefined): string | undefined => {
  if (p === undefined) return undefined
  const fwd = (s: string): string => s.split(sep).join("/")
  if (!p.startsWith("/")) return fwd(p)
  const rel = relative(sandbox, p)
  if (rel === "" || rel.startsWith("..")) return fwd(p)
  return fwd(rel)
}

/** Max actions retained in {@link BenchStreamTap.actionTrace} (most-recent window).
 *  Bounds prompt size + memory; the convergence tail is the informative part. */
export const ACTION_TRACE_CAP = 40

export class BenchStreamTap implements StreamPort {
  lastVerifyCmd: string | undefined
  lastErrorMessage: string | undefined
  /** Target of the FIRST file-mutating tool_call (raw, pre-relativization). */
  firstEditFile: string | undefined
  /** 1-based turn index at the first mutating edit (localize latency). */
  turnsToFirstEdit: number | undefined
  /** Count of file-mutating tool_calls across the run (churn). */
  editCount = 0
  /** Count of mutating tool_calls that targeted a SOURCE file (not tests/scratch).
   *  Attempt/churn signal only: a later tool_result still decides whether the
   *  edit actually landed. */
  sourceEditCount = 0
  /** Count of file-mutating tool_results that succeeded. Failed/denied/blocked
   *  edit attempts must not create a false `lost-edits` capture diagnosis. */
  appliedEditCount = 0
  /** Successful SOURCE edit count. This is the only edit counter safe for
   *  done-time source-capture classification. */
  sourceAppliedEditCount = 0
  /** Bounded ACTION TRACE (`<tool> <target/cmd-head>` per call) — the agent's
   *  what-it-did sequence for the LLM reviewer (SWE-agent reviewer parity). Tool
   *  NAMES + targets/command-heads only (NO observation bodies / file contents), so
   *  the leak surface is the agent's own public actions. Capped at
   *  {@link ACTION_TRACE_CAP} (keeps the most RECENT actions — the convergence tail
   *  is the most informative). Recording only; never alters control flow. */
  readonly actionTrace: string[] = []
  private currentTurn = 0
  /** tool_call ids whose invocation was a VERIFY (test_runner / test-like bash),
   *  awaiting their `tool_result` to decide pass/fail. Only populated when
   *  `onVerifyPass` is wired (P0 tentative-patch retention) — absent ⇒ empty ⇒
   *  byte-identical to the pre-feature tap. */
  private readonly pendingVerify = new Set<string>()
  /** VERIFY routing is two-phase: the tool_call tells us this invocation is a
   *  verifier candidate, but ONLY the later `tool_result.executedCommand` is
   *  authoritative for what actually ran. This prevents denied or non-verify
   *  bash calls from poisoning the validator re-exec target. */
  private readonly pendingVerifyCmd = new Set<string>()
  /** id → raw file path, so tool_result can report the target alongside ok/fail. */
  private readonly pendingEdits = new Map<string, string>()
  private readonly pendingSourceEdits = new Set<string>()
  private verifySeq = 0
  /**
   * @param downstream  pass-through sink (NullStream for non-observed runs).
   * @param onVerifyPass  P0 hook — called once each time a VERIFY tool_result
   *   comes back passing (`ok` AND no failure marker in its output). The driver
   *   wires this to snapshot the sandbox diff as a verified-green tentative
   *   candidate. Absent ⇒ no verify-pass tracking ⇒ byte-identical.
   */
  constructor(
    private readonly downstream: StreamPort,
    private readonly onVerifyPass?: (seq: number) => void,
    private readonly verifyAuthorityCommands?: readonly string[],
    /** Optional per-action progress sink. Wired in the bench path to logger.info
     *  so the box `run.log` shows WHAT the agent is doing live (edit <file> /
     *  bash <cmd> / read …) under concurrency, instead of ~15min of silence
     *  between the ▶ start and ■ done lines. Absent ⇒ byte-identical (no emit). */
    private readonly onAction?: (name: string, detail: string) => void,
    /** Optional per-tool-result observer. Called once per tool_result event with
     *  the tool name, success flag, timing/exit-code when available, and for
     *  file-mutating tools the target `file` path. Wired by the bench debug-sink
     *  path to record per-turn toolExec slices. */
    private readonly onToolResult?: (args: {
      name: string
      ok: boolean
      file?: string
      durationMs?: number
      exitCode?: number
    }) => void,
  ) {}

  /** Concise human detail for an action line: edit→target file, bash→command
   *  head, else the first string arg. Truncated so run.log stays one line/action. */
  private actionDetailOf(name: string, input: unknown): string {
    const edit = editTargetOf(name, input)
    if (edit !== undefined) return edit
    if (typeof input === "object" && input !== null) {
      const o = input as Record<string, unknown>
      for (const k of ["command", "path", "file_path", "query", "pattern", "url"]) {
        const v = o[k]
        if (typeof v === "string" && v !== "") return v.replace(/\s+/g, " ").slice(0, 80)
      }
    }
    return ""
  }
  /** A verify tool_call — `test_runner`, or a `bash` whose command is test-like
   *  OR exactly matches a caller-declared verifier authority command
   *  (e.g. bench `instance.testCmd`). */
  private isVerifyCall(name: string, input: unknown): boolean {
    if (name === "test_runner") return true
    if (name === "bash" && typeof input === "object" && input !== null && "command" in input) {
      const cmd = (input as { command: unknown }).command
      return typeof cmd === "string" && isVerifySignalCommand(cmd, this.verifyAuthorityCommands)
    }
    return false
  }

  private handleToolCall(event: ToolCallEvent): void {
    const detail = this.actionDetailOf(event.name, event.input)
    if (this.onAction !== undefined) this.onAction(event.name, detail)
    // Record the action for the reviewer trace (most-recent window, bounded).
    this.actionTrace.push(detail !== "" ? `${event.name} ${detail}` : event.name)
    if (this.actionTrace.length > ACTION_TRACE_CAP) this.actionTrace.shift()
    this.trackVerifyCall(event)
    this.trackEditCall(event)
  }

  private trackVerifyCall(event: ToolCallEvent): void {
    if (!this.isVerifyCall(event.name, event.input)) return
    this.pendingVerifyCmd.add(event.id)
    if (this.onVerifyPass !== undefined) this.pendingVerify.add(event.id)
  }

  private trackEditCall(event: ToolCallEvent): void {
    const editPath = editTargetOf(event.name, event.input)
    if (editPath === undefined) return
    this.editCount += 1
    const isSource = isSourceEditPath(editPath)
    if (isSource) this.sourceEditCount += 1
    this.pendingEdits.set(event.id, editPath)
    if (isSource) this.pendingSourceEdits.add(event.id)
    if (this.firstEditFile !== undefined) return
    this.firstEditFile = editPath
    this.turnsToFirstEdit = this.currentTurn
  }

  private handleToolResult(event: ToolResultEvent): void {
    const file = this.pendingEdits.get(event.id)
    this.trackAppliedEditResult(event)
    this.trackVerifyResult(event)
    this.onToolResult?.({
      name: event.name,
      ok: event.ok,
      ...(file !== undefined ? { file } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
    })
  }

  private trackAppliedEditResult(event: ToolResultEvent): void {
    const hadEdit = this.pendingEdits.delete(event.id)
    const hadSourceEdit = this.pendingSourceEdits.delete(event.id)
    if (!hadEdit || !event.ok) return
    this.appliedEditCount += 1
    if (hadSourceEdit) this.sourceAppliedEditCount += 1
  }

  private trackVerifyResult(event: ToolResultEvent): void {
    // P0 — a VERIFY that came back passing marks the CURRENT tree as a
    // verified-green candidate. `ok` = the runner executed; the output check
    // catches "exited 0 but tests failed" (same SSOT the verify-guard uses).
    const hasVerifyCmdCall = this.pendingVerifyCmd.delete(event.id)
    const hasAuthoritativeVerifyCmd =
      hasVerifyCmdCall && typeof event.executedCommand === "string" && event.executedCommand !== ""
    if (hasAuthoritativeVerifyCmd) {
      this.lastVerifyCmd = event.executedCommand
    }
    if (
      this.onVerifyPass !== undefined &&
      this.pendingVerify.delete(event.id) &&
      hasAuthoritativeVerifyCmd &&
      event.ok &&
      !isVerifyOutputFailing(event.name, undefined, event.preview)
    ) {
      this.onVerifyPass(this.verifySeq++)
    }
  }

  emit(event: AgentEvent): void {
    if (event.type === "turn_start") {
      this.currentTurn = event.turn
    } else if (event.type === "tool_call") {
      this.handleToolCall(event)
    } else if (event.type === "tool_result") {
      this.handleToolResult(event)
    } else if (event.type === "error") {
      this.lastErrorMessage = event.message
    }
    this.downstream.emit(event)
  }
}
