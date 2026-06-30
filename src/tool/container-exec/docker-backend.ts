/**
 * `docker exec`-backed {@link ContainerExec} — the standalone / local-dev transport (run a
 * command in a container you control). The orchestrator path uses a DIFFERENT impl (an IPC
 * bridge to the orchestrator's own env-exec, which is backend-agnostic) — see RFC §12. This one
 * is for driving a plain local container directly (no external orchestrator).
 *
 * `dockerRun` is injected (no spawning here) — pure + unit-testable.
 */
import type { ContainerExec, ContainerExecResult } from "./port"

/** Runs a docker argv → result. Injected by the caller (real `docker` runner). `signal` (when
 *  the caller threads it) is forwarded so the runner CAN terminate the spawned `docker exec` —
 *  best-effort (see ContainerExec.exec): killing the host-side `docker exec` does not by itself
 *  reap the in-container process, so a real reap needs a transport-level test when one lands. */
export type DockerRun = (
  argv: readonly string[],
  signal?: AbortSignal,
) => Promise<ContainerExecResult>

/** Container id/name token (alnum + `_.-`, no leading `-`) — reject metachars + flag-injection
 *  (argv has no shell, but a leading `-` could be read as a docker flag). */
const CONTAINER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/

/** Build a `docker exec`-bound ContainerExec: `exec(cmd)` → `docker exec <ctr> sh -lc <cmd>`.
 *  The command runs in the CONTAINER's shell (never host). Throws on an invalid id (no spawn). */
export const dockerContainerExec = (containerId: string, dockerRun: DockerRun): ContainerExec => {
  if (!CONTAINER_ID.test(containerId)) {
    throw new Error(`dockerContainerExec: invalid container id: ${containerId}`)
  }
  return {
    exec: (command, signal) => dockerRun(["exec", containerId, "sh", "-lc", command], signal),
  }
}
