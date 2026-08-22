/** ADR-0196 — default `CapabilityNegotiator` impl.
 *
 *  Emits `{}` — byte-identical with the pre-ADR-0196 hard-coded literal at
 *  `src/mcp/client.ts:126`. Every existing call site that does not opt into
 *  `QUANTA_MCP_CAPS=full` sees this impl. */

import type { CapabilityNegotiator, McpCapabilityRecord } from "./port"

const EMPTY: McpCapabilityRecord = Object.freeze({})

export const defaultNegotiator: CapabilityNegotiator = {
  compile: (): McpCapabilityRecord => EMPTY,
}
