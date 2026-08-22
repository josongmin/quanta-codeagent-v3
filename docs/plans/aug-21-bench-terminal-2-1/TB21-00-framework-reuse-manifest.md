# TB21-00 — framework-reuse manifest

**Ticket:** [TB21-00](./tickets/TB21-00-main-snapshot-and-retirement-manifest.md)
**Snapshot:** [TB21-00 execution snapshot](./TB21-00-execution-snapshot.md) @ `9d5369d31`
**Companion:** [TB21-00 retirement manifest](./TB21-00-retirement-manifest.md)

Purpose: prove that Terminal-Bench 2.1 is a **branch of the existing bench framework**,
not a second framework. Backlog rule: *"Do not create a `tools/terminal-bench` execution
framework."* Every existing bench owner below carries exactly one disposition.

## Disposition vocabulary

| Disposition | Meaning |
|---|---|
| `reuse` | Consumed **unchanged** by the Terminal branch. Terminal adds no copy, no fork, no parallel implementation. |
| `extend` | Gains a Terminal branch/registration **at its existing seam**. The owner stays canonical; Terminal does not take ownership. |
| `out-of-scope` | SWE-only or otherwise unrelated. Terminal must neither widen it nor remove it. |

⚠️ **Gate reality (snapshot §7).** BFND-01, BFND-02 and jun-30 T2/T4 exist only as
**uncommitted working-tree files** owned by a concurrent agent; BFND-03 **does not exist
at all**. Every `extend` row below targets a seam that is not yet landed. Rows are
written against the seam's intended contract, and TB21-00A/04/05 must re-verify the seam
against the **committed** SHA before consuming it.

---

## 1. Shared BFND-01 suite/config and the unified CLI

| # | Owner | State | Disposition | Terminal's obligation |
|---|---|---|---|---|
| RU-1 | `src/apps/bench/benchmark-suite.ts` — `BenchmarkSuite = "swe-bench" \| "terminal-bench"`, `BENCHMARK_SUITES`, `TerminalBenchRunConfig` (family-less), `resolveBenchmarkRunConfig` | untracked / in flight | `reuse` | Terminal **imports** the discriminator; it must never redeclare `BenchmarkSuite` or re-derive suite identity. `TerminalBenchRunConfig` already exists in the working tree carrying **no** `datasetFamily` — that is the contract to hold. |
| RU-2 | `src/apps/bench/cli.ts` — the unified `quanta-bench` composition root, `KNOWN_SUBCOMMANDS`, `case "terminal"` (`:124-141`) | modified / in flight | `extend` | TB21-00A replaces the "not yet wired" log with a `commands/terminal.ts` registration. **All paid commands enter here** (backlog DoD). No second entry point, no `tools/terminal-bench` runner. `package.json` may add only a thin alias to `quanta-bench terminal …`. |
| RU-3 | `src/apps/bench/run-main.ts` — the SWE composition root | modified / in flight | `out-of-scope` | Already fenced: `:973` throws *"runMain is the swe-bench composition root; terminal-bench routes elsewhere"*. Terminal must **not** be routed through it and must not widen it. |
| RU-4 | `src/apps/bench/{index,entry-bootstrap,run-args,run-main-helpers,dry-run,model-lanes,lane-progress-renderer,host-resource-sampler}.ts` | committed | `out-of-scope` | SWE local/pool run plumbing. Terminal's execution is Harbor-driven; none of this is shared. Listed so no row is silently missing. |
| RU-5 | `src/apps/bench/{observe,otel,otel-trace-sink,default-trace-sink,span-sink,trajectory,trajectory-debug-sink,reasoning-summary}.ts` | committed | `reuse` | Observability/trajectory sinks are suite-agnostic. TB21-02's ATIF trajectory work should feed these rather than build a Terminal-only sink. |

## 2. SWE-only `DatasetFamily` and the T4 `DatasetFamilyProfile` internals

