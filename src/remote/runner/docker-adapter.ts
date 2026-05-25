/**
 * ADR-0289 — Docker adapter for the {@link RemoteRunner} port.
 *
 * Shells out to `docker` CLI (no SDK / Dockerode dependency — see Constraint
 * "외부 lib install 없이 docker / lima / apple-vz CLI shell-out"). The
 * underlying process is provided via an INJECTED `DockerProcess` seam so
 * hellgate tests can drive every branch without a live daemon.
 *
 * Mapping to docker CLI:
 *   - `spawn(spec)`           → `docker run -d --name {handle} [env] [mounts] [opts] image cmd…`
 *   - `status(handle)`        → `docker inspect --format '{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}' {handle}`
 *   - `cancel(handle)`        → `docker stop {handle}` then `docker rm {handle}`
 *   - `logs(handle, opts)`    → `docker logs -f [--since=ts] {handle}` (stream)
 *
 * Hellgate coverage (`tests/unit/remote/docker-adapter-hellgate.test.ts`):
 *   - Daemon down → `daemon-unavailable` (HELL-DK-05).
 *   - Image pull fail → `image-not-found` (HELL-DK-06).
 *   - OOM kill → `failed` with `reason="oom"` (HELL-DK-07).
 *   - Network-disabled spec → `--network=none` flag (HELL-DK-08).
 *   - Concurrent spawn isolation (HELL-DK-14).
 *   - 1000-cycle zombie-free (HELL-DK-15).
 */

import { ok, err, type Result } from "@/shared"
import type { RemoteRunner } from "./port"
import {
  RemoteError,
  type RemoteHandle,
  type RemoteLogsOpts,
  type RemoteSpec,
  type RemoteStatus,
  type RemoteStatusKind,
} from "./types"
import { validateSpec } from "./validate"

/* ------------------------------------------------------------------ */
/* Injected process seam                                               */
/* ------------------------------------------------------------------ */

/** Single-shot command result. */
export interface DockerExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Streaming command — yields stdout lines until the iterator ends or the
 *  caller breaks. */
export type DockerLogStream = AsyncIterable<string>

/**
 * Process injection seam. Adapter NEVER calls `child_process` directly —
 * the composition root supplies a real shell-out implementation
 * (`createDefaultDockerProcess()`) and tests supply a mock.
 */
export interface DockerProcess {
  exec(argv: readonly string[]): Promise<DockerExecResult>
  stream(argv: readonly string[], signal?: AbortSignal | undefined): DockerLogStream
}

export interface DockerAdapterOpts {
  readonly process: DockerProcess
  /** Handle id namespace prefix. Defaults to `quanta-remote`. */
  readonly namePrefix?: string
  /** UUID generator (test injection). Default: `crypto.randomUUID()`. */
  readonly uuid?: () => string
  /** Clock for `RemoteStatus.observedAtMs`. */
  readonly nowMs?: () => number
}

/* ------------------------------------------------------------------ */
/* Argv composition (pure)                                             */
/* ------------------------------------------------------------------ */

/** Compose `docker run` argv from a spec + handle name.
 *
 *  Network policy: when `--network=none` is requested via
 *  `RemoteSpec.env.QUANTA_REMOTE_NETWORK = "none"` we inject `--network=none`.
 *  Otherwise the default docker network is used. */
export const composeDockerRunArgv = (
  spec: RemoteSpec,
  name: string,
): readonly string[] => {
  const argv: string[] = ["docker", "run", "-d", "--name", name]

  // env flags — `-e KEY` (no value) deletes inherited env vars.
  if (spec.env !== undefined && spec.env !== null) {
    for (const [k, v] of Object.entries(spec.env)) {
      if (v === null) {
        argv.push("-e", k)
        continue
      }
      // Network flag is hoisted out of env into a real `--network=none`.
      if (k === "QUANTA_REMOTE_NETWORK" && v === "none") continue
      argv.push("-e", `${k}=${v}`)
    }
    if (spec.env["QUANTA_REMOTE_NETWORK"] === "none") {
      argv.push("--network=none")
    }
  }

  // mounts
  if (spec.mounts !== undefined) {
    for (const m of spec.mounts) {
      const flag = m.readonly === true ? `${m.source}:${m.target}:ro` : `${m.source}:${m.target}`
      argv.push("-v", flag)
    }
  }

  if (spec.workdir !== undefined) argv.push("-w", spec.workdir)
  argv.push(spec.image, ...spec.cmd)
  return argv
}

