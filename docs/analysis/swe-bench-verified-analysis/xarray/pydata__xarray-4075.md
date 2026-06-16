---
instance_id: pydata__xarray-4075
repo: pydata/xarray
base_commit: 19b088636eb7d3f65ab7a1046ac672e0689371d8
version: "0.12"
difficulty: "<15 min fix"
created_at: 2020-05-18T18:42:05Z
fail_to_pass: 2
pass_to_pass: 958
gold_files: [xarray/core/weighted.py]
primary_type: T-ConstraintReason
tier: T2
loc_axis: L0
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`DataArray.weighted(wgt)`에 boolean dtype 가중치를 넘기면 `mean()`이 틀린 값을 반환한다. `dta=[1,1,1]`, `wgt=[True,True,False]`일 때 기대값은 `1.0`인데 `2.0`이 나온다. 원인은 내부 `sum_of_weights`가 `xr.dot(da.notnull(), weights)` 형태의 boolean×boolean dot product를 수행하는데, `xr.dot([True,True],[True,True])`가 개수 `2`가 아니라 boolean `True`로 평가되어 정규화 분모가 망가지기 때문이다. 이슈 본문이 `wgt * 1`로 int 캐스팅하면 옳다고 픽스 방향까지 명시한다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 `sum_of_weights`를 `xr.dot(dta.notnull(), wgt)`로 계산한다고 코드 표현식까지 지목. `weighted.py`의 `_sum_of_weights` grep 한 방으로 수렴. 탐색 비용 0.
- **S2 Constraint-Reasoning (+S1)**: 고칠 지점은 자명하나, "boolean dot이 sum 아닌 logical-any를 낸다"는 dtype 의미론 불변식을 추론해야 정확한 조건분기(weights가 bool일 때만 int 캐스팅)를 합성한다. 이슈가 픽스 형태(`*1`)를 거의 적어줘 S1 성격도 있으나, 가드 위치를 `mask`가 아니라 `self.weights`에 걸어야 하고 non-bool 경로를 보존해야 하므로 dominant는 S2.
- **K-Domain**: `xr.dot`/`DataArray.dtype`/numpy boolean reduction 의미론을 알아야 근본원인이 보인다. 일반 파이썬 추론만으로는 "dot이 왜 True를 내는지" 설명 불가.
- **primary = T-ConstraintReason**: 위치는 명확(L0)하나 픽스의 본질이 dtype-의존 조건식 합성이라 DirectMap이 아닌 ConstraintReason.

왜 S2인가(APR 관점): 결함은 단일 표현식이지만 패치는 "후보 여러 개 중 테스트로 고르기"(S3)가 아니라 dtype 불변식으로부터 연역되는 단일 정답(bool→int)이다. SemFix류 의미기반 합성에 정확히 대응.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처:
- 파일수 1 (`xarray/core/weighted.py`), 함수 1 (`_sum_of_weights`), 순증 +7줄/실수정 1라인 분기.
- localize 직접성 최상(L0, has-repro: MCVE+기대출력 명시) → 해결 용이성 강한 신호.
- 도메인 지식 필요(K-Domain)지만 얕음 — boolean dot 의미론 한 가지만 알면 됨.
- **P2P trap 존재**: PASS_TO_PASS 958개로 weighted 모듈 전체 파라미터화 스위트가 광범위. non-bool(int/float) 가중치 경로를 한 줄도 안 깨야 하므로 단순 "항상 int 캐스팅"으로 망치면 regression. 이 때문에 T1으로 내리지 않고 T2.
- 공식 라벨 `<15 min fix`와 일치. 개발자 시간 기준 사소하나, P2P 광범위성 때문에 무지성 캐스팅 함정이 있어 T1(존나쉬움)은 아님.