| # | Owner | State | Disposition | Terminal's obligation |
|---|---|---|---|---|
| RU-6a | `src/apps/bench/dataset-family.ts` — `DatasetFamily`, `resolveDatasetFamily`, `parseTasksForFamily`, `gradeEvaluatorForFamily`, `bridgeDatasetFamilyToEnv` | modified / in flight | `out-of-scope` (**never widened**) | Backlog: *"`DatasetFamily` remains internal to `swe-bench`"* and *"`datasetFamily: "terminal-bench"` is invalid. Do not widen SWE parsing/grading branches to accommodate Terminal-Bench."* Terminal reports carry **no** `datasetFamily` field at all. `DatasetFamily` may independently gain `promax` — that is not Terminal's concern. |
| RU-6b | `src/apps/bench/run-config.ts` (jun-30 T2) — `BenchRunConfig`, `DATASET_FAMILIES = ["verified","live","pro"]`, fail-closed on explicit-unknown, `serializeFamilyForSubprocess` | untracked / in flight | `out-of-scope` | SWE-only family resolution. The `terminal` subcommand must **refuse** a `--dataset-family` selector (RU-2 already does), not thread one. |
| RU-6c | `src/apps/bench/profiles/{types,registry}.ts` (jun-30 T4) — `DatasetFamilyProfile` (corpus-parse / grade-harness / remote-env / preflight), `DATASET_FAMILY_PROFILES` | untracked / in flight | `out-of-scope` | Backlog: *"Jun-30 T4 is not a Terminal prerequisite. It remains an internal SWE family registry concern used by ProMax."* Terminal must not register a profile here — its analogue is the **suite** branch (RU-1), not a family profile. |
| RU-6d | `src/apps/bench/{pro-swebench,python-swebench,pro-measure}.ts`, `src/apps/bench/remote/**`, `src/runner/batch/corpus/**`, `src/runner/batch/eval/**` | mixed | `out-of-scope` | SWE grading harnesses, EC2/full-remote lifecycle, corpus ingest, repro/eval driver. Terminal runs under Harbor in Docker; none of it is shared. |

## 3. Existing knob inventory and runtime resolution

| # | Owner | State | Disposition | Terminal's obligation |
|---|---|---|---|---|
| RU-7 | `src/config/knob-inventory/{extra,bench,host,runner,daemon,mention,const-keyed,types}.ts`, `src/config/knob-inventory.ts`, `src/config/knob-catalog.ts`, `src/config/knob-schema/**`, `src/config/{loader,merge,index}.ts` (`runtimeConfig`) | committed | `reuse` (**value authority**) | Backlog: *"The existing knob inventory/runtime resolver remains the value authority. A Terminal profile selects and records resolved values; it does not add a second ambient-env parser."* The TB21-03 Terminal profile/manifest **reads resolved values and records them**; it must not `process.env`-parse on its own. |
| RU-7a | The **8 retained** terminal-brain knobs in `knob-inventory/extra.ts`: `QUANTA_TB_ENV_OWNED`, `QUANTA_TB_VERIFY_GATE`, `QUANTA_TB_SELF_TEST`, `QUANTA_TB_ORACLE_LOOP`, `QUANTA_TB_OUTPUT_CONTRACT`, `QUANTA_TB_WRITE_TOOL`, `QUANTA_TB_STREAM_CAP`, `QUANTA_TB_TRAJECTORY` | committed | `reuse` | Brain-behavior levers, **not** TB2.0 dataset/scoring authority. 2.1 measures them; it does not retire them. Their resolved values become required report fields (backlog: *"Every report carries … profile …"*). Cross-ref retirement manifest **SR-12**. |
| RU-7b | `QUANTA_TB_BEST_OF_N` (9th entry, `extra.ts:683-692`) | committed | **retired** — see retirement **SR-6** | The single knob-inventory entry that is deleted, not reused. Recorded here so the inventory's completeness is auditable from either manifest. |
| RU-7c | `QUANTA_TB_AGENT_VERSION`, `QUANTA_TB_BRAIN_TRACE` | **referenced in docs only, zero code sites** | `out-of-scope` (today) | Neither appears in any `.ts`/`.py`/`.sh`. `QUANTA_TB_AGENT_VERSION` is a *name TB21-02 may claim* for AP-4's version plumbing — flagged, not assumed. `QUANTA_TB_BRAIN_LOG_DIR` exists in code but **not** in the inventory (retirement SR-13): TB21-03 should bring it under RU-7 rather than leave it an ad-hoc export. |

