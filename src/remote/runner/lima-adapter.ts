/**
 * ADR-0289 — Lima adapter for the {@link RemoteRunner} port.
 *
 * Shells out to `limactl shell {vm} bash -c {cmd}` for the background
 * workload, then tracks lifecycle via a PID file stored in
 * `~/.quanta/remote/lima/{handle}.pid`.
 *
 * Like the docker adapter, the underlying process is INJECTED so tests can
 * drive every branch without a live `limactl`.
 *
 * Mapping (abbreviated — full pid-file ↔ status state machine intentionally
 * deferred to a follow-up ADR; this adapter is the minimum shell-out
 * surface required for the registry env-swap. Headless behaviour for
 * cancel/logs mirrors the docker adapter.):
 *   - `spawn(spec)`           → `limactl shell {vm} -- bash -c '<cmd> & echo $! > <pidfile>'`
 *   - `status(handle)`        → `limactl shell {vm} -- bash -c 'kill -0 $(cat pidfile)'`
 *   - `cancel(handle)`        → `limactl shell {vm} -- bash -c 'kill $(cat pidfile)'`
 *   - `logs(handle)`          → tail VM-side log file at `~/.quanta/remote/lima/{handle}.log`
 */

import { ok, err, type Result } from "@/shared"
import type { RemoteRunner } from "./port"
import {
  RemoteError,
  type RemoteHandle,
  type RemoteLogsOpts,
  type RemoteSpec,
  type RemoteStatus,
} from "./types"
import { validateSpec } from "./validate"

export interface LimaExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface LimaProcess {
  exec(argv: readonly string[]): Promise<LimaExecResult>
  stream(argv: readonly string[], signal?: AbortSignal | undefined): AsyncIterable<string>
}

export interface LimaAdapterOpts {
  readonly process: LimaProcess
  /** Name of the lima VM to drive. */
  readonly vm: string
  readonly namePrefix?: string
  readonly uuid?: () => string
  readonly nowMs?: () => number
}

export const createLimaAdapter = (opts: LimaAdapterOpts): RemoteRunner => {
  const proc = opts.process
  const vm = opts.vm
  const prefix = opts.namePrefix ?? "quanta-remote"
  const uuid = opts.uuid ?? (() => crypto.randomUUID())
  const nowMs = opts.nowMs ?? (() => Date.now())
  const known = new Set<string>()

  return {
    async spawn(spec: RemoteSpec): Promise<Result<RemoteHandle, RemoteError>> {
      const validation = validateSpec(spec)
      if (!validation.ok) return err(validation.error)
      if (spec.signal?.aborted === true) {
        return err(new RemoteError("cancelled", "aborted pre-spawn", "lima"))
      }
      const id = `${prefix}-${uuid()}`
      const cmd = [spec.image, ...spec.cmd].join(" ")
      const argv = [
        "limactl",
        "shell",
        vm,
        "--",
        "bash",
        "-c",
        `nohup ${cmd} > /tmp/${id}.log 2>&1 & echo $! > /tmp/${id}.pid`,
      ]
      const result = await proc.exec(argv)
      if (result.exitCode !== 0) {
        const lower = result.stderr.toLowerCase()
        if (lower.includes("not found") || lower.includes("no such command")) {
          return err(new RemoteError("daemon-unavailable", result.stderr, "lima"))
        }
        return err(new RemoteError("transport", result.stderr, "lima"))
      }
      known.add(id)
      return ok({ id, backend: "lima" })
    },

    async status(handle: RemoteHandle): Promise<Result<RemoteStatus, RemoteError>> {
      if (!known.has(handle.id)) {
        return err(new RemoteError("unknown-handle", handle.id, "lima"))
      }
      const argv = [
        "limactl",
        "shell",
        vm,
        "--",
        "bash",
        "-c",
        `kill -0 $(cat /tmp/${handle.id}.pid) 2>/dev/null && echo running || echo exited`,
      ]
      const result = await proc.exec(argv)
      if (result.exitCode !== 0) {
        return err(new RemoteError("transport", result.stderr, "lima"))
      }
      const kind = result.stdout.trim() === "running" ? "running" : "succeeded"
      return ok({ kind, exitCode: undefined, reason: undefined, observedAtMs: nowMs() })
    },

    async cancel(handle: RemoteHandle): Promise<Result<void, RemoteError>> {
      if (!known.has(handle.id)) {
        return err(new RemoteError("unknown-handle", handle.id, "lima"))
      }
      const argv = [
        "limactl",
        "shell",
        vm,
        "--",
        "bash",
        "-c",
        `kill $(cat /tmp/${handle.id}.pid) 2>/dev/null || true`,
      ]
      await proc.exec(argv)
      return ok(undefined)
    },

    async *logs(handle: RemoteHandle, logOpts: RemoteLogsOpts = {}): AsyncIterable<string> {
      if (!known.has(handle.id)) return
      const argv = ["limactl", "shell", vm, "--", "tail", "-f", `/tmp/${handle.id}.log`]
      const stream = proc.stream(argv, logOpts.signal)
      for await (const line of stream) {
        if (logOpts.signal?.aborted === true) return
        yield line
      }
    },
  }
}
