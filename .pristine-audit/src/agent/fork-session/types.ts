/**
 * Fork-session shapes (ADR-0201).
 *
 * `ForkedSessionHandle` is the success payload returned by `SessionForker.fork`.
 * `ForkError` is the CLOSED 4-arm union surfaced as the `Err` variant — adding
 * a new arm forces an exhaustive-switch update at every consumer.
 *
 * Plane-clean: this file imports only `@/llm` (for the `Message` shape that
 * appears on the handle). No `@/agent/loop`, no `@/agent/dispatch`.
 */

import type { Message } from "@/llm"

/** Success payload returned by `SessionForker.fork`. The `messages` array is
 *  the SAME frozen array stored in the underlying `ConversationCheckpointStore`
 *  — see ADR-0201's snapshot-immutability invariant.
 *
 *  `exactOptionalPropertyTypes`: every field is REQUIRED on this shape (no
 *  optional slots), so the constructor never has to conditional-spread. */
export interface ForkedSessionHandle {
  /** New session id minted at fork time. `crypto.randomUUID()` (v4). */
  readonly sessionId: string
  /** The parent session id (the `id` the original snapshot was recorded under). */
  readonly parentSessionId: string
  /** Same as `parentSessionId` today — distinct field reserved for a future
   *  layer that records multiple checkpoints per session and forks from a
   *  named non-root checkpoint. Keeping the slot now avoids a breaking
   *  shape-change. */
  readonly parentCheckpointId: string
  /** Epoch-ms timestamp at fork time (from the injected clock). */
  readonly forkedAt: number
  /** Frozen messages array shared with the parent snapshot. */
  readonly messages: ReadonlyArray<Message>
}

/** Closed error union. Adding a code requires updating every consumer
 *  switch (compile error on the missing arm).
 *
 *  ADR-0226 extension: 4 new arms (`fork-not-configured` / `aborted` /
 *  `invalid-branch-name` / `shadow-odb-failed`) added for the
 *  ForkSessionPort layer (richer port that wraps the original
 *  SessionForker). All 4 codes are typed errors — NO throws past the
 *  port surface. */
export type ForkError =
  | { readonly code: "checkpoint-not-found"; readonly message: string }
  | { readonly code: "store-full"; readonly message: string }
  | { readonly code: "lineage-cycle"; readonly message: string }
  | { readonly code: "duplicate-id"; readonly message: string }
  | { readonly code: "fork-not-configured"; readonly message: string }
  | { readonly code: "aborted"; readonly message: string }
  | { readonly code: "invalid-branch-name"; readonly message: string }
  | { readonly code: "shadow-odb-failed"; readonly message: string }

/** Canonical literal tuple — feeds runtime guards and tests so the union does
 *  not silently drift from the type. */
export const ALL_FORK_ERROR_CODES = [
  "checkpoint-not-found",
  "store-full",
  "lineage-cycle",
  "duplicate-id",
  "fork-not-configured",
  "aborted",
  "invalid-branch-name",
  "shadow-odb-failed",
] as const satisfies readonly ForkError["code"][]
// Two-way drift guard (satisfies = array⊆union; Assert = union⊆array). A new
// ForkError arm missing from this tuple is a build error.
type _AssertFork<T extends true> = T
export type _ForkErrorCodesDriftGuard = _AssertFork<
  ForkError["code"] extends (typeof ALL_FORK_ERROR_CODES)[number] ? true : false
>
