/**
 * SideChatManager port (ADR-0244).
 *
 * Closed-port DI seam. The base port shape:
 *
 *   - `start(parentSessionId, prompt)` — mints a new SideChatId under the
 *     parent's scope, records the initial prompt, returns `{ id, state }`.
 *   - `send(id, message)` — appends a user message + assistant reply to the
 *     side chat's own isolated list. Requires `state === "active"`.
 *   - `stop(id)` — flips state to `stopped`. Subsequent `send` → `Err("not-active")`.
 *   - `list(parentSessionId)` — enumerates ACTIVE SideChatIds owned by that
 *     parent, newest-first. Unknown parent ⇒ `[]` (no throw).
 *   - `closeAllForParent(parentSessionId)` — parent-end hook; flips every
 *     active chat of that parent to stopped. Returns the affected count.
 *
 * CORE invariant: NO operation reaches the parent session's `messages[]`.
 * The side-chat's own message list (`SideChatMessage[]`) lives entirely
 * inside the manager's internal Map and is never aliased to the parent.
 *
 * Plane-clean: imports `@/shared` for `Result` + sibling types only. No
 * `@/agent/loop`, no `@/agent/dispatch`.
 */

import type { Result } from "@/shared"
import type { SideChatError, SideChatId, SideChatMessage, SideChatState } from "./types"

/** Input to `start`. `signal` is optional and honoured before any state mutates. */
export interface SideChatStartInput {
  readonly parentSessionId: string
  readonly prompt: string
  readonly signal?: AbortSignal
}

/** Success payload returned by `start`. */
export interface SideChatStartResult {
  readonly id: SideChatId
  readonly state: SideChatState
}

/** Input to `send`. `signal` is optional. */
export interface SideChatSendInput {
  readonly id: SideChatId
  readonly message: string
  readonly signal?: AbortSignal
}

/** Success payload returned by `send`. */
export interface SideChatSendResult {
  readonly reply: SideChatMessage
}

/** Input to `stop`. */
export interface SideChatStopInput {
  readonly id: SideChatId
}

/** Success payload returned by `stop`. */
export interface SideChatStopResult {
  readonly state: SideChatState
}

/** Input to `list`. */
export interface SideChatListInput {
  readonly parentSessionId: string
}

/** Input to `closeAllForParent`. */
export interface SideChatCloseAllInput {
  readonly parentSessionId: string
}

export interface SideChatManager {
  /** Start a new side chat under the parent's scope. */
  start(input: SideChatStartInput): Result<SideChatStartResult, SideChatError>

  /** Append a user message + record the assistant reply. */
  send(input: SideChatSendInput): Result<SideChatSendResult, SideChatError>

  /** Flip state to `stopped`. Idempotent: a second stop on an
   *  already-stopped id returns the same `Ok({ state: "stopped" })`. */
  stop(input: SideChatStopInput): Result<SideChatStopResult, SideChatError>

  /** Enumerate ACTIVE SideChatIds owned by `parentSessionId`, newest-first. */
  list(input: SideChatListInput): ReadonlyArray<SideChatId>

  /** Parent-end hook: flip every active chat of `parentSessionId` to stopped.
   *  Returns the number of chats that were active prior to the call. */
  closeAllForParent(input: SideChatCloseAllInput): number
}
