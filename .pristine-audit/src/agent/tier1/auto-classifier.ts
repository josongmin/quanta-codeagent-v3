/**
 * Tier-1 per-subsystem builder: AUTO-MODE CLASSIFIER block.
 *
 * Builds the session-scoped, STATEFUL `AutoModeClassifier` wrapping the
 * LLM-backed `createAutoClassifierPort({ llm })`. Denial-limit + circuit-break
 * state lives on the classifier instance for the whole session.
 *
 * Behavior preserved verbatim from the previous monolithic
 * `buildSessionFeatures` body — only the *location* of this slice has moved.
 *
 * DEFAULT-OFF: `permission.mode !== "auto"` ⇒ this builder returns `undefined`
 * (byte-identical, RFC §1.2). The auto-path is unreachable in any other mode.
 */

import { AutoModeClassifier } from "@/permission"
import { createAutoClassifierPort } from "../auto-classifier"
import type { AgentConfig } from "../types"

/** Build the auto-mode classifier block. Returns `undefined` when
 *  `permission.mode !== "auto"`. */
export const buildClassifierBlock = (config: AgentConfig): AutoModeClassifier | undefined => {
  if (config.permission.mode !== "auto") return undefined
  return new AutoModeClassifier(createAutoClassifierPort({ llm: config.llm }))
}
