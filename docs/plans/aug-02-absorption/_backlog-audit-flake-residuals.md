# Backlog Audit — Test-Parallelism Flake Pool + RFC-02/03/07/08/09 Residuals

Date: 2026-08-10 · Read-only audit against `/Users/songmin/quanta-codeagent-v3` HEAD (`main`).
Method: 2-round (R1 existence grep w/ file:line, R2 adversarial refutation). No source modified.

---

## PART A — FLAKE POOL (test-isolation / parallel bleed)

### A.1 Mechanism (tools/test-resilience/cli.ts + quarantine.json)
`test:resilient` = `test:clean-js && tools/test-resilience/cli.ts run tests/unit tests/integration`.
The runner (cli.ts):
1. runs the full parallel suite once, parses failures (`parseBunTestOutput`);
2. re-runs EACH failure in true isolation (`bun test <file> -t "<leaf>"`), with a
   FILE-level fallback when `-t` matches nothing (regex-special leaf names — cli.ts:73-79);
3. classifies flake (isolated-green) vs real (isolated-fail) vs inconclusive;
4. real / new-flake / inconclusive all BLOCK (exit 1); only ledger-known flakes pass;
5. `quarantine-check` is a static ratchet: `entries.length <= maxCount`.

Current ledger state (`quarantine.json`): **maxCount=2, entries=2** — ratchet GREEN
(`bun run …quarantine-check` → `✓ 2/2`). History: started at 4 (2 LSP + 1 node-repl),
LSP pair retired by real-toolchain serial lane → lowered 4→2. Current 2 entries:
- `tests/unit/runtime/node-repl-timeout-reap-hellgate.test.ts` :: "a healthy exec still completes" (resourceClass `timing`) — sibling real node spawn/kill pressures the `node -i` stdout flush race.
- `tests/unit/bench-closure-prompt-wiring-hellgate.test.ts` :: "chaMultisiteSteer …" (resourceClass `timing`) — `withEnv()` mutates process-GLOBAL `QUANTA_BENCH_LOCALIZE_PHASE`; a sibling bench test racing the same knob wins the set→assert→restore window.

NOTE — the audit prompt named `bench-token-budget-lease` and `side-agent-assembler-process-wire` as flake instances. Neither exists in the tree under those names today (grep of `tests`+`src` = 0 hits). STALE prompt / concurrent-session churn. The live quarantine has only the 2 entries above; `bench-closure-prompt-wiring` is IN the ledger (not "quarantined-out"), node-repl is the other.

### A.2 Pool quantification (structural risk surface, NOT confirmed flakes)
The ledger is only the *manifested* tip. The *structural pool* (files with the shared-state
patterns that CAN bleed under parallel workers):

| Pattern | Files | grep |
|---|---|---|
| Mutate `process.env[...]=` / `delete process.env` | **393** | (prompt baseline 393 — unchanged) |
| …AND real child spawn (`Bun.spawn`/`child_process`/`spawnSync`/`execSync`) | **13** | highest-risk intersection (env race × real process contention) |
| Real child spawn (any) | 116 | |
| Mutate a SHARED `QUANTA_BENCH_*` knob | **58** | the specific class that bit the ledger's #2 entry |
| Local re-implementations of a `withEnv` helper | **16** | divergent signatures, no shared SSOT |
| Env-mutating files with NO afterEach/afterAll/finally restore | 6 | leak-across-file risk |

Most-mutated shared knobs (top): `QUANTA_SESSIONS_DIR` (82), `QUANTA_PERMISSION_STATE` (75),
`QUANTA_SESSION_REGISTRY_SQLITE_PATH` (39), `QUANTA_BENCH_BRANCH_SEARCH` (31),
`QUANTA_MAX_DESCENDANT_DEPTH` (28), `QUANTA_BENCH_LSP` (25), `QUANTA_CENTRAL_CONFIG` (21).
These are process-GLOBAL and read at call-time by code-under-test → any two files touching the
same knob under Bun's parallel workers can race.

### A.3 Root cause (confirmed, not hypothesized)
`process.env` is ONE object shared by all parallel worker tests in the same runner process.
The existing `withEnv` helpers ARE hermetic *locally* (save→`try/finally`→restore, e.g.
bench-closure-prompt-wiring-hellgate.test.ts:43-58). But local save/restore does NOTHING against
**cross-file parallel bleed**: while file A holds the mutated global inside its `fn()`, file B
running concurrently reads the same `process.env.QUANTA_BENCH_LOCALIZE_PHASE`. The code-under-test
reads env at call-time (`src/runner/knobs/knobs/localize-phase.ts` envKey `QUANTA_BENCH_LOCALIZE_PHASE`),
so the race is real. Same shape for the node-repl entry (real spawn resource contention, not env).

### A.4 Structural fix pattern (fix-not-quarantine; project philosophy)
Two independent, composable fixes:

