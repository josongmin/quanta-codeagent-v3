/**
 * ADR-0289 — Lima adapter for the {@link RemoteRunner} port.
 *
 * Shells out to `limactl shell {vm} -- …` for the background workload, then
 * tracks lifecycle via a PID file stored under `/tmp/{handle}.pid`.
 *
 * Like the docker adapter, the underlying process is INJECTED so tests can
 * drive every branch without a live `limactl`.
 *
 * ── INJECTION HARDENING (audit L9 C1) ─────────────────────────────────────
 * The original spawn/status/cancel built a `bash -c '<string>'` where the
 * caller-controlled `image` / `cmd` / handle id were INTERPOLATED into the
 * script text. A spec like `{ image: "x; rm -rf ~ #", cmd: [] }` was a shell
 * injection straight into the VM. We now NEVER interpolate untrusted values
 * into a script body. Instead:
 *
 *   - The workload script is a FIXED string. The image+cmd are passed as
 *     POSITIONAL ARGS after `bash -c '<fixed>' lima-runner "$@"`, so they
 *     arrive as `"$@"` inside the script — quoted by the shell, never parsed
 *     as script tokens (`composeLimaSpawnArgv`).
 *   - The handle id (used in the pidfile / logfile paths) is validated to a
 *     safe `[A-Za-z0-9_-]` charset (`assertSafeId`) AND is itself generated
 *     from `prefix-uuid`, so it can never carry shell metacharacters; it is
 *     additionally passed positionally so even a future id scheme cannot
 *     break out.
 *   - status / cancel pass the pidfile path positionally too — no `$(cat …)`
 *     over an interpolated path.
 *
 * Mapping (abbreviated — full pid-file ↔ status state machine intentionally
 * deferred to a follow-up ADR; this adapter is the minimum shell-out surface
 * required for the registry env-swap. Headless behaviour for cancel/logs
 * mirrors the docker adapter.):
 *   - `spawn(spec)`    → `limactl shell {vm} -- bash -c '<fixed launcher>' lima-runner <id> <image> <cmd…>`
 *   - `status(handle)` → `limactl shell {vm} -- bash -c '<fixed status>'  lima-runner <pidfile>`
 *   - `cancel(handle)` → `limactl shell {vm} -- bash -c '<fixed cancel>'  lima-runner <pidfile>`
 *   - `logs(handle)`   → `limactl shell {vm} -- tail -f <logfile>` (structured argv — no shell)
 */

import { err, ok, type Result } from "@/shared"
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

/* ------------------------------------------------------------------ */
/* Injection-safe argv composition (pure, exported for the hellgate)   */
/* ------------------------------------------------------------------ */

/** Charset a handle id MUST satisfy before it is used in a VM-side path.
 *  `prefix-uuid` always matches; anything carrying a shell metacharacter
 *  (`;`, `$`, backtick, space, quote, `/`, …) is rejected. Defense-in-depth
 *  even though the id is also passed positionally. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/

/** Throw-free guard: returns the id when safe, otherwise `null`. */
export const safeLimaId = (id: string): string | null => (SAFE_ID.test(id) ? id : null)

/**
 * FIXED launcher script. Untrusted values arrive as positional args — NEVER
 * interpolated into this text:
 *   `$0` = "lima-runner" (script name, ignored)
 *   `$1` = handle id (safe charset, used for the pid/log file stem)
 *   `$2…` = image + cmd tokens, re-quoted by the shell via `"${@:2}"`.
 *
 * Because the workload tokens are referenced as `"${@:2}"` (NOT spliced into
 * the script), a token like `; rm -rf ~` is passed to the workload program as
 * a literal argument, never executed as a shell statement.
 */
const LIMA_LAUNCH_SCRIPT =
  'id="$1"; shift; nohup "$@" > "/tmp/${id}.log" 2>&1 & echo $! > "/tmp/${id}.pid"'

/** FIXED status probe. `$1` = pidfile path (passed positionally). */
const LIMA_STATUS_SCRIPT =
  'kill -0 "$(cat "$1" 2>/dev/null)" 2>/dev/null && echo running || echo exited'

