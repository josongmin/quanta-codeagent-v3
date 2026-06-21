# Heuristic authority cleanup + contract-first generate-and-test — final plan

Related:

- [Cases requiring clean re-solve](./contaminated-cases.md)

## 목적

SWE-bench selector의 clean path에서 heuristic authority를 제거하고, selector를
contract-first generate-and-test 구조로 바꾼다.

정적 엔진은 계속 쓴다. 단, 정적 엔진의 역할은 localization, co-change discovery, witness test
candidate generation, candidate family separation, branch-search seed diversity까지다. 최종 submit
authority는 실행된 증거와 공개 contract만 가진다.

최종 불변식:

```text
static engine = find where to look and what to test
candidate families = force search-space coverage
public contracts = express what must hold
executable proof = decide what can veto or admit
heuristic signals = observe-only or research-only
```

## 현재 코드 기준 문제

### `declaredExpected`

파일:

- `src/runner/batch/eval/selection-declared-expected.ts`
- `src/runner/batch/eval/selection-executor.ts`
- `src/runner/batch/eval/driver.ts`
- `src/apps/bench/eval/driver.ts`

문제:

- issue text regex와 patch/file-path regex가 결합되어 특정 issue family를 맞춘다.
- `postgresql`, `mysql`, `sqlite`, `oracle`, `misleading` 같은 issue keyword와
  `django/db/backends/...` file touch, `connectionTimezoneMentions >= 3` 같은 조건이 있다.
- `driver.ts`의 `RCA_*_STEER` 문자열도 known-solution literal을 prompt에 직접 주입해 generation path를
  오염시킨다.
- 현재 live wiring은 `rcaTargetGates` 뒤에 있지만, port 자체는 clean authority로 승격하면 안 된다.

결론:

- clean selector path에서 제거한다.
- clean prompt path에서도 exact-solution literal steer를 제거한다.
- 필요하면 `research/rca-target-gates`에서 telemetry-only로만 유지한다.

### `regression:discovered`

파일:

- `src/runner/batch/eval/impacted-test-discovery.ts`
- `src/runner/batch/eval/repo-regression-discovery-adapter.ts`
- `src/agent/verification-bundle/score.ts`

문제:

- impacted test discovery가 magic score table이다.
- `mirror +50`, `package +5`, `path-token +18`, `context-token +8`,
  `parent-mirror +32`, `import-ref +30`, `DEFAULT_MAX_TESTS=12`,
  `token.length >= 4`가 hardcoded다.
- 이 discovery 결과로 실행한 test가 실패하면 `regressionGreen=false`가 hard reject가 된다.

결론:

- discovered score는 test candidate ordering까지만 쓴다.
- hard authority는 실제 실행된 keep-green result만 가진다.
- score-table 기반 discovered rail은 clean preset에서 빼고, 정적 엔진 기반 witness builder로 대체한다.
- 단, `WitnessTestCandidateBuilder` / ordering telemetry 자체는 목표가 아니다. witness coverage, turns, cost,
  debuggability에 측정 가능한 이득이 없거나 authority 경계를 다시 흐리면 남기지 말고 제거한다.

### issue smoke / extracted MWE

파일:

- `src/runner/batch/eval/selection-smoke.ts`
- `src/agent/verification-plan/extract-issue-repro.ts`
- `src/agent/verification-bundle/score.ts`

문제:

- fenced block regex, python-ish allowlist, `hasImport`/`hasCall`, prompt stripping으로 source를 고른다.
- base-green이면 candidate-side failure가 `smokeGreen=false` hard reject가 된다.
- snippet extraction은 useful seed일 수 있지만, independent veto authority로는 너무 약하다.

결론:

- extracted source는 repro seed 또는 auxiliary evidence로만 쓴다.
- standalone `smokeGreen=false` hard reject는 clean path에서 제거한다.
- 단, repro seed / auxiliary telemetry 자체도 의무 보존 대상은 아니다. 재현 탐색이나 진단에 실측 이득이
  없으면 "non-authoritative"라는 이유만으로 남기지 말고 제거한다.

### weighted soft selector

파일:

- `src/agent/verification-bundle/score.ts`

문제:

- `declaredExpectedMatch: 0.25`, `rubricScore: 0.2`, `voterQuorum: 0.2`,
  `minimality: 0.15`, `ownerCoverage: 0.2` weighted sum이다.
- weight가 tuned evidence 없이 submit ranking에 영향을 준다.

결론:

- clean selector는 lexicographic tier로 바꾼다.
- executable authority tier가 먼저이고, public contract / candidate family authority가 그 다음이다.
- minimality/owner coverage는 마지막 tie-break만 맡는다.

### missing replacement seams

현재 문서의 cleanup 축만으로는 부족하다. score authority를 제거한 뒤 selector가 의존할
대체 seam이 있어야 한다.

