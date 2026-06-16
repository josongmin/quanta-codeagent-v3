---
instance_id: pydata__xarray-4687
repo: pydata/xarray
base_commit: d3b6aa6d8b997df115a53c001d00222a0f92f63a
version: "0.12"
difficulty: "15 min - 1 hour"
created_at: 2020-12-13T20:42:40Z
fail_to_pass: 1
pass_to_pass: 1717
gold_files: [xarray/core/computation.py]
primary_type: T-SpecInference
tier: T3
loc_axis: L0
repair_strategy: S5 (+S1)
knowledge: K-Domain
flags: [regression-trap, has-repro, underspecified]
---

## 문제 요약
`xr.where(cond, x, y)`가 입력 DataArray의 attrs를 보존하지 않고 빈 attrs를 가진 결과를 반환한다. 이슈는 재현 코드(`da.attrs['foo']='bar'` 후 `xr.where(da==0,-1,da).attrs == {}`)와 함께, 단순히 `keep_attrs=True`를 강제하면 breaking change이니 kwarg를 추가하거나 `OPTIONS["keep_attrs"]`를 따라야 한다는 방향까지 명시한다. 즉 동작 자체보다 "어떤 기본값/계약으로 attrs를 흘려보낼지"가 핵심이다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 함수 심볼 `xr.where`를 직접 지목. `xarray/core/computation.py`의 `where` 함수 한 곳. grep 한 방.
- **S5 Spec-Inference (+S1)**: 고칠 위치는 자명하나 진짜 작업은 "올바른 attrs 전파 계약"을 재구성하는 것이다. hints가 직접 명세한 세 가지 결정 — (a) 무조건 `keep_attrs=True`는 breaking이라 금지, (b) 기본값은 전역 `OPTIONS["keep_attrs"]`(=`_get_keep_attrs(default=False)`)를 따른다, (c) `True`일 때 *어느* 입력의 attrs를 쓰나(→ `x` = 두 번째 인자, DataArray/Dataset의 `.where` 메서드와 일관) — 를 코드만으론 결정 못 하므로 스펙 추론이 본질. kwarg 배선 자체는 S1처럼 기계적.
- **K-Domain**: `apply_ufunc`의 `keep_attrs` 시그니처(bool/str/callable 허용)와 callable 형태 `(attrs, context) -> attrs`, 그리고 `_get_keep_attrs`/`OPTIONS` 관례를 알아야 한다. xarray 내부 attrs 전파 도메인 지식이 병목.
- **primary = T-SpecInference**: 난점이 localize도 후보탐색도 아니라, 하위호환을 깨지 않는 attrs 전파 의미(기본값·선택 대상)를 이슈/관례에서 재구성하는 데 있음.

## 난이도 티어
**T3 (중간)** — 공식 라벨 "15min-1hour"와 정합.
- 파일 수 1, 추가 ~10줄, 단일 함수 → 구조적으로 가볍다.
- has-repro(MCVE 2건) + L0 직접 지목 → localize 비용 ≈ 0. 이건 T2로 미는 신호.
- 그러나 단순 `keep_attrs=True` 패치는 회귀를 부른다(아래). 올바른 풀이는 (1) 새 kwarg `keep_attrs=None` 추가, (2) `None`→`_get_keep_attrs(default=False)` 디폴트 해석, (3) `True`→`lambda attrs, context: attrs[1]` callable로 변환이라는 **3-결정 스펙 합성**을 요구 → S5가 T2가 아닌 T3로 끌어올린다.
- P2P 1717개로 매우 넓다(regression-trap): 디폴트를 `False`로 유지해 기존 `where` 사용자의 attrs-drop 동작을 보존해야 하므로 단순화 실수가 회귀로 직결.