/** FIXED cancel script. `$1` = pidfile path (passed positionally). */
const LIMA_CANCEL_SCRIPT = 'kill "$(cat "$1" 2>/dev/null)" 2>/dev/null || true'

/** Compose the injection-safe spawn argv. `id` MUST be pre-validated by the
 *  caller (`safeLimaId`). Image + cmd flow through as positional args. */
export const composeLimaSpawnArgv = (
  vm: string,
  id: string,
  spec: RemoteSpec,
): readonly string[] => [
  "limactl",
  "shell",
  vm,
  "--",
  "bash",
  "-c",
  LIMA_LAUNCH_SCRIPT,
  "lima-runner",
  id,
  spec.image,
  ...spec.cmd,
]

/** Compose the injection-safe status argv. */
export const composeLimaStatusArgv = (vm: string, id: string): readonly string[] => [
  "limactl",
  "shell",
  vm,
  "--",
  "bash",
  "-c",
  LIMA_STATUS_SCRIPT,
  "lima-runner",
  `/tmp/${id}.pid`,
]

/** Compose the injection-safe cancel argv. */
export const composeLimaCancelArgv = (vm: string, id: string): readonly string[] => [
  "limactl",
  "shell",
  vm,
  "--",
  "bash",
  "-c",
  LIMA_CANCEL_SCRIPT,
  "lima-runner",
  `/tmp/${id}.pid`,
]

export const createLimaAdapter = (opts: LimaAdapterOpts): RemoteRunner => {
  const proc = opts.process
  const vm = opts.vm
  const prefix = opts.namePrefix ?? "quanta-remote"
  const uuid = opts.uuid ?? (() => crypto.randomUUID())
  const nowMs = opts.nowMs ?? (() => Date.now())
  const known = new Set<string>()
  // HELL-RR-07: a `timeoutMs === 0` handle never spawns — record it so the
  // next status poll reports a terminal `timeout`-reason failure (parity with
  // the docker adapter).
  const immediateTimeout = new Set<string>()

  return {
    async spawn(spec: RemoteSpec): Promise<Result<RemoteHandle, RemoteError>> {
      const validation = validateSpec(spec)
      if (!validation.ok) return err(validation.error)

      // HELL-RR-07: timeout 0 → never spawn; emit terminal-failed on poll.
      if (spec.timeoutMs === 0) {
        const id = `${prefix}-${uuid()}`
        known.add(id)
        immediateTimeout.add(id)
        return ok({ id, backend: "lima" })
      }

      if (spec.signal?.aborted === true) {
        return err(new RemoteError("cancelled", "aborted pre-spawn", "lima"))
      }
      const id = `${prefix}-${uuid()}`
      const safe = safeLimaId(id)
      if (safe === null) {
        // Unreachable for the `prefix-uuid` scheme; encoded honestly so a
        // future id generator that emits metacharacters fails CLOSED rather
        // than injecting into the VM.
        return err(new RemoteError("invalid-spec", `unsafe handle id: ${id}`, "lima"))
      }
      const argv = composeLimaSpawnArgv(vm, safe, spec)
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
      if (immediateTimeout.has(handle.id)) {
        return ok({ kind: "failed", exitCode: undefined, reason: "timeout", observedAtMs: nowMs() })
      }
      const argv = composeLimaStatusArgv(vm, handle.id)
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
      if (immediateTimeout.has(handle.id)) return ok(undefined)
      const argv = composeLimaCancelArgv(vm, handle.id)
      await proc.exec(argv)
      return ok(undefined)
    },

    async *logs(handle: RemoteHandle, logOpts: RemoteLogsOpts = {}): AsyncIterable<string> {
      if (!known.has(handle.id)) return
      // Structured argv — `tail -f <logfile>` with the path as a discrete
      // token, no `bash -c` shell layer at all.
      const argv = ["limactl", "shell", vm, "--", "tail", "-f", `/tmp/${handle.id}.log`]
      const stream = proc.stream(argv, logOpts.signal)
      for await (const line of stream) {
        if (logOpts.signal?.aborted === true) return
        yield line
      }
    },
  }
}
