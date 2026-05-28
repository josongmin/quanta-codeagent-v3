/**
 * Tier-1 per-subsystem builder: SYNCHRONOUS DELEGATION block (ADR-0393).
 *
 * Returns the `delegate` tool when `config.delegation?.delegator` is wired;
 * empty array otherwise.
 *
 * DEFAULT-OFF: `config.delegation` absent ⇒ this builder returns [], so the
 * loop sees no extra tool and the ToolRegistry stays byte-identical. Mirrors
 * `buildSubagentBgBlock` posture.
 *
 * SLICE FENCE: the `@/tool/delegate` slice declares a DUCK-TYPED `DelegationPort`
 * mirror so it never imports `@/agent`. This builder is the composition root
 * that adapts the concrete `AgentConfig.delegation.delegator` (the producer
 * `DelegationPort` from `@/agent/subagent-typed`, ADR-0218) into the tool's
 * narrower port. The producer port is a STRUCTURAL SUPERSET of the tool port
 * (it additionally carries `describeMode`), so the assignment is direct — the
 * tool only consumes `delegate` + `listModes`.
 *
 * EXPLORE NOTE: there is no `explore` method on the producer port — `explore`
 * is a MODE VALUE the LLM passes through `delegate({ mode: "explore", … })`.
 */

import type { Tool } from "@/tool"
import { delegateTools, type DelegationPort as ToolDelegationPort } from "@/tool/delegate"
import type { AgentConfig } from "../types"

/** Build the synchronous delegation tool when the delegator slot is wired. */
export const buildDelegateBlock = (config: AgentConfig): Tool[] => {
  const delegator = config.delegation?.delegator
  if (delegator === undefined) return []
  // The producer `DelegationPort` (ADR-0218) is a structural superset of the
  // tool-side narrower `DelegationPort` mirror (`delegate` + `listModes`); the
  // assignment narrows it to the consumed surface.
  return delegateTools(delegator as ToolDelegationPort)
}
