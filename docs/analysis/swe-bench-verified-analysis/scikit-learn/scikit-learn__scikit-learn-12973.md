---
instance_id: scikit-learn__scikit-learn-12973
repo: scikit-learn/scikit-learn
base_commit: a7b8b9e9e16d4e15fabda5ae615086c2e1c47d8a
version: "0.21"
difficulty: "15 min - 1 hour"
created_at: 2019-01-13T16:19:52Z
fail_to_pass: 1
pass_to_pass: 32
gold_files: [sklearn/linear_model/least_angle.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S5)
knowledge: K-API
flags: [regression-trap, has-repro]
---

## 문제 요약

`LassoLarsIC`는 생성자 `__init__`에서 `copy_X` 파라미터를 받지만, `fit(self, X, y, copy_X=True)`에서도 동일 이름의 파라미터를 받는다. 두 값이 서로 모순될 수 있는데 `__init__`의 `self.copy_X`와 `fit`의 인자가 각각 한 번씩 사용되어 동작이 섞인다. 특히 `LassoLarsIC(copy_X=False)`로 설정한 뒤 `my_lasso.fit(X, y)`를 호출하면 `fit`의 기본값 `True`가 사용자의 선택을 조용히 덮어쓴다. 이슈는 후방호환을 위해 `fit`의 기본값을 `None`으로 바꿔 명시적으로 전달된 경우에만 override하도록 제안한다.

## 유형 (정형화)

- **L0 (Pinpointed)** — 이슈 본문이 파일·클래스·라인(`least_angle.py` L1487 / `fit` 시그니처)을 직접 지목하고 충돌 메커니즘까지 설명한다. grep 한 방.
- **S1 Direct-Map (+S5 Spec-Inference)** — 결함클래스가 "기본값 충돌"이라는 정형 패턴이고, 이슈가 픽스를 거의 그대로 명세("`fit`이 `None`을 기본값으로 받고 명시적 전달 시에만 override")한다 → S1. 다만 "올바른 후방호환 동작"(기존 코드 안 깨면서 사용자 의도 존중)은 코드만으론 결정되지 않고 이슈/API 관례에서 재구성해야 하므로 보조로 S5.
- **K-API** — `fit`의 시그니처/기본값을 바꾸되 공개 API 후방호환을 정확히 맞춰야 한다(인자 제거 대신 `None` sentinel). 도메인 알고리즘 지식은 불필요.
- **primary = T-DirectMap** — 위치가 명확하고 픽스가 sentinel-default + 분기 추가라는 기계적 변경. 이슈가 직접 처방하므로 추론 합성(T-ConstraintReason)이 아니다.

APR 관점에서 S1인 이유: 이는 PAR/TBar류 "기본값/가드 추가" 템플릿에 거의 그대로 매칭된다. `None` sentinel을 도입하고 `if copy_X is None: copy_X = self.copy_X` 분기를 끼워넣는 정형 변형이며, 후보 탐색(S3)이나 식 합성(S2)이 필요 없다.

## 난이도 티어

**T2 (쉬움)**. 구조적 피처: 단일 파일(`least_angle.py`), 단일 함수(`LassoLarsIC.fit`), 실질 2줄(sentinel 분기 + 인자 사용처 교체) 추가. localize 직접성 최상(L0, has-repro에 준하는 코드 포인터). 도메인 지식 불요. 다만 P2P가 33개로 인접 동작(`test_simple`, `test_lasso_lars_ic`, `test_lars_precompute[LassoLarsIC]` 등)을 안 깨야 해 `regression-trap` 표기 — 그래서 T1이 아니라 T2다. 공식 라벨 "15 min - 1 hour"와 정합적이며, 개발자 시간의 대부분은 테스트 작성·후방호환 판단에 쓰였을 것이다(코드 변경 자체는 자명).

## 골드패치 분석