## 4. Shared BFND-02 report envelope, writer, and canonical mirror

| # | Owner | State | Disposition | Terminal's obligation |
|---|---|---|---|---|
| RU-8a | `src/runner/batch/report-envelope.ts` — `CanonicalBenchReport = SweBenchReport \| TerminalBenchReport`, `BenchReportSuite`, `TerminalTrialReceipt`, `TERMINAL_BENCH_VERSION = "2.1"`, `TERMINAL_ONLY_KEYS = ["datasetRef","benchmarkVersion"]` with presence-without-identity refusal | untracked / in flight | `extend` | The union is the canonical envelope. Terminal passes a **typed branch** to it (backlog table: *"typed Terminal branch passed to the canonical writer"*). Terminal must not define a second report type. The `TERMINAL_ONLY_KEYS` refusal is what enforces "no compatibility parser guesses legacy reports are 2.1". |
| RU-8b | `src/runner/batch/report-terminal.ts` | untracked / in flight | `extend` | The Terminal branch of the envelope; TB21-04's target. Must live here, not under a Terminal-owned tree. |
| RU-8c | `src/runner/batch/report.ts` — `BenchReportMeta`, `emitLocalize`, the SWE report writer, `mirrorReportToSsot` | modified / in flight | `reuse` | The **canonical writer + result mirror**. Backlog DoD: *"Terminal reports use the existing canonical report writer and result mirror."* Terminal must not write report files itself — which is precisely why retirement **DB-1** (`tb-report-emit.ts`, a dashboard-tree tool that wrote into the SSOT sink) is deleted rather than ported. Note `report.ts:78` also holds the SWE-local `DatasetFamily` union — Terminal does not touch it (RU-6a). |
| RU-8d | `src/apps/bench/{report,run-report}.ts` | committed | `reuse` | Report shaping/printing on top of RU-8c. Suite-agnostic; consumed, not forked. |
| RU-8e | `src/apps/bench/preset.ts` (`seedBenchExecutionPreset`) | committed | `reuse` | Preset seeding is the recorded-knobs mechanism the reports carry. Terminal records its profile through it rather than inventing a `knobs.preset` free-text convention — the 2.0 reports' `knobs.preset: "TB baseline (knob-off)"` free-text is exactly what made DB-4's `arm`-split parse preset **strings**. |
| RU-8f | `mirrorReportToSsot` consumers: `src/apps/bench/remote/box-session.ts`, `tools/leaderboard-dashboard/leaderboard-sync.ts` | committed | `reuse` | The mirror path into `~/.quanta/bench/results`. Terminal 2.1 reports land through it, which is what makes the dashboard pick them up without a Terminal-specific ingest. |

## 5. Shared BFND-03 dashboard shell and suite-projector registry

