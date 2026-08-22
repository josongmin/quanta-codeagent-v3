# TB21-00 — Terminal-Bench 2.0 retirement manifest

**Ticket:** [TB21-00](./tickets/TB21-00-main-snapshot-and-retirement-manifest.md)
**Snapshot:** [TB21-00 execution snapshot](./TB21-00-execution-snapshot.md) @ `9d5369d31`, `2026-08-22T00:16:53+0900`
**Status:** ENUMERATION ONLY. **Nothing here has been deleted, moved, or archived.**

## Disposition vocabulary

| Disposition | Meaning | Executed by |
|---|---|---|
| `replace` | The surface stays as a *file/concept* but its 2.0 authority is rewritten to 2.1 (pin, identity, projector). Content is superseded in place. | TB21-01 … TB21-05 |
| `delete` | The surface is removed outright. Git is the history; no archive copy is kept. Any live contract inside it is transferred *first*. | TB21-06 (after TB21-05) |
| `archive-after-canary` | Local, non-Git artifact. Moved to a timestamped recoverable archive **only after a green 2.1 canary**, never deleted in the same step. | TB21-06 / TB21-07, per the destination policy in §8 |

## Hard preconditions on every `delete` / `archive-after-canary` row

Per the ticket's RED rails, **none** of these rows may be executed until **both**:

1. exact read-only target resolution has been performed for that specific row
   (`ls`/`find`/`git ls-files` of the literal path, echoed and reviewed), **and**
2. a **green 2.1 canary** exists (TB21-03 3-task canary at minimum, and for report/
   dashboard rows the TB21-05 dashboard renders it).

At snapshot time **neither** condition holds. Zero destructive commands have run.

---

## 1. Source / runtime

