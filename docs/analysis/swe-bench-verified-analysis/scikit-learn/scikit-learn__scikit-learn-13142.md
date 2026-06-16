---
instance_id: scikit-learn__scikit-learn-13142
repo: scikit-learn/scikit-learn
base_commit: 1c8668b0a021832386470ddf740d834e02c66f69
version: "0.21"
difficulty: "<15 min fix"
created_at: 2019-02-12T14:32:37Z
fail_to_pass: 2
pass_to_pass: 54
gold_files: [sklearn/mixture/base.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`GaussianMixture`(및 `BayesianGaussianMixture`)에서 `n_init>1`로 fit할 때 `fit_predict(X)`와 `fit(X).predict(X)`의 라벨이 서로 다르게 나온다(이슈 재현에서 88.6% mismatch). `n_init=1`일 때는 일치하므로 다중 초기화 경로에 한정된 버그다. 원인은 `fit_predict`가 마지막(best가 아닌) 초기화의 파라미터 상태로 final e-step을 돌려 그 결과를 반환하는 데 있다.

## 유형 (정형화)
- **L(Localization) = L1 (Traceable)**: 이슈가 `fit_predict` vs `predict` 불일치를 직접 지목하고 hints에서 `base.py`의 `_e_step` 호출 위치(base.py:263 부근)까지 짚어준다. 단일 파일 `sklearn/mixture/base.py`의 `BaseMixture.fit_predict`로 바로 수렴. grep 한 방은 아니나 후보가 좁다.
- **S(Strategy) = S2 Constraint-Reasoning (+S6 미세 reorder)**: 픽스 자체는 코드 줄을 옮기는 것이지만, "왜 옮겨야 하는가"는 `_e_step(X)`가 인자 없이 **estimator의 현재 attribute(파라미터)를 읽는다**는 불변식을 추론해야 도출된다. best 파라미터 복원(`_set_parameters(best_params)`) 이후에 e-step이 와야 반환 라벨이 best 모델과 일관된다는 의미적 조건 합성이 본질. 한 줄 reorder라 S6는 보조.
- **K(Knowledge) = K-Domain**: GMM의 EM(E/M-step) 의미론과 sklearn mixture estimator가 파라미터를 attribute로 보유한다는 내부 계약을 알아야 인과를 정확히 짚는다. 일반 파이썬 추론만으로는 "줄을 옮기면 된다"의 근거를 못 만든다.
- **primary = T-ConstraintReason**: 위치는 명확하나 올바른 수정의 정당화가 불변식 추론(파라미터-상태 의존성)에 달려 있어 T-ConstraintReason이 dominant. S1 기계적 가드가 아님.

## 난이도 티어
**T3 (중간).** 구조적 피처: 파일수 1개, 실효 변경 ≲5줄(코드 블록 1개 이동), `has-repro`(완전한 재현 스크립트 + 스택트레이스 = 강한 easiness 신호), localize 직접성 높음(hints가 라인까지 지목). 이 피처들만 보면 T2지만, 픽스의 정당성이 "`_e_step`이 attribute를 읽는다"는 도메인 불변식 추론에 걸려 있고 그걸 놓치면 잘못 고친다는 점(hints에서 maintainer 본인도 처음에 놓쳤다고 언급)이 T3로 민다. 또 P2P 54개 중 `test_multiple_init`, `test_gaussian_mixture_fit_best_params`, 파라미터화된 `fit_predict[...]` 케이스 등 인접 best-param 동작을 안 깨야 해 `regression-trap`이 약하게 존재. 공식 라벨 `<15 min fix`는 "정답을 아는 개발자의 구현시간"이라 reorder 한 줄로 짧지만, 에이전트 관점의 인과 추론 난점은 시간라벨에 안 잡혀 T1이 아닌 T3.

## 골드패치 분석
- **파일·함수**: `sklearn/mixture/base.py`의 `BaseMixture.fit_predict(self, X, y=None)`.
- **근본원인**: 기존 코드는 n_init 루프 종료 직후, **best 파라미터를 복원하기 전에** `_, log_resp = self._e_step(X)`를 실행했다. 이 시점의 estimator attribute는 루프 마지막 초기화의 파라미터이므로, `log_resp.argmax(axis=1)`로 반환되는 라벨이 best 모델이 아닌 마지막 초기화 기준으로 계산됐다. 반면 `predict`는 fit 종료 시 `_set_parameters(best_params)`로 복원된 best 파라미터를 사용 → 둘이 불일치.
- **수정요지**: final e-step 블록(`_, log_resp = self._e_step(X)` + 그 위 주석 3줄)을 `self._set_parameters(best_params)` / `self.n_iter_ = best_n_iter` / `self.lower_bound_ = max_lower_bound` **이후**, `return log_resp.argmax(axis=1)` 직전으로 이동. 이제 e-step이 복원된 best 파라미터를 읽어 라벨이 `predict`와 동일해진다. 로직 추가/삭제 없이 순서만 교정.

## 검증 (test_patch)
- **FAIL_TO_PASS (2)**: `test_gaussian_mixture_fit_predict_n_init`, `test_bayesian_mixture_fit_predict_n_init`. 둘 다 `n_init=5`(또는 10)로 `fit_predict(X)` 결과 `y_pred1`과 직후 `predict(X)`의 `y_pred2`를 `assert_array_equal`로 정확 일치 검증. 기존 코드에선 마지막 초기화 e-step 결과를 반환해 mismatch → FAIL. 패치 후 best 파라미터 기준 e-step이라 정확히 일치 → PASS. 두 서브클래스(Gaussian/Bayesian)가 동일 base의 `fit_predict`를 공유하므로 한 곳 수정이 양쪽을 동시에 고침을 증명.
- **overfit 관점**: 픽스는 special-case가 아니라 "반환 라벨은 복원된 best 모델로 계산"이라는 일반 불변식을 만족시키므로 overfit 위험 낮음. 테스트도 임의 라벨 값이 아니라 `fit_predict==predict` 등가성을 검증해 견고.
- **regression 관점**: 기존 `test_gaussian_mixture_fit_predict[...]`(n_init 미지정) 4종, `test_multiple_init`, `test_gaussian_mixture_fit_best_params`가 P2P로 그대로 통과해야 함 — n_init=1 경로와 best-param 선택 자체는 불변이므로 안전.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "fit_predict와 predict 불일치, n_init>1에서만"이라는 신호 → 두 메서드가 갈리는 지점이 `BaseMixture.fit_predict`의 final e-step. `predict`는 best 파라미터를 쓰는데 `fit_predict`는 별도 e-step을 돌린다는 비대칭을 발견. hints가 `base.py`의 `_e_step` 호출 라인까지 지목.
2. **픽스와 일반화 근거**: `_e_step(X)`는 인자로 파라미터를 받지 않고 estimator attribute에서 읽는다 — 따라서 호출 시점의 attribute 상태가 결과를 결정한다. final e-step을 `_set_parameters(best_params)` **이후**로 옮기면 best 모델 기준 responsibilities를 계산해 `predict`와 등가가 된다. 이는 입력 무관하게 성립하는 불변식이라 올바른 일반화.
3. **regression 안전**: n_init=1 경로(파라미터화 `fit_predict[...]`), best-param 선택 로직(`test_multiple_init`, `test_..._fit_best_params`), 수렴 경고(`test_gaussian_mixture_fit_convergence_warning`)를 깨지 않아야 함. 코드 추가/삭제 없이 순서만 바꿔 이들 동작은 불변 — 안전.
4. **함정 회피**: 오라클 없는 에이전트는 (a) e-step을 지워버리거나(그러면 `log_resp` 미정의 → 다른 버그), (b) `predict` 쪽을 바꾸려 하거나, (c) `_e_step`이 인자 없이 attribute를 읽는다는 사실을 놓쳐 "왜 이동이 맞는지" 정당화 못 하고 best_params를 e-step에 직접 넘기는 식의 과한 변경을 할 수 있다. 핵심은 attribute-상태 의존을 인지하고 **블록을 best 복원 뒤로 이동**하는 최소 변경에 머무는 것.
