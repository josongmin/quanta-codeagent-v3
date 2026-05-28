/**
 * ADR-0330 / ADR-0418 — `createMentionInjector` composition (async).
 *
 * Returns the function value that `AgentConfig.mentionInjector`
 * (ADR-0327 slot, reserved) is meant to hold. The function pipes a raw
 * user input string through:
 *
 *   parseMentions          (ADR-0325 / ADR-0418 parser, sync)
 *   ↓
 *   buildInjectionFragments(skill-only resolver)   (ADR-0418 ASYNC)
 *   ↓
 *   buildMentionInjectionMessages                  (sync)
 *
 * The end-to-end shape is
 * `(userInputText: string) => Promise<readonly Message[]>`, suitable for
 * direct splice into the per-turn `messages[]` (between `baseMessages`
 * and the trailing `<system-reminder>`, mirroring the insertion point
 * ADR-0321 uses).
 *
 * Status: ADR-0330's sync return shape is **superseded by ADR-0418** —
 * any caller still expecting a sync function must migrate to `await`.
 *
 * NO-THROW (defense in depth): parser / resolver / builder are each
 * already NO-THROW; this composition wraps the WHOLE pipeline in a
 * try/catch so any future regression in any layer cannot crash the
 * caller. Failure ⇒ `[]` (no mentions, byte-identical legacy).
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
 *              resolve to `null` (skipped), all plugin / app / file /
 *              symbol mentions always resolve to `null` regardless
 *              (skill-only flavour — ADR-0330 contract preserved as the
 *              5-kind subset where 4 kinds are frozen-null).
 *
 * @returns a function `(userInputText) => Promise<readonly Message[]>`.
 *          Empty input ⇒ `Promise.resolve([])`. NO-THROW. Order-preserving
 *          (first occurrence of a `(kind, target)` pair survives,
 *          subsequent dropped by the parser-side dedup).
 */
export const createMentionInjector = (
  cfg: MentionRunnerConfig = {},
): ((userInputText: string) => Promise<readonly Message[]>) => {
  const resolver = createSkillOnlyResolver(cfg.skills)
  return async (userInputText: string): Promise<readonly Message[]> => {
    try {
      const mentions = parseMentions(userInputText)
      if (mentions.length === 0) return []
      const fragments = await buildInjectionFragments(mentions, resolver)
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
