# W1-A receipt — agent, activity, attention, objective

```text
AUDIT_ASSIGNMENT|lane=A|scope=agent,activity,attention,objective|receipt=docs/plans/sep-7-solid-se-audit/receipts/W1-A.md
```

Read-only worker. Scope classified, not fixed. Inspection truth is the **working tree** for A-owned dirty files (SEP6 overlay) plus HEAD for clean A files. Cross-lane dirty files were not treated as A write ownership.

---

## Snapshot

| Field | Value |
|---|---|
| `w0_receipt` | **ABSENT** at inspection start (`docs/plans/sep-7-solid-se-audit/receipts/W0.md` missing). Coordinator dispatched A before W0. Local freeze used. Invalidate this receipt if a later W0 disagrees. |
| HEAD | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` |
| branch | `main` |
| `origin/main` | same commit (ahead 0 / behind 0) |
| merge-base | same |
| staged diff SHA-256 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (empty) |
| unstaged diff SHA-256 | `b693d4693650443b72d5910a98fa9573bc633bcda34171e261e37445d058918e` |
| untracked count (inspection start) | 7 |
| untracked manifest SHA-256 (inspection start) | `e3144092830e882813b8faf905e5e8fdebbcd59dddc1f5f5100aa57eb24e2612` |
| pre/post HEAD, staged, unstaged, authority docs | **unchanged** |
| untracked after sibling receipts | 14; hash `b8f8f16fe2f5d679f4bb919f0087134a074593bbcd7ce77c63e9bf12137b3f8e`. Delta = `W1-B.md`…`W1-H.md`. Not production drift. This file adds `W1-A.md`. |

Authority document hashes (worktree):

| Path | SHA-256 |
|---|---|
| `AGENTS.md` | `79de5da2fad6835f007654552180ba3c44312ab13f9049d6f04131f82411702c` |
| `AGENT_CORE.md` | `d1f585c79692ee9ca27b2dde36da25d01df0c17883676b3c392f6ee035dd7d82` |
| `AGENT_PLAYBOOK.md` | `288bb7e2fe1f2dbf60051d5ac0186f025e7b009dbbedefd29f2ca74afeb4f4b6` |
| `docs/ARCHITECTURE.md` | `16626624c6001dc16093000f0a1071a44402391f2f3940e5dff3cd24109b0fcf` (**DIRTY** vs HEAD; reserved W2/W3) |
| `tests/README.md` | `ba80760a592f1b3e70a2394bfa7f45ddecaf17f3b2cdec8468204eb61d351967` |
| `package.json` | `97c0650b754616cf72e5215aa7273c914840c314a141e8e83de3c0e37d8556e4` |
| `biome.json` | `86028e6e6c5e33a138cb5ed224f200fb4e704751b6aad14aee4c5477a2339703` |
| `tests/unit/_arch/slice-boundary-configs.ts` | `1e570be7ac9ecd80ede42399e98d8fabb948642be66ae2b4c93654dc0f4458d6` (**DIRTY**; reserved) |
| `tools/god-code/allowlist.json` | `9ce34fb2ee886193a369217b6aeac6d80ea2f30b8dfcf311e9047bdc46de34a3` |
| `tools/dev/lint-debt-ceiling.json` | `b56462a0d3b891d175a55ccb72026218018184dd9f50ac95f6c7d4c2fbeaaf24` |

A-owned dirty overlay (introduced/worsened attribution):

- `src/agent/dispatch/execute.ts` — source-class merge (introduced, fail-closed for `secret`; not a finding)
- `src/agent/retry.ts` — comment-only (SEP6-01 wording; N7 not reopened)
- mention/plugin resolvers — `mentionFirstLine` from `@/shared` (S8 closed; no local `firstLineOf`)
- `src/agent/per-tool-checkpoint/rollback-llm-error-bridge.ts` — comment-only
- `src/agent/session-resource-registry/{auto-sweep,global,index,inspector,disk-adapter/gc,sqlite-adapter/*}` — inspect/cleanup bind to singleton; **worsens operator coupling of P1-A-01**

Retired-campaign rule: SEP5 D8 and SEP6 N7/S8 **not reopened**. Documented triggers were not reproduced (no local first-line owner; `retryDispositionForKind` is the sole kind table).

---

## Coverage counts

| Universe | Count |
|---|---:|
| Production `.ts` exclusive A | **781** |
| Colocated tests under `src/{agent,activity,attention,objective}` | **108** |
| Production lines | **127966** |
| God-module >1000 | **0** |
| Cohort 900–999 | **3**: `compaction.ts` 983, `admissibility-gate/gates.ts` 913, `objective/authority.ts` 904 |
| Function body >150 (naive brace scan) | **1** confirmed: `dispatchTool` `src/agent/dispatch.ts:113-753` (~641). `work-metrics-collector.emit` 219-line claim is **false** (`emit` is a 1-line interface method). |
| A files in god-code allowlist `modules`/`functions` | **0** (allowlist arrays empty) |

| Slice | prod files |
|---|---:|
| `src/agent` | 727 |
| `src/activity` | 12 |
| `src/attention` | 3 |
| `src/objective` | 39 |
| **union** | **781** |

Internal inspection shards (disjoint, union = 781, intersection empty):

| Shard | n | method |
|---|---:|---|
| A1 loop/dispatch/retry/recovery/compaction/admissibility/stream-* | 100 | owner+consumer, dirty overlay |
| A2 session-registry/plugin/mention/checkpoint/sandbox/untrusted | 85 | all dirty files + GC/resolvers |
| A3-agent remaining | 542 | ≥400 deep-read; rest classified by dir |
| A3-leaf activity+attention+objective | 54 | all enumerated; large files deep-read |

Mirrored tests (name heuristic, not 1:1): `tests/unit` paths containing agent/activity/attention/objective ≈ 387; `tests/integration` ≈ 47. Root SUT owners in A: `tests/unit/{auto-sweep,recovery-router*,retry-decorator-policy,session-registry-slash,mention-first-line-parity}-*.test.ts` and colocated hellgates under `src/agent/**/__tests__`.

---

## Inspected consumer paths (production)

Lane A owners plus at least one reachable consumer per finding:

| Consumer | Role |
|---|---|
| `src/host/runtime/agent-config-assembler.ts:665-672` | XOR mint: caller-owned vs global registry (foreign G) |
| `src/apps/cli/session-registry-cmd.ts:331-398` | inspect/cleanup → singleton only (foreign G) |
| `src/agent/loop/emit-helpers.ts:99-132` | usage fan-out: meter tick + ledger.record |
| `src/agent/loop/same-turn-engine.ts:264` | `decideOnStreamError` / recovery |
| `src/agent/loop/stream-consume.ts:312-326` | shared `classify(e)` for spans |
| `src/agent/recovery.ts:239-256` | `classifyLLMError` / compact vs retry |
| `src/agent/observability-wire/wire.ts:236` | `createShadowVerifyAdapters` |
| `src/runner/assemble/llm.ts:176,209` | `RetryingLLM`; `createAutoClassifierPort` (foreign E) |
| `src/agent/tier1/auto-classifier.ts:23` | wraps auto-classifier into AutoModeClassifier |
| `src/agent/mention-runner/default-resolver.ts:263-287` | composite mention ingress |
| `src/shared/mention-text.ts` | S8 first-line owner (RESERVED; consumers in A call it) |
| `src/runtime/os-sandbox/llm-error-bridge.ts` | sibling LLM-error bridge (foreign B; fingerprint only) |

---

## Gap-fill 2026-09-08 (corrects scores below)

Campaign freeze remains HEAD `0b14f5cf`. Current repo HEAD later moved to `9b05cd33` (overlay commit). Do not mix.

| ID | Original | Corrected | Note |
|---|---|---|---|
| N7 / S8 | not reopened | **REOPEN on `0b14f5cf`** | WT overlay only. N7 owner is E `decorator-policy.ts`. S8: five local `firstLineOf` on HEAD; `mention-text.ts` absent |
| P1-A-01 | P1 | **P2** | production never takes caller-owned mint (`looksLikeMetricsRegistry` false on legacy `Metrics`) |
| P1-A-02 | P1 | **KEEP P1** | batch/daemon/ci-bot meter caps + ledger env = dual-STOP |
| P2-A-01 | P2 | **P3** | shared `classify` is span telemetry only; recovery does not compact on raw `"tokens exceed"` |
| P2-A-02 / P2-A-03 | P2 | KEEP | |
| **P2-A-04** | — | **new P2** | in-memory registry default mint has no maxEntries/TTL |
| **P2-A-05** | — | **new P2** | `lsp-diagnostics-hook` caches null open forever |
| git-directives / MCP mint / ticker / spawn-depth | fingerprints | closed as A write | parser dead; one Tool[] mint; different ticker contract; no production maxDepth omit |

Full evidence: `docs/bugbash/sep-8-se-audit/agent-7.md` §7 and §16.

---

## Findings

P0: none.

### P1-A-01 — Session registry mint vs lifecycle split-brain

- **Invariant:** one process has one `SessionResourceRegistry` Map whose durable GC/inspect/cleanup observe the same instance.
- **Owner A:** `src/agent/session-resource-registry/global.ts:94-148` — singleton + `startAutoSweep`.
- **Owner B:** `src/agent/session-resource-registry/caller-owned-builder.ts:91-127` — fresh instance, **no** sweep handle, **re-reads** `runtimeConfig()`.
- **Producer:** `src/host/runtime/agent-config-assembler.ts:665-672` — `metricsEmitter` present ⇒ caller-owned; else global.
- **Sweep/inspect consumers stay on singleton:** `auto-sweep.ts:408-420`, `inspector.ts:360-372`, CLI cleanup.
- **Failure mode:** SQLite adapter is Map-as-truth + sqlite mirror (`sqlite-store.ts` header). Two instances at one `databasePath` ⇒ two Maps. Auto-sweep still GC **configured paths**, not the mounted Map, so a later `getGlobal` can mutate caller-owned durable files while the live Map diverges. Metrics-on assemble never attaches sweep to the live mint ⇒ TTL GC missing on the write path.
- **Attribution:** pre-existing (ADR-0372/0383). Dirty overlay **worsens** operator coupling: inspect/cleanup now exclusively consume the singleton handle.
- **Proof limit:** composition is statically gated on `looksLikeMetricsRegistry(cfg.metrics)`. Dual-write not reproduced with a live MetricsRegistry in this worker.
- **Not SEP5/SEP6.**

**Proposed write set (A-owned):** `global.ts`, `caller-owned-builder.ts`, `unified-api.ts`, `auto-sweep.ts`.  
**Forbidden:** `src/host/runtime/agent-config-assembler.ts`, `src/apps/cli/session-registry-cmd.ts` (lane G).  
**Intent:** one lifecycle owner — caller-owned inherits frozen singleton+sweep, **or** metrics-on uses the singleton and threads flock telemetry without a second Map.

### P1-A-02 — Dual USD writers on the same usage event (unknown-model drift)

- **Invariant:** `emitUsage` prices once; every sink uses that number; no two sinks disagree (`emit-helpers.ts:28-32`).
- **Owner A (session price):** `priceUsage` via `emit-helpers.ts:315` — unpriced model ⇒ `pricingKnown:false`, `totalUsd=0`. Meter ticks `cost_usd` only if `eventCost.pricingKnown` (`:111`).
- **Owner B (ledger re-price):** `src/agent/budget-ledger.ts:474-475,711-713` — `resolvePricing = pricing[model] ?? safeFallback` (`claude-sonnet-4-6`). Same event is **re-priced**. `pricingKnown` is still false, but USD aggregates.
- **Consumer:** `USAGE_SINKS` in `emit-helpers.ts:99-132`. Host assembler always wires `budgetMeter` (`agent-config-assembler.ts:789`). Ledger is on when `QUANTA_BUDGET_LEDGER` + caps.
- **Measured drift (static fixture):** `model="lane-alias-unpriced"`, `inputTokens=1_000_000`. Meter cost axis inert. Ledger bills sonnet `$3/M in` → `$3.00`. `ledgerHardBreachCondition` can stop; meter `checkExhausted` cost remains false.
- **Attribution:** pre-existing (ADR-0136 fail-loud vs MR-05 skip-unpriced). Comment at `:115-116` ("never disagree") is false on this path.
- **Not SEP5/SEP6.**

**Proposed write set (A-owned):** `src/agent/budget-ledger.ts` (`record` consume pre-priced `eventCost` or disable fallback on this fan-out); optionally `src/agent/loop/emit-helpers.ts` ledger sink pass-through. Do **not** merge meter and ledger ports (per-run tick vs UTC daily USD).  
**Forbidden:** `@/observability/usage-accounting`, `src/host/runtime/budget-ledger-persist.ts`.

### P2-A-01 — PTL / context-window dual classifier (unknown/raw path)

- **Invariant:** this throw is prompt-too-long ⇒ compact, not retry/error.
- **Owner A:** `src/agent/retry.ts:131-139` `PTL_MARKERS` + `isPromptTooLong` + `classifyLLMError`. Missing `"context_window_exceeded"`, `"tokens exceed"`.
- **Owner B (foreign):** `src/shared/error-classifier.ts:61-71` `CONTEXT_WINDOW_MARKERS` includes those two.
- **Consumer:** `recovery.ts:244-256` uses `classifyLLMError`. `stream-consume.ts:312-326` uses shared `classify` for telemetry. Typed `kind === "context_window_exceeded"` path is aligned via `codexSpecRoute`. Residual is `kind:"unknown"` / non-`LLMError` with overflow wording.
- **Attribution:** pre-existing. Dirty `retry.ts` is comments only. **Not N7.**
- **Proof limit:** adapters that stamp typed kind (F-CTX-4) hide this; unknown/raw remains.

**Proposed write set:** `src/agent/retry.ts` delegate unknown/raw overflow to `classify` then `codexSpecRoute`, or copy the shared marker set. Optionally `recovery.ts:271` so unknown still consults overflow before marker retry.  
**Forbidden:** `src/shared/error-classifier.ts` (W2-X / RESERVED).

### P2-A-02 — Duplicate LSP `--version` cache; false-eviction drift

- **Invariant:** one process-wide answer to “is this language-server binary launchable?”
- **Owner A (canonical):** `src/agent/lsp-bridge/availability.ts:14-62` — cache **successes only**; settled `false` is evicted (transient 5s timeout must not disable LSP process-wide).
- **Owner B:** `src/agent/shadow-verify-adapters/check-lsp-test.ts:63-91` — copied probe; **false is cached forever**.
- **Consumer:** `createShadowVerifyAdapters` → `observability-wire/wire.ts:236`; CLI compose (foreign G).
- **Measured drift:** one 5s probe timeout on the shadow-verify path permanently skips LSP lint/typecheck for that bin in-process (empty diagnostics / graceful skip).
- **Attribution:** pre-existing.

**Proposed write set:** `check-lsp-test.ts` call `lspBinaryAvailable` / `isAvailable` from `lsp-bridge/availability.ts`.  
**Forbidden:** `@/lsp` adapters (lane C); `@/shared` probe dump.

### P2-A-03 — Permission auto-classifier cache unbounded

- **SE axis 7** (unbounded memory), single owner — not a duplicate-authority finding.
- **Owner:** `src/agent/auto-classifier.ts:137-165` `Map<string, CacheEntry>`. TTL eviction only on **same-key get**. No size cap. Deterministic allow/block entries live until that key is reused after expiry.
- **Consumers:** `src/runner/assemble/llm.ts:209`, `src/agent/tier1/auto-classifier.ts:23`.
- **Contrast:** `effort-classifier/store.ts` already uses a bounded ring/LRU.
- **Secondary smell (inventory unless reproduced):** `parseDecision` `:109` `norm.startsWith("no")` allows `notsure` / `noblock`. Documented contract is exact `no`.
- **Attribution:** pre-existing.

**Proposed write set:** `src/agent/auto-classifier.ts` — max entries + eager TTL sweep (or LRU). Optional exact-token parse.  
**Forbidden:** `@/permission` AutoModeClassifier orchestration (lane F).

---

## Inventory (not findings)

| Item | Why not a finding |
|---|---|
| Cohort modules (`compaction.ts`, `gates.ts`, `objective/authority.ts`) | size only; no new failure |
| `dispatchTool` ~641 lines | god-FUNCTION; W2-P structural |
| `error-routing` 16-arm vs `codexSpecRoute` 18-kind | `errorRouting` unwired in `src/apps/**` / `runner/assemble/llm.ts` |
| `StreamIdleError` fatal vs `llm/stream-timeout` network-retry | `createDefaultWatchdog` has **no** `src/` compose site |
| disk vs sqlite GC | LSP adapters; different storage units; TTL 14d both |
| two skill factories | production ingress is composite-only; `createSkillOnlyResolver` has no prod caller |
| S8 first-line | no local `firstLineOf`; all dirty resolvers call `mentionFirstLine` |
| LLM error bridges | parallel ADR-0237 arms, different kinds/knobs; rollback bridge default-OFF / unwired |
| `objective/authority` vs `agent/objective-decision.ts` | policy+CAS vs decision-stream counter |
| activity progress vs objective receipts vs observation vs attention vs focus-chain | four distinct invariants |
| glob-rules vs repo-rules vs agent-requested-rules | disjoint path families; matcher is not a loader |
| prompt.ts vs prompt-graph vs system-prompt | assembler + atom SSOT + identity projection |
| `stop-category` vs `stop-reason` vs `decideOnAssembled` | outcome vs provider stop_reason vs recovery; stopReasonPolicy default-OFF |
| closeout critic fail-open | documented advisory |
| `execute.ts` source-class merge | introduced; rank agrees with tool ports; secret still Layer-1 wipe |
| verification-bundle FAIL-OPEN | documented oracle rule |
| `parseDecision` startsWith("no") | no reproduced consumer of `notsure` |

---

## Candidate fingerprints for W2-X

1. **PTL/overflow** — `agent/retry.ts#isPromptTooLong` × `shared/error-classifier.ts#classify` × `llm/retry/codex-spec-router.ts`. See P2-A-01.
2. **Same-provider retry disposition** — `llm/retry/decorator-policy.ts#retryDispositionForKind` (canonical) × `agent/retry.ts#isRetryable` (markers only for four residual kinds) × `agent/recovery.ts#decideTypedStreamError` (`not_implemented` backoff vs decorator `no_retry`). Different layers; two projections of one table.
3. **USD accounting** — `budget-ledger.ts` × `budget/meter.ts` × `@/observability` `usageAccounting.record` × host persist. See P1-A-02.
4. **Session registry mint** — `global.ts` × `caller-owned-builder.ts` × host assembler (G). See P1-A-01.
5. **Mention first-line** — A resolvers → `src/shared/mention-text.ts` (S8 closed).
6. **LLM error bridges** — `per-tool-checkpoint/rollback-llm-error-bridge.ts` × `runtime/os-sandbox/llm-error-bridge.ts` (B). Same wrapper shape; different kind/knob; neither A-wired in prod.
7. **Sensitivity max-merge** — `dispatch/execute.ts` × `tool/pty/port.ts` × `tool/node-repl/index.ts` (B). Rank agrees; algorithm reuse.
8. **MCP Tool[] mint** — `mcp-bridge.ts` × A2 `plugin-app-resolver/mcp-resolver.ts` / `plugin-mcp-launcher`. Two ingresses.
9. **Subagent run** — `subagent-runner.ts` implements `@/subagent` `SubagentRunner` (H). Port+adapter, not duplicate policy.
10. **Named agentType** — `named-agent-registry.ts` disk agents × H `src/subagent/agent-type.ts` well-known types.
11. **Attention navigate** — `@/attention` × G CLI `/attention`.
12. **Spawn depth** — `spawn-depth.ts` × H `DEFAULT_MAX_DEPTH=3`.
13. **Git directives parse** — A `git-directives/parser` × H `src/git/directive-emit` × B `src/tool/git` (H may already hold).
14. **Quorum/vote** — `multi-voter` fail-closed × `repro-test/select` majority × `verification-bundle` k-of-n FAIL-OPEN.
15. **Classifier cache** — A auto-classifier × F `@/permission` AutoModeClassifier.
16. **Stream timeout** — `llm/stream-timeout.ts` always-on adapters × A `stream-timeout` opt-in unwired.
17. **TypedError 16-arm × LLMErrorKind 18-arm** — dead `errorRouting` slot.
18. **EscalationRequest basename** — sandbox-escalation vs skill-scope-escalation; different contracts.

Reject dumping policy into `src/shared` for (1) unless W2-X proves a pure, fence-legal, ≥2-consumer owner. Marker lists are algorithm reuse; recovery **action** must stay in agent/llm retry owners.

---

## No-finding bounded areas

- **N7 HITL retry:** `retryDispositionForKind` HITL → `no_retry`; `isRetryable` honors `no_retry` without a second kind table.
- **S8 mention first-line in A:** no local `firstLineOf`; composite is the live skill lookup.
- **Objective policy:** `objective/policy.ts` + `authority.ts` sole writer; `objective-decision.ts` is not a second store.
- **Attention vs focus-chain:** HITL “who needs the operator” vs N-turn todo re-inject.
- **Activity spine:** single reducer; progress bar ≠ objective receipts.
- **Follow-up queue bound:** max 32 per thread.
- **Recovery same-turn caps:** `RECOVERY_CAPS` in `recovery.ts`.
- **Untrusted-envelope:** default-off identity wrap; `escapeBoundary` from shared.
- **Slice fence in inspected A files:** agent as hub; no peer-library value-import violation observed in finding owners.

---

## Uninspected conditions

- Runtime not executed (static owner+consumer + fixture arithmetic only).
- AST-exact function lengths / biome complexity for all 781 files (W2-P).
- Live `cfg.metrics` assembler run for P1-A-01 (composition proven, race not executed).
- Whether any adapter still emits `kind:"unknown"` + `"tokens exceed"` after `fromSdkError` (F-CTX-4 suggests no for wrapped SDK errors).
- Same-input disk vs sqlite GC fixture (adapter pair, not claimed as LSP drift).
- Thin `index.ts`/`types.ts` barrels: classified by export role, not line-by-line.
- Hosts outside `src/` that might set `streamWatchdog` or `errorRouting`.
- Cross-process two-writers on `DISK_DIR` (disk adapter documents single-writer OOS).

---

## Exact proposed write sets

| ID | Files | Forbidden |
|---|---|---|
| P1-A-01 | `src/agent/session-resource-registry/{global,caller-owned-builder,unified-api,auto-sweep}.ts` | host assembler, CLI session-registry-cmd |
| P1-A-02 | `src/agent/budget-ledger.ts`; optionally `src/agent/loop/emit-helpers.ts` | observability pricing, host persist |
| P2-A-01 | `src/agent/retry.ts`; optionally `src/agent/recovery.ts` | `src/shared/error-classifier.ts` |
| P2-A-02 | `src/agent/shadow-verify-adapters/check-lsp-test.ts` | `@/lsp` |
| P2-A-03 | `src/agent/auto-classifier.ts` | `@/permission` orchestrator |

---

## Directory role fingerprints (grouped)

Fingerprint key: authority / invariant / input / output / state / effect / failure-policy / lifecycle.

- **`src/agent/loop/`** — session/turn FSM driver. Authority: turn iteration. Consumer: `runAgent`. Failure: recovery caps. Lifecycle: per-session.
- **`dispatch*`** — tool-call pipeline 0–11. Authority: `dispatchTool`. Effect: tool+hooks. Failure: deny as tool_result.
- **`retry.ts` / `recovery.ts` / `error-routing/`** — same-provider retry vs same-turn recovery vs optional 16-arm table (dead). See findings.
- **`compaction*`** — transcript compact/salvage. Cohort file. Consumer: compaction-wire.
- **`admissibility-gate*`** — pre-execute HITL/permission stages. Cohort `gates.ts`.
- **`session-resource-registry/`** — session store+cache+GC. See P1-A-01. Disk/sqlite are adapters.
- **`plugin-*` / `mention-*`** — plugin discovery/activation vs mention identity. Composite is live skill owner.
- **`per-tool-checkpoint/`** — granular checkpoint + three-way restore + default-OFF rollback LLM bridge.
- **`budget-ledger.ts` / `budget/`** — cross-run USD vs per-run meter. See P1-A-02.
- **`prompt.ts` / `prompt-graph/` / `system-prompt/`** — assembler / atom SSOT / identity projection.
- **`observation/`** — pre-task owner-hints. Not activity.
- **`objective/**`** — goal CAS authority + policy table + wake controller (timer, not store).
- **`activity/**`** — UX spine reducer + producers. Progress is ratio|indeterminate.
- **`attention/**`** — lineage-gated HITL next-operator. 3 files, pure.
- **`subagent-*`** — in-agent adapters over `@/subagent` port (H). Delivery/mailbox/resume/persistence are distinct contracts.
- **`tier1/`** — default-OFF capability builders.
- **`types.ts` + `wire-slots-*` + `optional-ports.ts` + `mode.ts` + `hooks.ts`** — composition bags approaching cohort; ISP smell, no dual-write.
- Remaining dirs (`plan/`, `converge/`, `repro-test/`, `issue-hint/`, `branch-search/`, `model-routing/`, `sticky-model/`, `fork-session/`, `command-hooks/`, `verification-*`, `shadow-verify*`, `lsp-bridge/`, …): classified complementary; see A3c watch-axis notes in worker packet. Complete path list is the appendix.

---

## Appendix — complete production file manifest

Format: `lines<TAB>sha256[:12]<TAB>path`. Sorted. 781 rows. Union proof: every path is under `src/{agent,activity,attention,objective}` and not a test. Pairwise shard intersection empty (A1 100 + A2 85 + A3-agent 542 + A3-leaf 54 = 781).

```tsv
 913	a6dedf487086	src/agent/admissibility-gate/gates.ts
 369	73cfc0c1f2ee	src/agent/admissibility-gate/hitl.ts
 785	9c95c86af53d	src/agent/admissibility-gate/shared.ts
 186	01c27907be4c	src/agent/admissibility-gate.ts
  87	f3ecfaba4fae	src/agent/agent-requested-rules.ts
  44	37ebfcf97971	src/agent/app-catalog/default-catalog.ts
  50	fa1be7597a52	src/agent/app-catalog/in-memory-catalog.ts
  37	2e038890983d	src/agent/app-catalog/index.ts
 163	fdaebf29a2fa	src/agent/app-catalog/loader.ts
 117	c05966c790dd	src/agent/app-catalog/merge.ts
  70	8591569b5f66	src/agent/app-catalog/types.ts
  45	2eecf95e9646	src/agent/app-catalog/workspace-catalog.ts
  20	f33626b31b1b	src/agent/approval-gate-wire/index.ts
 105	f2419a0a3d1c	src/agent/approval-gate-wire/types.ts
 189	00865cd6b64d	src/agent/approval-gate-wire/wire.ts
  23	baa4b235a4c3	src/agent/approval-state-machine/index.ts
 644	47e6b8c0bf18	src/agent/approval-state-machine/store.ts
 228	9b1e9f45f66e	src/agent/approval-state-machine/types.ts
 108	d24f3ad87ccf	src/agent/auto-background/default-tracker.ts
 134	d68a262f1327	src/agent/auto-background/fork-on-accept.ts
  48	bd594e059936	src/agent/auto-background/index.ts
 158	15493fa619a1	src/agent/auto-background/port.ts
 138	981b4a20e5a9	src/agent/auto-background/propose-handler.ts
  82	a5baaf0a386d	src/agent/auto-background/stuck-detector.ts
 168	bbbe4c504f02	src/agent/auto-classifier.ts
 110	79b2d22d6fdd	src/agent/automation-ticker.ts
 102	6a51ec0621f2	src/agent/batch-jobs/csv.ts
  50	c205210f9b1c	src/agent/batch-jobs/index.ts
 184	67057a8a8d04	src/agent/batch-jobs/port.ts
 458	979e17e6e6b5	src/agent/batch-jobs/runner.ts
 101	38583acf468d	src/agent/batch-jobs/schema.ts
 210	209989fea7f1	src/agent/batch-jobs/types.ts
 159	c8af0dfb6427	src/agent/batch-jobs-dispatch.ts
 161	a80a71ef52f1	src/agent/branch-search/anchor.ts
  53	e958789c47e3	src/agent/branch-search/index.ts
 123	312b6f6f0fe0	src/agent/branch-search/isolate.ts
 118	2bddd7aa3a05	src/agent/branch-search/progress.ts
 164	866fb9d66255	src/agent/branch-search/propose.ts
 126	dd9f69924009	src/agent/branch-search/score.ts
 161	4c97eaa7f648	src/agent/branch-search/search.ts
  46	aa09e9ee0de2	src/agent/branch-search/seed.ts
 219	3babc16e84d3	src/agent/branch-search/tool.ts
 147	8ff3b102f542	src/agent/branch-search/types.ts
 245	59def3798ae9	src/agent/branch-search/verify.ts
  48	a4d9513d6363	src/agent/branch-search-runner/run-agent-override.ts
 181	713b2a97cf3d	src/agent/branch-search-runner.ts
  55	065878c1811e	src/agent/brief.ts
  61	4cc3deb13ace	src/agent/budget/events.ts
  27	d96360aeff76	src/agent/budget/index.ts
 326	d7ced9a84527	src/agent/budget/meter.ts
 107	d96f79752193	src/agent/budget/task-budget.ts
 141	7d8249664bb7	src/agent/budget/types.ts
 150	9d6f4d18c797	src/agent/budget-ledger-cost.ts
  29	fc1053ca1f56	src/agent/budget-ledger-pricing.ts
 828	dfd97c3475cd	src/agent/budget-ledger.ts
 120	543f70829c81	src/agent/budget-tool.ts
 156	c83129a4f48e	src/agent/cap-enforcer.ts
 385	260053d556eb	src/agent/checkpoint-policy.ts
 118	eff58ca78b4c	src/agent/checkpoint-wiring.ts
 198	9aae713d51d9	src/agent/closeout-critic.ts
 138	5297d0b7775b	src/agent/closeout-guard.ts
  71	09ca9eb9019f	src/agent/closure/bundle.ts
 100	55c09841d9a5	src/agent/closure/evaluate-success-predicate.ts
  21	b379019fa2cf	src/agent/closure/index.ts
 231	f1c6e86096b5	src/agent/closure/owner-sibling-resolve.ts
  85	b935a4c6cd94	src/agent/closure/patch-hygiene.ts
  23	b240564842d0	src/agent/closure/primary-rail-step.ts
  31	c2b254ea46f3	src/agent/closure/render.ts
  56	9517c8e57a49	src/agent/closure/types.ts
  93	2b35c5a395d2	src/agent/codemode-wire.ts
  16	5c203eccb1b1	src/agent/codex-r2-wire-install/index.ts
 342	85783cc6f986	src/agent/codex-r2-wire-install/install.ts
  15	2a3dcf708a69	src/agent/codex-r2-wire-install/types-config.ts
  77	6b8863100429	src/agent/codex-r2-wire-install/types.ts
 191	c6b405eefd9d	src/agent/command-hooks/gate.ts
  48	4fb8a463b2fc	src/agent/command-hooks/index.ts
 124	325a6bbb4fe5	src/agent/command-hooks/install.ts
 180	124a9d65e501	src/agent/command-hooks/review-store.ts
 386	043605a883c8	src/agent/command-hooks/runner.ts
 125	7c49f7498c3a	src/agent/command-hooks/sandbox-exec.ts
 181	b0a8bcb3e833	src/agent/command-hooks/settings-loader.ts
 258	95c2c57d0689	src/agent/command-hooks/types.ts
 362	16ce9d162bd2	src/agent/compaction/background.ts
  63	74d3a31dd177	src/agent/compaction/harness-speech.ts
  30	1dd4546e6061	src/agent/compaction/index.ts
 345	3403839ae615	src/agent/compaction/token-baseline.ts
 203	26979f1ddc6b	src/agent/compaction/types.ts
 150	c225dc3a94f4	src/agent/compaction-breaker.ts
 983	f21507c2630a	src/agent/compaction.ts
 183	7eae372ab8ce	src/agent/confirm-decision.ts
 290	9330ab895d24	src/agent/context/usage-breakdown.ts
 175	22f65e7f877d	src/agent/context-change/detector.ts
  37	d01ae85852d4	src/agent/context-change/index.ts
 176	35310db5eb7b	src/agent/context-change/inject.ts
  52	de1dc71c5a8a	src/agent/context-change/snapshot.ts
 111	fc238545fc46	src/agent/context-change/store-reader.ts
  31	93e0cbbcbd44	src/agent/context-change/types.ts
 118	8abca6a48e35	src/agent/context-events-producer/debug-enricher.ts
 179	71f31c118607	src/agent/context-events-producer/factory.ts
  26	95bde062881e	src/agent/context-events-producer/index.ts
  55	e57d7b4a91ac	src/agent/context-events-producer/types.ts
 232	ea48017ed023	src/agent/control-op-handler.ts
 137	a3a64b258521	src/agent/control-request/apply.ts
  20	5ce01056d7c9	src/agent/control-request/index.ts
 151	c9858822d3c8	src/agent/control-request/types.ts
 269	642fb17b5a85	src/agent/converge/compare.ts
 260	7dd924f85bbf	src/agent/converge/exercise.ts
  44	439d0ca5463d	src/agent/converge/index.ts
 123	a184d983a593	src/agent/converge/loop.ts
 216	08fe0658b24c	src/agent/converge/oracle-taint.ts
  46	d1d87a1a56bf	src/agent/converge/output-contract.ts
 145	8232ea7a84cc	src/agent/converge/protocol.ts
 267	f87085d70d06	src/agent/converge/self-test.ts
  84	bc0e4dfd7bd0	src/agent/converge/stamp.ts
 255	e29e7119e289	src/agent/converge/tokenize.ts
 155	b0b73172605f	src/agent/conversation-action-surface.ts
 391	39b54b7b3833	src/agent/conversation-action.ts
 195	c69039112505	src/agent/conversation-checkpoint.ts
 149	e49ee84de8e9	src/agent/conversation-summary-archive.ts
 226	703960919d8c	src/agent/coordination-broker-wire.ts
 149	a553e99b41d6	src/agent/decision-emit-phase3.ts
 177	6b82a56e7d64	src/agent/delegation-runner/default-runner.ts
  70	3a9d833b66ce	src/agent/delegation-runner/headless-stub.ts
  21	dbf84fefabe0	src/agent/delegation-runner/index.ts
  44	8c4b33cf1b2c	src/agent/delegation-runner/port.ts
 103	b4e5236dbe3f	src/agent/delegation-runner/types.ts
  56	3eb08353485e	src/agent/deny-reason-wire.ts
 225	c19036018704	src/agent/dispatch/edit-repair.ts
 320	d77f6e5f2f3a	src/agent/dispatch/execute.ts
 253	e146028247ec	src/agent/dispatch/preflight-consults.ts
 265	804be0ef6300	src/agent/dispatch/tool-context.ts
 420	ccb678ccd4cb	src/agent/dispatch-dedup.ts
 209	e56017dea535	src/agent/dispatch-guard/default-guard.ts
  22	26ebf4b4d7e0	src/agent/dispatch-guard/index.ts
  85	253cb58c3a7c	src/agent/dispatch-guard/network-guard.ts
  21	22074a6c3fae	src/agent/dispatch-guard/no-op-guard.ts
  36	6e3dbe90d5ea	src/agent/dispatch-guard/port.ts
  94	bc7c05c2bbfa	src/agent/dispatch-guard/question-availability.ts
  28	047e7d6e74fe	src/agent/dispatch-guard/types.ts
 101	61fdf3889c04	src/agent/dispatch-helpers.ts
  65	ae3c66be1205	src/agent/dispatch-seam-guard.ts
  68	723f0c8b3549	src/agent/dispatch-types.ts
 756	85725063b1ba	src/agent/dispatch.ts
  24	a17c6622631f	src/agent/edit-repair-loop/index.ts
 176	5bcdb7b23109	src/agent/edit-repair-loop/lint-delta.ts
 174	f995aa43ae37	src/agent/edit-repair-loop/runner.ts
 178	753b2941a00f	src/agent/edit-repair-loop/types.ts
 274	dc6d4d38d5ba	src/agent/edit-repair-wire.ts
 179	db8313c3fa8b	src/agent/effect-channel.ts
  57	38acb556548d	src/agent/effective-model.ts
  16	e00dd32e38bc	src/agent/effort-classifier/index.ts
  75	95522ceca60a	src/agent/effort-classifier/keyword-detector.ts
 152	e0b1444ff6fa	src/agent/effort-classifier/store.ts
  81	45c0c7a1954b	src/agent/effort-classifier/types.ts
 113	6d569c380bc3	src/agent/effort.ts
 408	13016c13ebd1	src/agent/env-context.ts
 168	40e846ddb1f3	src/agent/error-routing/default-classifier.ts
  85	d6b8b6b60c1f	src/agent/error-routing/default-router.ts
  13	45a8f7664f5a	src/agent/error-routing/index.ts
  21	995263549b25	src/agent/error-routing/metric-port.ts
  18	f9b72ad90351	src/agent/error-routing/no-op-metric.ts
  37	073a5341ceb3	src/agent/error-routing/port.ts
 150	7430963faacf	src/agent/error-routing/types.ts
  19	4bd58e68c04c	src/agent/evidence/index.ts
  76	bcb2a7bf4445	src/agent/evidence/ingest.ts
 106	a4ef1e294127	src/agent/evidence/ledger.ts
  64	b580f3a5b187	src/agent/evidence/reducer.ts
 106	e750310747e2	src/agent/evidence/types.ts
  31	68cada7d3f52	src/agent/exploration-ladder.ts
  26	633affa32c9e	src/agent/fast-apply-fallback/index.ts
 212	ce94a74be610	src/agent/fast-apply-fallback/merge-runner.ts
 129	40b8b3bface0	src/agent/fast-apply-fallback/runner.ts
 132	72689dfb626b	src/agent/fast-apply-fallback/types.ts
 167	1cb2ddaceef7	src/agent/fault-evidence/build.ts
   7	dc8a59ddb6fe	src/agent/fault-evidence/index.ts
  83	cdc65e429aef	src/agent/fault-evidence/types.ts
 332	9996b79c1da5	src/agent/features.ts
 139	efdfc6ee992a	src/agent/focus-chain/default-tracker.ts
  43	21739877f755	src/agent/focus-chain/drift-detector.ts
  27	65386dd1ffb1	src/agent/focus-chain/index.ts
  96	9b88beaef173	src/agent/focus-chain/plan-bridge.ts
  84	85111b2fa4b1	src/agent/focus-chain/port.ts
  62	2f1967286339	src/agent/focus-chain/todo-injector.ts
 411	ac3506a47513	src/agent/follow-up-queue.ts
 163	58cd3d2ca8cc	src/agent/fork-session/branch-id.ts
 259	27d8a7835236	src/agent/fork-session/default-forker.ts
  30	4e409f08cd17	src/agent/fork-session/index.ts
 149	73111a01548f	src/agent/fork-session/lineage.ts
 174	935d79a4a490	src/agent/fork-session/parent-link.ts
  99	f3998bc64f18	src/agent/fork-session/port.ts
  71	21d1f368b901	src/agent/fork-session/types.ts
 113	8fbbad4af675	src/agent/fork-session-wire/default-checkpoint-base.ts
  17	fff135392675	src/agent/fork-session-wire/index.ts
  61	8119a0b02876	src/agent/fork-turns.ts
 101	26b9421a1447	src/agent/gate-decision.ts
  38	f3d523d66b95	src/agent/git-directives/default-stdout-emitter.ts
  19	da31f1b38e3a	src/agent/git-directives/index.ts
  17	fd7a02471879	src/agent/git-directives/metric-port.ts
  15	bfd44c924801	src/agent/git-directives/no-op-emitter.ts
  13	55843022dbf3	src/agent/git-directives/no-op-metric.ts
 102	b03ebeb90d1d	src/agent/git-directives/parser.ts
  14	f68ed7c879a4	src/agent/git-directives/port.ts
  69	95886c568c48	src/agent/git-directives/serializer.ts
  37	0667e9179d75	src/agent/git-directives/types.ts
  49	4cdc9f37079e	src/agent/git-observability/index.ts
  43	d4eac635136b	src/agent/git-observability/session-fingerprint.ts
  91	c2189a1b6c49	src/agent/git-observability/turn-diff-emit.ts
 610	75a2da66b760	src/agent/glob-rules.ts
  66	532a05ce7c9f	src/agent/guards/build.ts
 100	268a40b4ba2f	src/agent/guards/chain.ts
  45	49c3503cc2fe	src/agent/guards/closeout-guard.ts
  23	69b8e286a2c9	src/agent/guards/index.ts
  32	1082c1e50aec	src/agent/guards/shared.ts
  74	59f23e8d77a6	src/agent/guards/verify-guard.ts
 275	bd7656f5a7bc	src/agent/hitl-tier-registry.ts
  90	d1646a96a22f	src/agent/hitl-tier.ts
 257	d11f0f8de773	src/agent/hooks/event-types.ts
 878	fc7533689201	src/agent/hooks.ts
 589	a63ddacc495f	src/agent/ide-context.ts
  56	d98d5b5a8962	src/agent/identity/default-identities.ts
  11	fdc9bfc0e92c	src/agent/identity/index.ts
  67	8ca8348f6ddb	src/agent/identity/lookup.ts
  91	bdcc52bc78d1	src/agent/identity/port.ts
  67	a38d80822596	src/agent/identity-pool/default-minter.ts
  11	a8d9e6f10f0f	src/agent/identity-pool/index.ts
  73	fe565b7f6f22	src/agent/identity-pool/nickname-table.ts
  68	ec31dd2e0102	src/agent/identity-pool/port.ts
  82	8db36407d5bb	src/agent/identity-pool/types.ts
  80	adba281452bd	src/agent/identity-reminder.ts
 148	13b63c01de64	src/agent/inbound-mode.ts
 504	e869387bd043	src/agent/index.ts
 282	d8e0089bb4f8	src/agent/interrupted-turn.ts
 377	6559bab41483	src/agent/issue-hint/agentless-localize.ts
 168	8b4a5fc1a393	src/agent/issue-hint/budget-collector.ts
 140	272e54571655	src/agent/issue-hint/compose.ts
 121	3c728946545c	src/agent/issue-hint/extract-code.ts
  76	2ded2026b075	src/agent/issue-hint/extract-errors.ts
  58	d6d74a9ee9c0	src/agent/issue-hint/extract-expected-actual.ts
  82	d0d8833ea8b4	src/agent/issue-hint/extract-files.ts
  46	2a0cc2ba772a	src/agent/issue-hint/extract-refs.ts
 132	280ca7ced09e	src/agent/issue-hint/extract-symbols.ts
  87	053cc7149dcc	src/agent/issue-hint/extract-tracebacks.ts
 101	4cee4228bf9e	src/agent/issue-hint/index.ts
  18	34cdac28220f	src/agent/issue-hint/normalize.ts
 107	6c1c4e6f5011	src/agent/issue-hint/types.ts
 171	48a47f68ec8d	src/agent/language-detect/index.ts
  15	02e4bab94707	src/agent/localization/index.ts
 112	1e70423ebfc9	src/agent/localization/pass.ts
  62	1ef6fa866919	src/agent/localization/types.ts
 198	0618e00c2a01	src/agent/localize-phase-guard.ts
  47	1dab1eee7a91	src/agent/loop/closeout-critic-wire.ts
 820	f11bd276a38a	src/agent/loop/compaction-wire.ts
 642	3c6bf1043d91	src/agent/loop/context-assembler.ts
 253	349d4750d90d	src/agent/loop/control-poll.ts
 521	7dd170ac5680	src/agent/loop/emit-helpers.ts
 146	f9145f39f9dd	src/agent/loop/entry.ts
  63	cc92f954b223	src/agent/loop/plan-enter-wire.ts
  97	2fa3bc000345	src/agent/loop/plan-exit-wire.ts
 350	cb510d382c63	src/agent/loop/recovery-executor.ts
 291	d2f76f9fdc5a	src/agent/loop/same-turn-engine.ts
 500	20fe9dc9b326	src/agent/loop/session-bootstrap.ts
  96	90fe9026752c	src/agent/loop/session-hooks.ts
 373	64728c72ff18	src/agent/loop/session-lifecycle.ts
  69	ce556f7acc98	src/agent/loop/session-snapshots.ts
 241	1be554ebd226	src/agent/loop/skill-gate.ts
  63	a4c16fe32739	src/agent/loop/skill-scope-view.ts
  14	e6505162f973	src/agent/loop/sleep.ts
 129	ce53bca9e60a	src/agent/loop/stop-conditions.ts
  74	b40cc6413119	src/agent/loop/stream-cancellation-wire.ts
 609	09f5468ce1e1	src/agent/loop/stream-consume.ts
  40	3145f4856030	src/agent/loop/turn-gate.ts
 609	802450acff9d	src/agent/loop/turn-iteration.ts
 363	5f0a8363f4a0	src/agent/loop/turn-loop.ts
 160	ba6547a9281b	src/agent/loop/turn-outcome.ts
 113	e599d7d63ec2	src/agent/loop/types.ts
 328	7d865e427eb9	src/agent/loop-activation-hook.ts
 366	acb8b4f9f7b9	src/agent/loop-helpers.ts
  14	4a0b1efe7a15	src/agent/loop.ts
 102	f6b2b071f82f	src/agent/lsp-bridge/availability.ts
 101	59543628e8ab	src/agent/lsp-bridge/diagnostics.ts
 190	26fcb2d21376	src/agent/lsp-bridge/nav.ts
  96	e4f833f8ddef	src/agent/lsp-bridge/servers.ts
 250	5c5edb4af8e8	src/agent/lsp-bridge/tools.ts
 351	bc5357a6efc5	src/agent/lsp-bridge/warm-pool.ts
  53	5cf4e163e306	src/agent/lsp-bridge.ts
 128	75f53c483212	src/agent/lsp-diagnostics-hook.ts
 520	456c5af739b9	src/agent/lsp-workspace-pool.ts
 490	2872431d3598	src/agent/mcp-bridge.ts
 159	bd2dc4e8b1a8	src/agent/mcp-media-guard.ts
 151	daf159aaeedf	src/agent/mcp-reload-source.ts
 162	6af6aacf8155	src/agent/mcp-resources-aggregate.ts
 329	69e4bf8c6330	src/agent/mcp-tool-adapter.ts
 206	0165d5042f52	src/agent/memory-consolidate.ts
 450	010b28201ccb	src/agent/memory-consolidator-hook.ts
 235	71d257432228	src/agent/memory-distill.ts
 133	603b3db80843	src/agent/memory-embedder.ts
  47	288a90f1fc4d	src/agent/memory-stats.ts
 523	37605bbb1c1b	src/agent/memory-tools.ts
 532	e83ca499e255	src/agent/memory.ts
 304	8e5be4aba87d	src/agent/mention-injection/anchor-synth.ts
  93	d1195d527eb6	src/agent/mention-injection/event-emitter.ts
  58	45a323e036a0	src/agent/mention-injection/index.ts
  69	9dd99db35b32	src/agent/mention-injection/inject-messages.ts
 368	b7b13b7207d8	src/agent/mention-injection/parser.ts
 243	ae73d0b0605d	src/agent/mention-injection/resolver.ts
 191	16fad7577621	src/agent/mention-injection/symbol-lookup-lsp.ts
 107	8fb481e8677b	src/agent/mention-injection/symbol-lookup-semantic.ts
 196	225eabfb21cb	src/agent/mention-injection/symbol-resolver.ts
 127	c498832f4e1c	src/agent/mention-injection/types.ts
 288	0883fabbf27e	src/agent/mention-runner/default-resolver.ts
  28	0687ebc5fe2a	src/agent/mention-runner/index.ts
  91	64257b7b61bd	src/agent/mention-runner/skill-resolver.ts
  32	3de0211e0ffa	src/agent/mention-runner/types.ts
 195	8da51d7baabd	src/agent/metrics.ts
 207	3969a82cc01a	src/agent/mid-turn-interruption/default.ts
  19	fa70638e5946	src/agent/mid-turn-interruption/index.ts
  82	3595fbd45c3c	src/agent/mid-turn-interruption/types.ts
  45	33b265605f43	src/agent/mode-errors.ts
 872	3f8348dea780	src/agent/mode.ts
 316	b10b89d5a8e1	src/agent/model-routing/authority.ts
 161	e5d07313941e	src/agent/model-routing/boot-snapshot.ts
 182	f541b47933e3	src/agent/model-routing/from-config.ts
  26	d1f612472b61	src/agent/model-routing/index.ts
  76	e66148e9878f	src/agent/model-routing/precedence.ts
 197	d39c08353cfe	src/agent/model-routing/types.ts
  22	fb7f68e6ac51	src/agent/multi-voter/index.ts
  83	c4ab11b1c27a	src/agent/multi-voter/signal.ts
  60	a1d6e2bc235d	src/agent/multi-voter/skill-spec.ts
  71	19d6d878b4b1	src/agent/multi-voter/types.ts
 160	f5f0d8119dc1	src/agent/multi-voter/voter.ts
  65	612ecab87ab6	src/agent/mutating-tools.ts
 232	aafd23d40c4c	src/agent/n-phase/default-driver.ts
  37	e663328befe6	src/agent/n-phase/index.ts
  66	e50d8901796c	src/agent/n-phase/port.ts
 164	ebc5deecb7a6	src/agent/n-phase/types.ts
 250	40f11694bbf9	src/agent/named-agent-registry.ts
  47	071c2138134e	src/agent/no-patch-breaker.ts
  56	4e27ef13294b	src/agent/objective-decision.ts
  22	1c2f48ce1412	src/agent/observability-wire/index.ts
 223	5b14a60e2d8c	src/agent/observability-wire/types.ts
 360	af7b3e9b06f8	src/agent/observability-wire/wire.ts
   2	b782ce5878f3	src/agent/observation/critic/lsp-refuter/index.ts
 238	f07b84c0071a	src/agent/observation/critic/lsp-refuter/provider.ts
  86	0d6eb738e35d	src/agent/observation/critic/owner-critic.ts
  87	6786d3afa32f	src/agent/observation/critic/refuter.ts
  37	b0eee89d6490	src/agent/observation/critic.ts
  71	044f068f0e5b	src/agent/observation/fragment.ts
 143	5ce81c108a15	src/agent/observation/metrics/event.ts
 238	7654fe507fe1	src/agent/observation/metrics/failure-facts.ts
 177	3d19a048f7c0	src/agent/observation/metrics/failure-taxonomy.ts
  48	22feb6ee3559	src/agent/observation/metrics/index.ts
  76	2b10afcdefa2	src/agent/observation/metrics/stratum.ts
 305	e2d42b959f28	src/agent/observation/metrics/usage-metrics.ts
 155	6812d610cf96	src/agent/observation/pipeline.ts
  50	cd193af0fcf8	src/agent/observation/port.ts
 209	b9c86f61ff5a	src/agent/observation/providers/lsp-enrich/provider.ts
  83	108bfc7dc986	src/agent/observation/providers/static-owner/engine.ts
  96	34ff1670c79c	src/agent/observation/providers/static-owner/provider.ts
  76	2576654e4931	src/agent/observation/providers/static-owner/shadow.ts
  52	377034ae6627	src/agent/observation/render/agentless-provider.ts
 114	98e948610d41	src/agent/observation/render/render.ts
 874	658c523a6653	src/agent/optional-ports.ts
 291	faac0cb85e91	src/agent/owner-admission/index.ts
 432	22db3d70b7c0	src/agent/ownership-policy.ts
 176	865d31b5c7c0	src/agent/patch-budget/index.ts
 367	30251e430313	src/agent/per-tool-checkpoint/granular-policy.ts
  58	0604817b5e47	src/agent/per-tool-checkpoint/index.ts
 359	d55dfb810754	src/agent/per-tool-checkpoint/port.ts
 163	22785ed657ac	src/agent/per-tool-checkpoint/rollback-llm-error-bridge.ts
 279	beeb38220463	src/agent/per-tool-checkpoint/three-way-restore.ts
 134	d8b7acf69af7	src/agent/persona.ts
 327	a4f3b7655623	src/agent/plan/dag.ts
  33	98909789af66	src/agent/plan/index.ts
 724	1878fea3e1ea	src/agent/plan/mutations.ts
 199	dcb80a2a7b02	src/agent/plan/mutator-adapter.ts
  41	b326a14c710c	src/agent/plan/render-text.ts
 446	c9fefbe2cbb3	src/agent/plan/snapshot.ts
 230	cce31bff1388	src/agent/plan/state.ts
  62	2c65226e24eb	src/agent/plan/stream-mirror.ts
  84	0824279357ac	src/agent/plan/task-projection.ts
  57	33ac055c5f9e	src/agent/plan/transitions.ts
 352	a05b8ac232fb	src/agent/plan/types.ts
 244	6534bac30d1a	src/agent/plan-exit-flow.ts
 183	05ac85469340	src/agent/plan-exit-lifecycle.ts
 102	c6f4fa7f0419	src/agent/plan-exit.ts
 441	d9c2eb87e9cd	src/agent/plan-queue/internals.ts
 235	1be96c4f1759	src/agent/plan-queue-shared.ts
 195	69ae1119daff	src/agent/plan-queue.ts
  16	736ec76fa767	src/agent/plan.ts
 183	e6374fcef39c	src/agent/plugin-activation-handler/auto-wire.ts
 129	8c5d80ef6c52	src/agent/plugin-activation-handler/composite-activation.ts
 252	34f4aac7e9f3	src/agent/plugin-activation-handler/handler.ts
  48	e29ca87ad1f2	src/agent/plugin-activation-handler/index.ts
 119	470ff9814cd7	src/agent/plugin-activation-handler/types.ts
  55	c330cfb6ad36	src/agent/plugin-app-resolver/app-resolver.ts
 135	4dfca277c6ff	src/agent/plugin-app-resolver/composite-resolver.ts
 165	e141f9c7e2da	src/agent/plugin-app-resolver/file-resolver.ts
 120	d3eb9af041c3	src/agent/plugin-app-resolver/folder-resolver.ts
  95	2838d82010c8	src/agent/plugin-app-resolver/git-resolver.ts
  65	39c0984f07b0	src/agent/plugin-app-resolver/index.ts
 106	93c3edb7bef4	src/agent/plugin-app-resolver/mcp-resolver.ts
  69	971587d439a3	src/agent/plugin-app-resolver/plugin-resolver.ts
  56	35341af0c700	src/agent/plugin-app-resolver/skill-resolver.ts
  57	8b289232ed95	src/agent/plugin-app-resolver/subagent-resolver.ts
  96	d668a4ae7e51	src/agent/plugin-app-resolver/thread-resolver.ts
  54	d27d17743d74	src/agent/plugin-app-resolver/types.ts
 106	d68109d6e432	src/agent/plugin-discovery/discovery.ts
  54	16634bdc1f27	src/agent/plugin-discovery/in-memory-registry.ts
  33	3e93d30d535d	src/agent/plugin-discovery/index.ts
 195	3b82b7534c67	src/agent/plugin-discovery/parser.ts
 141	027bc418dc3e	src/agent/plugin-discovery/types.ts
  33	79bc62eeb893	src/agent/plugin-mcp-launcher/index.ts
 129	0eaa4437d107	src/agent/plugin-mcp-launcher/isolated-launcher-port.ts
 152	0b491160e042	src/agent/plugin-mcp-launcher/launcher.ts
  77	0f5c5069c724	src/agent/plugin-mcp-launcher/registry.ts
  87	7fc4efd6c257	src/agent/plugin-mcp-launcher/types.ts
 194	84a9ac00cf31	src/agent/plugin-skill-extension/extender.ts
  23	14ab7fc788ce	src/agent/plugin-skill-extension/index.ts
  79	abfe64c8c218	src/agent/plugin-skill-extension/types.ts
  87	9e58aafa953d	src/agent/primary-rail/index.ts
 541	f7e0bea26798	src/agent/prompt-body.ts
 197	d0db8b94613f	src/agent/prompt-directives.ts
  35	c099db293174	src/agent/prompt-graph/all-atoms.ts
 514	00c8ef2632d2	src/agent/prompt-graph/atoms-body.ts
 174	a66cc8474707	src/agent/prompt-graph/atoms-dynamic.ts
 139	e3aff6815901	src/agent/prompt-graph/atoms-notices.ts
 394	9a6506ace868	src/agent/prompt-graph/atoms.ts
 155	5875f2b0284e	src/agent/prompt-graph/contexts.ts
  46	d1b13364797b	src/agent/prompt-graph/index.ts
  76	bebbec8a1f7a	src/agent/prompt-graph/matches.ts
  54	c41e85495a97	src/agent/prompt-graph/render.ts
  51	43e56b0e850f	src/agent/prompt-graph/shared.ts
 265	4b08af4147bc	src/agent/prompt-graph/types.ts
 669	c821f93c9261	src/agent/prompt-graph/verify.ts
 333	7995643e2ecd	src/agent/prompt-reminders.ts
  18	7a43e371e60a	src/agent/prompt-rules/assistant.ts
  34	fe7ba2669d4f	src/agent/prompt-rules/benchmark.ts
  88	31519942a383	src/agent/prompt-rules/core.ts
 121	58a831f37537	src/agent/prompt-rules/index.ts
  41	c3f33ae55ef3	src/agent/prompt-rules/pr-agent.ts
  26	49566bb71c15	src/agent/prompt-rules/task-runner.ts
  71	02b37c213e61	src/agent/prompt-rules/verify-strategy.ts
 194	040975d24c92	src/agent/prompt-sections.ts
 137	618ce26c3736	src/agent/prompt-style.ts
  38	afed91cc2d52	src/agent/prompt-suggestion/index.ts
 121	efa7c90672e5	src/agent/prompt-suggestion/orchestrator.ts
 144	68848a2169d4	src/agent/prompt-suggestion/reject-gate.ts
  95	a80a7ab5e405	src/agent/prompt-suggestion/sanitize.ts
  32	d03a595e3005	src/agent/prompt-suggestion/suppression.ts
 146	6103cba9d36c	src/agent/prompt-suggestion/types.ts
 854	d685d57cc5e4	src/agent/prompt.ts
  93	ad4f8139b398	src/agent/radar-producer-hook.ts
  13	7e663646bf7f	src/agent/recovery-reason/index.ts
 116	fcba03998b3b	src/agent/recovery-reason/types.ts
 479	0c9e2c8732ea	src/agent/recovery.ts
  39	2a88f227d6bf	src/agent/refusal-fallback.ts
  82	84c980d0c877	src/agent/repair-escalation.ts
 254	19e6f5a5553f	src/agent/repo-rules.ts
 103	87cb8ff96575	src/agent/repro-doubt-guard.ts
 388	f7665d521482	src/agent/repro-test/execute.ts
 614	2b50155c1865	src/agent/repro-test/generate.ts
 356	ce2db39fd9c8	src/agent/repro-test/grounding.ts
  50	9d56f3cbdb68	src/agent/repro-test/index.ts
 159	65833c5cec19	src/agent/repro-test/pytest-report.ts
  52	086c399f14ec	src/agent/repro-test/scaffold-patterns.ts
 295	d5a0caa4958f	src/agent/repro-test/select.ts
 219	e4ebae9f4426	src/agent/repro-test/types.ts
  91	fd53df5ce6ff	src/agent/repro-test/vote.ts
 189	3d4495b8aa63	src/agent/retry-pretry.ts
 329	b01b92b28370	src/agent/retry.ts
 157	da181e116de9	src/agent/reviewer-port.ts
 162	a1e16792994e	src/agent/rewind-capture-feeder.ts
  21	a50614fc9637	src/agent/run-ledger/index.ts
 312	bc6dc344e6e8	src/agent/run-ledger/store.ts
 141	4b5484925b71	src/agent/run-ledger/types.ts
  24	7921e9c88418	src/agent/run-ledger-attribution/index.ts
 373	8316964e94bf	src/agent/run-ledger-attribution/matchers.ts
 148	5259f4e93f7c	src/agent/run-ledger-attribution/subscriber.ts
 112	28459b3f575b	src/agent/run-ledger-attribution/types.ts
 110	531d0e1c0dd9	src/agent/run-mode/clamp.ts
  32	49c8767e9ccc	src/agent/run-mode/index.ts
  58	2cdd5f2d77ab	src/agent/run-mode/narrow.ts
 211	32f7303f2fdb	src/agent/run-mode/presets.ts
  39	c8c99097c14f	src/agent/run-mode/repo-rules-policy.ts
 184	3b4fa95bfd8d	src/agent/run-mode/types.ts
 537	93fb226b2672	src/agent/sampling-span.ts
  86	c7c62338ae42	src/agent/sandbox-escalation/cap.ts
  26	ab1419c6948a	src/agent/sandbox-escalation/index.ts
 244	8c90d5b2229a	src/agent/sandbox-escalation/orchestrator.ts
 523	8b68181c0f46	src/agent/session-resource-registry/auto-sweep.ts
 140	6e4ec27089f8	src/agent/session-resource-registry/caller-owned-builder.ts
 612	7bbd795ae830	src/agent/session-resource-registry/disk-adapter/disk-store.ts
 493	88c7b17d0967	src/agent/session-resource-registry/disk-adapter/file-lock.ts
 635	cb49faf5c4df	src/agent/session-resource-registry/disk-adapter/gc.ts
 179	7823f934d7e7	src/agent/session-resource-registry/disk-adapter/serializer.ts
 165	5abf2896d5b3	src/agent/session-resource-registry/disk-adapter/types.ts
 221	a749fb540503	src/agent/session-resource-registry/global.ts
 181	086ee3f57710	src/agent/session-resource-registry/in-memory-registry.ts
  89	3cfbd12262b0	src/agent/session-resource-registry/index.ts
 446	91304c482055	src/agent/session-resource-registry/inspector.ts
 433	867a6680dd88	src/agent/session-resource-registry/sqlite-adapter/gc.ts
  18	942fd9cd7b23	src/agent/session-resource-registry/sqlite-adapter/index.ts
 100	735e0651e625	src/agent/session-resource-registry/sqlite-adapter/schema.ts
 186	50956364293b	src/agent/session-resource-registry/sqlite-adapter/serializer.ts
 353	ee0543f1a37c	src/agent/session-resource-registry/sqlite-adapter/sqlite-store/operations.ts
  97	2a99a371f953	src/agent/session-resource-registry/sqlite-adapter/sqlite-store/statements.ts
 122	a54fd27199ff	src/agent/session-resource-registry/sqlite-adapter/sqlite-store.ts
 117	582b30ee4566	src/agent/session-resource-registry/sqlite-adapter/types.ts
 164	2c195d29e48c	src/agent/session-resource-registry/types.ts
 138	4e74f5187312	src/agent/session-resource-registry/unified-api.ts
 386	4b902dcc8c34	src/agent/session-resources.ts
  21	2a4d085d9f25	src/agent/shadow-verify/index.ts
 142	8670bf6bf24d	src/agent/shadow-verify/runner.ts
  81	b6cc2e59e413	src/agent/shadow-verify/types.ts
 107	4182b6bd0071	src/agent/shadow-verify-adapters/apply-v4a.ts
 360	4c1f5a1848fe	src/agent/shadow-verify-adapters/check-lsp-test.ts
  39	661c59b075e4	src/agent/shadow-verify-adapters/index.ts
  60	ed42733c7a1b	src/agent/shadow-verify-adapters/scratch-worktree.ts
 192	503cea18d2b2	src/agent/shell-snapshot-session.ts
 164	0920ea6a5b56	src/agent/side-agent-runner.ts
  88	67c82a0624f1	src/agent/side-conversation/dispatch.ts
  43	fcb145e2efc3	src/agent/side-conversation/index.ts
  69	824c41494a84	src/agent/side-conversation/prompt.ts
 550	751a1204fd44	src/agent/side-conversation/run.ts
 259	77999743902d	src/agent/skill-mcp-attach-adapter.ts
  96	4bf6bb416545	src/agent/skill-mcp-wire.ts
 184	d1ca4ee8c930	src/agent/skill-scope-escalation.ts
  36	76972afd26dd	src/agent/span-content-redact.ts
 211	939fedc79dce	src/agent/spawn-depth-telemetry.ts
 124	cda4ba2d358d	src/agent/spawn-depth.ts
  73	7d954fe4eb2b	src/agent/spawn-projection.ts
  88	401c652cef70	src/agent/startup-prewarm.ts
 142	a74603f65ca9	src/agent/state.ts
  46	fd351c4658d1	src/agent/steer-reasons.ts
 295	7ee4f0b88c11	src/agent/steering.ts
  60	4c68ef34b5d8	src/agent/sticky-model/default-store.ts
 392	02f7ee1f6ad7	src/agent/sticky-model/fs-backed-store.ts
  30	1fcd714e6930	src/agent/sticky-model/index.ts
 153	99d405af544f	src/agent/sticky-model/key-codec.ts
 170	068ac71b550b	src/agent/sticky-model/port.ts
  40	da3a50e2238f	src/agent/sticky-model/resolver.ts
 164	8719501f359d	src/agent/sticky-model/session-scoped-store.ts
 543	f09e7b58d681	src/agent/stop-category.ts
  77	713bb2b44d09	src/agent/stop-reason/default-policy.ts
  17	8c2559ae3f57	src/agent/stop-reason/index.ts
  22	145da84d13c0	src/agent/stop-reason/no-op-policy.ts
  35	c91a99a46bfa	src/agent/stop-reason/port.ts
  85	469da4db1eab	src/agent/stop-reason/types.ts
 567	5be3408ed5b7	src/agent/stream-callbacks.ts
 227	e73f5ace3cc5	src/agent/stream-timeout/default-watchdog.ts
  18	97a554cc187b	src/agent/stream-timeout/index.ts
  19	fa48e948042c	src/agent/stream-timeout/metric-port.ts
  16	ce5db9d0195a	src/agent/stream-timeout/no-op-metric.ts
  18	bebf448f129a	src/agent/stream-timeout/no-op-watchdog.ts
  22	71cf1ce34e83	src/agent/stream-timeout/port.ts
  44	fc838c6360a2	src/agent/stream-timeout/snooze.ts
  67	b49cd879e9e4	src/agent/stream-timeout/types.ts
 352	27ccf5a25c6c	src/agent/streaming-boomerang/default-streamer.ts
  30	df99b065eb03	src/agent/streaming-boomerang/index.ts
  76	1cb3e6831cc5	src/agent/streaming-boomerang/port.ts
 124	110bdd17ea62	src/agent/streaming-boomerang/types.ts
 300	cf562cdd23fb	src/agent/streaming-cancellation/default.ts
  30	6468dc790be3	src/agent/streaming-cancellation/index.ts
 193	7e62cfdceed5	src/agent/streaming-cancellation/llm-stream-cancel.ts
 203	fe93d90b9e9e	src/agent/streaming-cancellation/types.ts
 675	49afd36a3622	src/agent/streaming-dispatch.ts
 340	fbbd7fa39d0c	src/agent/subagent-background/engine.ts
 250	f923e8383f9e	src/agent/subagent-background/methods.ts
 546	23eb2db4c6d4	src/agent/subagent-background.ts
 189	619d22c0b4c0	src/agent/subagent-control-endpoint.ts
 598	08ae910438cf	src/agent/subagent-delivery/controller.ts
  41	b8c8147449df	src/agent/subagent-delivery/index.ts
 109	ae71fccc811d	src/agent/subagent-delivery/ports.ts
 124	e86de0e00c06	src/agent/subagent-delivery/target-resolver.ts
 208	f26a4986a7de	src/agent/subagent-delivery/types.ts
  41	1df3f2d36342	src/agent/subagent-mailbox/index.ts
 125	69fb4a608afb	src/agent/subagent-mailbox/peer-inbox.ts
 584	de7c6e239220	src/agent/subagent-mailbox/store.ts
 148	11ebaecc1932	src/agent/subagent-mailbox/surface-notify.ts
 142	58a56895539a	src/agent/subagent-mailbox/team-scoped.ts
 164	869869c06db8	src/agent/subagent-mailbox/types.ts
 593	f2324da147b5	src/agent/subagent-persistence-store/hydrating-scheduler.ts
  23	ae1370d374f4	src/agent/subagent-persistence-store/index.ts
 402	6bb3dcde1039	src/agent/subagent-persistence-store/jsonl-store.ts
 132	00142a56b6e3	src/agent/subagent-persistence-store/types.ts
  74	f3ac8ae1c0ff	src/agent/subagent-persistence.ts
 136	338580e9dc11	src/agent/subagent-resume/idempotency.ts
  60	7d28c5e1353b	src/agent/subagent-resume/index.ts
 115	0656983290c1	src/agent/subagent-resume/policy.ts
 263	7ebbe25ee6be	src/agent/subagent-resume/replay.ts
 502	a7631154e9a7	src/agent/subagent-resume/resumer.ts
 295	d53987ca43ea	src/agent/subagent-resume/tool-history.ts
 297	5117947deae0	src/agent/subagent-resume/tool-replay.ts
 356	d2259d84b9eb	src/agent/subagent-runner-child-config.ts
  82	2ed51af779c9	src/agent/subagent-runner-identity.ts
  64	47ace2acd094	src/agent/subagent-runner-lineage.ts
 203	9ca947741b17	src/agent/subagent-runner-obs-projection.ts
  97	94d905af5064	src/agent/subagent-runner-overrides.ts
  26	0f226ed77827	src/agent/subagent-runner-team.ts
  77	727f01948fe6	src/agent/subagent-runner-waker.ts
 573	c0f597835ac7	src/agent/subagent-runner.ts
  27	771696ed2793	src/agent/subagent-tool-namespace.ts
  78	21b022f844fc	src/agent/subagent-typed/boomerang.ts
 324	48d4313f20e7	src/agent/subagent-typed/delegation-router.ts
  42	9e465b77ee68	src/agent/subagent-typed/index.ts
  62	1a8bd09302f1	src/agent/subagent-typed/isolated-context.ts
  97	4dd103dbfa7d	src/agent/subagent-typed/mode-registry.ts
 186	368acaecc00e	src/agent/subagent-typed/port.ts
 222	99944223ba13	src/agent/submission.ts
   9	ea8ad1692d3a	src/agent/surface-ports/index.ts
  88	f59b0540e75f	src/agent/surface-ports/port.ts
 173	1590b50dcba8	src/agent/surface-profile.ts
  46	83410502cacc	src/agent/synthetic-user.ts
 178	27919693b245	src/agent/system-prompt/default-builder.ts
  19	d2d8d8b8a66f	src/agent/system-prompt/index.ts
  40	7f7166e3b5bf	src/agent/system-prompt/mode-variants.ts
  95	5db09afa3b02	src/agent/system-prompt/port.ts
   9	70287b64e100	src/agent/thin-client-dispatch/index.ts
  59	fdfffa29e057	src/agent/thin-client-dispatch/types.ts
 159	2c8600c10a92	src/agent/thread-follower/approval-coordinator.ts
  89	3845c853b83c	src/agent/thread-follower/dispatch.ts
  39	f5ed82084878	src/agent/thread-follower/index.ts
 166	ec4070c7e74d	src/agent/thread-follower/timeout.ts
 222	1fe25f16e502	src/agent/thread-follower/types.ts
 110	59ead5889fc4	src/agent/thread-rollback-checkpoint.ts
 327	0ad6b9582644	src/agent/thread-rollback.ts
  52	273d2e0a758b	src/agent/thread-tools/composer.ts
 133	e834e49f7bfa	src/agent/thread-tools/in-memory-store.ts
  13	bdf848d09b9a	src/agent/thread-tools/index.ts
  86	0b5ffb4b7d98	src/agent/thread-tools/lazy-resolver.ts
  42	ee01684ab6c5	src/agent/thread-tools/port.ts
  79	bceff7e0dfdf	src/agent/thread-tools/types.ts
 246	3238e13bb57e	src/agent/tier1/advisor.ts
  52	02bdc27c7f52	src/agent/tier1/appshot.ts
  24	805e71d82f86	src/agent/tier1/auto-classifier.ts
  22	c00e7cd315bc	src/agent/tier1/branch-search.ts
  58	bae8d557e2d9	src/agent/tier1/browser.ts
  35	440bff801c1a	src/agent/tier1/budget.ts
  62	e8161f0ebf32	src/agent/tier1/check-secrets.ts
  35	f98700f319ce	src/agent/tier1/compose-authoring.ts
  51	3af62cd5fe27	src/agent/tier1/delegate.ts
  23	06c7839e8ad4	src/agent/tier1/enter-plan.ts
  16	6f279b32908e	src/agent/tier1/fork-session.ts
  62	d3a82fad6695	src/agent/tier1/index.ts
 373	916cd36966ad	src/agent/tier1/objective-judge-observer.ts
  37	cfdfd5f2cccc	src/agent/tier1/objective.ts
  29	15f56a8da30f	src/agent/tier1/plan-exit.ts
  25	7b25c564ad91	src/agent/tier1/plan-mutation.ts
  37	ee2797c186a6	src/agent/tier1/pr-ship.ts
  23	dcfe22d98ea1	src/agent/tier1/prompt-cache.ts
  66	223e42c395de	src/agent/tier1/reflect.ts
 342	4bbb6fe4f978	src/agent/tier1/reviewer-subagent.ts
  30	1e64365e1ac0	src/agent/tier1/shadow-verify.ts
  16	d8457243d39f	src/agent/tier1/shadow.ts
  38	b3dfa076a4e8	src/agent/tier1/side-agent.ts
 311	6d0547f2458a	src/agent/tier1/skill.ts
  72	39f075684c1f	src/agent/tier1/subagent-batch.ts
  43	6b9e2835d371	src/agent/tier1/subagent-bg.ts
 178	ff242bdf4efe	src/agent/tier1/subagent-introspect.ts
  47	84522292b044	src/agent/tier1/subagent-mailbox.ts
 514	3af51c5d2bf1	src/agent/tier1/subagent.ts
  33	418e3e25894c	src/agent/tier1/team.ts
  62	db287527eaf2	src/agent/tier1/user-input.ts
  19	efe90fa9201f	src/agent/tier1/web-search.ts
  34	e0090ca84ac4	src/agent/tier1/working-state.ts
  25	a17d377726de	src/agent/tier1/worktree.ts
 215	47a86918a286	src/agent/todo-readback/default-store.ts
  28	b5716c361f94	src/agent/todo-readback/index.ts
  95	76d722597e0d	src/agent/todo-readback/port.ts
  39	8bdaed6655bf	src/agent/todo-readback/types.ts
  76	36b4c142f780	src/agent/token-delta/counter.ts
  88	c751cfdfeb6b	src/agent/token-delta/wm-decorator.ts
 170	88509e97c7df	src/agent/tool-choice.ts
  83	58577d57db49	src/agent/tool-input-streaming.ts
  66	6dc2082d1239	src/agent/tool-matchers.ts
  15	917e6a6d5fac	src/agent/tool-profile/index.ts
  92	eee562268f7c	src/agent/tool-profile/port.ts
 116	b0fe1813a902	src/agent/tool-profile/presets.ts
  37	2b5186963489	src/agent/tool-profile/registry.ts
  84	3fa3c4ad0658	src/agent/tool-profile/resolver.ts
 178	ac30c3939bfb	src/agent/tool-result-evict/evict.ts
  13	12e0c61513c5	src/agent/tool-result-evict/index.ts
  82	7edd750b8f22	src/agent/tool-result-evict/spill-adapter.ts
  94	38ac947ae47e	src/agent/tool-result-evict/types.ts
 103	ebc836429e6a	src/agent/turn-closeout.ts
 268	6e63fa46ed5a	src/agent/turn-context.ts
 180	985e3ebeeea4	src/agent/turn-diff/index.ts
 148	112d60cb4d98	src/agent/turn-kind.ts
 140	f5a2789a696c	src/agent/turn-registry-snapshot.ts
 192	c4cf4cb7dbf4	src/agent/types/agent-capabilities.ts
 135	927141e87904	src/agent/types/agent-outcome.ts
 149	5e77a2f9617f	src/agent/types/compaction-config.ts
 138	69837a476c01	src/agent/types/memory-config.ts
  19	061248b52205	src/agent/types/rules-config.ts
 379	4a849334125f	src/agent/types/wire-slots-compose.ts
 555	d5738580e8f2	src/agent/types/wire-slots-core.ts
 539	cd8370bbe12b	src/agent/types/wire-slots-runtime.ts
 644	17ef420d9225	src/agent/types/wire-slots-session.ts
 879	4993043ece61	src/agent/types.ts
  26	01373972262f	src/agent/untrusted-envelope/gate.ts
  21	2bfcf3a8d99f	src/agent/untrusted-envelope/index.ts
  35	56216164e899	src/agent/untrusted-envelope/rule.ts
  59	5324d5e7f7a3	src/agent/untrusted-envelope/types.ts
 105	04c534ca4dba	src/agent/untrusted-envelope/wrap.ts
  14	107a7169b0ab	src/agent/untrusted.ts
  11	3429840ba2d8	src/agent/user-question/index.ts
  21	7c59d28819f2	src/agent/user-question/task-correlation.ts
  97	4521950898a3	src/agent/user-question/tool-adapter.ts
  87	46b9ccbc9022	src/agent/verification-bundle/authority.ts
  34	ff0a6e74403c	src/agent/verification-bundle/index.ts
  13	457d4dafe5bf	src/agent/verification-bundle/resolved-kofn.ts
 216	7b15184b1c2c	src/agent/verification-bundle/score.ts
 164	afc9e86cfd44	src/agent/verification-bundle/select-lexicographic.ts
 104	4e3773a5488f	src/agent/verification-bundle/types.ts
 176	67207daff161	src/agent/verification-plan/build.ts
 187	851e93ab3581	src/agent/verification-plan/extract-issue-declared-expected.ts
 134	c9b8f2748ca0	src/agent/verification-plan/extract-issue-repro.ts
  26	98885baa9075	src/agent/verification-plan/index.ts
 104	601a27538ce2	src/agent/verification-plan/types.ts
  60	bd5705efc170	src/agent/verify-checkpoint-bridge.ts
 487	e3062fbe9be4	src/agent/verify-guard.ts
 280	b7c19047e0a5	src/agent/verify-signal.ts
 265	006716f162d2	src/agent/work-metrics-collector.ts
  53	3236f0d09c96	src/agent/workflow-agent-adapter.ts
  86	b2ae43cc06fb	src/agent/workflow-keyword.ts
 179	a7aa4f77e5b8	src/agent/working-state.ts
  58	bed59b264cf0	src/agent/worktree-slot.ts
  94	81df784a3574	src/activity/index.ts
 163	ef0150e55fdc	src/activity/producers/fleet.ts
  62	204cc98909e4	src/activity/producers/side-agent.ts
 155	0e2cd2b0fc2d	src/activity/producers/workflow.ts
 192	93e0846b5ea0	src/activity/producers/worktree.ts
  70	92fa2eaba2f6	src/activity/progress.ts
 123	bb148c25826c	src/activity/project.ts
 120	29b6524a2458	src/activity/render.ts
 274	fd4f685d3584	src/activity/spine.ts
 250	7aef1d143e89	src/activity/store.ts
 177	3cf151f8f1c1	src/activity/subscription.ts
 217	6b90fbf67676	src/activity/types.ts
  10	6dfea79ea2fd	src/attention/index.ts
  40	92a8a7e76814	src/attention/model.ts
  57	f54ee0e68f55	src/attention/resolver.ts
 136	6ab102faeedc	src/objective/attempt.ts
  70	fd34fe9cf26a	src/objective/authority-core-adapter.ts
  76	956d9a546cbd	src/objective/authority-hydration.ts
 904	a08b1acde104	src/objective/authority.ts
  51	f346921dd440	src/objective/blocker-dependency.ts
  83	cf908ec2f0e6	src/objective/blocker-observation.ts
  44	1dda42e17120	src/objective/budget-limits.ts
 145	0ae8d5304d00	src/objective/capabilities.ts
 304	a22edc7ca16b	src/objective/continuation.ts
 392	ac46a0f83cf8	src/objective/core-store/cell.ts
 103	bcbf4a2a9534	src/objective/core-store/completion-ops.ts
 199	02180374f4e8	src/objective/core-store/criteria-ops.ts
  29	2ee4cac6dc74	src/objective/core-store/ctx.ts
 137	d5b78a3476ae	src/objective/core-store/objective-ops.ts
 395	ef7e30b943be	src/objective/core-store/rehydrate.ts
  90	92b052991f66	src/objective/core-store/snapshot-ops.ts
   3	ec776fe2dd0e	src/objective/criteria/defaults.ts
 249	ec675372e3b1	src/objective/criteria/model.ts
 151	d6dd6658591f	src/objective/criteria/ports.ts
 117	4c6d0a4ff95d	src/objective/criteria/verifier.ts
  49	8464a9d22813	src/objective/freshness.ts
  14	6261f2a3b60f	src/objective/goal-preset.ts
 606	437210507344	src/objective/goal-wake-controller.ts
 367	d627a99c6a31	src/objective/goal-wake-host.ts
 170	c0abfad936f0	src/objective/goal-wake-policy.ts
  62	5acb9c2efec1	src/objective/identity.ts
 264	103370ffbac1	src/objective/index.ts
  63	5841e86eafe6	src/objective/lifecycle-telemetry.ts
  61	4a0f76696108	src/objective/model.ts
 169	ec16578cdc54	src/objective/mutations.ts
 294	fda24b443bbd	src/objective/policy.ts
 215	d35f9f66f09d	src/objective/ports.ts
 110	aeeb15e0d3f0	src/objective/progress-receipt.ts
  30	c0b8bd07a570	src/objective/provenance.ts
  64	3a1f7722e361	src/objective/pursuit-prompt.ts
 173	56c6b633d2ce	src/objective/store.ts
 231	e0ec6c8e6cab	src/objective/types.ts
  95	a2d6571a800f	src/objective/usage-limit-wire.ts
 110	e6276427f3c6	src/objective/verification-batch.ts
```

DONE
