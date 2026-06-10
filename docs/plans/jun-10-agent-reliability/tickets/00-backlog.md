# jun-10 Agent Reliability — Ticket Backlog (SSOT)

38 tickets extracted from the FINAL RFCs (one per right-sized workstream). Status: `OPEN` unless noted.
Sizes: S (≤½d), M (~1d), L (multi-day). Posture column = default ON/OFF of shipped behavior.

## Recommended execution order

**Wave 1 (P0):** T-403 → T-401, T-402, T-404 (parallel) → T-405 → T-406 · then T-701 → T-702, T-703 → T-704
**Wave 2 (P1):** T-201, T-202, T-204, T-205 · T-301, T-303, T-304 · T-501, T-505
**Wave 3 (P1 tail / P2):** T-302, T-305, T-203 · T-502, T-503→T-504, T-506, T-507 · T-601..T-604 · T-101→T-102, T-103, T-104, T-105
**Blocked:** T-705 (jun-9 parity Tier B agent-state channel)
**Conditional (no ticket yet):** RFC-01 W5 runtime escalation — opens only with T-102's measurement report attached.

## House constraints (apply to every ticket)

No invented heuristics/thresholds (deterministic or measure-first). New gates via `@/shared` gate vocabulary + knob registry (grep the 3 parallel knob systems first). Write-class mirror rule: **edit / write / apply_patch / scripted_replace / notebook_edit / storage adapters / file-history**. Landed features need feature-catalog entry + ADR per DoD. Default-ON tickets are enumerated in 00-index's posture register — reviewers push back there first.

## Ticket table

