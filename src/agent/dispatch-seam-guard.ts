/**
 * Dispatch-seam guard (ADR-0036, Cluster D Feature 1).
 *
 * Pure function called BEFORE `ToolRegistry.run()` to decide whether the
 * call is permitted under the active collaboration mode. Returns a tagged
 * result rather than throwing so the caller (eventually `loop.ts`) can
 * surface the rejection to the LLM as a `tool_result` text body without an
 * unhandled exception unwinding the loop.
 *
 * Wired into the real dispatch site (ADR-0036 L4): `dispatch.ts`'s
 * `dispatchToolInner` calls {@link checkDispatchAllowed} when
 * `collab === "plan" && !registry.isReadOnly(call.name)` — a read-only tool
 * takes the fast path unconditionally; everything else in `plan` posture is
 * consulted against the mutating-tool table. The guard stays standalone-callable
 * (no implicit dispatch coupling) so it is unit-testable in isolation.
 */

import {
  assertNotMutatingInPlanMode,
  type CollaborationMode,
  PlanModeMutatingBlockedError,
  UnknownToolError,
} from "./mode"

/** Minimal turn-state surface needed by the guard. Defined locally so the
 *  guard can be invoked from any caller — the real `loop.ts` turn state has
 *  more fields, but this is the only one the guard reads. */
export interface DispatchTurnState {
  readonly collaborationMode: CollaborationMode
}

/** Minimal tool-call surface needed by the guard. */
export interface DispatchToolCall {
  readonly name: string
}

/** Result of {@link checkDispatchAllowed}. `ok:false` carries the typed
 *  error so the caller can render the deny message uniformly. */
export type DispatchAllowedResult =
  | { ok: true }
  | { ok: false; reason: PlanModeMutatingBlockedError | UnknownToolError }

/** Pure dispatch-seam guard.
 *
 *  - `default` mode ⇒ always `{ ok: true }` (no work done).
 *  - `plan` mode ⇒ consult the explicit mutating-tool table:
 *      - tool absent from table ⇒ `{ ok: false, reason: UnknownToolError }`
 *      - tool present and mutating ⇒ `{ ok: false, reason:
 *        PlanModeMutatingBlockedError }`
 *      - tool present and read-only ⇒ `{ ok: true }`
 *
 *  No throws on the happy path; no silent allow on the unhappy path. */
export const checkDispatchAllowed = (
  turnState: DispatchTurnState,
  toolCall: DispatchToolCall,
): DispatchAllowedResult => {
  try {
    assertNotMutatingInPlanMode(turnState.collaborationMode, toolCall.name)
    return { ok: true }
  } catch (err) {
    if (err instanceof PlanModeMutatingBlockedError) return { ok: false, reason: err }
    if (err instanceof UnknownToolError) return { ok: false, reason: err }
    throw err
  }
}