필요한 replacement는 3개다.

- `candidate family generation`
- `public contract bundle`
- `semantic counterfactual contracts`

이 세 축이 없으면 clean selector는 단순 falsifier만 남고 search-space를 충분히 구조화하지 못한다.

### patch budget / counterfactual contract

파일:

- `src/agent/patch-budget/index.ts`
- `src/runner/batch/eval/counterfactual-contract.ts`

문제:

- patch-budget은 Python-oriented regex structural analyzer다.
- `DEF_RE`, Python test file detection, runtime expansion regex는 exact semantics가 아니다.
- counterfactual `singleOwnerFile`은 legitimate owner-justified multi-file candidate를 막을 수 있다.

결론:

- patch-budget은 clean global hard reject가 아니다.
- counterfactual candidate contract는 유지 가능하지만, 그 contract의 authority는
  "candidate가 자기 seed 약속을 지켰는가"로만 제한한다.
- owner-justified multi-file repair는 executable proof가 있으면 살아야 한다.

### fault evidence / owner admission

파일:

- `src/agent/fault-evidence/build.ts`
- `src/agent/fault-evidence/types.ts`
- `src/agent/owner-admission/index.ts`
- `src/agent/closure/bundle.ts`
- `src/runner/batch/eval/selection-executor.ts`

문제:

- 현재 owner packet은 `ISSUE_FILE_BOOST`, `OWNER_RESOLVE_BOOST`, score-desc merge, `DEFAULT_MIN_LEAD_GAP=1`
  같은 numeric heuristic에 의존한다.
- 이 owner set은 generation hint를 넘어서 candidate family ordering, selector context, early-accept stop
  authority까지 새어 들어간다.
- static owner confidence가 provenance-carrying typed evidence가 아니라 merged score라서, clean path에서
  무엇이 authoritative이고 무엇이 advisory인지 타입으로 구분되지 않는다.

결론:

- clean path에서는 additive owner score/gap 모델을 authority로 쓰지 않는다.
- owner evidence는 authoritative vs advisory typed lattice로 바꾼다.
- static owner confidence는 generation/family ordering에는 쓸 수 있지만, final admit/veto authority는
  못 가진다.

### early accept / loop stop

파일:

- `src/runner/batch/eval/selection-executor.ts`

문제:

- 현재 early-accept는 `owners.size > 0`, `fullyInsideOwners(...)` 같은 static owner facts를 stop authority로
  쓴다.
- 즉 executable proof가 불충분해도 heuristic owner set이 search를 조기 종료시킬 수 있다.

결론:

- clean early-accept는 executed proof receipt만으로 결정한다.
- static owner/family evidence는 search-space ordering만 바꾸고, loop stop authority는 못 가진다.

## Authority lattice

### Hard authority allowed in clean path

- `patchProduced=false`: empty patch reject.
- `applyClean=false`: patch apply failure reject.
- `patchedResolvedKofN` malformed or `votes < k`: validated repro quorum reject.
- executed keep-green suite fails: reject only when the suite was selected by a non-oracle witness policy and actually ran.
- base repro is not validated red: reject only for rails whose contract requires validated red authority.
- early-accept / loop-stop authority is allowed only when backed by the same executable receipts above.

### Soft / tie-break only

- minimality.
- owner coverage.
- candidate family 내부의 static ordering.
- patch budget facts.
- static owner confidence.
- branch-search candidate provenance.
- static witness-test rank.

### Lexicographic dominance layer

Hard reject와 soft tie-break 사이에 clean selector가 반드시 봐야 하는 dominance layer를 둔다.

- public contract satisfaction.
- candidate family / owner authority class.
- executed proof strength 비교 (`votes/k`, executed keep-green coverage).

이 layer는 weighted sum으로 상쇄되면 안 된다.

### Observe-only / research-only

- `declaredExpected`.
- issue-family regex.
- patch/file-path regex.
- extracted issue smoke as independent hard gate.
- impacted-test magic score.
- LLM rubric or critic before shadow calibration.
- targeted presets such as RCA-only gates or stuck-loop breakers.

## Clean preset policy

Clean presets must not include:

- `rca-target-gates`.
- `declaredExpected` authority.
- `repro-doubt` as a hidden stuck-loop breaker.
- issue-family selector logic.
- discovered regression as magic-score hard authority.
- issue smoke as standalone hard authority.

Research presets must be named separately:

- `research/rca-target-gates/*`
- `research/repro-doubt/*`
- `research/discovered-regression/*`

## Static engine use

Existing assets to use:

- `lsp_definition`: true owner confirmation.
- `find_references`: fast co-change/reference candidate map.
- `repo-map`: bounded turn-0 orientation.
- `localize-phase`: first-edit block until owner is identified.
- closure/fault evidence bundle: candidate owner evidence and verification context.

Allowed use:

