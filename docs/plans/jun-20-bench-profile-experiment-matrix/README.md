# Bench Profile Experiment Matrix (jun-20)

> SSOT for the next SWE-bench comparison wave.
> Goal: pick the next default profile honestly, with difficulty and issue-type
> coverage, instead of promoting off a 4-instance A/B.

---

## 0. One line

Run a staged, stratified profile comparison:

- easy floor = regression guard
- selector stress = where the current profiles disagree
- medium discriminator = where profile quality should separate
- hard tail = stress only, not default-promotion evidence
- repair arms = follow-up only on the right termination families

## 1. Why (measured)

- Live same-pack result on `ab-presets-v2-sample-20260620.jsonl`:
  - `agentless-v2`: `3/4`
  - `agentless-v3-thin-strict`: `3/4`
  - `agentless-v3-thin-strict-select`: `2/4`
- The tie between `v2` and `v3-thin-strict` is not a real tie:
  - `v2`: `175 turns`, `5899 patchBytes`
  - `v3-thin-strict`: `49 turns`, `3203 patchBytes`
- This is still small-n. It is enough to rank candidates, not enough to set the
  repo default honestly.
- Prior RCA already says not to collapse `strict-select`, `repair`, and
  `reprovote` into one recommendation from one run. Keep baseline/control/
  treatment explicit.

## 2. Questions

- `Q1` default-floor:
  - Does `agentless-v3-thin-strict` match or beat `agentless-v2` on the easy
    floor with no regression and lower cost?
- `Q2` selector value:
  - Does `agentless-v3-thin-strict-closure-select` recover the current
    `strict-select` regression on `xarray`-like cases?
- `Q3` medium discriminator:
  - On cases that are not trivial but not true ceiling, which profile actually
    moves resolved count?
- `Q4` hard-tail stress:
  - Are any wins on H or ceiling-ish instances real scaffold value, or just
    noise?
- `Q5` repair niche:
  - On unresolved non-empty-patch cases, does `reprovote` help more than the
    legacy repair gate?

## 3. Profile ladder

- `agentless-v2`
  - Full grounding + in-loop execution control.
- `agentless-v3-thin-strict`
  - Current best default candidate.
  - Mini-first, noexec, hard patch-budget admission.
- `agentless-v3-thin-strict-select`
  - Late selector control arm.
  - Already suspicious from the current 4-pack.
- `agentless-v3-thin-strict-closure-select`
  - Structural selector hypothesis.
  - Same thin/noexec candidate generation, but restores closure-grounded owner
    evidence for the selector.
- `agentless-v2-repair`
  - Repair-loop control arm.
  - Follow-up only; do not run as a global default candidate.
- `agentless-v2-reprovote`
  - Repair + resolved-vote treatment arm.
  - Follow-up only; compare only against `v2-repair`, not directly against
    unrelated selector arms.

## 4. Dataset strata

### 4.1 `01-e-floor.ids`

Role:
- easy-floor regression guard
- cross-repo breadth
- previously measured green or tier-E-like picks

IDs:
- `astropy__astropy-7166`
- `django__django-11551`
- `pydata__xarray-3677`
- `scikit-learn__scikit-learn-10297`
- `sphinx-doc__sphinx-8721`

### 4.2 `02-selector-stress.ids`

Role:
- current profile-disagreement set
- over-engineer / selection-sensitive / recent-miss mix

Type hints:
- minimality / over-engineer: `django-13417`
- selector-sensitive current disagreement: `xarray-3677`
- recent misses: `astropy-13579`
- recoverable-medium: `pytest-5787`

IDs:
- `django__django-13417`
- `pydata__xarray-3677`
- `astropy__astropy-13579`
- `pytest-dev__pytest-5787`

### 4.3 `03-m-discriminator.ids`

Role:
- medium difficulty
- different repos and failure surfaces
- where resolved-count separation is most likely to be real

IDs:
- `django__django-11211`
- `matplotlib__matplotlib-25122`
- `pytest-dev__pytest-5787`
- `sympy__sympy-18763`

### 4.4 `04-h-tail.ids`

Role:
- hard + ceiling-ish stress set
- not promotion evidence by itself
- used to learn which arm is worth escalating further

Type hints:
- symptom-root split / localize trap: `sympy-17630`
- H-tier public low-solve: `django-11734`
- true multi-site ceiling pressure: `django-13212`

IDs:
- `sympy__sympy-17630`
- `django__django-11734`
- `django__django-13212`

## 5. Phase plan

### Phase A — default-floor A/B

Dataset:
- `01-e-floor.ids`

Arms:
- `agentless-v2`
- `agentless-v3-thin-strict`

Budget:
- `5 ids x 2 arms = 10 instance-runs`

Goal:
- decide if `v3-thin-strict` is allowed to stay in the default-candidate lane

Pass rule:
- resolved count `>= v2`
- no new `empty_patch` / `harness_error` cluster
- lower or comparable `turns` and `patchBytes`

### Phase B — selector value A/B

Dataset:
- `02-selector-stress.ids`

Arms:
- `agentless-v3-thin-strict`
- `agentless-v3-thin-strict-select`
- `agentless-v3-thin-strict-closure-select`

Budget:
- `4 ids x 3 arms = 12 instance-runs`

Goal:
- test whether `closure-select` fixes the current `strict-select` failure mode

