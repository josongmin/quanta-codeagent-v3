/** ADR-0196 — typed MCP client capability surface.
 *
 *  The `capabilities` field on the `initialize` JSON-RPC envelope is the
 *  client's advertisement of optional features. The default impl emits `{}`
 *  (byte-identical with the pre-ADR-0196 hard-coded literal); the full impl
 *  emits the four flags rmcp 0.15 understands.
 *
 *  `compile()` returns the canonical (sorted-keys) capability record an
 *  `initialize` RPC consumes. The shape is closed-union per slot:
 *  presence-only objects (`{ tools: {} }`) carry the feature flag itself;
 *  nested option objects (`{ tasks: { listChanged: false } }`) carry the
 *  per-feature options. */

/** rmcp 0.15 capability record. Each slot is OPTIONAL — absent = unsupported,
 *  present = supported (the inner shape carries the per-feature options). */
export interface McpCapabilityRecord {
  /** Presence advertises tool/list+call support. Inner object reserved for
   *  future per-tool options; today emitted as `{}`. */
  tools?: Record<string, never>
  /** Presence advertises sampling/createMessage support. */
  sampling?: Record<string, never>
  /** Presence advertises elicitation/* support (ADR-0197 sibling). */
  elicitation?: Record<string, never>
  /** Presence advertises tasks/* support (ADR-0196). `listChanged` tells the
   *  server whether the client subscribes to `notifications/tasks/listChanged`. */
  tasks?: { listChanged: boolean }
}

/** Closed-port: the only thing the MCP client cares about is the canonical
 *  serialized capability record. Adding a 5th capability requires extending
 *  {@link McpCapabilityRecord} AND every impl's `compile()`. */
export interface CapabilityNegotiator {
  compile(): McpCapabilityRecord
}
