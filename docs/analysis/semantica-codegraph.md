# semantica-codegraph-v2 — Capability & Integration Analysis

> Analysis date: 2026-06-29. Target: `~/Documents/code-new/semantica-codegraph-v2`.
> Purpose: assess it as a code-intelligence / static-analysis backend (and possible
> coding-agent runtime) for quanta-codeagent-v3's SWE-bench work (incl. SWE-bench Pro,
> which is multi-language).
>
> **Evidence discipline:** facts below are tagged `[verified]` (I read the primary
> source — file:line), `[sampled]` (sub-agent read a sample; directionally solid,
> not exhaustive), or `[unmeasured]` (no committed number found). Several earlier
> conclusions in this analysis were wrong because I trusted a proxy (catalog labels,
> git span, a buggy `wc` command, sub-agent summaries) instead of primary source —
> see "Methodology / caveats" at the bottom.

## TL;DR

semantica-codegraph-v2 is **not** a search index or a small project. It is a
**multi-language static-analysis + code-graph platform with a production MCP
coding-agent runtime layered on top** — roughly the union of {CodeQL-class dataflow/
taint} + {Infer-class separation logic} + {dedicated points-to engines} + {abstract
interpretation / SMT} + {rust-analyzer-class IDE/incremental} + {a coding-agent
apply/verify/rollback runtime}. Built (visible git window) by an AI-agent fleet at
very high throughput.

- **Scale `[verified]`:** ~5.42M lines Rust / 13,762 files / **416 crates**; +0.55M Python tooling, +0.63M markdown docs (3,953 files). ~6.3M lines of code, ~9M total.
- **Languages `[verified]`:** Python / Java / TypeScript / JavaScript = full-depth ("Golden"-tier); Rust = mostly full; Go / C / Kotlin = partial / public-claim-blocked; C++ = unsupported.
- **Pure static core** does not execute code — but the **codeagent-runtime-v2 layer DOES** (RunTests / Bash / verify_patch), exposed over **MCP**.
- **Measured quality:** OWASP Java taint **P=1.0 / R=0.47, FPR=0** (jun-17, smoke N=34) `[verified]`; clone detection best detectors **F1≈0.88–0.91, P≈1.0** (4000-sample confusion matrices) `[verified]`. Real-world precision at full-corpus scale = **`[unmeasured]`**.
- **Honest score (all-in, real-world analytical value): ~83/100.** Exceptional engineering artifact (90+ on ambition × realness × discipline) discounted for unmeasured full-corpus precision/recall. Band 80–89 depending on a full-corpus run.

## What it is

A daemon-served program-analysis platform. Thin CLI → server daemon → heavy runtime →
core analysis engines. Two front-ends over one engine:
- **FluentSDK v3** (`Code::from_dir()`, `.ide()`, `.analysis()`, `.code_agent()`) — in-process Rust SDK `[verified]`.
- **GQLang** — a "universal program-analysis DSL" (CodeQL-QL analog), canonical query ingress, GA on a bounded IDE slice (~50–70% breadth) `[sampled]`.

## Capability inventory

### Capability atlas — 55 capabilities across 7 domains `[verified]` (catalog.yaml)

| Domain | Count | Notable capabilities |
|---|---|---|
| **Analysis** | 22 | points-to (PTA), call graph, cost analysis, abstract interpretation, control/data flow, effect, program dependence (PDG), import graph, incremental, dead code, clone, concurrency, spec mining, escape, typestate, symbolic execution, symbol resolution |
| **Navigation** | 6 | go-to-definition, find-references, hover, document/workspace symbols |
| **Refactoring** | 3 | rename, code actions, editing assist |
| **Search** | 9 | lexical, semantic, hybrid, **structural (AST)**, dataflow-query, call-graph search, graph-based ranking, behavior diff |
| **Security** | 4 | taint flow, vulnerability scan, source/sink detection, SARIF report |
| **Reasoning** | 8 | dependency reasoning, function summary, framework model repo, cross-module reasoning, whole-repo reachability, **change-impact analysis**, explain, proof analysis |
| **System** | 3 | query DSL (GQLang), planner/policy, proof/evidence platform |

The `Reasoning` domain (change-impact, whole-repo-reachability, behavior-diff) and
`Analysis` dataflow/taint are the most directly SWE-bench-relevant (symptom→cause
localization, "what does this patch affect").

### Analysis engines (90 catalog entries) `[sampled]`