Primary readout:
- resolved delta vs `v3-thin-strict`

Secondary readout:
- which ids flip
- whether the selector loses `xarray-3677` again
- whether closure-grounded owner seeds recover that loss

### Phase C — medium discriminator spread

Dataset:
- `03-m-discriminator.ids`

Arms:
- `agentless-v2`
- `agentless-v3-thin-strict`
- `agentless-v3-thin-strict-closure-select`

Budget:
- `4 ids x 3 arms = 12 instance-runs`

Goal:
- decide the real control vs candidate ranking on medium difficulty

### Phase D — hard-tail stress

Dataset:
- `04-h-tail.ids`

Arms:
- `agentless-v3-thin-strict`
- `agentless-v3-thin-strict-closure-select`

Budget:
- `3 ids x 2 arms = 6 instance-runs`

Goal:
- probe for real upside without letting hard-tail noise choose the default

Rule:
- do not promote a profile off Phase D alone
- do not run Phase D until Phase A-C leaves an unresolved ranking question

### Phase E — repair/oracle follow-up

Source set:
- unresolved subset from Phase B/C/D

Entry rule:
- `failure.termination in {completed_unresolved, max_turns_exhausted}`
- no `empty_patch`
- no `harness_error`
- no `grader_invalid`

Arms:
- `agentless-v2`
- `agentless-v2-repair`
- `agentless-v2-reprovote`

Goal:
- isolate repair-loop value only on the class where repair is a legitimate
  question

## 6. Total fixed budget

Fixed budget before any hard-tail or repair follow-up:

- Phase A: `10`
- Phase B: `12`
- Phase C: `12`
- fixed total: `34 instance-runs`

Optional add-ons:

- Phase D hard-tail smoke: `6`
- Phase E repair follow-up: conditional on unresolved subset only

This keeps the main ranking wave cheap while preserving one floor check, one
selector check, and one medium discriminator check.

## 7. Concurrency policy

- Keep `QUANTA_FULL_REMOTE_CONCURRENCY=1` per box.
- Parallelize by problem/profile arms, not by per-box patch-gen concurrency.
- Without multi-auth routing, cap live arms conservatively.
- With multi-auth routing, prefer one box per active arm and keep chunk size
  small. See `../jun-20-multi-auth-fleet/README.md`.

## 8. Dataset build commands

```sh
ROOT=/Users/songmin/quanta-codeagent-v3
PLAN=$ROOT/docs/plans/jun-20-bench-profile-experiment-matrix
OUT=$ROOT/.tmp/bench-exp-jun20/$(date -u +%Y-%m-%dT%H-%M-%SZ)
mkdir -p "$OUT"

build_dataset() {
  local stem="$1"
  local ids="$PLAN/datasets/${stem}.ids"
  local out="$OUT/${stem}.jsonl"
  : > "$out"
  while IFS= read -r id; do
    jq -c . "$ROOT/docs/analysis/swe-bench-verified-analysis/_data/by-instance/${id}.json" >> "$out"
  done < "$ids"
  echo "$out"
}

build_dataset 01-e-floor
build_dataset 02-selector-stress
build_dataset 03-m-discriminator
build_dataset 04-h-tail
```

## 9. Launch template

```sh
launch_arm() {
  local session="$1"
  local dataset="$2"
  local preset="$3"
  local log="$OUT/${session}.log"
  tmux new-session -d -s "$session" /bin/zsh -lc "
    set -o pipefail
    cd '$ROOT'
    export QUANTA_FULL_REMOTE_CONCURRENCY=1
    export QUANTA_FULL_REMOTE_ONDEMAND=1
    bun run src/apps/bench/cli.ts grade \
      --mode full \
      --allow-remote-secrets \
      --allow-extra-boxes \
      --dataset '$dataset' \
      --preset '$preset' \
      --model gpt-5.4 2>&1 | tee '$log'
  "
}
```

Example:

```sh
ESET="$OUT/01-e-floor.jsonl"
SSET="$OUT/02-selector-stress.jsonl"

launch_arm exp-e-v2 "$ESET" agentless-v2
launch_arm exp-e-v3strict "$ESET" agentless-v3-thin-strict
launch_arm exp-s-v3closure "$SSET" agentless-v3-thin-strict-closure-select
```

## 10. Readout contract

For each arm, record:

- `totals.resolved`
- solved id list
- unresolved id list
- `sum(turns)`
- `sum(patchBytes)`
- termination mix
- empty-patch count
- report path + log path

Do not collapse:

- problem-count solved
- report-count solved
- unique solved union
- hard-tail anecdotes

## 11. Promotion rules

- Promote a new default candidate only if:
  - Phase A floor is non-regressing
  - Phase B/C improves resolved count or ties with materially lower cost
  - no new failure-class regression cluster appears
- `strict-select` stays non-default unless it clearly beats `v3-thin-strict`.
- `closure-select` is promoted only if it fixes the selector regressions without
  reopening the floor.
- Hard-tail wins alone do not justify default promotion.

## 12. Artifact discipline

- Experimental losses do not go to `docs/swebench-leaderboard.yaml`.
- Only real clean passes get folded into the board.
- Keep raw logs and built datasets under `.tmp/bench-exp-jun20/<stamp>/`.
- Keep per-phase summaries append-only in this folder or a sibling run note.
