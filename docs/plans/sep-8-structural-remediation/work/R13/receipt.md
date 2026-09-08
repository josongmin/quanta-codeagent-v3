# R13 receipt — G-F5

package: R13 (W2-B)
finding IDs: G-F5 (P1)
source HEAD: `16cabfde464e354a4c3e98f3b7ffbc6e57f1086f`
owner: W2-B worker R13
status: red-confirmed → implemented (not verified)
worktree: `/Users/songmin/quanta-codeagent-v3-w2-r13`
branch: `sep8-w2-r13`

## Owner files changed

- `src/apps/bench/profiles/family-box-readiness.ts` (new) — `familyRequiresSwebenchShim` + `boxProfileReadinessProbe` derived from existing `boxGrade`
- `src/apps/bench/remote/box-session/bootstrap-phases.ts` (new) — phase executor: common → optional shim → ALWAYS `setupBoxForFamily` → profile readiness
- `src/apps/bench/remote/box-session/profile-readiness.ts` (new) — `isBoxProfileReady` / `assertBoxProfileReady` consume the same probe
- `src/apps/bench/remote/box-session/ec2-lifecycle.ts` — 934 → **799 lines** (below 900; out of 900–999 cohort). `findIdleBox` / `inspectBox` / `attachBox` use profile readiness. Warm reuse still calls `ensureWarmBoxFamilyBootstrap`
- `src/apps/bench/profiles/registry.test.ts` — G-F5.1 probe derivation assertions

Not edited: `src/apps/bench/remote/full.ts`, `src/apps/bench/remote/pool/launch-window.ts` (idle selection is count-only; family readiness lives in `findIdleBox`), barrel `box-session.ts`.

## Tests

New:

- `tests/unit/sep8-remediation/r13/g-f5-profile-readiness.test.ts` (5)
- `tests/unit/sep8-remediation/r13/g-f5-bootstrap-phases.test.ts` (6)
- `tests/unit/sep8-remediation/r13/g-f5-mutation-ratchet.test.ts` (4)
- `tests/integration/sep8-remediation/r13/g-f5-attach-warm-reuse.test.ts` (5)

Existing colocated: `src/apps/bench/profiles/registry.test.ts` (+2), `src/apps/bench/remote/box-session/swebench-pip-spec.test.ts`, `src/apps/bench/remote/box-session/ami-resolution.test.ts`, `src/apps/bench/profiles/family-four-stop-rule.test.ts`.

## Removed path

- `boxGrade !== undefined` whole-bootstrap `return` before `setupBoxForFamily` (shim skip was also skipping family setup)
- Universal `test -x ~/swebench-python` probe on every family in `isBootstrapped`

`boxGrade` still means skip SHIM only (`wantedSwebenchPipSpec` / `familyRequiresSwebenchShim`).

## Commands run

```
bun test tests/unit/sep8-remediation/r13 tests/integration/sep8-remediation/r13
# GREEN: 20 pass / 0 fail

bun test tests/unit/sep8-remediation/r13 tests/integration/sep8-remediation/r13 \
  src/apps/bench/profiles/registry.test.ts \
  src/apps/bench/remote/box-session/swebench-pip-spec.test.ts \
  src/apps/bench/remote/box-session/ami-resolution.test.ts
# GREEN: 69 pass / 0 fail

bun test tests/unit/god-code-ratchet.test.ts
# GREEN: 9 pass (cohort did not grow; ec2-lifecycle left 900–999)

bunx @biomejs/biome check <owner + test files>
# PASS
```

Environment: isolated worktree. Fake SSH only. **No RunInstances / no AWS/EC2.**

## RED cause

At HEAD, ProMax `boxGrade` made `bootstrapBox` return after common install and before `setupBoxForFamily`. `isBootstrapped` still required `~/swebench-python` for every family, so a ProMax box never looked warm; `attachBox` re-entered `bootstrapBox` (early-return again) and skipped `ensureWarmBoxFamilyBootstrap`.

## GREEN result

- ProMax fresh bootstrap: family setup command exactly once; `cat > ~/swebench-python` absent.
- ProMax warm reuse: succeeds without `~/swebench-python`; `ensureWarmBoxFamilyBootstrap` still runs.
- verified/live: shim still written (control).
- bun-install / family-setup / final-probe failure ⇒ throw, not ready.
- `findIdleBox` selects a ProMax box that lacks the swebench shim.

## Mutation result

- Clone inserting `if (profile.boxGrade !== undefined) return` before family setup fails the ratchet.
- Clone restoring the universal `bun && swebench-python && src` probe in lifecycle/readiness fails.
- Anti-vacuum ≥4: `familyRequiresSwebenchShim(`, `setupBoxForFamily(`, `boxProfileReadinessProbe(` / `isBoxProfileReady(`, gated probe owner.

## Remaining proof gap

**G-F5.4 EC2 proof is OPEN — local-only gap.** Fake SSH is contract proof only. Actual EC2 provision/reuse (RunInstances, warm AMI reuse, single-box guard under live boxes) was not started and is not claimed. Requires a separate approved paid runtime.

Follow-up on merged source: `box up` / `pool` now call `withResolvedFamilyBootstrap` (owner `family-bootstrap-resolve.ts`). Fresh `setupBoxForFamily` refuses a declaring family with no payload.

Integrator must re-run on merged source (`verified` is not claimed here). `full.ts` / `launch-window.ts` were not changed in the original R13 worker; they consume `findIdleBox` / `attachBox` as before.
