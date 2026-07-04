/**
 * Shared primitives used by the guard adapters AND by `loop.ts`'s legacy
 * helpers. Moved out of `loop.ts` so the chain adapters do NOT import the
 * loop module (which would create a new edge in the agent slice import
 * graph). `loop.ts` re-imports these so its existing behavior is preserved
 * verbatim — every call site that previously used `metaUser` / `isFinishAttempt`
 * goes through the SAME functions exported here.
 */

import type { Message } from "@/llm"
import type { AssembledMessage, RecoveryAction } from "../recovery"
import { makeSyntheticUserMessage } from "../synthetic-user"

/** A short out-of-band user message used to steer the model on a same-turn
 *  retry (output-limit / malformed-tool / empty). Kept terse on purpose.
 *  Verbatim move from `loop.ts:719-722` — byte-identical shape. */
export const metaUser = (text: string): Message => ({
  ...makeSyntheticUserMessage("same-turn-recovery", [{ type: "text", text }]),
})

/** True when this decided action is a finish attempt: an exhaustion-completed
 *  (malformed/empty retries spent) OR a proceed turn that produced NO tool_use
 *  (a pure-text "I'm done"). These are exactly the two points the loop accepts
 *  a completion, so they are the points the guards must intercept.
 *  Verbatim move from `loop.ts:1110-1112` — byte-identical predicate. */
export const isFinishAttempt = (action: RecoveryAction, message: AssembledMessage): boolean =>
  action.do === "completed" ||
  (action.do === "proceed" && !message.content.some((b) => b.type === "tool_use"))
