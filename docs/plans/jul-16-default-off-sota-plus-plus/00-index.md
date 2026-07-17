# Default-OFF SOTA++ execution board (SSOT)

**Truth snapshot:** `896b0ae86` + working-tree audit corrections, 2026-07-16
**Execution authority:** this board, its ledger, and linked leaf tickets
**Supporting inventory:** [../../analysis/jul-16-default-off-gate-inventory.md](../../analysis/jul-16-default-off-gate-inventory.md)
**Superseded plan:** [../jul-16-gate-flip-campaign.md](../jul-16-gate-flip-campaign.md) is historical input, not execution authority.

## Objective

Make nearly every non-external capability usable without deleting unique dormant work:

- at least 90% of the eligible denominator ends as `default_on`, `resource_on`, or `policy_gated_live`
- `ambiguous`, `unknown_default`, and unowned dispositions end at zero
- behavior-changing defaults require paired A/B proof
- high-risk, mutating, network, credential, and provider-cost features remain explicit opt-in but first-class and discoverable
- deletion requires a proven duplicate/supersession, not merely zero current callers

Eligible denominator = all catalog rows minus `external_blocked`, `platform_unavailable`, `proven_duplicate`, and pure documentation/forward-contract rows. DOF-00 freezes the exact count.

## Audit status

- Resolved: web daemon defaults to loopback; wildcard binds require auth or an exact insecure acknowledgement.
- Resolved: shipping `--tool-profile` consumes and validates its value before bootstrap without prompt leakage.
- Resolved: prompt suggestion reads live plan, provider-rate-limit, elicitation, and permission state and suppresses on unknown state.
- Resolved: read outline receives the production tree-sitter adapter only under its own gate.
- Resolved: playbook trigger loads a confined disk registry and reaches the real external prompt queue.
- Resolved: known catalog truth drift is corrected and `bun fc diff` is GREEN.
- Resolved: authority ledger is fully populated — 173 eligible rows, all 27 live CLI seed gates, `unknown_surfaces=0`, one residual `unknown` proof tier (`bench-find-refs-steer` has no ON-path test). Prior 85/85 and STRONG/MEDIUM/WEAK prose counts remain non-authoritative and are not imported.
- Denominator correction: the frozen 175 was pre-fold; the current deterministic catalog yields **173**. `per-tool-granular-registry` is superseded by `surface-wire-r2` (same `QUANTA_PER_TOOL_RECORD` owner) and `lane-manager-parallel` is no longer a catalog row (uncatalogued fold) — both dropped from the eligible set. Working-tree label drift that had stripped `default-off` from `surface-wire-r2` and `recovery-router-codex-spec` (HEAD carried it) was restored from the committed source of truth.

## Ticket board

