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
 *   - `editCount`      — F6 churn signal (#10914-class over-editing).
 *
 * With a `NullStream` downstream (a non-observed run) the tap emits zero new
 * bytes, so the default-OFF posture stays byte-identical.
 */
import { relative, sep } from "node:path"
import { isTestLikeCommand, isVerifyOutputFailing, mutatingToolKind } from "@/agent"
import type { AgentEvent, StreamPort } from "@/stream"

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

export class BenchStreamTap implements StreamPort {
  lastVerifyCmd: string | undefined
  lastErrorMessage: string | undefined
  /** Target of the FIRST file-mutating tool_call (raw, pre-relativization). */
  firstEditFile: string | undefined
  /** 1-based turn index at the first mutating edit (localize latency). */
  turnsToFirstEdit: number | undefined
  /** Count of file-mutating tool_calls across the run (churn). */
  editCount = 0
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
  ) {}
  /** A verify tool_call — `test_runner`, or a `bash` whose command is test-like
   *  (`isTestLikeCommand`, the SSOT verify-signal matcher the validator uses). */
  private isVerifyCall(name: string, input: unknown): boolean {
    if (name === "test_runner") return true
    if (name === "bash" && typeof input === "object" && input !== null && "command" in input) {
      const cmd = (input as { command: unknown }).command
      return typeof cmd === "string" && isTestLikeCommand(cmd)
    }
    return false
  }
  emit(event: AgentEvent): void {
    if (event.type === "turn_start") {
      this.currentTurn = event.turn
    } else if (event.type === "tool_call") {
      if (this.isVerifyCall(event.name, event.input)) {
        this.pendingVerifyCmd.add(event.id)
      }
      if (this.onVerifyPass !== undefined && this.isVerifyCall(event.name, event.input)) {
        this.pendingVerify.add(event.id)
      }
      const editPath = editTargetOf(event.name, event.input)
      if (editPath !== undefined) {
        this.editCount += 1
        if (this.firstEditFile === undefined) {
          this.firstEditFile = editPath
          this.turnsToFirstEdit = this.currentTurn
        }
      }
    } else if (event.type === "tool_result") {
      // P0 — a VERIFY that came back passing marks the CURRENT tree as a
      // verified-green candidate. `ok` = the runner executed; the output check
      // catches "exited 0 but tests failed" (same SSOT the verify-guard uses).
      const hasVerifyCmdCall = this.pendingVerifyCmd.delete(event.id)
      const hasAuthoritativeVerifyCmd =
        hasVerifyCmdCall &&
        typeof event.executedCommand === "string" &&
        event.executedCommand !== ""
      if (hasAuthoritativeVerifyCmd) {
        this.lastVerifyCmd = event.executedCommand
      }
      if (this.onVerifyPass !== undefined && this.pendingVerify.delete(event.id)) {
        if (
          hasAuthoritativeVerifyCmd &&
          event.ok &&
          !isVerifyOutputFailing(event.name, undefined, event.preview)
        ) {
          this.onVerifyPass(this.verifySeq++)
        }
      }
    } else if (event.type === "error") {
      this.lastErrorMessage = event.message
    }
    this.downstream.emit(event)
  }
}
