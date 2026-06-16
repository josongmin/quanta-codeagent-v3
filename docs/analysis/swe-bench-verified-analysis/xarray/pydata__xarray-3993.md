---
instance_id: pydata__xarray-3993
repo: pydata/xarray
base_commit: 8cc34cb412ba89ebca12fc84f76a9e452628f1bc
version: "0.12"
difficulty: 1-4 hours
created_at: 2020-04-21T20:30:35Z
fail_to_pass: 2
pass_to_pass: 2398
gold_files: [xarray/core/dataarray.py, xarray/core/dataset.py]
primary_type: T-SpecInference
tier: T3
loc_axis: L0
repair_strategy: S5 (+S1)
knowledge: K-API
flags: [has-repro, regression-trap, cross-file-dep]
---

# pydata__xarray-3993

## 문제 요약
`Dataset.integrate`와 `differentiate`는 `coord` 키워드를 쓰는데 `DataArray.integrate`만 `dim` 키워드를 써서 API가 불일치한다. 이슈는 "차원(dim)은 격자점 간 거리 정보가 없으므로 적분/미분 대상으로 `coord`가 맞다"며 `DataArray.integrate`도 `coord`로 통일하길 요구한다. 핵심 질문은 하위호환 깨짐 없이 어떻게 전환(deprecation cycle 필요 여부)하느냐다.

## 유형 (정형화)
- **L = L0 (Pinpointed)**: 이슈가 `DataArray.integrate`의 `dim` 인자를 직접 지목한다. `git grep "def integrate"` 한 방으로 `dataarray.py`/`dataset.py` 두 정의에 바로 도달. 탐색 비용 사실상 0.
- **S = S5 Spec-Inference (+S1 Direct-Map)**: 결함 클래스 자체는 단순(시그니처 변경)이지만, 정답의 본질은 "공개 API 계약을 어떻게 바꿔야 안전한가"라는 **스펙 재구성**에 있다. 즉시 `dim`→`coord`로 갈아끼우는 naive 픽스는 기존 `da.integrate(dim="x")` 호출을 전부 깨므로 오답이다. 올바른 답은 이슈가 던진 "deprecation cycle 필요?" 질문에 답하는 것 — `coord`를 새 1st 인자로 도입하고 `dim`은 keyword-only deprecated alias로 남겨 `FutureWarning`을 내는 전환 스펙. 가드 추가(both/None 처리) 부분은 S1 템플릿이라 보조.
- **K = K-API (API-contract)**: 픽스의 난점이 도메인 수치 로직이 아니라 **하위호환·공개 시그니처 계약**(인자 순서, keyword-only `*`, 제거 예정 버전 명시)을 정확히 맞추는 데 있다.
- **primary = T-SpecInference**: 위치/결함은 자명하나 "deprecation을 통한 호환 보존"이라는 의도된 동작이 코드에 안 적혀 있어 이슈 본문/프로젝트 관례에서 스펙을 먼저 재구성해야 한다. 그래서 G&V(S3)가 아니라 S5다 — 테스트 반복으로 우연히 수렴할 종류가 아니다.

## 난이도 티어
**T3 (중간)**. 구조적 피처:
- 파일수 2 / gold 변경 ~수십 줄(대부분 docstring), 실제 로직은 `DataArray.integrate` 시그니처 + 5줄 가드.
- localize 직접성 L0(매우 높음), has-repro(이슈에 호출 예시 명시).
- 도메인 수치지식 불필요(K-API), 그러나 **regression-trap이 실질 난점**: `da.integrate(dim=...)`가 깨지면 안 되고, P2P 2398개 중 `test_units`의 8개 integrate 케이스를 비롯한 광범위 인접 동작을 보존해야 한다.
- 단일 라인 픽스가 아니라 "호환 전환 스펙 합성"이 요구돼 T1/T2보다 위. 반면 cross-file 조율이 가벼운 한 방향 위임이고 도메인 깊이가 없어 T4까지는 아님.

공식 라벨 `1-4 hours`와 대체로 정합. 시간라벨이 높은 이유는 코드 양이 아니라 docstring 정비 + deprecation 정책 결정의 신중함 때문이며, 에이전트 관점 핵심 난점(regression 보존)이 시간라벨에 잘 안 잡혀 T3로 둔다.

