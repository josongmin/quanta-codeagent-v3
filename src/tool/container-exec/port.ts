/**
 * `ContainerExec` — run a one-shot command INSIDE a bounded container, get its full result
 * (stdout + stderr + exit code). TB21-06 TC-1a (spec S3): a structured exec tool (the
 * edge product agents have over raw keystroke-typing) whose **exit code is the strongest
 * completion signal** — no pane-scraping / "is it done?" guesswork.
 *
 * Injected transport (the tool is paradigm-agnostic):
 *   - `dockerContainerExec` — `docker exec <ctr> sh -lc <command>` (standalone / local-dev).
 *   - an IPC bridge to the container orchestrator's own env-exec (the backend-agnostic path;
 *     wired by the entry-point adapter in `src/apps/`, which is where orchestrator specifics live).
 * General capability: NO specific benchmark/harness named here (ownership boundary).
 */

export interface ContainerExecResult {
  /** Captured stdout. NULLABLE: a real env-exec bridge (the orchestrator IPC path) may report
   *  `None`/absent for an empty stream — the tool coerces null→"" at the boundary. */
  readonly stdout: string | null
  /** Captured stderr. Nullable for the same reason as {@link stdout}. */
  readonly stderr: string | null
  /** Process exit code (the completion signal). */
  readonly code: number
  /** True iff the transport DEADLINE (`timeoutMs`) elapsed before the command completed and the
   *  result was synthesized/truncated by the transport (B1, RFC jul-3). The command did NOT run to
   *  completion: `code` is a kill/sentinel code (124 on the IPC path), `stdout`/`stderr` are whatever
   *  was salvaged (docker path) or empty (IPC path — the bridge is completion-only, so a timed-out
   *  exec has NO partial output by construction). Absent/false ⇒ a genuine completion. */
  readonly timedOut?: boolean
}

/** Run an arbitrary shell command in the bound container. NEVER the host.
 *  `signal` (optional) lets a caller abort a long-running exec mid-flight. Orphan-kill is
 *  BEST-EFFORT and transport-dependent: honouring the signal CAN terminate the process, but the
 *  `docker exec` backend only forwards it to the host-side runner — `docker exec` does not
 *  propagate a host kill into the container by default, so a real kill must be proven per-transport
 *  (P2: the IPC bridge / a Bun.spawn DockerRun with a red-on-injection reap test). A transport MAY
 *  instead resolve with the PARTIAL output collected so far + a code, which is surfaced normally.
 *
 *  `timeoutMs` (optional, B1 RFC jul-3) is a PER-COMMAND deadline the transport enforces itself
 *  (each transport knows how to bound its own wait and what it can salvage — a host-side race
 *  wrapper in the tool would discard transport partials and leak abort listeners). On expiry the
 *  transport RESOLVES with `timedOut: true` (never rejects/hangs) and best-effort-cancels the
 *  in-flight command; in-container orphan-kill remains the same best-effort caveat as `signal`.
 *  ABSENT or NON-POSITIVE (≤0) ⇒ NO deadline (byte-identical to the pre-B1 contract) — long builds
 *  are legitimate on this surface, so an implicit default kill is deliberately NOT part of the port
 *  contract. (The standalone docker transport keeps its OWN 60s host-side backstop regardless, so a
 *  wedged `docker exec` never hangs the host; that is a transport detail, not the port contract.) */
export interface ContainerExec {
  exec(command: string, signal?: AbortSignal, timeoutMs?: number): Promise<ContainerExecResult>
}
