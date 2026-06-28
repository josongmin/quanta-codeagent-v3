# RFC: SWE-bench Multi-Dataset Platform (Verified · Pro · Live) — FINAL (3-round audited)

- **Status:** Proposed (post 3-round adversarial audit, all corrections folded in)
- **Date:** 2026-06-29
- **Scope:** `src/runner/batch/{corpus,eval,core.ts,report.ts,types.ts}`, `src/apps/bench/`
- **Related:** [docs/analysis/semantica-codegraph.md](../../analysis/semantica-codegraph.md) (multi-language nav backend — orthogonal)
- **Audit log:** §A (3 rounds, grounded in primary source — every load-bearing claim verified at file:line)

## 1. Summary

Generalize the bench harness from single-dataset (Verified) to a **multi-dataset
platform** (Verified / Pro / Live). Per-dataset divergence is injected **down** into a
generalized, dataset-agnostic library runner through the **existing DI seams** — not
bolted on as a library registry that imports app verifiers (which the slice fence
forbids; see §A R8). The agent loop, model routing, knobs, Best-of-N, and repo cache
are shared; what changes is which **verifier / prediction-formatter / schema-adapter /
budget** the app layer injects.

Adding a dataset = **one app-slice profile** that injects existing-shape behavior; a new
grading verifier is needed **only** for Pro (non-official harness). Live needs **near-zero
code** (the `--dataset_name` and `--namespace` params it requires already exist).

## 2. Motivation

- Verified is **saturated**; frontier signal is in Pro (harder, multi-language, contamination-resistant) and Live (monthly-refreshed).
- Ingest is JSONL-agnostic, but **grading, predictions format, test-cmd synthesis, env-prep, and repo-URL are Verified/Python-hardcoded in shared code** — Pro breaks all of them. Without explicit seams, each dataset forks the runner.

## 3. Goals / Non-goals

**Goals:** one pipeline; per-dataset behavior injected, not branched; Verified byte-identical when unselected; Live ≈ config-only; Pro = schema adapter + a second verifier; Python-first, multi-language-capable.

**Non-goals (this RFC):** multi-language **repro rail** (the SOTA execution-feedback lever — separate workstream; Pro grading is Docker-authoritative regardless); semantica-codegraph nav integration; dashboard schema beyond a `datasetFamily` tag.

## 4. The three datasets (verified facts)