/* ------------------------------------------------------------------ */
/* Status parsing (pure)                                               */
/* ------------------------------------------------------------------ */

/** Parse `docker inspect --format` output of the form
 *  `<status>|<exitCode>|<oomKilled>`.
 *
 *  Maps docker `State.Status` to our 5-arm union:
 *   - `created` / `restarting`               → `pending`
 *   - `running` / `paused`                   → `running`
 *   - `exited`  + exit 0                     → `succeeded`
 *   - `exited`  + exit ≠ 0                   → `failed` (`reason="oom"` if OOM)
 *   - `dead`                                 → `failed`
 *   - `removing`                             → `cancelled`
 */
export const parseDockerInspectLine = (
  line: string,
): { kind: RemoteStatusKind; exitCode: number | undefined; reason: string | undefined } => {
  const parts = line.trim().split("|")
  const dockerStatus = parts[0] ?? ""
  const exitRaw = parts[1] ?? "0"
  const oom = parts[2] === "true"
  const exitCode = Number.parseInt(exitRaw, 10)
  const exitOrUndef = Number.isFinite(exitCode) ? exitCode : undefined
  switch (dockerStatus) {
    case "created":
    case "restarting":
      return { kind: "pending", exitCode: undefined, reason: undefined }
    case "running":
    case "paused":
      return { kind: "running", exitCode: undefined, reason: undefined }
    case "exited": {
      if (exitOrUndef === 0) return { kind: "succeeded", exitCode: 0, reason: undefined }
      return {
        kind: "failed",
        exitCode: exitOrUndef,
        reason: oom ? "oom" : "non-zero-exit",
      }
    }
    case "dead":
      return { kind: "failed", exitCode: exitOrUndef, reason: oom ? "oom" : "dead" }
    case "removing":
      return { kind: "cancelled", exitCode: exitOrUndef, reason: undefined }
    default:
      return { kind: "failed", exitCode: exitOrUndef, reason: "unknown" }
  }
}

/* ------------------------------------------------------------------ */
/* stderr → RemoteErrorKind classification (pure)                      */
/* ------------------------------------------------------------------ */

/** Classify `docker run` stderr into a RemoteErrorKind. */
export const classifyDockerStderr = (stderr: string): {
  kind: "daemon-unavailable" | "image-not-found" | "transport"
  message: string
} => {
  const lower = stderr.toLowerCase()
  if (
    lower.includes("cannot connect to the docker daemon") ||
    lower.includes("is the docker daemon running") ||
    lower.includes("docker daemon socket")
  ) {
    return { kind: "daemon-unavailable", message: stderr.trim() }
  }
  if (
    lower.includes("manifest unknown") ||
    lower.includes("pull access denied") ||
    lower.includes("not found: manifest") ||
    lower.includes("repository does not exist")
  ) {
    return { kind: "image-not-found", message: stderr.trim() }
  }
  return { kind: "transport", message: stderr.trim() }
}

/* ------------------------------------------------------------------ */
/* Adapter                                                              */
/* ------------------------------------------------------------------ */

interface CachedState {
  status: RemoteStatusKind
  exitCode: number | undefined
  reason: string | undefined
  observedAtMs: number
  terminal: boolean
}

