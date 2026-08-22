# TB21-00 — execution-time snapshot (freeze before any edit)

**Ticket:** [TB21-00](./tickets/TB21-00-main-snapshot-and-retirement-manifest.md)
**Captured:** `2026-08-22T00:16:53+0900`
**Captured by:** TB21-00 snapshot pass. **Read-only.** Zero destructive commands, zero
`git add/commit/push/stash/checkout --/reset`, zero edits outside this packet's manifests.

> This snapshot supersedes the historical "three user-owned files" list in the ticket's
> *Entry facts* and in `tickets/00-backlog.md`. Per the ticket, the **execution-time**
> snapshot — not the historical list — defines the preservation boundary.

---

## 1. Git identity

| Field | Value |
|---|---|
| full SHA | `9d5369d310bba9cfcdf2508ca62e6274f184cdd4` |
| short SHA | `9d5369d31` |
| commit subject | `done` |
| branch | `main` |
| upstream | `origin/main` |
| ahead / behind | `+0 / -0` (`git rev-list --left-right --count origin/main...HEAD` → `0  0`) |
| staged (index) paths | **0** (`git diff --cached --name-only` empty) |
| plan authoring SHA `11a54656bfc8` | **is an ancestor of HEAD** (`git merge-base --is-ancestor` → true) — fast-forward only, no ref rewrite |

## 2. Historical user-owned diffs — status: **already committed, tree clean**

`git diff -- package.json src/llm/adapters/chatgpt-oauth.ts src/llm/factory.ts` → **empty**.

| Path | Last commit touching it |
|---|---|
| `package.json` | `9d5369d31` 2026-08-21 `done` |
| `src/llm/adapters/chatgpt-oauth.ts` | `9d5369d31` 2026-08-21 `done` |
| `src/llm/factory.ts` | `9d5369d31` 2026-08-21 `done` |

A concurrent session committed these (plus `run-main.ts`, `corpus/dataset.ts`, and the
`aug-21-*` plan docs) into `9d5369d31`. **There is no user-owned uncommitted diff to
preserve.** The "byte-identical pre-existing user diffs" DoD clause is satisfied
vacuously-by-commit at this SHA, and the live obligation moves to §3.

## 3. Live dirty state — **21 modified + 17 untracked, ALL in-flight foundation work**

`git status --short --branch` at capture time. **This tree is actively moving**: a
concurrent background agent is building the BFND foundation packet and created 7 new
files during this snapshot pass alone (`report-envelope.ts`, `report-terminal.ts`,
`promax/provenance/*`). Treat the list below as a *stamped instant*, not a stable set.

### 3.1 Tracked-modified (21) — `446 insertions(+), 118 deletions(-)`

