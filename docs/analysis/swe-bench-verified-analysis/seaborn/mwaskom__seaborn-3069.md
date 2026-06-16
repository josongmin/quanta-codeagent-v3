---
instance_id: mwaskom__seaborn-3069
repo: mwaskom/seaborn
base_commit: 54cab15bdacfaa05a88fbc5502a5b322d99f148e
version: "0.12"
difficulty: "15 min - 1 hour"
created_at: 2022-10-09T23:31:20Z
fail_to_pass: 2
pass_to_pass: 94
gold_files: [seaborn/_core/plot.py]
primary_type: T-SpecInference
tier: T4
loc_axis: L1
repair_strategy: S5 (+S2)
knowledge: K-Domain
flags: [regression-trap, underspecified, cross-file-dep]
---

## 문제 요약
seaborn objects 인터페이스의 `so.Nominal` 스케일(명시 또는 추론된 것 포함)이 기존 categorical 플롯의 축처럼 그려져야 한다는 기능 요청이다. categorical 축은 세 가지 특수동작을 한다: (1) 첫/마지막 틱에서 ±0.5로 한계를 잡고 일반 margin 로직을 쓰지 않음, (2) 활성 스타일이 그리드를 켜더라도 그리드를 끔, (3) y축이면 축을 반전. 이슈는 "어디서 하면 좋을지"까지 힌트만 줄 뿐 정확한 구현(어느 함수·무슨 값)을 명세하지 않는다.

## 유형 (정형화)
- **L (Localization) = L1**: 이슈가 `Plotter._finalize_figure`를 직접 지목("Probably straightforward to do in `Plotter._finalize_figure`")한다. 다만 정확한 삽입 지점·축 반복 루프는 약간의 코드 독해가 필요하므로 L0가 아닌 L1.
- **S (Repair Strategy) = S5 (+S2)**: 의도된 동작(±0.5 한계, 그리드 off, y 반전)은 코드만 봐서는 결정되지 않고 **categorical 축의 기존 관례에서 스펙을 재구성**해야 한다 → S5. 그 위에서 `-.5, nticks-.5` 한계식과 y축 swap 같은 **올바른 식·조건을 추론 합성**해야 함 → 보조 S2.
- **K (Knowledge) = K-Domain**: matplotlib 축 객체(`xaxis`/`yaxis`), `get_major_ticks()`, `grid(which="both")`, `set_xlim(auto=None)`, seaborn `Nominal` 스케일 타입 등 프레임워크 내부지식이 병목.
- **Primary = T-SpecInference**: 핵심 난점이 "올바른 식 합성"보다 "categorical 축 동작이라는 의도된 스펙을 이슈/관례에서 먼저 복원"하는 데 있다. 그래서 APR 관점에서 SpecRover류 스펙추론이 dominant이고, 식 합성(S2)은 종속적.

## 난이도 티어
**Tier = T4 (약간 어려움)**. 구조적 피처: 단일 파일(`seaborn/_core/plot.py`) 단일 함수(`_finalize_figure`)에 약 11줄 추가 + import 1줄 정리로 **수정 범위는 작다**(scope상 T2~T3에 가까움). 그러나 (a) repro 코드 없는 **기능요청형**이라 기대동작을 스스로 명세해야 하고(underspecified), (b) y축 반전 시 `lo, hi = hi, lo` 같은 **방향 의존 엣지**를 정확히 잡아야 하며, (c) `p._limits`에 사용자가 한계를 줬으면 **건드리지 말아야 하는** 분기(`if axis_key not in p._limits`)를 빠뜨리면 P2P `test_limits`/`TestPairInterface::test_limits`가 깨진다. 이 스펙 재구성 + regression trap이 tier를 T2/T3에서 T4로 끌어올린다. 공식 라벨 "15분-1시간"은 *구현시간* 기준이며 코드량과 일치하나, localize 직접성에 비해 스펙추론 부담이 커서 에이전트 난이도는 그보다 높다.

