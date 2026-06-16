---
instance_id: scikit-learn__scikit-learn-25232
repo: scikit-learn/scikit-learn
base_commit: f7eea978097085a6781a0e92fc14ba7712a52d75
version: "1.3"
difficulty: "<15 min fix"
created_at: 2022-12-24T15:32:44Z
fail_to_pass: 1
pass_to_pass: 214
gold_files: [sklearn/impute/_iterative.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-API
flags: [regression-trap]
---

## 문제 요약

`IterativeImputer`는 첫 라운드 초기값을 `initial_strategy`로 채우는데, `SimpleImputer`와 달리 `fill_value` 파라미터가 없다. 그래서 `initial_strategy="constant"`로 두어도 사용자가 채울 상수를 직접 지정할 수 없다(항상 SimpleImputer 기본값인 0 / "missing_value"로만 채워짐). 이슈는 `SimpleImputer`와 동일하게 `fill_value` 파라미터를 추가해 내부 `SimpleImputer`로 전달해 줄 것을 요구한다.

## 유형 (정형화)

- **L (Localization) = L0**: 이슈가 클래스(`IterativeImputer`)와 누락된 심볼명(`fill_value`)을 그대로 지목한다. 비교 대상 `SimpleImputer.fill_value`까지 명시돼 있어 grep 한 방으로 `_iterative.py`에 수렴한다.
- **S (Repair Strategy) = S1 (Direct-Map)**: 이슈가 사실상 픽스를 명세한다. "기존 파라미터를 따라 새 파라미터를 추가하고 내부 SimpleImputer에 전달하라"는 정형적 *passthrough-parameter 추가* 템플릿. 추론으로 식을 합성할 게 없다 → S2 아님.
- **K (Knowledge) = K-API**: `SimpleImputer`의 `fill_value` 계약(생성자 시그니처, 검증 규약, `"no_validation"` 옵션 표기, `.. versionadded::` 버저닝, 생성자 인자 순서)을 정확히 맞춰야 한다. 일반 파이썬 추론(K-Gen)이 아니라 sklearn 추정기 API 관례 지식이 병목.
- **Primary = T-DirectMap**: 위치가 명확(L0)하고 픽스가 기계적인 파라미터 위임(S1). "찾으면 끝"인 T-LocTrivial보다는, 4개 사이트에 일관되게 배선하고 검증 스킵(`"no_validation"`)·docstring 버저닝까지 sklearn 규약대로 맞춰야 하므로 DirectMap이 정확.

APR 관점: SemFix식 조건 합성(S2)이나 G&V 반복(S3) 불필요. 결함 클래스가 "누락된 위임 파라미터"라 PAR/TBar식 fix-template으로 바로 매칭된다.

## 난이도 티어

**Tier = T2 (쉬움)**. 구조적 피처:
- 파일수 1, 함수 경계로는 docstring / `_parameter_constraints` / `__init__` 시그니처 / `__init__` 바디 / `_initial_imputation` 5개 헌크지만 모두 동일 파라미터의 기계적 배선(논리 분기 0).
- localize 직접성 최상(L0).
- repro 코드 없음(`has-repro` 미부여) — 이슈는 기능요청 형태. 다만 픽스 자명도가 이를 상쇄.
- 도메인 추론 거의 없음; 위험은 오직 sklearn 추정기 계약 준수.
- `regression-trap`: PASS_TO_PASS 214개로 impute 모듈 전체가 회귀 감시 범위. 새 생성자 인자 위치를 잘못 끼우면 `test_imputation_shape` 등 기존 테스트가 깨질 수 있다.

공식 라벨 `<15 min fix`와 일치(T1~T2 prior). T1로 더 내리지 않은 이유: 단순 "한 줄"이 아니라 검증 스킵 마커·버전 docstring·내부 위임까지 sklearn 관례를 맞춰야 하는 K-API 비용 + 214 P2P trap이 살짝 위로 민다.

## 골드패치 분석

- **건드린 파일**: `sklearn/impute/_iterative.py` 단일.
- **건드린 지점(4종 배선)**:
  1. `IterativeImputer` 클래스 docstring — `fill_value` 파라미터 문서 + `.. versionadded:: 1.3`.
  2. `_parameter_constraints["fill_value"] = "no_validation"` — 임의 객체 허용(검증 스킵). `np.nan` 등도 허용하라는 이슈 요구를 충족.
  3. `__init__` 시그니처에 `fill_value=None` 추가(`initial_strategy` 바로 뒤, `imputation_order` 앞) + `self.fill_value = fill_value` 저장.
  4. `_initial_imputation`에서 내부 `SimpleImputer(...)` 생성 시 `fill_value=self.fill_value` 전달.
- **근본원인**: `IterativeImputer`가 초기 대치를 내부 `SimpleImputer`에 위임하면서 `strategy`(=`initial_strategy`)만 넘기고 `fill_value`는 넘기지 않아, `initial_strategy="constant"`일 때 사용자 상수가 도달하지 못함.
- **수정요지**: 누락된 위임 파라미터를 끝단(`_initial_imputation`의 `SimpleImputer` 생성)까지 관통시켜 `fill_value`가 초기 대치값으로 실제 사용되게 한다.

## 검증 (test_patch)

- **FAIL_TO_PASS (1개)** `test_iterative_imputer_constant_fill_value`: `missing_values=-1, initial_strategy="constant", fill_value=100, max_iter=0`으로 `fit_transform` 후 `imputer.initial_imputer_.statistics_ == 100`을 단언. `max_iter=0`은 반복 회귀를 건너뛰고 *초기 대치 단계만* 격리 관찰하는 영리한 설계 — `fill_value`가 내부 `SimpleImputer`까지 전파됐는지를 `statistics_`로 직접 검사한다.
- **픽스 증명**: 패치 전에는 `__init__`에 `fill_value`가 없어 `TypeError`(미지원 인자), 설령 받아도 `_initial_imputation`이 전달 안 해 `statistics_`가 기본값 0이라 단언 실패. 4종 배선이 모두 있어야만 `statistics_ == 100`이 성립.
- **overfit 관점**: F2P 1개로 얇지만, 검사 대상이 "내부 imputer의 실제 통계량"이라 special-case 우회가 어렵다. `fill_value`를 무시하고 100을 하드코딩하는 식의 cheat는 다른 값으로 일반화 불가하나 — 본 패치는 직접 위임이라 일반화 안전. `overfit-risk` 미부여.
- **regression 관점**: 214 P2P가 mean/median/most_frequent/constant 전 경로 + SimpleImputer/MissingIndicator/keep_empty_features를 커버. `fill_value=None` 기본값이 기존 `SimpleImputer` 기본 동작과 동일하므로 무회귀. 생성자 인자를 `initial_strategy`와 `imputation_order` *사이*에 끼운 것도 위치 기반 호출 안전성을 위해 의미가 있다(SimpleImputer 시그니처 순서 미러링).

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈가 `IterativeImputer` + `fill_value`(SimpleImputer 대비)를 직접 지목 → `sklearn/impute/_iterative.py`. 클래스 안에서 초기 대치 위임 지점 `_initial_imputation`의 `SimpleImputer(missing_values=..., strategy=self.initial_strategy, keep_empty_features=...)` 호출이 `fill_value` 누락의 진원지임을 즉시 식별.
2. **픽스와 일반화 근거**: `SimpleImputer`가 이미 `fill_value`를 지원하므로 새 로직을 짜는 게 아니라 *위임 파라미터 추가*가 정답. (a) 시그니처+저장, (b) `_initial_imputation` 전달, (c) `_parameter_constraints`에 `"no_validation"`(이슈가 요구한 `np.nan` 허용 충족), (d) docstring+`versionadded`. 직접 위임이라 모든 `fill_value` 값에 일반화 — overfit 아님.
3. **regression 안전**: 기본값 `fill_value=None`이 기존 SimpleImputer 기본과 동치라 mean/median/most_frequent 경로 불변. 214 P2P(특히 `test_imputation_shape`, `test_iterative_imputer_keep_empty_features[*]`)를 안 깨려면 생성자 인자를 *추가*하되 기존 인자 시맨틱은 건드리지 말 것.
4. **함정 회피**: (i) `_parameter_constraints`에 `fill_value`를 빠뜨리면 sklearn의 `_validate_params`가 "unexpected parameter"로 막는다 — 반드시 `"no_validation"` 등록 필요(에이전트가 흔히 누락). (ii) 임의 값/`np.nan` 허용을 위해 `StrOptions` 같은 좁은 제약 대신 `"no_validation"`을 써야 함. (iii) `_initial_imputation` 전달을 빼고 시그니처에만 추가하면(가장 흔한 절반 픽스) F2P가 `statistics_` 불일치로 그대로 실패한다 — 끝단 위임이 진짜 chokepoint. (iv) `versionadded` 버전(1.3)·docstring을 sklearn 관례대로 채워야 API 일관성 유지.
