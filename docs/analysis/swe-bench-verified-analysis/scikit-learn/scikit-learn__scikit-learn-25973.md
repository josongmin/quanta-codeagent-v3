---
instance_id: scikit-learn__scikit-learn-25973
repo: scikit-learn/scikit-learn
base_commit: 10dbc142bd17ccf7bd38eec2ac04b52ce0d1009e
version: "1.3"
difficulty: "<15 min fix"
created_at: 2023-03-25T13:27:07Z
fail_to_pass: 1
pass_to_pass: 72
gold_files: [sklearn/feature_selection/_sequential.py]
primary_type: T-DomainBound
tier: T3
loc_axis: L1
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`SequentialFeatureSelector`에 `cv` 인자로 cross-validator의 `.split()` 결과(제너레이터)를 넘기면 `IndexError: list index out of range`가 발생한다. 문서상으로는 splits의 iterable을 받을 수 있어야 하지만, 내부 `fit` 루프가 동일 `self.cv` 제너레이터를 매 반복마다 재소비하려 해서 두 번째 반복부터 빈 split이 되어 깨진다. 다른 `*SearchCV` 클래스와 달리 `check_cv`를 거치지 않은 것이 원인이다.

## 유형 (정형화)
- **L = L1 (Traceable)**: 이슈가 클래스(`SequentialFeatureSelector`)와 인자(`cv`)를 명시하고 native 스택트레이스(`_aggregate_score_dicts`)까지 준다. 단 실제 픽스 지점은 트레이스의 최하단이 아니라 `_sequential.py::fit`의 루프 구조이므로 약간의 역추적이 필요 → grep 한 방(L0)은 아님.
- **S = S2 (Constraint-Reasoning) +S5**: 고칠 함수는 명확하나, "제너레이터 1회 소비" 불변식을 파악하고 sklearn 관례(`check_cv`로 cv를 1회 materialize)대로 합성해야 한다. hints에 정답이 들어있어 본질은 추론(S2)이며, "다른 cv 객체와 동일하게 동작해야 한다"는 의도 재구성(S5)이 보조.
- **K = K-Domain**: `check_cv(cv, y, classifier=...)`가 제너레이터를 list로 materialize한다는 sklearn 내부 계약과 `is_classifier(estimator)` 분기가 핵심. 일반 파이썬 추론만으로는 "왜 check_cv가 해법인지" 도달하기 어렵다.
- **primary = T-DomainBound**: 병목이 프레임워크 내부 cv-handling 관례 지식. 픽스 자체는 작지만 sklearn estimator의 cv 표준 처리 경로를 알아야 한다.
- repair strategy 근거: 후보 패치를 다수 던져보는 G&V가 아니라, 제너레이터 1회-소비라는 단일 불변식을 이해하고 표준 헬퍼로 교정하는 의미적 수리 → S2.

## 난이도 티어
**T3 (중간)**. 구조적 피처: 1파일·단일 함수 수정, +4/-4줄 수준의 소규모, has-repro 존재(강한 easiness 신호). 그러나 L1 역추적(스택트레이스 최하단 ≠ 수정 지점)과 K-Domain(`check_cv` 관례)이 T2를 넘긴다. 공식 라벨은 `<15 min fix`(=T1~T2 prior)지만, "제너레이터가 루프에서 한 번만 소비된다"는 비자명한 인과를 짚고 sklearn 표준 cv 처리로 매핑하는 도메인 추론이 필요하므로 T3로 상향. P2P 71개라는 넓은 regression 표면(전 sanity/n_features 경로)이 있어 픽스가 기존 cv-int 경로 동작을 보존해야 한다는 제약도 T2를 넘기는 요인.

