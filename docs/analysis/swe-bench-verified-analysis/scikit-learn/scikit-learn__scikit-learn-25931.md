---
instance_id: scikit-learn__scikit-learn-25931
repo: scikit-learn/scikit-learn
base_commit: e3d1f9ac39e4bf0f31430e779acc50fb05fe1b64
version: "1.3"
difficulty: "15 min - 1 hour"
created_at: 2023-03-22T00:34:47Z
fail_to_pass: 1
pass_to_pass: 21
gold_files: [sklearn/ensemble/_iforest.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약

`IsolationForest`를 `pd.DataFrame`으로 fit하고 `contamination != "auto"`로 지정하면, fit이 끝나기 전에 "X does not have valid feature names, but IsolationForest was fitted with feature names" 경고가 잘못 발생한다. 원인은 `fit()`이 `offset_`을 contamination 분위수로 계산하려고 공개 메서드 `score_samples(X)`를 호출하는데, 이때 `X`가 이미 `_validate_data`로 ndarray로 변환된 상태라 두 번째 `_validate_data`가 "fit 시점엔 feature name이 있었는데 지금은 없다"고 오인하기 때문이다. 사용자 데이터엔 정상적으로 `"a"` 컬럼이 있으므로 이 경고는 거짓 양성이다.

## 유형 (정형화)

- **L (Localization) = L1**: 이슈 본문이 `_iforest.py`의 라인까지 직접 링크하고(L337/L348/L436), 메인테이너 힌트가 `score_samples` 내부 `_validate_data` 호출을 정확히 지목한다. grep 한 방은 아니지만 좁은 단일 파일·단일 함수쌍으로 즉시 수렴 → L1.
- **S (Repair Strategy) = S2 (+S6)**: 고칠 지점은 명확하다. 그러나 "validation을 두 번 하면 안 되는데, fit 내부 호출은 validation 없이, 공개 경로는 그대로 validation 유지"라는 불변식을 추론해 충족시켜야 한다(기계적 가드 추가가 아님) → S2. 그 충족 수단이 검증부와 채점부를 분리하는 작은 구조 변경(private `_score_samples` 추출)이라 S6 보조.
- **K = K-Domain**: sklearn estimator의 `_validate_data(reset=False)`가 fit 때 본 feature name과 호출 시 입력을 대조해 경고를 띄운다는 프레임워크 내부 계약을 알아야 근본원인이 보인다 → K-Domain.
- **Primary = T-ConstraintReason**: 위치는 알지만 "한 번만 validate"라는 올바른 조건을 추론해 합성하는 게 본질. 단순 None가드/상수변경(S1)이 아니라 의미적 불변식 추론이므로 DirectMap이 아닌 ConstraintReason.

## 난이도 티어

**T3 (중간).** 구조적 피처: 단일 파일(`sklearn/ensemble/_iforest.py`), 골드 +13/−7줄 소규모 2헌크, has-repro(4줄 재현코드 + 명확한 expected/actual). 그러나 픽스가 단순 한 줄이 아니라 (a) double-validation이 경고의 원인이라는 인과 추론과 (b) validation/scoring 책임 분리 리팩터를 요구한다. P2P 21건이 `score_samples` 공개 경로의 결과 불변성을 강제하므로 약한 regression-trap. 공식 라벨은 "15분-1시간"이며, "good first issue"로 분류되었으나 메인테이너가 PR에서 토론하며 설계 방향(private 메서드)을 잡아준 점을 보면 자명한 T1/T2는 아니다. localize는 쉬우나 올바른 일반화(공개 API 동작 보존) 추론이 난점이라 T3로 둔다.

## 골드패치 분석

- **건드린 파일·함수**: `sklearn/ensemble/_iforest.py`의 `IsolationForest.fit`, `IsolationForest.score_samples`, 신규 `IsolationForest._score_samples`.
- **근본원인**: `fit()`이 `self.score_samples(X)`를 호출하는데, 이 시점 `X`는 이미 fit 초반의 `_fit`/`_validate_data`를 거쳐 ndarray다. `score_samples`는 진입 시 다시 `self._validate_data(..., reset=False)`를 수행하고, 이 검사가 "fit 때 feature name 있었음 vs 지금 입력엔 없음"을 비교해 거짓 경고를 낸다. 즉 내부 재진입에서의 **이중 입력검증**이 결함.
- **수정요지**: `score_samples`를 둘로 쪼갠다. 공개 `score_samples`는 `_validate_data`만 수행한 뒤 `return self._score_samples(X)`로 위임한다. 신규 private `_score_samples`는 검증 없이 `check_is_fitted(self)` 후 `-self._compute_chunked_score_samples(X)`만 반환한다. 그리고 `fit`은 마지막 줄에서 `score_samples` 대신 `self._score_samples(X)`를 호출해 두 번째 validation을 건너뛴다. 결과적으로 외부 호출자는 검증 그대로 받고, 내부 fit 경로만 검증을 우회한다.

## 검증 (test_patch)

- **FAIL_TO_PASS (1건)**: `test_iforest_preserve_feature_names` — `pd.DataFrame(columns=["a"])`로 `contamination=0.05` 모델을 fit하면서 `warnings.simplefilter("error", UserWarning)`로 모든 UserWarning을 예외로 승격시킨다. 거짓 경고가 사라져야만(=경고 0회) fit이 예외 없이 통과한다. PR #24873과 동일한 패턴의 non-regression test.
- **픽스 증명**: 픽스 전엔 `fit` 끝에서 `score_samples`가 두 번째 `_validate_data`를 돌려 UserWarning을 띄우고 → 테스트가 그걸 error로 잡아 실패. 픽스 후 `fit`은 `_score_samples`(검증 없음)를 호출하므로 경고 자체가 발생하지 않아 통과.
- **overfit·regression 관점**: overfit 위험 낮음 — 픽스가 테스트 입력 형태에 특화된 분기가 아니라 검증 경로를 구조적으로 일원화한 것이라 일반화가 자연스럽다. regression 관점에서 핵심은 공개 `score_samples`의 출력이 바뀌면 안 된다는 것: P2P의 `test_score_samples`, `test_iforest[42]`, `test_iforest_works[*]`, `test_iforest_chunks_works*`가 분위수/채점 결과 불변성을 지킨다. 골드가 공개 메서드의 validation을 그대로 유지하므로 이들이 깨지지 않는다.

## 모범답안 (오라클 기반)

1. **Localize**: 이슈가 경고 문자열과 `_iforest.py` 라인을 직접 준다. "fit에서 발생하는 feature-name 경고"라는 모순 신호 → fit 말미가 `score_samples`를 재호출하고 그 안에서 `_validate_data(reset=False)`가 도는 것을 확인. `fit` + `score_samples` 함수쌍으로 수렴.
2. **픽스와 일반화**: 근본원인은 "내부 재진입 시 이중 검증". 올바른 일반화는 **검증과 채점의 책임 분리** — private `_score_samples`(검증 없음)를 만들고 공개 `score_samples`는 검증 후 위임, `fit`은 private 경로 사용. 힌트가 제시한 대안(`feature_names`를 인자로 전달)은 공개 시그니처를 오염시키므로 열등하다. 책임 분리는 공개 API 계약을 건드리지 않아 더 깨끗한 일반화다.
3. **regression 안전**: 공개 `score_samples`/`decision_function`/`predict`의 출력 수치와 검증 동작이 보존되어야 한다(P2P `test_score_samples`, `test_iforest*`, chunks 테스트). 골드는 `_compute_chunked_score_samples` 호출과 부호(`-`)를 그대로 옮기고 공개 경로의 `_validate_data`를 유지하므로 안전.
4. **함정 회피**: (a) `score_samples`에서 `_validate_data`를 통째로 제거해 검증을 없애면 외부 사용자 입력 검증이 깨진다 — 검증은 공개 경로에만 남겨야 한다. (b) `check_is_fitted`를 잘못된 쪽에 두면 안 된다: 골드는 이를 private `_score_samples`로 옮겨 fit 내부 호출에서도 fitted 가드가 유지되도록 했다. (c) fit에서 그냥 경고를 suppress(`warnings.catch_warnings`)하는 임시방편은 근본원인을 안 고치고 다른 거짓 경고를 가릴 수 있어 오답. (d) 힌트 코멘트의 `_validate_input` 같은 자작 검증 로직을 끌어오면 sklearn 표준 검증 계약에서 벗어난다 — 프레임워크 메서드 분리가 정답.