| # | Surface | Disposition | Rationale · transfer-first obligation |
|---|---|---|---|
| SR-1 | `src/apps/terminal/best-of-n.ts` (210 L) | `delete` | Terminal-only Best-of-N *selector*. Backlog **Trial ownership**: Harbor owns trials via `-k`; the terminal brain stays one clean attempt. Verified **runtime-dead**: zero production callers. Nothing to transfer. ⚠️ Must not be confused with SR-FRAME `src/apps/bench/sampler.ts` (see reuse manifest RU-9). |
| SR-2 | `src/apps/terminal/best-of-n.test.ts` (232 L) | `delete` | Test of SR-1; dies with it. |
| SR-3 | `src/apps/terminal/best-of-n-runner.ts` (192 L) | `delete` | The N-runner wrapper (`runTerminalBrainBestOfN`, `resolveBestOfN`, `TB_BEST_OF_N_ENV`, `BEST_OF_N_MAX`). Zero production callers (only its own test + a knob-inventory `readSite` string). This is the "second sampling layer" the backlog forbids. |
| SR-4 | `src/apps/terminal/best-of-n-runner.test.ts` (312 L) | `delete` | Test of SR-3. |
| SR-5 | `src/apps/terminal/brain-mode.ts` — the `bestOfN?: { attempts; cap?; winnerIndex; rationale }` report field (`:215-226`) and its doc block | `delete` | Terminal-only best-of-N **report field**. Only writer was SR-3. Removing it is byte-identical for every single-run report (field is optional and was never emitted in production). |
| SR-6 | `src/config/knob-inventory/extra.ts` — the `envKey: "QUANTA_TB_BEST_OF_N"` entry (`:683-692`) and its 5-line preamble comment (`:678-682`) | `delete` | Knob-inventory entry for a deleted knob. The inventory is the value authority (reuse manifest RU-6); leaving a `readSite` pointing at a deleted file rots it. **Transfer-first: none** — no 2.1 replacement knob; `-k` is Harbor's. |
| SR-7 | `src/apps/terminal/brain-mode.ts:901-907` — the comment block explaining that Lever #3 runs out-of-process | `delete` | Comment describing a deleted mechanism. |
| SR-8 | `src/apps/terminal/index.ts:2`, `brain-mode.ts:2`, `terminal-surface.test.ts:2`, `brain-mode.test.ts:5` — `RFC jun-29 §13, spec S2/S3/B3/B4` citations | `replace` | Source comments linking to the retired TB RFC (DR-1). Repoint to the 2.1 packet (`docs/plans/aug-21-bench-terminal-2-1/`) — the *terminal surface* itself is kept (reuse manifest RU-11). |
| SR-9 | `src/tool/{container-exec/port.ts:3, container-exec/ipc-backend.ts:2, default-tool-ports.ts:204, index.ts:916, pty/docker-exec-tmux.ts:2, surface/gated-tools.ts:823,829, terminal-capability-guide.ts:2, terminal-surface.test.ts:2}` — `RFC jun-29 §…` citations | `replace` | Same as SR-8, in the `@/tool` slice. **9 sites.** Comment-only repoint; no behavior change. |
| SR-10 | `src/tool/terminal-capability-guide.ts:10` — the `~24% of failures per the TB2.0 paper` citation | `replace` | Rewrite to the 2.1 authority or drop the version claim. The *guide* is kept (reuse RU-11); only the 2.0 statistic is retired. |
| SR-11 | `src/apps/terminal/brain-mode.ts:140,158,65` · `best-of-n{,-runner}{,.test}.ts` · `brain-mode.test.ts:577,685` · `src/agent/surface-profile.test.ts:3` · `src/apps/terminal/surface-profile-brain.test.ts:3` — `jul-2-terminal-bench-levers/NN` citations (**12 sites / 8 files**) | `replace` | Source comments linking to the retired levers plan (DR-2). Repoint. The Lever #1/#2 knobs themselves are **kept** (SR-12). |
| SR-12 | `QUANTA_TB_{ENV_OWNED, VERIFY_GATE, SELF_TEST, ORACLE_LOOP, OUTPUT_CONTRACT, WRITE_TOOL, STREAM_CAP, TRAJECTORY}` — 8 knob-inventory entries + read sites | **NOT retired** — see reuse manifest RU-7 | These are terminal-**brain behavior** knobs (env posture, verify gate, self-test, stream cap), not TB2.0 dataset/scoring authority. They are measured *by* 2.1, not replaced by it. Recorded here explicitly so the RED rail "known TB2.0 surface without a disposition" cannot be tripped by a sweep that matches on `QUANTA_TB_`. Only `QUANTA_TB_BEST_OF_N` (SR-6) is retired. |
| SR-13 | `QUANTA_TB_BRAIN_LOG_DIR` (adapter-side, `quanta_agent.py:126`; set by TS-1/TS-2/SC-1) | `replace` | Kept as a mechanism but re-owned by the TB21-03 manifest/profile rather than by ad-hoc shell exports. Not in the knob inventory today — that gap is TB21-03's to close. |
| SR-14 | `src/apps/eval/public/mapping.ts:39` — `bench: "terminalbench"` | **out-of-scope** (no retirement action) | This is the *public-eval leaderboard name mapping*, not a TB run authority. Listed to close the sweep; TB21-05 must not touch it. |
| SR-15 | `src/agent/converge/self-test.ts:3`, `src/agent/prompt-rules/verify-strategy.ts:12`, `src/tool/container-exec/tool.ts:39,43` — `QUANTA_TB_*` references | **NOT retired** (kept, per SR-12) | Read sites of retained lever knobs. No action. |

## 2. Adapter / package

