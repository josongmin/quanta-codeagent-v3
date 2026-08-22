/**
 * `dockerRunViaCli` — the REAL {@link DockerRun} for the standalone (non-orchestrator)
 * terminal backend (RFC P2 remainder). It shells out to the `docker` CLI so quanta can drive a
 * plain local container directly, with NO external orchestrator.
 *
 * Composition (the standalone path):
 *   `dockerContainerExec(containerId, dockerRunViaCli())`  →  a {@link ContainerExec}
 * The backend (`docker-backend.ts`) owns the `exec <ctr> sh -lc <cmd>` argv shape; THIS module owns
 * (a) prepending the `docker` binary + spawning, and (b) container LIFECYCLE (`run` / `rm`) with an
 * orphan-reap guard. The split keeps the backend pure (no spawn) and this file the only spawner.
 *
 * Container-bound by construction (spec S3): every exec runs INSIDE the container via `docker exec`
 * — there is NO host-bash path here. We never build a host-shell argv; the only commands we emit are
 * `docker exec|run|rm`. Do not add a host fallback.
 *
 * Daemon-free testability: the subprocess boundary is the injected {@link SpawnPort}. Tests pass a
 * fake that records argv + scripts stdout/stderr/exit, so the argv-builders, result-mapping, abort
 * threading, and end-to-end composition are all unit-provable WITHOUT a docker daemon. The default
 * port wraps `Bun.spawn` (mirroring `@/storage/git-runner`'s drain + abort→kill + finally-unhook).
 */
import { scrubEnv } from "@/runtime"
import type { DockerRun } from "./docker-backend"
import type { ContainerExecResult } from "./port"

/** Drained result of one spawned process. Mirrors {@link ContainerExecResult} but stdout/stderr are
 *  ALWAYS strings here — a CLI spawn yields concrete streams (the null-coercion concern is the IPC
 *  bridge's, not ours). `code` is the process exit code (the completion signal). `timedOut` (B1,
 *  RFC jul-3) marks a WALL-CLOCK kill: the process was killed by the deadline timer, `code` is the
 *  kill exit, and stdout/stderr hold the PARTIAL bytes drained up to the kill (real partials — the
 *  streams are piped + drained concurrently, so a killed process yields what it wrote so far). */
export interface SpawnResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
  readonly timedOut?: boolean
}

/** Injected subprocess boundary — full argv (binary first) + optional abort + optional wall-clock
 *  deadline → drained result. REJECTS only on a spawn-level failure (binary missing, daemon socket
 *  down); a non-zero EXIT is a normal `SpawnResult` (resolves). `timeoutMs` overrides the module
 *  default deadline ({@link defaultDockerSpawn} keeps a 60s backstop either way — this spawner also
 *  serves `docker run`/`rm` lifecycle calls, which must never hang the host). The default wraps
 *  `Bun.spawn`. */
export type SpawnPort = (
  argv: readonly string[],
  signal?: AbortSignal,
  timeoutMs?: number,
) => Promise<SpawnResult>

/**
 * Container lifecycle over the same injected spawner — the standalone backend needs to BRING UP a
 * container (so there is something for `docker exec` to target) and TEAR IT DOWN. `dockerRunViaCli`
 * returns a callable {@link DockerRun} that ALSO carries these methods, so one factory drives both
 * exec (the call signature) and lifecycle (the methods).
 */
export interface DockerLifecycle {
  /** `docker run -d --rm <image> sleep infinity` → the new container id (stdout, trimmed). `--rm`
   *  is the orphan guard: the box self-reaps when its keep-alive (`sleep infinity`) is killed, so a
   *  crashed host process can't leak a running container. Rejects on a non-zero `docker run`. */
  run(image: string): Promise<string>
  /** `docker rm -f <id>` — explicit reap. BEST-EFFORT: a non-zero exit (already gone) does NOT
   *  throw (reaping an absent box is success). Rejects only on a spawn-level failure. */
  rm(id: string): Promise<void>
}

/** The factory's product: the {@link DockerRun} call signature PLUS the {@link DockerLifecycle}
 *  methods, on one object. Callers wanting just the port use it as a `DockerRun`; the standalone
 *  entry-point also uses `.run` / `.rm`. */
export type DockerRunner = DockerRun & DockerLifecycle

/** Token guard for image refs / container ids handed to the CLI: alnum + `_.-/:@` (image refs carry
 *  `/` `:` `@` for registry/tag/digest), NO leading `-`. The argv has no shell, but a leading `-`
 *  could be read as a `docker` FLAG (e.g. `--privileged`) — reject flag-injection at the boundary.
 *  (The backend applies its own stricter id guard to `exec` targets; this covers `run`/`rm` args.) */