| Ticket | P | Status | Depends on | Owner seam |
|---|---:|---|---|---|
| [DOF-00](tickets/DOF-00-inventory-and-surface-truth.md) | P0 | complete | - | 173-row ledger, 0 unknown surfaces, hellgate 4/0, red-on-injection pinned |
| [DOF-01](tickets/DOF-01-catalog-parity-and-generated-drift.md) | P0 | complete | DOF-00 | fc validate/check-evidence/build/diff all exit 0; `diff: no changes` on 1021 features |
| [DOF-05](tickets/DOF-05-web-bind-auth-fail-closed.md) | P0 | complete | - | web-daemon bind/auth policy |
| [DOF-06](tickets/DOF-06-distill-redaction-auto-trigger.md) | P0 | complete | - | memory auto-trigger redaction |
| [DOF-10](tickets/DOF-10-web-first-class-surface-closeout.md) | P1 | complete | DOF-05 | authed e2e: session→turn→approval→observability→canvas on one real WS, 7 pass |
| [DOF-11](tickets/DOF-11-shipping-cli-tool-profile.md) | P1 | complete | - | CLI argv/profile authority |
| [DOF-12](tickets/DOF-12-prompt-suggestion-live-state.md) | P1 | complete | - | prompt suggestion suppression wire |
| [DOF-13](tickets/DOF-13-read-outline-parser-wire.md) | P1 | complete | - | read-tool parser composition |
| [DOF-14](tickets/DOF-14-playbook-registry-dispatch.md) | P1 | complete | - | playbook registry + dispatch |
| [DOF-15](tickets/DOF-15-per-tool-record-consumer.md) | P2 | complete | DOF-00 | bounded retention (call-index LRU + teardown clear) + producer-only inspection; OFF wraps zero tools; 11 pass |
| [DOF-20](tickets/DOF-20-strong-a-default-flip-tranche.md) | P1 | in_progress | DOF-00, DOF-01 | subprocess/inheritance proof harness delivered (6 pass); tranche-1 at safe ceiling, no unsafe flip |
| [DOF-21](tickets/DOF-21-weak-a-loop-proof-repair.md) | P1 | in_progress | DOF-00 | 12+ real-loop proofs landed (run-workflow, budget-ledger, subagent role/introspect, language-detect, automation, debug-tracer, branch-search, adaptive-thinking, session-effort, context-1m, reasoning-carryover, edit-repair); remaining rows are MEDIUM-tier |
| [DOF-22](tickets/DOF-22-behavioral-default-ab.md) | P1 | in_progress | DOF-00, DOF-21 | local regression A/B harness delivered (runPairedAB, 10 pass); SWE efficacy rail deferred to operator (preflight/box) |
| [DOF-30](tickets/DOF-30-stub-kill-or-wire.md) | P1 | complete | DOF-00 | disposition sweep of 42 dormant rows: 20 stale ledger reachability corrected seam-only/producer-only→wired (call-site verified), 21 deliberate_hold w/ promotion owner recorded, 0 delete; recovery-router single-authority done; lane-manager/bug-fix moot (source deleted) |
| [DOF-40](tickets/DOF-40-partial-fail-closed-hardening.md) | P1 | in_progress | DOF-00 | 10 families hardened fail-closed: microcompact, vendor-glob, approval-state attribution, command-hook stdin+**exec-throw fail-open FIXED**, compaction race, landlock (fail-open bug fixed), canvas/observability, sendNow, structured-output parity, appshot judge-brand; +212 adversarial tests. Remaining: mid-turn end-to-end wires (composition-root, concurrent-hot) |
| [DOF-50](tickets/DOF-50-tauri-promotion-gate.md) | P2 | hold | DOF-10 | external/platform evidence |
| [DOF-90](tickets/DOF-90-closure-audit.md) | P0 | in_progress | all non-hold | closure snapshot: **150/173 wired (86.7%)**, **zero unknowns** (ambiguous/unknown/unowned=0); 23 dormant = ~18 deliberate_hold + repair-first; gap to 90% = composition-root wires (concurrent-hot) + measure-first efficacy A/B (operator) |

## Current receipts

Truth is the current working tree over `896b0ae86`; no commit receipt is claimed.

- Focused owner and cross-owner batches: 319 pass, 0 fail across web, memory, CLI profile, prompt suppression, read outline, playbook registry, and real queue dispatch.
- Source typecheck: `bun run typecheck` exit 0.
- Structural ratchet: `bun test tests/unit/god-code-ratchet.test.ts` 6 pass, 0 fail.
- Authority ledger: 173 eligible rows, 27 runtime CLI seeds; `bun run tools/feature-catalog/default-off-ledger-checker.ts` → `eligible=173 runtime_cli_seeds=27 unknown_surfaces=0 unknown_values=1`, 0 errors. `bun test tests/unit/default-off-ledger-hellgate.test.ts` → 4 pass / 0 fail (anti-vacuum flipped to the completion invariant `unknown_surfaces===0`; red-on-injection still fails parity for exactly one mutated CLI default).
- Catalog: `bun fc validate`, `bun fc check-evidence`, `bun fc build`, and `bun fc diff` all exit 0 for 1,021 features; `diff: no changes` after regenerating `docs/10.feature-catalog.md`.
- Safe-default audit: five CLI-effective-ON candidates are retained (`BRACKETED_PASTE`, `AT_AUTOCOMPLETE`, `PREFLIGHT_CHECK`, `COVERAGE_TOOL`, `PROMPT_CACHE_STATUS`); no additional flip is allowed until subprocess OFF/inheritance/telemetry receipts exist.
- Whole-tree typecheck remains RED on pre-existing/concurrent test-shape errors outside these owner seams; it is not promoted to a completion receipt.