| # | Surface | Disposition | Rationale · transfer-first obligation |
|---|---|---|---|
| AP-1 | `adapters/terminal-bench/README.md` (6 sweep hits: `terminal-bench-2` ×2, `--agent-import-path` ×4) | `replace` | Rewrite for the 2.1 dataset, the pinned Harbor ref, and the versioned agent. Every `-d terminal-bench` / `terminal-bench-2` example is 2.0 authority. |
| AP-2 | `adapters/terminal-bench/pyproject.toml` | `replace` | **The pin violation.** `[project.optional-dependencies].harbor = ["harbor @ git+https://github.com/harbor-framework/harbor.git"]` — a floating VCS `main` dep, self-labelled "the placeholder". Backlog forbids VCS-`main`/`latest` as promotable evidence. TB21-01 replaces with an exact pinned commit/tag. Also bumps `version = "0.1.0"` into a real provenance value (AP-4). Line 6's RFC path citation is a DR-1 link → `replace`. |
| AP-3 | `adapters/terminal-bench/Dockerfile` | `replace` | Installs the `.[harbor]` extra; must consume the AP-2 pin. Re-verify no secret enters a layer (backlog reproducibility rule). |
| AP-4 | `adapters/terminal-bench/quanta_agent.py:241-243` — `version() -> "str \| None": return None` | `replace` | Harbor's provenance hook returns `None`, so **no report can carry an agent version** — directly blocks the backlog DoD *"Quanta agent version and reasoning effort are visible to Harbor and receipts."* TB21-02 replaces with a real version (Quanta SHA + dirty flag + package version). |
| AP-5 | `adapters/terminal-bench/quanta_agent.py` (rest, 324 L) — `_probe_brain_version`, `_spawn_brain`, ATIF/trajectory paths | `replace` | Kept as the Harbor glue but rewritten for 2.1 (versioned agent, ATIF trajectory paths, reasoning effort). Not a delete — this is the live integration seam. |
| AP-6 | `adapters/terminal-bench/quanta_terminal_bridge/{__init__,protocol,serve}.py` | **NOT retired** — `replace` only if the 2.1 protocol changes | The stdlib-only box-free bridge. Version-agnostic transport; **transfer-first target** for anything AP-5 needs. Golden-parity contract with `src/tool/container-exec` (AP-8). |
| AP-7 | `adapters/terminal-bench/tests/{test_agent_adapter,test_golden_parity,test_protocol,test_quanta_agent_run}.py` | `replace` | Adapter test suite (the backlog's `29 passed` rail). Must be rewritten alongside AP-4/AP-5, not deleted — it is the cheapest authoritative rail in the proof ladder. |
| AP-8 | `adapters/terminal-bench/protocol-golden.json` + `src/tool/container-exec/golden-parity.test.ts` (which reads it at `:29`) | **NOT retired** — `replace` only on protocol change | Cross-language golden fixture pinning TS↔Python parity. **Live contract**: deleting it silently unpins the bridge. Explicitly recorded so it is never swept as "a TB2.0 json". |
| AP-9 | `adapters/terminal-bench/tally-verification.sh` | `delete` | A 2.0-run tallying helper superseded by the canonical report writer + official scorer (TB21-04). Transfer-first: confirm TB21-04's scorer covers whatever tallies it produced before removal. |
| AP-10 | **Committed build artifacts**: `adapters/terminal-bench/__pycache__/quanta_agent.cpython-313.pyc`, `quanta_terminal_bridge/__pycache__/{__init__,protocol,serve}.cpython-313.pyc`, `tests/__pycache__/test_quanta_agent_run.cpython-313-pytest-9.1.1.pyc`, `quanta_terminal_bench.egg-info/{PKG-INFO,SOURCES.txt,dependency_links.txt,requires.txt,top_level.txt}` — **10 tracked files** | `delete` | Stale Python 3.13 bytecode and setuptools metadata **committed into Git** (`git ls-files adapters/terminal-bench` → 23 tracked, 10 of them build output). They embed the old `version = 0.1.0` and pin nothing. Add `.gitignore` coverage in the same TB21-01 change so they cannot return. (`adapters/terminal-bench/.pytest_cache/`, `tests/.pytest_cache/` are already ignored — no action.) |
| AP-11 | `package.json` scripts | **no TB entry exists** — `out-of-scope` today | Verified: **zero** `tb`/`terminal` scripts. TB21-03 *adds* a thin alias to `quanta-bench terminal …` (backlog: package scripts may only be thin aliases). Recorded so the sweep is closed, not because something must be removed. |

## 3. Scripts

| # | Surface | Disposition | Rationale |
|---|---|---|---|
| SC-1 | `tools/tb-smoke/run-tb-smoke.sh` | `replace` | Line 32: `harbor run -d terminal-bench $INC --agent-import-path quanta_agent:QuantaAgent -m gpt-5.5 -n 8 -o "$OUT"`. Retired dataset shorthand, unpinned harbor, hardcoded model, own output root. TB21-06 rewrites the smoke to enter through `quanta-bench terminal …`. |
| SC-2 | `tools/tb-smoke/run-selftest-ab.sh` | `replace` | Line 24: same shape plus `-k "$K"` A/B arms. Same treatment. |
| SC-3 | `tools/tb-smoke/smoke-set.md` | `replace` | The task-set SSOT mirror. Its GUARD/TARGET sets are keyed to **TB2.0** task names and to competitor pass-rates from the 2.0 leaderboard (CR-1). The *concept* survives into the 2.1 smoke; the 2.0 task list and pass-rate justifications do not. **Transfer-first**: re-derive GUARD/TARGET against the 2.1 89-task set before rewriting. |
| SC-4 | **`script/bench-smoke/smoke-terminal-bench-ver-jul-5.sh`** (104 L) | `replace` | ⚠️ **Discovered outside the ticket's Required inventory** (the ticket's `rg` scope was `adapters src tools docs package.json`; this lives under `script/`). A third TB2.0 driver: exports the full lever stack (`ENV_OWNED`/`VERIFY_GATE`/`OUTPUT_CONTRACT`/`WRITE_TOOL`/`SELF_TEST`/`ORACLE_LOOP`) plus optional `QUANTA_TB_BEST_OF_N` (arg `$1`, 2..4) — so it is a **live caller of SR-3**, which must be removed from this script before SR-3 can be deleted. Also hardcodes `-m gpt-5.5`, writes to `~/tb-results/jul5-blogs`. Recorded under the ticket's **Stop rule**. |