- generate candidate owner files.
- generate co-change candidate files.
- generate witness test candidates.
- separate candidate families (`root-owner`, `symptom-owner`, `api-owner`, `lifecycle-owner`,
  `test-adjacent-owner`).
- derive public contract witnesses from public source text and public tests.
- seed branch-search diversity.
- explain why a candidate was explored.

Retention rule:

- builder / seed / telemetry helper는 "hard authority가 아니니까 남겨도 됨"이 아니다.
- 각 helper는 coverage, turns, patch quality, debug value 중 적어도 하나에서 측정 가능한 효용을 보여야 한다.
- 효용이 약하거나 authority ambiguity를 반복해서 다시 열면 단순화 차원에서 제거한다.

Forbidden use:

- direct final veto.
- direct final admit.
- instance-family patch matching.
- score tuning to recover known SWE-bench misses.

## Candidate families

Current `ownerCandidates` line ranking is too weak. Clean generate-and-test should force at least one candidate
per non-empty family before reusing the same family.

Initial family set:

- `root-owner`
- `symptom-owner`
- `api-owner`
- `lifecycle-owner`
- `test-adjacent-owner`

Selector telemetry must show which family each candidate came from and which family won.

## Public contracts

`declaredExpected` alone is not enough. Clean selector needs a typed public contract bundle derived from public
issue text, public tests, validated repros, and static witnesses.

Initial contract classes:

- `exact-output`
- `api-surface`
- `owner-must-touch`
- `lifecycle-owner`
- `state-reset-semantics`
- `multi-site-family`

These contracts are not issue-family regexes for known misses. They must be generic typed obligations with
explicit provenance.

## Contract-first selector

Clean selection order:

1. hard falsifier pass only.
2. stronger executable proof.
3. public contract satisfaction.
4. candidate family / owner authority class.
5. minimality.
6. stable original candidate order.

This is the opposite of the current weighted-sum shape where a small symptom patch can beat a larger
root-cause patch.

## Semantic counterfactual

Counterfactual should stop meaning "smaller structural patch" and start meaning "the opposite side of the
failed contract".

Examples:

- API-owner contract violated -> spawn API-owner counterfactual.
- lifecycle-owner contract violated -> spawn lifecycle-owner counterfactual.
- root-owner file missing -> spawn owner-must-touch counterfactual.

Structural patch-budget facts can still contribute, but they are no longer the whole contract surface.

## Ticket order

1. `T-AUTH-01`: authority taxonomy and selector contract.
2. `T-SEL-02`: remove `declaredExpected` clean authority.
3. `T-REG-03`: replace discovered regression authority with static witness generation.
4. `T-SMK-04`: demote issue smoke to repro seed.
5. `T-LOC-05`: wire static engine as localization/witness generator only.
6. `T-OWN-12`: replace scored owner packet with an authoritative/advisory owner-evidence lattice.
7. `T-GEN-09`: generate candidate families instead of one ranked owner list.
8. `T-CON-10`: build a typed public contract bundle.
9. `T-SEL-06`: replace weighted sum with contract-first lexicographic selection.
10. `T-SEL-13`: remove static-owner early-accept authority and require executable-only stop receipts.
11. `T-CF-11`: extend counterfactual to semantic contracts.
12. `T-PRESET-07`: split clean presets from research presets.
13. `T-MEASURE-08`: promotion policy and holdout audit (forward gate).
14. `T-RESOLVE-14`: clean re-solve campaign + leaderboard score correction
    (backward correction; closes `contaminated-cases.md`).

## Success criteria

- No clean preset can hard reject via issue text regex, file path regex, magic score table, or extracted smoke.
- Every clean hard rejection has an executable receipt or an explicit structural impossibility (`empty patch`,
  `applyClean=false`).
- No clean early-accept path can stop on static owner/family confidence alone.
- Every clean winner can explain:
  - which candidate family it came from,
  - which public contracts it satisfied,
  - which executable proof tier beat the alternatives.
- A smaller symptom patch cannot beat a larger root/API/lifecycle patch unless executable proof and public
  contracts are tied.
- Static engine improves search and witness generation without becoming verdict authority.
- Counterfactual candidates represent the opposite side of a failed contract, not just a structurally smaller
  patch.
- Targeted RCA wins are relabeled as research evidence, not clean benchmark quality.
- New authority signals require observe-only telemetry, holdout A/B, and false-reject audit before promotion.
- Score receipts carry one of three explicit labels — `official_harness`,
  `local_structural`, `research_contaminated` (T-RESOLVE-14) — and only
  `official_harness` is reported as benchmark-grade resolved. `local_structural`
  green is never rendered as official resolved.
- Every contaminated/unproven receipt in `contaminated-cases.md` ends clean-resolved,
  clean-failed, or explicitly ambiguous — none left counted as a bare clean win, and
  the published count is corrected with the delta shown.
