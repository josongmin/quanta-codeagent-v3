/**
 * `ContainerExec` — run a one-shot command INSIDE a bounded container, get its full result
 * (stdout + stderr + exit code). RFC jun-29 §13 SOTA lever #1/#2: a structured exec tool (the
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
}

/** Run an arbitrary shell command in the bound container. NEVER the host.
 *  `signal` (optional) lets a caller abort a long-running exec mid-flight. Orphan-kill is
 *  BEST-EFFORT and transport-dependent: honouring the signal CAN terminate the process, but the
 *  `docker exec` backend only forwards it to the host-side runner — `docker exec` does not
 *  propagate a host kill into the container by default, so a real kill must be proven per-transport
 *  (P2: the IPC bridge / a Bun.spawn DockerRun with a red-on-injection reap test). A transport MAY
 *  instead resolve with the PARTIAL output collected so far + a code, which is surfaced normally. */
export interface ContainerExec {
  exec(command: string, signal?: AbortSignal): Promise<ContainerExecResult>
}