export const createDockerAdapter = (opts: DockerAdapterOpts): RemoteRunner => {
  const proc = opts.process
  const prefix = opts.namePrefix ?? "quanta-remote"
  const uuid = opts.uuid ?? (() => crypto.randomUUID())
  const nowMs = opts.nowMs ?? (() => Date.now())
  const cache = new Map<string, CachedState>()
  const known = new Set<string>()

  // HELL-DK-11: naming collision retry — if `docker run` reports a name
  // conflict we suffix and retry up to 3 times.
  const allocName = (): string => `${prefix}-${uuid()}`

  const cacheUpdate = (id: string, parsed: ReturnType<typeof parseDockerInspectLine>): void => {
    const terminal =
      parsed.kind === "succeeded" || parsed.kind === "failed" || parsed.kind === "cancelled"
    cache.set(id, {
      status: parsed.kind,
      exitCode: parsed.exitCode,
      reason: parsed.reason,
      observedAtMs: nowMs(),
      terminal,
    })
  }

  return {
    async spawn(spec: RemoteSpec): Promise<Result<RemoteHandle, RemoteError>> {
      const validation = validateSpec(spec)
      if (!validation.ok) return err(validation.error)

      // HELL-RR-07: timeout 0 → never spawn; emit terminal-failed immediately.
      if (spec.timeoutMs === 0) {
        const id = allocName()
        known.add(id)
        cache.set(id, {
          status: "failed",
          exitCode: undefined,
          reason: "timeout",
          observedAtMs: nowMs(),
          terminal: true,
        })
        return ok({ id, backend: "docker" })
      }

      if (spec.signal?.aborted === true) {
        return err(new RemoteError("cancelled", "aborted pre-spawn", "docker"))
      }

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const name = allocName()
        const argv = composeDockerRunArgv(spec, name)
        const result = await proc.exec(argv)
        if (result.exitCode === 0) {
          known.add(name)
          cache.set(name, {
            status: "pending",
            exitCode: undefined,
            reason: undefined,
            observedAtMs: nowMs(),
            terminal: false,
          })
          return ok({ id: name, backend: "docker" })
        }
        // Naming collision → loop; otherwise classify + return.
        const lower = result.stderr.toLowerCase()
        const collision =
          lower.includes("is already in use by container") ||
          lower.includes("conflict. the container name")
        if (collision) continue
        const cls = classifyDockerStderr(result.stderr)
        return err(new RemoteError(cls.kind, cls.message, "docker"))
      }
      return err(new RemoteError("transport", "naming collision retry exhausted", "docker"))
    },

    async status(handle: RemoteHandle): Promise<Result<RemoteStatus, RemoteError>> {
      if (!known.has(handle.id)) {
        return err(new RemoteError("unknown-handle", handle.id, "docker"))
      }
      const cached = cache.get(handle.id)
      if (cached !== undefined && cached.terminal) {
        return ok({
          kind: cached.status,
          exitCode: cached.exitCode,
          reason: cached.reason,
          observedAtMs: cached.observedAtMs,
        })
      }
      const argv = [
        "docker",
        "inspect",
        "--format",
        "{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}",
        handle.id,
      ]
      const result = await proc.exec(argv)
      if (result.exitCode !== 0) {
        const cls = classifyDockerStderr(result.stderr)
        return err(new RemoteError(cls.kind, cls.message, "docker"))
      }
      const parsed = parseDockerInspectLine(result.stdout)
      cacheUpdate(handle.id, parsed)
      return ok({
        kind: parsed.kind,
        exitCode: parsed.exitCode,
        reason: parsed.reason,
        observedAtMs: nowMs(),
      })
    },

    async cancel(handle: RemoteHandle): Promise<Result<void, RemoteError>> {
      if (!known.has(handle.id)) {
        return err(new RemoteError("unknown-handle", handle.id, "docker"))
      }
      const cached = cache.get(handle.id)
      // HELL-RR-11: idempotent — terminal handle returns ok without reissuing.
      if (cached !== undefined && cached.terminal) return ok(undefined)
      const stop = await proc.exec(["docker", "stop", handle.id])
      // best-effort rm even when stop reports non-zero
      await proc.exec(["docker", "rm", "-f", handle.id])
      cache.set(handle.id, {
        status: "cancelled",
        exitCode: undefined,
        reason: stop.exitCode === 0 ? "user-cancel" : "force-rm",
        observedAtMs: nowMs(),
        terminal: true,
      })
      return ok(undefined)
    },

    async *logs(handle: RemoteHandle, logOpts: RemoteLogsOpts = {}): AsyncIterable<string> {
      if (!known.has(handle.id)) return
      const argv = ["docker", "logs", "-f"]
      if (logOpts.since !== undefined) {
        const isoSec = Math.floor(logOpts.since / 1000)
        argv.push(`--since=${isoSec}`)
      }
      argv.push(handle.id)
      const stream = proc.stream(argv, logOpts.signal)
      try {
        for await (const line of stream) {
          if (logOpts.signal?.aborted === true) return
          yield line
        }
      } finally {
        // Iterator release — natural cleanup path for back-pressure.
      }
    },
  }
}
