/**
 * ADR-0249 — types for the node-REPL persistent-kernel primitive.
 *
 * The kernel is a long-running node REPL subprocess whose variable bindings
 * survive across `exec` calls. Codex's reference pattern lives at
 * `~/.codex/node_repl/active_execs/{execId}.json` — quanta mirrors that
 * shape (handle metadata only) under `<quanta home>/node_repl/active_execs/`
 * (`QUANTA_CONFIG_DIR ?? QUANTA_HOME ?? ~/.quanta`).
 *
 * `KernelError` is a closed union (project convention — see
 * `src/shared/errors.ts`) so policy code can branch on `.kind` without
 * parsing error messages.
 */

import type { Id } from "@/shared"

/** Branded id for a spawned kernel. The sanitized + nonce-suffixed
 *  filesystem-safe string the state-store also uses for `{id}.json`. */
export type KernelId = Id<"NodeReplKernel">

/** Closed state machine the default adapter walks:
 *    starting → ready → running → idle → … → dead
 *  `starting` covers banner-consume window before the kernel is exec-ready.
 *  `running` is set while an exec is in flight; `idle` after it resolves.
 *  `dead` is terminal — kill / process-exit / unrecoverable parse error. */
export type KernelState = "starting" | "ready" | "running" | "idle" | "dead"

/** Handle metadata persisted to disk. The `id` is the on-disk filename
 *  stem; `pid` is the spawned node process; `lastUseMs` is updated on
 *  every successful exec so an orphan-reaper can prefer-oldest. */
export interface KernelSpec {
  readonly id: KernelId
  readonly pid: number
  readonly startedAtMs: number
  readonly lastUseMs: number
  readonly sessionId: string
}

/** Result of a successful exec. `hadError` is true when the REPL emitted
 *  to stderr OR an Uncaught exception was reported — the caller decides
 *  whether to feed `stderr` back into the LLM context. */
export interface ExecResult {
  readonly id: KernelId
  readonly stdout: string
  readonly stderr: string
  readonly hadError: boolean
}

/** Closed-union failure code. Every public method returns
 *  `Result<…, KernelError>` — no thrown errors. */
export type KernelError =
  | { kind: "node-missing"; detail: string }
  | { kind: "kernel-dead"; id: KernelId }
  | { kind: "spawn-failed"; detail: string }
  | { kind: "exec-aborted"; id: KernelId }
  | { kind: "invalid-id"; raw: string }
