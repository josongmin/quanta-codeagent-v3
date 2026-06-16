---
instance_id: pydata__xarray-3151
repo: pydata/xarray
base_commit: 118f4d996e7711c9aced916e6049af9f28d5ec66
version: "0.12"
difficulty: "15 min - 1 hour"
created_at: 2019-07-20T12:31:14Z
fail_to_pass: 1
pass_to_pass: 66
gold_files: [xarray/core/combine.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`xr.combine_by_coords`는 데이터셋 간에 변하지 않는(identical) 좌표 차원이라도 그 좌표가 단조(monotonic)하지 않으면 `ValueError: Resulting object does not have monotonic global indexes along dimension y`를 던진다. 그러나 docstring은 "데이터셋 간에 변하지 않는 좌표 차원은 무시된다"고 명시한다. 즉 concat 대상이 아닌 bystander 차원(예: `y=['a','c','b']`)까지 단조성 검사를 강제하는 것이 스펙 위반이다. MCVE가 ValueError를 직접 재현한다.

## 유형 (정형화)
- **L (Localization) = L1**: 이슈가 `combine_by_coords`와 정확한 에러 메시지("monotonic global indexes")를 준다. 메시지로 grep하면 `xarray/core/combine.py`의 단일 검사 루프로 바로 수렴한다. 파일/심볼 직접지목은 아니나 키워드 추적이 거의 일직선.
- **S (Repair Strategy) = S2 (+S5)**: 고칠 지점은 분명하지만 "어떤 차원에 단조성을 요구해야 하는가"라는 불변식을 재추론해야 한다. 검사 대상을 `concatenated.dims` 전체 → 실제 concat된 `concat_dims`로 좁히는 것이 핵심이고, 이는 docstring 계약(변하지 않는 차원은 무시)에서 스펙을 재구성(S5)해 도출한다. 후보를 마구 시도하는 G&V가 아니라 의미 추론으로 푸는 문제.
- **K (Knowledge) = K-Domain**: xarray 내부 모델 지식 필요 — `concat_dims`가 `_infer_concat_order_from_coords`의 반환값이고 그것이 "실제로 합쳐진 축"을 뜻한다는 것, bystander 차원과 concat 차원의 구분을 알아야 올바른 루프 대상을 고른다.
- **primary_type = T-ConstraintReason**: 위치는 명확(L1)하나 픽스 자체가 "검사해야 할 올바른 차원 집합"이라는 조건을 추론 합성하는 데 있음. 가드 추가/상수 변경식 기계적 S1이 아니다.

## 난이도 티어
**T3 (중간)**. 구조적 피처:
- 파일 수 1, 헌크 1, 순 변경 ~5줄 — scope는 매우 작다(T1/T2 신호).
- has-repro: MCVE가 ValueError를 정확히 재현 — easiness 신호.
- 그러나 단순 가드/기본값 픽스가 아니라 "검사 대상 차원 집합"을 `dims`에서 `concat_dims`로 바꾸는 의미 추론이 필요(S2). 잘못 좁히면(예: 검사 자체 삭제) 의도된 단조성 보장을 깨뜨릴 수 있어 정밀도가 요구된다.
- regression-trap: PASS_TO_PASS 68개 중 `test_combine_by_coords`, `test_combine_by_coords_still_fails`, `test_check_for_impossible_ordering` 등 단조성/순서검사 동작이 다수 있어, 검사를 너무 넓게 무력화하면 인접 동작이 깨진다.
공식 라벨 "15분-1시간"과 부합하나, scope가 작음에도 의미추론·regression 민감도 때문에 T2가 아닌 T3로 둔다.

## 골드패치 분석
- **파일·함수**: `xarray/core/combine.py`의 `combine_by_coords` 내부, `_combine_nd` 호출 직후의 "overall coordinates monotonically increasing" 검사 루프.
- **근본원인**: 검사 루프가 `for dim in concatenated.dims: if dim in concatenated:`로 결과 객체의 **모든** 차원 좌표를 순회하며 단조성을 강제했다. 여기에는 concat에 전혀 관여하지 않은 bystander 차원(데이터셋 간 동일한 `y`)까지 포함되어, 비단조 bystander 좌표가 ValueError를 유발했다.
- **수정요지**: 순회 대상을 `_infer_concat_order_from_coords`가 반환한 `concat_dims`로 교체(`for dim in concat_dims:`). 실제로 합쳐진 축에 대해서만 전역 단조성을 요구하도록 한다. concat_dims에 든 차원은 항상 결과에 존재하므로 `if dim in concatenated` 가드도 불필요해져 제거된다.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `TestCombineAuto::test_combine_leaving_bystander_dimensions` 1개. 비단조 bystander 좌표 `y=['a','c','b']`를 가진 ds1/ds2를 `combine_by_coords`로 합치고, ValueError 없이 `assert_identical(expected, actual)`로 결과가 정확히 보존됨을 확인한다.
- **픽스 증명**: base에서는 `y`가 `concatenated.dims`에 포함되어 비단조라 ValueError. 패치 후 `y`는 concat 축이 아니라 `concat_dims`(=`x`)에 없으므로 검사를 건너뛰고, `x`는 단조이므로 통과 → 결합 성공.
- **overfit 관점**: 검사를 `concat_dims`로 좁힌 것은 special-case 회피가 아니라 docstring 계약과 정합하는 일반화라 overfit 위험 낮음. 단, FAIL_TO_PASS가 1개뿐이라 "concat 축의 비단조 결과"를 명시 검증하는 부담은 기존 PASS_TO_PASS(`test_combine_by_coords_still_fails`)가 진다.
- **regression 관점**: concat 축의 비단조 결과는 여전히 ValueError를 던져야 한다(`still_fails`, `test_check_for_impossible_ordering`). 패치는 검사를 삭제하지 않고 대상만 좁히므로 이들이 유지된다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 에러 문자열 "Resulting object does not have monotonic global indexes along dimension"을 grep → `xarray/core/combine.py`의 `combine_by_coords` 검사 루프 단일 지점. has-repro로 즉시 재현.
2. **픽스와 일반화 근거**: 루프 대상을 `concatenated.dims`(모든 차원) → `concat_dims`(실제 합쳐진 차원)로 교체. docstring이 "데이터셋 간에 변하지 않는 좌표 차원은 무시된다"고 약속하므로, bystander 차원은 단조성 검사 범위 밖이 맞다. `concat_dims`는 같은 함수 안에서 `_infer_concat_order_from_coords`가 이미 반환해 둔 값이라 추가 계산 없이 정확히 "합쳐진 축"을 지칭 — 이게 임의 휴리스틱이 아닌 올바른 일반화.
3. **regression 안전**: concat 축이 정렬 후에도 비단조이면 여전히 raise해야 한다(`test_combine_by_coords_still_fails`, `test_check_for_impossible_ordering`). 검사 로직을 보존하고 순회 집합만 좁히므로 안전. `concat_dims`의 차원은 항상 결과에 존재해 `if dim in concatenated` 가드 제거도 동작을 바꾸지 않는다.
4. **함정 회피**: (a) 검사 루프를 통째로 삭제하면 FAIL_TO_PASS는 통과하나 `still_fails`/`impossible_ordering`이 깨진다 — 대상만 좁혀야 한다. (b) "bystander 여부"를 좌표가 동일한지 비교로 직접 판정하려 들면 과도하게 복잡해지고 엣지에서 틀린다; 이미 존재하는 `concat_dims`를 신뢰하는 게 정답. (c) `concatenated.indexes.get(dim)`이 None을 줄 수 있는 비인덱스 차원을 걱정할 필요 없음 — concat_dims는 인덱스 추론에서 나온 축이라 가드가 불필요해진다.