| Path | Δ | Targeted diff summary (hunk-level) |
|---|---:|---|
| `src/apps/bench/cli.ts` | +19 | adds `terminal` to `KNOWN_SUBCOMMANDS`; new `case "terminal"` calling `resolveBenchmarkRunConfig({subcommand:"terminal"})` + a "not yet wired" log. BFND-01 suite registration stub. |
| `src/apps/bench/commands/grade.ts` | +41/−? | new imports from run-config/profiles; family threading into full-remote grade + `cmdGrade`. |
| `src/apps/bench/commands/pool.ts` | +32 | `planPoolChunkAccounts` added; family threading into `cmdPool`. |
| `src/apps/bench/corpus/paths.ts` | +1 | re-export line. |
| `src/apps/bench/dataset-family.test.ts` | +26/−? | `resolveDatasetFamily` cases moved out (to `run-config.test.ts`). |
| `src/apps/bench/dataset-family.ts` | −33 net | `resolveDatasetFamily` / parse / grade-evaluator bodies thinned; behavior delegated to `profiles/registry.ts` (T4). |
| `src/apps/bench/remote/box-session.ts` | +14 | Pro env prelaunch/`buildProEnv` extension. |
| `src/apps/bench/remote/box-session/dataset-preflight.ts` | +13 | `assertProDatasetGradeable` extension. |
| `src/apps/bench/remote/full.ts` | +8 | `createFullRemoteBackend` family plumbing. |
| `src/apps/bench/remote/pool.ts` | +9 | `assertPoolChunksLaunchable` guard. |
| `src/apps/bench/run-main.ts` | +51 | typed run-config threading; `runMain` explicitly refuses terminal (`"runMain is the swe-bench composition root; terminal-bench routes elsewhere"`). |
| `src/runner/batch/corpus/dataset.ts` | +62 | `normalizeProRow` + `checkoutOrDeepen` / `prepareTaskRepo` clone-depth rework. |
| `src/runner/batch/corpus/index.ts` | +8 | barrel re-exports for `paths`. |
| `src/runner/batch/corpus/paths.ts` | +7 | new header + `benchWorkRoot` siblings. |
| `src/runner/batch/eval/driver/config-build.ts` | +12 | `localEnvSlotOf` + bench-registry change. |
| `src/runner/batch/eval/driver/config-build-prompt-pack.test.ts` | +19 | A2 promptPack assertions. |
| `src/runner/batch/report.ts` | +15 | `emitLocalize` extension + `BenchReportMeta` fields (BFND-02 envelope prep). |
| `tests/integration/swebench-dataset.test.ts` | +80 | new dataset cases. |
| `tests/unit/apps/bench/batch-report-schema-parity.test.ts` | +41 | envelope parity cases. |
| `tests/unit/bench-paths.test.ts` | +10 | paths cases. |
| `tests/unit/src-no-sketchy-code.test.ts` | −2 | ratchet allowlist entries removed. |

### 3.2 Untracked / new (17)

```
docs/plans/aug-21-bench-foundation/freeze/snapshot-9d5369d31.txt
src/apps/bench/benchmark-suite.ts            src/apps/bench/benchmark-suite.test.ts
src/apps/bench/run-config.ts                 src/apps/bench/run-config.test.ts
src/apps/bench/profiles/types.ts             src/apps/bench/profiles/registry.ts
src/apps/bench/profiles/registry.test.ts
src/apps/bench/promax/provenance/{digest,frozen-snapshot,selector,types}.ts
src/runner/batch/report-envelope.ts          src/runner/batch/report-terminal.ts
tests/unit/apps/bench/canonical-report-envelope.test.ts
tests/unit/apps/bench/promax/promax-v1-ids.ts
tests/unit/dataset-family-profile-ssot.test.ts
```

### 3.3 Classification and the non-collision invariant

Every path in §3.1 + §3.2 is **in-flight foundation work owned by a concurrent agent**
(BFND-01 suite/config, BFND-02 report envelope, jun-30 T2 run-config, jun-30 T4 family
profiles, ProMax provenance). It is **not** user state and **not** TB2.0 debt.

**Invariant checked:** the dirty set ∩ the TB2.0 retirement set (§ retirement manifest)
is **empty**. No dirty path lives under `adapters/`, `tools/tb-smoke/`,
`tools/leaderboard-dashboard/`, `src/apps/terminal/`, `script/bench-smoke/`,
`docs/rfc/`, or `docs/plans/jul-2-terminal-bench-levers/`. TB21-00 therefore neither
reads-for-edit nor blocks on any of it, and TB21-01+ can proceed on TB surfaces without
colliding with the foundation build.

## 4. Toolchain

| Tool | Version / status |
|---|---|
| bun | `1.3.14` |
| python3 | `3.9.6` |
| uv | `0.11.8` (aarch64-apple-darwin) |
| docker (client) | `28.5.1`, build `e180ab8` |
| **docker daemon** | **READY** — `docker info` → server `28.5.1`, Docker Desktop |
| **harbor** | **NOT ON `PATH`** — `command -v harbor` empty |

