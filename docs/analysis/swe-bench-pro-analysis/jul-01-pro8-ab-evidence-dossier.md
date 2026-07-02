# Pro-8 A/B — Evidence Dossier (2026-07-01)

Self-contained evidence for the structural/SOTA++ review of the first measure-first
Pro-8 A/B run. Every claim is sourced (artifact path · exact value · code file:line ·
commit · log line). A second reviewer can re-derive every number from the commands in §8.

> Scope caveat: n=8, single run, gpt-5.5. Directional, not a leaderboard claim.

---

## 1. Run provenance

- **Dataset (pinned 8-case Python-Pro):** `~/.quanta/bench/datasets/pro-python-8.jsonl`
  (6 RCA-named misses: ansible-a26c/395e, openlibrary-4a5d/dbbd, qutebrowser-c580/f631
  + 2 first-pick resolved: ansible-f327e65d, qutebrowser-f91ace96).
- **Model:** gpt-5.5 · **provider:** chatgpt-oauth · n=1.
- **Arms (serial):** `agentless-v6-oracle-hardened` (baseline) → `agentless-v7-oracle-multifile-synthesis` (headline).
- **Infra:** full-remote, on-demand `c7i.4xlarge` (QUANTA_FULL_REMOTE_ONDEMAND=1). arm1 box i-025014c2a52f97d8e@43.203.129.87, arm2 box @16.184.28.206. Both terminated.
- **Supervisor:** `tools/pro8-ab-supervisor.sh` (self-heal, serial, env-preset per arm). Logs: `/tmp/pro8-ab-supervisor.log`, `/tmp/pro8-ab-run.log`.
- **Timings:** launch 22:15 → arm1 done 23:11 (~56m) → arm2 done 23:52 (~41m).

### Relevant commits (this work)
| commit | what |
|---|---|
| `51e05c8ee` | feat: serialize acceptance rerank tier (selection-observability) |
| `bdb197d1d` | fix: correct acceptance-tier attribution + un-gate telemetry |
| `352876527` | feat: add `agentless-v7-oracle-multifile-synthesis` preset |
| `58766837a` | **fix: restore Pro/Live family grader + parse dropped by god-MODULE split** |
| `956d640e3` | (follow-on) make the ssh grade-only path dataset-family-aware |
| `11adab597` | **REGRESSION SOURCE** — refactor: split index.ts god-MODULE into run-main |

---

## 2. Headline results (arm2, real ScaleAI grading)

Source: `~/Library/quanta-codeagent-v3/bench/full-remote/report-i-0dec5a7e4abe6ed36.json`
(copied → `AB-agentless-v7-oracle-multifile-synthesis.json`); supervisor line:
`COMPLETE 8/8 graded resolved=3` (`/tmp/pro8-ab-supervisor.log:10`).

- **resolved 3 / 8** (`totals.resolved=3`, `officialResolvedPct=38`).
- Arm2 `failureBreakdown.byTermination` = `completed_unresolved:3`, `timeout:2`; there is
  **no `grader_invalid` termination** in the arm2 report.
- PASS: qutebrowser-f91ace96, ansible-a26c, openlibrary-4a5d.
- FAIL: qutebrowser-c580 (`completed_unresolved`), qutebrowser-f631
  (`completed_unresolved` + `multi_file_drift`), openlibrary-dbbd
  (`completed_unresolved`), ansible-f327e65d (`timeout` + `multi_file_drift`,
  202 turns, 8007B), ansible-395e (`timeout` + `multi_file_drift`, 220 turns, 38979B).

The FAIL reasons are genuine misses (`completed_unresolved`/`timeout`), **not**
`gold did not resolve` — i.e. grading is REAL (contrast §4).

---

## 3. Closure metrics → structural claims

Source: `~/Library/quanta-codeagent-v3/bench/full-remote/closure-i-0dec5a7e4abe6ed36.json` (`.metrics`).