| # | Owner | State | Disposition | Terminal's obligation |
|---|---|---|---|---|
| RU-9a | `tools/leaderboard-dashboard/projectors/` + `server.test.ts`-visible projector registry | **DOES NOT EXIST** | `extend` (**blocked**) | BFND-03 is not started. TB21-05 registers `projectors/terminal-bench.ts` (+`.test.ts`). Until BFND-03 lands, TB21-05 cannot begin — and the backlog's proof-ladder command `bun test tools/leaderboard-dashboard/projectors/terminal-bench.test.ts` names a path that does not exist. |
| RU-9b | `tools/leaderboard-dashboard/server.ts` — `REPORT_ROOTS`, `parseRuns`, `groupRuns`, `Run`/`Campaign` shell, tab/render skeleton (2368 L) | committed | `extend` | The **shell** is reused. The 13 raw `datasetFamily === "terminal-bench"` sites inside it are `replace`d by the projector (retirement DB-4). Backlog: *"Dashboard code may import/parse/project canonical reports but may not launch Harbor, resolve runtime knobs, emit reports, or own scoring formulas."* |
| RU-9c | `tools/leaderboard-dashboard/family-partition.ts` (+ `.test.ts`) — `campaignKeyOf` RFC-jun-29-R4 partition | committed | `out-of-scope` | SWE dataset-family campaign partition. Terminal partitions by **suite**, not family; it must not be added as a fourth family here. |
| RU-9d | `tools/leaderboard-dashboard/{external-baselines,external-comparison}.ts` | committed | `reuse` (if a 2.1 competitor baseline exists) | External SOTA ingestion/comparison. If a 2.1 leaderboard baseline is available it enters here — **not** through a hand-maintained markdown matrix like retirement CR-1. |
| RU-9e | `tools/leaderboard-dashboard/{bench-actions,bench-control,bench-request}.ts` | committed | `out-of-scope` | The SWE bench management/control console (spawns EC2 boxes). Terminal must **not** gain a launch button here — the backlog forbids the dashboard launching Harbor. |
| RU-9f | `tools/leaderboard-dashboard/tb-pertask.ts` (`parseTbPertask`) | committed | `extend` → then folded into RU-9a | The parsing capability moves into the Terminal projector. Cross-ref retirement DB-3. |

## 6. The generic `src/apps/bench` Best-of-N sampler — explicitly NOT Terminal sampling

| # | Owner | State | Disposition | Why it is protected |
|---|---|---|---|---|
| RU-10 | **`src/apps/bench/sampler.ts`** — the generic Best-of-N sampler, generic over a `T` attempt payload (`makeAttempt`/`score`), specialised by the bench CLI to `InstanceResult`; surfaced via `src/apps/bench/dry-run.ts:96` (`best-of-n: ${plan.n}`) and `src/apps/bench/index.ts` | committed | `out-of-scope` — **DO NOT REMOVE** | Backlog: *"The generic SWE-bench sampler under `src/apps/bench` is out of scope."* This is **SWE sampling** (N independent agent trajectories over one SWE instance). It is a **different module in a different slice** from the Terminal best-of-N being retired (`src/apps/terminal/best-of-n{,-runner}.ts`, retirement SR-1..SR-4). A grep for `best-of-n` hits both; only the `src/apps/terminal/**` pair dies. |
| RU-10a | `tools/feature-catalog/features/10-app/bench-best-of-n-sampler.yaml` and the 4 features that `depends_on: [… bench-best-of-n-sampler …]` (`04-llm-0.yaml`, `05-quantabenchtimeoutms.yaml`, `07-resilience/swebench-smoke-baseline.yaml`, `08-observability/{runtime-config-ssot,01-src-shared-logger-ts}.yaml`), plus `tools/pm/baseline.json:39` | committed | `out-of-scope` — **DO NOT REMOVE** | Feature-catalog entries for RU-10. Removing them because a sweep matched "best-of-n" would break 5 `depends_on` edges and the pm baseline. Recorded as a tripwire. |

## 7. Terminal-side owners kept (not framework, but must not be swept)

