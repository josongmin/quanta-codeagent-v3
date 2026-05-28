# ADR-0420 — Observability served-WebSocket sink (closes ADR-0415 emitter-port-only deferral)

**Status:** Accepted (2026-05-29)
**Companion to:** ADR-0406 (observability-wire), ADR-0408 (observability-ui-pane + protocol), ADR-0415 (live-wire — the deferral this ADR closes)
**Default-OFF:** Yes — `QUANTA_OBSERVABILITY` unset ⇒ byte-identical.

## Context

ADR-0415 wired the four live observability ports onto the daemon's `ObservableRuntimeFacade` and fed them to `createObservabilityEmitter(...)`. But it ran the emitter **port-only**: the emitter read live `RunLedger` / `Objective` / `ApprovalStateMachine` state yet had **no daemon-level WebSocket sink**, so `observability.snapshot` / `observability.delta` frames never reached the connected UI pane. ADR-0415 documented this as a deliberate hold whose L4 promotion path was: *"add a daemon-level ws broadcast sink in server.ts so the emitter's snapshot/delta frames reach the connected UI pane live."*

The blocker was that the sink lives at the served-`ServerWebSocket` layer (`src/apps/web-daemon/server.ts`) which was off-limits at the time. This ADR opens that one file (plus the entry composition root) and closes the deferral.

## Decision

### `server.ts` — per-connection sink (`attachObservabilitySink`)
- New exported helper `attachObservabilitySink(ws, ports)`: when `ports` is present it mints **one emitter per connection** whose `ObservabilitySink` forwards encoded frames straight to `ws.send(frame)`; when `ports` is absent it returns `null` (gate OFF ⇒ no sink, byte-identical). The emitter slice (`observability-emitter.ts`) and the protocol slice (`src/protocol/observability/*`) are **consumed only, never modified** (sealed).
- The `ObservabilityPorts` bundle type and the emitter port/timer option types are **re-derived** from `createObservabilityEmitter`'s parameter type, so this surface can never drift from what the sealed emitter accepts.
- Connection lifecycle: the Bun.serve `open` callback attaches the sink (`ws.data.observability = attachObservabilitySink(ws, config.observabilityPorts)`); the `close` callback calls `handle.stop()` and clears the slot so the emitter timer is cleared and **no further frames target a dead socket**. Each connection gets its own emitter + its own snapshot (v1 = one session per socket per ADR-0315).
- Frames ride the **same** `ws` the `SessionTransport` uses; the frontend already multiplexes by the `kind: "observability.*"` discriminant (no frontend change).
- Config is widened locally via `WebDaemonServerConfig extends WebDaemonConfig` with an optional `observabilityPorts` — `WebDaemonConfig` (shared `types.ts`) is left untouched so the gate-OFF surface is byte-identical.

### `index.ts` — thread the ports
- `buildObservabilityPorts(facade)` projects the live facade ports into the `ObservabilityPorts` bundle, returning `undefined` when the facade is absent (gate OFF) or carries no readable port. The bundle is threaded into the server config under `observabilityPorts`.
- Replaces ADR-0415's port-only `startObservabilityEmitter` call (which constructed a sink-less emitter that emitted nowhere) — the server now owns emitter construction per connection.

### NO-THROW
A dead / throwing `ws.send` is swallowed (the sink wraps `ws.send` in try/catch and the emitter also guards internally). `attachObservabilitySink` never throws on a hostile socket; a later tick on a recovered socket still emits.

## Consequences

- **Positive:** `QUANTA_OBSERVABILITY=on` now delivers a `observability.snapshot` on connect + subsequent `observability.delta` frames to each connected UI pane — the pane renders live. Closes the last Wave-3 observability hold.
- **Default-OFF:** unset env ⇒ `observabilityPorts` undefined ⇒ no sink attached ⇒ zero behavior change. Existing web-daemon suite (55 tests) byte-identical, 0 regression.
- **Per-connection isolation:** disconnecting one client freezes only its sink; siblings keep emitting.

## Tests

`tests/unit/observability-ws-sink-hellgate.test.ts` — 14 cases / 37 expects against a FAKE `ServerWebSocket` recording `.send()`: gate-OFF byte-identical (no sink), snapshot-first-on-connect, delta-on-port-change, no-frame-when-unchanged, requestSnapshot re-emit, stop()-freezes + idempotent, two-connection independent snapshots, disconnect-one-keeps-sibling, throwing-send swallowed (NO-THROW), hostile-socket mint never throws, every frame decode-round-trips to a valid `ObservabilityMessage`.

## References

- ADR-0315 — web-daemon served WebSocket surface (one session per socket)
- ADR-0406 — observability-wire (the wire feeding the emitter)
- ADR-0408 — observability-ui-pane + `encodeObservabilityFrame` / `ObservabilityMessage`
- ADR-0415 — observability-live-wire (the emitter-port-only deferral closed here)
