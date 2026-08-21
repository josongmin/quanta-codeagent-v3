# TB21-07 — canary, k=1, and k=5 receipt closure

**Priority:** P0
**Size:** L
**Depends on:** BFND-01..03; TB21-00 through TB21-06, including TB21-00A
**Parallelizable:** no
**Live benchmark cost:** high; this is the only full-run ticket

## Goal

Close the cutover with staged current-SHA execution evidence. A full run is not a
debugging tool; every cheaper rail must already be green.

## Entry conditions

- Working tree is clean at the intended committed SHA.
- `main` and upstream state are recorded.
- Harbor lock, dataset ref, agent version, model, effort, profile, sandbox, and
  budgets are fixed in the run manifest.
- Doctor is green.
- Suite registry, unified CLI, adapter, terminal, scorer, canonical report writer,
  dashboard projectors, typecheck, lint, and diff-check rails are
  green.
- Shared foundation owner audit is green with no PMX/SWE regression or duplicate
  suite/report/projector owner.
- No TB2.0 report is discoverable by the active dashboard.
- Community leaderboard submission status has been checked live; submission is
  not assumed to be open.

## Stage 1 — import and oracle

Run zero-LLM/import checks, then one canonical task with the official oracle or
equivalent dataset-provided validation path.

Acceptance:

- dataset and task version match the pinned manifest;
- sandbox provisions and verifier completes;
- reward, timing, result, and trajectory artifacts are locatable;
- no Quanta model-quality claim is made from the oracle run.

## Stage 2 — three-task Quanta canary (`k=1`)

Run the revision-bound canary manifest with the final `quanta-full` configuration.

Acceptance:

- three distinct trial IDs and task IDs;
- agent version/model/effort/profile match the manifest;
- brain/tool bridge works end to end;
- each trial has reward or a typed incomplete diagnostic;
- successful trial has parseable ATIF path;
- report emission is bijective with raw trials;
- dashboard renders trial rates, provenance, cost, and errors correctly;
- no secret sentinel in logs/report/trajectory.

Any schema, import, auth, or dashboard failure returns to the owning ticket. Do not
patch forward by rerunning a paid full slice.

## Stage 3 — full 89-task `k=1`

Purpose: establish environment coverage and a cost/model baseline before 5x spend.

Acceptance:

- canonical expected task set exactly matches the report;
- 89 distinct task IDs and 89 distinct trial IDs, unless the pinned dataset count
  changed and the manifest was deliberately refreshed;
- no unknown task versions;
- missing reward/malformed result counts are zero before promotion;
- all outcome classes are explained;
- dashboard and scorer totals match the raw Harbor job;
- actual token/cost/duration budget is reviewed before `k=5`;
- the run is explicitly labeled `k=1`, not leaderboard-submittable.

If the full `k=1` run has unexplained infra or receipt loss, stop. Do not start
`k=5` and hope variance hides it.

## Stage 4 — official-shaped full `k=5`

Use the upstream-required standard settings:

- full pinned dataset;
- at least five trials per task;
- no timeout multiplier override;
- no agent/verifier timeout override;
- no resource override;
- one exact agent/model/reasoning-effort identity;
- public upload only if explicitly authorized and currently allowed.

Acceptance:

- 89 tasks x 5 trials = 445 preserved trial receipts for the current pinned set;
- every errored/disqualified trial remains in the metric with reward zero;
- rewarded trials have trajectory paths;
- accuracy, SE, pass@2..5, cost, token, duration, and error breakdown are emitted;
- local scorer parity is proven against the pinned upstream calculation path;
- dashboard displays this run independently from control/canary/k=1 runs;
- exact clean Quanta SHA and all source refs are in the final receipt.

## Final evidence bundle

Produce one immutable evidence directory or indexed document containing:

- run manifest and doctor receipt;
- git SHA/upstream/clean-state receipt;
- Harbor and dataset locks/refs;
- raw Harbor job IDs and paths;
- normalized lossless report;
- scorer output and upstream-parity proof;
- dashboard screenshot or render proof;
- test/typecheck/lint receipts;
- cost/token/duration totals;
- error and disqualification breakdown;
- known limitations, including leaderboard submission closure if still applicable.

Do not commit credentials, raw secret-bearing env, or large downloaded task images.

## RED rails

- A dirty or different SHA than the stored manifest blocks promotable execution.
- A dataset/upstream/Harbor ref mismatch invalidates resume and requires restart
  from the cheapest affected stage.
- A canary raw trial without exactly one canonical report receipt fails before
  any full run.
- Any unexplained missing/duplicate task or trial blocks promotion and `k=5`.
- A scorer/dashboard total that differs from the raw Harbor job fails closure.
- Secret sentinel appearance in logs, reports, doctor output, or ATIF fails the run.
- Upload/public flags without explicit current authorization fail closed.

## Proof rails

```sh
bun run src/apps/bench/cli.ts terminal doctor
python3 -m pytest -q adapters/terminal-bench/tests
bun test src/apps/terminal/*.test.ts
bun test \
  src/apps/bench/benchmark-suite.test.ts \
  src/apps/bench/commands/terminal.test.ts \
  src/apps/bench/terminal \
  tools/leaderboard-dashboard/projectors/terminal-bench.test.ts \
  tools/leaderboard-dashboard/server.test.ts
bun test tools/leaderboard-dashboard/projectors/swe-bench.test.ts
bun run typecheck
bun run lint
git diff --check

# Staged through the implemented wrapper; exact model/sandbox/effort are explicit.
bun run src/apps/bench/cli.ts terminal canary --profile quanta-full
bun run src/apps/bench/cli.ts terminal run --profile quanta-full --k 1 --full
bun run src/apps/bench/cli.ts terminal run --profile quanta-full --k 5 --full
```

The wrapper must print/store the resolved manifest before launching and refuse
manifest/source drift between resume attempts.

## Definition of done

- Oracle and three-task canary are green on the final command/report/dashboard path.
- Full `k=1` has complete current-dataset coverage with no unexplained receipt loss.
- Full `k=5` preserves every required trial and matches the pinned upstream scorer.
- The final dashboard render and evidence bundle name the same clean Quanta SHA,
  suite/version/dataset ref, Harbor version, agent version, model, effort, and profile.
- Source integration, paid execution, dashboard proof, and external release status
  are reported separately; a closed source ticket is not presented as a completed run.

## Completion verdict

Report the layers separately:

- **source repair** — code/docs/scripts landed;
- **framework integration** — suite registry, unified CLI, canonical report sink,
  and dashboard projector ownership proven with no parallel framework;
- **main integration** — exact commit and dirty state;
- **box execution** — doctor/oracle/canary receipts;
- **full k=1** — coverage and infra closure;
- **full k=5** — official-shaped metric receipt;
- **dashboard** — current-version render and parity;
- **external release** — upload/submission status, if authorized.

Do not call the campaign complete when only source/tests are green or only a
canary ran.

## Stop rule

Stop immediately on source SHA drift, dataset-ref drift, manifest drift, missing
trial receipts, secret leakage, or official-score parity failure. Resync/re-run
from the cheapest invalidated stage; never merge partial runs into one headline.