## 골드패치 분석
- **건드린 파일·함수**: `xarray/core/dataarray.py::DataArray.integrate`, `xarray/core/dataset.py::Dataset.integrate`(주로 타입힌트/docstring).
- **근본원인**: `DataArray.integrate(self, dim, datetime_unit=None)`가 1st positional 인자명을 `dim`으로 정의해 `Dataset.integrate(coord, ...)`와 불일치. 단순 rename은 기존 사용자 코드 파괴.
- **수정요지**:
  1. 시그니처를 `integrate(self, coord=None, datetime_unit=None, *, dim=None)`로 변경 — `coord`가 새 1st 인자, `dim`은 `*` 뒤 keyword-only deprecated alias.
  2. 가드: `dim`과 `coord` 동시 전달 시 `ValueError("Cannot pass both 'dim' and 'coord'...")`.
  3. `dim`만 주면 `coord = dim`으로 흡수 후 `FutureWarning`(메시지에 "replaced with `coord`", "removed in version 0.19.0", `stacklevel=2`) 발생.
  4. 내부 위임을 `self._to_temp_dataset().integrate(coord, datetime_unit)`로 변경(기존 `dim` → `coord`).
  5. `Dataset.integrate`는 타입힌트(`Union[Hashable, Sequence[Hashable]]`, `-> "Dataset"`)와 docstring 문구만 정비(동작 불변). `warnings`는 dataarray.py 상단에 이미 import 되어 있어 추가 import 불요.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개)**: `test_dataset.py::test_integrate[True]`/`[False]`. 추가된 단언 `with pytest.warns(FutureWarning): da.integrate(dim="x")` — 즉 `dim` 키워드가 여전히 동작하되 `FutureWarning`을 내야 통과. base에서는 경고가 없어 실패, 골드에서 통과.
- **픽스 증명**: 이 단언은 (a) `dim` 경로가 살아 있음(호환), (b) 경고가 발생함(deprecation), (c) 결과가 정상 계산됨(`coord=dim` 흡수 위임)을 동시에 강제한다. `test_units.py`의 `method("integrate", dim="x")` → `method("integrate", coord="x")` 변경은 신 API가 1급 경로임을 확인.
- **overfit 관점**: `pytest.warns`만으로는 ValueError 가드(both 전달)나 coord 기본경로를 직접 검증하진 않아 얇은 편 → `overfit-risk`성 존재하나, 실제 픽스는 가드를 포함해야 위임 정합성이 유지되므로 special-case 통과 유인은 낮음.
- **regression 관점**: P2P 2398개(특히 `test_units` integrate 8케이스, 기존 `da.integrate("x")` positional 호출)가 깨지면 안 됨. `coord`를 1st positional로 둔 덕에 positional 호출 `da.integrate("x")`가 `coord="x"`로 정상 바인딩되어 보존됨 — 이게 keyword-only `*dim`을 쓴 핵심 이유.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 `da.integrate(dim='x')` 신호 → `git grep "def integrate"` → `dataarray.py`와 `dataset.py` 두 정의 확인. `Dataset`이 `coord`이므로 `DataArray` 쪽을 `coord`에 맞추는 방향임을 즉시 확정(L0).
2. **픽스와 일반화 근거**: 단순 rename이 아니라 `coord`를 새 positional 1st로, `dim`을 keyword-only deprecated alias(`*` 뒤)로 도입. `dim`만 오면 `coord`로 흡수 + `FutureWarning`, 둘 다 오면 `ValueError`. 이는 "이슈가 명시적으로 던진 deprecation cycle 질문"에 답하는 올바른 일반화 — 신규 사용자는 일관된 `coord`를, 기존 사용자는 경고와 함께 계속 동작을 얻는다.
3. **regression 안전**: `coord`를 1st positional로 둬야 기존 positional 호출 `da.integrate("x")`와 P2P의 integrate 케이스들이 보존된다. `dim`을 positional로 남기거나 둘 다 positional로 두면 바인딩 충돌로 회귀. `Dataset.integrate`는 동작을 건드리지 말고 docstring/타입힌트만 정비.
4. **함정 회피**: (a) `dim`을 그냥 삭제/rename → 기존 호출 전부 파괴(가장 흔한 오답). (b) `FutureWarning` 누락 또는 `stacklevel`/메시지 형식 불일치 → `pytest.warns` 통과해도 deprecation 의도 미달. (c) `*` keyword-only 마커 누락 → `dim`이 positional로 새서 `coord`와 순서 충돌. (d) `warnings`를 중복 import(이미 존재)하거나 `Dataset.integrate` 로직까지 손대는 over-edit. 정답은 "한 방향 위임 + keyword-only deprecated alias + 명시적 제거 버전"이라는 좁은 스펙을 정확히 맞추는 것.