## 4. Dashboard / report schema

| # | Surface | Disposition | Rationale |
|---|---|---|---|
| DB-1 | `tools/leaderboard-dashboard/tb-report-emit.ts` (275 L) | `delete` | The 2.0 raw→report emitter. Its core act — *"Dedups to ONE verdict per task (any-pass wins)"* (`:97-138`) — is exactly what the backlog forbids (*"Preserve every trial. Do not reduce trials to one any-pass boolean per task."*). It also writes `datasetFamily:"terminal-bench"` (`:113`), an invalid axis, and emits directly into the SSOT sink (`:244-268`) — a dashboard-adjacent tool owning report emission, which the backlog forbids. **Transfer-first**: its raw-tree walk and its error taxonomy (`AgentTimeoutError` ⇒ task timeout vs other exception ⇒ agent-crash, `:53`) are real contracts that TB21-04's lossless writer must absorb before deletion. |
| DB-2 | `tools/leaderboard-dashboard/tb-report-emit.test.ts` (238 L) | `delete` | ⚠️ **Not named in the ticket's Required inventory** — added here. Dies with DB-1; any error-taxonomy assertion worth keeping migrates to the TB21-04 test. |
| DB-3 | `tools/leaderboard-dashboard/tb-pertask.ts` (78 L, `parseTbPertask` / `TbPertask`) | `replace` | Parser for the competitor matrix. The *parsing capability* survives into the TB21-05 projector; the 2.0 column semantics do not. Consumed at `server.ts:29,919-922`. |
| DB-4 | `tools/leaderboard-dashboard/server.ts` — the **13** raw `terminal-bench` sites: `:407` (filename→family sniff), `:860` (family skip), `:929-940` (label map + `order = ["verified","pro","live","terminal-bench"]`), `:1283` (`.fam-terminal-bench` CSS), `:1434`/`:1695`/`:2122` (`BENCH === "terminal-bench"` render branches), `:1616-1639` (`tbOurResults` any-pass fold, arm-split by preset text), `:1828` (`fam-terminal-bench` badge) | `replace` | Replaced wholesale by the **BFND-03 suite projector** registration (reuse manifest RU-8). Backlog: *"`datasetFamily: "terminal-bench"` is invalid"* and *"Dashboard suite projection contains no second scorer or any-pass headline fold."* `server.ts` is 2368 lines (god-module) — the projector extraction is the mechanism, not an in-place edit. |
| DB-5 | `tools/leaderboard-dashboard/server.ts:1641-1690` — `famOurResults` generic any-pass fold + `runCount` headline for pro/live | **out-of-scope** for TB retirement | Shares the any-pass shape but is the **SWE** pro/live view. Recorded so TB21-05 does not collaterally delete it, and so the RED rail is not tripped by a grep for "any-pass". |
| DB-6 | `tools/leaderboard-dashboard/server.test.ts:780-812` — `describe("tbOurResults (D1/P1-C) …")` | `replace` | Test of DB-4's fold; rewritten as the projector test (`projectors/terminal-bench.test.ts` per the backlog proof ladder). |
| DB-7 | `tools/leaderboard-dashboard/server.ts:71` — `TB_PERTASK_MD = argOf("--tb-matrix") ?? join(RAWDATA, "tb-pertask.md")` and `:919-922,973` `loadTbPertask()` wiring | `replace` | The 2.0 competitor-matrix input path. Re-pointed to a 2.1 matrix by TB21-05, or dropped if no 2.1 competitor matrix is available. |
| DB-8 | The legacy on-disk report **schema shape** itself: `{datasetFamily,knobs,model,perInstance,source,timestamp}` with **no** `schemaVersion`/`benchmarkSuite`/`benchmarkVersion`/`datasetRef` | `replace` | Superseded by BFND-02's `TerminalBenchReport` (`benchmarkSuite:"terminal-bench"`, `benchmarkVersion:"2.1"`, `dataset`, `datasetRef`, trial receipts). Backlog: a TB report missing that identity is legacy and **must not enter** the active 2.1 score/matrix — and **no compatibility parser may guess** a legacy report is 2.1. The dashboard must *exclude* legacy, not upgrade it. |

