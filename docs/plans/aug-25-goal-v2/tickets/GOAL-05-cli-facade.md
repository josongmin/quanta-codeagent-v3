# GOAL-05 — CLI facade first; public preset activation after all safety gates

**Priority:** P1 · **Depends on:** GOAL-04 for 05A; GOAL-06, GOAL-07, and GOAL-09 for 05B · **Owner:** CLI control/render/config

**Receipt:** docs/plans/aug-25-goal-v2/receipts/GOAL-05A.yaml and GOAL-05B.yaml

## Purpose

Expose one policy-thin Goal control and one renderer without enabling unsafe autonomous behavior early. This ticket has two merge phases.

## GOAL-05A — Facade and renderer

- buildGoalControl is the single CLI adapter over authority/read/verifier ports.
- goal-cmd.ts parses only; it does not decide transitions or mutate stores.
- /objective remains a deprecated alias calling the same control instance.
- GOAL-05A keeps the public QUANTA_GOAL preset disabled. Internal test gates may compose the feature.

Supported commands:

- /goal text, /goal, /goal edit text, /goal pause|resume|clear, /goal stop as pause alias
- /goal criterion add description
- /goal criterion edit criterionId description
- /goal criterion remove criterionId
- /goal criterion complete criterionId
- /goal criterion reopen criterionId
- /goal check add description [--timeout-ms N] [--success-exit N,...] -- argv...
- /goal check edit checkId description [options] -- argv...
- /goal check remove checkId
- /goal budget --max-turns=N --max-tokens=N
- /goal verify
- /goal work instruction — explicit foreground agent turn with user-requested-goal-work provenance; ordinary chat never receives this provenance

Check argv requires the -- separator, non-empty bounded argv, bounded element length/count, and the verifier's timeout ceiling.

## Definition and budget decisions

- /goal text creates once and rejects if a goal exists.
- /goal edit creates a new objective ID and invalidates all evidence. By default it clears the old stopping contract, so the new objective is wake-ineligible until a criterion/check is added.
- /goal edit --keep-contract explicitly reuses old definitions after showing that they belong to the old goal; the flag is the user confirmation. Evidence is still cleared and every check must run again.
- Criterion/check add/edit/remove builds one full replacement definition and commits once with a new objective ID. CLI and web share this GoalDefinition edit payload.
- Goal text length is enforced by the domain MAX_GOAL_CHARS=4000, not a CLI-only constant.
- Budget amendment is same-ID user/system amendBudget, does not invalidate evidence, and clamps to product limits.
- Completed goals reject budget amendment; create/edit a new goal instead.
- A user-limit exhaustion may reactivate when an amendment leaves positive user budget. Exhausted product autonomous cap cannot be reset by amend/pause/resume; an explicit new objective generation is required.
- Manual complete/reopen routes to markCriterion and the central policy.

## Renderer

New goal-render.ts renders only read-port data:

- goal, derived status, revision, short objective ID
- validation contract and verified/manual/stale counts
- remaining criteria, next actions, typed blocker/waiting-on
- effective and requested budget with product/user source
- last attributed outcome and age, without raw attempt key
- verifier/checkpoint/source digest status

Every mutation response re-reads authority state before rendering. Slash code never predicts the next status.
After each attributed attempt, the host projects the bounded GOAL-04 receipt history through this same data model and emits checkpoint, newly verified work, remaining work, and blocker state. Restart restores the same report source; no parallel progress log is added.

## GOAL-05B — Preset activation

After GOAL-06 wake safety, GOAL-07 attach/epoch, and GOAL-09 blocker trust rails pass:

- QUANTA_GOAL=1 seeds QUANTA_OBJECTIVE_TOOLS=1, QUANTA_OBJECTIVE_BUDGET_ENFORCE=1, and QUANTA_GOAL_ENFORCE=1 when each is unset.
- QUANTA_GOAL=1 with explicit QUANTA_OBJECTIVE_TOOLS=0 is a boot configuration error.
- QUANTA_GOAL_ENFORCE=1 with QUANTA_OBJECTIVE_BUDGET_ENFORCE=0 is a boot error.
- Any GOAL_ENFORCE=1 with OBJECTIVE_TOOLS=0 is a boot error, with or without the preset.
- Explicit enforce=0 is record-only mode and is rendered as such; it cannot schedule autonomous wake.
- QUANTA_GOAL remains default off and is not self-seeded.
- With preset absent/0, legacy advanced knobs may compose internal tests/model tools but never register public /goal discovery. The preset exclusively owns public command discovery.
- Register knobs in runtime config, inventory, feature gates, help, and parity tests.
- Update every existing fixture that sets `QUANTA_GOAL_ENFORCE=1` without `QUANTA_OBJECTIVE_BUDGET_ENFORCE=1` (at least `tests/e2e-pty/cli-goal-pursuit-e2e.test.ts` boot env and `tests/integration/goal-continuation-live-e2e.test.ts`); they must boot under the new invariant, and one fixture must prove the boot error.
- When off, /goal and /objective are absent from registry/help.

## RED rails

1. Create twice preserves ID and directs user to edit.
2. Edit changes ID, clears definitions/evidence by default, and leaves wake ineligible.
3. edit --keep-contract preserves definitions only after explicit flag and re-verifies from zero evidence.
4. Budget amend preserves ID/evidence, clamps product maximum, reactivates only user-limit exhaustion, and rejects when completed.
5. Manual complete/reopen follows authority policy and re-derived state.
6. Clear is deletion, not pause.
7. Blocked/completed/budget-limited resume renders typed rejection from authority.
8. One slash command causes one authority commit.
9. Missing -- or invalid check argv/timeout fails before authority/verifier.
10. Renderer uses receipts/read state only and exposes no attempt key.
11. /objective and /goal emit deep-equal commands.
12. Unsafe gate combinations fail config construction.
13. Exhaustive preset × tools × enforce × budget matrix fixes boot outcome, discovery, tool exposure, and scheduler state.
14. QUANTA_GOAL cannot register publicly before GOAL-06, GOAL-07, and GOAL-09 dependency markers are present.
15. 4000-character goal passes and 4001 fails identically to model/web.
16. Each attributed attempt emits one bounded checkpoint report and restart renders the same receipt-backed history.

## E2E

- PTY: create -> status -> add check -> verify -> pause -> resume -> edit -> manual reopen -> clear -> restart.
- Preset-off binary has no public command.
- After 05B, preset-on binary composes the same control and obeys hard cap/quiet/usage-limit behavior from GOAL-06.
- Use repo-local built binary. Global install is deferred to GOAL-10 release approval.

## Verification

    bun test tests/unit/goal-cmd-hellgate.test.ts tests/unit/apps/cli
    bun test tests/unit/runtime-config* tests/unit/*knob*
    bun test tests/e2e-pty/cli-goal-pursuit-e2e.test.ts
    bun run typecheck
    bun run lint:debt

## Stop conditions

- CLI duplicates policy or state transition logic.
- Public preset can be enabled before GOAL-06/07/09 are green.
- Edit implicitly reuses an old stopping contract.
- A gate combination produces tools without enforcement invariants.
