---
instance_id: scikit-learn__scikit-learn-11578
repo: scikit-learn/scikit-learn
base_commit: dd69361a0d9c6ccde0d2353b00b86e0e7541a3e3
version: "0.20"
difficulty: "15 min - 1 hour"
created_at: 2018-07-16T23:21:56Z
fail_to_pass: 1
pass_to_pass: 93
gold_files: [sklearn/linear_model/logistic.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`neg_log_loss` 같은 확률 기반 스코어러로 `LogisticRegressionCV(multi_class='multinomial')`를 채점하면, 내부적으로 OvR 방식으로 확률을 계산해 잘못된 점수가 나온다. 원인은 헬퍼 `_log_reg_scoring_path()`가 채점용으로 만드는 `LogisticRegression` 인스턴스를 `multi_class` 인자 없이 생성해 기본값 `'ovr'`이 적용되기 때문이다. 이슈 제출자가 최소 재현 코드까지 첨부했고, 고칠 라인(L922)과 수정안까지 직접 지목했다.

## 유형 (정형화)
- **L = L0 (Pinpointed)**: 이슈 본문이 파일·함수·라인 번호(`logistic.py` L922, `_log_reg_scoring_path`)와 깨지는 심볼(`log_reg = LogisticRegression(fit_intercept=fit_intercept)`)을 정확히 지목. grep 한 방.
- **S = S2 (Constraint-Reasoning)**: 위치는 자명하나 "왜 `multi_class`만 전달하면 충분하고 `fit_intercept`는 빼도 되는가"를 추론해야 한다. 채점 함수가 호출하는 `predict_proba`에서 분기를 가르는 유일 변수가 `self.multi_class`이고, `coef_`/`intercept_`는 뒤에서 수동 주입되므로 `fit_intercept`는 무의미함을 따져야 골드와 동일한 식(`LogisticRegression(multi_class=multi_class)`)이 나온다. 기계적 가드 추가(S1)가 아니라 불변식 추론.
- **K = K-Domain**: OvR vs multinomial에서 `predict_proba`가 시그모이드-정규화 대 softmax로 갈린다는 scikit-learn 내부 동작 지식이 핵심.
- **primary = T-ConstraintReason**: 위치는 명확(L0)하나 올바른 인자 집합을 의미 추론으로 합성하는 게 본질. 단순 None가드/상수변경이 아니므로 T-DirectMap이 아니다.

## 난이도 티어
**T3 (중간)**. 구조적 피처: 1파일·1줄(헌크 1개)·localize 완전 직접(L0)·`has-repro`로 easiness 신호가 매우 강함. 이 셋만 보면 T2에 가깝다. 그러나 T3으로 미는 요인은 (1) S2 의미 추론 — `fit_intercept`를 빼고 `multi_class`로 교체하는 비자명한 인자 재구성, (2) `regression-trap` — P2P 95개로 넓고, 같은 신규 파라미터화 테스트의 OvR 케이스(accuracy/precision/f1/recall)를 깨면 안 됨. 공식 라벨 "15 min - 1 hour"와 정합. T4로 올리지 않는 이유는 멀티사이트·refactor·cross-file가 없기 때문.

## 골드패치 분석
- **건드린 파일·함수**: `sklearn/linear_model/logistic.py` 내 `_log_reg_scoring_path()` (라인 922 부근).
- **근본원인**: 채점용 더미 추정기 생성 시 `LogisticRegression(fit_intercept=fit_intercept)` — `multi_class`를 전달하지 않아 생성자 기본값 `'ovr'`로 고정. 이후 `coef_`/`intercept_`는 경로에서 찾은 값으로 수동 주입되지만 `predict_proba`는 `self.multi_class=='ovr'` 분기를 타서 multinomial 모델인데도 OvR 확률을 반환.
- **수정요지**: `log_reg = LogisticRegression(multi_class=multi_class)`로 교체. `multi_class`를 호출자의 옵션에서 상속시키고, 채점 결과에 영향 없는 `fit_intercept`는 제거(intercept는 뒤에서 수동 설정되므로 불필요).

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_logistic_cv_multinomial_score[neg_log_loss-multiclass_agg_list3]`. 새 파라미터화 테스트 `test_logistic_cv_multinomial_score`가 `_log_reg_scoring_path(...)[2][0]`(반환된 점수)가 동일 `multi_class='multinomial'` 추정기를 직접 채점한 `scorer(lr, X[test], y[test])`와 일치하는지 검증. 확률 기반 `neg_log_loss`만 OvR/multinomial 확률이 실제로 갈리므로 수정 전 이 케이스가 실패한다.
- **픽스 증명**: 패치 후 더미 추정기가 softmax 경로를 타 `predict_proba`가 참조 추정기와 동일 확률을 내므로 `assert_array_almost_equal` 통과.
- **overfit·regression 관점**: 파라미터화의 accuracy/precision/f1/recall 케이스는 `predict`/임계값 기반이라 multi_class 무관해 수정 전후 모두 통과 — 즉 FAIL_TO_PASS는 확률 스코어러로 한정돼 overfit이 아닌 진짜 일반화를 강제한다. P2P 95개(warm_start·solver별·iris 등)는 `fit_intercept` 제거가 채점 외 경로를 안 건드림을 보장해야 안전.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 라인 번호(L922)와 깨지는 표현식을 직접 지목 → `_log_reg_scoring_path` 안의 `log_reg = LogisticRegression(fit_intercept=fit_intercept)` 한 줄로 즉시 수렴. 추가 탐색 불필요(L0).
2. **픽스와 일반화 근거**: 채점 함수가 호출하는 `predict_proba`에서 OvR/multinomial을 가르는 유일 변수가 `self.multi_class`이고 `coef_`/`intercept_`는 뒤에서 수동 주입되므로, `multi_class=multi_class`만 상속시키면 모든 확률 스코어러에 대해 올바른 확률 경로가 보장된다. 특정 스코어러용 분기를 추가하는 게 아니라 인자 전파라 일반화가 정당. `fit_intercept` 제거는 채점에 무영향이므로 안전한 단순화.
3. **regression 안전**: P2P 95개(특히 `test_warm_start[*]`·`test_logistic_cv`·`test_logistic_regression_solvers*`)는 채점 경로 외 학습/계수 경로를 검증 — 골드는 더미 추정기 생성만 바꾸고 `logistic_regression_path` 계산은 손대지 않아 이들을 안 깬다. 신규 파라미터화의 비확률 스코어러 4케이스도 그대로 통과.
4. **함정 회피**: (a) 힌트에 끌려 penalty·dual·tol 등 "유사 파라미터 전부 전달"로 과수정하면 채점 무관 인자까지 끌어와 불필요한 표면 확대·잠재 회귀 위험 — 채점에 실제 영향 주는 `multi_class`만 전달이 정답. (b) 스코어러 종류로 분기하는 special-case는 overfit. (c) `fit_intercept`를 보존하려다 의미를 오해하기 쉬우나, intercept 수동 주입을 확인하면 제거가 옳음.
