---
instance_id: scikit-learn__scikit-learn-10297
repo: scikit-learn/scikit-learn
base_commit: b90661d6a46aa3619d3eec94d5281f5888add501
version: "0.20"
difficulty: "15 min - 1 hour"
created_at: 2017-12-12T22:07:47Z
fail_to_pass: 1
pass_to_pass: 28
gold_files: [sklearn/linear_model/ridge.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-API
flags: [has-repro, regression-trap]
---

## 문제 요약

`sklearn.linear_model.RidgeClassifierCV`를 `store_cv_values=True`로 생성하면 `TypeError: __init__() got an unexpected keyword argument 'store_cv_values'`가 난다. 이 플래그는 docstring의 `cv_values_` 속성 설명에 이미 공식 문서화되어 있고 부모 `_BaseRidgeCV`는 이를 지원하지만, 정작 `RidgeClassifierCV.__init__`가 해당 파라미터를 노출하지 않는다. 즉 문서가 약속한 공개 API와 실제 시그니처가 불일치한다.

## 유형 (정형화)

- **L0 (Pinpointed)**: 이슈가 `RidgeClassifierCV` + `store_cv_values` 심볼을 직접 지목. `ridge.py`에서 클래스의 `__init__` 한 곳으로 grep 한 방에 수렴. 탐색 비용 사실상 0.
- **S1 (Direct-Map)**: 픽스가 기계적이다. 부모 `_BaseRidgeCV.__init__`가 이미 `store_cv_values=False`를 받으므로, 자식 시그니처에 같은 파라미터를 추가하고 `super().__init__(...)`로 전달(forward)하기만 하면 된다. 새 로직·조건 합성 불필요 — 누락된 위임(delegation)을 복원하는 템플릿.
- **K-API (API-contract)**: 핵심은 공개 생성자 시그니처와 문서화된 계약을 정확히 맞추는 것. 부모 기본값(`False`)·인자 이름·통과 방식이 하위호환을 깨지 않게 정렬돼야 한다. 도메인 알고리즘 지식은 거의 불필요.
- **primary = T-DirectMap**: 위치 자명 + 기계적 가드/위임 추가. APR 관점에서 PAR/TBar식 "missing-argument-forwarding" 템플릿에 정확히 매칭된다. S2(추론합성)가 아닌 이유는 올바른 조건식을 따질 게 없고, 이미 존재하는 부모 동작을 노출만 하면 되기 때문.

## 난이도 티어

**T2 (쉬움).** 구조적 피처: 단일 파일(`ridge.py`) 단일 클래스 `__init__`, 실질 코드 변경 ~3줄(시그니처 1 + super 호출 인자 1, 나머지는 docstring), 네이티브 재현 스택트레이스 존재(`has-repro`), 도메인 추론 없음. 공식 라벨 "15 min - 1 hour"와 대체로 일치하나 그 시간의 대부분은 코드가 아니라 RidgeCV/RidgeClassifierCV 두 docstring을 RST 형식(``...``)으로 정돈하는 부수 작업에서 온다. T1이 아닌 이유는 단 하나 — `regression-trap`: P2P 27개가 ridge 계열 전반(`test_ridgecv_store_cv_values`, `test_ridgecv_sample_weight`, `test_class_weights_cv` 등)을 덮어, 새 인자가 기존 회귀 경로의 기본 동작을 바꾸지 않아야 한다. 다만 기본값을 `False`로 두면 trap은 가볍게 회피된다.

## 골드패치 분석

- **건드린 파일·함수**: `sklearn/linear_model/ridge.py` — `RidgeClassifierCV.__init__`(코드 변경), 그리고 `RidgeCV`·`RidgeClassifierCV`의 클래스 docstring(문서 정리).
- **근본원인**: `_BaseRidgeCV.__init__(..., store_cv_values=False)`는 이 플래그를 받아 `self.store_cv_values`로 저장하고 `fit()`에서 `_RidgeGCV`로 전달한다. 그러나 `RidgeClassifierCV`가 `__init__`를 오버라이드하면서 `store_cv_values`를 (1) 자기 시그니처에서 빠뜨리고 (2) `super().__init__()` 호출 인자에서도 누락했다. 결과적으로 사용자가 키워드로 넘기면 바인딩될 곳이 없어 `TypeError`. 문서는 이 속성을 약속하지만 생성자가 입구를 막은 셈.
- **수정요지**: `RidgeClassifierCV.__init__` 시그니처에 `store_cv_values=False`를 추가하고, `super(RidgeClassifierCV, self).__init__(...)` 호출에 `store_cv_values=store_cv_values`를 끼워 부모로 위임. 추가로 누락돼 있던 `store_cv_values` 파라미터 docstring 블록을 `RidgeClassifierCV`에 신설하고, 두 클래스의 `cv_values_` 설명을 backtick→이중백틱 RST로 정정(shape 표기도 `n_responses`→`n_targets`로 통일).

## 검증 (test_patch)

- **FAIL_TO_PASS** (1개): `test_ridge_classifier_cv_store_cv_values` 신설. `RidgeClassifierCV(alphas=..., store_cv_values=True)`를 생성(이전엔 여기서 TypeError) 후 `fit`하여 1D 타깃(`n_targets=1`)에서 `cv_values_.shape == (n_samples, 1, n_alphas)`, 2D 다중타깃에서 `(n_samples, n_targets, n_alphas)`를 단언. 즉 "생성자가 인자를 받는다 + fit 후 속성이 올바른 shape로 채워진다"를 end-to-end로 증명.
- **픽스 증명**: 위임이 복원되면 `self.store_cv_values=True`가 `fit()`을 통해 `_RidgeGCV`로 흘러가 `cv_values_`가 저장된다. 시그니처 추가만으로 TypeError가 사라지고, super 전달이 있어야 속성이 실제로 채워지므로 두 변경 모두 테스트에 의해 강제된다.
- **overfit·regression 관점**: overfit 위험 낮음 — 픽스가 새 분기를 만들지 않고 기존 부모 경로를 재사용하므로 special-case 통과 여지가 없다. regression은 P2P 27개(특히 기존 `test_ridgecv_store_cv_values`, RidgeCV 경로)가 보호. 기본값 `False` 덕에 기존 호출자 동작은 byte-identical 유지.

## 모범답안 (오라클 기반)

1. **localize**: 스택트레이스의 `__init__() got an unexpected keyword argument 'store_cv_values'` + 클래스명으로 `ridge.py`의 `RidgeClassifierCV.__init__`에 직행. 부모 `_BaseRidgeCV.__init__`가 같은 인자를 이미 받는지 확인 → 자식만 위임을 빠뜨렸음을 즉시 파악.
2. **픽스**: 자식 시그니처에 `store_cv_values=False`(부모와 동일 기본값) 추가 + `super().__init__(..., store_cv_values=store_cv_values)`. 이것이 올바른 일반화인 이유 — 새 동작을 발명하는 게 아니라 부모가 이미 구현·검증한 GCV 경로를 그대로 노출하는 것이라, 1D/2D 타깃·모든 alpha에 대해 부모와 동일하게 작동한다.
3. **regression 안전**: 기본값을 `False`로 둬 기존 `RidgeClassifierCV()` 호출자(P2P 다수)의 동작 불변. `class_weight` 등 자식 고유 인자나 `fit()` 흐름은 건드리지 않아 ridge 회귀 경로(`test_ridgecv_*`)도 무영향.
4. **함정 회피**: (a) 시그니처에만 추가하고 `super()` 전달을 빠뜨리면 TypeError는 사라지지만 `cv_values_`가 안 채워져 FAIL_TO_PASS의 shape 단언에서 실패 — 두 줄이 한 쌍임을 인지. (b) `fit()`에 중복 분기를 새로 작성하려는 과잉수정은 부모 로직과 충돌·중복; 부모 위임이 정답. (c) docstring의 약속을 코드 변경과 분리해 무시하면 계약 불일치가 남는다 — 문서의 `n_responses` 표기도 실제 `n_targets`로 정렬해 두는 것이 일관적.
