/**
 * Tier-1 per-subsystem builder: USER-INPUT tool block (ADR-0095 draft,
 * ADR-0086 sister).
 *
 * Registers `request_user_input` ONLY when a `userInputPort` is wired. The
 * dispatch seam builds `ctx.requestUserInput` from the port; absent ⇒ tool
 * NOT in registry.
 *
 * Behavior preserved verbatim from the previous monolithic
 * `buildSessionFeatures` body — only the *location* of this slice has moved.
 *
 * DEFAULT-OFF: `config.userInputPort` absent ⇒ this builder returns
 * `undefined` (byte-identical, RFC §1.2).
 */

import { requestUserInputTool, type Tool } from "@/tool"
import type { AgentConfig } from "../types"

/** Build the user-input tool from `config.userInputPort`. Returns
 *  `undefined` when the port is not wired. */
export const buildUserInputBlock = (config: AgentConfig): Tool | undefined => {
  if (config.userInputPort === undefined) return undefined
  return requestUserInputTool() as Tool
}
