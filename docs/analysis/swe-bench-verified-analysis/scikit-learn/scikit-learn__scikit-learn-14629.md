---
instance_id: scikit-learn__scikit-learn-14629
repo: scikit-learn/scikit-learn
base_commit: 4aded39b5663d943f6a4809abacfa9cae3d7fb6a
version: "0.22"
difficulty: "15 min - 1 hour"
created_at: "2019-08-12T09:31:54Z"
fail_to_pass: 1
pass_to_pass: 26
gold_files: [sklearn/multioutput.py]
primary_type: T-DirectMap
tier: T3
loc_axis: L1
repair_strategy: S1 (+S5)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`cross_val_predict(method='predict_proba')`를 `MultiOutputClassifier`와 함께 쓰면 `AttributeError: 'MultiOutputClassifier' object has no attribute 'classes_'`가 발생한다. `_validation.py`의 `cross_val_predict`가 `estimator.classes_`를 참조하는데, `MultiOutputClassifier`는 fit 후에도 `classes_` 속성을 노출하지 않기 때문이다. 이슈 보고자와 메인테이너는 "모든 분류기는 fit되면 `classes_`를 저장해야 하며, `ClassifierChain`처럼 `MultiOutputClassifier`에도 `classes_`를 추가하자"로 수렴했다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈 본문이 `_validation.py` L857-866의 `estimator.classes_` 사용을 직접 지목하지만, 픽스의 진짜 위치는 그곳이 아니라 `multioutput.py`의 `MultiOutputClassifier`다. 즉 "에러 신호 위치 ≠ 수정 위치"라 한 단계 추론이 필요(소비자 코드를 고칠지 producer 클래스를 고칠지). 메인테이너 힌트가 후자로 못박아 줘서 좁은 단일 후보로 수렴.
- **S1 + S5 (Direct-Map + Spec-Inference)**: 일단 위치가 정해지면 픽스는 기계적 — `fit` 오버라이드해서 `super().fit()` 후 `self.classes_` 세팅. 하지만 "estimator 계약상 fit된 분류기는 `classes_`를 가져야 한다"는 **API 스펙**과 `classes_`가 단일 배열이 아니라 출력별 리스트라는 형태를 ClassifierChain 선례에서 재구성해야 하므로 S5 보조.
- **K-Domain**: sklearn estimator 계약(`classes_` 규약), `MultiOutputEstimator.fit`의 시그니처(`sample_weight` 전달), `estimators_`가 출력별 fitted 서브추정기 리스트라는 내부 구조 지식이 병목.
- primary **T-DirectMap**: localize만 풀리면 픽스는 "속성 추가" 정형 결함클래스. 픽스 핵심은 추론 합성이 아니라 누락된 계약 속성의 기계적 보강.

## 난이도 티어
**T3 (중간)**. 구조적 피처: 단일 파일(`sklearn/multioutput.py`) · 실질 변경 ~6줄(+docstring) · has-repro(완전한 재현 스니펫 + 네이티브 AttributeError 스택). 이는 T2를 가리키지만 **T3로 올리는 요인**: (1) localize 우회 — 에러는 `_validation.py`에서 나지만 정답 수정은 별개 파일의 producer 클래스라, 보고자가 처음 제안한 "consumer 패치" 방향을 따르면 overfit하거나 잘못된 위치를 고친다. (2) `classes_`의 올바른 *형태*(출력별 리스트)를 `ClassifierChain` 선례에서 유추해야 함. (3) regression-trap — 인접 `PASS_TO_PASS` 26개 중 `test_multi_output_classification_sample_weights`, `..._partial_fit` 등이 있어 `fit`에 `sample_weight`를 빠뜨리면 시그니처 호환이 깨진다. 공식 라벨 "15분-1시간"과 정합(T3 하단).

