# ADR-0460: Proactive token-refresh scheduler for connectors

**Status:** Accepted (2026-06-03)
**Type:** New connectors slice (closed-port, default-OFF). Extends ADR-0160
Phase E token rotation; does NOT modify the rotator.
**Scope:** `src/connectors/token-refresh-scheduler.ts` + barrel export +
`src/connectors/__tests__/token-refresh-scheduler-hellgate.test.ts`. The rotator
(`src/connectors/token-rotation.ts`) is UNCHANGED.

## Context

ADR-0160 Phase E shipped per-connector token rotation: `TokenRotator.rotate(id,
refresh)` with an in-flight mutex (concurrent rotates for the same id coalesce
onto one promise) and atomic persist. But rotation is **caller-driven only** — a
connector refreshes its access token when a caller explicitly invokes `rotate()`,
which in practice happens reactively AFTER a wire call already returned 401. A
long-running task can therefore hit an expired token mid-flight, eat the 401, and
only then refresh — pure friction on the hot path.

The fix is a clock-driven scheduler that refreshes BEFORE expiry, so the new
token is in hand before the old one lapses, removing the 401-mid-task friction.

## Decision

Add a `TokenRefreshScheduler` closed-port. Given a `TokenRecord` carrying an
`expiresAt`, it schedules a refresh at `expiresAt - LEAD_MS`. On fire it calls
the SAME `TokenRotator.rotate(connectorId, refresh)` path — it does NOT duplicate
the rotator's mutex or atomic persist. On success it re-schedules from the new
token's expiry. The scheduler is opt-in: connectors that never construct it are
byte-identical (rotation stays purely caller-driven).

### Port shape

```ts
interface TimerPort {
  set(callback: () => void, delayMs: number): TimerHandle  // TimerHandle = opaque
  clear(handle: TimerHandle): void
}

interface TokenRefreshSchedulerConfig {
  rotator: TokenRotator                 // reused verbatim — single source of mutex/persist
  clockPort: ClockPort                  // the SAME ClockPort the rotator uses
  timerPort: TimerPort                  // injected setTimeout/clearTimeout pair
  refresh: (current: TokenRecord | undefined) => Promise<TokenRecord>  // same sig as rotate()
  onError?: (connectorId: string, error: unknown) => void
}

interface TokenRefreshScheduler {
  schedule(connectorId: string, record: TokenRecord): void
  cancel(connectorId: string): void
  stop(): void
  pendingCount(): number
}
```

### LEAD_MS — a structural margin, not a heuristic

`LEAD_MS = 60_000`. This is a MARGIN, not a tunable. If we fired exactly at
`expiresAt`, the refresh network round-trip itself would straddle the expiry
boundary and a concurrent call could still observe an expired token. 60s is a
conservative upper bound on (refresh RTT + tolerated client/server clock skew):
large enough that the fresh token lands before the old one lapses, small enough
to avoid refreshing wastefully far ahead. It is a single named constant (not
per-connector configurable) so the margin is uniform and auditable —
configurability would invite cargo-cult drift.

### Reuse of the rotator mutex (no duplication)

The timer body calls `config.rotator.rotate(id, config.refresh)` — the exact API
the caller-driven 401 flow uses. The rotator owns the in-flight `Map<id,
Promise>`; a scheduled fire that overlaps a manual `rotate()` for the same id
coalesces onto that single promise. The scheduler holds NO mutex of its own and
re-implements NO persist logic.

### Clock + timer injection (deterministic)

Both the clock (`ClockPort.now()`) and the timer (`TimerPort.set/clear`) are
injected. Tests use a fake clock + a fake timer whose `fireNext()` invokes the
recorded callback synchronously, so refresh firing is fully deterministic with
zero real timers.

### Backoff on failure

A failed scheduled refresh must neither tight-loop (hammering the issuer) nor
give up silently. The body catches, routes the error to `onError` (best-effort —
a throwing observer is swallowed), and re-arms a single retry with bounded
exponential backoff (`BACKOFF_BASE_MS = 1s`, doubling, capped at
`BACKOFF_MAX_MS = 5min`). Exactly one retry timer is armed per failure — never a
synchronous loop.

### No unhandled rejection

The timer callback runs an async IIFE wrapped in `void`; the IIFE owns a
try/catch over the entire body so nothing can reject out of the timer. Even with
no `onError` configured, a refresh rejection is fully absorbed.

### No timer leak

At most ONE pending timer per connector id. Arming clears any prior timer for the
id first; the fired handle is removed from the pending map BEFORE the body runs.
`stop()` clears every pending timer and empties the map — call it on session end.
`pendingCount()` exposes the live count for leak assertions.

### No-expiry tokens

A `TokenRecord` with no `expiresAt` is a no-op (and clears any stale prior
timer): there is no deadline to anticipate. A successful refresh that returns a
token with no expiry likewise stops the cadence.

## Consequences

- 401-mid-task friction removed for connectors that opt in.
- Zero behavioural change for connectors that don't (default-OFF, byte-identical
  rotation).
- Single source of truth for the refresh mutex/persist (the rotator) — no drift.

## Alternatives considered

- **Reuse `src/agent/retry.ts` backoff** — rejected: that util is LLM-specific
  and lives in the `@/agent` plane, which the connectors slice deliberately does
  NOT import (plane-clean: stdlib only). A small documented exponential inline
  keeps the slice fence intact.
- **A second wall-clock** — rejected: the scheduler reuses the connectors
  `ClockPort` the rotator already uses; no second clock is introduced.

## Deferred

- Composition-root wire (constructing the scheduler in agent assembly with real
  `setTimeout`/`clearTimeout` + the connector's real `refresh`) is a follow-up,
  consistent with ADR-0160's "wire-up into agent dispatch is a follow-up ADR."
- Jitter on the backoff (thundering-herd across many connectors refreshing at
  once) is intentionally out of scope; the per-id single-flight + the proactive
  lead already spread fires by each token's own expiry.
