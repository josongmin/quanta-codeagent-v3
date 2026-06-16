---
instance_id: scikit-learn__scikit-learn-14894
repo: scikit-learn/scikit-learn
base_commit: fdbaa58acbead5a254f2e6d597dc1ab3b947f4c6
version: "0.22"
difficulty: "15 min - 1 hour"
created_at: 2019-09-05T17:41:11Z
fail_to_pass: 1
pass_to_pass: 85
gold_files: [sklearn/svm/base.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [has-repro]
---

## 문제 요약
sparse 데이터로 SVM(SVR linear 커널 등)을 fit할 때, support_vectors_가 비는 경우 `_sparse_fit`에서 `ZeroDivisionError: float division by zero`가 난다. 원인은 `np.arange`의 step 인자로 `dual_coef_indices.size / n_class`를 넘기는데, support vector가 0개면 `dual_coef_indices.size == 0`이 되어 step이 0이 되기 때문이다. 동일 데이터를 dense로 주면 에러가 없다. 기대 동작은 예외 없이 `self.dual_coef_ = sp.csr_matrix([])`로 빈 행렬을 세팅하는 것이다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 네이티브 트레이스백이 `sklearn/svm/base.py`의 `_sparse_fit`, 정확히 `dual_coef_indices.size / n_class` 라인을 지목한다. grep 한 방이며 탐색 사실상 불요.
- **S1 (Direct-Map)**: 정형 결함 클래스(0으로 나눗셈 / 빈-컬렉션 가드)에 그대로 매칭. 이슈가 기대 결과(`sp.csr_matrix([])`)까지 명세해 픽스가 사실상 처방됨. 합성할 식이 없고 기계적 가드 추가다.
- **K-Gen**: 일반 파이썬/numpy 추론으로 충분. `np.arange(start, stop, step)`에서 step=0이 division by zero라는 사실 외에 SVM 내부 도메인 지식 불요.
- **primary = T-DirectMap**: 위치는 트레이스백으로 자명하고 픽스는 None/empty 가드라는 템플릿(S1)에 정확히 떨어진다. T-LocTrivial이 아닌 이유는 가드의 올바른 placement(indptr 계산 전체를 우회)를 골라야 하기 때문 — 그래도 추론량은 최소.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처:
- 파일수 1 / 함수 1(`_sparse_fit`) / 변경 ~7줄 — ICLR 컷에서 "1파일·소규모 ≈ 고solve" 구간.
- **localize 직접성 최상**: native ZeroDivisionError 트레이스백 + 재현 스니펫(`has-repro`)이 라인을 직접 가리킴.
- 도메인 추론 없음, P2P 84개지만 전부 기존 SVM 경로라 빈-가드 추가가 인접 동작을 건드리지 않음(regression-trap 약함).
공식 라벨 "15 min - 1 hour"보다 약간 낮은 체감이나, 빈 케이스에서 `dual_coef_`를 무엇으로 채울지(`sp.csr_matrix([])`) 결정하고 가드 위치를 잡는 가벼운 판단이 있어 T1이 아닌 T2로 둔다. 이슈가 기대값을 명시해 그 판단조차 거의 처방됨.

## 골드패치 분석
- **파일·함수**: `sklearn/svm/base.py`의 `BaseLibSVM._sparse_fit`.
- **근본원인**: `dual_coef_indptr = np.arange(0, dual_coef_indices.size + 1, dual_coef_indices.size / n_class)`에서 step = `dual_coef_indices.size / n_class`. support vector가 없으면 `n_SV = self.support_vectors_.shape[0] == 0` → `dual_coef_indices = np.tile(np.arange(n_SV), n_class)`가 빈 배열 → `.size == 0` → step=0 → `np.arange` float division by zero.
- **수정요지**: indptr 계산·`csr_matrix` 생성 직전에 `if not n_SV:` 가드를 추가해 빈 경우 `self.dual_coef_ = sp.csr_matrix([])`로 바로 세팅하고, 그렇지 않을 때만 기존 indptr/csr_matrix 경로를 탄다. 즉 0으로 나누는 식 자체를 빈 케이스에서 실행하지 않게 분기.

## 검증 (test_patch)
- **FAIL_TO_PASS** `test_sparse_fit_support_vectors_empty` (#14893 regression test): sparse `X_train`(4x4)와 `y_train`으로 `svm.SVR(kernel='linear')`를 fit. 픽스 전엔 fit 중 `_sparse_fit`에서 ZeroDivisionError로 즉시 실패. 픽스 후 fit이 통과하고 `assert not model.support_vectors_.data.size`, `assert not model.dual_coef_.data.size`로 빈 SV / 빈 dual_coef를 확인.
- **픽스 증명**: 가드가 step=0 산술을 차단하므로 예외가 사라지고, `sp.csr_matrix([])`는 `.data.size == 0`이라 두 단언을 만족.
- **overfit/regression 관점**: 테스트는 빈-SV 분기만 직접 검증해 얇지만(`overfit-risk` 경계), 가드가 `not n_SV`라는 일반 조건이라 special-case 하드코딩이 아닌 올바른 일반화다. 비어있지 않은 경로는 `else`로 기존 코드를 그대로 보존하므로 84개 PASS_TO_PASS(정상 SVM/SVR/LinearSVC 전 경로)가 안전.

## 모범답안 (오라클 기반)
1. **localize 경로**: 트레이스백의 `base.py:302 dual_coef_indices.size / n_class` + 메시지 `ZeroDivisionError: float division by zero` → `_sparse_fit`의 `np.arange` step 인자로 직행. dense 경로는 무사하다는 이슈 단서로 sparse-전용 함수임을 확정.
2. **픽스**: step이 0이 되는 유일 조건은 `dual_coef_indices.size == 0`, 즉 `n_SV == 0`. 따라서 `if not n_SV:`로 빈 분기를 만들고 이슈가 명시한 `sp.csr_matrix([])`를 세팅, else에서만 indptr/csr_matrix를 계산. 이는 0-나눗셈 식의 사전조건(support vector 존재)을 명시화한 것이라 overfit이 아닌 정당한 가드.
3. **regression 안전**: 비어있지 않은 모든 fit은 `else`로 원본 로직을 그대로 타야 한다 — 따라서 `test_svr`, `test_linearsvr`, `test_oneclass`, sample_weight/negative-weight 계열 등 84개 P2P가 byte-수준으로 동일 동작 유지. 가드를 indptr 계산 "이후"에 두면 이미 예외가 나므로, 반드시 indptr 계산 "이전"에 분기해야 함.
4. **함정 회피**: (a) `dual_coef_indptr` 계산만 가드하고 `csr_matrix(...)` 호출은 그대로 두면, 빈 indices/indptr로 shape `(n_class, 0)` 행렬을 만들려다 또 깨질 수 있음 → csr 생성 전체를 분기로 감싸야 함. (b) `n_SV` 대신 `n_class`로 가드하면 원인을 잘못 짚음(0이 되는 건 분자 size지 n_class 아님). (c) 빈 값을 `sp.csr_matrix((n_class, n_SV))`처럼 추측하지 말고 이슈가 명시한 `sp.csr_matrix([])`를 따를 것 — 테스트가 `.data.size == 0`만 보므로 over-engineering 불요.
