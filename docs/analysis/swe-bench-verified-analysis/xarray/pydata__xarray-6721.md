---
instance_id: pydata__xarray-6721
repo: pydata/xarray
base_commit: cc183652bf6e1273e985e1c4b3cba79c896c1193
version: "2022.06"
difficulty: "15 min - 1 hour"
created_at: 2022-06-24T18:45:45Z
fail_to_pass: 1
pass_to_pass: 1405
gold_files: [xarray/core/common.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
zarr 백엔드 등 lazy-loading 데이터셋에서 `ds.chunks`(또는 `ds.chunksizes`) 속성에 접근하면 청크 정보만 보면 될 것을 전체 배열이 메모리로 로드되는 버그다. 이슈에 네이티브 스택트레이스가 포함되어 있어 `get_chunksizes`가 `hasattr(v.data, "chunks")`를 호출하고, 이 `v.data` 접근이 `Variable.values` → `np.asarray`를 거쳐 lazy backend array를 실제 materialize시키는 경로가 그대로 드러난다. 기대 동작은 청크 메타데이터만 inspect하고 데이터는 로드하지 않는 것이다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 스택트레이스로 `xarray/core/common.py`의 `get_chunksizes` 안 `hasattr(v.data, "chunks")` 라인을 정확히 지목. grep 한 방으로 도달. 점수 L0.
- **S2 (Constraint-Reasoning)**: 고칠 라인은 자명하나, 올바른 픽스는 "왜 `.data`가 로드를 유발하는가"라는 불변식 추론을 요구한다. `Variable.data`는 `_data`에 `.chunks`가 없으면 `.values`로 fallback해 numpy materialize를 강제하는 property이고, `_data`는 raw lazy array를 그대로 노출한다. 따라서 `v._data`로 검사해야 로드 없이 chunk 보유 여부를 판정할 수 있다 — 단순 가드 추가(S1)가 아니라 두 접근자의 의미 차이를 따져야 하는 의미적 수리.
- **K-Domain**: xarray 내부 lazy-array/duck-array 모델(`_data` vs `data` property, `MemoryCachedArray.__array__`, dask `.chunks`)을 알아야 픽스가 옳음을 확신할 수 있다.
- primary **T-ConstraintReason**: 위치는 명확(L0)하지만 dominant 난점은 "`.data`→`._data` 한 글자 차이가 왜 올바른지"를 lazy-loading 계약으로 추론 합성하는 데 있다. APR 관점에서 SemFix류의 조건/식 합성에 해당하며, 무작위 generate-&-validate가 아니라 단일 정답을 의미로 도출하는 케이스다.

## 난이도 티어
**T3 (중간)**. 구조적 피처:
- 파일 1개(`xarray/core/common.py`), 정확히 1줄 수정 — scope는 최소(T1~T2 신호).
- has-repro: 네이티브 스택트레이스 있음 → easiness 강신호.
- 그러나 픽스를 "기계적 가드"로 보면 틀린다. `v.data` 자체를 검사 대상으로 유지한 채 다른 방어를 넣으면 여전히 로드가 발생 — 정답은 `._data`라는 도메인 내부 접근자로의 교체뿐이라, 약한 constraint 추론과 K-Domain이 결합한다.
- regression-trap: P2P가 106984개(test_dataset 전반)로 매우 넓어, `_data`로 바꾼 검사가 일반 dask/numpy/sparse 변수의 chunk 판정을 깨면 안 된다.

공식 라벨 "15 min - 1 hour"와 정합. 1줄짜리지만 lazy 계약 추론 때문에 T1/T2로 내리지 않고 T3로 둔다(localize는 쉬우나 픽스 정당화에 도메인 추론 필요).

## 골드패치 분석
- **파일·함수**: `xarray/core/common.py`의 `get_chunksizes(variables)`.
- **근본원인**: 청크 존재 여부를 검사할 때 `hasattr(v.data, "chunks")`로 `Variable.data` property를 호출. lazy backend(zarr/`MemoryCachedArray`)에서 `_data`에는 `.chunks`가 없으므로 `data` property가 `Variable.values` → `_as_array_or_item` → `np.asarray` → `MemoryCachedArray.__array__._ensure_cached()`로 떨어져 **전체 배열을 메모리로 로드**한다.
- **수정요지**: `v.data` → `v._data`. raw underlying array를 직접 검사해 materialize fallback을 우회. dask 변수는 `_data`에 이미 `.chunks`가 있어 동작 동일, lazy 변수는 로드 없이 `chunks`가 없다고 판정.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `TestDataset::test_chunks_does_not_load_data`. `InaccessibleVariableDataStore`에 `create_test_data()`를 덤프 후 `open_dataset(store)`로 열고 `ds.chunks == {}`를 단언. 이 store는 데이터 접근 시 예외를 던지도록 설계되어, `.data`를 통한 로드가 일어나면 `ds.chunks` 평가 중 예외로 즉시 실패한다.
- **픽스 증명**: 패치 후 `get_chunksizes`가 `v._data`만 검사하므로 inaccessible store의 실제 데이터를 건드리지 않고 chunk 없음(`{}`)을 반환 → 단언 통과. 픽스 전엔 `.data` 접근이 store를 깨워 예외 발생.
- **overfit/regression 관점**: 테스트가 "로드하면 터지는" store로 부작용을 직접 관찰하므로 special-case 통과가 어렵다(overfit 저위험). 다만 F2P는 1개라 chunk *값* 정확성은 광범위 P2P(dask chunk repr/`test_chunk` 계열)가 커버 — `_data`로의 교체가 정상 dask 경로를 깨지 않음을 P2P가 보증한다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈 스택트레이스의 `common.py:get_chunksizes` → `Variable.data` → `Variable.values` → `MemoryCachedArray.__array__._ensure_cached` 체인을 따라간다. 로드를 유발하는 분기는 `get_chunksizes`의 `hasattr(v.data, "chunks")` 단 한 줄임이 명백 — L0 직행.
2. **픽스와 일반화**: `Variable.data` property가 lazy 변수에서 `.values`로 fallback해 materialize한다는 점을 확인하고, `_data`가 raw lazy array를 그대로 노출함을 안다. `hasattr(v._data, "chunks")`로 교체하면 (a) dask 변수는 `_data`에 `.chunks`가 있어 동일하게 인식, (b) lazy/numpy 변수는 로드 없이 chunk 없음으로 판정 — 모든 array 타입에 걸친 올바른 일반화이지 테스트 특화가 아니다.
3. **regression 안전**: 광범위 P2P(`test_repr`/`test_constructor`/`test_chunk` 등 dask·numpy·sparse repr/chunk 동작)를 안 깨야 한다. `_data`는 dask에서도 `.chunks`를 보유하므로 정상 청크 보고가 유지됨을 근거로 안전.
4. **함정 회피**: 오라클 없는 에이전트는 (a) `v.data`를 그대로 둔 채 `try/except`나 `getattr` 가드를 추가 — 여전히 로드 발생(헛수정), (b) `Variable.data`/`values` property 자체를 손대 광범위 회귀 유발, (c) `chunksizes` property까지 중복 수정. 정답은 검사 *대상 접근자*를 `_data`로 바꾸는 것임을 lazy 계약으로 좁혀야 한다.
