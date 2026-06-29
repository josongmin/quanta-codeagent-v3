# Handoff — jun-29 agent-2 (pool-diversity measurement + box-death RCA)

> Split-brain handoff. This thread chased ONE measurement and got stuck on a box
> infra bug. Code is landed; the measurement is blocked on a fixable detector bug.

## The ONE goal (don't lose this)

Measure: **does a diverse pool of N candidate patches contain a correct one** for
our selection-class failures? If yes → building the selection pipeline
(dedup / regression-set / pool-discrimination / sample-budget) is justified. If
the pool is all the same mistake → selection is useless, the lever is upstream
(localization recall = semantica, or synthesis capability).

Target instances: `sphinx-doc__sphinx-8056` + `sphinx-doc__sphinx-9461`.
- 8056: localizer surfaced the gold file `sphinx/ext/napoleon/docstring.py` as **#1
  candidate**, model edited the WRONG file (`sphinx/util/docfields.py`). Oracle 1/5.
  → "does best-of-8 ever edit the right file?"
- 9461: localizer surfaced ALL 3 gold sites; model edited only 1/3 (under-coverage).
  Oracle 4/5. → "does best-of-8 ever cover all 3 sites?"

Pass bar: 8056 has ≥1 candidate touching `napoleon/docstring.py` ⇒ pool hypothesis PASS.

## Established this session (measured, durable)

- **env-fix works**: the rA-FAIL sphinx cases' repro went exec_failed → 5/5 reproduced.
  Failures are now synthesis/selection-bound, NOT env-bound. (env-era pins landed
  earlier; HEAD before this session = `8dce6cbde`.)
- **Failure split (n=4 sphinx, report + local oracle measure)**: localization-whiff
  (9229: localizer surfaced nothing → semantica's job) vs selection (8056/7462: right
  file surfaced, wrong edit). Local oracle-discrimination (env-faithful, sanity-gated):
  7462=0/5 (broken oracle, fails even on gold), 8056=1/5, 9461=4/5.
  - Local oracle-measure rig: `/tmp/oracle-disc/` (run.py + faithful.sh). macOS gotchas:
    `bash 3.2 has no mapfile`, need env guards `PYTHONNOUSERSITE=1
    PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 PYTEST_ADDOPTS=` + `--with roman` (sphinx dep).