1. **Kill the global read (the durable fix).** Thread the knob as an explicit param into the
   builder instead of reading `process.env` inside code-under-test. The ledger #2 entry's own
   `reason` prescribes exactly this: "thread localize-phase as an explicit param into the
   closure-prompt-wiring builder (drop the process.env read) → the test needs no global mutation
   → retire this entry and lower maxCount." This is the generalizable move for the 58 shared-knob
   files: config-injection at the composition seam, env read ONLY at the boundary (bootstrap /
   knob-parse), never deep in call-time logic.

2. **A shared hermetic `withEnv` SSOT** — but scoped honestly: it removes the 16-way
   reimplementation drift and the 6 no-restore leaks, and makes *intra-process serialization*
   possible (a shared helper can hold a per-knob async mutex so two tests can't overlap the same
   global). It does NOT by itself defeat parallel bleed for call-time-env readers — only (1) does.
   Recommended: `tests/helpers/with-env.ts` exporting one generic
   `withEnv(patch, fn)` (sync+async) with save/restore, and reserving an optional per-key lock for
   the shared-knob class.

For the node-repl `timing` entry the structural fix is per-test child isolation OR making the
best-effort stdout content check non-fatal (its own comment: `ok:true`+reusability is the
deterministic proof) — decouple the assertion from the flushed-content race.

### A.5 Effort estimate to structurally retire the pool
- Retire ledger #2 (bench-closure) → lower maxCount 2→1: **~S (0.5 day)** — thread one param, drop
  one env read, delete `withEnv` from that file. Self-contained; the fix path is already written
  in the ledger reason.
- Retire ledger #1 (node-repl) → maxCount 1→0: **~S (0.5 day)** — per-child isolation or non-fatal
  content assert.
- Shared `withEnv` SSOT + migrate the 16 reimplementations + 6 no-restore leaks: **~M (1–2 days)**,
  mechanical but touches many files (do file-disjoint waves; runtime-config `__reset` sites are
  transient-fragile — edit sequentially, see MEMORY jul-2 slice-boundary note).
- Full de-globalization of the 58 shared-knob call-time readers (the durable end-state): **~L
  (multi-day, incremental)** — but ROI is front-loaded: the two ledger entries + the ~13
  env×spawn intersection files are the ones that actually flake; the long tail is latent risk, not
  active breakage. Recommend: retire the 2 ledger entries now (ratchet 2→0), land the shared
  helper, then de-globalize opportunistically as files are touched. Do NOT big-bang the 393.

---

## PART B — RFC RESIDUALS (02 / 03 / 07 / 08 / 09)

Verdict legend: **BUILT** = present + prod-wired + gated + non-vacuous · **PARTIAL** · **GAP**.
Every item below is **BUILT** — the aug-02 absorption (MEMORY: RFC-01~11 all LANDED, deeaa91da)
already shipped these. R2 refutation found no dead seams; improvement opportunities noted.

### RFC-02 — Observability
| Item | Verdict | Evidence |
|---|---|---|
| B1 `/ps` process manager | **BUILT** | `src/runtime/bash-bg-registry.ts` (owner-scoped snapshot/killOwned, tagged `RFC02-0`); `/ps` registered in `src/apps/cli/slash/registry-surface.ts:391` gated by `isProcPanelEnabled()`=`readCliKnob("QUANTA_PROC_PANEL","bool") ?? false` (default-OFF); surfaced via `slash-surface.ts:661`; "not wired in this surface" fallback + exit 0 parity with `/agents`. |
| C2 bash observability hints | **BUILT** | model-tool kill routes ONLY through owner-scoped path (`src/tool/bash/kill.ts:59`, `RFC02-2`); registry snapshot is the observability surface. |
| B6 phase producer / op-correlation | **BUILT** | `OperationCorrelation` contract `src/activity/types.ts:68` (`RFC02-5 … B6`) — thin annotation on the spine node (operationId/threadId/turnId/runId/sequence). Phase hierarchy producer: `src/activity/producers/workflow.ts` (`phase_enter`→L1 `phase`, closes prior). |
| A8 model-route observation | **BUILT** | `src/llm/fallback.ts:69` (`RFC02-3 (A8)` FallbackTransition → `model_route_changed`), NOOP-metrics default-OFF (byte-identical). PROD-WIRED: real `FallbackLLM` swap at `src/runner/assemble/llm.ts:192` via `fallbackTransitionToRouteEvent` adapter; bootstrap seam `bootstrap-session.ts:478`. |

