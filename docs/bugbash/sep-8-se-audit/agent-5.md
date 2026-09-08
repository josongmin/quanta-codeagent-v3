# Sep-08 SE audit — agent-5 fact-checked action items

**Fact-check snapshot:** `f5f4875799141068af73e604129c8b9a09f76007`

Only unresolved issues with a reachable producer → contract → consumer path remain. This file is an audit result, not implementation or runtime-closure proof.

## C-F1 [P1] `MCP_USE_ISOLATED_SPAWN` is advertised but has no production consumer

- **Owner:** `src/mcp/isolated-client.ts:56-64` exports `isolatedMcpEnabledFromEnv()` specifically for a composition root.
- **Contradicting contract:** `tools/feature-catalog/features/09-integration/162-mcp-isolated-spawn.yaml:6-30` marks the feature L4/stable/full and states that the env flag swaps legacy `McpClient` for `IsolatedMcpClient`.
- **Reachable consumer:** production MCP construction still uses `new McpClient(...)` in `src/host/mcp-composition.ts:121-135`, `src/agent/mcp-bridge.ts:409`, and `src/agent/skill-mcp-wire.ts:62`. `isolatedMcpEnabledFromEnv()` has no `src/**` caller. The plugin launcher constructs `IsolatedMcpClient` unconditionally and is a separate manifest-driven path.
- **Trigger / impact:** set `MCP_USE_ISOLATED_SPAWN=1` and load a normal configured MCP server; the requested isolated spawn timeout and SIGTERM→SIGKILL lifecycle are not selected.
- **Smallest correction:** either wire one composition-owned client factory that consumes the parser, or remove the knob/full-integration claim from the feature YAML and rebuild the generated catalog.
- **Regression rail:** production-construction test with the flag OFF/ON that asserts the concrete client/spawner path. Parser-only tests are insufficient.

## C-F2 [P2] `SessionVerbSurface` omits three accepted session commands

- **Canonical command set:** `src/protocol/session/commands.ts:207-234` includes `session.objective.mutate`, `session.posture.set`, and `session.skill.set_enabled`.
- **Narrower public surface:** `src/protocol/session/verb-surface.ts:55-101` and `src/ipc/session/handle.ts:675-728` expose no objective/posture/skill verbs, despite the surface claiming every verb is derived from protocol command types.
- **Reachable consumer:** `SessionHandle` is the wire SDK surface; `src/sdk/runtime/handle-adapter.ts:43-61` uses `SessionVerbSurface` as its conformance contract. A raw `SessionTransportClient.sendCommand` can bypass the typed surface, but that does not close the public API gap.
- **Trigger / impact:** a typed wire client attempts one of the three supported commands; it cannot express it through `SessionHandle` even though the codec and kernel accept it.
- **Smallest correction:** add the three verb groups to `SessionVerbSurface`, both verb-surface builders, and their command builders without changing kernel ownership.
- **Regression rail:** compile-time exhaustiveness against `SESSION_COMMAND_TYPES` plus wire/in-process conformance tests for all three verbs.

## C-F9 [P2] HTTP OAuth reauthorization rebuilds a transport without a new MCP session

- **Owner:** `src/mcp/client.ts:822-845` replaces the carrier after a 401 and calls only `next.start()` before retrying.
- **Protocol state owner:** `src/mcp/transports/http-sse.ts:231-236,289-295,336-359,432-435` starts each new transport with no session id, learns `Mcp-Session-Id` from an initialize response, and pins the negotiated protocol version after initialize.
- **Trigger / impact:** a Streamable-HTTP server returns a mid-session 401 and token refresh succeeds. The replacement transport retries an ordinary request without running MCP `initialize`, so it has no server session id and can be rejected or create inconsistent server-side state.
- **Smallest correction:** make reauthorization perform the same initialize/notification handshake used by initial start before retrying the failed request. Do not carry the old session id across credentials unless the protocol contract explicitly permits it.
- **Regression rail:** stateful HTTP test server: initialize assigns a session id, first tool request returns 401, refreshed transport must initialize again and send the new session id on the retry. Existing synthetic OAuth transports do not model this.

## C-F11 [P2] `decodeSessionEvent` validates metadata but trusts event payloads

- **Owner:** `src/protocol/session/codec.ts:238-244` checks the envelope, common metadata, and event type, then casts the remaining payload. The command decoder at `:160-228` performs command-specific checks.
- **Reachable consumers:** `src/ipc/session/codec.ts:287` accepts wire events and `src/kernel/session/event-log-jsonl.ts:209-228` loads persisted events through the decoder. `src/ipc/session/handle.ts:345-357` dereferences `event.approval.approvalId` without another guard.
- **Observed:** the decoder accepted an `approval.requested` event whose `approval` value was `null`.
- **Trigger / impact:** malformed wire or persisted event with a valid type/common metadata but invalid type-specific fields; consumers can throw after decode or poison correlation/state reconstruction.
- **Smallest correction:** add type-specific payload validation for every `SessionEvent` variant, beginning with fields dereferenced by the turn correlator and event-log replay.
- **Regression rail:** table-driven decoder cases with one malformed required field per event variant, plus a persisted-log case proving fail-closed corruption reporting.

## C-F12 [P3] timed-out diagnostics waiters remain retained

- **Owner:** `src/lsp/adapters/base/diagnostics-hub.ts:18-39` resolves a timeout but does not remove that callback or delete an empty URI entry. Cleanup exists only on publish (`:42-51`) or whole-hub teardown (`:54-67`).
- **Reachable consumer:** `LspClient.diagnostics()` calls this hub through `src/lsp/adapters/base.ts:240,603-604`.
- **Observed:** after a zero-duration timeout, `diagnosticsWaiters.size === 1` and the URI still retained one callback.
- **Trigger / impact:** repeated diagnostics requests for files whose language server never publishes diagnostics; settled promises and callbacks accumulate for the session lifetime, and a late publish walks every stale callback.
- **Smallest correction:** remove the timed-out callback and delete the URI key when its waiter array becomes empty.
- **Regression rail:** fake-timer test asserting zero retained keys/callbacks after one and repeated timeouts, while concurrent non-timed-out waiters for the same URI still resolve on publish.

## Verification

- Focused baseline: 60 tests passed across isolated MCP, remote runner, OAuth, session codec, and LSP persistence suites. These characterize current behavior; they do not exercise the retained missing rails.
- Ephemeral probes reproduced malformed `approval.requested` acceptance and diagnostics waiter retention.
- Static call-site census confirmed that `isolatedMcpEnabledFromEnv()` has no production caller and that reauthorization starts a fresh HTTP carrier without re-running initialize.
