# T-203: Claim-trace force-guard (gated escalation of T-201/202)

**RFC:** [02·W3](../02-rfc-evidence-claim-trace.md) · **Priority:** P2 · **Size:** S · **Deps:** T-201, T-202 · **Posture:** OFF (`QUANTA_CLAIM_TRACE_FORCE`)

## Deliverable
A third guard in `src/agent/guards/chain.ts` (alongside verify-guard; chain runs via `runGuardChain`, `src/agent/loop/recovery-executor.ts:203`) converting "claimed path does not exist" / "verification claim without verify" into a verify-guard-style forcing message, with a trip budget.

## Acceptance criteria
- [ ] Guard-chain integration test (forcing fires once, trip budget respected).
- [ ] Gate OFF → byte-identical behavior.
- [ ] Coexists with verify-guard trips without double-forcing the same turn.