### RFC-03 — Self-improve / onboarding
| Item | Verdict | Evidence |
|---|---|---|
| ProposeSkills | **BUILT** | `src/skill/skill-creator.ts` + `src/skill/proposal/compiler.ts`; wired in `src/agent/tier1/skill.ts:192` gated `if (runtimeConfig().skillCreator && dir !== undefined)` (default-OFF, promotion via CAS artifact port on approve). Hellgate: `src/skill/__tests__/skill-creator.hellgate.test.ts`. |
| skill_search / ToolSearch | **BUILT** | `src/skill/tool-search.ts:279` `createToolSearchTool`; wired `src/agent/tier1/skill.ts:192` (`RFC03-1`, fed the pinned snapshot's registry entries). |
| external-config import | **BUILT** | full slice `src/migration/external-config/` (detect/convert/persist/run/ledger); CLI-wired gated (default-OFF, H13) via `src/apps/cli/config-migration-notice.ts` + `config-migration-skill-stage.ts`; startup notice `src/apps/cli/repl.ts:332`. Slice-fenced from `@/skill`/`@/agent`. |

### RFC-07 — Delivery / dependencies / workflow
| Item | Verdict | Evidence |
|---|---|---|
| named-to resolver | **BUILT** | `src/agent/subagent-delivery/target-resolver.ts:102` `createNamedAddressResolver` (+ `NamedAddressResolution` type); controller falls back to id verbatim when no binding (`ports.ts`/`controller.ts`). |
| task owner/blocks projection | **BUILT (relocated)** | `src/plan` does NOT exist (STALE prompt path). owner/blocks/dependencies live on the workflow spec: `src/workflow/spec.ts` + `structured.ts`; deps gating in `src/workflow/executor.ts:90` `gateAgent` (synchronous gates before await, semaphore-limited). |
| workflow engine | **BUILT** | `src/workflow/{compile,executor,semaphore,builders,structured,spec}.ts`. PROD-WIRED via `run_workflow` tool: `src/tool/workflow/run-workflow-tool.ts:95` `runWorkflow(compileWorkflowSpec(...))`, registered in `src/tool/surface/gated-tools.ts:45` (GATED). |

### RFC-08 — Effort/mode cycle
| Item | Verdict | Evidence |
|---|---|---|
| effort-cycle hotkey + EffortStore | **BUILT** | `src/apps/cli/effort-cycle.ts` (`RFC-08 BUILD-1`, pure core) applies via EXISTING `EffortStore` (`src/agent/effort.ts:98/104`, created `bootstrap-session.ts:472`). Keybinding: `src/apps/cli/keybindings/types.ts:50` (cycle reasoning-effort tiers); shift+tab mode-cycle owned separately by `mode-cycle.ts` (`RFC-08 / ADR-0443`). Live e2e (non-vacuous, 33 test/expect calls): `src/apps/cli/__tests__/effort-cycle-session-live-e2e.hellgate.test.ts`. |

### RFC-09 — Hooks / review
| Item | Verdict | Evidence |
|---|---|---|
| hook append-context bridge | **BUILT** | `src/agent/command-hooks/runner.ts:185` (`RFC09-1 (A-GAP-2)`) extracts user-side append-context, forwarding to the EXISTING `HookPromptInject` channel (`injectBeforeUser`), accepting both `additionalContext` (Claude Code alias) and native field; default-OFF/byte-identical when absent (`types.ts:108-116`); producer forwarding `install.ts:78`. |
| review-finding contract | **BUILT** | `src/tool/git/review-diff.ts`: `ReviewFinding` (l.80), `ReviewVerdict = "confirmed"|"plausible"` (l.63), `ReviewReport` (l.116), `ReviewCommentAnchor` (l.104), zod input schema (l.47), `parseOneFinding` (l.188). |

### R2 — what the adversarial round changed
R1 found all 14 items present. R2 (refute — for BUILT verify wired+gated+non-vacuous; for GAP
verify not-missed-under-alias) changed / hardened:
- **A8 refuted-as-dead → confirmed prod-wired**: emit is not a dangling comment — `runner/assemble/llm.ts:192` constructs a real `FallbackLLM` and `fallbackTransitionToRouteEvent` projects `model_route_changed`. Gate: NOOP metrics default-OFF (byte-identical when no swap).
- **RFC-07 `src/plan` "GAP" refuted**: the prompt's path is stale; owner/blocks are not missing —
  they live on `src/workflow/spec.ts`+`executor.ts` under a different name. Reclassified BUILT.
- **/ps, run_workflow, ProposeSkills, ToolSearch, external-config gates verified real**:
  `QUANTA_PROC_PANEL ?? false`, `runtimeConfig().skillCreator`, `gated-tools.ts`, H13 default-OFF —
  none default-ON; OFF paths are byte-identical.
- **effort-cycle non-vacuity verified**: live-session hellgate e2e (33 assertions), not a stub.
- **Flake-pool**: R2 confirmed the two prompt-named flakes (`bench-token-budget-lease`,
  `side-agent-assembler-process-wire`) do NOT exist today (0 grep hits) — the live ledger is the 2
  `timing` entries. Confirmed the racy env read is real (`localize-phase.ts` reads
  `QUANTA_BENCH_LOCALIZE_PHASE` at call-time), so local `withEnv` restore cannot fix parallel bleed
  — only param-threading (fix #1) can.

### Improvement opportunities (all default-OFF today; measure-first for efficacy)
- Retire both quarantine entries → ratchet maxCount 2→0 (fix paths already written in the ledger).
- Extract a single `tests/helpers/with-env.ts` (kill 16-way drift + 6 no-restore leaks).
- De-globalize the 58 shared-knob call-time readers incrementally (param-injection at composition seam).
- RFC efficacy for the BUILT-but-OFF absorption features (A8 route events, /ps, ProposeSkills,
  run_workflow, hook append-context) is unmeasured — gate any default-ON flip behind an A/B, per
  no-heuristics/measure-first.
