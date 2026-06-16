---
instance_id: pydata__xarray-2905
repo: pydata/xarray
base_commit: 7c4e2ac83f7b4306296ff9b7b51aaf016e5ad614
version: "0.12"
difficulty: "15 min - 1 hour"
created_at: "2019-04-17T21:52:37Z"
fail_to_pass: 1
pass_to_pass: 364
gold_files: [xarray/core/variable.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약

`.values` 속성을 가진 임의 객체를 `dtype=object` 배열에 대입하면, xarray가 그 객체를 자기서술(self-described) 배열로 오인해 `.values`를 추출·강제 변환한다. 즉 `bad_indexed.loc[{'dim_0': 0}] = HasValues()`가 객체 자체가 아니라 `HasValues.values`(=5)를 저장한다. 이는 v0.10.0→v0.10.1(PR #1746)에서 도입된 회귀로, `.values` 속성을 가진 lmfit `ModelResult` 같은 객체 저장을 막는다.

## 유형 (정형화)

- **L (Localization) = L0**: 이슈 본문이 정확한 파일·줄(`xarray/core/variable.py` L171-172, PR #1746의 해당 라인)을 링크로 지목하고, 메인테이너 hint가 그 라인을 다시 못박는다. grep 한 방.
- **S (Repair Strategy) = S1 (+S2)**: hint가 사실상 픽스 코드(`if isinstance(data, (pd.Series, pd.Index, pd.DataFrame)): data = data.values`)를 그대로 적어준다 → 기계적 Direct-Map. 다만 "어떤 타입만 unwrap 허용할지"의 화이트리스트(Series/Index/DataFrame)를 정하는 건 도메인 불변식 추론(S2)이 약간 섞인다.
- **K (Knowledge) = K-Domain**: `as_compatible_data`가 왜 `.values`를 벗기는지(중첩된 self-described 배열 방지), 그리고 pandas 타입 화이트리스트가 충분한지는 xarray 내부 array-like 처리 관례를 알아야 안전하다.
- **primary_type = T-DirectMap**: 위치가 자명(L0)하고 픽스가 가드/조건 좁히기로 기계적(S1)이다. duck-typing(`getattr(data, "values", data)`)을 명시적 isinstance 화이트리스트로 좁히는 정형 결함 패턴.

APR 관점: 이슈가 결함 위치와 수정 형태를 모두 명세하므로 generate-and-validate 탐색이 거의 불필요. 핵심은 "넓은 duck-typing → 좁은 타입체크"로 의도된 케이스(pandas/xarray)만 unwrap하도록 일반화하는 것이라 S1이 dominant.

## 난이도 티어

**T2 (쉬움)**. 구조적 피처:
- 파일 1개, 함수 1개(`as_compatible_data`), 실질 변경 2줄(삭제 1 + 추가 2).
- localize 직접성 최상(L0, 이슈가 줄 링크 제공).
- has-repro: 최소 재현 코드 + 기대 출력이 본문에 있음 → 가장 강한 easiness 신호.
- 픽스가 hint에 사실상 적혀 있음.
- 단, **regression-trap 존재**: P2P 364개로 매우 넓고, `as_compatible_data`는 거의 모든 Variable 생성 경로의 핫패스다. 화이트리스트를 잘못 좁히면 pandas 데이터 변환 테스트가 무더기로 깨진다. 그래서 T1(존나쉬움)이 아니라 T2.

공식 라벨 "15 min - 1 hour"와 일치. 구현 자체는 분 단위지만 화이트리스트 검증과 광범위 회귀 확인 때문에 T1로 내리지 않음.

## 골드패치 분석

- **건드린 파일·함수**: `xarray/core/variable.py`의 `as_compatible_data(data, fastpath=False)`.
- **근본 원인**: `data = getattr(data, "values", data)` 한 줄이 `.values` 속성을 가진 **모든** 객체를 self-described 배열로 간주해 unwrap한다. 이 duck-typing은 xarray.Variable / pandas.Series 등 중첩 방지를 위한 것이었으나, 사용자 정의 객체까지 무차별 적용되어 객체 dtype 저장을 깨뜨렸다.
- **수정 요지**: duck-typing을 명시적 isinstance 화이트리스트로 교체.
  ```python
  -    data = getattr(data, "values", data)
  +    if isinstance(data, (pd.Series, pd.Index, pd.DataFrame)):
  +        data = data.values
  ```
  의도된 pandas 타입만 `.values`를 벗기고, 그 외 객체는 원형 그대로 보존한다. (xarray.Variable/DataArray는 함수 상단의 다른 분기에서 이미 처리되므로 화이트리스트에서 빠져도 안전.)

## 검증 (test_patch)

- **FAIL_TO_PASS (1개)**: `TestAsCompatibleData::test_unsupported_type`. `.values` 속성에 배열을 담은 `CustomWithValuesAttr` 더미 클래스를 만들고, `Variable(dims=(), data=array)`로 0차원 객체 Variable을 생성한 뒤 `orig._data.item()`이 **여전히 `CustomWithValuesAttr` 인스턴스**임을 단언한다. 픽스 전에는 `.values`가 벗겨져 내부 배열이 저장되므로 isinstance 단언이 실패; 픽스 후 화이트리스트에 안 걸려 객체가 보존되어 통과.
- **픽스 증명**: 테스트가 정확히 회귀 시나리오(임의 `.values` 객체)를 재현하고, 화이트리스트가 그 객체를 unwrap하지 않음을 직접 관찰한다.
- **overfit 관점**: 더미 객체 1개만 검사하므로 F2P는 얇다. 그러나 픽스가 "특정 타입만 통과"가 아니라 "허용 타입을 명시 화이트리스트로 좁힘"이라 일반화가 올바르다 — special-case 우회가 아님.
- **regression 관점**: P2P 364개가 `test_pandas_data`, `test_datetime64_conversion`, `test_pandas_period_index`, `test_pandas_cateogrical_dtype` 등 pandas/datetime 변환 경로를 광범위하게 커버한다. 화이트리스트에 `pd.Series/pd.Index/pd.DataFrame`가 모두 포함되어 기존 pandas unwrap 동작이 보존됨을 이 P2P 군이 증명한다.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈가 직접 PR #1746과 `variable.py`의 `.values` 추출 라인을 링크. `as_compatible_data` 안의 `data = getattr(data, "values", data)`로 grep 한 방에 수렴. 탐색 비용 사실상 0(L0).
2. **픽스와 일반화 근거**: 무차별 `getattr` duck-typing을 의도된 self-described 타입(`pd.Series`, `pd.Index`, `pd.DataFrame`)만 명시 isinstance로 unwrap하도록 교체. "`.values`가 있으면 xarray/pandas다"라는 잘못된 가정을 제거하는 것이 본질 — 화이트리스트 방식이라 미래의 임의 사용자 객체 전부에 일반화되며 overfit이 아니다.
3. **regression 안전**: pandas 데이터·datetime·categorical·period-index 변환을 검증하는 P2P 군을 깨면 안 된다. 따라서 세 pandas 타입을 빠짐없이 화이트리스트에 넣어야 한다. xarray.Variable/DataArray는 함수 앞쪽 분기에서 이미 처리되므로 화이트리스트 누락이 회귀를 일으키지 않음을 코드로 확인하는 것이 안전판.
4. **함정 회피**: (a) 화이트리스트를 `pd.Series`만으로 너무 좁히면 `pd.Index`/`pd.DataFrame` unwrap이 깨져 P2P 대량 실패 → 세 타입 모두 포함. (b) `hasattr(data, "values")` 같은 또 다른 duck-typing으로 "고치는 척"하면 원래 버그가 그대로 남음 → 반드시 isinstance 기반 명시 타입체크여야 함. (c) `np.ndarray`나 dask array를 화이트리스트에 잘못 넣으면 안 됨(이들은 `.values`가 없거나 다른 의미) — 정확히 pandas 3타입으로 한정.