## 5. Competitor rawdata

| # | Surface | Disposition | Rationale |
|---|---|---|---|
| CR-1 | `tools/leaderboard-dashboard/rawdata/tb-pertask.md` (94 L) | `replace` | Header: *"Terminal-Bench **2.0** — task별 난이도 × 상위권 pass율"*, source `harborframework/terminal-bench-2-leaderboard`, top-6 submissions. Pure **2.0** competitor data; feeding it into a 2.1 view is the "TB2.0 data contamination" the backlog's outcome #6 forbids. Replaced by a 2.1-leaderboard-derived matrix, or the column is dropped (DB-3 tolerates absence: *"Absent ⇒ TB view still shows our runs, just no competitor column"*). |
| CR-2 | `docs/analysis/terminal-bench-pertask.md` | `delete` | **Byte-identical duplicate of CR-1** (md5 `1d6f3a409a4b7c523c1c6a27b6f9f89c`). Two copies of the same 2.0 matrix in two trees is a drift hazard; one canonical location (CR-1) survives. |

## 6. Docs / RFC / evidence

| # | Surface | Disposition | Rationale |
|---|---|---|---|
| DR-1 | `docs/rfc/jun-29-rfc-terminal-bench-integration.md` (227 L) | `delete` | The 2.0 integration authority (§13 "SOTA++ 레버 … TB2.0 논문 2601.11868", §7.5 harbor-`main` interface measurement, §10 the yanked-PyPI-`harbor` note). Superseded in full by this packet. **Transfer-first — three live contracts must move before deletion:** (a) §5.3 *Ownership boundary* (the "TB-전용 분기 침입 탐지" rule enforced by `src/tool/terminal-surface.test.ts:97-104`); (b) §3's `--agent module:Class` selector shape, cited by `pyproject.toml:6`; (c) §4.5 capability-guide rationale behind `terminal-capability-guide.ts`. ⚠️ **Do not sweep "RFC jun-29" repo-wide**: the token is overloaded across three unrelated docs — this RFC, `docs/plans/jun-29-swe-benchmark-platform` ("RFC jun-29 R4" dataset-family/platform, ~40 sites), and `docs/plans/jun-29-repro-adapter-polyglot`. Only the **13** sites listed in SR-8/SR-9 cite *this* document. |
| DR-2 | `docs/plans/jul-2-terminal-bench-levers/**` (10 files) | `delete` | The 2.0 lever campaign: `00-MASTER-PLAN.md`, `01-env-posture-rfc.md`, `02-verify-before-finalize-rfc.md`, `03-verify-gate-rca-and-redesign.md`, `03-verify-gate-v2-compare-to-reference.md`, `04-best-of-n-fair-selection.md`, `05-brain-observability.md`, `06-dashboard-tb-integration.md`, `07-close-the-gap-action-plan.md`, `README.md`. **Transfer-first**: `00 §X` defines the terminal brain's declared `SurfaceProfile`, which is a live contract asserted by `src/agent/surface-profile.test.ts` and `src/apps/terminal/surface-profile-brain.test.ts` — that definition must land in the 2.1 packet first. `06-dashboard-tb-integration.md` is the design DB-4 implements; superseded by TB21-05. |
| DR-3 | `docs/plans/jul-3-tb-lever-audit-fixes/{00-PLAN,02-bestofn-audit-and-sota,03-module-audit-and-metrics}.md` | `delete` | ⚠️ Not in the ticket's Required inventory — added. The audit-fix follow-on to DR-2, incl. the best-of-N audit that justified SR-1..SR-4. Dies with them. |
| DR-4 | `docs/tickets/jul-01-live-and-terminal-bench-finish.md` | `delete` | Closed 2.0 ticket; contains a `--agent-import-path` invocation. |
| DR-5 | `docs/analysis/terminal-bench.md` | `archive-after-canary` → then `delete` | 2026-06-29 investigation ("2.0 벤치 메커니즘 · 경쟁구도 · 통합 갭"). Pure historical judgement, no live contract, but it is the *reason* the 2.0 integration was shaped as it was. Per the ticket (*"Historical files are not retained merely because they are old"*) it is a `delete` — sequenced after the canary so its gap analysis can be re-checked against 2.1 first. |
| DR-6 | `docs/analysis/terminal-bench-analysis/**` (133 files: `FAILURE-RCA.md`, `FAILURE-TYPES-AND-FIXES.md`, `SYNTHESIS.md`, `TAXONOMY.md`, `SOLUTIONS-CROSSREF.md`, `README.md`, `_data/{classified.json,tasks.jsonl}`, 89 `tasks/**/*.md`, 10 `<task>/reference-solve.sh`, 13 competitor `scaffolds/*.txt`) | `archive-after-canary` | The **2.0 89-task** failure taxonomy + competitor scaffold transcripts. Six files carry an explicit `Terminal-Bench 2.0` header. It is 2.0 *evidence*, and the 2.1 task set differs — so it cannot inform 2.1 targeting unmodified. Archived (not deleted outright) because the failure **taxonomy** (`TAXONOMY.md`, `FAILURE-TYPES-AND-FIXES.md`) is what the retained lever knobs (SR-12) were designed against; TB21-06 decides delete-vs-port after the canary shows which classes still exist. |
| DR-7 | `docs/evidence/jul-6-smoke-prompts/README.md:12`, `docs/analysis/jul-03-absorption-efficacy-measurement.md:10,45`, `docs/analysis/jul-04-agent-loop-decision-map.md:478`, `rfc/0003-eval-architecture.md:116,236,256`, `docs/10.feature-catalog.md:1071`, `docs/analysis/jul-4-scaffold-review-prompt-rendering/README.md` | `replace` (link/label repoint only) | Incidental `terminal-bench` / `TerminalBench` / `QUANTA_TB_ENV_OWNED` mentions inside documents whose subject is **not** TB2.0. No 2.0 authority lives here; only stale names/links. Listed to close the sweep and prevent a "discovered consumer" stop later. |
| DR-8 | `tools/feature-catalog/features/10-app/eval-public-swebench-bridge.yaml:30,49` (`TerminalBench` as a public-eval leaf) | **out-of-scope** | Pairs with SR-14. Public-eval naming, not a TB run authority. |

