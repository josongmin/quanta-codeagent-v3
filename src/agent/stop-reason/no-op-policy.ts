/**
 * No-op policy — every reason maps to `"continue"` (ADR-0241).
 *
 * Used as the implicit fallback when {@link AgentConfig.stopReasonPolicy} is
 * absent: the wire path consults a policy, but a policy that always returns
 * `"continue"` is observably identical to NOT consulting one (the loop falls
 * through to the historical 3-arm `decideOnAssembled` branch). HELL-SR-10
 * asserts the byte-identical property against the default 3-arm output.
 *
 * Hosts that want to OBSERVE stop reasons without changing behavior can
 * attach this policy + their own `ctx.metrics` and get per-arm counts
 * without altering the loop's control flow.
 */

import type { StopReasonPolicy } from "./port"

export const NO_OP_STOP_REASON_POLICY: StopReasonPolicy = {
  handle() {
    return "continue"
  },
}
