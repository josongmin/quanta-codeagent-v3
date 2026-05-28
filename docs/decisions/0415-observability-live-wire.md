# ADR-0415 — Observability live-wire (HookBus auto-subscribe + RuntimeFacade port exposure)

**Status:** Accepted (2026-05-28)
**Companion to:** ADR-0394/0395/0396 (Wave-1 substrate), ADR-0401/0402/0403/0406/0408 (Wave-2/3 attribution + wire + UI)
**Default-OFF:** Yes — `QUANTA_OBSERVABILITY` unset ⇒ byte-identical.

## Context

Wave-3 (ADR-0406 observability-wire) shipped the composition-root wire but with three documented deliberate-holds:

1. **AgentConfig had no slot** for `runLedger` / `approvalStateMachine` — the wire parked them on its handle. (Resolved by the Part-1 slot promotion: those two ports are now first-class `AgentConfig` slots alongside `objective` + `shadowVerify`.)
2. **AgentConfig had no first-class HookBus seam** (`src/apps/agent/index.ts` literally said "AgentConfig has no first-class HookBus slot; a follow-up slice can adapt"). So the run-ledger-attribution subscriber (ADR-0401) was wired but NEVER subscribed in production — "what is the agent doing now" stayed empty.
3. **RuntimeFacade did not expose the 4 ports** → the web-daemon observability-emitter (ADR-0408) read nothing → the UI pane showed empty placeholders.

This ADR closes all three so Wave-1/2/3 observability actually goes live.

## Decision

### Part 1 (landed separately) — AgentConfig slot promotion
`runLedger?: RunLedgerPort` + `approvalStateMachine?: ApprovalStateMachinePort` added to `AgentConfig` + `FeaturesConfig` Pick. Both optional ⇒ default-OFF byte-identical. Surface consumers (emitter, attribution, approval-gate) now reach them directly.

### Part 2 — HookBus auto-subscribe (`src/apps/agent/index.ts`)
- `resolveObservabilityWire(env, { hookBus? })` now accepts an optional live `HookBus`, adapted to the wire's duck-typed `ObservabilityHookBus` via `toObservabilityHookBus` (`bus.on(event, handler)`; no-op detach since `HookBus.on` has no `off()`).
- `resolveObservabilitySlots(env)` mints the canonical `HookBus` ONLY when `QUANTA_OBSERVABILITY=on`, subscribes run-ledger-attribution to `post_tool_use`, and returns the 4 ports + `hooks` as a presence-only AgentConfig fragment (single spread). Gate OFF ⇒ `{}`.

### Part 3 — RuntimeFacade port exposure (`runtime-factory.ts` + `index.ts`)
- `ObservableRuntimeFacade extends RuntimeFacade` with 4 optional read-only ports; `attachObservabilityPorts(facade, handle)` proxies getters via `Object.defineProperties` (preserving `createSession`/`close`). `RuntimeFacade` in `@/sdk/runtime` is left untouched (slice fence).
- `buildProductionRuntimeFactory` mints a per-session wire + bus, threads ports onto the session config, returns the widened facade.
- `index.ts` (gate ON) mints ONE facade so the emitter + served session share the same wire handle, then feeds `createObservabilityEmitter` the live ports.

## Known follow-up

No daemon-level `ws` broadcast sink exists without touching the off-limits `server.ts`, so the emitter currently runs port-only (live ports are the load-bearing deliverable; pushing deltas over the served WS is the next wire). Documented, not blocking.

## Consequences

- **Positive:** "what is the agent doing / why stopped / what's next" is now backed by live data when `QUANTA_OBSERVABILITY=on`. Run-ledger-attribution finally subscribes; the 4 ports are reachable from both AgentConfig and RuntimeFacade.
- **Default-OFF:** unset env ⇒ zero behavior change. apps/agent (180) + web-daemon (55) suites byte-identical, 0 regression.

## Tests

`tests/unit/observability-live-wire-hellgate.test.ts` — 21 cases / 70 expects (HookBus subscribe/unsubscribe via fake bus, AgentConfig slot population gated, RuntimeFacade getters, emitter receives live ports, idempotent re-wire, byte-identical default-OFF).

## References

- ADR-0394/0395/0396 — Wave-1 substrate (Objective / Run Ledger / Shadow Verify)
- ADR-0401 — run-ledger-attribution (the subscriber this ADR finally subscribes)
- ADR-0406 — observability-wire (the wire this ADR feeds a live HookBus)
- ADR-0408 — observability-ui-pane (the emitter this ADR feeds live ports)