| metric | value (n) | what it grounds |
|---|---|---|
| `synth_repro_base_red_rate` | **0.25 (8)** | **ORACLE ACTIVATION: only 2/8 got a base-red repro** |
| `repro_red_but_unresolved_rate` | 0.5 (2) | of the 2 red, 1 stayed unresolved |
| `owner_recall@1` | 0.625 (8) | localization: 5/8 first-file hits gold |
| `multi_file_disjoint_rate` | **0 (8)** | **never totally wrong files — always right neighborhood** |
| `gold_coverage_rate` | 0.552 (8) | patches cover ~55% of gold files on average |
| `exact_file_set_match_rate` | 0.125 (8) | only 1/8 hits the exact gold file set |
| `multi_file_full_coverage_rate` | 0.125 (8) | 1/8 touches ALL gold files |
| `multi_file_partial_overlap_rate` | **0.875 (8)** | **7/8 touch SOME but not all gold files** |
| `acceptance_tier_*_rate` (all 4) | **na (n=0)** | **NO ATTRIBUTED ACCEPTANCE TIER was retained** |

**Signature (the core read):** disjoint=0 + owner 0.625 + coverage 0.55 + exact 0.125
⇒ the agent lands in the right neighborhood, hits the lead file, covers ~half the gold
files, but almost never completes the full set. This is a **co-change / multi-file
COMPLETION gap**, not a localization gap. Matches Pro's median-4-file design and the
prior RCA thesis (`PYTHON-FIRST-STRUCTURAL-RCA.md`).

---

## 4. What the current artifacts prove vs. what they only suggest

**FACTS**

1. **Canonical base-red activation is low.** `synth_repro_base_red_rate=0.25` and the
   arm2 report records `reproTest.installed:true` on only 2/8 instances
   (ansible-a26c, ansible-395e). The other 6/8 report `installed:false`, mostly with
   `reason:"execution_failed"`.
2. **Acceptance is structurally gated.** The acceptance selector is built only when
   `enabled===true && reproSources.length>0`
   (`src/runner/batch/eval/acceptance-selector.ts:67-75`) and is only used on the
   breadth path (`src/runner/batch/eval/repair/index.ts:162-174`,
   `src/runner/batch/eval/driver.ts:3847-3852`).
3. **The v7 arm really had breadth+acceptance ON.** The retained `observe` bundle's
   per-instance `knobs_applied` events show `acceptance:true` and
   `repair-breadth:3` for this preset.
4. **The report preserves zero per-instance acceptance tiers.** The serializer
   supports `acceptanceTier` (`src/runner/batch/report.ts:137-141`), but the arm2
   report records `acceptanceTier` on 0/8 instances.
5. **`reproTest` and `reproVoteOutcomes` are different telemetry surfaces.** Arm2 has
   `reproVoteOutcomes` on 5/8 instances, including some whose top-level `reproTest`
   still says `installed:false`; do not collapse those into a single "oracle fired"
   number.

**INFERENCE**

- The 0.25 canonical base-red rate is strong evidence that oracle activation remains
  the main upstream bottleneck for multi-file convergence.
- `acceptanceTier` missing on 0/8 is **consistent with** selection starvation, but the
  retained artifacts do **not** prove whether no acceptance selection ran or whether
  a selection ran and its winner later diverged from the final submitted patch.

---

## 5. Grader-routing regression (why arm1 was 8/8 invalid) — RCA with anchors

**Symptom:** arm1 (baseline) graded 8/8 FAIL with `gold patch did not resolve under
selected verifier`; `full-remote done — resolved 0 | unresolved 0` ⇒ grader_invalid
masquerading as 0/8.

**Smoking-gun log lines** (`/tmp/pro8-ab-run.log`):
- arm1 (old box code): `:23  using official Python swebench harness for grading (dataset=princeton-nlp/SWE-bench_Verified (default))`
- arm1 verdict: `:285  ... FAIL ... (gold patch did not resolve under selected verifier ...)`
- arm2 (after fix): `:814  using ScaleAI SWE-bench Pro harness for grading (/home/ubuntu/swebench-pro, python=.../swebench-pro-venv/bin/python)`

**Code chain:**
- FAIL string: `src/runner/batch/eval/gold-sanity.ts:46-51` (gold-sanity runs gold through `verify()`).
- `verify()` reads the one injected `deps.pythonSwebench` seam
  (`src/runner/batch/eval/verdict.ts:49-52,81-83`). No Pro-specialized branch lives here.
