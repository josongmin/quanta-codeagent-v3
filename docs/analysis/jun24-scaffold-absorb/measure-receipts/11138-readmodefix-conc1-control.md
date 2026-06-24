# 11138 local control after read-mode verifier fix (`concurrency=1`)

Date: 2026-06-24

Command:

```sh
QUANTA_PREFS_HOME=/tmp/quanta-auth \
QUANTA_BENCH_HOME=/tmp/quanta-bench \
QUANTA_SWEBENCH_REPO_CACHE=/tmp/quanta-swebench-repo-cache \
QUANTA_BENCH_PRESET=agentless-v4-proof-clean \
QUANTA_BENCH_VERIFY_SELECT_CONCURRENCY=1 \
QUANTA_SWEBENCH_PYTHON=1 \
  bun run src/apps/bench/index.ts \
  --swebench /tmp/frozen3.jsonl \
  --instance django__django-11138 \
  --predictions /tmp/11138-readmodefix-conc1-predictions.jsonl \
  --report /tmp/11138-readmodefix-conc1-report.json
```

Authoritative artifacts:

- observe:
  `/tmp/quanta-bench/runs/run-1782308528653/observe/run-1782308528653/django__django-11138.0.jsonl`
- report:
  `/tmp/11138-readmodefix-conc1-report.json`
- predictions:
  `/tmp/11138-readmodefix-conc1-predictions.jsonl`
- closure diagnostics:
  `/tmp/11138-readmodefix-conc1-report.closure-diagnostics.json`

Verified facts:

1. The previous local Python sandbox/runtime blocker did not recur.
   - bash verifier calls: `write=12`, `read=0`
   - read-mode/sandbox error terms: `0` for `read-mode incompatible`, `guard page`,
     `Operation not permitted`, and `failed to allocate`
2. The prompt/tool fix steered reproducer/test execution into write mode.
   - observe seq `158`: `uv run ... python -s reproduce_issue.py`, `mode:"write"`
   - observe seq `171`: `uv run ... python tests/runtests.py ...`, `mode:"write"`
   - repeated later candidate sessions also used `mode:"write"` only.
3. The run produced an empty prediction, but not because of capture loss.
   - predictions file contains `model_patch:""`
   - report `patchBytes: 0`
   - `selectionTelemetry.candidates[*].captureClass` includes `source-captured`
     for real generated candidates.
4. The immediate selector result is no submittable candidate.
   - `attempted: 5`
   - `successfulGenerations: 5`
   - `generationFailures: 0`
   - `admissibleCount: 0`
   - `winnerId: null`
   - `noWinnerReason: "proof_required_missing"`
   - `repairFeedbackStopReason: "empty_patch"`
5. Official harness grading degraded after the empty prediction path.
   - report failure: `grader_invalid`
   - signal: `empty_patch`
   - error head: gold patch verifier failed under selected official harness with
     `ConnectionError` / `FileNotFound` tail.

Implication:

- The local read-mode Python blocker is structurally cleared for this control
  path.
- This `concurrency=1` receipt does not prove fork capture desync. It instead
  shows source capture worked for generated candidates and selection rejected
  them under proof-required/family-coverage constraints.
- Next fork-desync work must use a `concurrency>1` arm and compare
  `source-captured` vs `lost-edits`/`capture_lost_edits` directly.
