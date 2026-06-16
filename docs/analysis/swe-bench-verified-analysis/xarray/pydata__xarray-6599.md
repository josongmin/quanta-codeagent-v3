---
instance_id: pydata__xarray-6599
repo: pydata/xarray
base_commit: 6bb2b855498b5c68d7cca8cceb710365d58e6048
version: "2022.03"
difficulty: "15 min - 1 hour"
created_at: 2022-05-12T15:12:41Z
fail_to_pass: 1
pass_to_pass: 264
gold_files: [xarray/core/computation.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, has-repro, underspecified]
---

## 문제 요약
`xr.polyval`을 `timedelta64[ns]` 좌표로 호출하면 stable(2022.3.0) 대비 잘못된 결과를 낸다. 새 polyval 구현은 index 좌표가 아닌 `coord` 인자의 값을 numeric으로 변환해 다항식을 평가하는데, timedelta 좌표가 올바르게 float로 환산되지 않는다. hints에 따르면 좌표를 직접 넘기면 `cannot include dtype 'm' in a buffer` 또는 `ufunc 'subtract' cannot use operands ... '<m8[ns]' and '<M8[D]'` 에러까지 난다. 즉 `_ensure_numeric`이 datetime은 처리하면서 timedelta는 처리하지 못하는 게 근본.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈 본문에 직접 심볼은 없지만 hints의 traceback이 `computation.py:1949 _ensure_numeric → 1939 to_floatable`를 정확히 지목. 스택트레이스로 단일 함수에 수렴하므로 L1. has-repro로 localize는 거의 공짜.
- **S2 (Constraint-Reasoning) +S5**: 고칠 지점(`to_floatable`)은 명확하나, "timedelta를 어떻게 float로 만들 것인가"를 추론해야 함. datetime은 origin 기준 offset(`datetime_to_numeric`)이 필요하지만 timedelta는 절대 경과량이라 그냥 ns 정수→float면 충분하다는 도메인 불변식을 합성해야 한다. "stable과 동일 결과"라는 의도는 코드만으론 안 나와 스펙 재구성(S5)이 보조로 든다.
- **K-Domain**: numpy dtype.kind('M'/'m')과 datetime/timedelta 의미, `datetime_to_numeric`이 왜 timedelta에 부적합한지(offset subtract가 dtype 충돌)는 xarray/numpy 도메인 지식.
- **primary = T-ConstraintReason**: 위치는 잡혔고 진짜 난점은 "올바른 변환식"을 의미론으로 도출하는 것. 템플릿 가드(S1)가 아니라 분기별로 다른 정답 식이 필요해 ConstraintReason.

## 난이도 티어
**T3 (중간)**. 구조적 피처: 1파일(`computation.py`) 단일 함수 1개, 골드 순변경 +5줄 수준으로 scope는 T2급. 그러나 (1) datetime과 timedelta를 **다르게** 다뤄야 한다는 의미론 추론이 들어가고(단순 None가드 아님), (2) P2P가 264개로 넓어 `test_polyval[datetime-*]` 등 기존 datetime 경로를 절대 깨면 안 되는 regression-trap이 있다. has-repro·소규모라 T4까지는 안 가고, S1 기계적 픽스가 아니라 T2도 아니다. 공식 라벨 "15min-1h"와 정합(T3).

## 골드패치 분석
- **파일/함수**: `xarray/core/computation.py`의 `_ensure_numeric` 내부 클로저 `to_floatable(x: DataArray)`.
- **근본원인**: 기존 코드는 `if x.dtype.kind in "mM":` 한 분기로 datetime('M')과 timedelta('m')를 함께 묶어 둘 다 `datetime_to_numeric(...)`에 보냈다. `datetime_to_numeric`은 내부에서 `array - offset`을 수행하는데, timedelta('m8')에서 datetime origin offset('M8')을 빼면 ufunc dtype 충돌이 나거나 잘못된 numeric을 만든다. → 잘못된 polyval 결과.
- **수정요지**: 분기를 dtype.kind별로 쪼갬. `kind == "M"`(datetime)은 기존대로 `datetime_to_numeric(... datetime_unit="ns")`. `kind == "m"`(timedelta)은 신규 `elif`로 `return x.astype(float)` — ns 정수 경과량을 그대로 float화해 stable 결과를 복원.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_polyval[timedelta-False]`. `test_polyval` 파라미터에 timedelta 케이스를 추가: 입력 `timedelta64[ns]` 좌표 `[1000,2000,3000]`, degree 계수 `[0,1]`, 기대 결과 `[1000.0,2000.0,3000.0]`. 즉 1차항(degree 1) 계수만 1이라 결과가 ns값 그대로 float가 되어야 하므로 `astype(float)`가 정확히 검증된다.
- **픽스 증명**: 패치 전엔 timedelta가 `datetime_to_numeric` 경로로 가 에러/오답 → 픽스 후 `astype(float)`로 `[1000.0,2000.0,3000.0]` 산출. 테스트가 정확히 새 분기를 친다.
- **overfit/regression**: FAIL_TO_PASS가 1개라 얇아 보이나, P2P에 `test_polyval[datetime-False/True]`와 `test_polyval[timedelta-True]`(dask 변형)이 이미 있어 datetime 경로 불변·dask 경로까지 함께 강제 → special-case overfit이 어렵다. regression-trap은 datetime 분기를 건드리지 않은 점이 안전판.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "main에서 polyval 결과가 틀림" + hints traceback이 `_ensure_numeric → to_floatable`을 직접 가리킨다. `polyval` 정의에서 `coord = _ensure_numeric(coord)` 호출을 따라가면 `to_floatable`의 `dtype.kind in "mM"` 한 줄이 datetime/timedelta를 뭉뚱그린다는 걸 즉시 발견.
2. **픽스와 일반화**: timedelta는 절대 경과 시간이라 origin offset이 불필요·부적합(그래서 `array - offset`이 dtype 충돌). 올바른 변환은 ns 정수를 그대로 float로 보는 것(`x.astype(float)`). datetime은 epoch 기준 offset이 필요하므로 `datetime_to_numeric` 유지. 분기를 'M'/'m'로 분리하는 게 두 dtype의 서로 다른 의미론을 반영한 올바른 일반화이며, `[1000,2000,3000]`뿐 아니라 임의 timedelta·다항차수에 일관.
3. **regression 안전**: datetime 분기(`kind == "M"`)를 바이트 그대로 보존해 `test_polyval[datetime-*]`을 안 깬다. 264개 P2P(특히 polyval/cov/corr 군)는 timedelta 외 경로를 안 건드리므로 무영향.
4. **함정 회피**: (a) `in "mM"`을 통째 `astype(float)`로 바꾸면 datetime이 epoch offset 없이 환산돼 datetime 케이스가 깨진다 — 반드시 datetime은 `datetime_to_numeric` 유지. (b) timedelta를 `datetime_to_numeric(datetime_unit="ns")`에 그대로 넣어 "통합 처리"하려 하면 `<m8` vs `<M8` ufunc 충돌로 실패. (c) `astype("float64")`의 단위는 ns 정수라는 점을 놓치고 임의 스케일링을 넣으면 stable 결과와 어긋난다. 분기별로 정답식이 다르다는 점이 핵심.
