---
instance_id: scikit-learn__scikit-learn-14710
repo: scikit-learn/scikit-learn
base_commit: 4b6273b87442a4437d8b3873ea3022ae163f4fdf
version: "0.22"
difficulty: "15 min - 1 hour"
created_at: "2019-08-21T16:29:47Z"
fail_to_pass: 1
pass_to_pass: 63
gold_files: [sklearn/ensemble/_hist_gradient_boosting/gradient_boosting.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약

`HistGradientBoostingClassifier`에 문자열 타깃(`y = ['x','y',...]`)을 주고 early stopping(`n_iter_no_change`)을 켜면 `fit` 중 `TypeError: '<' not supported between instances of 'str' and 'float'`가 난다. early stopping용 scorer가 내부적으로 정수 인코딩된 `y_true`를 받지만 `estimator.predict`가 원래 클래스(문자열)를 돌려줘서, `accuracy_score → _check_targets → np.union1d`에서 str과 float를 비교하다 터진다. scorer에 넘기기 전에 정수 타깃을 원래 클래스 라벨로 디코딩해야 한다.

## 유형 (정형화)

- **L1 (Traceable)**: 이슈에 네이티브 스택트레이스가 있어 `gradient_boosting.py`의 `_check_early_stopping_scorer`로 곧장 수렴한다. 다만 "근본원인이 scorer 호출 직전의 y 인코딩 불일치"라는 인과는 트레이스 끝 프레임이 아니라 한 단계 위(`self.scorer_(self, ..., y_small_train)`)에 있어 grep 한 방은 아니다. → L1.
- **S2 Constraint-Reasoning (+S1)**: 고칠 지점은 명확하나, "왜 `y_true`는 int인데 `y_pred`는 string인가"라는 불변식(scorer는 estimator의 출력 공간과 같은 라벨 공간을 기대)을 추론해 `self.classes_[y.astype(int)]` 디코딩 식을 합성해야 한다. 분류기에만 적용(`is_classifier` 가드)하는 부분은 S1성 가드. 따라서 dominant는 S2.
- **K-Domain**: scikit-learn estimator 계약 — `classes_`/`is_classifier`/scorer가 `predict` 출력과 동일 라벨공간을 비교한다는 내부 규약을 알아야 픽스가 일반화된다. K-Gen 추론만으로는 "int를 classes_로 인덱싱"이라는 도메인 관용구가 안 나온다.
- **primary = T-ConstraintReason**: 위치는 좁게 잡히지만 진짜 일은 올바른 디코딩 조건·식을 의미적으로 합성하는 데 있다(템플릿 None-guard류 아님).

## 난이도 티어

**T3 (중간)**. 구조적 피처: 단일 파일 1개·실질 변경 4줄(가드 2 + 디코딩 2), localize는 has-repro 덕에 비교적 직접적이라 난이도를 낮춘다. 그러나 (a) 근본원인이 "트레이스 최하단 numpy 비교 에러"가 아니라 "scorer에 들어가는 y의 라벨공간 불일치"라는 한 단계 추상화된 인과여서 표면적 패치(np 비교 회피 등)로 오답 가능, (b) `is_classifier` 가드를 빠뜨리면 회귀(regression) early stopping을 깨는 P2P trap이 있다. 공식 라벨 "15 min - 1 hour"와 정합 — L0/S1 자명픽스(T1/T2)보다는 의미추론이 필요하고, 멀티파일·overfit 고위험(T4/T5)까지는 아니다.

## 골드패치 분석

- **파일/함수**: `sklearn/ensemble/_hist_gradient_boosting/gradient_boosting.py`의 `BaseHistGradientBoosting._check_early_stopping_scorer`.
- **근본원인**: 이 클래스는 fit 내부에서 타깃을 정수로 인코딩(`y_small_train`, `y_val`이 0/1...)해 트리를 학습한다. 그런데 early stopping 점수는 `self.scorer_(self, X, y)` → `estimator.score` → `accuracy_score(y_true=y, y_pred=self.predict(X))` 경로를 타는데, `predict`는 `self.classes_`로 디코딩한 **원래 라벨(문자열)**을 반환한다. 즉 `y_true`(int)와 `y_pred`(str)의 라벨공간이 불일치해 `_check_targets`의 `np.union1d`에서 비교 예외.
- **수정요지**: scorer 호출 직전에 `if is_classifier(self): y = self.classes_[y.astype(int)]`로 정수 타깃을 원래 클래스로 되돌린다. train 경로와 validation 경로(`self._use_validation_data`) 양쪽 모두에 적용. 회귀기에는 `classes_`가 없고 디코딩이 무의미하므로 `is_classifier` 가드로 분류기에만 한정한다. (이슈 제안의 `hasattr(self, 'classes_')` 대신 골드는 `is_classifier(self)`를 써 estimator 계약에 정확히 정렬.)

## 검증 (test_patch)

- **FAIL_TO_PASS (1)**: `test_string_target_early_stopping[None]` — `y = ['x']*50+['y']*50` (object dtype) 으로 `HistGradientBoostingClassifier(n_iter_no_change=10, scoring=None)`를 fit. 픽스 전엔 scoring=None(=passthrough `estimator.score`)이 int y_true vs str y_pred로 TypeError. 디코딩 후 `y_true`도 문자열이 되어 `accuracy_score`가 정상 동작.
- **픽스 증명**: 에러가 `np.union1d`의 dtype 충돌에서 발생하므로, scorer 진입 전 y를 동일 라벨공간으로 맞추는 것이 직접적 인과 차단. `astype(int)` 인덱싱은 fit이 인코딩한 정수가 `classes_` 인덱스와 1:1이라는 보장 위에서 정확.
- **overfit/regression 관점**: `[loss]` 변종은 P2P(63개)에 들어 있어 scoring='loss'(scorer 미사용) 경로가 안 깨짐을 같이 보증한다. P2P에 `test_early_stopping_classification`/`test_early_stopping_regression` 전수가 있어 — 회귀기에 디코딩을 잘못 적용하면 즉시 RED. 따라서 `is_classifier` 가드가 회귀 안전의 핵심. F2P가 1개로 얇지만 P2P가 두 estimator·여러 scoring을 망라해 overfit 위험은 낮다.

## 모범답안 (오라클 기반)

1. **localize**: 트레이스를 끝에서 위로 읽되 numpy 프레임(`union1d`/`_unique1d`)은 증상으로 무시하고, scikit-learn 경계인 `_check_early_stopping_scorer`의 `self.scorer_(self, X_binned_small_train, y_small_train)` 호출을 원인 지점으로 지목. 에러 메시지("str vs float")=y_true/y_pred 라벨공간 불일치 신호.
2. **픽스**: scorer 호출 직전에 정수 타깃을 `self.classes_[y.astype(int)]`로 원래 라벨로 디코딩. 이것이 overfit이 아닌 올바른 일반화인 이유 — `predict`가 항상 `classes_` 라벨을 돌려주므로, 모든 비수치 타깃(문자열/객체/임의 라벨)에 대해 y_true를 동일 공간으로 정렬하는 근본 교정이다. 특정 입력에 맞춘 회피가 아니다.
3. **regression 안전**: train과 validation 두 경로 모두 패치하고, 회귀기에는 `classes_`가 없으니 `is_classifier(self)`로 가드. 이로써 `test_early_stopping_regression` 전 케이스와 수치 타깃 분류 케이스가 그대로 통과.
4. **함정 회피**: (a) 한쪽(train만) 패치하면 validation early stopping 경로에서 재발 → 두 곳 모두. (b) 가드 없이 무조건 디코딩하면 회귀 P2P가 깨짐. (c) 이슈가 제안한 `hasattr(self,'classes_')`도 동작하지만, 골드의 `is_classifier(self)`가 estimator 계약상 더 견고(속성 유무가 아니라 estimator 타입으로 판정). (d) numpy 비교를 우회하려 `_check_targets`/scorer를 건드리는 광역 수정은 불필요한 cross-module 변경이자 오답 경로.
