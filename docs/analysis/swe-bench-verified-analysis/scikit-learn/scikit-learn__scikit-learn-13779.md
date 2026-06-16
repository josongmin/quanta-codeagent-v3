---
instance_id: scikit-learn__scikit-learn-13779
repo: scikit-learn/scikit-learn
base_commit: b34751b7ed02b2cfcc36037fb729d4360480a299
version: "0.22"
difficulty: "<15 min fix"
created_at: 2019-05-03T13:24:57Z
fail_to_pass: 2
pass_to_pass: 18
gold_files: [sklearn/ensemble/voting.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [has-repro]
---

## 문제 요약
`VotingClassifier`/`VotingRegressor`에서 어떤 추정기를 `set_params(lr=None)`로 비활성화한 뒤 `sample_weight`를 주고 다시 `fit`하면 `AttributeError: 'NoneType' object has no attribute 'fit'`가 난다. 원인은 `fit`이 sample_weight 지원 여부를 검사하는 루프에서 `step`이 `None`일 수 있다는 사실을 고려하지 않고 `has_fit_parameter(step, ...)`를 그대로 호출하기 때문이다. 이슈 본문에 정확한 재현 스니펫과 네이티브 traceback이 모두 포함되어 있다.

## 유형 (정형화)
- **L0 (Localization)**: 이슈가 traceback과 재현코드로 `fit` + `sample_weight` 경로를 직접 지목한다. `voting.py`의 `fit` 안 `sample_weight is not None` 분기로 grep 한 방에 수렴 → L0.
- **S1 (Repair Strategy)**: 정형 결함클래스 = None 가드 누락. 픽스는 루프 본문 첫 줄에 `if step is None: continue` 한 줄을 끼워넣는 기계적 가드. 추론 합성(S2)이 아니라 템플릿 매칭(None-guard) → S1.
- **K-Domain**: 일반 None 가드처럼 보이지만, "왜 step이 None일 수 있나"는 scikit-learn의 `_BaseVoting`/`set_params`로 추정기를 끌 수 있는 도메인 계약(estimator를 None으로 set하면 fit에서 스킵됨, `test_set_estimator_none`이 보장)에 의존한다. 가드 위치를 `has_fit_parameter` 검사보다 앞에 두어야 한다는 점은 이 계약을 알아야 자연스럽다 → K-Domain.
- **primary type = T-DirectMap**: 위치 명확(L0) + S1 기계적 가드. 찾으면 자명하지만 픽스 자체가 None-체크 삽입이라 T-LocTrivial보다 한 단계 위.
- APR 관점: 이슈가 결함과 위치를 사실상 명세하므로 generate-&-validate 반복이 불필요하고, SemFix류 조건 합성도 필요 없다. PAR/TBar의 "Null Checker" 수리 템플릿에 정확히 대응 → S1이 dominant.

## 난이도 티어
- 파일 1개(`sklearn/ensemble/voting.py`), 변경 +2줄, 단일 헌크, 단일 함수(`fit`).
- localize 직접성: has-repro + traceback → 해결률이 가장 높은 easiness 신호.
- 도메인: None으로 끌 수 있는 estimator 계약을 알아야 가드 위치가 정당화되지만, 가드 자체는 일반적.
- P2P trap: 18개 P2P(`test_set_estimator_none`, `test_sample_weight`, `test_weights_iris` 등)가 인접 동작을 보장하나, 추가한 가드는 "step이 None일 때만 발동"이라 기존 경로를 건드리지 않음 → trap 약함.
- **T2 (쉬움)**: L0 + S1 + 1파일 소규모. 공식 라벨 `<15 min fix`와 일치한다. T1(존나쉬움)으로 내리지 않은 이유는 픽스가 "이슈가 적어준 상수 변경"이 아니라 None 가드를 정확한 위치(검사 직전)에 넣어야 하고 약한 K-Domain이 끼기 때문.

## 골드패치 분석
- **파일·함수**: `sklearn/ensemble/voting.py`의 `_BaseVoting.fit(self, X, y, sample_weight=None)`.
- **근본원인**: `sample_weight is not None`일 때 `for name, step in self.estimators:` 루프가 각 step에 대해 `has_fit_parameter(step, 'sample_weight')`를 호출한다. 그런데 `set_params(lr=None)`로 끈 추정기는 `step`이 `None`이고, 이후 실제 fit 단계에서도 None은 스킵 대상이다. None 검사 없이 `has_fit_parameter`(내부적으로 step의 fit 시그니처를 inspect)를 호출하면서 NoneType에서 터진다.
- **수정요지**: 루프 본문 맨 앞에 `if step is None: continue`를 추가하여 비활성화된(None) 추정기를 sample_weight 지원 검사에서 건너뛴다. 이로써 None 추정기는 검사·fit 양쪽에서 일관되게 스킵된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2)**: `test_none_estimator_with_weights[X0-y0-voter0]`(`VotingClassifier`+`LogisticRegression`/`RandomForestClassifier`), `[X1-y1-voter1]`(`VotingRegressor`+`LinearRegression`/`RandomForestRegressor`). 테스트는 (1) weight 주고 fit → (2) `set_params(lr=None)` → (3) weight 주고 다시 fit → (4) `predict` 후 shape 확인. 가드가 없으면 (3)에서 AttributeError, 있으면 통과.
- **픽스 증명**: parametrize로 분류기·회귀기 두 패밀리를 모두 커버해 가드가 `_BaseVoting` 공통 경로에 있음을 검증한다. fit이 끝까지 돌고 predict shape가 `y.shape`와 일치 → None estimator가 검사·학습 모두에서 정상 스킵됨을 확인.
- **overfit/regression 관점**: 가드는 `step is None`일 때만 작동하므로 None이 아닌 정상 추정기의 sample_weight 미지원 에러(`'Underlying estimator ... does not support sample weights.'`)는 그대로 발생 — `test_sample_weight`/`test_sample_weight_kwargs`가 이를 보장한다. overfit-risk 낮음(특수 입력으로만 통과하는 형태 아님). regression-trap도 낮음(추가 분기가 기존 흐름과 분리).

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 traceback `'NoneType' object has no attribute 'fit'` + 재현코드(`set_params(lr=None)` 후 `fit(..., sample_weight=...)`) → `sklearn/ensemble/voting.py`의 `fit`에서 `sample_weight is not None` 분기를 찾는다. 이 분기의 `for name, step in self.estimators` 루프가 None step을 가정하지 않음을 확인.
2. **픽스**: 루프 첫 줄에 `if step is None: continue`. 이것이 올바른 일반화인 이유 — None estimator 스킵은 scikit-learn의 기존 계약(set_params로 끈 추정기는 fit에서 무시)이며, sample_weight 지원 검사도 그 계약에 맞춰 동일하게 None을 스킵해야 일관적이다. 호출부 try/except로 증상만 막거나 fit 단계에서만 None 처리하는 것은 검사 루프 버그를 남긴다.
3. **regression 안전**: 정상 추정기에 대한 sample_weight 미지원 ValueError 경로(`test_sample_weight`, `test_sample_weight_kwargs`)와 None-estimator 일반 동작(`test_set_estimator_none`), 가중치 동작(`test_weights_iris`, `test_weights_regressor`)을 깨면 안 된다. 가드를 `step is None`으로 좁혀 이들을 모두 보존.
4. **함정 회피**: (a) 가드를 `has_fit_parameter` 검사 *뒤*에 넣으면 여전히 None에서 터지므로 반드시 검사 직전에 둬야 한다. (b) `continue` 대신 None을 다른 값으로 치환하면 fit 단계 스킵 로직과 충돌. (c) 분류기만 고치고 `_BaseVoting` 공통 경로를 못 보면 `VotingRegressor` 케이스(`[X1-y1-voter1]`)가 실패 — 공통 베이스의 fit을 수정해 두 패밀리를 동시에 커버해야 한다.