Delta vs the plan's authoring snapshot: the Docker daemon is now **ready** (was "not
ready"); `harbor` is still absent. `harbor` absence is expected and is TB21-01's job —
`adapters/terminal-bench/pyproject.toml` deliberately keeps harbor as an unresolvable
optional VCS extra (see retirement manifest AP-2).

## 5. Active TB report roots and filenames on disk

Dashboard `REPORT_ROOTS` (`tools/leaderboard-dashboard/server.ts:50-63`), in priority order:

1. `$QUANTA_BENCH_RESULTS_DIR` if set and `!== "off"`, else `~/.quanta/bench/results` ← **canonical SSOT sink**
2. `~/reprovote-ab`
3. `~/easy-more`
4. `~/Library/quanta-codeagent-v3/bench`
5. `~/Library/quanta-codeagent-v3/bench-slices`
6. any `--reports <dir>` argv

Competitor matrix root: `tools/leaderboard-dashboard/rawdata/`, TB file selected by
`--tb-matrix` else `rawdata/tb-pertask.md` (`server.ts:71`).

**TB2.0 report files found in root 1:**

| File | Size | mtime | `datasetFamily` | `schemaVersion` | `benchmarkSuite` | perInstance | passed | `knobs.preset` |
|---|---|---|---|---|---|---:|---:|---|
| `report-terminal-bench-baseline.report.json` | 10K | Jul 3 01:55 | `terminal-bench` | **absent** | **absent** | 88 | 48 | `TB baseline (knob-off)` |
| `report-terminal-bench-levers.report.json` | 4.9K | Jul 3 02:29 | `terminal-bench` | **absent** | **absent** | 42 | 17 | `TB +levers (env-owned·maxTurns·verify-gate)` |

Both are **versionless legacy** by the backlog's identity rule (no `schemaVersion` /
`benchmarkSuite` / `benchmarkVersion` / `datasetRef`) and both use the invalid
`datasetFamily: "terminal-bench"` axis. They are the *only* two non-`tmp__`
`report-*.report.json` files in the whole root.

Report-root inventory: `~/.quanta/bench/results` holds **3961** files (**59M**), of
which **3680** are `tmp__*` test scratch and **2** are the named TB reports above.

## 6. Baseline-proof sweep counts

### 6.1 `rg` sweep (ticket pattern) over `adapters src tools docs package.json`

Total: **70 matching lines across 29 files.**

| Sub-pattern | files | lines |
|---|---:|---:|
| `terminal-bench-2([^0-9-]\|$)` | 8 | 10 |
| `Terminal-Bench 2\.0` | 10 | 11 |
| `TB2\.0` | 10 | 27 |
| `--agent-import-path` | 6 | 9 |
| `QUANTA_TB_BEST_OF_N` | 9 | 16 |

Non-doc (code/script) hits only: `adapters/terminal-bench/README.md` (6),
`src/apps/terminal/best-of-n-runner.ts` (4), `src/apps/terminal/brain-mode.ts` (3),
`src/config/knob-inventory/extra.ts` (1), `src/tool/terminal-capability-guide.ts` (1),
`tools/leaderboard-dashboard/rawdata/tb-pertask.md` (1),
`tools/tb-smoke/run-tb-smoke.sh` (1), `tools/tb-smoke/run-selftest-ab.sh` (1).

> **Symbol-identity note.** Ripgrep output in this environment is subject to display
> redaction that renders some identifiers as the literal string `ln` (e.g. `tb-pertask`
> rendered as `n`). Every load-bearing identifier in these manifests was re-read from
> real file bytes via `python3` before being recorded. Confirmed real names:
> `QUANTA_TB_BEST_OF_N`, `parseTbPertask`, `TB_PERTASK_MD`, `rawdata/tb-pertask.md`.

### 6.2 Broader sweep — surfaces the ticket pattern misses

