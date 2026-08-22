/** ADR-0470 (jun-04) — default `SamplingHandlerPort` for unwired deployments.
 *
 *  Resolves every `sampling/createMessage` to `{ ok: false, reason:
 *  "no-handler" }`. This is the SAFE default and the linchpin of the
 *  advertise-iff-able contract: when this rejecter is in place the MCP client
 *  does NOT advertise `sampling`, so a well-behaved server never asks. If a
 *  server asks anyway, declining is strictly better than fabricating a model
 *  completion or dropping the request.
 *
 *  Mirrors `@/mcp/elicitation` `headlessRejecter`. No throws. */

import type { SamplingHandlerPort, SamplingOutcome } from "./port"

const DECLINE: SamplingOutcome = { ok: false, reason: "no-handler" }

export const headlessSamplingRejecter: SamplingHandlerPort = {
  createMessage: async () => DECLINE,
}