Named classical algorithms actually implemented (not just specs):
- **Taint:** IFDS / IFDS-V2 / IDE / TabulatingIDE / BackwardIFDS / MemSSA; context- and path-sensitive; Z3-backed path conditions.
- **Points-to (PTA):** Andersen, Steensgaard, k-CFA, object-sensitive, delta-incremental, whole-program closure, counterexample mining.
- **Abstract interpretation:** interval / sign / constant / Galois / product domains.
- **SSA:** Braun, Cytron dominance-frontier; MemSSA.
- **Shape / heap:** Ghiya-Hendren, **biabduction (separation logic — Infer's core technique)**.
- **Concurrency race detection:** FastTrack, Eraser, hybrid, Tarjan deadlock, sleep-set POR, guided replay.
- **Cost / complexity:** Master theorem, Akra-Bazzi, Rustenholz, amortized, parametric, termination.
- **Clone detection:** MinHash, LSH, Winnowing, PDG-signature, semantic FP, Type-4.
- **Spec mining:** PrefixSpan, FSM, RPNI, **L\*** (automata learning).
- **SMT:** Z3 — arithmetic / string / SQL / lightweight theories.
- **SCA:** dependency graph (PURL), license/SPDX, SBOM (SPDX/CycloneDX), vuln matching.

Plus 122 adapters and 132 domain contracts.

### GQLang DSL `[sampled]`

Declarative query language over the code graph. Entity constructors, flow operators
(`-TaintReaches{policy}->`, `-Calls{depth:1..3}->`), predicates, EXISTS/subqueries,
GROUP/ORDER/aggregates, policy blocks. Costed planner (enumerate→select). Executable
end-to-end on a **bounded GA slice** (IDE vertical: definitions/references/calls/
calledBy + WHERE/ORDER/GROUP); broader universal-query breadth ~50–70%, recursion/
multi-hop fixpoint still partial.

### Coding-agent runtime — the integration-critical surface `[verified]`

This is the most important finding for codeagent-v3: semantica already ships a
**production coding-agent runtime**, not just a passive analysis library.

- **`codeagent-runtime-v2`** — machine-ingress runtime exposing **MCP** (stdio, JSON-RPC 2.0, protocol "2025-11-25"), HTTP (feature-gated), and CLI.
- **`Code::code_agent()` → `CodeAgentSelectorV1`** — in-process builder families: search, resolve, inspect, **mutation, rename, validate, review, rollback**.
- **`code_recovery`** — post-apply validation + rollback (PostApplyRollbackPort).

MCP `tools/call` surface (5 advertised tools): **PreviewFix, ApplyFix, RollbackFix, RunTests, Bash**.
Custom `cgr/*` methods (9 ops total): `query_quanta` (→ SearchCode / ExpandNeighbors / **TraceDataflow** / **FetchProof**), `preview_patch`, `apply_patch`, `rollback`, `verify_patch`, `create_checkpoint`, `resume_session`, `check_policy`.

**Implication:** codeagent-v3 can consume semantica as an **MCP tool server**
(`codeagent-runtime serve-mcp`, stdio Content-Length framing) — no new integration
seam required for the analysis/evidence side. The real decision is architectural:
who owns the agent loop (codeagent-v3 as MCP client vs semantica's own runtime).

> Correction to an earlier conclusion: I first called semantica "static-only, no
> execution → repro rail must be rebuilt." That was wrong. The agent-runtime layer
> has RunTests + Bash + verify_patch + rollback already.

### Production infrastructure `[sampled]`

- **Proof / evidence:** proof DAG builder + replay + validator, counterexample (CEX) graphs, provenance lineage, determinism oracle. (Proof compression = planned.)
- **Incremental:** IncrementalExecutor (fail-closed fallback), trace invalidation, cross-solver invalidation, SafePoint/GC. **Warm-root pool = RFC drafted, Go CLI not started** (biggest perf roadmap item).
- **Scale:** analysis budgeting (k-CFA degradation), symbol-hash sharding; proven ~1M–10M LOC, 10M–100M roadmap.
- **Output:** SARIF 2.1.0 (full typed response embedded).
- **Observability:** TelemetryPort, TraceRecorder, OTel (partial instrumentation).
- **Adjacent:** DevOS (agent+solver framework — **sunsetting**, superseded by codeagent-runtime-v2), IaC analysis, SQL Rule OS (code complete / acceptance pending), Memory Platform (extracted to sibling repo), Python SDK over unix socket.

## Language support truth table `[verified]`

SSOT: `packages/core/codegraph-language-capabilities/src/lib.rs`.

| Language | SSA/PTA/MemSSA | taint | semantic | public claim |
|---|---|---|---|---|
| Python | ✅ | Golden | Golden | allowed |
| Java | ✅ | Golden | Golden | allowed |
| TypeScript | ✅ | Golden | Golden | allowed |
| JavaScript | ✅ | Golden | Golden | allowed |
| Rust | ✅ | Supported | Supported | allowed (refinement unsupported) |
| **Go** | ❌ DfgReady only | **Partial** | FeatureGated | **blocked** |
| C | ❌ | Degraded | Partial | blocked |
| Kotlin | ❌ | Degraded | FeatureGated | blocked |
| C++ | ❌ (no parse) | — | — | blocked |

**SWE-bench Pro relevance:** Pro spans Python/Go/TS/JS. Python/TS/JS are full-depth;
**Go is the weakest lane** (DFG-level only, no PTA/SSA/taint depth). Localization
quality on Pro will be strong for Python/TS/JS, weak for Go.

## Measured quality

### Taint / security — OWASP BenchmarkJava `[verified]`

Source: `tools/ci/gates/gate-qm02-owasp-java-fp-ceiling.sh` (gate file last commit jun-17).

- **jun-17 baseline, smoke split N=34, 10 CWE families: FP=0, TN=17, precision=1.0, recall=0.4706, FPR=0.0 (overall + per-CWE).**
- Youden index (TPR − FPR) ≈ **0.47** — mid-pack vs the field (FindSecBugs-class ~0.4; commercial 0.2–0.6; best-tuned/CodeQL-class 0.5–0.7), but the **zero-FP profile is the rare/valuable end** (every alert real → trustworthy).
- Gate discipline is sophisticated: FP ceiling (≤0.05) **+ anti-gaming recall floor** (can't lower FP by suppressing TPs), per-CWE breakdown, **Joern comparison bridge**, disagreement triage. Java + Python both gated.

**Caveats:** N=34 is a **smoke canary**, not full OWASP (~2740 cases). The number is
**11 days old (jun-17)** and precision tickets opened jun-22/27 *after* it, so current
HEAD may differ. OWASP Benchmark is synthetic/simple → necessary not sufficient for
real-world precision. There is **no committed full-corpus number**.

> Two earlier claims of mine were wrong here: I said "precision measurement = 0" and
> later "OWASP in-progress / no number." Both false — the number exists and is
> respectable. Separately, a `taint-ifds.json` internal-oracle 31/31 I cited is
> **stale** (measured 2026-02-08, engine "dirty", frozen since the mar-13 fork) — retracted.

### Clone detection `[verified]`

Source: `tools/bench/accuracy/results/clone_benchmark_comprehensive.json`.

Per (clone-type × detector) over 4000-sample datasets with full TP/FN/FP/TN:
- Best detectors: **P≈1.00, F1≈0.88–0.91**.
- Baselines (e.g. ItemNormalization): P≈0.60, weaker.
- Hardest types: P≈0.31, F1≈0.22.

(Which detector is the flagship vs baseline needs label confirmation before quoting a single headline F1.)

### IDE / type-inference `[unmeasured here]`

Benchmark harness exists — `tools/bench/ide-surface/profiles/` has session-matrix
profiles incl. a **holdout** split (proper eval discipline). Type-inference has ~112
test files incl. exact e2e (e.g. `typescript_type_inference_exact_e2e_test.rs` asserts
exact `canonical_type_identity` on real `.ts` source through a real orchestrator
`[verified]`). Committed accuracy scores not yet read.

## E2E test-suite quality `[sampled, ~48 of 527+ e2e files]`

- Distribution ≈ STRONG 45–55% / MEDIUM ~35% / WEAK ~10–15% (WEAK ≈ honest negative pins, not silent stubs).
- **STRONG** tests use real source fixtures → real pipeline → specific behavioral assertions, often with paired negative controls ("must NOT fabricate"). Examples verified directly: `gate_malformed_input_fail_closed` hard-panics on fabricated flows (`assert_eq!(flows.len(), 0)`, `panic!` on NonEmptyFlows); type-inference asserts exact type identity.
- **MEDIUM** (esp. analysis-core: cost, SMT, concurrency) feed **synthetic IR** (hand-built CFG/DFG/events) to the real engine — engine-isolated, frontend→IR under-tested. e.g. `fasttrack_race_e2e_test` builds synthetic events (the named `.py` fixtures are only existence-checked); its docstring honestly declares the EventLogV1 input path.
- `ir_graph_semantic_soundness_e2e_test` checks **structure/reachability presence** (edge-kind present, BFS reachable, `phi.inputs.len() >= 2`), **not exact-set semantic correctness** — could drop flows and still pass.
- **Catalog honesty:** `closure_basis` / `claim_level` labels are **conservative catalog-proof-discipline, not test strength** — a hard exact-assertion test can be `inferred_label`. Do **not** read the label distribution as the count of strong tests (I made that error).

"All e2e green" therefore proves: **real working engines, fail-closed, deterministic,
honestly-declared gaps, exact where it counts (types/slices/locations)** — it does
**not** prove sound+precise on real-world-scale code (fixtures are small/inline; no
full-corpus precision/recall in the test suite).

## Honest assessment

Two axes, same 100-pt scale, weighted toward real-world analytical value:

- **Engineering artifact (ambition × realness × discipline): ~90+.** Breadth exceeds any single competitor (CodeQL has no PTA/abstract-interp/concurrency/IDE/agent-runtime; Infer is narrow; Semgrep is shallow). 6.3M real lines, strong tests where read, fail-closed honesty governance with no silent stubs. This is the upper tier of what exists.
- **Proven real-world soundness/precision: partial.** Precision (the hard half) is *demonstrated* — zero-FP on OWASP Java smoke, F1≈0.9 clone. Recall (0.47) and full-corpus scale are the open gaps; Go/C/Kotlin lag; GQLang/warm-root partial.

**Blended ≈ 83/100.** Band:
- Full OWASP run holds P≈1.0 and recall climbs to ~0.6+ → **87–89** (heavyweight cluster, broadest in it).
- Full run degrades (recall ~0.3, FP appears) → **~80**.

vs reference (same scale): CodeQL ~94, Coverity ~89, Infer ~88, Semgrep ~74, SonarQube ~72. semantica sits **below the proven heavyweights, above the shallow-but-popular tools** — and the gap to the heavyweights is **almost entirely the unmeasured/recall axis, not breadth or sophistication**. On breadth it already exceeds CodeQL. Theoretical ceiling for *any* static analyzer ≈ 96 (Rice's theorem: perfect is impossible).

## For codeagent-v3 integration (SWE-bench / Pro)

1. **Consume via MCP.** `codeagent-runtime serve-mcp`; codeagent-v3 attaches as MCP client. `cgr/query_quanta` (TraceDataflow / FetchProof) is the localization/evidence lever; apply/verify/rollback already exist if we want them.
2. **Localization lever:** static dataflow / def-use / taint directly attacks the measured "right-place-wrong-edit" + wrong-localization failure classes. Strongest for Python/TS/JS; weak for Go.
3. **Decision to make:** who owns the agent loop — codeagent-v3 (MCP client, semantica as tool backend) vs semantica's own runtime (codeagent-v3 supplies SWE-bench harness + model routing). Hybrid: codeagent-v3 loop + semantica post-apply validate/rollback as a verify rail.

## How to measure current HEAD (all prereqs present as of jun-29)

```bash
cd ~/Documents/code-new/semantica-codegraph-v2
# pass/fail vs FP≤0.05, recall≥0.45 on current HEAD:
bash tools/ci/gates/gate-qm02-owasp-java-fp-ceiling.sh
# raw current numbers + full corpus:
scripts/quanta-build-cli cargo --lane owasp-java-qm02 -- run -p quanta-bench \
  --bin owasp_benchmark --features parser-java,cli-bin,smt-z3 -- \
  --suite-language java --corpus-id owasp.benchmark.java \
  --corpus-root tools/bench/accuracy/datasets/owasp-benchmark-java \
  --profile full --out-dir /tmp/owasp-now && cat /tmp/owasp-now/metrics.json
```
Cost: `parser-java,smt-z3` build is heavy (Z3; first build minutes–tens-of-minutes).
`--profile full` may be slow (open perf ticket: pta-precise ~134s/2-files).

## Open questions (what would move the assessment)

1. **Full-corpus OWASP** (Java + Python) precision/recall on current HEAD — the single number that resolves 80 vs 89.
2. **Flagship clone detector** label (which config is the real engine vs baseline).
3. **IDE / type-inference accuracy** committed scores (harness + holdout exist).
4. **Go lane** uplift feasibility (DfgReady → taint) for SWE-bench Pro.
5. **DevOS-sunset vs codeagent-runtime-v2** live boundary (what's dead vs the live agent).

## Methodology / caveats

This analysis repeatedly corrected itself because early conclusions leaned on proxies
instead of primary source. Errors made and corrected during the analysis:
- LOC "1.68M" → actually **5.42M** Rust (a `find | xargs wc -l | tail -1` batching bug counted only the last batch).
- "Built in ~3.5 months" → **git history is post-hard-fork**; true timeline unknown.
- "Only ~7 real e2e tests" → conflated catalog `closure_basis` labels with test strength; labels are conservative, strong tests are far more numerous.
- "Precision measurement = 0" then "OWASP in-progress" → **both wrong**; OWASP Java number exists (jun-17) and is respectable.
- "Static-only, repro rail must be rebuilt" → the agent-runtime layer already has RunTests/Bash/verify.

Rule going forward: **no verdict without the primary-source quote attached** (file:line),
and **committed baseline ≠ current engine** (re-run against HEAD for a live number).
`[verified]` items were read directly; `[sampled]` items came from sub-agent samples
(directionally reliable, not exhaustive); `[unmeasured]` items have no committed number found.
