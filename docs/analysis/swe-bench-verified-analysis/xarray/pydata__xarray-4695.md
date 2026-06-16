---
instance_id: pydata__xarray-4695
repo: pydata/xarray
base_commit: 51ef2a66c4e0896eab7d2b03e3dfb3963e338e3c
version: "0.12"
difficulty: "15 min - 1 hour"
created_at: 2020-12-15T00:30:04Z
fail_to_pass: 1
pass_to_pass: 875
gold_files: [xarray/core/dataarray.py]
primary_type: T-ConstraintReason
tier: T2
loc_axis: L1
repair_strategy: S2
knowledge: K-API
flags: [has-repro, regression-trap]
---

## 문제 요약
DataArray의 차원 이름이 `method`(또는 `tolerance`, `drop` 등 `sel`의 키워드 파라미터명)와 충돌하면 `.loc[dict(...)]` 인덱싱이 깨진다. 예: `D2.loc[dict(dim1='x', method='a')]`가 `ValueError: Invalid fill method. Expecting pad (ffill), backfill (bfill) or nearest.`를 던진다. 이슈 작성자는 "어느 지점에서 dims가 정제되지 않은 채 다른 메서드로 넘어간다"고 정확히 진단했다. 차원 이름은 인덱싱 의미에 영향을 주면 안 되는데, 이름이 호출 시그니처와 충돌하면서 동작이 깨진 것.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈 본문이 `.loc` + dict 인덱싱을 직접 지목하고 재현 코드가 있다. `_LocIndexer.__getitem__`까지는 키워드 grep으로 좁게 수렴한다. 단 "왜 `method`만 깨지는지"는 `sel` 시그니처를 봐야 하므로 L0(핀포인트)까지는 아님.
- **S2 (Constraint-Reasoning)**: 고칠 한 줄(`return self.data_array.sel(**key)`)은 금방 찾지만, 올바른 픽스는 "왜 깨지나"를 추론해야 도출된다. `**key` 언패킹이 `key={'method':'a'}`를 `sel(indexers=None, method='a')`로 바인딩 → `method='a'`가 fill-method로 해석됨. 정답은 dict를 위치인자 `indexers`로 넘겨 키워드 바인딩 충돌을 회피하는 것. 무작정 후보를 던지는 G&V가 아니라 시그니처-바인딩 불변식을 따져 푸는 결함.
- **K-API**: `sel(indexers=None, method=None, tolerance=None, drop=False, **indexers_kwargs)`라는 **공개 API의 바인딩 계약**을 정확히 이해해야 한다. 도메인(인덱싱 알고리즘) 지식이 아니라 함수 시그니처/네임스페이스 계약 문제라 K-API.
- **primary = T-ConstraintReason**: 위치는 거의 명확하나, 픽스의 정당성이 "키워드 인자 네임스페이스 오염"이라는 인과 추론에서 나온다.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처: 1파일·1줄 수정(`**key` → `key`), 명확한 재현 코드(`has-repro`), 단일 함수(`_LocIndexer.__getitem__`). localize 직접성은 높지만 픽스의 *근거*가 시그니처 충돌 추론을 요구하므로 T1(픽스가 이슈에 적혀있는 수준)보다는 한 칸 위. 공식 라벨 "15분-1시간"과 정합적이며, 본 분석도 T2로 라벨과 일치한다. P2P가 875개로 넓어 `regression-trap` 잠재성은 있으나, 변경이 호출 규약(키워드→위치)만 바꾸는 의미보존 리팩터라 실제 회귀 위험은 낮아 티어를 끌어올리지 않는다.

## 골드패치 분석
- **파일·함수**: `xarray/core/dataarray.py`의 `_LocIndexer.__getitem__`.
- **근본원인**: dict-like key를 `self.data_array.sel(**key)`로 **언패킹**해 넘겼다. `sel`의 시그니처는 `sel(indexers=None, method=None, tolerance=None, drop=False, **indexers_kwargs)`. 차원 이름이 `method`이면 `**key`가 `method='a'`를 진짜 `method` 파라미터(fill 방법)에 바인딩한다. 그 결과 `'a'`가 reindex의 fill-method로 해석되어 `ValueError: Invalid fill method`가 난다. `dim1`처럼 충돌 안 하는 이름은 `**indexers_kwargs`로 흡수되어 우연히 동작했을 뿐.
- **수정요지**: `sel(**key)` → `sel(key)`. dict 전체를 첫 위치인자 `indexers`로 전달해, 차원 이름이 더 이상 키워드 파라미터 네임스페이스와 충돌하지 않게 한다. 모든 키가 `indexers` dict 안에 머물러 `method`/`tolerance`/`drop` 같은 이름도 차원으로만 해석된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_loc_dim_name_collision_with_sel_params` — dims `["dim1","method"]`인 DataArray에서 `da.loc[dict(dim1=["x","y"], method=["a"])]`가 `[[0],[1]]`을 반환하는지 검사. 패치 전엔 `method=["a"]`가 fill-method로 바인딩되어 ValueError, 패치 후엔 dict가 `indexers`로 들어가 정상 셀렉션.
- **픽스 증명**: 테스트가 정확히 충돌 시나리오(차원명 == `sel` 파라미터명)를 재현하므로, `sel(key)`가 키워드 바인딩을 우회한다는 사실을 직접 입증한다.
- **overfit/regression 관점**: 테스트는 `method` 한 케이스만 보지만(`tolerance`/`drop` 미검증), 픽스 자체가 "dict→위치인자"라는 일반 해법이라 한 케이스로도 전 충돌클래스를 닫는다 → overfit 위험 낮음. P2P 875개(`__getitem__` 일반 라벨 셀렉션 전부)가 깨지지 않아야 하는데, `sel(**key)`와 `sel(key)`는 비충돌 입력에서 동치라 회귀 없음.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "`.loc[dict(...)]`", "dims가 정제되지 않은 채 다른 메서드로 넘어간다", 그리고 에러 문구 `Invalid fill method`가 결정적 신호. `loc` → `_LocIndexer.__getitem__`로 들어가 `self.data_array.sel(**key)`를 찾고, `sel` 시그니처에 `method` 파라미터가 있음을 확인하면 충돌이 드러난다.
2. **픽스**: `**key`를 `key`로 바꿔 dict를 위치인자 `indexers`로 전달. 이것이 올바른 *일반화*인 이유 — 버그의 본질은 "사용자 차원명이 함수 키워드 네임스페이스를 침범"하는 것이므로, 차원명을 데이터(dict 값)로 다루면 `method`뿐 아니라 `tolerance`/`drop`/`indexers` 등 모든 충돌이 동시에 사라진다. `method` 이름만 if로 막는 식의 특수처리는 오답.
3. **regression 안전**: 비충돌 차원명(`dim1`, `dim2` 등)은 패치 전후가 동치이므로 875개 P2P 셀렉션 동작이 그대로 유지된다. `_setitem_`/`isel` 등 인접 경로는 건드리지 않아 부작용 없음.
4. **함정 회피**: 오라클 없는 에이전트는 (a) 에러 메시지만 보고 reindex/fill-method 로직을 고치려는 잘못된 localize, (b) `method`라는 이름을 키에서 rename/blacklist하는 특수처리로 다른 충돌(`tolerance` 등)을 놓치는 overfit에 빠지기 쉽다. `sel`의 *시그니처 바인딩 규약*을 먼저 읽고 "키워드 언패킹이 사용자 데이터를 함수 파라미터에 흘린다"는 인과를 잡으면 한 줄 위치인자 전환으로 정확히 수렴한다.