const SAFE_REF = /^[a-zA-Z0-9][a-zA-Z0-9_.\-/:@]{0,255}$/

const DEFAULT_TIMEOUT_MS = 60_000

/** Env the host-side `docker` CLI needs to reach the daemon — and NOTHING that carries provider
 *  credentials. The in-container command gets the CONTAINER's own env (we pass no `-e`), so the host
 *  `docker` process never needs `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / tokens. Mirrors the
 *  credential-fence hygiene of `@/tool/gh`'s runner (which also `scrubEnv`s). `DOCKER_HOST` / TLS
 *  vars select + authenticate the daemon endpoint (local socket or a remote engine). */
const DOCKER_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
])

/** Default {@link SpawnPort} — `Bun.spawn(argv)` with piped streams, fully drained before resolving
 *  (no partial reads), a bounded wall-clock, abort→kill (the spawned `docker` is killed on abort
 *  rather than orphaned until the timeout), and a SCRUBBED env (provider creds never reach the host
 *  `docker` process). The abort listener is unhooked in `finally` so a long-lived signal never leaks
 *  listeners. Pattern lifted from `@/storage/git-runner` + `@/tool/gh`'s credential fence. */
export const defaultDockerSpawn: SpawnPort = async (argv, signal, timeoutMs) => {
  const proc = Bun.spawn(argv as string[], {
    stdout: "pipe",
    stderr: "pipe",
    env: scrubEnv(DOCKER_ENV_ALLOWLIST),
  })
  const kill = (): void => {
    try {
      proc.kill()
    } catch {
      // already exited — ignore
    }
  }
  // B1 (RFC jul-3): the wall-clock kill is now TYPED — `timedOut: true` on the result — instead of
  // the prior SILENT kill (indistinguishable from a normal exit; jul-3 audit R2-A). The caller's
  // `timeoutMs` overrides the 60s module backstop (the backstop stays: this spawner also serves
  // `docker run`/`rm`, which must never hang the host). Killing the pipes resolves the drains with
  // the bytes collected so far, so a timed-out exec surfaces REAL partial output.
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, timeoutMs ?? DEFAULT_TIMEOUT_MS)
  let onAbort: (() => void) | undefined
  if (signal !== undefined) {
    if (signal.aborted) kill()
    else {
      onAbort = kill
      signal.addEventListener("abort", onAbort, { once: true })
    }
  }
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    return { stdout, stderr, code, ...(timedOut ? { timedOut: true } : {}) }
  } finally {
    clearTimeout(timer)
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort)
  }
}

/**
 * Build the standalone {@link DockerRunner}: a real `DockerRun` (shells `docker <argv>` via the
 * injected `spawn`) carrying container lifecycle. The default `spawn` is the real one; tests inject
 * a fake. The returned function maps the spawner's `SpawnResult` straight onto `ContainerExecResult`
 * (a non-zero exit RESOLVES — the container_exec completion-signal contract; only a spawn-level
 * failure rejects).
 */
export const dockerRunViaCli = (spawn: SpawnPort = defaultDockerSpawn): DockerRunner => {
  // The DockerRun call: prepend the `docker` binary to the backend-built argv, spawn, map result
  // (incl. the typed `timedOut` deadline marker — B1).
  const runner = ((
    argv: readonly string[],
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<ContainerExecResult> =>
    spawn(["docker", ...argv], signal, timeoutMs).then((r) => ({
      stdout: r.stdout,
      stderr: r.stderr,
      code: r.code,
      ...(r.timedOut === true ? { timedOut: true } : {}),
    }))) as DockerRunner

  runner.run = async (image: string): Promise<string> => {
    if (!SAFE_REF.test(image)) {
      throw new Error(`dockerRunViaCli.run: invalid image ref: ${image}`)
    }
    // `-d` detached, `--rm` self-reap on stop, keep-alive so `docker exec` has a live target.
    const r = await spawn(["docker", "run", "-d", "--rm", image, "sleep", "infinity"])
    if (r.code !== 0) {
      throw new Error(`docker run failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`)
    }
    const id = r.stdout.trim()
    if (id === "") throw new Error("docker run: empty container id on stdout")
    return id
  }

  runner.rm = async (id: string): Promise<void> => {
    if (!SAFE_REF.test(id)) {
      throw new Error(`dockerRunViaCli.rm: invalid container id: ${id}`)
    }
    // Best-effort reap: ignore a non-zero exit (already gone). Only a spawn-level failure rejects.
    await spawn(["docker", "rm", "-f", id])
  }

  return runner
}
