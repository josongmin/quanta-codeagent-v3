/**
 * ADR-0288 — Closed `RemoteRunner` port.
 *
 * Single seam every remote execution backend speaks. Four operations:
 *   - `spawn(spec)`                       — allocate handle + start workload.
 *   - `status(handle)`                    — snapshot lifecycle state.
 *   - `cancel(handle)`                    — terminate + reap.
 *   - `logs(handle, opts?)`               — back-pressure-friendly stream.
 *
 * Hard invariants (locked by `tests/unit/remote/runner-port-hellgate.test.ts`):
 *
 *   - Every adapter returns a {@link Result} for spawn / status / cancel —
 *     no thrown surface error escapes (except programmer errors like a
 *     `null` handle, which surface as `TypeError`).
 *   - `cancel` is IDEMPOTENT — calling twice on the same handle MUST NOT
 *     throw and MUST return the same `Ok` either time (HELL-RR-11).
 *   - `status` after a terminal state is CACHED — the adapter MUST NOT
 *     re-contact the backend; the snapshot is frozen (HELL-RR-14).
 *   - `logs` is an `AsyncIterable<string>` that releases its underlying
 *     stream when the iterator is exhausted OR the caller `break`s out
 *     of the for-await loop (HELL-RR-12).
 *   - Default-OFF: the registry returns `null` when `QUANTA_REMOTE_RUNNER`
 *     is unset / `none` / unknown. No code path in the project instantiates
 *     a runner from import alone (HELL-RR-08, HELL-RR-15).
 */

import type { Result } from "@/shared"
import type {
  RemoteError,
  RemoteHandle,
  RemoteLogsOpts,
  RemoteSpec,
  RemoteStatus,
} from "./types"

/**
 * Remote runner port — closed surface for every backend.
 *
 * Result vs throw convention:
 *   - `spawn / status / cancel` return `Result<T, RemoteError>` — never
 *     throw on user-classifiable errors (invalid spec, daemon down,
 *     unknown handle, etc.).
 *   - `logs` is an `AsyncIterable<string>` — back-pressure naturally
 *     bounded by the consumer's pull rate. Errors during iteration MAY
 *     throw (matches the `for await` cancellation idiom).
 */
export interface RemoteRunner {
  spawn(spec: RemoteSpec): Promise<Result<RemoteHandle, RemoteError>>
  status(handle: RemoteHandle): Promise<Result<RemoteStatus, RemoteError>>
  cancel(handle: RemoteHandle): Promise<Result<void, RemoteError>>
  logs(handle: RemoteHandle, opts?: RemoteLogsOpts): AsyncIterable<string>
}
