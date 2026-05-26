/**
 * ADR-0330 — `createMentionInjector` composition.
 *
 * Returns the function value that `AgentConfig.mentionInjector`
 * (ADR-0327 slot, reserved) is meant to hold. The function pipes a raw
 * user input string through:
 *
 *   parseMentions          (ADR-0325 parser)
 *   ↓
 *   buildInjectionFragments(skill-only resolver)
 *   ↓
 *   buildMentionInjectionMessages
 *
 * The end-to-end shape is `(userInputText: string) => readonly Message[]`,
 * suitable for direct splice into the per-turn `messages[]` (between
 * `baseMessages` and the trailing `<system-reminder>`, mirroring the
 * insertion point ADR-0321 uses).
 *
 * NO-THROW (defense in depth): parser / resolver / builder are each
 * already NO-THROW; this composition wraps the WHOLE pipeline in a
 * try/catch so any future regression in any layer cannot crash the
 * caller. Failure ⇒ `[]` (no mentions, byte-identical legacy).
 *
 * Pure: no clock, no I/O. Calling the returned function twice with the
 * same input always returns equivalent output (object identity not
 * guaranteed — the message envelopes are freshly allocated).
 */

import {
  buildInjectionFragments,
  buildMentionInjectionMessages,
  parseMentions,
} from "@/agent/mention-injection"
import type { Message } from "@/llm"
import { createSkillOnlyResolver } from "./skill-resolver"
import type { MentionRunnerConfig } from "./types"

/**
 * Build the `mentionInjector` function. Default-OFF semantics: callers
 * that don't wire this into `AgentConfig` see byte-identical legacy
 * behaviour (no mention injection at all). Callers that DO wire it
 * MUST splice the result into the per-turn message list themselves —
 * this function is a producer, not a consumer.
 *
 * @param cfg — optional skills registry. Omit ⇒ all `@skill` mentions
 *              resolve to `null` (skipped), all plugin / app mentions
 *              always resolve to `null` regardless.
 *
 * @returns a function `(userInputText) => readonly Message[]`. Empty
 *          input ⇒ `[]`. NO-THROW. Order-preserving (first occurrence
 *          of a `(kind, target)` pair survives, subsequent dropped by
 *          the parser-side dedup).
 */
export const createMentionInjector = (
  cfg: MentionRunnerConfig = {},
): ((userInputText: string) => readonly Message[]) => {
  const resolver = createSkillOnlyResolver(cfg.skills)
  return (userInputText: string): readonly Message[] => {
    try {
      const mentions = parseMentions(userInputText)
      if (mentions.length === 0) return []
      const fragments = buildInjectionFragments(mentions, resolver)
      if (fragments.length === 0) return []
      return buildMentionInjectionMessages(fragments)
    } catch {
      // Belt-and-suspenders: every layer below is NO-THROW, so this
      // catch should be unreachable. If it ever fires we degrade to
      // legacy (no injection) instead of crashing the caller.
      return []
    }
  }
}
