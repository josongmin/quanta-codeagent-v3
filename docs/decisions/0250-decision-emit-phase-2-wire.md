# ADR-0250: `decision` event emit — Phase 2 wire-up at the admissibility gate

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related ADRs**: ADR-0239 (Phase 1 — `decision` AgentEvent variant + CLI
  debug-tracer consumer + `QUANTA_DEBUG` toggle + `/debug` slash). This ADR
  is the Phase 2 contract: the actual emit sites at the gate-decision
  points that produce the events Phase 1 already knows how to render +
  persist.
- **References**:
  `src/stream/decision-emitter.ts` (new narrow port + `safeEmitDecision`
  helper),
  `src/agent/admissibility-gate.ts` (3 emit sites — rule / hook /
  permission),
  `src/agent/types.ts` (`AgentConfig.decisionEmitter` slot +
  `AdmissibilityGateConfig` Pick extension),
  `tests/unit/agent/decision-emit-hellgate.test.ts` (16-case hellgate).

## Context

ADR-0239 (Phase 1) landed the `decision` `AgentEvent` variant, the
`createDebugTracer` consumer that pretty-prints it to stderr, the
`QUANTA_DEBUG` env-gated boot wire-up, and the `/debug` runtime toggle.
Phase 1 was a *consumer-only* slice — no production code emits the event.
A developer running `QUANTA_DEBUG=1 quanta` today sees the live trajectory
for tool_call / tool_result / llm_request / etc., but the `decisions` line
is silent because nothing populates it. This ADR closes the cycle by
emitting the event at the three documented gate-decision points so the
debug-tracer has *contents* to render.

## Decision

Add an optional `DecisionEmitter` port (NEW, narrow, separate from
`StreamPort`) and call `emitter?.emit(...)` from three sites inside
`runAdmissibilityGate`:

1. **rule** — inside the prefix-rule DSL gate. `allow`, `deny`, `ask`, and
   the `no_match` + `noMatchPolicy: "deny"` arm each emit `kind:"rule"`
   with a `ruleId` of `${layer}:${sourceFile}:${sourceLine}` (categorical;
   never carries the matched command).
2. **hook** — inside `runPreToolUseHook`. The deny arm emits
   `kind:"hook"` with `hookName: "pre_tool_use"`; the admit arm also
   emits so a tracer can confirm WHICH call passed the hook.
3. **permission** — inside `runModePolicy` AND `runPermissionStack`.
   `evaluate` / `evaluateAuto` / `evaluateStack` results map directly to
   `kind:"permission"` with the policy's own `reason` (the canonical
   wording carries only `action.tool`, never input).

Why a *separate* port instead of routing through `StreamPort`: the stdout
adapter + JSONL recorder both already render the `decision` event variant
the moment it lands on the main stream (they were authored alongside
Phase 1's consumer wiring). Routing through `StreamPort` by default would
break the **default-OFF byte-identical surface invariant** (ADR-0239,
explicit Phase 2 contract clause 1). The narrow port lets a composition
root wire emission ONLY when `QUANTA_DEBUG` is on, pointing at the
debug-tracer (NOT stdout/jsonl), so the user-facing surface stays
identical until the developer opts in.

The emit helper sanitises the call shape:

- `reason` is a short one-liner constructed at the emit site — never tool
  input, never file contents.
- `metadata` carries ONLY `{ tool: action.tool }`. Action `input` is
  *never* spread.
- `toolCallId` mirrors `call.id` so the tracer can pair the decision row
  with the upstream `tool_call.id`.
- `turn` flows from `config.run?.turn ?? 0`.

A `safeEmitDecision` wrapper swallows any throw from the consumer so a
misbehaving tracer cannot poison the gate's deny/allow result.

## Scope (this ADR)

In-scope: rule, hook, permission. Out-of-scope (Phase 3 / follow-up):
cap (`@/agent/cap-enforcer`), jail (`@/storage/fs-jail-lib`), budget
(`@/agent/budget`). Those three gates do NOT live on the
`runAdmissibilityGate` call graph and require their own emit-port wire-up
in their respective composition roots; investigated and deferred to keep
this slice closed.

## Default-OFF guarantee

`AgentConfig.decisionEmitter` is optional. When absent (the production
default), `emitGateDecision` short-circuits before constructing the event
object — zero allocation, zero stream writes. The 16-case hellgate
asserts the gate result is identical between `decisionEmitter: undefined`
and `decisionEmitter: collector` paths.

## Slice fence

- `src/stream/decision-emitter.ts` is a leaf in `@/stream` — imports only
  the local `AgentEvent` + `StreamPort` types.
- `src/agent/admissibility-gate.ts` reaches `@/stream` exclusively via
  `safeEmitDecision` (no adapter classes, no I/O).
- `AdmissibilityGateConfig` grew exactly ONE `Pick` field
  (`decisionEmitter`); existing callers (`dispatch.ts`) compile unchanged
  via structural subtyping.

## Tests

`tests/unit/agent/decision-emit-hellgate.test.ts` — 16 cases / 51 expects:

- 4 rule branches (allow / deny / ask / no_match-deny)
- 3 hook branches (deny / admit / no-hooks)
- 3 permission branches (bypass-allow / default-ask / read-only-allow)
- 6 invariants (default-OFF byte-identity, throwing emitter isolation,
  no-double-emit on routed paths, metadata-sanitise, turn=0 default,
  turn from `config.run.turn`).

All pass. Zero regression on the broader 1008-test agent unit suite +
1079 permission/stream/admissibility tests.