### Parallel wave receipts (2026-07-16, 6 disjoint owner-seam leaves, base b92b3798f)

All new tests run per-file green in the current working tree (`.ts` confirmed to win bun resolution over the 2501 stale gitignored `.js`, so no shadowing hazard):

- **DOF-30a recovery-router (wire)** — `bun test tests/unit/recovery-router-consumer-wire.test.ts tests/integration/recovery-router-real-loop-e2e.test.ts tests/unit/recovery-router-hellgate.test.ts` → 50 pass / 0 fail. Consumer = `src/agent/recovery.ts:decideTypedStreamError` (wire present in working tree via a concurrent session; UNCOMMITTED). Ledger flipped seam-only→wired, decision repair-first. ⚠️ Open: `not_implemented` now retries wastefully (behavior flip — needs gate-vs-measure decision); RetryingLLM/FallbackLLM decorators still carry independent hardcoded kind sets (single-authority only at the outer stream-error owner).
- **DOF-40 microcompact fail-closed** — `bun test tests/unit/microcompaction-tuning-failclosed-hellgate.test.ts tests/unit/microcompaction-wire-failclosed-hellgate.test.ts` → 12 pass / 0 fail. Invalid tuning ⇒ visible typed refusal (never silent mis-eviction); OFF byte-identical; red-on-injection 7/12.
- **DOF-40 vendor-glob consume fail-closed** — `bun test tests/unit/vendor-glob-unconsumed-failclosed-hellgate.test.ts` → 11 pass / 0 fail. Detected-but-dropped vendor rules now surface via `onUnconsumed` sink (was silent); stays seam-only with promotion owner recorded.
- **DOF-21 proof repair (real-loop)** — run-workflow (`tests/integration/run-workflow-real-loop-e2e.test.ts`, 2 pass), budget-ledger (`…/budget-ledger-real-loop-e2e.test.ts`, 2 pass), subagent-role-identity (`…/subagent-role-identity-real-loop-e2e.test.ts`, 3 pass), subagent-introspect+background (`…/subagent-introspect-background-real-loop-e2e.test.ts`, 2 pass), language-detect (`…/language-detect-turn-context-consumer-e2e.test.ts`, component-chain/wire). Each replaces a fake-runner/helper-only "e2e" and carries a paired control that goes RED on gate/wire removal. Ledger proof tiers upgraded (run-workflow, subagent-introspect → real-loop; language-detect → wire). Existing weak tests flagged for removal (not deleted).
- **DOF-10 web operator flow** — `bun test tests/unit/apps/web-daemon/authenticated-operator-flow-e2e-hellgate.test.ts` → 7 pass / 0 fail. One authed real `Bun.serve` WS: session→turn→approval→observability→canvas all light up; 4 edge cases (disconnect, stale approval id, unauthorized reconnect, dropped canvas) + negative auth control; DOF-05 gate exercised not bypassed. observability-ws-sink proof unit→wire.
- **DOF-20 tranche-1 inheritance harness** — `bun test tests/unit/cli/cli-feature-gate-seed-inheritance.hellgate.test.ts` → 6 pass / 0 fail. Real child+grandchild `bun` process proves unset→seeded-ON, explicit-0 preserved, cross-process inheritance, rollback. Finding: tranche-1 is at its safe ceiling (the 3 qualifying read-only observability gates are already seeded); no safe unseeded flip exists, so no default changed.

