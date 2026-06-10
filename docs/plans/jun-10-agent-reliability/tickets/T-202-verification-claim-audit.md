# T-202: Verification-claim audit (en+ko anchored registry)

**RFC:** [02·W2](../02-rfc-evidence-claim-trace.md) · **Priority:** P1 · **Size:** M · **Deps:** T-201 (shares finish seam + claimAudit shape) · **Posture:** ON (annotate-only)

## Deliverable
At the same finish seam: if final text asserts verification (small anchored registry: "tests pass(ed)", "verified", "all green", "확인했…") and the trace has **no verify-classified call** (`src/agent/verify-signal.ts:53-96`) or the **last one failed** (failure matchers `:152-188`), flag `{claim, trace: "none" | "last-verify-failed"}` in claimAudit.

## Acceptance criteria
- [ ] claim+no-verify → flagged; claim+passing-verify → clean; no claim → no-op.
- [ ] Negation/quoting must NOT fire — fixtures in BOTH languages, Korean conjugation/negation explicitly: "확인했지만 실패", "확인 못 했", "테스트는 통과 못함" (R4-L5).
- [ ] FP-zero bar (staleness-gate precedent for default-ON).