The ticket's `rg` pattern does **not** cover `datasetFamily === "terminal-bench"`,
`tools/tb-smoke/**` bodies, or anything under `script/`. A case-insensitive sweep for
`terminal-bench|terminalbench|QUANTA_TB_|tb-raw|harbor run` over the whole repo
(excluding `node_modules`, `.git`, `.extracted_source`, `__pycache__`, `.pytest_cache`)
returns **118 files**. Of those, **37** are under `src|tools|adapters|package.json`.

**Two consumers outside the ticket's Required-inventory scope were discovered** and are
recorded in the retirement manifest under the ticket's Stop rule:

- `script/bench-smoke/smoke-terminal-bench-ver-jul-5.sh` (104 lines) — a third TB2.0
  smoke driver, box-side, drives the full lever stack + optional `QUANTA_TB_BEST_OF_N`.
- `tools/leaderboard-dashboard/tb-report-emit.test.ts` (238 lines) — the emitter's test,
  not named in the ticket.

Plus test-side lever consumers (`tests/unit/agent/prompt-env-posture.test.ts`,
`tests/unit/agent/prompt-rules/owned-rules.test.ts`,
`tests/unit/tool-surface-manifest-hellgate.test.ts`,
`tests/unit/_arch/slice-boundary-configs.ts`, `tests/unit/src-no-sketchy-code.test.ts`),
all classified in the retirement manifest.

### 6.3 `find` counts — local external run artifacts

| Command | Result |
|---|---|
| `find ~/.quanta/bench -maxdepth 4 \( -iname '*terminal-bench*' -o -iname '*tb*' \)` | **32 paths** — but **29 are false positives** (`-iname '*tb*'` matching random `tmp__bench-*` scratch suffixes such as `…-8RTBah`). **True TB paths: 3** — `~/.quanta/bench/tb-raw`, and the two `report-terminal-bench-{baseline,levers}.report.json`. |
| `find ~/.quanta/bench/tb-raw -print` (uncapped) | **1069 entries**, **1.6M**, **6 job dirs** under `full89/` (5) + `failset-levers/` (1) |
| `find ~/tb-results -maxdepth 3 -print` | **114 paths** |
| `find ~/tb-results -print` (uncapped) | **294 entries**, **1.8M** — `full89/` **9 job dirs**, `full89-brain-logs/` **52 files** |

No secrets, credentials, or environment dumps are reproduced in this snapshot.

## 7. Exact BFND / T2 / T4 foundation state (DoD: record it, do not assume it landed)

| Packet | Canonical artifact | State at `9d5369d31` |
|---|---|---|
| BFND-01 suite/config | `src/apps/bench/benchmark-suite.ts` (+`.test.ts`) | **UNTRACKED / uncommitted, in flight.** Not at HEAD. `BenchmarkSuite = "swe-bench" \| "terminal-bench"`, `TerminalBenchRunConfig` (family-less) present in the working tree only. `cli.ts` `case "terminal"` is a resolve-and-log stub that explicitly says execution is not wired. |
| BFND-02 report envelope | `src/runner/batch/report-envelope.ts`, `src/runner/batch/report-terminal.ts` | **UNTRACKED / uncommitted, in flight** (both created *during* this snapshot pass). Declares `CanonicalBenchReport = SweBenchReport \| TerminalBenchReport`, `TERMINAL_BENCH_VERSION = "2.1"`, `TERMINAL_ONLY_KEYS = ["datasetRef","benchmarkVersion"]` with a presence-without-identity refusal. |
| BFND-03 dashboard projectors | `tools/leaderboard-dashboard/projectors/` | **DOES NOT EXIST.** Not started. The ticket-order proof command `bun test tools/leaderboard-dashboard/projectors/terminal-bench.test.ts` cannot run yet. |
| jun-30 T2 typed run-config | `src/apps/bench/run-config.ts` (+`.test.ts`) | **UNTRACKED / uncommitted, in flight.** `DATASET_FAMILIES = ["verified","live","pro"]` — SWE-only, fail-closed on explicit-unknown. |
| jun-30 T4 family profiles | `src/apps/bench/profiles/{types,registry}.ts` (+`registry.test.ts`) | **UNTRACKED / uncommitted, in flight.** `DatasetFamilyProfile` = one port for corpus-parse / grade-harness / remote-env / preflight. |
| ProMax provenance | `src/apps/bench/promax/provenance/*.ts` | **UNTRACKED / uncommitted, in flight.** Separate packet; not a Terminal prerequisite. |