## 골드패치 분석
- **파일/함수**: `seaborn/_core/plot.py`의 `Plotter._finalize_figure`. 추가로 모듈 상단 import를 `from seaborn._core.scales import Scale` → `Scale, Nominal`로 호이스트하고, `_setup_scales` 안의 지역 `from ... import Nominal`을 제거(중복 해소).
- **근본원인**: `Plot` 그리기 파이프라인이 `Nominal` 스케일에 대해 categorical 축 관례(±0.5 한계 / 그리드 off / y 반전)를 적용하는 코드가 **아예 없었다**. matplotlib 기본 margin·grid·축방향이 그대로 적용되어 categorical 플롯과 외형이 달랐다.
- **수정요지**: 서브플롯×축(`for axis in "xy"`) 루프에서 `axis_obj = getattr(ax, f"{axis}axis")`를 먼저 잡고, 해당 축의 스케일이 `isinstance(self._scales.get(axis_key), Nominal)`이면: `axis_obj.grid(False, which="both")`로 그리드를 끄고, 사용자 한계가 없을 때(`axis_key not in p._limits`)만 `nticks = len(axis_obj.get_major_ticks())`로 `lo, hi = -.5, nticks-.5`를 계산하되 y축이면 `lo, hi = hi, lo`로 반전한 뒤 `set_{axis}lim(lo, hi, auto=None)`을 호출. `auto=None`으로 autoscale 재활성을 막는다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개)**: `test_nominal_x_axis_tweaks`는 `Plot(x=["a","b","c"], y=[1,2,3])`에서 `get_xlim() == (-.5, 2.5)`(틱 3개 → ±0.5)와 그리드선 전부 비가시를 단언하고, 사용자가 `limit(x=(-1,2.1))`를 주면 그 한계가 그대로 유지됨을 단언한다. `test_nominal_y_axis_tweaks`는 y축 버전으로 **반전된** `get_ylim() == (2.5, -.5)`를 단언한다.
- **픽스 증명**: 두 테스트가 각각 (1)±0.5 한계, (2)그리드 off, (3)y 반전, (4)사용자 limit 존중 분기를 모두 커버 → 골드패치의 네 동작과 1:1 대응.
- **overfit·regression 관점**: FAIL_TO_PASS가 x/y 양 축 + limit 유무까지 갈라 검증하므로 special-case 통과는 어렵다(overfit-risk 낮음). 다만 `if axis_key not in p._limits` 가드를 누락하면 사용자 limit 분기가 깨지고, 광범위한 94개 P2P(`TestPlotting::test_limits`, `TestFacetInterface`, `TestPairInterface::test_limits` 등)가 인접 축 동작을 지켜야 하므로 regression-trap이 실재한다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 `Plotter._finalize_figure`를 명시 → 해당 함수의 서브플롯/축 루프(`for axis in "xy"`, `axis_key = sub[axis]`)를 찾고, 한계 설정이 이미 `p._limits` 기반으로 이뤄지는 곳 바로 뒤를 삽입점으로 택한다.
2. **픽스(올바른 일반화)**: 축 스케일이 `Nominal`인지 `self._scales.get(axis_key)`로 판정(추론된 Nominal 포함됨)하고, 세 동작을 적용. 한계를 하드코딩 `(-.5, n-.5)` 대신 `len(axis_obj.get_major_ticks())`로 동적 산출해 카테고리 수에 일반화. y축은 `lo, hi` swap으로 반전. 그리드는 `which="both"`로 major/minor 모두 끔.
3. **regression 안전**: 사용자 명시 limit을 존중하려면 `axis_key not in p._limits`일 때만 한계를 덮어쓴다 — 이 가드가 `test_limits` 계열 P2P를 보호한다. `auto=None`은 이후 autoscale이 한계를 되돌리지 않게 한다.
4. **함정 회피**: 오라클 없는 에이전트는 (a) y축 반전을 빠뜨려 `(−.5, 2.5)`로 두거나, (b) 사용자 limit 가드를 빼서 `limit()`을 무력화하거나, (c) 그리드를 `which="major"`로만 꺼 minor 그리드를 남기기 쉽다. 이슈 본문 1·3번 항목(±0.5, y 반전)과 2번(그리드)을 **categorical 관례 그대로** 복원하는 것이 핵심 회피책이다. 이슈가 언급한 "invisible artist + sticky edges" 해킹은 실제 채택되지 않았으므로 그 경로로 빠지지 말 것.