## 골드패치 분석
- **파일**: `sklearn/feature_selection/_sequential.py` 단일.
- **import 추가**: `is_classifier`(from `..base`), `check_cv`(from `..model_selection`).
- **`fit(self, X, y)`**: 루프 진입 전에 `cv = check_cv(self.cv, y, classifier=is_classifier(self.estimator))` 한 줄 추가. 이로써 제너레이터를 **단 한 번** list로 materialize한 재사용 가능한 cv 객체를 만든다.
- **시그니처 변경**: `_get_best_new_feature_score(self, estimator, X, y, current_mask)` → `(self, estimator, X, y, cv, current_mask)`. `fit`의 호출부도 `cv`를 전달하도록 수정.
- **`cross_val_score(..., cv=self.cv, ...)` → `cv=cv`**: 매 반복이 재사용 가능한 materialized cv를 받는다.
- **근본원인**: 기존 코드는 루프의 각 반복(각 후보 feature)마다 `cv=self.cv`로 `cross_val_score`를 호출. `self.cv`가 제너레이터면 첫 후보에서 소진되고, 이후 후보들은 빈 split을 받아 `scores`가 비고 `_aggregate_score_dicts`에서 `scores[0]`이 IndexError.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_cv_generator_support`. `LeaveOneGroupOut().split(X, y, groups)`로 만든 **제너레이터**를 `cv=splits`로 넘기고 `sfs.fit(X, y)`가 예외 없이 끝나는지 확인. 이슈 #25957의 정확한 재현을 비회귀 테스트로 고정.
- **픽스 증명**: `check_cv`가 제너레이터를 내부에서 list로 변환하므로 두 번째 이후 후보 반복에서도 split이 보존 → IndexError 소멸. 테스트가 `fit` 완주만 단언하는 것이 적절(올바른 동작 = 예외 없이 모든 split 반복).
- **overfit 관점**: FAIL_TO_PASS가 1개라 얇아 보이나, 픽스가 "제너레이터 special-case"가 아니라 모든 cv 입력을 `check_cv`로 표준화하는 일반 해법이라 overfit 위험 낮음. special-case로 통과시킬 여지가 거의 없다.
- **regression 관점**: P2P 71개(int cv, sanity, n_features, pipeline, sparse/nan support 등 전 경로). `check_cv(5, ...)`는 기존 KFold/StratifiedKFold 동작과 동치이므로 `cv=int`/`cv=None` 경로 불변 — 그래서 71개 모두 green 유지.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "cv=splits에서 IndexError" + 스택트레이스(`_aggregate_score_dicts`, `scores[0]`)에서 시작하되, 트레이스 최하단이 아니라 호출 출처를 거슬러 `_sequential.py::_get_best_new_feature_score`의 `cross_val_score(cv=self.cv)`와 이를 감싼 `fit`의 `for _ in range(n_iterations)` 루프로 수렴. 핵심 통찰: 같은 `self.cv` 제너레이터가 루프에서 반복 소비됨.
2. **픽스**: 루프 진입 전 1회만 `cv = check_cv(self.cv, y, classifier=is_classifier(self.estimator))`로 materialize하고, 이 `cv`를 루프/`cross_val_score`에 전달. 이것이 올바른 일반화인 이유 — `check_cv`는 int/None/iterable/제너레이터를 모두 표준 cv로 환원하는 sklearn 공식 계약이며, `*SearchCV`와 동일 동작을 보장(hints의 maintainer 가이드와 일치). 제너레이터를 그저 `list(self.cv)`로 감싸는 것보다 분류기 여부에 따른 stratification까지 일관 처리.
3. **regression 안전**: `cv=int`/`cv=None`/`cv=KFold객체` 경로(P2P의 sanity·n_features·pipeline 등 71케이스)가 안 깨져야 한다. `check_cv`는 이들 입력에 대해 기존과 동치 객체를 돌려주므로 안전. `is_classifier` 분기로 regressor(LinearRegression 등) 경로의 KFold 기본도 보존.
4. **함정 회피**: (a) 스택트레이스 최하단(`_validation.py`)을 고치려 들면 잘못된 위치 — 진짜 원인은 호출자의 제너레이터 재사용. (b) `_get_best_new_feature_score` 안에서 `list(self.cv)`를 만들면 매 반복마다 빈 제너레이터를 list화해 여전히 깨짐 → materialize는 반드시 루프 **밖**에서 1회. (c) `_get_best_new_feature_score` 시그니처에 `cv`를 추가하지 않고 `self.cv`만 in-place로 덮어쓰면 estimator immutability/clone 관례를 위반 — 골드처럼 지역변수 `cv`를 명시 전달하는 것이 정석.