| ID | Title | RFC·WS | Pri | Size | Deps | Posture |
|----|-------|--------|-----|------|------|---------|
| T-401 | apply_patch full worktree fence (guard key + write target + jail assert) | 04·W1 | P0 | M | — | ON (bugfix) |
| T-402 | write tool full worktree fence | 04·W2 | P0 | S | — | ON (bugfix) |
| T-403 | scripted_replace stale-guard integration (uncovered BASE tool) | 04·W3 | P0 | M | — | ON (bugfix) |
| T-404 | notebook_edit worktree keying parity | 04·W4 | P0 | S | — | ON (bugfix) |
| T-405 | Manifest-derived write-class structural hellgate | 04·W5 | P0 | M | T-401..404 | test |
| T-406 | Write-path mirror-sweep survey (storage/file-history/checkpoint) | 04·W6 | P1 | M | — | survey |
| T-701 | PreHandoffSummary type + deterministic builder + nextActions registry | 07·W1 | P0 | L | — | ON (additive) |
| T-702 | BudgetExhaustionPolicy dispatch at finish (truth-telling enum) | 07·W2 | P0 | M | T-701 | per-policy |
| T-703 | hand-off-required deniedAction capture | 07·W3 | P0 | S | T-701 | ON (additive) |
| T-704 | CLI checkpoint panel + /state last-summary | 07·W4 | P0 | M | T-701 | ON (render) |
| T-705 | Web push of PreHandoffSummary (BLOCKED: parity Tier B channel) | 07·W5 | P1 | M | T-701, parity-plan | ON when channel lands |
| T-706 | Gated LLM recap layer (QUANTA_PREHANDOFF_RECAP) | 07·W6 | P2 | M | T-701 | OFF |
| T-201 | Prose path-claim audit (extractor + builder + finish-seam annotation) | 02·W1 | P1 | L | — | ON (annotate) |
| T-202 | Verification-claim audit (en+ko anchored registry) | 02·W2 | P1 | M | T-201 (seam) | ON (annotate) |
| T-203 | Claim-trace force-guard in guards/chain.ts (gated) | 02·W3 | P2 | S | T-201, T-202 | OFF |
| T-204 | toolCallId unconditional threading + ToolResultEvidence cross-link | 02·W4 | P1 | M | — | ON (plumbing) |
| T-205 | verify-guard max-trips doc/code reconciliation + drift-pin test | 02·W5 | P1 | S | — | unchanged |
| T-301 | affected_tests tool (convention + import-graph + co-change, attributed) | 03·W1 | P1 | L | — | OFF (QUANTA_AFFECTED_TESTS) |
| T-302 | Post-edit affected-test reminder (edit-class decoration) | 03·W2 | P1 | S | T-301 | OFF (rides W1 gate) |
| T-303 | Paired-file drift guard (manifest↔lockfile mtime snapshot) | 03·W3 | P1 | M | — | ON (advisory, =off killswitch) |
| T-304 | Generated-file edit guard across write class + snapshot-policy prompt line | 03·W4 | P1 | M | T-403 (write-class seam) | ON (warn, =off killswitch) |
| T-305 | edit-repair-loop idleThreshold early-stop (Cursor absorb) | 03·W5 | P2 | S | — | rides existing gate |
| T-501 | detectGitOpState pure probe (rebase/merge/cherry-pick/bisect/revert) | 05·W1 | P1 | S | — | lib |
| T-502 | ADR-0397 env-block wiring closeout + git op-state line | 05·W2 | P1 | M | T-501 | OFF initially (new gate) |
| T-503 | Destructive-helper op-state survey (rewind/file-history/checkpoint) | 05·W3a | P1 | S | T-501 | survey |
| T-504 | Destructive-helper op-state fixes (scoped by T-503) | 05·W3b | P1 | M | T-503 | ON (safety extension) |
| T-505 | Crash-resume workspace fingerprint + resume drift report (mark-time) | 05·W4 | P1 | M | T-501 | rides QUANTA_CRASH_RESUME |
| T-506 | ReadFileState persistence across crash (capability-plumbed, bounded) | 05·W5 | P1 | L | T-505 | rides QUANTA_CRASH_RESUME |
| T-507 | Structured worktree merge-back ({merged, conflicts[]}) | 05·W6 | P2 | M | — | OFF (worktree gating) |
| T-601 | Vendor-collision surfacing (DetectionResult.collisions + panel) | 06·W1 | P2 | S | — | ON (observability) |
| T-602 | Hook identity: registration-API extension + attributed render + events | 06·W2 | P2 | M | — | ON (backward-compat) |
| T-603 | SKILL.md frontmatter validation warnings at discoverSkills | 06·W3 | P2 | M | — | ON (warnings) |
| T-604 | Precedence SSOT docs page (test-cited) | 06·W4 | P2 | S | — | docs |
| T-101 | Routing-quality metric SPEC + annotated fixtures | 01·W1a | P2 | M | — | offline |
| T-102 | Routing-quality analyzer + report command | 01·W1b | P2 | M | T-101 | offline |
| T-103 | Routing smoke scenarios (≥4, replay + judge rubric) | 01·W2 | P2 | M | — | test |
| T-104 | LSP unavailability degrade hints (deterministic fallback naming) | 01·W3 | P2 | S | — | ON (message content) |
| T-105 | Truncation ladder hints + Cursor-grade routing prompt refresh | 01·W4 | P2 | S | T-103 (net) | ON (content) |

## Cross-cutting notes for ticket writers

- T-401..405 must keep the no-worktree path byte-identical **except** T-403's intended stale-deny restoration (its own pinned test + changelog note).
- T-201/T-202's FP-zero bar includes adversarial fixtures (URLs, diff prefixes, version strings) and Korean negation ("확인했지만 실패").
- T-502 includes the gate registration + `--help` + default-OFF decision; flipping ON is a later measured decision.
- T-702 must leave the `BudgetExhaustionPolicy` enum with zero never-read members (implement or delete `ask-user`/`fail-run`).
- Every ticket that lands user-visible behavior cites its RFC's SOTA-alignment section in the PR description (absorb vs exceed posture).