- The Pro grader (`gradeEvaluatorForFamily("pro", …)` → Scale `swe_bench_pro_eval.py`)
  is designed to inject INTO that same `pythonSwebench` seam — `src/apps/bench/dataset-family.ts:46-66`.
- **Regression:** commit `11adab597` (split index.ts → run-main) dropped the family
  wiring from `buildPythonSwebench`, so Pro fell through to the Verified harness; Pro
  instance_ids aren't in `princeton-nlp/SWE-bench_Verified` ⇒ gold can't resolve ⇒ all invalid.
  (Verify: `git show 11adab597 -- src/apps/bench/index.ts` shows `-` lines removing
  `gradeEvaluatorForFamily`, `resolveDatasetFamily`, `buildProGradeVerifier`, and the
  `parseTasksForFamily` parse.)
- **Fix (`58766837a`):** restored in `src/apps/bench/run-main.ts` —
  `datasetFamily()` (`370`), `parseTasksForFamily(...)` in readSwebenchTasks (`376`),
  `buildProGradeVerifier()` (`718`), and
  `if (datasetFamily()==="pro") return buildProGradeVerifier()` (`748`).
- **Live-proof:** arm2 logged
  the ScaleAI harness (`:814`) → real grades (§2/§3), grader_invalid 0.

## 6. What remains unproven about `acceptance_tier n=0`

- `attributeAcceptanceTier` emits a tier only when the last selection's
  `winningPatch === submittedPatch`
  (`src/runner/batch/eval/acceptance-select.ts:125-129`,
  `src/runner/batch/eval/driver.ts:4034-4051`).
- The retained arm2 artifacts include:
  - preset knobs proving `acceptance=1` and `repair-breadth=3`;
  - zero serialized `acceptanceTier` fields in the final report;
  - no explicit selection-winner / rerank-tier event in the report, runlog, or
    retained `observe` JSONL.

Therefore the current evidence cannot distinguish:
1. **No acceptance selection ever ran** on the winning path.
2. **Acceptance did run**, but a later non-selected/fallback patch became the final
   submitted diff, so attribution was intentionally dropped.

Treat "selection inert" as a plausible read, **not** as a proved fact.

---

## 7. SOTA++ verdict + next rails (aligned to current repo direction)

### A. What this run can and cannot justify

- **This run is usable as a v7 structural bottleneck readout, not as a promotable A/B delta.**
  arm1 is not a valid control because the Pro grader routing regressed to the Verified
  harness (§5), so this dossier must NOT claim `v7 > v6` from the resolved count.
- What the run **does** justify is narrower and still valuable:
  - Python-Pro remains the right first lane (`README.md`, `PYTHON-FIRST-STRUCTURAL-RCA.md`).
  - current-head v7 still bottlenecks on **thin canonical oracle activation** plus
    **under-completed multi-file synthesis**.
  - attributed acceptance-tier telemetry is still insufficient to promote the
    acceptance path as a proven winner.

### B. SOTA++ direction for this repo

For this codebase, SOTA++ here is **not** "turn on more scaffolding". The current
direction is:

1. **Trustworthy Python-Pro oracle first.**
   The next headline rail is not broader language coverage and not a larger planner
   stack. It is raising canonical repro activation on Python-Pro.
2. **Then prove the multi-file winning path.**
   Only after the oracle is live do breadth / location-fanout / multisite levers have
   a fair chance to show real completion gains.
3. **Then let selection prove itself with observable tiers.**
   If acceptance cannot show a non-empty attributed tier distribution, it is not yet a
   promoted SOTA++ lever even if the code path exists.

### C. Priority order (repo-aligned)

1. **P0 — backend parity / canonical oracle activation.**
   This is the immediate SOTA++ move. The repo's own polyglot repro RFC already points
   to the remaining Python-Pro gap: host repro env mismatch and missing in-image parity
   (`docs/plans/jun-29-repro-adapter-polyglot/README.md`). Practically:
   - isolate the backend-parity arm (`image-exec` + `paired-control`) rather than
     burying it inside the synthesis preset;
   - raise `synth_repro_base_red_rate` above 0.25 before reading too much into breadth
     or acceptance.