## 골드패치 분석
- **파일/함수**: `xarray/core/weighted.py` → `Weighted._sum_of_weights`.
- **근본원인**: `_sum_of_weights`가 `mask = da.notnull()`(bool)와 `self.weights`를 `self._reduce(...)`에 넘기고, `_reduce`는 내부적으로 `dot(da, weights, dims=dim)`을 호출한다. `self.weights`가 boolean dtype이면 bool×bool dot → numpy가 logical-OR 누적으로 평가해 개수가 아닌 `True`(=1)를 반환, 정규화 분모가 1이 되어 mean이 합으로 뭉개진다.
- **수정요지**: `_reduce` 호출 전에 `self.weights.dtype == bool`일 때만 `self.weights.astype(int)`로 캐스팅 후 reduce. bool이 아니면 기존 경로 그대로. 주석 `# bool -> int, because xr.dot([True,True],[True,True]) -> True (and not 2); GH4074`로 의도 봉인. `mask`(da.notnull 결과)는 캐스팅하지 않음 — sum 대상이 아니라 마스크 역할이므로.

## 검증 (test_patch)
- **FAIL_TO_PASS (2)**: `test_weighted_sum_of_weights_bool`(weights `[True,True]` → `sum_of_weights == 2`), `test_weighted_mean_bool`(`da=[1,1]`, weights `[True,True]` → `mean == 1`). 패치 전엔 dot이 `True`(1)를 내 각각 `1`/`2`로 실패, 패치 후 int 캐스팅으로 `2`/`1` 통과.
- **픽스 증명**: 두 테스트가 sum_of_weights(분모 직접)와 mean(분모로 나눈 최종) 양쪽을 커버해 캐스팅이 분모 계산 지점에 정확히 작용함을 보임.
- **overfit/regression 관점**: 캐스팅을 `dtype == bool` 가드로 한정했으므로 int/float 가중치는 byte-identical 경로 → 958개 P2P(특히 `test_weighted_*[weights*-*]` 파라미터 가족)가 안전. overfit 위험 낮음: 픽스가 특정 테스트값이 아니라 dtype 클래스 전체(임의 bool weights)에 일반화. 다만 FAIL_TO_PASS가 2개로 얇아 0-weight bool·다차원 bool 등 미검증 입력은 남으나, 캐스팅이 모든 bool 케이스를 균일 처리하므로 special-case overfit는 아님.

## 모범답안 (오라클 기반)
1. **localize**: 이슈 본문이 `sum_of_weights = xr.dot(dta.notnull(), wgt)`와 `wgt*1`이 옳다고 명시 → `weighted.py`에서 `dot`/`notnull` grep → `_sum_of_weights`(및 그것이 부르는 `_reduce`)로 직행. has-repro로 1분 내 재현.
2. **픽스와 일반화**: 진짜 결함은 "boolean dot이 count가 아닌 logical reduction"이다. 따라서 reduce에 들어가는 **weights를 int로 승격**해야 한다. `self.weights.dtype == bool`에서만 `astype(int)` — 이것이 임의 boolean 가중치 전체에 맞는 올바른 일반화이며, 이슈의 `*1` 트릭을 dtype 가드로 정형화한 형태.
3. **regression 안전**: P2P 958개의 int/float 가중치·nan 처리·equal-weights·non-DataArray weights 케이스를 깨면 안 됨. bool 분기를 분리하고 else에 원본 호출을 그대로 둬 비-bool 경로 불변 보장.
4. **함정 회피**: (a) `mask`(da.notnull)를 캐스팅하면 안 됨 — 합산 대상은 weights지 mask가 아님. (b) 가드 없이 항상 `astype(int)`/`astype(float)` 하면 float weights의 dtype/정밀도와 dask lazy 경로를 건드려 P2P 회귀 위험. (c) `_weighted_sum`이나 호출부에서 고치면 분모(sum_of_weights)는 여전히 bool dot로 틀림 — 정확한 chokepoint는 `_sum_of_weights` 내부 reduce 호출이다. 오라클 없는 에이전트는 `*1`을 `mean()` 결과에만 붙이거나 잘못된 함수에 캐스팅을 넣어 sum_of_weights를 못 고치는 데서 틀리기 쉽다.