Rails after landing: ledger checker `eligible=173 unknown_surfaces=0 unknown_values=1` 0 errors; `default-off-ledger-hellgate` 4/0; `bun fc validate/check-evidence/build/diff` all exit 0, `diff: no changes` (1021 features). god-code ratchet RED is from a concurrent session's `server.ts::startWebDaemon` (+16, not this wave); no new god-function in any of the 6 owned seams.

### Wave A — security-priority (2026-07-17, 5 disjoint owner-seam leaves, base 8a96e4be8)

All new tests per-file green in the current tree (HEAD ff-moved to d9f759ffc mid-run; owned files uncontended). Regression on 10 touched existing suites: 217 pass / 0 fail.

- **DOF-40 approval-state producer (fail-closed attribution)** — `bun test tests/unit/approval-attribution-gap-hellgate.test.ts` → 9 pass. Escalation lifecycle proven live end-to-end (request→pending→settle through real Objective.blockers + RunLedger transitions; was claimed "no producer"); the residual always-confirm path is now fail-closed — an unknown-id terminal mutator surfaces an `ApprovalAttributionGap` via `onUnattributed` instead of silently swallowing the audit trail. `approval-gate-wire` proof unit→real-loop. Residual: the `onUnattributed` sink is a leaf seam, unwired at the composition root (promotion owner = observability-wire/web-daemon).
- **DOF-40 command-hook fail-closed** — `bun test tests/unit/command-hooks-fail-closed-hardening-hellgate.test.ts` → 9 pass. Prompt's "dryRun" spec was wrong (no such field) — NOT invented; hardened the real triple-gate (enabled+ack+bindings) and closed a genuine hole: `serializePayload` wrote unbounded event JSON to the arbitrary-shell child's stdin (only OUTPUT was capped) → now symmetric-bounded. 3 fail-closed controls (empty-ack THROWS before arming, zero-binding disarmed, unset zero-subscription). command-hooks proof unit→wire.
- **DOF-40 compaction attribution race** — `bun test tests/unit/compaction-attribution-race-failclosed-hellgate.test.ts` → 10 pass. `post_compact` provenance carried no turn identity + async emit could resolve past the turn boundary ⇒ mis-attribution/silent drop. Now stamps `attributedTurnId/attributedThreadId` synchronously at emit + surfaces failed attribution via `onAttributionFailure`. compaction-visibility proof unit→wire. Residual: loop.ts injection of `config.run.turn`→`attributedTurnId` still deferred (different owner).
- **DOF-30 recovery-router single-authority COMPLETE** — `bun test tests/unit/retry-decorator-policy-hellgate.test.ts` → 79 pass (247 unit + 38 integration across the family). `RetryingLLM`/`FallbackLLM` decorators no longer carry hardcoded RETRYABLE/FATAL/FALLBACK kind sets — both now derive from `codexSpecRoute` (single table), byte-parity proven for all 18 kinds, red-on-injection ×2. recovery-router-codex-spec proof unit→wire (reachability already wired). Latent divergence preserved+flagged (7 marker-scan kinds retry on message-marker vs the table's hitl/fatal — measure-first, one-line fix pending). NOTE: consumers `src/agent/retry.ts` + `src/llm/fallback.ts` sit just outside the literal `src/llm/retry/**` allowlist (not forbidden) — collision-clean.
- **DOF-40 Landlock/bwrap FAIL-OPEN→FAIL-CLOSED (security bug fixed)** — `bun test tests/unit/os-sandbox-fail-closed-refusal-hellgate.test.ts` → 21 pass + real-bwrap e2e (2 visible Linux-skip on macOS). Found a real security bug: a REQUESTED restrictive sandbox with no backend available **silently ran the command unsandboxed** (`passthrough()` invoked the spawner, tagged `sandboxApplied:false` advisory-only) at the `OsSandbox.spawn()` port for any direct caller. Now returns a typed refusal (exit 126, empty stdout) — command never runs. Compilers byte-identical (no restriction weakened); red-on-injection ×2. Not a ledger row (proof recorded here).

Post-Wave-A rails: ledger checker `eligible=173 unknown_surfaces=0 unknown_values=1` 0 errors; ledger-hellgate 4/0; `fc validate/build/diff` exit 0, `diff: no changes`. Four ledger proof tiers upgraded (approval-gate-wire→real-loop; command-hooks/compaction-visibility/recovery-router→wire).

### Wave B — DOF-40 remaining + DOF-21 remaining (2026-07-17, 5 disjoint leaves, base d9f759ffc → HEAD c2f0dd1c2 concurrent, owned files uncontended)

New tests per-file green; regression on touched suites 70/0.
- **DOF-40 web fail-closed (canvas + observability)** — `canvas-fanout-failclosed-hellgate` 17 pass + `observability-wire-failclosed-hellgate` 9 pass. Canvas fan-out send-throw isolated + surfaced (`onSubscriberError`/`onSendError` seams, was silent starvation); observability partial-wire failure reports `degraded` slot list (was silent-offline). Composition-root observer wiring in server.ts deferred (concurrent-owned) — seams are the deliverable.
- **DOF-40 sendNow lifecycle** — `plan-queue-sendnow-failclosed-hellgate` 32 pass. Added typed `send-not-ready` variant + probe-before-mutate: a send-now in the first-turn timing window now KEEPS the entry + returns explicit not-ready (was silent drop). Web-surface parity still a hold.
- **DOF-40 structured-output provider parity** — `llm-structured-output-anthropic-parity-hellgate` 18 pass. Anthropic adapter now consumes `responseFormat` via the forced-tool builder (was silent no-op; OpenAI-only before); OFF byte-identical vs pre-feature HEAD codec. reachability producer-only→wired.
- **DOF-40 appshot fail-closed** — `appshot-fail-closed-hellgate` 14 pass. Un-forgeable `JUDGE_BRAND` symbol: a pass now REQUIRES a real branded judge verdict (fabricated `{pass:true}` ⇒ typed `refused/unverified_pass`); browser/judge unavailable ⇒ typed refusal (was accidental TypeError-catch); loop bounds [1,8] pinned. Real CDP/judge composition (assembler) still deferred.
- **DOF-21 proofs (real-driver)** — automation-engine (env→assembler→ticker→run-model→AgentLoopPort, 4 pass), debug-tracer (QUANTA_DEBUG→factory→real admissibility decision→real process.stderr, 4 pass), branch-search-progress (real ShadowOdb/git→per-candidate delta→formatter, 3 pass). Each replaces a hand-built-fake test with a gated real driver + paired control. No product bugs; nothing needed expensive infra.

Post-Wave-B rails: ledger `eligible=173 unknown_surfaces=0 unknown_values=1` 0 errors; ledger-hellgate 4/0; `fc validate/build/diff` exit 0 `diff: no changes` (1022 features). Ledger updates: structured-output-mode producer-only→wired + proof→wire; observability-live-wire/appshot-verify-loop proof→wire; automation-engine-wire/branch-search-progress proof→real-loop.

### Wave C — disposition + lifecycle + A/B harness (2026-07-17, 3 disjoint leaves, base c2f0dd1c2)

- **DOF-30 disposition sweep (COMPLETE)** — 42 dormant rows classified. **20 had stale ledger reachability** (`seam-only`/`producer-only`) but real production consumers exist (call-site verified, spot-checked 5/5 by parent): codex-r2-* family (compaction/context/mention/observability/plugin/sqlite/prompt-cache), conflict-parser-lib (git_conflict_inspect tool), effort-classifier, fast-apply-fallback/merge, per-tool-checkpoint-granularity, pre-compact-hitl, ratelimit-dual-window-snapshot, run-ledger-attribution, shadow-verify, subagent-resume-replay, voice-input-stt-slice, ndjson-introspection, codebase-indexer — all corrected to `wired` in the ledger. 21 rows legitimately `deliberate_hold` with promotion owners now recorded in their catalog yaml (bridge-attestation, budget-probe, streaming-boomerang/cancellation, message-batches, model-preset/tag, semantic-search-port, etc.). **0 deletes** (no proven duplicate; board rule: zero-callers alone never justifies deletion). lane-manager + bug-fix-queue are MOOT — their `.ts` source was deleted in a prior commit (only stale gitignored `.js` remain), no catalog/ledger row exists; recommend dropping them from the ticket's named list. Distinction traps correctly held: codex-r2-typed-event-store (slot has no reader), multi-source-rules-vendor-detector (port never injected), semantic-search-port (consumer is empty stub). fc validate + yaml-hellgate exit 0.
- **DOF-15 per-tool snapshot lifecycle (COMPLETE)** — `per-tool-record-lifecycle-hellgate` 11 pass. Found the ADR-0300 store was deleted; real live authority is ADR-0209 `GranularCheckpointPolicy`. Bounded the previously-unbounded call-index counter (LRU cap + reset on `clear()`; teardown now clears ALL producer state — was leaking) + typed `stats()` inspection accessor, classified producer-only (option c: deliberate-hold with bounds). OFF wraps zero tools (referential-identity paired control). No second snapshot authority beside the SHA registry. /rewind-tool RESTORE wire returned as a text follow-up (needs a forbidden composition root).
- **DOF-22 local A/B regression harness (in_progress — regression rail done)** — `ab-default-harness` 10 pass. `runPairedAB(gateEnv, scenario)` runs the same scripted-LLM scenario twice through real `runAgent` (only delta = the gate env via `wireOptionalAgentPorts`), over 8 observable axes → NO-REGRESSION / CHANGED / REGRESSION verdict. Hermetic (no network/box). Self-tests prove CHANGED-detection (red-on-injection: force ON==OFF ⇒ demo goes RED) and non-vacuous NO-REGRESSION (positive control: a real critic firing IS caught). Demonstrated on refusal-fallback (CHANGED) + closeout-critic (NO-REGRESSION, fail-open). Caught + reported a real test-shape bug (toolEvents filtered a non-existent `tool_start` type — the jul-4 bun-typecheck gap). **The EXPENSIVE SWE picks A/B efficacy rail is deliberately NOT run** (operator/box/preflight); this harness clears only the local behavior-regression gate.

Post-Wave-C rails: ledger `eligible=173 unknown_surfaces=0 unknown_values=1` 0 errors; ledger-hellgate 4/0; `fc validate/build/diff` exit 0 `diff: no changes` (1022 features). Ledger updates: 20 reachability corrections (seam-only/producer-only→wired) + per-tool-checkpoint decision→deliberate_hold.

### DOF-90 closure snapshot (2026-07-17, partial — gated tickets still open)

Computed from the authority ledger (173 eligible):
- **USABLE (reachability=wired OR a surface default on/resource): 148 = 85.5%** (target ≥90%).
- **Zero unknowns: 0 rows** have `unknown` in owner_seam/activation/reachability/decision/any surface — the board's "ambiguous/unknown_default/unowned end at zero" requirement is **MET**.
- reachability: wired 148, seam-only 13, producer-only 8, consumer-only 3, forward-contract 1.
- decision: enable-now 55, measure-first 53, repair-first 19, hold 46.
- 25 dormant remainder = 20 `deliberate_hold` (unique parked primitives, promotion owners recorded — kept per the "without deleting unique dormant work" objective) + 5 repair-first (approval-gate-wire, fast-apply-wire, shell-snapshot-runshell-wire, stage1-phase2-consume, compaction-visibility) whose composition-root wiring is deferred.
- **Gap to 90%**: ~8 rows. Requires (a) completing the 5 repair-first composition-root wires (forbidden to leaf agents — needs an owner touching loop.ts/surface-compose/server.ts) and/or (b) the 53 measure-first behavioral flips, which are gated on the DOF-22 **efficacy** rail (operator SWE A/B, not run autonomously). Held rows are intentional and count against the raw %; a closure-state mapping that counts wired-but-held as `policy_gated_live` would raise the effective number.

### Wave D — closure push + adversarial hardening + a real security fix (2026-07-17, 5 leaves + 1 direct fix, base ccb8480b7)

- **DOF-30 shell-snapshot-runshell-wire (truth correction)** — leaf STOPPED on catalog collision but ground-truthed the premise: `runShellWithSnapshot` was never implemented; the feature is ALREADY live via a different architecture (`runtime-context-compose→buildShellSnapshotConfig→turn-iteration capture→shell.ts restore`, gated `QUANTA_SHELL_SNAPSHOT`). Ledger corrected seam-only→wired; the concurrent yaml's "seam-only/zero call sites" hold narrative is stale (flagged for its owner).
- **DOF-30 fast-apply-wire (verified wired)** — 40 pass. Traced end-to-end: `QUANTA_FAST_APPLY`→optional-ports→`ctx.fastApplyFallback`→apply-patch V4A-failure→`fallback.attempt`→applied (real bytes observed, red-on-injection confirmed). Ledger corrected producer-only→wired; hold resolved in the feature yaml.
- **DOF-21 more real-loop proofs** — adaptive-thinking (3), session-effort-wire (4), context-1m-window (5, factory→SDK-client wire), reasoning-carryover (3, two-turn factory wire). edit-repair-loop already had a real-loop e2e. Ledger adaptive-thinking proof→real-loop.
- **DOF-22 behavioral-gate sweep (honest partial)** — `dof22-behavioral-gate-sweep` 9 pass. refusal-fallback clears rail-1 (PASS); closeout-critic partial (recovery axis live, env-gate end-to-end needs the knob-apply seam); **5 gates (cap-enforcer, adaptive-thinking, edit-repair, prompt-directive, delegation-suppress) are UNREACHABLE via the wireOptionalAgentPorts harness** — they ride `runtimeConfig()`/process.env; NOT fabricated a verdict, follow-up = a runtimeConfig-seam paired factory.
- **Adversarial test-hardening (2nd layer)** — 212 pass across command-hooks / landlock / approval-state / recovery-router: property/fuzz invariants, boundary policy-shapes, concurrency/ordering races, adversarial input (injection/binary/unicode/circular), exhaustive-18-kind decorator drive.
- **🔒 REAL SECURITY FIX (command-hook fail-open)** — the hardening pass found that `HookBus.runHandler` catches a throwing handler and continues, so a command-hook exec-adapter throw (EMFILE/OOM/bug) on a deny-capable `pre_tool_use` silently PASSED the guarded tool through (fail-OPEN). **Fixed** in `src/agent/command-hooks/install.ts`: the handler now catches the runner throw and returns an explicit `{deny}` for deny-capable events (fail-CLOSED). New test `command-hooks-exec-throw-failclosed-hellgate` (3 pass) + the D4 tripwire flipped to assert the secure behavior; red-on-injection confirmed (reverting the try/catch → 2 RED). Observer events stay non-fatal.

Post-Wave-D rails: ledger `eligible=173 unknown_surfaces=0 unknown_values=1` 0 errors; ledger-hellgate 4/0; `fc validate/build/diff` exit 0 `diff: no changes` (1024 features); god-code green; command-hooks 97/0. **Closure now 150/173 = 86.7% wired** (+2 truth corrections), zero unknowns holds.

## Required ticket shape

Each implementation ticket owns one composition root and at most 1-3 features in one gate family. It records exact files, pre-change RED rail, ON real path, explicit-OFF identity, CLI/subagent/web/headless inheritance, permission/HITL preservation, telemetry, and one-feature rollback.

Delete tickets additionally require:

1. bounded production consumer search with zero callers
2. named replacement or `superseded_by` target
3. proof that no unique invariant or supported surface is lost
4. catalog lifecycle update and deletion-reversion RED rail

No `roadmap 없음`, unit-only evidence, or default-OFF label is sufficient for deletion.
