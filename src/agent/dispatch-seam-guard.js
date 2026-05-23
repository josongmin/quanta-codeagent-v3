/**
 * Dispatch-seam guard (ADR-0036, Cluster D Feature 1).
 *
 * Pure function called BEFORE `ToolRegistry.run()` to decide whether the
 * call is permitted under the active collaboration mode. Returns a tagged
 * result rather than throwing so the caller (eventually `loop.ts`) can
 * surface the rejection to the LLM as a `tool_result` text body without an
 * unhandled exception unwinding the loop.
 *
 * Wiring into the real dispatch site is deferred to a follow-up patch — see
 * ADR-0036 §한계. This module ships standalone-callable so the integration
 * patch is a pure import + call, no new logic.
 */
import { assertNotMutatingInPlanMode, PlanModeMutatingBlockedError, UnknownToolError, } from "./mode";
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
export const checkDispatchAllowed = (turnState, toolCall) => {
    try {
        assertNotMutatingInPlanMode(turnState.collaborationMode, toolCall.name);
        return { ok: true };
    }
    catch (err) {
        if (err instanceof PlanModeMutatingBlockedError)
            return { ok: false, reason: err };
        if (err instanceof UnknownToolError)
            return { ok: false, reason: err };
        throw err;
    }
};