| | Verified | Live | Pro |
|---|---|---|---|
| HF id | `princeton-nlp/SWE-bench_Verified` | `SWE-bench-Live/SWE-bench-Live` | `ScaleAI/SWE-bench_Pro` |
| size / langs | 500 / Python | ~1,319 (+50/mo) / Python | 731 / **Python·Go·JS·TS** |
| F2P/P2P keys | `FAIL_TO_PASS` (upper) | upper | `fail_to_pass` (**lower**) |
| env setup | `environment_setup_commit` (**git checkout, no host mutation**) | same | `before_repo_set_cmd` (**arbitrary host-mutating shell — NOT a git ref; runs inside Scale's Docker**) |
| grading | `swebench.harness.run_evaluation` | **same harness** + `--dataset_name Live` (+ Live namespace) | **`swe_bench_pro_eval.py`** (custom; `scaleapi/SWE-bench_Pro-os`) |
| docker | `swebench`(arm64)/`none`(x64) | Live registry / local build | `jefzda/sweap-images:<dockerhub_tag>` (prebuilt, untrusted 3rd-party) |
| predictions row | `{instance_id, model_name_or_path, model_patch}` | same | `{instance_id, patch, prefix}` (+ raw **CSV** via `--raw_sample_path`) |
| extra fields | — | — | `dockerhub_tag`, `repo_language`, `selected_test_files_to_run`, `requirements`, `interface`, `issue_categories` |

> **Correction (audit A-F1):** `before_repo_set_cmd` is **not** the analogue of
> `environment_setup_commit`. The latter is pure git (no host mutation). The former is
> host-mutating build/install run **inside Scale's Docker image** at grade time — it is
> **not** run host-side in our pipeline (and must not be: untrusted + expensive). It is
> relevant only to the optional P3 local repro rail.

## 5. Architecture (fence-respecting)

The "profile" is an **app-slice composition** that injects dataset behavior **down** into
a generalized library runner. The library never imports the app.

```
 src/apps/bench/  (APP slice — may import everything; composes + injects)
   profiles/{verified,live,pro}.ts   ← bundles: schema-adapter, verifier, formatter, image, budget
   python-swebench.ts  = officialVerifier  (Verified + Live; namespace/datasetName already wired)
   pro-swebench.ts     = proVerifier  ★new  (Scale harness; MUST reuse exported withGradingLock)
   index.ts            selects profile by dataset_family knob, INJECTS down  ──┐
                                                                                │ inject
 src/runner/batch/  (LIBRARY slice — dataset-agnostic, NO app imports)         ▼
   corpus/dataset.ts   parseRows(normalize raw) · resolveRepoUrl · testCmd opt-out
   core.ts             writeBatchArtifacts(formatPrediction)   ← injected formatter
   eval/verdict.ts     verify(deps.gradeVerifier)              ← injected verifier (was pythonSwebench)
   report.ts           BenchReport + datasetFamily / authority split
   types.ts            Instance.swebench + dockerhubTag?/repoLanguage?  (additive)
```

### 5.1 The load-bearing refactor (was missing in draft)

Today grading is an **injected function** `VerifyDeps.pythonSwebench.evaluate`
([verdict.ts:49-50](../../../src/runner/batch/eval/verdict.ts)) supplied by the app
([index.ts:917 buildPythonSwebench](../../../src/apps/bench/index.ts)). Generalize this
single seam:

```ts
// library: eval/verdict.ts — widen the injected grade seam (default = official)
interface VerifyDeps { gradeVerifier?: { evaluate: GradeFn }  /* was: pythonSwebench */ }
```

App injects `officialVerifier` (Verified/Live) or `proVerifier` (Pro). **No `if pro` in
shared code** — the one switch is app-layer profile selection in `index.ts`. This is the
seam that actually exists; the draft's "runner calls `profile.grade`" inverted the DI.

### 5.2 The real divergence seams (corrected locations)

| concern | draft said | actually lives at | fix |
|---|---|---|---|
| grade routing | "runner→profile.grade" | injected `VerifyDeps.pythonSwebench` ([verdict.ts:49](../../../src/runner/batch/eval/verdict.ts)) | widen to `gradeVerifier` |
| predictions format | `dataset.ts writePredictions` | **`core.ts:158` hardcodes the official 3 keys** | `writeBatchArtifacts(formatPrediction)`, default official |
| lowercase F2P | "parseRows" | `synthesizeTestCmd` reads **`raw.FAIL_TO_PASS`** ([dataset.ts:349](../../../src/runner/batch/corpus/dataset.ts)); `toTask` never touches it | `parseRows` normalizes **`raw`** (upper keys) so downstream is unchanged |
| local test-cmd | optional method | `synthesizeTestCmd` runs unconditionally → returns `"true"` for Pro = fake-green risk | Pro **opts out** (returns null); never the Python default by omission |
| repo URL | (none) | `prepareTaskRepo` hardcodes `github.com` + base-URL-gated cache key ([dataset.ts:198,214](../../../src/runner/batch/corpus/dataset.ts)) | `resolveRepoUrl` seam; make URL-hash the **always** cache key |
| timeout/turns | "shared, unchanged" | global 20min/60-turn tuned on **Verified** django cases ([index.ts:1039-1048](../../../src/apps/bench/index.ts)) | per-dataset `budget?` (default = current globals = byte-identical) |
| namespace/datasetName | "add namespace param" | **already wired** (`HarnessConfig.namespace` [config.ts:20,60](../../../src/apps/bench/harness/config.ts), `datasetName` [python-swebench.ts:93](../../../src/apps/bench/python-swebench.ts)) | Live = config only, **zero code** to grade |

### 5.3 Grading verifiers (two impls)

```
 verified ─┐
 live ─────┴─► officialVerifier (python-swebench.ts)  ── run_evaluation --dataset_name {Verified|Live} --namespace {…}
 pro ───────► proVerifier (pro-swebench.ts ★new)      ── swe_bench_pro_eval.py --dockerhub_username jefzda
                                                          preds=[{instance_id,patch,prefix}] (+ raw CSV)
                                                          ★ MUST route through the SAME withGradingLock as official (R2)
```

> **Live caveat (audit A-F3):** "shared verifier" holds **iff** the installed `swebench`
> package grades Live through the stock report layout. The official verifier carries a
> Verified-specific spec shim (`SPHINX_RA_SHIM`) and assumes the upstream
> `logs/run_evaluation/.../report.json` shape. If Live needs a harness fork, it becomes
> verifier #3. **This is a P1 blocking probe, not an open question.**

### 5.4 Best-of-N × expensive Pro grading (audit A-F6)

Best-of-N selects on a per-attempt `passed` grade. Pro's authoritative grade is a large
`jefzda/sweap-images` pull — N× per instance is prohibitive, and batch-only grading
collapses Best-of-N to single-pass (no per-attempt signal). **Pro strategy (explicit):**
select on a **cheap proxy** (patch-vote / optional local repro), then grade **only the
selected winner** authoritatively. Never N× authoritative Docker pulls.

## 6. File mapping (corrected)

```
src/runner/batch/
  corpus/dataset.ts   parseRows→normalize raw (upper F2P/P2P, carry extras); resolveRepoUrl; testCmd opt-out
  core.ts             writeBatchArtifacts: inject formatPrediction (default official)        ← was omitted
  eval/verdict.ts     VerifyDeps.pythonSwebench → gradeVerifier (default official)           ← load-bearing
  report.ts           BenchReport + datasetFamily?; authority split carries Pro             ← was omitted
  types.ts            Instance.swebench + dockerhubTag?/repoLanguage? (additive)
src/apps/bench/
  profiles/{index,verified,live,pro}.ts   ★new (APP slice — composes + injects)
  python-swebench.ts  officialVerifier (export withGradingLock for reuse)
  pro-swebench.ts     ★new proVerifier (Scale harness; reuses withGradingLock)
  index.ts            select profile by dataset_family knob; inject verifier/formatter/budget
```
> `src/apps/bench/corpus/*` and `apps/bench/types.ts` are re-export **shims** over
> `@/runner/batch/*` — edits land in `src/runner/batch/`, new types follow the shim pattern.

## 6.5 Existing-component migration / 기존 아키텍처 변경

The platform is mostly **generalizing existing shared code**, not greenfield. Below is
what the current Verified-centric architecture must change, classified by blast radius.
**Contract** changes ripple to all construction sites and need a coordinated migration;
**generalize** changes must preserve Verified output (R1 golden-diff); **additive** is safe;
**behavioral** adds a non-default path.

| Existing component | Current state | Change | Class | Ripple / safety |
|---|---|---|---|---|
| `eval/verdict.ts` `VerifyDeps.pythonSwebench` | Verified-named injected grade fn ([verdict.ts:49](../../../src/runner/batch/eval/verdict.ts)) | rename → `gradeVerifier: { evaluate }` (Verifier port) | **contract** | every `VerifyDeps` construction site (`index.ts:528`, driver, tests) migrates; default still official ⇒ Verified unchanged |
| `core.ts` `writeBatchArtifacts` / `Prediction` | official 3-key row hardcoded ([core.ts:158](../../../src/runner/batch/core.ts)); shared by **dataset AND custom-corpus** modes | inject `formatPrediction` (default = official); widen `Prediction` to a union | **contract** | both bench modes call it — custom-corpus path must pass the official default explicitly; golden-diff guards Verified/custom output |
| `corpus/dataset.ts` `parseSwebenchJsonl`/`toTask` | parses official snake_case, stashes `raw` | `parseRows` per-profile; **normalize `raw`** to canonical UPPER F2P/P2P so `synthesizeTestCmd`/`toInstance` are untouched | **generalize** | Verified path = identity normalize ⇒ byte-identical |
| `corpus/dataset.ts` `synthesizeTestCmd` | unconditional, reads `raw.FAIL_TO_PASS`, Python/pytest/django ([dataset.ts:349](../../../src/runner/batch/corpus/dataset.ts)) | per-profile **opt-out** (Pro returns null, never `"true"` fake-green) | **generalize** | Verified keeps current synthesis; Pro skips local repro |
| `corpus/dataset.ts` `prepareTaskRepo` repo URL + mirror cache | hardcoded `github.com`; cache-name base-URL-gated ([dataset.ts:198,214](../../../src/runner/batch/corpus/dataset.ts)) | add `resolveRepoUrl(task)` seam; non-github datasets use the **existing URL-hash** cache branch | **generalize** | Verified stays github + repo-name cache (no re-clone); Pro/custom hosts auto-hash |
| `report.ts` `BenchReport` / `buildReport` | no dataset field; authority split = official-only ([report.ts:187](../../../src/runner/batch/report.ts)) | add `datasetFamily?` + Pro per-instance meta; authority split carries Pro | **additive→contract** | absent for Verified ⇒ byte-identical (R1/R4); leaderboard must partition by `datasetFamily` |
| `types.ts` `SwebenchMeta` | optional-field interface | `+ dockerhubTag? + repoLanguage?` | **additive** | spread-when-present ⇒ byte-identical when absent |
| `apps/bench/index.ts` `runMain` grade wiring | builds one `pythonSwebench` handle + `goldSanity` ([index.ts:528,917](../../../src/apps/bench/index.ts)) | select profile by `dataset_family`; inject verifier/formatter/budget; `goldSanity` per-dataset (Pro path differs) | **contract** | the one legitimate app-layer switch; library stays dataset-agnostic |
| `apps/bench/index.ts` budget | global 20min/60-turn, Verified-tuned ([index.ts:1039](../../../src/apps/bench/index.ts)) | resolve `profile.budget` after selection (default = current globals) | **generalize** | Verified globals unchanged; Pro longer horizon |
| `index.ts` Best-of-N `resolveInstance` | selects on per-attempt authoritative `passed` ([index.ts:421](../../../src/apps/bench/index.ts)) | add proxy-select-then-grade-winner mode for expensive (Pro) verifiers | **behavioral** | Verified keeps per-attempt grade; Pro avoids N× Docker pulls (§5.4) |
| `apps/bench/harness/config.ts` | namespace/datasetName already wired ([config.ts:20](../../../src/apps/bench/harness/config.ts)) | **no change** for Live (config-only); Pro doesn't use `run_evaluation` namespace at all | — | confirms Live is near-zero-code |
| `apps/bench/python-swebench.ts` `withGradingLock` | module-private serial mutex ([python-swebench.ts:366](../../../src/apps/bench/python-swebench.ts)) | **export** it so `proVerifier` reuses the same process-global chain (R2) | **contract** | both verifiers share one lock; concurrent grade stays banned |
| knob system (`config/knob-schema`, `register-bench-knobs`) | bench knobs derive from `ALL_BENCH_SCHEMAS` | add `dataset_family` + Pro/Live knobs as **schemas** (R3) | **additive** | derive-parity ratchet enforces single SSOT |
| SSOT mirror + dashboard (`~/.quanta/bench/results`, leaderboard `REPORT_ROOTS`) | Verified-only; conflates by instance id | partition/tag by `datasetFamily` so cross-dataset runs aren't merged | **behavioral** | prevents apples-to-oranges leaderboard rows |
| smoke (`tests/smoke/swebench`) | Verified regression smoke | add `verified`-profile **byte-identity golden** (R10) + Live/Pro smoke | **additive** | red-on-injection guard, not vacuous |

**Migration order (so contract changes land safely):** (1) export `withGradingLock`; (2)
widen `VerifyDeps.pythonSwebench → gradeVerifier` + `writeBatchArtifacts(formatPrediction)`
with official defaults (pure rename/inject, Verified output unchanged — golden-diff gate);
(3) extract the current path into the `verified` profile; (4) add `live`; (5) add `pro` +
`pro-swebench.ts`. Steps 1–3 are refactors with zero behavior change (the R1 guard proves
it); only 4–5 add datasets.

## 7. Phasing

- **P0 — acquire.** Export Pro JSONL + raw CSV from HF (keep `dockerhub_tag`,`repo_language`,`selected_test_files_to_run`); clone `scaleapi/SWE-bench_Pro-os`, pin deps; Docker + (Modal | `--use_local_docker`) on a **disposable grading box**. Live JSONL too.
- **P1 — seam + Verified/Live.** Widen `gradeVerifier`/`formatPrediction`/`budget` DI; refactor current path into `verified` profile (**byte-identical, golden-diff gated — R1/R10**). Add `live` profile (config-only). **Blocking probe:** does stock `swebench` grade Live (A-F3)? Ship Live as the pipeline smoke.
- **P2 — Pro ingest + verifier.** `pro` profile: normalize lowercase schema, carry Pro metadata, opt out of local test-cmd. `pro-swebench.ts` (Scale format/harness/images) **reusing `withGradingLock` (R2)**; fail-closed refuse-to-fake-grade (R5). Route via injected verifier. **First run = Python subset, measured baseline (≥ N, not n=1 — R6).**
- **P3 — Pro multi-language (separate).** Grading already covers Go/JS/TS via Scale Docker; remaining = agent-side multi-lang **repro rail** (`synthesizeTestCmd`/`reproArgv` → per-language) + patch-capture de-Python-ization (env-strip, `go.sum`/`package-lock` noise) + nav via semantica MCP. Score-critical, optional for baseline.

## 8. 시스템 구현 규칙 / Implementation Rules (enforceable)

Each rule = invariant (file:line) + verification. **These are gates, not guidance.**

- **R1 — Default-OFF / byte-identical.** `dataset_family` defaults to `verified`; unset ⇒ zero new reads/fields, byte-identical output. New knobs `default: undefined ⇒ OFF`. *(src/config/knob-schema/contracts.ts:83; derive-inventory default-OFF proof.)* **Verify:** golden-diff regression of `predictions.jsonl`+`report.json` for `verified` with all dataset env unset.
- **R2 — Pro grading is SERIAL (mutex), concurrent BANNED.** `proVerifier` routes every Docker spawn through the **same** `withGradingLock` as the official harness (export it). *(python-swebench.ts:350-379 — concurrent grading PROVEN false-negative 0/5→4/5, 2026-06-19.)* **Verify:** lock-counter test, max-in-flight === 1.
- **R3 — Single KnobSchema SSOT (no 4th config system).** `dataset_family` + Pro/Live knobs declared once in `src/config/knob-schema/schemas/`; registry/inventory/CLI/docs derived. No scattered `process.env.QUANTA_SWEBENCH_*`. *(contracts.ts:62; derive-parity tests.)* **Verify:** grep — env vars appear in exactly one schema, zero raw reads in `profiles/`.
- **R4 — `report.json` carries `datasetFamily`.** `BenchReport` gains `datasetFamily` (+ Pro per-instance `dockerhubTag`/`repoLanguage`); winning-config records include it. *(report.ts:11-18,187-215 — field absent today; SSOT for comparability.)* **Verify:** Pro report serializes `datasetFamily:"pro"`; Verified OMITS it (R1).
- **R5 — Fail-closed, refuse-to-fake-grade.** `proVerifier` NEVER throws (unavailable harness/image/CSV ⇒ `{resolved:false, log}`); when Pro grading is requested but the harness/Docker is missing, **abort loudly**, never silently count a local-pytest green. *(python-swebench.ts:29,345; index.ts:925 "REFUSING to fake-grade".)* **Verify:** harness-missing ⇒ batch aborts, no fallback score.
- **R6 — No-heuristics / measure-first / no n=1.** Pro's `selected_test_files_to_run`/`interface`/`issue_categories`/`fail_to_pass` MUST NOT reach the agent prompt/localization path (grading-only) and MUST NOT become regex/path answer-key shortcuts; the P2 baseline is multi-instance measured, not n=1. *(MEMORY no-answer-key, gold-as-ours .tmp/CSV leak trap.)* **Verify:** grep guard (mirror the `*_STEER` answer-key ratchet) that grading-only fields never enter prompt assembly.
- **R7 — God-code ratchet.** `pro-swebench.ts`/`profiles/*` < 1000 lines, functions < 150; **never** add to `tools/god-code/allowlist.json`; parameterizing `python-swebench.ts` must not push it over. *(AGENTS.md:54-73.)* **Verify:** `bun test tests/unit/god-code-ratchet.test.ts` green, no allowlist additions.
- **R8 — Slice fence.** Library slice (`src/runner/batch/`) MUST NOT import `src/apps/bench/*` verifiers. Profiles/verifiers live in the **app** slice; the library receives them via injected ports (§5.1). *(AGENTS.md:43-52 — app slices "cannot be imported from outside their own slice", Biome `noRestrictedImports`.)* **Verify:** `bun lint` green; grep `corpus/profiles/` for `apps/bench` import = 0.
- **R9 — Egress / untrusted-image / cost-cap.** `jefzda/sweap-images` (untrusted 3rd-party) and Scale harness run **only on a disposable grading box**, never the agent host; pinned deps; respect `QUANTA_MAX_COST_USD`; `ulimit`/nproc cap to prevent the uv/subprocess fork-storm OOM. *(agent-config-assembler.ts cost cap; MEMORY jun-28 xarray fork-storm OOM.)* **Verify:** preflight (image-pull size/disk + cost budget) before any Pro campaign.
- **R10 — Strong tests + real byte-identity guard.** New tests mutation-resistant, paired-control (Pro-on/off), red-on-injection, wiring-proof (assert the mutex is awaited — R2); the Verified byte-identity guard is a golden-diff that goes RED on a deliberate perturbation, not a vacuous smoke. *(MEMORY test-quality-culture; "wired≠engages" theater class.)* **Verify:** inject a one-field perturbation into `verified` profile ⇒ guard fails.
- **R11 — Score authority.** Only an authoritative Pro-harness green counts as leaderboard score; a local repro green is a ranking/safety signal in the **non-authoritative** bucket. *(report.ts:19-22,197 authority split.)* **Verify:** repro-green without Pro-harness-green ⇒ `scoreTotals` authoritative=false.

## 9. Risks / open questions

1. **Live grades through stock `swebench`?** — P1 blocking probe (else Live = verifier #3). *(A-F3)*
2. **Pro `--raw_sample_path` CSV** — profile must keep/produce both JSONL + CSV. *(risk #1 draft)*
3. **Patch capture is Python-shaped** (env-strip, lang-specific lockfile noise) — a green Pro Python baseline will NOT generalize to Go/JS/TS for free; that's P3, not free. *(A-F4)*
4. **Pro Best-of-N cost** — bound by the §5.4 cheap-proxy-then-grade-winner strategy.
5. **Flagship clone detector / full-OWASP number** — measurement gaps tracked in the analysis doc, not this RFC.

## 10. Audit log (§A) — 3 rounds

- **R1 (fan-out, 3 adversarial lenses, code-grounded):** architecture/correctness (8 findings), code-vs-RFC (7), implementation-rules (R1–R11). Surfaced: slice-fence violation in the layout, mislocated seams (predictions in `core.ts`, grade via injected dep not `profile.grade`, lowercase at `dataset.ts:349`), `before_repo_set_cmd` ≠ git, namespace already wired, Best-of-N × Pro-grade cost, per-dataset budget, 11 missing impl rules.
- **R2 (reconcile + self-verify):** I re-read primary source for the 4 load-bearing corrections — AGENTS.md:43-52 (fence), verdict.ts:49 (injected dep), harness/config.ts:20 + python-swebench.ts:93 (namespace/datasetName exist), core.ts:158 (predictions hardcoded), dataset.ts:349 (raw uppercase). All confirmed; design rewritten to inject-down via existing DI.
- **R3 (convergence):** corrected design introduces no new fence crossings (verifiers stay app-slice, injected); Verified byte-identity preserved (default formatter/verifier/budget unchanged, no `datasetFamily` emitted); all 11 rules have a landing point + verification. Clean.

## 11. References

- `ScaleAI/SWE-bench_Pro` (HF, 731); `scaleapi/SWE-bench_Pro-os` (`swe_bench_pro_eval.py`, `jefzda/sweap-images`).
- `SWE-bench-Live/SWE-bench-Live` (HF, arXiv:2505.23419).
- `princeton-nlp/SWE-bench_Verified`; `swebench.harness.run_evaluation`.
- Seams: [verdict.ts](../../../src/runner/batch/eval/verdict.ts), [core.ts](../../../src/runner/batch/core.ts), [dataset.ts](../../../src/runner/batch/corpus/dataset.ts), [python-swebench.ts](../../../src/apps/bench/python-swebench.ts), [harness/config.ts](../../../src/apps/bench/harness/config.ts), [report.ts](../../../src/runner/batch/report.ts), `AGENTS.md:43-73`.