2. **P1 — oracle-driven multi-file convergence on Python-Pro.**
   Once canonical repro sources are live, attack the 0.875 partial-overlap rate:
   breadth / location-fanout / multisite should be judged by whether they move
   `multi_file_full_coverage_rate` up and `multi_file_partial_overlap_rate` down.
3. **P2 — selection observability before selection promotion.**
   The jun-30 synthesis RFC is explicit: if acceptance collapses to tier-3
   `all_patches`, the real next work is the regression dual-guard feed, not "more
   acceptance". In this run we do not even have attributed tier evidence, so acceptance
   stays measurement-only.
4. **P3 — cost/convergence discipline.**
   Two timeouts at 202/220 turns mean the system still lacks a strong "done" signal.
   Keep effort-ladder / turn-cap scrutiny attached to any breadth-heavy rerun; cost per
   resolved matters as much as raw resolved.

### D. Explicit non-goals from this dossier

- **Do not** promote `agentless-v7-oracle-multifile-synthesis` from this run alone.
- **Do not** pivot to Go/JS/TS before Python-Pro oracle parity is proven.
- **Do not** read "more knobs wired" as SOTA++ progress when the upstream oracle is
  still mostly dark.

### E. Observability requirements for the next rerun

- keep the fail-loud Pro grader invariant (`family=pro` with missing Scale harness env
  must abort, never fake-grade);
- retain `acceptanceTier`, but also emit routing reason and winning-patch vs
  submitted-patch lineage so `n=0` is no longer ambiguous;
- keep `reproTest` and `reproVoteOutcomes` split in the readout, because they are not
  the same authority surface.

---

## 8. Re-derivation commands (for an independent reviewer)

```bash
cd /Users/songmin/quanta-codeagent-v3
# results + closure metrics
node -e 'const j=require(process.env.HOME+"/Library/quanta-codeagent-v3/bench/full-remote/report-i-0dec5a7e4abe6ed36.json");console.log(JSON.stringify({totals:j.totals,failureBreakdown:j.failureBreakdown},null,2));console.log(JSON.stringify(j.perInstance.map(p=>({id:p.id,passed:p.passed,failure:p.failure,turns:p.turns,patchBytes:p.patchBytes,acceptanceTier:p.acceptanceTier,reproTest:p.reproTest,reproVoteOutcomes:p.reproVoteOutcomes?.tally})),null,2))'
node -e 'console.log(require(process.env.HOME+"/Library/quanta-codeagent-v3/bench/full-remote/closure-i-0dec5a7e4abe6ed36.json").metrics)'
# grader-routing smoking gun
grep -n "using ScaleAI SWE-bench Pro harness\|official Python swebench harness\|gold patch did not resolve" /tmp/pro8-ab-run.log
# regression diff
git show 11adab597 -- src/apps/bench/index.ts | grep -E "^[-+].*(gradeEvaluatorForFamily|buildProGradeVerifier|parseTasksForFamily)"
# fix
git show 58766837a -- src/apps/bench/run-main.ts
# code anchors
sed -n '46,52p' src/runner/batch/eval/gold-sanity.ts
sed -n '67,75p' src/runner/batch/eval/acceptance-selector.ts
sed -n '125,129p' src/runner/batch/eval/acceptance-select.ts
sed -n '46,66p' src/apps/bench/dataset-family.ts
sed -n '718,749p' src/apps/bench/run-main.ts
# optional: inspect the retained observe bundle for preset knobs / vote artifacts
python3 - <<'PY'
import base64, pathlib
src = pathlib.Path.home()/"Library/quanta-codeagent-v3/bench/full-remote/observe-i-0dec5a7e4abe6ed36.tar.b64"
dst = pathlib.Path("/private/tmp/observe-i-0dec5a7e4abe6ed36.tar")
dst.write_bytes(base64.b64decode(src.read_bytes()))
print(dst)
PY
mkdir -p /private/tmp/observe-i-0dec5a7e4abe6ed36
tar -xf /private/tmp/observe-i-0dec5a7e4abe6ed36.tar -C /private/tmp/observe-i-0dec5a7e4abe6ed36
rg -n '"acceptance":\{"value":true\}|"repair-breadth":\{"value":3' /private/tmp/observe-i-0dec5a7e4abe6ed36/run-1782828846881/*.jsonl
```