- **파일·함수**: `sklearn/linear_model/least_angle.py`, `LassoLarsIC.fit`.
- **근본원인**: `fit`이 `copy_X=True`라는 자체 기본값을 갖고, 내부에서 `_preprocess_data(...)` 호출 시 `self.copy_X`가 아니라 이 지역 인자를 전달했다. 따라서 사용자가 `__init__`에서 설정한 `self.copy_X`가 `fit` 무인자 호출에서 항상 `True`로 덮였다.
- **수정요지**:
  1. 시그니처를 `def fit(self, X, y, copy_X=None)`로 변경 (sentinel).
  2. 본문 진입부에 `if copy_X is None: copy_X = self.copy_X` 추가 — 미전달이면 인스턴스 값을 사용.
  3. `_preprocess_data(X, y, self.fit_intercept, self.normalize, self.copy_X)`의 마지막 인자를 지역 변수 `copy_X`로 교체.
  4. docstring 기본값을 `None`으로 갱신하고 override 의미를 명시.

## 검증 (test_patch)

FAIL_TO_PASS는 `test_lasso_lars_fit_copyX_behaviour[False]` 단 1개. 이 테스트는 `LassoLarsIC(precompute=False)`(즉 `__init__` 기본 `copy_X=True`)에 대해 `fit(X, y, copy_X=False)`를 호출하고 `assert copy_X == np.array_equal(X, X_copy)`로 X가 in-place 변경(미복사)됐는지 확인한다 — 즉 **fit 인자가 인스턴스 기본을 override**함을 증명. 베이스에선 `copy_X=None`이 미존재라 `[False]` 케이스가 in-place 변경을 못 일으켜 실패.
P2P에는 `test_lasso_lars_copyX_behaviour[True/False]`(생성자 경로)와 `test_lasso_lars_fit_copyX_behaviour[True]`가 포함되어, 인스턴스 `copy_X`가 fit 무인자에서 존중되는지와 `True` override가 깨지지 않는지를 같이 묶는다.
- **overfit 관점**: FAIL_TO_PASS는 얇지만 `[True]/[False]` 양방향과 두 진입경로(생성자/fit)를 교차해 special-case 통과를 차단한다. sentinel 패턴이 `[True]` override도 동시에 만족해야 해 단순 하드코딩으로는 못 통과.
- **regression 관점**: 33개 P2P가 LARS 경로 전반(precompute/cv/ill-conditioned/positive 등)을 커버. 픽스가 `copy_X` 흐름만 건드리고 `_preprocess_data` 호출 그 외 인자는 불변이라 회귀 표면이 좁다.

## 모범답안 (오라클 기반)

1. **localize**: 이슈가 `least_angle.py`의 `LassoLarsIC` 생성자(L1487)와 `fit` 시그니처를 직접 지목 → 해당 클래스의 `fit`로 직행, `_preprocess_data`에 어떤 `copy_X`가 흘러가는지 1분 내 확인.
2. **픽스**: `fit`의 기본값을 `None`으로, 진입부에 `if copy_X is None: copy_X = self.copy_X` 분기 추가, `_preprocess_data`에 지역 `copy_X` 전달. 이게 올바른 일반화인 이유 — `fit` 인자를 제거하는 것이 더 깔끔하지만 기존 `fit(X, y, copy_X=...)` 호출을 깨므로(후방호환 위반), `None` sentinel은 "미전달=인스턴스 존중, 전달=override"라는 의도를 정확히 인코딩한다.
3. **regression 안전**: `[True]` 경로(생성자 기본 + fit `True`)와 다른 LARS 경로(precompute/cv 등) 33 P2P를 안 깨야 한다 — 변경이 `copy_X` 인자 단 하나의 출처만 바꾸고 알고리즘 흐름엔 무영향이라 안전.
4. **함정 회피**: (a) 이슈 제안대로 `fit`에서 `copy_X`를 **제거**하면 후방호환이 깨져 `[True]` 명시 호출 테스트가 실패 — sentinel을 써야 함. (b) `_preprocess_data`에 여전히 `self.copy_X`를 넘기면(인자 교체 누락) fit override가 무효화되어 FAIL_TO_PASS 미통과. (c) `if not copy_X` 같은 falsy 체크는 `False`를 sentinel과 혼동해 override를 깬다 — 반드시 `is None`으로 구분해야 한다.
