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
 *
 * DEPTH (RFC jul-13 P0-b, correctness): a delegate CHILD runs at THIS agent's
 * `config.depth + 1` (0 = root ⇒ child depth 1), mirroring the foreground
 * `buildChildConfig(parentDepth + 1)` convention. The `+1` is threaded where
 * the opaque `config.delegation.delegator` PORT is CONSTRUCTED — the composition
 * root (`agent-arg-builder.resolveDelegation` / `session-execution-plane.
 * adaptDelegation`) reads the parent `AgentConfig.depth` and feeds it into
 * `wrapSubagentRunner(parentDepth)` + the delegate spec `depth`. This builder
 * receives the ALREADY-BOUND port, so it does NOT re-thread depth; the spec
 * `depth` it carries drives the delegation-runner `MAX_DEPTH` gate and the
 * runtime `req.depth > maxDepth` reject (previously dead: hardcoded 0).
 */

import type { Tool } from "@/tool"
import { delegateTools, type DelegationPort as ToolDelegationPort } from "@/tool/delegate"
import type { AgentConfig } from "../types"

/** Build the synchronous delegation tool when the delegator slot is wired. */
export const buildDelegateBlock = (config: AgentConfig): Tool[] => {
  const delegator = config.delegation?.delegator
  if (delegator === undefined) return []
  // rev.4 §4.4 — capability projection (TOOL-EXPOSURE) moved to the single
  // `projectSpawnTools` filter at the `features.ts` seam (SSOT). `delegate` is
  // minted here unconditionally and removed downstream for a leaf. (The depth
  // doc-comment above governs the SPEC depth a delegate child runs at — a
  // separate concern from whether the tool is offered.)
  // The producer `DelegationPort` (ADR-0218) is a structural superset of the
  // tool-side narrower `DelegationPort` mirror (`delegate` + `listModes`); the
  // assignment narrows it to the consumed surface.
  return delegateTools(delegator as ToolDelegationPort)
}