**Gate consequence.** TB21-00A depends on BFND-01, TB21-04 on BFND-02, TB21-05 on
BFND-03. **None of the three is committed.** BFND-03 is not even started. TB21-00A must
not start until BFND-01 lands as a commit — a dirty overlay is not a landed gate
(backlog: *"A green dirty-overlay run is not a committed-current-SHA receipt"*).

## 8. TB2.0 facts re-verified from real file bytes at this SHA

| Fact | Evidence |
|---|---|
| Harbor dependency is a floating VCS `main` ref | `adapters/terminal-bench/pyproject.toml` `[project.optional-dependencies].harbor = ["harbor @ git+https://github.com/harbor-framework/harbor.git"]`, self-described as "the placeholder". Violates the backlog's pin rule. |
| Agent version is `None` | `adapters/terminal-bench/quanta_agent.py:241-243` — `@staticmethod def version() -> "str \| None": return None`. Harbor receipts carry no agent provenance. TB21-02's target. |
| Dataset shorthand is the retired one | `tools/tb-smoke/run-tb-smoke.sh:32` and `run-selftest-ab.sh:24` both `harbor run -d terminal-bench … --agent-import-path quanta_agent:QuantaAgent -m gpt-5.5 -n 8`. |
| Emitter folds trials to one any-pass row | `tools/leaderboard-dashboard/tb-report-emit.ts:97-138` — *"Dedups to ONE verdict per task (any-pass wins…)"*; writes `report-terminal-bench-${tag}.report.json` into `~/.quanta/bench/results` (`:244-268`). |
| Dashboard treats TB as a 4th `datasetFamily` | `server.ts` — 13 `terminal-bench` sites: `:407` filename sniff, `:860` skip, `:936` label map, `:940` `order = ["verified","pro","live","terminal-bench"]`, `:1283` `.fam-terminal-bench` CSS, `:1434`/`:1695`/`:2122` `BENCH === "terminal-bench"` branches, `:1619` any-pass fold. File is **2368 lines** (god-module). |
| `QUANTA_TB_BEST_OF_N` is runtime-dead | `runTerminalBrainBestOfN` has **zero** production callers — the only non-definition references are its own `best-of-n-runner.test.ts` and the knob-inventory `readSite` string. |
| Competitor rawdata is duplicated byte-for-byte | `docs/analysis/terminal-bench-pertask.md` and `tools/leaderboard-dashboard/rawdata/tb-pertask.md` are **identical** (md5 `1d6f3a409a4b7c523c1c6a27b6f9f89c`), both TB2.0 (`harborframework/terminal-bench-2-leaderboard`). |

## 9. Commands actually run (all read-only)

`git rev-parse` · `git status` · `git diff --stat/--name-only/--shortstat/--unified=0` ·
`git log -1` · `git merge-base --is-ancestor` · `git ls-files` · `git cat-file -e` ·
`git show HEAD:<path>` · `rg` · `grep` · `find` · `ls` · `wc` · `du` · `head` ·
`diff -q` · `md5` · `python3` (read-only file parsing) · `bun --version` ·
`python3 --version` · `uv --version` · `docker --version` · `docker info` ·
`command -v harbor` · `date`.

**No `rm`, `mv`, `mkdir` outside this packet, `git add`, `git commit`, `git push`,
`git stash`, `git checkout --`, or `git reset` was executed.**
