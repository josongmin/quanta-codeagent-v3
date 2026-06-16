---
instance_id: pydata__xarray-4356
repo: pydata/xarray
base_commit: e05fddea852d08fc0845f954b79deb9e9f9ff883
version: "0.12"
difficulty: "<15 min fix"
created_at: 2020-08-19T23:48:49Z
fail_to_pass: 8
pass_to_pass: 604
gold_files: [xarray/core/nanops.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`DataArray.sum`(및 `prod`)을 `min_count`와 함께 **2개 이상의 dim**으로 호출하면 `ValueError: min_count is not available for reduction with more than one dimensions`로 막혀버린다. 이슈는 재현코드(`da.sum(["dim_0","dim_1"], min_count=1)`)와 함께 결함 위치(`xarray/core/nanops.py` L35)를 직접 지목하고, 심지어 제안 픽스(`mask.shape[axis]` → `np.take(a.shape, axis).prod()`)까지 적어준다. 이는 기능 차단을 푸는 단순한 일반화이지 새 기능 설계가 아니다.

## 유형 (정형화)
- **L (Localization) = L0**: 이슈 본문이 파일·줄번호·심볼(`mask.shape[axis]`)을 그대로 지목. grep 한 방. 탐색 비용 사실상 0.
- **S (Repair Strategy) = S2 (Constraint-Reasoning)**: 고칠 지점은 자명하나, 올바른 식을 추론으로 합성해야 한다. 다차원 reduction에서 "유효 원소 개수"는 단일 축 길이(`shape[axis]`)가 아니라 **reduce되는 모든 축 길이의 곱**(`np.take(mask.shape, axis).prod()`)이다. scalar `axis`/tuple `axis` 양쪽에서 옳게 동작하는 식임을 불변식으로 따져야 한다(`np.take`는 scalar에도 동작). 후보를 여러 개 던져 테스트로 고르는 G&V가 아니라 식 하나를 논리로 도출하는 결.
- **K (Knowledge) = K-Domain**: numpy broadcasting/`np.take` semantics + xarray의 `min_count` 의미론(pandas `_maybe_null_out` 포팅본)을 알아야 식이 맞다. 일반 파이썬 추론만으로는 prod 일반화가 자명하지 않다.
- **primary_type = T-ConstraintReason**: 위치는 명확(L0)하나 핵심 난점이 "올바른 카운트 식 합성"(S2)에 있으므로 ConstraintReason. DirectMap(S1 기계적 가드/상수)이 아닌 이유는, 단순히 막던 `raise`를 지우는 것만으론 부족하고 카운트 식 자체를 다차원으로 일반화해야 정답이 되기 때문이다.

## 난이도 티어
**Tier = T3 (중간)**. 공식 라벨은 `<15 min fix`(prior로 T1~T2 시사)이지만 T3로 올린다.
- 파일수 1, 변경 줄수 ~6줄(헌크 1개) → 매우 작음 (T1~T2 쪽).
- localize 직접성 L0 + `has-repro` → 가장 강한 easiness 신호.
- 그러나 **실질 추론이 식 합성에 집중**(S2)되어 있고, scalar/tuple axis 양면을 동시에 만족시키는 일반식을 도출해야 한다 — 단순 가드 제거(naive)면 scalar 경로 회귀를 깰 수 있는 함정. 이 "올바른 일반화 vs special-case" 긴장이 T2를 넘긴다.
- **P2P trap이 광범위(604개)** → `regression-trap`. 같은 `_maybe_null_out` 경로를 타는 1-dim `sum`/`prod`/min_count 기존 케이스를 단 하나도 깨면 안 됨. patch scope는 작지만 인접 동작 보호 부담이 T3 수준.
- 결론: 구조 자체는 쉬우나(작은 patch) 식 합성 + 넓은 P2P가 시간라벨보다 약간 위 → T3.

## 골드패치 분석
- **파일/함수**: `xarray/core/nanops.py` 의 `_maybe_null_out(result, axis, mask, min_count=1)` (pandas `pandas.core.nanops._maybe_null_out`의 xarray 포팅본).
- **근본원인**: 두 가지가 결합. (1) 함수 진입부에 `if hasattr(axis, "__len__"): raise ValueError(...)` 가드가 다차원(tuple/list) axis를 **인위적으로 차단**. (2) 그 가드를 지워도 카운트 식 `null_mask = (mask.shape[axis] - mask.sum(axis) - min_count) < 0` 이 `mask.shape[axis]` 에서 깨진다 — `axis`가 tuple이면 `shape[tuple]`은 의미가 없고, reduce되는 전체 원소 수는 단일 축 길이가 아니라 축 길이들의 **곱**이어야 한다.
- **수정요지**:
  1. `hasattr(axis, "__len__")` 차단 가드(`raise ValueError`)를 **삭제** → 다차원 reduction 허용.
  2. `mask.shape[axis]` → `np.take(mask.shape, axis).prod()` 로 교체. `np.take`는 axis가 scalar든 tuple/list든 해당 축 길이들을 뽑고 `.prod()`로 전체 카운트를 계산. scalar일 때 `np.take(shape, k).prod()` == `shape[k]` 이므로 1-dim 동작 보존.

## 검증 (test_patch)
- **FAIL_TO_PASS (8)**: 신규 `test_min_count_nd[func-dask-dtype]` 의 dask=False 8조합 (`sum`/`prod` × `float/int/float32/bool_`). 3차원 array를 `dim=["x","y","z"]`, `min_count=3`으로 전 dim reduce한 결과가 `dim=...`(=전체)로 reduce한 결과와 `assert_allclose`로 동일함을 요구. 픽스 전엔 가드의 `ValueError`로 즉시 실패, 픽스 후엔 prod 카운트가 올바른 null 마스킹을 산출해 통과. (dask=True 8조합은 F2P에 미포함 — 환경상 dask 의존, 그래도 `assert_dask_array`로 lazy성 검증.)
- **픽스 증명**: "전 dim 지정 == `...`(None) reduce" 라는 등가성을 oracle로 못박아, 단순히 `raise`만 지운 special-case 구현은 카운트 식이 틀려 값이 어긋나 fail → 식 일반화가 강제됨. `test_multiple_dims`도 `skipna` 파라미터를 추가해 skipna 양면을 넓힘.
- **overfit 관점**: dtype 4종 + sum/prod 2종 매트릭스라 special-case 통과가 어렵다. 다만 `min_count` 값이 3 하나라 경계(`< 0` 부등호) 미세조정 overfit 여지는 약간 있으나, `assert_allclose` 등가성이 이를 거의 막음. → overfit 위험 낮음(`overfit-risk` 미표기).
- **regression 관점**: P2P 604개에 기존 1-dim `test_min_count`, `test_min_count_dataset` 등이 포함. `np.take(shape, scalar).prod() == shape[scalar]` 항등이 1-dim 경로를 byte 수준으로 보존하므로 회귀 안전.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 `nanops.py` L35와 심볼 `mask.shape[axis]`을 직접 준다 → `_maybe_null_out` 한 함수로 즉시 수렴. 에러 메시지 `"min_count is not available for reduction with more than one dimensions"` 를 grep해 `raise` 가드까지 같이 찾는다.
2. **픽스와 일반화 근거**: 차단 가드를 제거하고 카운트 식을 `np.take(mask.shape, axis).prod()` 로 교체. 이게 올바른 일반화인 이유 — reduce 후 각 출력 셀이 집계한 원소 수는 reduce되는 모든 축 길이의 **곱**이며, `np.take`는 scalar/tuple 양쪽을 통일된 식으로 처리하고 scalar에선 기존과 항등. min_count의 의미(유효 원소가 min_count 미만이면 NaN/fill)를 다차원에 정확히 보존한다.
3. **regression 안전**: 1-dim `sum`/`prod`/`min_count` 경로(P2P 604, `test_min_count`·`test_min_count_dataset`)를 깨면 안 된다. scalar axis에서 `np.take(shape,k).prod()==shape[k]` 항등이 이를 보장하므로 추가 분기 없이 안전.
4. **함정 회피**: 가장 흔한 오답은 **`raise`만 삭제하고 카운트 식을 그대로 두는 것** — tuple axis에서 `mask.shape[axis]`가 깨지거나 잘못된 카운트를 산출해 F2P 등가성 fail. 또 다른 함정은 `mask.shape[axis]`를 Python `sum`/임의 인덱싱으로 곱이 아닌 합으로 잘못 합성하는 것(곱이어야 함). `np.take(...).prod()` 라는 곱 일반화를 정확히 도출해야 하며, scalar 경로 항등 보존을 함께 확인해야 한다.
