/** Synchronous delegation tool — ADR-0393.
 *
 *  One LLM-facing tool (`delegate`) wrapping a {@link DelegationPort}: hand a
 *  subtask to a child agent under a named MODE and BLOCK until it finishes,
 *  then receive the typed {@link BoomerangResult} in-band. The synchronous
 *  boomerang sibling of the asynchronous background trio (`subagent_fork` /
 *  `subagent_poll` / `subagent_await`, ADR-0140).
 *
 *  The port is a DUCK-TYPED mirror of `DelegationPort` from
 *  `@/agent/subagent-typed` (ADR-0218). We mirror it here so the `@/tool` slice
 *  does NOT import `@/agent` (slice fence, RFC §3.1; biome enforces). The
 *  composition root in `@/agent/tier1/delegate` adapts the concrete
 *  `config.delegation.delegator` into this narrower port at wire time.
 *
 *  Plane-clean: imports only `../types` + `zod`. NO `@/agent`. */

import type { Tool } from "../types"
import { delegateTool } from "./delegate"

export type { DelegateInput } from "./delegate"
export { delegateInputSchema, delegateTool } from "./delegate"
export type {
  AgentMode,
  BoomerangErrorKind,
  BoomerangResult,
  DelegationPort,
  DelegationRequest,
} from "./port"
export { DELEGATE_MODES } from "./port"

import type { DelegationPort } from "./port"

/** Build the synchronous delegation tool wired to a delegation port. Returns a
 *  single-element array to mirror the `subagentBgTools` builder shape so the
 *  tier-1 composer can spread it uniformly. */
export const delegateTools = (port: DelegationPort): Tool[] => [delegateTool(port) as Tool]
