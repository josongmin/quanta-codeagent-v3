# Remaining work — evidence-verified (heuristic-authority-cleanup)

Final audit against current code. ONLY genuinely-remaining items. Everything not
listed here is DONE + verified live (T-AUTH-01, T-SEL-02, T-REG-03, T-SMK-04,
T-SEL-06, T-SEL-13, T-CF-11, T-MEASURE-08, T-CON-10 core, T-GEN-09 incl. multi-site,
T-PRESET-07 preset wiring, T-RESOLVE-14 score-label code).

Verified-live evidence (so it's not re-done):
- clean mode end-to-end: `presets.ts` `selector-mode: clean` (4 presets) → posture →
  both drivers → `runSelection({mode})` → `lexCleanWinner`.
- contracts live: `buildCleanSelectionPublicContracts` consumed at `driver.ts:2961`,
  `apps/bench/eval/driver.ts:848` (exact-output + owner-must-touch + api-surface).
- multi-site live: `withCandidateFamilyPublicContracts` consumed at `driver.ts:2385`,
  `apps/bench/eval/driver.ts:691`.
- selector authority is genuine REGARDLESS of the items below: the contract tier
  filters owners by `sources.includes("issue-file")` (a label), NOT by the heuristic
  score. So nothing below is a selection-authority leak.

---

## 1. T-OWN-12 clean admission  — ✅ ACTIVATED (wired + hellgate); A/B of the steering effect still pending

DONE: `driver.ts` now passes `ownerClean: posture.selectorMode === "clean"` into
`buildClosureSession` (in the shared `prepareAttemptContext` path, so BOTH drivers
get it). Clean presets now run the rule-based AUTHORITATIVE admission; research is
byte-identical (`ownerClean` false ⇒ legacy, verified by `verify-select-driver-parity`
7/7). Switch locked by `tests/unit/closure-session-owner-clean-activation.test.ts`
(3/3: same evidence, opposite admit on `ownerClean`). NOTE: `ownerClean` only changes
`bundle.owner.admit` / coverageExpectation (the gate + closure HINT = generation
steering); it does NOT touch `evidence.candidates`, so the SELECTOR (owners + contract
tier) is unaffected. The only thing left is the A/B MEASUREMENT of whether the new
clean steering helps clean resolved-rate — that's a bench question, not code.

<details><summary>original inert finding (now resolved)</summary>

Evidence (worktree 82da355f, dirty): `ownerClean` is received as an OPTION only at
`closure-session.ts:33`; the real caller at `driver.ts:2854` does NOT pass it. So
the rule-based authoritative admission never runs, and the heuristic boosts still
drive owner admission even under clean presets:
- `fault-evidence/build.ts:34` boosts (`ISSUE_FILE_BOOST` / `OWNER_RESOLVE_BOOST`)
- `owner-admission/index.ts:78` legacy lead-gap logic (`DEFAULT_MIN_LEAD_GAP`)

Scope: this is GENERATION-side owner admission (which file to seed toward),
classified `advisory` by the plan lattice — allowed to shape generation, never
selection. The SELECTOR is already clean. So this is T-OWN-12's own Done criterion
unmet, not a selector-authority leak.

(original "to finish" note retained for history: thread ownerClean from driver →
closure-session. WARNING: changes clean-preset generation steering → A/B before
treating as a win.)

</details>

## 2. T-LOC-05 static-witness-bundle is DEAD  — 🔁 SUPERSEDED by jun-22 SCAFF-01 (`static-witness.ts`)

Evidence: `buildStaticWitnessBundle` has 0 production consumers (only its own test).
jun-22 `SCAFF-01` introduces a NEW typed `static-witness.ts` IR (witnessId/kind/
authority/provenance/...) that replaces this ad-hoc assembler. Action: remove the old
`static-witness-bundle.ts` (+test) WHEN SCAFF-01 lands its replacement, to avoid two
witness types. Until then, leave it; it's inert, not harmful.

## 3. T-PRESET-07 EXHAUSTIVE allowlist ratchet  — ✅ DONE

DONE: `tests/unit/clean-preset-research-knob-allowlist-ratchet.test.ts` (8/8).
AUTO-discovers every clean preset (iterate KNOB_PRESETS, resolve posture, keep
`selectorMode==="clean"` → 4 presets) and asserts NONE enable a research-only
authority knob (rcaTargetGates / verify-select-llm-risk-gate=on / repro-doubt /
contaminating discovered-regression). Red-on-injection + paired research-preset
control prove it's live, not vacuous. New clean presets are auto-covered.

## 4. Builders/family kinds not generated in the live clean path  — ⛔ DO NOT TRIM (absorbed by jun-22 SCAFF-05)

UPDATE: the jun-22 static-witness scaffold (`SCAFF-01`/`SCAFF-05`) makes
`override-family` / `producer-consumer` / `registration-callback` / `lifecycle-owner`
witnesses GENUINE (AST-derived), and `buildStaticWitnessContracts` will consume these
builders to emit required contracts. So they are RESERVED targets, not dead theater —
do not trim. The earlier "trim" recommendation is superseded.

Original scope (still accurate):
- `buildLifecycleOwnerContracts` / `buildStateResetContract` / `buildPublicTestContracts`
  have NO production consumer YET (only tests) — wired by SCAFF-05.
- The live clean witness path only builds issue-named-symbol families
  (`driver.ts:2740`) and promotes ONLY multi-site to a contract (`driver.ts:2755`),
  locked by `family-genuineness-ratchet.test.ts:23`. So `root-owner` / `api-owner` /
  `lifecycle-owner` / `symptom-owner` / `test-adjacent-owner` are NOT built in the
  live clean path — but they remain on the `CandidateFamilyId` type/`FAMILY_PRECEDENCE`
  surface (`candidate-families.ts:18`) and ARE referenced by the counterfactual code,
  so they are surface-reserved, not globally dead.
These cannot be filled without inventing a classifier (lifecycle / test→file / reset
owner) = unvalidated heuristic = rule violation. Action: TRIM the no-consumer
builders to kill theater; leave the family-kind type surface (it's referenced).
Do NOT fill by faking.

## 5. T-RESOLVE-14 bench re-solve + post-run restatement  — `EC2 run + relabel + leaderboard docs`

`score-label.ts` 3-label enum + test EXIST and pass, but have NO runtime consumer in
`src/` — the enum is defined, not yet plumbed into the report/leaderboard path. The
ticket's remaining work is NOT only the EC2 run; it also includes the POST-RUN
correction: relabel the old `contaminated-cases.md` receipts `research_contaminated`,
and restate `docs/swebench-leaderboard.{md,yaml}` with the contaminated delta shown.
EC2 run (code-out-of-scope) + the relabel/doc restatement together.

---

## Status

- ✅ **#1 T-OWN-12 activation** — wired + hellgate-locked (A/B of the steering effect is a bench question).
- ✅ **#3 exhaustive allowlist ratchet** — done.

Left:
1. **#4 (trim no-consumer builders)** — cosmetic honesty; trim `buildLifecycleOwnerContracts` /
   `buildStateResetContract` / `buildPublicTestContracts` (0 consumers). Leave the family-kind type
   surface (referenced by counterfactual).
2. **#2 (static-witness)** — decide remove vs keep staged.
3. **#5 (bench)** — EC2 re-solve + post-run relabel + leaderboard restatement (user/measurement).
4. **#1 A/B** — measure whether the now-active clean owner admission helps clean resolved-rate.

Nothing here is a heuristic/answer-key authority leak in the SELECTOR — that goal is
met and ratchet-locked (smoke/declaredExpected no clean veto: `selection-clean-mode.test.ts`;
contract uses issue-file only: `authoritative-owner-contracts.test.ts`; family genuine:
`family-genuineness-ratchet.test.ts`). What remains is theater-trim + measurement.
