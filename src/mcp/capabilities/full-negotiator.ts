/** ADR-0196 + ADR-0470 (jun-04) — full `CapabilityNegotiator` impl.
 *
 *  Emits the rmcp 0.15 flags in JSON-canonical (sorted-keys) order so the
 *  on-wire payload is byte-deterministic across runs. Wired at the composition
 *  root when `QUANTA_MCP_CAPS=full` is set.
 *
 *  ## Advertise-iff-able (ADR-0470)
 *
 *  `sampling` is advertised IFF a real `SamplingHandlerPort` is wired — never
 *  by default. Advertising a capability we cannot fulfill is false advertising:
 *  the server would send `sampling/createMessage` and (pre-fix) be killed with
 *  `-32601 method not found`. `tools`, `elicitation`, and `tasks` are always
 *  fulfillable (elicitation routes to the always-present prompter; tasks proxy
 *  the server), so they remain unconditional.
 *
 *  `tasks.listChanged` stays `false`: we never emit
 *  `notifications/tasks/list_changed`, so `false` is the HONEST advertisement
 *  (claiming `true` would promise a subscription we don't service). */

import type { CapabilityNegotiator, McpCapabilityRecord } from "./port"

/** Options that gate optional, advertise-iff-able capabilities. */
export interface FullNegotiatorOptions {
  /** Advertise `sampling` ONLY when a real inbound-sampling handler is wired at
   *  the composition root. Defaults to `false` (omitted) so an unwired
   *  deployment never falsely advertises a capability it would decline. */
  sampling?: boolean
}

/** Build a fresh, canonically-ordered record. The shape is rebuilt every call
 *  so a mutating caller cannot poison a shared default. Keys are inserted in
 *  alphabetical order to match `JSON.stringify` on a freshly-allocated object
 *  (V8 preserves insertion order for string keys), so two serialize calls
 *  produce identical bytes. */
const compile = (opts: FullNegotiatorOptions): McpCapabilityRecord => ({
  elicitation: {},
  // sampling is advertise-iff-able (ADR-0470): present only when a handler is
  // wired. Inserting it conditionally keeps the canonical alphabetical order
  // (elicitation < sampling < tasks < tools) for both the present and absent
  // serializations.
  ...(opts.sampling === true ? { sampling: {} as Record<string, never> } : {}),
  tasks: { listChanged: false },
  tools: {},
})

/** `opts.sampling` defaults to `false` so every existing `fullNegotiator()`
 *  call (no handler wired) is HONEST — sampling is omitted. The composition
 *  root opts in with `fullNegotiator({ sampling: true })` once an
 *  `@/llm`-backed `SamplingHandlerPort` is injected into the client. */
export const fullNegotiator = (opts: FullNegotiatorOptions = {}): CapabilityNegotiator => ({
  compile: () => compile(opts),
})
