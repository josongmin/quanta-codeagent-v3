---
instance_id: pydata__xarray-7233
repo: pydata/xarray
base_commit: 51d37d1be95547059251076b3fadaa317750aab3
version: "2022.09"
difficulty: "15 min - 1 hour"
created_at: 2022-10-27T23:46:49Z
fail_to_pass: 1
pass_to_pass: 189
gold_files: [xarray/core/rolling.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap]
---

## 문제 요약
`ds.coarsen(...).construct(...)`가 비-차원(non-dimensional) 좌표(coordinate)를 일반 데이터 변수(variable)로 강등시킨다. 예시에서 `time` 차원에 붙은 `day` 좌표가 coarsen.construct 후 좌표가 아닌 data variable로 빠진다. 기대 동작은 "construct 이전에 좌표였던 모든 변수는 이후에도 좌표로 유지"되는 것이다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 `Coarsen.construct`라는 메서드 이름을 직접 지목. `rolling.py`의 `construct` 함수로 키워드 grep 한두 번에 수렴. 단일 파일·단일 함수·단일 라인. 단 정확한 결함 라인(`should_be_coords` 계산)까지는 함수 본문을 읽어야 함 → L0가 아닌 L1.
- **S2 (Constraint-Reasoning)**: 고칠 지점은 명백하나, 올바른 집합식을 **추론으로 합성**해야 함. 버그는 `should_be_coords = set(window_dim) & set(self.obj.coords)` 가 "재구성되는 차원과 교집합인 좌표"만 다시 좌표로 승격시키고, 그 외 좌표(`day` 같은 비-차원 좌표)는 누락. 올바른 불변식("원래 좌표는 전부 좌표로 보존")을 식으로 옮겨야 하므로 G&V(시행착오)가 아닌 의미적 추론.
- **K-Domain**: xarray의 coordinate vs data_variable 모델, `set_coords`, `window_dim` 매핑 의미를 알아야 정확한 식을 도출. 일반 파이썬 지식만으론 어떤 집합을 합쳐야 하는지 결정 불가.
- **primary = T-ConstraintReason**: 위치는 좁게 잡히지만(L1) 난점이 "올바른 집합 연산을 불변식에서 추론"하는 데 있음. 템플릿 매칭(S1)이 아니라 도메인 불변식 기반 식 합성이라 ConstraintReason.

## 난이도 티어
**T3 (중간).** 구조적 피처: 파일 1개, 함수 1개, 실질 변경 1줄(3줄 추가), localize 직접성 높음(L1), has-repro(이슈에 완전한 MVCE 존재). 이 신호들만 보면 T2에 가깝다. 그러나 픽스가 단순 가드/상수가 아니라 집합식의 의미적 합성을 요구하고(S2), 좌표/변수 도메인 모델 의존(K-Domain)이라 T2를 넘는다. 또한 P2P 188개로 인접 coarsen 동작(reduce/keep_attrs/dask/dataset)이 넓게 깔려 있어 regression-trap이 약하지 않다 — set_coords 인자를 과하게 넓히면 차원 좌표 처리나 attrs 보존이 깨질 여지. 공식 라벨 "15min-1h"와 정합(T3 prior와 일치).

## 골드패치 분석
- **건드린 파일·함수**: `xarray/core/rolling.py`의 `Coarsen.construct`.
- **근본원인**: 좌표 재지정 단계에서 `should_be_coords = set(window_dim) & set(self.obj.coords)`. `window_dim`은 reshape되는 차원(예: `time`)만 키로 가지므로, 교집합은 "reshape 대상 차원과 이름이 같은 좌표"만 골라낸다. `day`처럼 `time` 차원 위에 정의됐지만 이름이 `time`이 아닌 비-차원 좌표는 이 교집합에 빠져, 이후 `reshaped.set_coords(...)`에서 좌표로 복원되지 못하고 data variable로 남는다.
- **수정요지**: 교집합 결과에 원본의 전체 좌표 집합을 합집합(union)으로 추가 — `(set(window_dim) & set(self.obj.coords)) | set(self.obj.coords)`. 결과적으로 "원래 좌표였던 모든 키는 전부 다시 좌표로 set" 하여 불변식을 보존. (window_dim과의 교집합 항은 union 후에는 부분집합이라 사실상 `set(self.obj.coords)`와 동치이나, 패치는 기존 식을 보존한 채 보강하는 형태.)

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `TestCoarsenConstruct::test_coarsen_construct_keeps_all_coords`. `day = 365*da`를 좌표로 assign한 뒤 `coarsen(time=12).construct(time=("year","month"))` 수행, `list(da.coords) == list(result.coords)`를 DataArray·Dataset 양쪽에서 단언. 픽스 전엔 `day`가 변수로 강등돼 `result.coords` 목록이 축소 → 실패. 픽스 후 전체 좌표 union으로 set되어 동일 → 통과. 이것이 픽스를 직접 증명.
- **overfit 관점**: FAIL_TO_PASS 1개로 얇지만, 테스트가 DataArray/Dataset 두 경로를 모두 검사하고 좌표 목록 전체 동등성을 본다. union 자체가 "모든 원좌표 보존"이라는 일반 불변식이라 special-case 통과가 아님 → overfit 위험 낮음(플래그 미부여).
- **regression 관점**: 기존 `test_coarsen_construct`가 클래스로 재구성돼 P2P에 남고, time 차원 좌표 reshape/keep_attrs=False/dask/ValueError 경계까지 함께 검증. union이 차원 좌표 처리를 깨지 않음을 이들이 보장 → regression-trap이 실재하나 테스트로 커버됨.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 `ds.Coarsen.construct`를 직접 지목 → `rolling.py`에서 `def construct` grep → 좌표 강등이므로 함수 말미의 좌표 재지정 라인 `should_be_coords = set(window_dim) & set(self.obj.coords)` / `reshaped.set_coords(...)`로 즉시 수렴.
2. **픽스**: 교집합은 "이름이 reshape 차원과 같은 좌표"만 보존하는 과소집합. 의도된 불변식은 "원래 좌표는 전부 좌표 유지"이므로 `set(self.obj.coords)` 전체를 set_coords 대상에 포함. 이는 MVCE의 `day` 한 케이스가 아니라 **모든 비-차원 좌표**를 덮는 올바른 일반화 → overfit 아님.
3. **regression 안전**: P2P의 `test_coarsen_construct[True/False]`(차원 좌표 `time`의 reshape, keep_attrs, dask, ValueError 경계)를 안 깨야 함. union은 기존 교집합을 포함하므로 차원 좌표는 여전히 좌표로 남고, data variable을 좌표로 잘못 승격하지도 않음(원래 coords 집합만 대상). coarsen reduce 계열 100+개 테스트는 construct를 안 거치므로 무관.
4. **함정 회피**: 오라클 없는 에이전트의 오답 경로 — (a) `window_dim` 매핑을 잘못 읽어 reshape된 새 차원 이름을 추가하려다 KeyError; (b) `set_coords` 대신 결과에서 일일이 좌표 복원하는 과한 리팩터(S6로 과적합); (c) 교집합을 차집합/대칭차로 바꾸는 등 식을 오추론. 핵심은 "원좌표 보존" 불변식 한 줄로 환원해 `set(self.obj.coords)`를 합치는 최소 변경임을 인지하는 것.
