# jun-30 - Python-Pro synthesis-first measure-first RFC

> 날짜: 2026-06-30
> 상태: RFC, 구현 전
> 스코프: `src/runner/knobs/presets.ts`, Python-Pro bench launch matrix, no default promotion
> 관련 문서:
> - `docs/analysis/swe-bench-pro-analysis/PYTHON-FIRST-STRUCTURAL-RCA.md`
> - `docs/plans/jun-29-bestofn-measure-first/README.md`
> - `docs/plans/jun-29-repro-adapter-polyglot/README.md`

## 0. 결론

다음 Python-Pro headline arm은 `image-exec`가 아니다.

다음 순서는 둘로 분리한다.

1. **headline synthesis arm**
   - 목표: right-file-but-unresolved 수렴 개선
   - 방식: `v6-oracle-hardened` 위에 breadth/fanout/acceptance/CHA만 얹는다
   - backend/env/oracle-admission 변화는 넣지 않는다
2. **isolated backend parity arm**
   - 목표: `image` repro backend가 실제로 `exec_failed`를 줄이는지 검증
   - 방식: `bench-repro-image-exec`는 별도 A/B로만 켠다
   - 이 arm에서는 `paired-control`을 반드시 유지한다

즉, **synthesis 문제와 backend parity 문제를 한 preset에 섞지 않는다.**

## 1. ground-truth

### 1.1 현재 인용 표본은 작다

직접 검증한 Pro receipts:

- `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/closure-i-07dfa79ea7e9e9741.json`
- `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/closure-i-07dd08900e8cb5de5.json`
- `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/report-i-07dfa79ea7e9e9741.json`
- `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/report-i-07dd08900e8cb5de5.json`

둘 다 `agentless-v6-oracle`, `datasetFamily=pro`, `total=4` 표본이다.

closure 공통:

- `owner_recall@1 = 1.0 (n=4)`
- `synth_repro_base_red_rate = 0.25 (n=4)`
- `repro_red_but_unresolved_rate = 1.0 (n=1)`
- `cross_file_rate = unavailable`

report 공통:

- 주 termination은 `completed_unresolved`
- `bySignal`에는 `multi_file_drift`가 있으나, termination SSOT는 아니다

해석:

- localization만의 문제로 보기 어렵다
- repro base-red 점화율이 낮다
- red가 떠도 unresolved가 남는다

### 1.2 더 큰 집계도 synthesis 쪽을 가리키지만, 증거 형식은 누적 빈도다

`bench/full-remote` 전체 집계:

- `closure-i-*.json`: 168개
- `report-i-*.json`: 295개

closure `perInstance.class` 누적:

- `resolved = 420`
- `model_miss = 340`
- `empty_patch_other = 155`

report 내부 `reason` 문자열 누적:

- `no_public_issue_mwe_seed = 369`
- `no_reproduced_candidate = 364`
- `execution_failed = 277`

중요한 제한:

- 이 숫자는 unique case 분포가 아니라 **run artifact 누적 빈도**다
- 따라서 "병목 순위 확정" 증거로 과장하면 안 된다

그래도 방향성은 분명하다.

- unresolved의 큰 덩어리는 `model_miss`다
- `image-exec`가 겨냥하는 `execution_failed`는 실제로 존재하지만 유일한 병목은 아니다

### 1.3 `image-exec`는 promotion-ready가 아니다

코드 계약:

- `src/config/knob-schema/schemas/bench-gap-3.ts`
- `src/runner/batch/eval/repro-adapter.ts`

현재 설명은 명시적이다.

- Python parity inside image is **UNPROVEN**
- box validation before promotion
- default-OFF
- opt-in measurement arm only

즉 `bench-repro-image-exec`는 headline preset에 넣을 안정화 레버가 아니라,
**독립 검증 대상**이다.

### 1.4 `repair-breadth`는 바깥 rerank-only가 아니다

코드:

- `src/runner/batch/eval/repair/index.ts`

