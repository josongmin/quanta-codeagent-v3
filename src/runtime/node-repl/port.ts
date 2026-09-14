/**
 * ADR-0249 — closed port for the node-REPL persistent kernel.
 *
 * Five operations:
 *   - `spawn(opts)`   — launch a fresh kernel; returns the persisted spec.
 *   - `exec(id, code)` — evaluate `code` in the kernel; variables persist.
 *   - `status(id)`    — current `KernelState` for the live process.
 *   - `kill(id)`      — terminate + remove the on-disk handle.
 *   - `list()`        — every kernel known to the adapter + its in-use flag.
 *
 * Split-port keeps the two implementations independently substitutable:
 *   - production wires `createDefaultNodeReplKernel()` (Bun.spawn-backed),
 *   - tests wire `headlessStub()` for determinism (no real spawn).
 */

import type { Result } from "@/shared"
import type { ExecResult, KernelError, KernelId, KernelSpec, KernelState } from "./types"

/** Caller options for `spawn`. The `id` is OPTIONAL — when omitted the
 *  state-store generates a nonce-suffixed safe id. `signal` participates
 *  in the spawn path (a pre-aborted signal short-circuits to
 *  `spawn-failed`); per-exec aborts use the `exec` option of the same
 *  name. */
export interface NodeReplSpawnOptions {
  readonly sessionId: string
  readonly id?: string
  readonly signal?: AbortSignal
}

/** Caller options for `exec`. `signal` aborts a long-running evaluation by killing the
 *  kernel process — it transitions to `dead` and the call resolves with
 *  `{ kind: "exec-aborted" }`. Past `timeoutMs` the kernel is killed the same way and the
 *  call resolves with `{ kind: "exec-timeout" }`. */
export interface NodeReplExecOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

/** Public listing entry. `inUse` is `true` while a kernel's state is
 *  `running`; `false` for `ready` / `idle` / `dead` / `starting`. */
export interface KernelListing {
  readonly spec: KernelSpec
  readonly state: KernelState
  readonly inUse: boolean
}

export interface NodeReplKernel {
  spawn(opts: NodeReplSpawnOptions): Promise<Result<KernelSpec, KernelError>>
  exec(
    id: KernelId,
    code: string,
    opts?: NodeReplExecOptions,
  ): Promise<Result<ExecResult, KernelError>>
  status(id: KernelId): KernelState
  kill(id: KernelId): Promise<void>
  list(): ReadonlyArray<KernelListing>
}
