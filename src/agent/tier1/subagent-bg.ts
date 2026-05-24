/**
 * Tier-1 per-subsystem builder: BACKGROUND SUBAGENT block (ADR-0130).
 *
 * Returns the `subagent_fork` + `subagent_poll` + `subagent_await` tools when
 * `config.subagentBackground?.scheduler` is wired; empty array otherwise.
 *
 * DEFAULT-OFF: `config.subagentBackground` absent ⇒ this builder returns [],
 * so the loop sees no extra tools and the ToolRegistry stays byte-identical.
 * Mirrors `buildShadowBlock` posture.
 *
 * DUCK-TYPED CONFIG ACCESS: `subagentBackground` is NOT (yet) declared on
 * `AgentConfig` — the caller-wire ADR (sibling) appends it separately. We
 * read the slot through a narrow structural assertion so this module stays
 * standalone and can land before the caller-wire PR (deferred-wire posture,
 * voice-match ADR-0124 / ADR-0128 / ADR-0125). Once the slot lands on
 * `AgentConfig`, this cast becomes a direct member access.
 */

import type { Tool } from "@/tool"
import { subagentBgTools } from "@/tool/subagent-bg"
import type { BackgroundSubagentScheduler } from "../subagent-background"
import type { AgentConfig } from "../types"

/** Narrow structural slot the caller appends onto `AgentConfig` separately. */
interface SubagentBackgroundConfigSlot {
  subagentBackground?: { scheduler: BackgroundSubagentScheduler }
}

/** Build the background subagent tools when the slot is wired. */
export const buildSubagentBgBlock = (config: AgentConfig): Tool[] => {
  // Duck-typed read: the slot is added on `AgentConfig` by a sibling PR.
  // Until then, treat `config` as the union with the optional slot — the
  // structural shape is what matters here, not the declared field.
  const bag = config as AgentConfig & SubagentBackgroundConfigSlot
  const scheduler = bag.subagentBackground?.scheduler
  if (scheduler === undefined) return []
  return subagentBgTools(scheduler)
}