현재 동작:

- breadth candidate fanout
- candidate별 validate
- winner adopt
- adopted state에서 다음 repair round 계속

즉 breadth는 실제 repair loop 내부 레버다. 그래서 synthesis arm의 주 레버로
삼을 수 있다.

### 1.5 thin oracle에서는 generation보다 selection이 먼저 깨진다 (SOTA++ 핵심)

Pro의 구조적 함정은 `fail_to_pass` median = 1이다(README 상단 실측). 이건
test-time scaling의 selection 단계에 직접 위험이다.

코드 계약 (`src/runner/batch/eval/acceptance-rerank.ts`):

- 3-tier 래더로 후보를 고른다
  - tier 1 `repro_and_regression` — repro-pass AND min-regression → patch vote
  - tier 2 `regression_only` — repro 떨구고 min-regression → vote
  - tier 3 `all_patches` — 둘 다 신호 없으면 전 non-empty patch vote (= 실질 선택 없음)
- regression "pass"는 RELATIVE다 (candidate들 중 최소 실패수)

함의:

- breadth=3로 후보를 **늘리는 것**(generation)은 쉽다
- 그 후보 중 정답을 **고르는 것**(selection)이 thin oracle에서 깨진다
- F2P 1개에 acceptance가 과적합하면 regression-clean-but-wrong을 winner로 뽑는다
- 최악은 Pro에서 acceptance가 거의 항상 **tier-3로 떨어지는** 경우다 — 그러면
  acceptance=1은 inert이고 breadth=3은 비용만 늘리고 winner는 사실상 랜덤이다

업계 SOTA++ 대응(execution-grounded selection)은 명확하다:

- regression-set을 dominant negative signal로 둔다 (우리 래더가 이미 그렇게 가중)
- positive oracle(F2P)이 얇을 때는 LLM reviewer/critic을 tiebreak로 (generative
  reward model 트렌드; 우리 `submit-review`/LLM-select가 fail-open으로 보유)

그래서 이 RFC의 측정은 "resolved 올랐나"만으로는 부족하다. **어느 tier가
떴는지**가 synthesis arm이 실제로 작동하는지의 ground-truth다 (§4 readout 필수항목).

### 1.6 image deprioritize는 Python-Pro 한정이다 (polyglot keystone 보존)

이 RFC가 `image-exec`를 headline에서 빼는 근거는 **Python 레인 한정**이다:

- Python host env는 이미 hardened다 (`src/runner/batch/corpus/project-env.ts`:
  official era pins, `-e .[test]` extra 추출, repo-specific overrides)
- 그래서 Python에서 image의 marginal value는 `execution_failed` 일부(qutebrowser-class
  pytest plugin 결손)뿐이고, 더 큰 병목은 synthesis(`model_miss`)다

하지만 비-Python 64%(go 280 / js 165 / ts 20)에서는 image backend가
**오라클 substrate keystone으로 남는다** — instance image가 이미 정답 env를
들고 있어서, Go/JS/TS의 신뢰 가능한 red→green은 image 안에서만 나온다. 그 확장은
별도 polyglot RFC(`docs/plans/jun-29-repro-adapter-polyglot/README.md`) 소관이며,
이 문서의 "image 후순위"를 "image 영구 후순위"로 읽으면 안 된다.

### 1.7 구현 상태 감사 (4-way 병렬, 2026-06-30 — 발사 전 검증)

부품이 "파일 존재"가 아니라 "posture→driver→effect 풀체인 + test"로 배선됐는지
적대 감사(assume-inert-until-proven)했다.

WIRED 확정 (full chain + effect + test):

- `repair-breadth` — 멀티라운드 continue-from-winner까지 테스트 증명(round i가
  i-1 winner 트리 fork, adopt = reset→git apply). `repair-breadth.ts`,
  `repair-breadth-driver-fanout.test.ts`, `repair-breadth-selection.test.ts`
