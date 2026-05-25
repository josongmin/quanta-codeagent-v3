/**
 * ADR-0288 — Remote runner port types.
 *
 * Closed types for {@link RemoteRunner} (in `port.ts`). Pure types — no
 * runtime, no I/O, no provider-specific knowledge. Every adapter
 * (`docker-adapter.ts`, `lima-adapter.ts`, `apple-vz-adapter.ts`,
 * `headless-stub.ts`) speaks exactly this surface.
 *
 * Slice discipline: `@/remote` is a LEAF slice. It imports nothing from the
 * project except `@/shared` (Result). External effects (subprocess spawn,
 * filesystem, network) cross via the adapter — the port surface stays pure.
 *
 * exactOptionalPropertyTypes: every optional field uses an EXPLICIT
 * `| undefined` so an adapter may equally OMIT the key OR set it to
 * `undefined` without provoking EOP errors. The default-OFF discipline
 * (registry returns `null` when env is unset) keeps unwired code byte-
 * identical.
 */

/* ------------------------------------------------------------------ */
/* Status — closed 5-arm union                                         */
/* ------------------------------------------------------------------ */

/**
 * Lifecycle status for a remote job. Closed 5-arm union (HELL-RR-05
 * exhaustiveness).
 *
 *   - `pending`     — handle allocated; backend not yet observed running.
 *   - `running`     — backend confirms the container/VM is alive.
 *   - `succeeded`   — terminal: process exited with status 0.
 *   - `failed`      — terminal: process exited non-zero, OOM, network
 *                     failure mid-run, or backend-reported error.
 *   - `cancelled`   — terminal: explicit `cancel(handle)` or AbortSignal
 *                     cascade from the spawner.
 */
export type RemoteStatusKind =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"

/** All five status arms — closed array for runtime exhaustiveness checks. */
export const ALL_REMOTE_STATUS_KINDS: ReadonlyArray<RemoteStatusKind> = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]

/**
 * Status snapshot returned by {@link RemoteRunner.status}. Terminal kinds
 * (`succeeded` / `failed` / `cancelled`) carry an `exitCode` when the
 * backend reported one and an optional `reason` token (e.g. `"oom"`).
 *
 * exactOptional: `exitCode` / `reason` are `| undefined` so an adapter
 * may equally omit them or pass `undefined`.
 */
export interface RemoteStatus {
  readonly kind: RemoteStatusKind
  readonly exitCode?: number | undefined
  readonly reason?: string | undefined
  /** Wall-clock ms when the backend snapshot was taken. */
  readonly observedAtMs: number
}

/* ------------------------------------------------------------------ */
/* Spec — input to spawn()                                             */
/* ------------------------------------------------------------------ */

/** A volume / bind mount declaration. `readonly` is a separate flag from
 *  TypeScript's `readonly` modifier (this one maps to `--mount,ro`). */
export interface RemoteMount {
  readonly source: string
  readonly target: string
  readonly readonly?: boolean | undefined
}

/**
 * Job specification fed to {@link RemoteRunner.spawn}. Closed shape — every
 * adapter validates this surface.
 *
 * exactOptional: every optional field is `T | undefined` so adapters can
 * either omit the key OR pass `undefined`. The validator (`validateSpec`)
 * treats both as "absent".
 */
export interface RemoteSpec {
  /** Container image (docker / OCI tag) or VM template id. MUST be a
   *  non-empty string; empty / whitespace → `invalid-spec`. */
  readonly image: string
  /** Command to run inside the container/VM. Empty array allowed (defaults
   *  to the image entrypoint). */
  readonly cmd: readonly string[]
  /** Environment variables to inject. Keys MUST match `[A-Z_][A-Z0-9_]*`;
   *  the validator rejects anything else. `null` value allowed — interpreted
   *  as "delete this env var" (mirrors `node:child_process` convention).
   *  HELL-RR-03 locks the null-vs-undefined posture. */
  readonly env?: Readonly<Record<string, string | null>> | undefined
  /** Bind mounts. */
  readonly mounts?: readonly RemoteMount[] | undefined
  /** Working directory inside the container/VM. */
  readonly workdir?: string | undefined
  /** Wall-clock budget in ms. `0` is honored as IMMEDIATE timeout
   *  (HELL-RR-07): the adapter MUST emit a `timeout` failed status on the
   *  next status poll without spawning the workload at all. `undefined` /
   *  omitted → no client-side timeout (the backend may still enforce one). */
  readonly timeoutMs?: number | undefined
  /** AbortSignal — cancelling pre-spawn returns `cancelled` without ever
   *  reaching the backend. Cancelling mid-run cascades to
   *  {@link RemoteRunner.cancel}. */
  readonly signal?: AbortSignal | undefined
}

