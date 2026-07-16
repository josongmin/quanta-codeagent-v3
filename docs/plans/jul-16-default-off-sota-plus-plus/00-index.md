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
- Open P0: the new authority ledger deterministically covers 175 rows and all 27 live CLI seed gates, but still contains 851 unknown surface cells and 2,354 unknown values. Prior 85/85 and STRONG/MEDIUM/WEAK prose counts remain non-authoritative.

## Ticket board

| Ticket | P | Status | Depends on | Owner seam |
|---|---:|---|---|---|
| [DOF-00](tickets/DOF-00-inventory-and-surface-truth.md) | P0 | in_progress | - | 175-row ledger live; unknown elimination pending |
| [DOF-01](tickets/DOF-01-catalog-parity-and-generated-drift.md) | P0 | in_progress | DOF-00 | known drift fixed; full ledger parity pending |
| [DOF-05](tickets/DOF-05-web-bind-auth-fail-closed.md) | P0 | complete | - | web-daemon bind/auth policy |
| [DOF-06](tickets/DOF-06-distill-redaction-auto-trigger.md) | P0 | complete | - | memory auto-trigger redaction |
| [DOF-10](tickets/DOF-10-web-first-class-surface-closeout.md) | P1 | ready | DOF-05 | web operator flow |
| [DOF-11](tickets/DOF-11-shipping-cli-tool-profile.md) | P1 | complete | - | CLI argv/profile authority |
| [DOF-12](tickets/DOF-12-prompt-suggestion-live-state.md) | P1 | complete | - | prompt suggestion suppression wire |
| [DOF-13](tickets/DOF-13-read-outline-parser-wire.md) | P1 | complete | - | read-tool parser composition |
| [DOF-14](tickets/DOF-14-playbook-registry-dispatch.md) | P1 | complete | - | playbook registry + dispatch |
| [DOF-15](tickets/DOF-15-per-tool-record-consumer.md) | P2 | blocked | DOF-00 | per-tool snapshot lifecycle |
| [DOF-20](tickets/DOF-20-strong-a-default-flip-tranche.md) | P1 | blocked | DOF-00, DOF-01 | safe availability leaf tranches |
| [DOF-21](tickets/DOF-21-weak-a-loop-proof-repair.md) | P1 | blocked | DOF-00 | proof repair leaf tickets |
| [DOF-22](tickets/DOF-22-behavioral-default-ab.md) | P1 | blocked | DOF-00, DOF-21 | paired A/B default decisions |
| [DOF-30](tickets/DOF-30-stub-kill-or-wire.md) | P1 | in_progress | DOF-00 | one stale catalog duplicate removed; code dispositions pending |
| [DOF-40](tickets/DOF-40-partial-fail-closed-hardening.md) | P1 | blocked | DOF-00 | owner-local partial hardening |
| [DOF-50](tickets/DOF-50-tauri-promotion-gate.md) | P2 | hold | DOF-10 | external/platform evidence |
| [DOF-90](tickets/DOF-90-closure-audit.md) | P0 | blocked | all non-hold | closure metrics + replay |

## Current receipts

Truth is the current working tree over `896b0ae86`; no commit receipt is claimed.

- Focused owner and cross-owner batches: 319 pass, 0 fail across web, memory, CLI profile, prompt suppression, read outline, playbook registry, and real queue dispatch.
- Source typecheck: `bun run typecheck` exit 0.
- Structural ratchet: `bun test tests/unit/god-code-ratchet.test.ts` 6 pass, 0 fail.
- Authority ledger: 175 eligible rows, 27 runtime CLI seeds, 4 anti-vacuum/parity tests GREEN; unknown counts remain explicit and block DOF-00 closure.
- Catalog: `bun fc validate`, `bun fc check-evidence`, `bun fc build`, and `bun fc diff` all exit 0 for 1,026 features after removing the superseded `glob-tool` row.
- Safe-default audit: five CLI-effective-ON candidates are retained (`BRACKETED_PASTE`, `AT_AUTOCOMPLETE`, `PREFLIGHT_CHECK`, `COVERAGE_TOOL`, `PROMPT_CACHE_STATUS`); no additional flip is allowed until subprocess OFF/inheritance/telemetry receipts exist.
- Whole-tree typecheck remains RED on pre-existing/concurrent test-shape errors outside these owner seams; it is not promoted to a completion receipt.

## Required ticket shape

Each implementation ticket owns one composition root and at most 1-3 features in one gate family. It records exact files, pre-change RED rail, ON real path, explicit-OFF identity, CLI/subagent/web/headless inheritance, permission/HITL preservation, telemetry, and one-feature rollback.

Delete tickets additionally require:

1. bounded production consumer search with zero callers
2. named replacement or `superseded_by` target
3. proof that no unique invariant or supported surface is lost
4. catalog lifecycle update and deletion-reversion RED rail

No `roadmap 없음`, unit-only evidence, or default-OFF label is sufficient for deletion.
