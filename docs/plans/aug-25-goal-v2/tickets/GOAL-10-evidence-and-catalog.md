# GOAL-10 — Current-SHA evidence, semantic catalog parity, and promotion decision

**Priority:** P1 · **Depends on:** GOAL-01 through GOAL-09 · **Owner:** evidence/catalog only

**Receipt:** docs/plans/aug-25-goal-v2/receipts/GOAL-10.yaml plus final-manifest.yaml

## Purpose

Prove implemented front doors at one frozen SHA, ratchet catalog claims to named executable cases, and keep release/default-on claims separate from local implementation green.

## No duplicate implementation

This ticket indexes and runs tests created by earlier owners. Add only missing front-door coverage, semantic evidence guards, final receipt/manifest, and catalog entries. GOAL-01 through GOAL-09 receipts are produced by their own tickets and are never reconstructed retrospectively.

## Evidence battery

- PTY: default off; create/status; missing-contract wake 0; contract/check CRUD/verify/stale; multi-turn completion; pause/resume; edit clear/explicit keep-contract; clear/restart tombstone; effective hard cap; crash/uncertain attempt; backoff; draft/background/plan/approval quiescence; activity-epoch stale queue; typed blocker paths; attach/epoch fence.
- Verifier real-command E2E: Git, non-Git bounded manifest, timeout/kill, source-write/outside-read/network/fan-out/temp-cap denial, CAS-raced invalidation, source drift.
- Daemon E2E: session objective commands, web controls, payload-bound atomic turn.submit, approval resume, concurrent user input, attach/restart/rearm, teardown.
- Contract/meta: protocol codecs, command exhaustiveness, runtime config/knob parity, architecture fences, non-vacuous ratchets.
- Smoke: add the Goal battery to the existing tests/smoke/index.ts dispatch. Do not invent a second smoke runner.

Run the repo-local built binary first. bun run install:cli mutates ~/.local/bin and is not required for implementation evidence. Perform global install only with explicit release approval, then record it separately.

## Semantic catalog guard

Update the owning Goal continuation YAML and add the verifier runtime YAML. Generated docs/10.feature-catalog.md remains build output.

Catalog claims must be exact:

- Modes: interactive when PTY passes; daemon/web when daemon E2E passes; exclude headless/serve-stdio without proof.
- Web daemon evidence does not claim IDE mode or IDE UI integration.
- Separate Codex-comparable goal behavior from Quanta-only safety extensions.
- List public QUANTA_GOAL and advanced knobs with actual defaults/clamps.
- Default remains off until a separate promotion decision.

Add tests/unit/goal-catalog-evidence-parity.test.ts mapping each maturity/mode/capability claim to named test cases and receipt IDs. File existence alone is insufficient. The guard needs an anti-vacuum floor and injected mutants for an unsupported mode and missing named case. bun fc check-evidence remains necessary but not sufficient.

## Repo-local receipt protocol

Validate the already-produced small ticket receipts and write only GOAL-10 plus final manifest. Each ticket protocol is:

- commit implementation/generated artifacts as source commit S
- run rails against frozen S with an unchanged unrelated-dirty allowlist, and record testedSourceSha S, origin/main, source tree digest, dirty allowlist, and index state
- porcelain dirty allowlist and index state
- command/args, exit code, duration
- bounded output digest and relevant named test count
- test/mutant ID and pre/post expectation
- commit only that receipt as evidence commit E; E is discovered from Git history, not self-written into its own contents

The final manifest maps each prior receipt path to testedSourceSha and its receipt-only evidence commit. A verifier rejects any E whose diff from E-parent includes source/generated files, and rejects any source-tree change between S and the executed rail. GOAL-10 follows the same S→receipt-only E protocol; its E is reported after commit rather than self-referenced inside the file.

There is no PR-body dependency because this workflow is main-direct. Promotion identifies tested source commit S and evidence container E separately.

## RED and adversarial proof

1. Run each named front-door case against its pre-owner baseline or a narrowly injected mutant and record the expected failing assertion.
2. At least three rounds cover: authority/wiring bypass, stale revision/epoch or ordering race, and catalog/evidence overclaim.
3. Mutants include manual-completion allow, settle-after-persist, missing fire-time quiescence, hard-cap N+1, split web append/run, attach without wake cancel, dependency lookup bypass, and unsupported catalog mode.
4. A mutant that stays green blocks completion until the rail is made non-vacuous.
5. Restoration is verified with git diff before the final current-SHA battery; mutant edits never enter the receipt or commit.

## Verification

First update YAML, run bun fc build, inspect generated diff, and commit all source/catalog/generated changes as final source commit S. Then freeze S and run serially without any source-generating command:

    bun run typecheck
    bun run typecheck:tests
    bun run lint
    bun run lint:debt
    bun test tests/unit/god-code-ratchet.test.ts tests/unit/_arch tests/meta
    bun test src/kernel/session/__tests__ --parallel=1
    bun test tests/unit --parallel=1
    bun test tests/integration --parallel=1
    bun run test:contract
    bun run e2e:pty
    bun run smoke          # replay-only battery; any LLM-judge/live smoke (smoke:live) is NOT a rail and is reported separately
    bun fc validate
    bun fc diff
    bun fc check-evidence
    git diff --cached --check

Freeze HEAD/status again after rails. If source changes, discard only the stale receipt, create a new source commit, and rerun; do not reuse results.

## Promotion decision

Hard failures:

- overlapping autonomous turn
- duplicate/reused attempt
- paid execution before durable attempt start or crash-refunded hard-cap slot
- stale revision/epoch execution
- checked completion without verifier receipt
- unavailable verifier becoming completion
- fabricated dependency evidence
- product hard-cap overrun
- attach/persist rollback leak

Report separately:

1. source implemented
2. owner-local tests green
3. full current-SHA battery green
4. catalog/generated docs synchronized
5. repo-local built binary green
6. global install/release not run or explicitly approved
7. default-on promotion deferred or approved

Expected pre-promotion wording: CLI + daemon behavior GREEN at SHA X, default OFF; IDE and default-on promotion not claimed.

## Stop conditions

- Any required rail is skipped, stale, or run against a changed testedSourceSha.
- Catalog mode/maturity lacks a named semantic case.
- Global install would overwrite a user binary without explicit release approval.
- Existing unrelated dirty files cannot be isolated in the receipt.