- `bench-location-fanout` — 후보별 distinct lead file + info-preservation invariant
- `acceptance` knob + 3-tier 래더 **로직** — 순수·결정적, Agentless rerank.py 충실
- `cha-multisite-steer`/`general` — **answer-key 아님 확정** (gold patch/file list
  절대 미참조, candidate repo AST만; `cha-multisite.ts:17-18`). general=1이
  django path-hardcode→structural 전환, parity 테스트 있음
- `QUANTA_BENCH_LLM_SELECT` — inert 아님, admissible 내 vote winner 실제 교체
  (never-veto + fail-open)
- `submit-review` — observe-only by design (정상; test-revert는 sourceOnlyDiff로
  이미 무조건)
- `effort-ladder` — controller limits 실제 조정
- repro oracle base-red (host backend) — 실행 실제 발생, `synthReproBaseRed`/
  `execution_failed` 진짜 측정값, primary rail 게이팅

🔴 발사 차단 갭 2개 (이 RFC의 가정이 코드로 확정됨):

1. **acceptance 래더 data source가 half-built (§1.5 리스크 실재).** regression
   failure-count 신호는 `(instance.swebench) AND (verification-plan||primary-rail)
   AND 디스커버리 성공`일 때만 채워진다. 비면 oracle에 `runRegression`이 안 들어가
   래더가 tier-1/2를 건너뛰고 **tier-3(all_patches = 순수 vote, 실질 선택 없음)**로
   떨어진다. v6-oracle-hardened가 두 knob을 켜서 디스커버리를 *시도*는 하나,
   실패/empty면 tier-3. 즉 Pro에서 `acceptance=1`이 **조용히 inert일 수 있다.**
   (`acceptance-select.ts:156`, `acceptance-rerank.ts:114-138`,
   `repo-regression-discovery-adapter.ts`, `driver.ts:5606-5617`)
2. **tier serialization 부재.** `RerankTier`는 계산되지만
   `acceptance-adapter.ts:101`에서 `selected`만 destructure하고 tier/scored를
   버린다. report/closure 어디에도 안 들어가 **어느 tier가 떴는지 볼 방법이 없다.**
   selection-observable 원칙상 이게 없으면 synthesis arm은 측정 불가.

