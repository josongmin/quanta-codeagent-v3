---
instance_id: pydata__xarray-3677
repo: pydata/xarray
base_commit: ef6e6a7b86f8479b9a1fecf15ad5b88a2326b31e
version: "0.12"
difficulty: "15 min - 1 hour"
created_at: 2020-01-09T16:07:14Z
fail_to_pass: 1
pass_to_pass: 21
gold_files: [xarray/core/dataset.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약

최상위 `xr.merge([ds, da])` 함수는 `Dataset`과 `DataArray`를 섞어 머지할 수 있지만, 동일한 작업을 `ds.merge(da)` 메서드로 시도하면 실패한다. 내부에서 `coerce_pandas_values`가 각 객체에 대해 `obj.items()`를 호출하는데, `DataArray`에는 `items` 속성이 없어 `AttributeError: 'DataArray' object has no attribute 'items'`가 발생한다. 즉 메서드 경로가 함수 경로와 달리 `DataArray` 입력을 `Dataset`으로 변환하지 않는 게 원인이다.

## 유형 (정형화)

- **L0 (Pinpointed)**: 이슈에 완전한 네이티브 스택트레이스가 있어 `dataset.py:merge` → `merge.py:dataset_merge_method` → `merge_core` → `coerce_pandas_values`까지 콜체인이 통째로 노출됨. 고칠 진입점(`Dataset.merge`)이 사실상 지목됨. grep 한 방.
- **S1 (Direct-Map)**: 픽스는 정형 결함클래스 — "함수 경로엔 있는 입력 정규화가 메서드 경로엔 빠짐". 입력을 `Dataset`으로 강제 변환하는 한 줄 가드를 추가하면 끝. 추론 합성(S2) 불필요, 후보 탐색(S3) 불필요.
- **K-Domain**: 일반 파이썬 지식만으론 부족. `DataArray`↔`Dataset` 변환 API(`to_dataset()`)와 `dataset_merge_method`가 dict-like(`.items()`)를 기대한다는 xarray 내부 계약을 알아야 올바른 변환점을 고른다.
- **primary = T-DirectMap**: 위치가 명확(L0)하고 픽스가 기계적 입력 강제(S1)다. APR 관점에서 이는 "missing input coercion" 템플릿 — 두 진입점(함수/메서드)의 전처리 비대칭을 메서드 쪽에 동일 변환을 삽입해 메우는 패치라 Direct-Map이 정확하다.

## 난이도 티어

**T2 (쉬움)**. 구조적 피처: 단일 파일(`xarray/core/dataset.py`) 단일 헌크 **+1줄**, has-repro(완전한 MWE+스택트레이스 → 가장 강한 easiness 신호), localize 직접성 L0. 픽스가 자명에 가까우나 변환 API(`to_dataset()`)와 `xr` import 의존이라 K-Gen 순수 T1은 아님. P2P 21개가 머지 동작 전반(arrays/datasets/dicts/no_conflicts/fill_value/auto_align)을 덮어 regression-trap이 약하게 존재 — 변환 한 줄이 기존 `Dataset` 입력 경로를 건드리면 광범위 회귀가 난다. 공식 라벨 "15분-1시간"과 일치(T2 상단). 시간라벨이 더 높지 않은 건 추론·refactor가 없어서다.

## 골드패치 분석

- **건드린 파일·함수**: `xarray/core/dataset.py`의 `Dataset.merge` 메서드.
- **근본원인**: `Dataset.merge`의 docstring은 `other : Dataset or castable to Dataset`이라 광고하지만, 실제로는 `other`를 변환 없이 `dataset_merge_method`로 넘긴다. 하류 `merge_core → coerce_pandas_values`는 각 객체에 `.items()`를 호출(dict-like/`Dataset` 가정)하므로 `DataArray`가 들어오면 `AttributeError`. 반면 최상위 `xr.merge`는 입력 리스트를 정규화하는 단계가 있어 `DataArray`를 받아준다 — 두 진입점의 전처리 비대칭이 본질.
- **수정요지**: `_check_inplace(inplace)` 직후, `dataset_merge_method` 호출 전에 한 줄 삽입:
  `other = other.to_dataset() if isinstance(other, xr.DataArray) else other`.
  `DataArray`이면 `to_dataset()`으로 dict-like한 `Dataset`으로 승격하고, 그 외 타입은 그대로 통과시켜 기존 동작을 보존.

## 검증 (test_patch)

- **FAIL_TO_PASS** (1개): `TestMergeMethod::test_merge_dataarray`. `ds = xr.Dataset({"a": 0})`, `da = xr.DataArray(data=1, name="b")`에 대해 `assert_identical(ds.merge(da), xr.merge([ds, da]))`. 메서드 경로 결과가 함수 경로 결과와 **동일**함을 요구 — 단순 무예외가 아니라 두 진입점의 시맨틱 동치를 못박는 강한 오라클.
- **픽스 증명**: 패치 전엔 `ds.merge(da)`가 `AttributeError`로 죽어 테스트 수집조차 못 통과. 패치 후 `da.to_dataset()`로 `b` 변수를 가진 `Dataset`이 되어 `dataset_merge_method`가 정상 처리 → 함수 경로와 비트동일 결과.
- **overfit 관점**: 테스트가 named `DataArray` 한 케이스뿐이라 얇아 보이나, 오라클을 "함수 경로와 identical"로 잡아 special-case 통과(예: `if name=="b"`)를 차단. 픽스 자체가 `isinstance(other, xr.DataArray)` 전역 변환이라 입력공간 일반화가 자연스러움 — overfit 위험 낮음. (단 unnamed `DataArray`는 `to_dataset()`가 에러를 내므로 그 동작은 함수 경로와 함께 별 테스트가 커버.)
- **regression 관점**: 변환이 `DataArray`에만 적용되고 `else other`로 `Dataset`·dict 입력은 무손상 통과 → P2P 21개(특히 `test_merge_fill_value*`, `test_merge_auto_align`, `test_merge_no_conflicts`)가 그대로 green.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈 스택트레이스가 `coerce_pandas_values`의 `obj.items()`에서 죽는 걸 직접 보여줌. 하지만 `coerce_pandas_values`를 고치는 건 함정 — 진짜 비대칭은 상류에 있다. 콜체인을 위로 거슬러 `Dataset.merge`(메서드)와 `xr.merge`(함수)를 비교하면, 함수만 입력 정규화를 하는 차이가 드러난다. 따라서 수정점은 `Dataset.merge` 진입.
2. **픽스와 일반화**: `dataset_merge_method` 호출 직전에 `DataArray`를 `to_dataset()`로 승격. 이는 stacktrace의 `.items()` 지점이 아니라 "입력이 잘못된 모양으로 들어온다"는 근원을 막는 것이라 올바른 일반화. 하류(`merge_core`/`coerce_pandas_values`)를 손대지 않아 다른 호출자에 부작용 없음. docstring의 "castable to Dataset" 약속을 실제로 이행하는 변경.
3. **regression 안전**: `else other` 분기로 기존 `Dataset`/dict 입력 경로는 1바이트도 안 바뀜 → fill_value·auto_align·no_conflicts·compat 등 21개 P2P 보존. 변환을 `merge_core` 내부에 넣었다면 다른 진입점까지 영향받아 회귀 위험이 컸을 것.
4. **함정 회피**: (a) 스택트레이스에 낚여 `coerce_pandas_values`에 `hasattr(obj,"items")` 가드를 넣으면 증상만 가리고 `DataArray`의 변수/좌표가 누락돼 함수 경로와 **identical 실패** → overfit. (b) `to_dataset()`는 unnamed `DataArray`엔 에러를 내므로 무조건 변환하지 말고 named 케이스(함수 경로와 동일 의미)만 위임해야 함. (c) `xr` 심볼이 모듈 상단에 import돼 있는지 확인 — 안 되면 순환 import 위험. 올바른 해법은 함수/메서드 두 경로의 전처리를 일치시키는 단일 변환 한 줄이다.
