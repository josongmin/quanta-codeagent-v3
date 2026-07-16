# DOF-22 - behavioral default A/B

**Priority:** P1  
**Depends on:** DOF-00, DOF-21

Candidates include prompt directives, delegation suppression, closeout critic, cap enforcer, adaptive thinking, edit-repair, refusal fallback, prompt suggestion, and any knob that changes control flow, token/cost use, or answer quality.

Run paired ON/OFF on identical corpus, model, concurrency, retry policy, and judge order. Use the admitted `--concurrency` or `QUANTA_BENCH_CONCURRENCY` front door; bare `CONCURRENCY` is not consumed. Keep predictions/reports in independent paths and reject `testCmd: "true"` or certification-pending recordings as promotion evidence.

Record quality/resolution delta, token and latency delta, failure distribution, confidence interval, non-inferiority threshold, and rollback threshold before execution. Promote only with non-regression guardrails and a rollback knob; otherwise retain opt-in. Do not delete a unique feature merely because the first A/B is neutral.
