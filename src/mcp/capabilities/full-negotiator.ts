/** ADR-0196 — full `CapabilityNegotiator` impl.
 *
 *  Emits the four rmcp 0.15 flags (`tools`, `sampling`, `elicitation`,
 *  `tasks`) in JSON-canonical (sorted-keys) order so the on-wire payload
 *  is byte-deterministic across runs. Wired at the composition root when
 *  `QUANTA_MCP_CAPS=full` is set. */

import type { CapabilityNegotiator, McpCapabilityRecord } from "./port"

/** Build a fresh, canonically-ordered record. The shape is rebuilt every
 *  call so a mutating caller cannot poison the shared default. */
const compile = (): McpCapabilityRecord => ({
  // Keys deliberately inserted in alphabetical order to match
  // JSON.stringify on a freshly-allocated object (V8 preserves insertion
  // order for string keys), so two serialize calls produce identical bytes.
  elicitation: {},
  sampling: {},
  tasks: { listChanged: false },
  tools: {},
})

export const fullNegotiator = (): CapabilityNegotiator => ({
  compile,
})
