---
instance_id: pydata__xarray-6744
repo: pydata/xarray
base_commit: 7cc6cc991e586a6158bb656b8001234ccda25407
version: 2022.06
difficulty: 15 min - 1 hour
created_at: 2022-07-02T16:36:00Z
fail_to_pass: 3
pass_to_pass: 1815
gold_files: [xarray/core/rolling.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`DataArrayRolling`을 수동으로 순회(`for label, window in da.rolling(...)`)할 때 `center=True` kwarg가 무시된다. `rolling(x=3, center=True).mean()`은 중앙정렬 윈도우 `[nan, 2, 3, ..., 8, nan]`를 주지만, 동일 객체를 수동 순회하면 우측정렬 결과 `[nan, nan, 2, ..., 8]`가 나온다. 즉 `__iter__`가 `.mean()` 등 집계 경로와 윈도우 슬라이스 정렬 규약이 어긋난다.

## 유형 (정형화)
- **L (Localization) = L1**: 이슈가 "manually iterating over DataArrayRolling"과 "center kwarg ignored"를 명시 → `rolling.py`의 `__iter__`로 키워드 grep 한 번에 수렴. 단일 파일·단일 함수. 직접 심볼명을 적어주진 않아 L0는 아님.
- **S (Repair Strategy) = S2 (Constraint-Reasoning)**: 고칠 함수는 자명하나, 올바른 픽스는 "윈도우 start/stop 인덱스 산식을 center 정렬에 맞게 재유도"하는 산술 추론이다. 후보를 마구 시도하는 G&V가 아니라, center일 때 윈도우가 라벨 좌우로 어떻게 펼쳐지는지 불변식(`offset = (window+1)//2`)을 따져 식을 합성해야 한다.
- **K (Knowledge) = K-Domain**: xarray rolling의 정렬 규약(center 윈도우가 어느 인덱스를 중심으로 stop을 +offset 미는지, `min_periods`/`count` 처리)을 알아야 `.mean()`과 일치하는 식을 도출한다. 일반 파이썬 추론만으로는 정렬 규약을 못 맞춘다.
- **primary = T-ConstraintReason**: 위치는 명확(L1)하나 난점이 "center 정렬 산식을 정확히 추론 합성"하는 S2 의미추론에 있으므로 ConstraintReason이 dominant.

## 난이도 티어
**T3 (중간)**. 구조적 피처:
- 파일 1개(`xarray/core/rolling.py`), 함수 1개(`__iter__`), 실질 변경 ~6줄 헌크 1개 → scope는 작다.
- localize 직접성: 이슈 키워드가 `__iter__`를 거의 지목 → 탐색 부담 낮음.
- **has-repro**: 이슈에 최소 재현 코드 + 기대/실제 배열이 둘 다 있음(강한 easiness 신호).
- 그러나 픽스가 단순 가드/상수 변경이 아니라 인덱스 산식 재유도(S2)라 T2(쉬움)보다 위.
- **regression-trap**: PASS_TO_PASS 1815개로 넓고, `__iter__`는 `center=False` 기존 동작과 `min_periods`/다차원 가드(`ndim>1` ValueError)를 유지해야 함. center 분기를 추가하며 비-center 경로를 깨면 대량 회귀.
공식 라벨 "15 min - 1 hour"와 일치 — repro가 있어 빠르지만 산식 추론이 들어가 trivial은 아님.

## 골드패치 분석
- **파일·함수**: `xarray/core/rolling.py` → `DataArrayRolling.__iter__`.
- **근본원인**: 기존 코드는 정렬 무관하게 우측정렬 산식만 썼다. `stops = arange(1, len+1)`, `starts = stops - window`, `starts[:window] = 0` — 항상 라벨이 윈도우의 우측 끝에 오도록 슬라이스를 만든다. `center` 플래그를 전혀 참조하지 않아 `.mean()`의 중앙정렬과 어긋난다.
- **수정요지**: center 여부로 stop 오프셋을 분기.
  - `offset = (window0 + 1) // 2 if self.center[0] else 1` — center면 윈도우를 라벨 기준 좌우로 펼치도록 stop을 앞당김.
  - `stops = np.arange(offset, self.obj.sizes[dim0] + offset)`, `starts = stops - window0`, `starts[: window0 - offset] = 0` — 시작부 경계 클램프도 offset에 맞춰 일반화.
  - 부수: `self.dim[0]` 반복 호출을 `dim0` 지역변수로 추출(가독·일관), 반환 타입 힌트를 `Iterator[tuple[RollingKey, DataArray]]` → `tuple[DataArray, DataArray]`로 정정. `counts >= self.min_periods` 마스킹은 유지.

## 검증 (test_patch)
- **FAIL_TO_PASS (3)**: `test_rolling_iter[numpy-3-True-1]`, `[numpy-3-True-2]`, `[numpy-7-True-1]` — 모두 `center=True`(`True`) 케이스. 테스트는 `da.rolling(time=size, center=center)`로 파라미터화(`center∈{True,False}`, `size∈{1,2,3,7}`)되고, 수동 순회 윈도우의 `mean`과 `rolling_obj.mean().isel(time=i)`를 `np.testing.assert_allclose`로 직접 비교한다.
- **픽스 증명**: 픽스 전엔 center 윈도우가 우측정렬이라 i 위치별 `actual`(집계경로)≠`expected`(수동 윈도우 평균) → assert_allclose 실패. offset 분기로 수동 윈도우가 중앙정렬되어 두 경로가 일치 → 통과.
- **overfit 관점**: 테스트가 `size∈{1,2,3,7}`×`center∈{True,False}`로 짝수/홀수 윈도우와 비-center를 모두 커버하고, 기존 약한 단언(`isnull` 위치만 보고 `np.allclose` 반환값을 버리던 vacuous 체크)을 `assert_allclose`로 교체해 teeth를 강화. special-case 하드코딩으론 통과 어려움 → overfit 위험 낮음.
- **regression 관점**: `center=False` 파라미터가 FAIL_TO_PASS엔 없지만 테스트에 포함되어 비-center 경로 보존을 강제. 픽스의 `offset=1`(비-center) 분기가 기존 산식과 동치라 회귀 없음.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "manually iterating over DataArrayRolling" + "center kwarg ignored" → `xarray/core/rolling.py`에서 `__iter__`로 grep. 비교 기준은 `.mean()`(`construct`/reduce 경로)이 어떻게 center를 반영하는지이므로, `__iter__`의 starts/stops 산식이 center를 안 보는 점을 진단.
2. **픽스와 일반화 근거**: 정답은 center일 때 stop을 `(window+1)//2`만큼 앞당기는 것. 홀수 window=3이면 offset=2 → 라벨 i의 윈도우가 `[i-1, i, i+1]` 중심이 되어 `.mean()`과 동일. 짝수 window=2면 offset=1로 xarray의 center 규약(약간 우측 편향)과 일치 — 이래서 단순히 `window//2`가 아니라 `(window+1)//2`가 올바른 일반화. 시작부 클램프 `starts[: window - offset] = 0`도 offset에 종속시켜 모든 size에서 경계가 맞는다.
3. **regression 안전**: `center=False`면 `offset=1`이 되어 기존 `arange(1, len+1)`·`starts[:window]=0`과 산술적으로 동치 → 비-center 동작 보존. `ndim>1` ValueError 가드, `counts >= self.min_periods` 마스킹을 건드리지 않아 1815개 P2P(다차원 rolling, min_periods, construct/reduce)를 안 깬다.
4. **함정 회피**: (a) offset을 `window//2`로 쓰면 짝수 window에서 xarray center 규약과 어긋나 짝수 케이스가 깨진다 — `(window+1)//2`가 정답. (b) center 분기만 추가하고 시작부 클램프 인덱스(`window - offset`)를 기존 `window`로 두면 경계 NaN 위치가 틀어진다. (c) 기존 테스트의 vacuous 단언(`np.allclose` 반환값 미사용)을 그대로 믿으면 "통과하는데 틀린" 픽스를 만들 수 있다 — assert_allclose로 실제 값 일치를 검증해야 함. (d) `min_periods`/`count` 마스킹을 함께 손대면 불필요한 회귀를 유발.
