/**
 * `ThreadToolRegistry` port (ADR-0206).
 *
 * Closed-port DI seam. The default-impl in `./in-memory-store.ts` is the
 * production wiring; test-doubles satisfy the port without reaching
 * into the slice internals.
 *
 * Plane-clean: imports only `@/shared` + `@/tool` + sibling types. No
 * `@/agent/loop`, no `@/agent/dispatch`.
 */

import type { Result } from "@/shared"
import type { Tool } from "@/tool"
import type { DynamicToolSpec, RegError, ResError } from "./types"

/** Options forwarded to `list()`. */
export interface ListOpts {
  /** When `true`, include specs whose `deferLoading=true` AND whose
   *  factory has NOT been resolved yet. Default `false` so callers
   *  iterating `list()` for the LLM tool catalog see only specs whose
   *  underlying `Tool` is ready (matches Codex's lazy posture). */
  readonly includeDeferred?: boolean
}

export interface ThreadToolRegistry {
  /** Insert a spec under `threadId`. Duplicate `name` → `Err("duplicate-tool")`.
   *  When `spec.deferLoading === false`, runs `spec.factory()` eagerly and
   *  reports a throw as `Err("factory-failed")` (the spec is NOT inserted
   *  in that case — the thread registry stays in its pre-call state). */
  register(threadId: string, spec: DynamicToolSpec): Result<void, RegError>
  /** Read the per-thread spec list. Unknown `threadId` → `[]` (no throw). */
  list(threadId: string, opts?: ListOpts): readonly DynamicToolSpec[]
  /** Resolve a spec to its underlying `Tool`. Unknown name → `Err("not-found")`.
   *  Eager specs return the result of the register-time call; deferred specs
   *  run `factory()` on first resolve and cache the result (single-flight). */
  resolve(threadId: string, toolName: string): Result<Tool, ResError>
  /** Drop the entire per-thread Map + every cached `Tool` for that thread. */
  evict(threadId: string): void
  /** Drop every spec whose `namespace === ns` inside `threadId` (plus its
   *  caches). Specs without a namespace are NEVER touched by this op. */
  evictNamespace(threadId: string, namespace: string): void
}