## 골드패치 분석
- **건드린 파일·함수**: `xarray/core/computation.py`의 `def where(cond, x, y)` 단일 함수.
- **근본원인**: `where`가 내부에서 `apply_ufunc(duck_array_ops.where, ...)`를 호출할 때 `keep_attrs`를 전혀 전달하지 않아 `apply_ufunc`의 기본 attrs-drop 경로를 타고 attrs가 소실됨.
- **수정요지**:
  - 시그니처를 `def where(cond, x, y, keep_attrs=None)`으로 확장(public API 추가, 비파괴).
  - `keep_attrs is None`이면 `_get_keep_attrs(default=False)`로 전역 옵션을 조회 → 디폴트는 종전과 동일한 미보존.
  - `keep_attrs is True`이면 `lambda attrs, context: attrs[1]`로 변환 → `apply_ufunc` 입력 attrs 리스트의 인덱스 1(=두 번째 인자 `x`)을 선택. DataArray/Dataset `.where`와의 일관성을 위해 `x`의 attrs를 채택.
  - `apply_ufunc(...)` 호출에 `keep_attrs=keep_attrs` 인자 추가로 배선 완료.
  - `_get_keep_attrs`는 base_commit에서 이미 `from .options import OPTIONS, _get_keep_attrs`로 import되어 있어 추가 import 불필요.

## 검증 (test_patch)
- **FAIL_TO_PASS (1)**: `xarray/tests/test_computation.py::test_where_attrs`. cond/x/y 각각 attrs를 다르게 부여하고 `xr.where(cond, x, y, keep_attrs=True)`가 `x`의 attrs(`{"attr":"x"}`)를 가진 결과와 `assert_identical`인지 검증.
- **픽스 증명**: `keep_attrs=True`→ callable `attrs[1]` 변환이 정확히 두 번째 인자 `x`의 attrs를 고르게 하므로, cond/y가 아닌 `x.attrs`만 살아남는다 → 테스트가 곧 "올바른 대상 선택" 계약을 핀으로 박는다.
- **overfit 관점**: FAIL_TO_PASS가 1개뿐이라 얇다. 그러나 테스트가 cond·x·y에 *서로 다른* attrs를 줘서 "attrs[1]=x"라는 구체적 선택을 강제 → `attrs[0]`(cond)나 병합으로 통과 못 함. special-case 우회 여지가 낮아 overfit 위험은 제한적.
- **regression 관점**: test_patch는 `test_units.py`에서 포매팅만 정리(동작 무변). 핵심은 디폴트 `keep_attrs=None→False` 유지로 P2P 1717개(attrs를 드롭하던 기존 경로 포함)가 깨지지 않는다는 점. 무조건 보존으로 바꿨다면 다수 P2P가 회귀했을 것.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 `xr.where`를 직접 지목 → `xarray/core/computation.py`의 `where`를 열어 `apply_ufunc(duck_array_ops.where, ...)` 호출에 `keep_attrs`가 없음을 확인. 한 함수에서 종료.
2. **픽스와 일반화 근거**: 새 kwarg `keep_attrs=None`을 도입하고 `None`을 `_get_keep_attrs(default=False)`로 해석해 전역 `OPTIONS["keep_attrs"]` 관례에 편입. `True`는 `lambda attrs, context: attrs[1]`로 변환해 `x`의 attrs만 채택 — 이는 `DataArray.where`/`Dataset.where`의 기존 의미와 일관되므로 임의 선택이 아닌 *프레임워크 계약에 정렬된* 일반화다. 무조건 보존(하드코딩 True)이 아니라 opt-in이라 비파괴.
3. **regression 안전**: 디폴트가 `False`(미보존)로 유지되므로 P2P 1717개 중 종전 attrs-drop을 기대하는 코드가 보존된다. `apply_ufunc`의 callable keep_attrs 시그니처 `(attrs, context)`를 정확히 맞춰 다른 ufunc 경로도 영향 없음.
4. **함정 회피**: 오라클 없는 에이전트의 전형적 오답 = (a) `keep_attrs=True`를 그냥 하드코딩 → breaking change로 광범위 P2P 회귀, (b) `attrs[0]`(cond) 또는 attrs 병합 선택 → `.where` 메서드와 불일치이며 test_where_attrs 실패, (c) kwarg를 raw bool로 `apply_ufunc`에 넘김 → True가 "어느 입력"인지 모호. 이를 피하려면 hints가 명시한 세 결정(디폴트=옵션 조회, True=x 선택, opt-in 유지)을 스펙으로 못 박고 callable 변환으로 대상을 명시해야 한다.
