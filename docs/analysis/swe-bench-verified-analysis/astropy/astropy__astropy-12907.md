---
instance_id: astropy__astropy-12907
repo: astropy/astropy
base_commit: d16bfe05a744909de4b27f5875fe0d4ed41ce607
version: "4.3"
difficulty: "15 min - 1 hour"
created_at: "2022-03-03T15:14:54Z"
fail_to_pass: 2
pass_to_pass: 13
gold_files: [astropy/modeling/separable.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`astropy.modeling.separable.separability_matrix`가 **중첩(nested) CompoundModel**에 대해 분리성(separability)을 잘못 계산한다. `Pix2Sky_TAN() & Linear1D(10) & Linear1D(5)`는 우하단 2x2가 대각(독립)으로 나오지만, `cm = Linear1D(10) & Linear1D(5)`를 먼저 만들어 `Pix2Sky_TAN() & cm`로 중첩하면 같은 두 Linear1D가 갑자기 서로 종속(off-diagonal True)으로 표시된다. 즉 `&` 결합의 결합법칙이 깨져 있다.

## 유형 (정형화)
- **L (Localization) = L1**: 이슈가 `separability_matrix`를 직접 지목하고 has-repro가 있어 `separable.py`로 즉시 수렴하나, 실제 결함은 그 안의 헬퍼 `_cstack`(`&` 연산 대응)의 한 줄이라 한 단계 탐색이 필요. grep 한 방은 아님 → L1.
- **S (Repair Strategy) = S2 (Constraint-Reasoning)**: 후보를 마구 던지는 G&V가 아니라, "right가 이미 계산된 coord matrix일 때 그 구조를 보존해야 한다"는 불변식을 추론해 올바른 대입식을 합성하는 문제. 바로 위 `cleft` 분기(`cleft[...] = left`)가 정답 형태를 이미 보여준다.
- **K (Knowledge) = K-Domain**: `_coord_matrix`/`_cstack`/`_cdot`가 모델을 0/1 좌표행렬로 인코딩하는 modeling 도메인 규약, 그리고 nested CompoundModel이 재귀적으로 ndarray(서브행렬)로 들어온다는 내부 지식이 병목.
- **primary_type = T-ConstraintReason**: 위치는 좁게 좁혀지나, 픽스는 "상수 1 대신 실제 부분행렬을 보존"이라는 의미적 불변식 추론에서 나온다. 기계적 None-가드/상수변경(T-DirectMap)이 아니라, 왜 1이 틀렸는지를 이해해야 right로 바꿀 수 있어 S2가 dominant.

## 난이도 티어
**T3 (중간)**. 구조적 피처: 1파일·1함수·**1줄** 변경(`gold_files` 1개), has-repro 존재로 재현·검증이 쉬움 — 이것만 보면 T2 쪽. 그러나 (1) 결함이 표면 API가 아닌 내부 헬퍼 `_cstack`의 else 분기라 약한 localize 노력이 필요하고, (2) 픽스가 자명한 가드가 아니라 "좌표행렬 보존" 불변식 추론(S2)을 요구하며, (3) 인접 분기(`cleft`, `_cdot`, `_coord_matrix`)와 13개 PASS_TO_PASS를 안 깨야 하는 regression-trap이 있어 T2가 아닌 T3로 민다. 공식 라벨 "15분-1시간"과 정합적이다 (T3 = 단일파일 + 실질 추론).

## 골드패치 분석
- **파일/함수**: `astropy/modeling/separable.py` → `_cstack(left, right)` (`&` 연산 핸들러).
- **근본원인**: `right`가 `Model`이 아니라 ndarray(= 이미 계산된 하위 CompoundModel의 좌표행렬)인 else 분기에서, 우측 블록을 `cright[-right.shape[0]:, -right.shape[1]:] = 1`로 채웠다. `= 1`은 해당 블록 전체를 all-ones로 broadcast해 right의 내부 분리 구조(어떤 출력이 어떤 입력에 종속인지)를 **뭉개버린다**. 그래서 중첩 시 독립이어야 할 두 Linear1D가 종속으로 보였다.
- **수정요지**: `cright[-right.shape[0]:, -right.shape[1]:] = right` — 상수 1 대신 right 부분행렬 자체를 대입해 구조를 보존. 바로 위 `cleft[: left.shape[0], : left.shape[1]] = left`와 대칭이 되어 좌/우 분기 일관성이 회복된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개)**: `test_separable[compound_model6-result6]`, `test_separable[compound_model9-result9]`. test_patch는 `compound_models` 딕셔너리에 `cm8`(`rot & (sh1 & sh2)`), `cm9`(`rot & sh1 & sh2`), `cm10`(`(rot & sh1) & sh2`) — 세 가지 결합 그룹핑이 모두 동일한 `cm_4d_expected` 대각 블록을 내야 함을 단언하고, `cm11`(5출력)로 더 깊은 중첩까지 검사한다.
- **픽스 증명**: `= right`로 바꾸면 nested 그룹의 부분행렬이 보존되어 `cm8/cm9/cm10`이 결합법칙대로 동일 행렬을 산출 → 결합 순서 불변성 확인. all-ones 뭉갬이 사라져 off-diagonal False가 정상 복원.
- **overfit/regression**: overfit 위험 낮음 — 테스트가 **결합 그룹핑 3종 + 비대칭 5출력 케이스**를 함께 넣어 special-case 통과를 차단(특정 1을 어떤 행렬로 바꿔도 cm8~cm11을 동시에 못 속임). regression: 기존 12개 `test_separable`와 `test_cstack`/`test_cdot`/`test_coord_matrix`가 PASS_TO_PASS로 남아, right가 Model인 분기와 단일레벨 케이스(right가 그냥 0/1 단위 구조)는 영향 없음 — `= 1`이었던 단위 케이스에서는 right 자체가 그 자리에서 1이라 동치.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 has-repro로 `separability_matrix(m.Pix2Sky_TAN() & cm)` 재현 → `&`가 핵심이므로 `separable.py`에서 `&` 처리부 `_cstack` 진입. left/right 두 분기 중, 중첩 시 right가 ndarray(하위 행렬)로 들어오는 else 분기를 의심. `cright[...] = 1`이 left의 `cleft[...] = left`와 비대칭임을 발견하면 결정타.
2. **픽스와 일반화 근거**: `1` → `right`. 좌표행렬 인코딩에서 블록은 "그 자리에 우측 모델의 분리 구조를 그대로 박는" 것이 의미. 단일 모델일 땐 그 구조가 우연히 단위(1)였을 뿐이고, 중첩이면 비자명한 부분행렬이다. 따라서 right를 보존하는 게 모든 깊이/그룹핑에 대한 올바른 일반화이지, 테스트만 맞춘 특수화가 아니다(cleft 대칭이 이를 보증).
3. **regression 안전**: `_coord_matrix`(right가 Model인 경로), `_cdot`(`|` 연산), 단일레벨 `test_separable` 12종을 안 깨야 한다. 픽스는 else 분기(ndarray) 한정이고 단위 케이스에서 right==1이라 byte-동치 → 13 PASS_TO_PASS 안전.
4. **함정 회피**: 오라클 없는 에이전트의 오답 경로는 (a) `separability_matrix`/`_separable` 상위에서 후처리로 off-diagonal을 강제 0 마스킹(special-case overfit, cm11 비대칭에서 깨짐), (b) `cleft` 쪽까지 건드려 left 분기 회귀 유발, (c) `1`을 `np.eye`나 다른 상수로 바꿔 단위 케이스만 통과시키기. 회피법: left/right 대칭성과 "구조 보존" 불변식에 근거해 **else 분기의 right 대입 한 줄**로 국소화하고, cm8/cm9/cm10 결합법칙 동치를 판정 기준으로 삼는다.