결론: 발사 전 **net-new는 tier serialization 하나뿐**(§6 #2). 이걸 먼저 배선해
baseline에서 tier 분포 ground-truth를 본다. tier-3 지배면 다음 레버는 breadth가
아니라 regression passing-set 인프라 완성이다.

## 2. 하드 원칙

- **measure-first**: default 승격 금지. 먼저 isolate된 A/B를 돌린다.
- **backend/synthesis 분리**: env/backend 변경과 repair convergence 변경을 같은 arm에 싣지 않는다.
- **default-OFF**: 새 preset은 research arm이다. 기본 preset을 덮지 않는다.
- **single-lane first**: breadth 효과를 먼저 본다. multi-vendor lane은 후순위다.
- **no parity handwave**: `image-exec`는 box parity proof 전까지 headline 금지다.
- **oracle-admission isolation**: `paired-control`, `adversarial-repro` 같은 admission/hardening 변화는 synthesis arm과 분리한다.
- **selection-observable**: acceptance가 어느 tier로 winner를 골랐는지(`repro_and_regression`/`regression_only`/`all_patches`)를 readout에 노출하지 않으면 synthesis arm은 측정 불가로 본다. tier-3 지배 = arm inert.
- **cost-gated**: breadth=3은 후보×라운드×validate 비용 곱이다. effort-ladder/turn-cap 없이 돌리지 않고, readout은 항상 cost-per-resolved를 같이 낸다.
- **power-honest**: 8-case는 delta 1이 노이즈다. resolved delta ≤ 1로 모호하면 결정 전 더 큰 Python-Pro set으로 확대한다 (n=1/소표본으로 루프 변경 금지).

## 3. 제안 arm

### A. baseline

기준 arm:

- `agentless-v6-oracle-hardened`

목적:

- 현재 public oracle hardened baseline 유지
- synthesis arm과 backend arm 둘 다 이 기준 위에서 비교

### B. headline synthesis arm

새 preset을 추가한다.

권장 id:

- `agentless-v7-oracle-multifile-synthesis`

구성:

- base: `agentless-v6-oracle-hardened`
- add `acceptance = 1`
- add `repair-breadth = 3`
- add `bench-location-fanout = 1`
- add `cha-multisite-steer = 1`
- add `cha-multisite-general = 1`

명시적으로 넣지 않는 것:

- no `bench-repro-image-exec`
- no `model-lane-diversity`
- no `paired-control`
- no `adversarial-repro`

이유:

- 이 arm의 목적은 env/parity가 아니라 **repair convergence**다
- `paired-control`과 `adversarial-repro`는 symptom admission/hardening 변화다
- `model-lane-diversity`는 공급자/샘플 decorrelation 레버라 1차 attribution을 흐린다

attribution 한계 (명시):

- 이 arm은 synthesis-class 5개(acceptance, repair-breadth, bench-location-fanout,
  cha-multisite-steer, cha-multisite-general)를 한 번에 켠다
- 1차 질문은 "synthesis-class 레버가 baseline 대비 delta가 있긴 한가"이고,
  이 coarse 번들로 답하기에 충분하다
- B가 baseline을 이기면 **후속 ablation 필수** — 가장 싼 의심부터 드롭
  (`bench-location-fanout` → `cha-multisite-steer` 순), 어느 레버가 delta를
  실어 나르는지 격리한다

cost posture (필수):

- breadth=3 × repair round × candidate validate = 비용 곱이므로 effort-ladder
  또는 turn-cap 게이팅 아래에서만 돌린다 (`QUANTA_BENCH_EFFORT_LADDER`)
- readout은 resolved뿐 아니라 **cost-per-resolved**(토큰/달러)를 같이 낸다 —
  8-case는 버텨도 스케일에서 터지는 arm을 1차에 거른다

### C. broad comparison arm

기존 arm은 그대로 둔다.

- `agentless-v7-oracle-multifile`

역할:

- headline synthesis arm이 delta를 보인 뒤
- 추가 hardening (`paired-control`, `adversarial-repro`, `model-lane-diversity`)이
  실제로 더 이득인지 보는 후속 비교군

### D. isolated backend parity arm

새 preset보다 overlay A/B가 낫다.

기준:

- base: `agentless-v6-oracle-hardened`

overlay:

- `QUANTA_BENCH_REPRO_IMAGE_EXEC=1`
- `QUANTA_BENCH_PAIRED_CONTROL=1`

명시적으로 요구:

- parity box validation receipt
- `exec_failed` delta
- false-red admission 증가 여부

이 arm은 headline이 아니다.

## 4. 실험 순서

### Phase 1. synthesis first

고정 8-case Python-Pro smoke에서 비교:

1. `agentless-v6-oracle-hardened`
2. `agentless-v7-oracle-multifile-synthesis`
3. 필요 시 `agentless-v7-oracle-multifile`

성공 기준:

- resolved count 상승 (단, §2 power-honest: delta ≤ 1이면 확대 후 재판정)
- `multi_file_full_coverage_rate` 상승 / `multi_file_partial_overlap_rate` 하락
- `repro_red_but_unresolved_rate` 하락
- cost-per-resolved가 baseline 대비 폭증하지 않음
- hygiene 회귀 없음

필수 readout (selection-observable):

- acceptance tier 분포 — `repro_and_regression` / `regression_only` / `all_patches`
  각각 몇 건인지. **tier-3(all_patches)가 지배하면 acceptance=1은 inert**이고,
  이때의 진짜 next-work는 regression passing-set 인프라 완성이다(메모리 jun-28
  "regression dual-guard 절반"). 이 분포 없이 resolved만 보면 arm이 헛도는지
  모른다.
- per-arm cost (토큰/달러)와 cost-per-resolved

읽을 때 주의:

- `owner_recall@1`은 주 승격 기준이 아니다
- `cross_file_rate = null`은 구 receipt 계측 공백일 수 있으니, refreshed closure
  diagnostics 기준으로 본다
- resolved가 올라도 tier-3 지배면 "운 좋은 vote"일 수 있으니 tier 분포로 교차검증한다

### Phase 2. backend parity isolated A/B

같은 고정 set에서 비교:

1. `agentless-v6-oracle-hardened`
2. `agentless-v6-oracle-hardened + image-exec + paired-control`

성공 기준:

- `execution_failed` 감소
- `no_reproduced_candidate` 악화 없음
- false-red admission 증가 없음
- parity mismatch evidence 없음

실패 시:

- image backend는 계속 deferred
- headline preset에는 넣지 않는다

## 5. 명시적 비채택안

다음 조합은 채택하지 않는다.

- `v7` 계열 headline preset에 `bench-repro-image-exec`를 바로 포함
- `image-exec`를 켜면서 `paired-control`을 끄는 조합
- `model-lane-diversity`까지 동시에 넣어 single-lane breadth 효과를 가리는 조합

반대 이유:

- parity 미검증 backend를 headline에 넣으면 attribution이 죽는다
- env를 바꾸면서 false-red guard를 끄는 것은 안전하지 않다
- breadth 효과를 보기 전에 multi-lane variance를 섞으면 해석이 나빠진다

## 6. 구현 항목

코드 변경은 작다.

1. `src/runner/knobs/presets.ts`
   - `agentless-v7-oracle-multifile-synthesis` 추가
2. acceptance tier readout (selection-observable, 필수)
   - `src/runner/batch/eval/acceptance-rerank.ts`의 선택 tier(`RerankTier`)를
     report/closure receipt에 per-instance로 직렬화
   - 집계 시 tier 분포를 readout 매트릭스에 노출
   - 이게 이 RFC에서 유일한 **net-new 측정 배선**이다 (나머지는 preset bundling)
3. cost readout
   - per-arm 토큰/달러 + cost-per-resolved를 비교 매트릭스에 포함
   - effort-ladder/turn-cap 게이팅 확인 (신규 코드 아님, launch posture)
4. launch/readout
   - Phase 1/2 비교 매트릭스 문서화 (tier 분포 + cost-per-resolved 컬럼 포함)
5. `image-exec`
   - preset 승격 없음
   - overlay A/B만 허용 (Python-Pro 한정 후순위; polyglot keystone은 별도 RFC)

드라이버 의미론 변경은 없다. tier 직렬화는 관측 배선이지 selection 로직 변경이
아니다(default-OFF byte-identical 불변식 유지).

## 7. 최종 판정

현재 최적안은 새 headline preset 하나와 isolated backend A/B 하나다.

- **headline preset**: synthesis-only
- **backend A/B**: image parity-only

이 순서가 맞는 이유는 단순하다.

- 현재 코드는 breadth/fanout/acceptance repair loop를 이미 갖고 있다
- 현재 `image-exec`는 계약상 아직 미검증이다
- 따라서 먼저 측정할 값은 "synthesis-only delta"이지 "backend 바꾼 복합 arm"이 아니다

단, SOTA++ 정렬상 한 가지를 못 박는다:

- **이 arm의 진짜 합격/불합격 신호는 resolved가 아니라 acceptance tier 분포다.**
  thin oracle(F2P median 1)에서 generation(breadth)은 쉽고 selection이 병목이다.
  tier-1/2가 실제로 떠야 synthesis arm이 작동한 것이고, tier-3 지배면 다음
  진짜 레버는 breadth가 아니라 **regression passing-set 인프라 완성**이다.
- image backend 후순위는 Python-Pro 한정이며, 비-Python 64%에는 여전히 keystone이다.
