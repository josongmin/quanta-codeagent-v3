# ADR-0506: Anthropic `service_tier` request control

- **상태**: Accepted
- **날짜**: 2026-06-07
- **관련**:
  - `src/llm/anthropic-messages-codec.ts` (`normalizeAnthropicServiceTier`, request builder 5th param)
  - `src/llm/adapters/anthropic.ts` (`serviceTier` field, public-readonly)
  - `src/llm/factory.ts` (`resolveServiceTier`)
  - Tests: `tests/unit/anthropic-service-tier-hellgate.test.ts`, `tests/unit/service-tier-factory-e2e-hellgate.test.ts`
  - Absorbs: Anthropic service tiers (gap-other-agent GAP 5)

## Context

The Anthropic Messages API accepts a `service_tier` (auto / standard_only / priority) to control
latency/cost capacity. quanta never sent it, so it could not opt a run into priority capacity nor
pin standard-only.

## Decision

`resolveServiceTier(opts, env)` resolves the intent at the composition root (`QUANTA_FAST` ⇒
`priority`; else `QUANTA_SERVICE_TIER`). The adapter threads it (public-readonly `serviceTier`,
mirroring `betaHeaders`) to the codec, which `normalizeAnthropicServiceTier` maps onto the value we
SEND: `auto` for {auto, priority, fast}, `standard_only` for {standard, standard_only}, else dropped.
`priority`/`fast` collapse to `auto` deliberately (safer — `auto` falls back to standard when priority
capacity is unavailable, whereas a literal `priority` can be rejected). Absent intent ⇒ no
`service_tier` key (byte-identical); the 5th codec param is optional so all cloud adapters
(bedrock/vertex/foundry/mantle) stay byte-identical.

## Consequences

A run can opt into priority capacity via `QUANTA_FAST`; cost/latency posture becomes an operator knob.
