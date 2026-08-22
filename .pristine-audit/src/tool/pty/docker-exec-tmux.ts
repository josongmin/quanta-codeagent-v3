/**
 * Container-bound {@link TmuxExec} (RFC jun-29 terminal surface, spec S3).
 *
 * The default tmux backend ({@link ./tmux-adapter} `createTmuxAdapter`) runs `tmux` on the
 * HOST. When an external terminal-operator drives a session INSIDE a Docker container, that is
 * wrong — every tmux call must hit the container, never the host. This wraps each `tmux <args>`
 * as `docker exec -i <container> tmux <args>` through an injected `dockerRun`, so the same
 * `createTmuxAdapter({ exec })` / `ptyTools(port)` stack becomes container-bound with zero
 * change to the tools or the adapter.
 *
 * `dockerRun` is injected (no process spawning here) — pure + unit-testable; the entry-point
 * adapter (in `src/apps/`) supplies the real `docker exec` runner + the containerId. General
 * capability: this module names NO specific benchmark/harness (ownership boundary).
 */
import type { TmuxExec } from "./tmux-adapter"

/** Runs a docker argv to completion → {ok, stdout}. Injected by the caller (the shim wires
 *  the real `docker`/exec runner). Mirrors `TmuxExec.run`'s result shape. */
export type DockerRun = (
  argv: readonly string[],
) => Promise<{ readonly ok: boolean; readonly stdout: string }>

/** A `docker exec` containerId is an id/name token (alnum + `_.-`). Reject shell metachars so a
 *  hostile/typo'd id can't smuggle extra args (defense-in-depth — argv has no shell, but a
 *  leading `-` could still be read as a docker flag). */
const CONTAINER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/

/** Build a container-bound TmuxExec: each `tmux <args>` → `docker exec -i <container> tmux <args>`.
 *  Throws on an invalid containerId (never spawns). */
export const dockerExecTmux = (containerId: string, dockerRun: DockerRun): TmuxExec => {
  if (!CONTAINER_ID.test(containerId)) {
    throw new Error(`dockerExecTmux: invalid container id: ${containerId}`)
  }
  return {
    run: (args) => dockerRun(["exec", "-i", containerId, "tmux", ...args]),
  }
}
