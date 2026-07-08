# jul-9 Agent Loop Bug Bash

Consolidated tickets from four parallel audit passes over `src/agent/loop/**` and
adjacent hot paths (dispatch, kernel scheduler, host turn-runner, features/SDK
composition, guards/HITL, stream wiring).

**Audit rounds:** silent failures, frustrating wiring, SE debt, test/proof gaps.

## Audit outcome (post two-round adversarial re-verification)

Every ticket's `file:line` claims were re-grounded against current code (line
numbers were NOT trusted — symbols were grep'd), then a second independent pass
tried to flip each verdict. **5 tickets were deleted as not-real** (the cited
code pattern exists, but the causal chain to a defect is broken — defended
elsewhere, unreachable config, or a label that never reaches an artifact):

| Deleted | Why not-real |
|---------|--------------|
| ALBB-01 (dispatch ownership) | `ownershipPolicy` is set only on subagent children, which drop `hooks` — so the pre-hook rewrite channel can never fire on an ownership-bearing config. Structurally unreachable. |
| ALBB-02 (verify-guard phantom) | Verify tools are non-safe → deferred behind the barrier, so a verify entry is never pushed during the stream loop. Tombstone/abort/approval-pause paths all break the chain. |
| ALBB-13 (run.turn stamp) | The dedup gate is default-ON in every reachable config, so no run is ever unstamped. Latent-coupling smell, not a manifesting bug. |
| ALBB-22 (bench diagnostics) | `aborted→timeout` label folds into `empty_patch_other`, not `no_patch_exhausted`; `endReason` never reaches the JSON artifact. No metric corruption. |
| ALBB-23 (SE ratchet) | All 6 files are under the 1000-line ratchet (no violation); the ticket's own acceptance gate is unmeetable by its Required changes (the real ratchet-red is pre-existing bench/terminal churn). |

The surviving **19 tickets were rewritten toward SOTA++**: drifted refs fixed to
verified locations, `Problem` sharpened to quote current code and name the exact
silent/fail-open path, `Required changes` upgraded to fail-closed-by-default +
competitor baseline (Claude Code / Codex / Cursor) + measure-first (no arbitrary
thresholds), and `Proof rails` replaced with red-on-injection / mutation-style
behavioral tests citing real test paths. Several severities were re-graded down
(P0→P1: 03, 04; P1→P2: 05, 08, 10, 11, 14, 15; P2→P3: 18, 21) — no ticket
survived at P0.

## How to use

1. Pick a ticket from the execution order below (or by priority band).
2. Implement the **narrowest owner fix** — one invariant per PR when possible.
3. Land the ticket's **proof rail** before marking done.
4. Report: files changed, proof command output, remaining follow-up.

## Execution order (recommended)

### Wave A — highest-severity correctness (ship-blocking)

| ID | Ticket | P | Theme |
|----|--------|---|-------|
| ALBB-03 | [03-content-filtered-default-path.md](./tickets/03-content-filtered-default-path.md) | P1 | content_filtered drains mutating tools |
| ALBB-04 | [04-kernel-abort-and-stream-persist.md](./tickets/04-kernel-abort-and-stream-persist.md) | P1 | Cancel mislabel + persist flip |

### Wave B — loop / host silent failures

| ID | Ticket | P | Theme |
|----|--------|---|-------|
| ALBB-05 | [05-host-turn-runner-stream-and-approval.md](./tickets/05-host-turn-runner-stream-and-approval.md) | P2 | Stream tap NO-THROW parity |
| ALBB-06 | [06-interrupted-turn-capture.md](./tickets/06-interrupted-turn-capture.md) | P1 | Resume buffer gaps |
| ALBB-07 | [07-recovery-compaction-objective.md](./tickets/07-recovery-compaction-objective.md) | P1 | PTL emit + activeModel thread |
| ALBB-08 | [08-compaction-breaker-and-effort-reset.md](./tickets/08-compaction-breaker-and-effort-reset.md) | P2 | empty_summary strike + /summarize-now |
| ALBB-09 | [09-silent-degradation-emit-parity.md](./tickets/09-silent-degradation-emit-parity.md) | P1 | codex-r2 / plugins / MCP |
| ALBB-10 | [10-subagent-persistence-observability.md](./tickets/10-subagent-persistence-observability.md) | P2 | Crash-resume snapshots |

### Wave C — composition / dead wires

| ID | Ticket | P | Theme |
|----|--------|---|-------|
| ALBB-11 | [11-hitl-admissibility-wiring.md](./tickets/11-hitl-admissibility-wiring.md) | P2 | allowlistEscalated + ASM |
| ALBB-12 | [12-features-sdk-composition.md](./tickets/12-features-sdk-composition.md) | P1 | TaskRegistry + embed ports |
| ALBB-14 | [14-dead-wires-identity-automation.md](./tickets/14-dead-wires-identity-automation.md) | P2 | ADR-0239 + automation ticker |
| ALBB-15 | [15-orphan-slices-triage.md](./tickets/15-orphan-slices-triage.md) | P2 | lane-manager / side-chat / objective idle |
| ALBB-16 | [16-subagent-fork-and-workflow-depth.md](./tickets/16-subagent-fork-and-workflow-depth.md) | P1 | fork live-WM + depth |

### Wave D — observability / UX / taxonomy

| ID | Ticket | P | Theme |
|----|--------|---|-------|
| ALBB-17 | [17-stop-category-and-error-taxonomy.md](./tickets/17-stop-category-and-error-taxonomy.md) | P2 | budget vs max_turns labels |
| ALBB-18 | [18-cli-sdk-surface-gaps.md](./tickets/18-cli-sdk-surface-gaps.md) | P3 | label fidelity + dropped-event visibility |
| ALBB-19 | [19-prompt-compaction-snapshot-parity.md](./tickets/19-prompt-compaction-snapshot-parity.md) | P2 | skill-event + cache parity |
| ALBB-20 | [20-control-plane-and-stream-edges.md](./tickets/20-control-plane-and-stream-edges.md) | P2 | plan exit / steer / boomerang / timeout |

### Wave E — policy / bench-adjacent

| ID | Ticket | P | Theme |
|----|--------|---|-------|
| ALBB-21 | [21-budget-checkpoint-policy.md](./tickets/21-budget-checkpoint-policy.md) | P3 | Breach signal + converge reason |

### Wave F — proof closure

| ID | Ticket | P | Theme |
|----|--------|---|-------|
| ALBB-24 | [24-test-hellgates-proof-gaps.md](./tickets/24-test-hellgates-proof-gaps.md) | P3 | Missing behavioral rails |

## Priority legend

- **P0** — security / authority / misleading terminal outcome
- **P1** — silent wrong behavior or dead safety wiring
- **P2** — observability, UX, maintainability with real failure potential
- **P3** — SE debt, docs, ratchet (still ticketed; lower queue)

## Out of scope (document only unless paired with a ticket)

- Full `AgentConfig` decomposition (tracked separately; touch only ticket seams)
- Monolithic `docs/runbooks/agent-loop-reference.md` line-number refresh (add to ALBB-24 doc slice if needed)
- `src/runner/batch/eval/llm-evidence-packet.ts` god-module (bench-owned, not loop)

## Source audits

- Round 1: core loop (`entry` → `turn-loop` → `same-turn-engine` → dispatch/recovery)
- Round 2: kernel/host bridge, stream/recovery outcome, dispatch/HITL, memory/context
- Round 3: stream-callbacks, features/SDK, guards/budget, compaction/memory depth
- Round 4: prompt/composition root, tier1/orphans, CLI→kernel, test proof gaps