| # | Owner | State | Disposition | Why |
|---|---|---|---|---|
| RU-11 | `src/apps/terminal/{index,brain-mode,verify-gate}.ts` + tests — the `terminal` ToolSurface composition root and brain | committed | `reuse` / `extend` | Backlog ownership table: *terminal agent/brain → `src/apps/terminal/*`*. The brain stays **one clean attempt** (Harbor owns trials via `-k`). Only the best-of-N wrapper and the `bestOfN` report field are removed (retirement SR-1..SR-5). |
| RU-12 | `src/tool/{terminal-surface.test.ts, terminal-capability-guide.ts, container-exec/**, pty/docker-exec-tmux.ts, surface/gated-tools.ts, default-tool-ports.ts}` | committed | `reuse` | The `terminal` ToolSurface and `container_exec` machinery. Version-agnostic. `terminal-surface.test.ts:97-104` enforces the ownership-boundary rule (no `TerminalBench|Harbor|BaseAgent` naming outside `src/apps/` + `adapters/`) — a **live guard** that the 2.1 packet must keep satisfied. |
| RU-13 | `adapters/terminal-bench/quanta_terminal_bridge/**` + `protocol-golden.json` + `src/tool/container-exec/golden-parity.test.ts` | committed | `reuse` | Stdlib-only cross-language bridge with a golden-parity pin. Cross-ref retirement AP-6/AP-8. |
| RU-14 | `src/agent/converge/{self-test,exercise}.ts`, `src/agent/prompt-rules/verify-strategy.ts`, `src/agent/surface-profile*.ts` | committed | `reuse` | The machinery behind the retained lever knobs (RU-7a). Suite-agnostic agent behavior. |

## 8. RED-rail self-check

| Rail | Result |
|---|---|
| Every owner named in the ticket's Deliverable 3 has a disposition | **PASS** — shared BFND-01 suite/config + `cli.ts` → RU-1, RU-2; SWE-only `DatasetFamily` + T4 `DatasetFamilyProfile` internals → RU-6a..RU-6c; existing knob inventory / runtime resolution → RU-7, RU-7a..RU-7c; BFND-02 envelope + writer + canonical mirror → RU-8a..RU-8f; BFND-03 dashboard shell + suite-projector registry → RU-9a, RU-9b; generic `src/apps/bench` Best-of-N sampler (**not** Terminal sampling, **not** removed) → RU-10, RU-10a. |
| The ticket's `src/apps/bench/{cli,dataset-family,preset,report}.ts` + `src/runner/batch/report.ts` are classified `reuse/extend`, not replacement | **PASS** — `cli.ts` RU-2 `extend`; `dataset-family.ts` RU-6a `out-of-scope`/never-widened (the correct non-replacement outcome — widening it is what the backlog forbids); `preset.ts` RU-8e `reuse`; `src/apps/bench/report.ts` RU-8d `reuse`; `src/runner/batch/report.ts` RU-8c `reuse`. |
| No existing bench owner lacks a `reuse` / `extend` / `out-of-scope` disposition | **PASS** — 28 rows covering every `src/apps/bench` module, the `src/runner/batch` report layer, the full `src/config` knob stack, all 10 dashboard modules, and the terminal-side owners. |
| No second framework is planned implicitly | **PASS** — zero `extend` rows create a new execution root. `tools/terminal-bench` does not appear anywhere. Terminal's only new files are `commands/terminal.ts` + `src/apps/bench/terminal/*` + `projectors/terminal-bench.ts`, each a registration at an existing seam. |

## 9. Items this manifest could NOT fully resolve

| Item | Why | Owner |
|---|---|---|
| RU-9a — the projector registry's actual API | BFND-03 has produced **no files**. The disposition (`extend`) is firm; the shape is unknowable. TB21-05 is **hard-blocked**, not merely sequenced. | BFND-03 |
| RU-1 / RU-8a / RU-8b — contracts read from **uncommitted** working-tree files | Snapshot §7: BFND-01 and BFND-02 are in-flight and were still being written during this pass (two envelope files appeared mid-snapshot). The contracts quoted here may change before landing. | TB21-00A / TB21-04 must re-verify against the committed SHA |
| RU-7c — whether `QUANTA_TB_AGENT_VERSION` is the intended name for TB21-02's version plumbing | The name exists only in prose; no code claims it. Flagged rather than assumed, per the no-inference rule. | TB21-02 |
