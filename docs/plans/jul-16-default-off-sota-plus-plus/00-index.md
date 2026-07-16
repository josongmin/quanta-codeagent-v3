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
| [DOF-15](tickets/DOF-15-per-tool-record-consumer.md) | P2 | blocked | DOF-00 | per-tool snapshot lifecycle |
| [DOF-20](tickets/DOF-20-strong-a-default-flip-tranche.md) | P1 | in_progress | DOF-00, DOF-01 | subprocess/inheritance proof harness delivered (6 pass); tranche-1 at safe ceiling, no unsafe flip |
| [DOF-21](tickets/DOF-21-weak-a-loop-proof-repair.md) | P1 | in_progress | DOF-00 | 5 real-loop proofs landed (run-workflow, budget-ledger, subagent role/introspect, language-detect); more WEAK rows remain |
| [DOF-22](tickets/DOF-22-behavioral-default-ab.md) | P1 | blocked | DOF-00, DOF-21 | paired A/B default decisions |
| [DOF-30](tickets/DOF-30-stub-kill-or-wire.md) | P1 | in_progress | DOF-00 | recovery-router wired+proven (seam-only→wired, decision repair-first); lane-manager/bug-fix disposition open |
| [DOF-40](tickets/DOF-40-partial-fail-closed-hardening.md) | P1 | in_progress | DOF-00 | microcompact tuning + vendor-glob consume hardened fail-closed; more families remain |
| [DOF-50](tickets/DOF-50-tauri-promotion-gate.md) | P2 | hold | DOF-10 | external/platform evidence |
| [DOF-90](tickets/DOF-90-closure-audit.md) | P0 | blocked | all non-hold | closure metrics + replay |

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

## Required ticket shape

Each implementation ticket owns one composition root and at most 1-3 features in one gate family. It records exact files, pre-change RED rail, ON real path, explicit-OFF identity, CLI/subagent/web/headless inheritance, permission/HITL preservation, telemetry, and one-feature rollback.

Delete tickets additionally require:

1. bounded production consumer search with zero callers
2. named replacement or `superseded_by` target
3. proof that no unique invariant or supported surface is lost
4. catalog lifecycle update and deletion-reversion RED rail

No `roadmap 없음`, unit-only evidence, or default-OFF label is sufficient for deletion.