- **2026 SOTA gap audit (retrieval excluded — that's semantica)**: our verification/
  robustness/repro/harness are at/above SOTA. Genuine gaps cluster in the SELECTION
  pipeline: ① candidate semantic dedup (TRAE), ② pool-discrimination (RED/GREEN via
  pool-as-fixed-proxy), ③ regression passing-set capture (Agentless; our dual-guard
  half-built), ④ patch sample budget (we cap 8, SOTA 12–16). Sources: TRAE
  2507.23370, CodeMonkeys 2501.14723, Agentless 2407.01489, test-gen 2508.06365.

## LANDED this session (committed to main)

**`4805c87a0` — observe-only candidate-pool ledger for repair-breadth.**
- Problem: breadth path adopts only the winner, drops the other B-1 candidates →
  "was there a winning candidate the selector missed?" un-answerable post-hoc.
- `src/runner/batch/eval/repair/candidate-ledger.ts` — PURE leaf: `touchedFilesFromDiff`
  + `buildCandidatePoolRows`. Unit test `candidate-ledger.test.ts` (7 green, leaf-crate).
- `candidate-ledger-sink.ts` — impure: writes `repair-candidates/<id>/candidates.jsonl`
  (rows) + `cand-r<round>-i<idx>.patch` under the run artifact root (rides observe tarball).
- `recordCandidates?` port on `RepairBreadthDeps` (repair-breadth.ts), called fail-open
  BEFORE selection in `makeRepairBreadthRunCandidates`.
- Wired in BOTH drivers when `deps.reproArtifactRootPath` exists:
  `runner/batch/eval/driver.ts:~3604`, `apps/bench/eval/driver.ts:~728`.
- Decision impact ZERO (absent root ⇒ no sink ⇒ byte-identical).

## The launch config (CORRECTED — earlier launches were inert)

```
CNS=breadthN CQUEUE=/tmp/breadth-ids.txt CMODEL=gpt-5.5 CMAXBOX=1 CBATCH=2 \
QUANTA_BENCH_REPAIR_BREADTH=8 \
QUANTA_BENCH_CLOSURE_REPAIR=1 \   # ← REQUIRED: breadth only fans out in repair phase
QUANTA_BENCH_ACCEPTANCE=1 \       # repro-only selector (label readout "repro-only")
QUANTA_FULL_REMOTE_ONDEMAND=1 \
nohup bash tools/campaign-generic.sh > /tmp/camp-breadthN-launch.log 2>&1 &
```
🔴 **INERT-KNOB TRAP (the user caught this):** `REPAIR_BREADTH=8` ALONE does nothing.
The repair phase needs `effectiveRepair` = `deps.repair ?? (posture.repairRounds set)`
(`driver.ts:5178`, `repair-phase-policy.ts:9`). Without a repair-rounds trigger the
fan-out never runs (1 candidate). `CLOSURE_REPAIR=1` sets `posture.repairRounds=1` and
is `QUANTA_BENCH_*`-prefixed so it forwards to the box (`QUANTA_REPAIR_ROUNDS` does NOT
forward). The ledger now also empirically proves engagement (8 rows = engaged).

- Box rsyncs WORKING-TREE `src/` (`box-session/src-sync-guard.ts:buildSrcRsyncArgs`),
  so uncommitted changes ride to the box — no commit needed for the box to get code.
- `ACCEPTANCE=1` is currently **repro-only** (regressionSet NOT passed,
  `driver.ts:3609` + `acceptance-selector.ts:1`). Do NOT claim regression-set
  justification from this run.

## 🔴 THE BLOCKER — box dies 6/6, ROOT CAUSE = detector bug (fixable, NOT infra)

Fresh on-demand boxes died 16–28 min in, every time (breadth/breadth3..6).
**Refuted with evidence:** TTL (180min, box died at ~20min), OOM (availMb ~30GB
stable until death), spot (on-demand RunInstances, not spot), budget contention
(0/16 free), my-AWS-diagnostic-throttle (stayed off AWS in breadth6, still died).

**Confirmed mechanism (CloudTrail + code):**
- CloudTrail: the box was **running → shutting-down** at OUR TerminateInstances. So the
  box was ALIVE when we killed it. Only OUR terminates exist (no external/spot).
- We only terminate via `BOX_DIED_DURING_RUN`, which throws ONLY when
  `isInstanceStillLive` returns false (`detached-poll.ts:164`).
- `isInstanceStillLive` does `aws ec2 describe-instances ... State.Name`; **treats
  empty/"None" stdout as DEAD** (`detached-poll.ts:~80`):
  ```
  if (state === "" || state === "None") return false   // ← false-negative on throttle
  ```
  Its own comment flags this: "A throttle that exits 0 with empty stdout is rare."
- With concurrent runs (a django/sympy campaign was ALSO polling describe), EC2
  `describe-instances` gets rate-limited → empty stdout exit-0 → `isInstanceStillLive`
  false-reports DEAD → BOX_DIED → we terminate a HEALTHY, actively-solving box.

Box console-output (captured via watcher death-hook, `/tmp/breadth5-console.txt`):
clean cloud-init finish, NO OOM/panic, `shutdown -h +180` scheduled for +180min
(not the cause). Boot was healthy.

## ⏭ NEXT ACTION (pending user go — recommended)

**Fix `isInstanceStillLive` (detached-poll.ts):** treat empty/None/ambiguous describe
as **INCONCLUSIVE (return true = keep polling)**, only declare dead on an EXPLICIT
`terminated`/`stopping`/`stopped`/`shutting-down` state. Add a small retry/backoff on
empty stdout. This is a safe leaf change; the wall-clock ceiling stays the backstop.
- Hellgate: unit test the predicate — empty stdout ⇒ alive (not dead); explicit
  "terminated" ⇒ dead; non-zero exit ⇒ alive (already handled).
- Then re-launch breadth with the corrected config above. Box should survive →
  `repair-candidates/<id>/candidates.jsonl` lands in the observe tarball.

**Readout when it finally runs** (decode observe tarball locally, macOS `base64 -D`):
1. ledger has ≥2 rows ⇒ breadth engaged (not inert).
2. 8056: any candidate `touchedFiles` includes `sphinx/ext/napoleon/docstring.py`?
3. 9461: any candidate covers all 3 gold sites (`domains/python.py`,
   `ext/autodoc/__init__.py`, `util/inspect.py`)? Separate "3-files touched" from
   official `resolved` — don't treat file-touch as a win.
4. acceptance-selected winner vs the pool — did the selector pick a good one or miss it?

## After the measurement (the actual roadmap)

- IF pool contains winners → build the selection pipeline: ① candidate dedup,
  ② pool-discrimination filter (drop RED-on-everything oracles like 7462),
  ③ regression passing-set capture (finish the jun-28 acceptance dual-guard — the
  `regressionSet` param at `driver.ts:3609` is plumbed but empty), ④ raise sample
  budget 8→16 cheaply via fork-at-end.
- IF pool is all the same mistake → drop selection, the lever is semantica
  (localization recall) + synthesis. 9229-class.
- semantica (callgraph/embedding/semantic retrieval) is a SEPARATE engine the user
  is building — handles the localization-whiff class (9229). Not in scope here.

## Gotchas / notes

- bench knob truth must be re-checked against LIVE code (memory: knob/preset rot).
  The repair-phase gate + acceptance-repro-only state were both verified this session.
- `git add -u` is BANNED (user in-flight sweep). Stage explicit paths.
- macOS local sphinx env: bash3.2 no-mapfile, need `PYTHONNOUSERSITE=1` +
  `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1` + `--with roman` for faithful repro exec.
- Watchers: use PYTHON not bash (macOS bash watchers kept dying exit-144).
- Evidence/artifacts: oracle-disc `/tmp/oracle-disc/`, box console `/tmp/breadth5-console.txt`,
  reports `~/Library/quanta-codeagent-v3/bench/full-remote/report-i-*.json`.
- A concurrent `pro-5.jsonl` SWE-bench-Pro campaign (user's) cycled boxes during this
  session — its describe polls likely aggravated the throttle. Check it's done before
  re-launching.
