/**
 * Per-thread dynamic-tool shapes (ADR-0206).
 *
 * `DynamicToolSpec` is the registration record — descriptive metadata + a
 * thunk-style `factory` that constructs the actual `Tool`. The factory is
 * synchronous (`() => Tool`) so the single-flight cache in
 * `lazy-resolver.ts` is a trivial Map check.
 *
 * `RegError` and `ResError` are CLOSED unions — adding a code forces an
 * exhaustive-switch update at every consumer. Per-arm payloads are
 * structurally distinct (e.g. `factory-failed` carries `cause`) so a
 * caller can branch on `error.code` and access the typed extras.
 *
 * Plane-clean: imports only `@/tool` for the duck-typed `Tool` shape
 * (the slice fence allows this — `@/agent/thread-tools` is at the
 * helper plane, and `@/tool` is the leaf-most consumer surface).
 */

import type { Tool } from "@/tool"

/** Registration record for a per-thread dynamic tool. Every field is
 *  REQUIRED on the spec; `namespace` is the only OPTIONAL slot and is
 *  spelled `string | undefined` so a zod `.optional()` parse output is
 *  assignable under `exactOptionalPropertyTypes: true`. */
export interface DynamicToolSpec {
  /** Canonical tool name. Duplicate within the same thread → RegError. */
  readonly name: string
  /** Human-readable description; forwarded to the LLM as part of the
   *  tool catalog. */
  readonly description: string
  /** Provider-agnostic input schema (Codex MCP convention — JSON Schema
   *  object). Stored opaquely; the slice does not validate the shape. */
  readonly inputSchema: object
  /** Group key (e.g. MCP server name). Drives `evictNamespace`. Optional;
   *  absent ⇒ the spec is ungrouped (only `evict(threadId)` removes it). */
  readonly namespace?: string
  /** When `false`, `factory()` runs INSIDE `register` and a throw becomes
   *  `Err("factory-failed")`. When `true`, `factory()` runs on the first
   *  `resolve` call and the result is cached. */
  readonly deferLoading: boolean
  /** Synchronous constructor returning the `Tool` instance. Called
   *  exactly once across `register` + `resolve` lifetime. */
  readonly factory: () => Tool
}

/** Registration error. CLOSED 2-arm union.
 *
 *  `duplicate-tool` — a spec with the same `name` already exists for
 *  this `threadId`. The `existing` payload is the prior spec so the
 *  caller can render a useful diagnostic.
 *
 *  `factory-failed` — `deferLoading=false` and the eager `factory()`
 *  call threw. The original throwable is preserved on `cause` so the
 *  caller can rethrow or log it without losing the stack. */
export type RegError =
  | {
      readonly code: "duplicate-tool"
      readonly existing: DynamicToolSpec
      readonly message: string
    }
  | { readonly code: "factory-failed"; readonly cause: unknown; readonly message: string }

/** Resolution error. CLOSED 2-arm union.
 *
 *  `not-found` — no spec registered under `name` for this `threadId`.
 *
 *  `factory-failed` — a `deferLoading=true` factory threw on first
 *  resolve. The single-flight cache DOES NOT poison the slot on
 *  failure: a future `resolve` re-runs the factory (the call site that
 *  failed is the one that records the error; a successful retry then
 *  succeeds). */
export type ResError =
  | { readonly code: "not-found"; readonly message: string }
  | { readonly code: "factory-failed"; readonly cause: unknown; readonly message: string }

/** Canonical literal tuples — feed runtime guards and drift tests so the
 *  unions cannot silently grow. */
export const ALL_REG_ERROR_CODES = ["duplicate-tool", "factory-failed"] as const
export const ALL_RES_ERROR_CODES = ["not-found", "factory-failed"] as const
