/**
 * ADR-0288 — Deterministic headless stub.
 *
 * In-memory `RemoteRunner` that never touches a subprocess, docker, lima,
 * or VZ framework. Used by:
 *   - hellgate tests (HELL-RR-09 byte-identical determinism);
 *   - replay paths;
 *   - the registry's "default-OFF" position when an adapter is unwanted
 *     but a non-null runner is convenient for downstream test wiring.
 *
 * Behaviour:
 *   - `spawn(spec)` → handle `headless-<n>` where `n` is a monotonic counter
 *     (shared across instances when seeded, fresh-per-instance otherwise).
 *   - `status(handle)` → returns `succeeded` immediately after the synthetic
 *     run (the stub never emits `running` mid-poll — terminal state is
 *     observable from the very first call). For a spec with
 *     `timeoutMs === 0`, returns `failed` with `reason: "timeout"`
 *     (HELL-RR-07).
 *   - `cancel(handle)` → idempotent; flips state to `cancelled` if not
 *     already terminal, otherwise no-op (HELL-RR-11).
 *   - `logs(handle)` → yields a fixed `["[headless] cmd: <argv>"]` synthetic
 *     line then ENDS the iterator (HELL-RR-12 release on completion).
 *
 * The stub MUST NEVER perform real I/O. Tests that mock-spawn live in
 * `docker-adapter.ts` / `lima-adapter.ts` / `apple-vz-adapter.ts`.
 */

import { ok, err, type Result } from "@/shared"
import type { RemoteRunner } from "./port"
import {
  type RemoteError as RemoteErrorType,
  type RemoteHandle,
  type RemoteLogsOpts,
  type RemoteSpec,
  type RemoteStatus,
  type RemoteStatusKind,
  RemoteError,
} from "./types"
import { validateSpec } from "./validate"

interface HeadlessClock {
  now(): number
}

const REAL_CLOCK: HeadlessClock = { now: () => Date.now() }

export interface HeadlessRunnerOpts {
  /** Monotonic id counter — pass to obtain reproducible handle ids in tests. */
  readonly seedCounter?: number
  /** Override clock (deterministic replay). */
  readonly clock?: HeadlessClock
}

interface InternalRecord {
  status: RemoteStatusKind
  exitCode: number | undefined
  reason: string | undefined
  observedAtMs: number
  argv: readonly string[]
}

const formatSpec = (spec: RemoteSpec): string =>
  `${spec.image} ${spec.cmd.join(" ")}`.trim()

export const createHeadlessRunner = (opts: HeadlessRunnerOpts = {}): RemoteRunner => {
  const clock: HeadlessClock = opts.clock ?? REAL_CLOCK
  const records = new Map<string, InternalRecord>()
  let counter = opts.seedCounter ?? 0

  const allocHandle = (): RemoteHandle => {
    counter += 1
    return { id: `headless-${counter}`, backend: "headless" }
  }

  const finalize = (
    record: InternalRecord,
    status: RemoteStatusKind,
    exitCode: number | undefined,
    reason: string | undefined,
  ): void => {
    record.status = status
    record.exitCode = exitCode
    record.reason = reason
    record.observedAtMs = clock.now()
  }

  return {
    async spawn(spec: RemoteSpec): Promise<Result<RemoteHandle, RemoteErrorType>> {
      const validation = validateSpec(spec)
      if (!validation.ok) return err(validation.error)
      if (spec.signal?.aborted === true) {
        return err(new RemoteError("cancelled", "aborted pre-spawn", "headless"))
      }
      const handle = allocHandle()
      const isImmediateTimeout = spec.timeoutMs === 0
      const record: InternalRecord = {
        status: isImmediateTimeout ? "failed" : "succeeded",
        exitCode: isImmediateTimeout ? undefined : 0,
        reason: isImmediateTimeout ? "timeout" : undefined,
        observedAtMs: clock.now(),
        argv: [spec.image, ...spec.cmd],
      }
      records.set(handle.id, record)
      return ok(handle)
    },

    async status(handle: RemoteHandle): Promise<Result<RemoteStatus, RemoteErrorType>> {
      const record = records.get(handle.id)
      if (record === undefined) {
        return err(new RemoteError("unknown-handle", handle.id, "headless"))
      }
      return ok({
        kind: record.status,
        exitCode: record.exitCode,
        reason: record.reason,
        observedAtMs: record.observedAtMs,
      })
    },

    async cancel(handle: RemoteHandle): Promise<Result<void, RemoteErrorType>> {
      const record = records.get(handle.id)
      if (record === undefined) {
        return err(new RemoteError("unknown-handle", handle.id, "headless"))
      }
      const isTerminal =
        record.status === "succeeded" ||
        record.status === "failed" ||
        record.status === "cancelled"
      if (!isTerminal) finalize(record, "cancelled", undefined, "user-cancel")
      return ok(undefined)
    },

    async *logs(
      handle: RemoteHandle,
      opts: RemoteLogsOpts = {},
    ): AsyncIterable<string> {
      const record = records.get(handle.id)
      if (record === undefined) {
        // For an unknown handle the iterator simply yields nothing.
        return
      }
      if (opts.signal?.aborted === true) return
      yield `[headless] cmd: ${formatSpec({
        image: record.argv[0] ?? "",
        cmd: record.argv.slice(1),
      })}`
    },
  }
}