## 7. Local external run artifacts (non-Git)

All rows are `archive-after-canary` and are governed by §8. **Not one of these paths has
been touched.**

| # | Path | Measured size | Disposition | Rationale |
|---|---|---|---|---|
| LA-1 | `~/.quanta/bench/results/report-terminal-bench-baseline.report.json` | 10K, 88 tasks / 48 pass, mtime Jul 3 01:55 | `archive-after-canary` | Versionless legacy (no `schemaVersion`/`benchmarkSuite`), `datasetFamily:"terminal-bench"`. Sits in **report root #1**, the canonical SSOT sink the dashboard scans first — so while it exists it can contaminate cards/matrix/filters. Backlog DoD: *"Old versionless reports cannot affect cards, matrices, filters, or leaderboards."* **Two independent guarantees are required**: (i) TB21-05's projector must *refuse* identity-less reports (a code guarantee that holds even if the file returns), and (ii) this archive move. Do (i) first — the move alone is not the fix. |
| LA-2 | `~/.quanta/bench/results/report-terminal-bench-levers.report.json` | 4.9K, 42 tasks / 17 pass, mtime Jul 3 02:29 | `archive-after-canary` | Same as LA-1. Also the "levers arm" half of a baseline/levers pair the backlog forbids combining into a projected union score. |
| LA-3 | `~/.quanta/bench/tb-raw/full89/{2026-07-01__11-46-00, __14-08-06, __14-09-28, __15-10-16, __16-11-01}` | 5 job dirs | `archive-after-canary` | Raw 2.0 harbor job trees (the DB-1 emitter's input). Kept until TB21-04 proves its lossless writer reproduces LA-1/LA-2's numbers from them — they are the only ground truth for that parity check. |
| LA-4 | `~/.quanta/bench/tb-raw/failset-levers/2026-07-02__16-18-06` | 1 job dir | `archive-after-canary` | Same. `~/.quanta/bench/tb-raw` total: **1069 entries, 1.6M, 6 job dirs**. |
| LA-5 | `~/tb-results/full89/` — 9 dated job dirs (`2026-07-01__17-22-33` … `__19-25-28`), each with `job.log`, `lock.json`, `result.json`, `config.json` + per-task dirs | part of 294 entries / 1.8M | `archive-after-canary` | 2.0 full-89 run outputs written by SC-1/SC-2/SC-4's `-o "$OUT"`. |
| LA-6 | `~/tb-results/full89-brain-logs/` — 52 `brain-quanta-tb-*.stderr.log` | part of 294 entries / 1.8M | `archive-after-canary` | Brain stderr from `QUANTA_TB_BRAIN_LOG_DIR` (SR-13). **May contain prompt/response text** — check for secrets before any archive that leaves the machine, per the backlog's no-secrets rule. |
| LA-7 | `~/.quanta/bench/results/tmp__*` — **3680 files** of test scratch (`tmp__bench-art-*`, `tmp__bench-hg-*`, `tmp__batch-report-parity-*`, `tmp__bench-report-knobs-*`, `tmp__bugbash-*`) | ~59M root total | **out-of-scope** for TB retirement | ⚠️ **29 of the ticket's 32 `find` hits are these**, matched only by `-iname '*tb*'` hitting random suffixes (`…-8RTBah`, `…-lp84Tb`). They are **SWE test scratch, not TB2.0**. Recorded explicitly so a TB cleanup never globs them. Their accumulation is a separate hygiene issue, not this campaign's. |

## 8. Destination policy for old local artifacts

Binding order for every `archive-after-canary` row. **All four steps must be satisfied
in order; skipping any one voids the row.**

1. **Gate — green 2.1 canary first.** No archive/delete of any local artifact until the
   TB21-03 three-task canary is green *and*, for LA-1/LA-2, TB21-05 renders a 2.1 report
   in the dashboard. A dirty-overlay canary does not count (backlog: a green dirty-overlay
   run is not a committed-current-SHA receipt).
2. **Exact read-only target resolution.** Immediately before any move, resolve the literal
   targets read-only and review the printed list — `ls -la <exact path>` / `find <root> -maxdepth 1`.
   **Never a glob, never `-iname '*tb*'`** (LA-7 proves that pattern is 91% false-positive),
   never `rm -rf` on a variable that could be empty.
3. **Archive first, timestamped and recoverable.** Move — never delete — into
   `~/.quanta/bench/archive/tb-2-0/<UTC-YYYYMMDD-HHMMSS>/` preserving the relative path
   under it, e.g.
   `~/.quanta/bench/archive/tb-2-0/20260822-000000/results/report-terminal-bench-baseline.report.json`.
   The archive root must sit **outside every dashboard `REPORT_ROOTS` entry** (snapshot §5)
   so archived reports cannot be re-scanned. Write a `MANIFEST.txt` in the timestamp dir
   recording source path, byte size, and mtime for each moved file.
4. **Permanent deletion is a separate, later, explicitly-authorized act.** Only after the
   archive exists, its manifest is verified against the recorded sizes, and the 2.1 rail
   has produced its own receipts. Deletion targets are named literally, one path per line,
   with no wildcard. Nothing is deleted in the same command that archives it.

Redaction: before LA-6 (brain stderr) is copied anywhere off this machine, scan for
credentials/tokens. No secret may enter reports, logs, trajectories, docs, or archives.

## 9. RED-rail self-check

| Rail | Result |
|---|---|
| Every surface in the ticket's *Required inventory* has a disposition | **PASS** — `adapters/terminal-bench/{README.md,pyproject.toml,Dockerfile,quanta_agent.py}` → AP-1..AP-5; `tools/tb-smoke/**` → SC-1..SC-3; `tools/leaderboard-dashboard/{tb-report-emit.ts,tb-pertask.ts,server.ts}` → DB-1, DB-3, DB-4; `rawdata/tb-pertask.md` → CR-1; raw `datasetFamily === "terminal-bench"` branches → DB-4 (`replace` by projector); terminal-only best-of-N source/tests/report-fields/knob → SR-1..SR-6; `docs/rfc/jun-29-…` → DR-1; `docs/plans/jul-2-terminal-bench-levers/**` → DR-2; source comments linking retired docs → SR-8, SR-9, SR-11, AP-2; versionless reports under `~/.quanta/bench/results/` → LA-1, LA-2; `~/.quanta/bench/tb-raw/` → LA-3, LA-4; `~/tb-results/` → LA-5, LA-6. `src/apps/bench/{cli,dataset-family,preset,report}.ts` + `src/runner/batch/report.ts` are classified `reuse/extend` in the [framework-reuse manifest](./TB21-00-framework-reuse-manifest.md), as the ticket requires. |
| No known TB2.0 surface lacks a disposition | **PASS** — 42 rows, every one carrying exactly one of `replace` / `delete` / `archive-after-canary`, or an explicit **out-of-scope / NOT-retired** classification with a stated reason (SR-12, SR-14, SR-15, AP-6, AP-8, AP-11, DB-5, DR-8, LA-7). |
| No unclassified surface remains | **PASS** — the 118-file repo-wide sweep (snapshot §6.2) is fully partitioned across this manifest and the reuse manifest. |
| Consumers discovered after the ticket's inventory are recorded, not silently absorbed (Stop rule) | **PASS, with 4 flagged**: **SC-4** `script/bench-smoke/smoke-terminal-bench-ver-jul-5.sh` (a live caller of the SR-3 best-of-N runner — SR-3 cannot be deleted before SC-4 is rewritten); **DB-2** `tb-report-emit.test.ts`; **DR-3** `docs/plans/jul-3-tb-lever-audit-fixes/**`; and the lever-knob test consumers (`tests/unit/agent/prompt-env-posture.test.ts`, `tests/unit/agent/prompt-rules/owned-rules.test.ts`, `tests/unit/tool-surface-manifest-hellgate.test.ts:377`, `tests/unit/_arch/slice-boundary-configs.ts:129`, `tests/unit/src-no-sketchy-code.test.ts:167`), all covered by SR-12 as **retained**. |
| No destructive command has run | **PASS** — see execution snapshot §9. |

### Ordering constraints this manifest imposes on TB21-06

- **SC-4 before SR-1..SR-6.** `script/bench-smoke/smoke-terminal-bench-ver-jul-5.sh` still
  exports `QUANTA_TB_BEST_OF_N`. Deleting the runner first leaves a script that silently
  no-ops a knob it advertises.
- **DB-1's raw-tree walk + error taxonomy must be transferred into TB21-04 before DB-1 dies.**
- **DR-1's ownership-boundary rule must land in the 2.1 packet before DR-1 dies** — it is
  enforced at runtime by `src/tool/terminal-surface.test.ts:97-104`, which would otherwise
  assert against a deleted authority.
- **DR-2's `SurfaceProfile` definition must land in the 2.1 packet before DR-2 dies** — same
  reason, enforced by two surface-profile tests.
- **LA-3/LA-4 must survive until TB21-04 proves scorer parity against them.**
- **LA-1/LA-2's exclusion must be a code guarantee (TB21-05) before the file move**, not
  instead of it.

## 10. Items this manifest could NOT fully classify

| Item | Why | Resolution owner |
|---|---|---|
| `docs/analysis/terminal-bench-analysis/**` (133 files) — `archive` vs `delete` | The failure **taxonomy** may still describe live failure classes that the retained lever knobs (SR-12) target, but that can only be judged against 2.1 canary results, which do not exist. Classified `archive-after-canary` (a valid ticket disposition) with the delete/port decision deferred. | TB21-06, after TB21-03 canary |
| CR-1 `rawdata/tb-pertask.md` — whether a **2.1** competitor matrix exists to replace it | Requires reading the 2.1 leaderboard, which is external and was not fetched (no network authority in this ticket). If none exists, DB-3's absent-file path (`{scaffolds:[],tasks:[]}`) is the fallback and CR-1 becomes `delete`. | TB21-05 |
| AP-2 — the exact Harbor commit/tag to pin to | `harbor` is **not on `PATH`** (snapshot §4), so no installed version can be read, and resolving upstream requires network. Disposition (`replace`) is firm; the pin **value** is TB21-01's to measure. | TB21-01 |