/* ------------------------------------------------------------------ */
/* Handle — opaque pointer to a spawned job                            */
/* ------------------------------------------------------------------ */

/**
 * Opaque handle to a spawned job. The {@link RemoteHandle.id} format is
 * `{backend}-{uuid}` (HELL-RR-04). The {@link RemoteHandle.backend} tag
 * lets a multiplexed orchestrator route status/cancel/logs back to the
 * correct adapter without parsing the id.
 *
 * Closed `backend` arms mirror the adapter file names:
 *   `docker`, `lima`, `apple-vz`, `headless`.
 */
export type RemoteBackend = "docker" | "lima" | "apple-vz" | "headless"

/** All known backends — closed array for runtime exhaustiveness. */
export const ALL_REMOTE_BACKENDS: ReadonlyArray<RemoteBackend> = [
  "docker",
  "lima",
  "apple-vz",
  "headless",
]

export interface RemoteHandle {
  readonly id: string
  readonly backend: RemoteBackend
}

/* ------------------------------------------------------------------ */
/* Error — closed 7-arm union                                          */
/* ------------------------------------------------------------------ */

/**
 * Closed 7-arm error union for the remote runner port (HELL-RR-06
 * exhaustiveness). Every adapter MUST classify its failures into exactly
 * one of these kinds. Adding an 8th arm requires a deliberate ADR + a new
 * `assertNever` switch update.
 *
 *   - `invalid-spec`        — caller-supplied spec violates the schema
 *                             (empty image, malformed env key, etc.).
 *   - `unknown-handle`      — status/cancel/logs called with a handle the
 *                             adapter doesn't recognize.
 *   - `daemon-unavailable`  — backend daemon down / CLI missing
 *                             (`docker` not in PATH, `limactl` errored,
 *                             VZ framework not available).
 *   - `image-not-found`     — image pull failed (4xx from registry,
 *                             `manifest unknown`, etc.).
 *   - `timeout`             — wall-clock budget exceeded; the cancel
 *                             cascade has been initiated.
 *   - `cancelled`           — explicit cancel or AbortSignal cascade.
 *   - `transport`           — every other backend / I/O failure
 *                             (network, OOM, kernel panic, …). Carries
 *                             the underlying message in `message`.
 */
export type RemoteErrorKind =
  | "invalid-spec"
  | "unknown-handle"
  | "daemon-unavailable"
  | "image-not-found"
  | "timeout"
  | "cancelled"
  | "transport"

/** All seven error arms — closed array for runtime exhaustiveness. */
export const ALL_REMOTE_ERROR_KINDS: ReadonlyArray<RemoteErrorKind> = [
  "invalid-spec",
  "unknown-handle",
  "daemon-unavailable",
  "image-not-found",
  "timeout",
  "cancelled",
  "transport",
]

/**
 * Structured remote runner error. Stringified shape:
 * `RemoteError(<kind>): <message>`. The wrapping `Error` (so it can be
 * thrown if a caller prefers) sets `name = "RemoteError"`.
 */
export class RemoteError extends Error {
  override readonly name = "RemoteError"
  readonly kind: RemoteErrorKind
  readonly backend: RemoteBackend | undefined

  constructor(
    kind: RemoteErrorKind,
    message: string,
    backend?: RemoteBackend | undefined,
  ) {
    super(`RemoteError(${kind}): ${message}`)
    this.kind = kind
    this.backend = backend
  }
}

/* ------------------------------------------------------------------ */
/* Logs — back-pressure-friendly iterable                              */
/* ------------------------------------------------------------------ */

/** Options for {@link RemoteRunner.logs}. `since` is an ms-epoch lower bound
 *  for resume; `signal` cancels the iteration. */
export interface RemoteLogsOpts {
  readonly since?: number | undefined
  readonly signal?: AbortSignal | undefined
}
