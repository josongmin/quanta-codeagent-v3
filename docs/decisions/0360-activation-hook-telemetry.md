# ADR-0360 — Per-turn plugin activation telemetry

## Status

Accepted — 2026-05-27.

## Context

ADR-0346 introduced `resolvePluginActivationForTurn` — the per-turn
hook that parses the latest user-text mentions, calls
`cfg.activatePlugins` (ADR-0340), and unions the resolved plugin skills
onto the active-skills channel for the same `buildTurnContext` call.

The hook runs once per turn, before prompt assembly. Operators have no
visibility today into:

- How often the hook runs (turn count with activator wired).
- How long each call takes (synchronous wait blocking prompt build).
- How many skills the activator returns per call (sizing the active-skills channel).
- How often the activator throws (silent NO-THROW swallow today).

Codex's OTel vocabulary (memory `codex-otel-attribute-vocabulary`)
emits per-turn span families: `codex.turn.{started_at, latency_ms,
resolved_skills, errors, …}`. The v3 equivalent for plugin activation
is the missing piece — without it, hot plugin activators degrade silently.

## Decision

Emit four counters from inside `resolvePluginActivationForTurn` when a
`MetricEmitterPort` (ADR-0352) is wired via the
`config.metricsEmitter` structural field (populated by the ADR-0358
composition wire):

| Counter                                       | When emitted                              | Meaning |
|-----------------------------------------------|-------------------------------------------|---------|
| `codex_r2.activation.calls`                   | every invocation (post-mentions)          | total activations |
| `codex_r2.activation.sum_latency_ms`          | successful activation                     | sum of elapsed ms (operator divides by `calls`) |
| `codex_r2.activation.resolved_skills_count`   | successful activation                     | count of skills returned (per call delta) |
| `codex_r2.activation.errors`                  | activator throws                          | total failures |

Order: `calls` is emitted UP-FRONT (after mentions parse, before
activator). This guarantees that even a thrown activator increments
the call counter so operators can compute `error_rate = errors / calls`
exactly.

Latency: monotonic via `performance.now()` — `Date.now()` jumps when
NTP corrects, which would poison sum-latency math.

### MetricEmitterPort shape stays 2-method

ADR-0352 deliberately exposed only `counter` + `gauge`. Histograms
were left for a future extension. ADR-0360 chooses Option B
(sum-counter) over extending the port to keep the codex-r2 slice
plane-clean. Operators get mean latency via
`codex_r2.activation.sum_latency_ms / codex_r2.activation.calls` and
P50/P95 via a downstream OTel histogram view (the OTel sink in
`@/observability/metrics/otel-sink` provides this server-side).

### `ActivationHookConfigLike.metricsEmitter` field

Existing local interface in `loop-activation-hook.ts` extends to
declare `readonly metricsEmitter?: MetricEmitterPort`. The
`AgentConfig` type surface is NOT mutated — the composition root
(ADR-0358) assigns via structural cast, and the loop reads via the
local interface. This keeps the type-level slice fence clean.

## Non-goals

- **No new port.** Reuses `MetricEmitterPort` from ADR-0352.
- **No histogram method.** Sum-counter (Option B) covers the
  observability need without expanding the agent-side port.
- **No mention-injection telemetry.** Only the activation hook is
  instrumented here; ADR-0325 mention resolver is a separate slice.
- **No AgentConfig.metricsEmitter type field.** Structural
  side-channel only (ADR-0358 sets it on the cfg object).

## Codex OTel attribute vocabulary alignment

| v3 counter | Codex parallel (`codex.turn.*`) |
|---|---|
| `codex_r2.activation.calls` | `codex.turn.count` |
| `codex_r2.activation.sum_latency_ms` | `codex.turn.latency_ms_sum` |
| `codex_r2.activation.resolved_skills_count` | `codex.turn.resolved_skills_count` |
| `codex_r2.activation.errors` | `codex.turn.errors` |

Operators bridging to a Codex-flavored OTel dashboard rewrite the
`codex_r2.` prefix to `codex.` and inherit the same panels.

## NO-THROW

Three layers:

1. `safeEmit(emitter, fn)` wraps every emit in try/catch — a hostile
   emitter cannot break the activation hook.
2. The emitter contract (ADR-0352 §types.ts) is already NO-THROW at
   the implementor.
3. The ADR-0358 adapter delegates to a `MetricsRegistry` that silently
   coerces poison values (ADR-0144 contract).

The hook itself preserves the ADR-0346 NO-THROW posture verbatim:
absent activator / empty text / throwing activator ⇒ `EMPTY` result
returned. Telemetry is best-effort and never propagates.

## Default-OFF

`config.metricsEmitter === undefined` ⇒ `safeEmit` returns immediately
without calling `monotonicNow()` for any emit-only path (we DO measure
elapsed even when the emitter is absent, but the cost is one
`performance.now()` per turn — negligible). Set the emitter via
ADR-0358 composition wire to opt in.

## Short-circuit ordering

Emit is gated by mentions-found AND activator-present:

1. `config.activatePlugins === undefined` ⇒ EMPTY return BEFORE any emit.
2. Empty user text ⇒ EMPTY return BEFORE any emit.
3. `parseMentions` throws or returns zero mentions ⇒ EMPTY return BEFORE any emit.
4. Activator runs ⇒ emit `calls`, then `sum_latency_ms` + `resolved_skills_count` on success OR `errors` on throw.

This keeps the counter `calls` semantically aligned with "activator was
actually called", not "the loop entered the hook" — operators care
about the former for capacity planning.

## Slice fence

- Touched: `src/agent/loop-activation-hook.ts` (interface extension +
  safeEmit helper + monotonicNow + 4 emit points),
  `tests/unit/loop-activation-telemetry-hellgate.test.ts` (new).
- NOT touched: `src/agent/loop.ts`, `src/agent/prompt-body.ts`,
  `src/agent/types.ts`, `src/agent/plugin-activation-handler/*`,
  ADR-0346 callers.

## Hellgate coverage

8 cases:
- A. emitter absent ⇒ no emit (byte-identical legacy)
- B. successful activation ⇒ `calls` + `sum_latency_ms`
- C. `resolved_skills_count` = activator's array length
- D. activator throws ⇒ `errors` + `calls` (no `sum_latency_ms`)
- E. emitter.counter throws ⇒ swallowed (NO-THROW)
- F. activator absent ⇒ no emit
- G. empty user text ⇒ no emit
- H. zero mentions ⇒ no emit (short-circuit before counter)

## References

- ADR-0144 — typed MetricsRegistry port
- ADR-0340 — `cfg.activatePlugins` config slot
- ADR-0346 — `resolvePluginActivationForTurn` loop hook
- ADR-0352 — codex-r2 observability decorators + `MetricEmitterPort`
- ADR-0358 — composition-root wire that populates `cfg.metricsEmitter`
- Memory `codex-otel-attribute-vocabulary` — Codex OTel keys