## 골드패치 분석
- **파일·함수**: `sklearn/multioutput.py`, `MultiOutputClassifier`에 신규 `fit(self, X, Y, sample_weight=None)` 메서드 추가. (부수적으로 `ClassifierChain.fit` 내 `raise ValueError("invalid order")` 들여쓰기 정정.)
- **근본원인**: `MultiOutputClassifier`는 `MultiOutputEstimator`의 `fit`을 그대로 상속해 서브추정기들을 `self.estimators_`에 채우지만, sklearn 분류기 계약이 요구하는 `classes_` 속성을 자기 수준에서 노출하지 않는다. 그래서 `cross_val_predict`가 `estimator.classes_`에 접근하면 AttributeError.
- **수정요지**: `super().fit(X, Y, sample_weight)`로 기존 멀티출력 학습을 그대로 수행한 뒤, `self.classes_ = [estimator.classes_ for estimator in self.estimators_]`로 출력별 서브추정기의 `classes_`를 리스트로 모아 노출한다. `sample_weight`를 파라미터로 받아 상위로 전달해 기존 가중치 경로를 보존.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_multi_output_classes_[estimator1]` — `MultiOutputClassifier(RandomForestClassifier(...))`를 fit한 뒤 `estimator.classes_`가 `list`이고 길이가 `n_outputs`이며, 각 원소가 출력별 기대 `classes`와 `assert_array_equal`로 일치하는지 검증. 픽스 전엔 AttributeError로 즉시 실패.
- **픽스 증명**: 골드의 `self.classes_ = [est.classes_ for est in self.estimators_]`가 정확히 "리스트 + 길이 n_outputs + 출력별 클래스 배열" 형태를 만들어 테스트의 세 단언을 모두 충족.
- **overfit/regression**: 테스트가 parametrize로 `RandomForestClassifier`(estimator0), `MultiOutputClassifier`(estimator1), `ClassifierChain`(estimator2)를 함께 돌려, 이번 픽스가 다른 두 분류기의 기존 `classes_` 동작을 깨지 않음을 보장(estimator0/2는 PASS_TO_PASS). regression 관점에선 `fit`이 `sample_weight`를 받고 `super().fit`에 전달하므로 가중치 관련 P2P가 안전. overfit 위험 낮음 — 단일 출력별 배열을 모으는 일반적 형태라 special-case가 아님.

## 모범답안 (오라클 기반)
1. **localize**: 스택트레이스/이슈의 `AttributeError: ... no attribute 'classes_'`와 메인테이너 힌트("`ClassifierChain`처럼 `MultiOutputClassifier`에 `classes_` 추가")를 신호로 삼아, consumer(`_validation.py`)가 아니라 producer(`MultiOutputClassifier`)를 수정 대상으로 확정. `ClassifierChain`이 어떻게 `classes_`를 세팅하는지 같은 파일에서 참고.
2. **픽스**: `MultiOutputEstimator.fit`이 채우는 `self.estimators_`에서 각 서브추정기의 `classes_`를 모아 `self.classes_` 리스트로 노출. 이것이 올바른 일반화인 이유 — sklearn estimator 계약(fit된 분류기는 `classes_`를 가짐)을 멀티출력의 자연스러운 형태(출력별 리스트)로 충족시키며, 특정 cross_val_predict 호출이 아니라 모든 `classes_` 소비자에게 동작.
3. **regression 안전**: `fit` 시그니처에 `sample_weight=None`을 포함해 `super().fit(X, Y, sample_weight)`로 위임 — `test_multi_output_classification_sample_weights`, `..._partial_fit*` 등 P2P가 가중치 전달을 기대하므로 이를 빠뜨리면 깨진다. 기존 학습 로직은 super 호출로 그대로 보존.
4. **함정 회피**: (a) 보고자가 처음 제시한 "consumer(`_validation.py`)에서 `mo_clf.estimators_[i].classes_`로 우회" 방향은 cross_val_predict 한 곳만 땜질하고 다른 `classes_` 소비자엔 무효 — overfit. producer 수정이 정답. (b) `self.classes_`를 단일 배열로 두면(`estimators_[0].classes_`만) 멀티출력 의미가 깨지고 테스트의 `len == n_outputs` 단언 실패. (c) `fit`에서 `sample_weight`를 누락하면 P2P regression.
