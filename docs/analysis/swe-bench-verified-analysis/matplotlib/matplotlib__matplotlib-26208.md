---
instance_id: matplotlib__matplotlib-26208
repo: matplotlib/matplotlib
base_commit: f0f133943d3e4f1e2e665291fe1c8f658a84cc09
version: "3.7"
difficulty: "<15 min fix"
created_at: 2023-06-28T21:31:50Z
fail_to_pass: 2
pass_to_pass: 813
gold_files: [lib/matplotlib/axes/_base.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L2
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro, underspecified]
---

## 문제 요약
twinx로 두 번째 y축(ax2)을 만든 뒤, ax1이 stackplot(범주형 문자열 x)이고 ax2에 plot을 하면 ax1의 `dataLim.intervaly`가 ±inf로 망가진다. 3.4.0 이후 회귀이며, plot/stackplot 순서를 바꾸거나 twin을 먼저 만들면 재현되지 않는다. 핵심 신호: 문자열 카테고리 → unit(단위/카테고리) 변환 머신이 개입할 때만 발생하는 엣지케이스.

## 유형 (정형화)
- **L (Localization) = L2(Diffuse).** 이슈는 `twinx`/`dataLim`/`inf`를 가리키지만 정작 고칠 곳은 unit 변환 경로다. 증상(dataLim=inf)이 나타나는 곳과 원인(twin axis가 단위를 안 물려받음)이 떨어져 있어, x축 공유 + unit converter 데이터플로우를 cross-module로 추적해야 위치가 잡힌다. grep 한 방이 아니다.
- **S (Repair Strategy) = S2(Constraint-Reasoning).** 후보를 막 던져 통과시키는 게 아니라, "twin 축은 원본 축과 단위 컨텍스트를 공유해야 한다"는 불변식을 추론으로 합성해 정확히 두 줄(`ax2.xaxis.units = self.xaxis.units`)을 넣는다. 고칠 함수(`twinx`/`twiny`)는 좁지만 올바른 식은 도메인 불변식에서 도출된다.
- **K (Knowledge) = K-Domain.** matplotlib 내부 unit machinery(axis.units / converter / 카테고리 unit) 지식이 병목. 일반 파이썬 추론으로는 왜 두 번째 plot이 첫 축 dataLim을 망가뜨리는지 설명 못 한다.
- **primary_type = T-ConstraintReason.** 위치는 결국 좁은 함수지만(twinx/twiny), 진짜 난점은 "어떤 상태를 공유시켜야 하는가"라는 의미적 조건 합성이라 DirectMap(가드/상수)이 아니라 ConstraintReason이 맞다.

## 난이도 티어
**T4 (약간 어려움).** 구조 피처:
- 파일 1개 / 헌크 2개 / 순수 추가 2줄 — patch scope는 작다(T1~T2 신호).
- 그러나 localize 직접성이 낮다(L2): 증상≠원인. 공식 라벨 `<15 min fix`는 *원인을 아는 코어 개발자의 구현 시간*이며(hints에 "PR incoming"), 에이전트 관점의 *원인 발견* 비용은 반영 안 됨.
- has-repro 있음(강한 easiness 신호)이지만 repro는 증상만 보여주고 unit 경로로 안내하지 않는다.
- P2P 813개 + 전역 PTP 5만 규모 → twinx/twiny는 광범위하게 의존되는 핵심 API라 regression-trap이 실재. 단위를 강제로 물려주면 단위 미사용 축의 기존 동작을 깨선 안 된다.
- underspecified: 이슈는 "버그 change to inf"만 말하고 의도된 동작을 unit 계약으로 명시하지 않음.
=> 작은 패치지만 L2 진단 + 도메인 지식 + 넓은 P2P trap이 결합해 T2가 아니라 T4로 민다.

## 골드패치 분석
- **파일/함수:** `lib/matplotlib/axes/_base.py`의 `twinx` / `twiny`.
- **근본원인:** `twinx`는 `_make_twin_axes(sharex=self)`로 x축을 공유하는 ax2를 만들지만, `ax2.xaxis.units`를 설정하지 않아 None으로 남는다. 이후 ax2에 plot하면 단위 머신이 다음 체인을 탄다: ax2.plot → category converter의 `default_units`가 `ax2.xaxis.units is None`을 보고 `axis.set_units(UnitData(data))` 호출(category.py L104-105) → `set_units`가 `_get_shared_axis()`로 sharex로 묶인 ax1.xaxis까지 전파하며 `axis.units=u; axis._update_axisinfo(); axis.callbacks.process('units')`를 발화(axis.py L1737-1743) → ax1의 `_unit_change_handler`가 `self.relim()`을 호출(_base.py L2448). **핵심 linchpin:** `relim()`은 `dataLim`을 null(±inf)로 초기화한 뒤 `_children`를 순회하며 `Line2D`/`Patch`/`AxesImage`만 재누적하고 **Collection은 의도적으로 미지원**(_base.py L2467-2468 주석 "Collections are deliberately not supported (yet)"; 루프 L2474-2481에 Collection 분기 없음). stackplot은 `PolyCollection`(=Collection)이라 relim이 ax1의 데이터를 다시 넣지 못해 `dataLim.intervaly`가 ±inf인 채로 남는다. plot 먼저/stackplot 나중이면 재현 안 되는 비대칭은, ax1 데이터가 Line2D라서 units 콜백으로 relim()이 발화돼도 relim이 Line2D를 `_update_line_limits`로 다시 누적해 dataLim을 복원하기 때문이다('단위가 이미 박혀서'가 아님 — 그 설명은 별개 케이스인 "twin을 plot 전에 생성"에 해당).
- **수정요지:** twin 생성 시 공유 축의 단위를 명시적으로 전파.
  - `twinx`: `ax2.xaxis.units = self.xaxis.units`
  - `twiny`: `ax2.yaxis.units = self.yaxis.units`
  공유 축은 원본과 동일한 unit 컨텍스트를 갖는다는 불변식을 코드로 봉인.

## 검증 (test_patch)
- **FAIL_TO_PASS (2):** `test_twin_units[x]`, `test_twin_units[y]` (parametrize). 카테고리 문자열(`a=['0','1']`, `b=['a','b']`)을 plot한 뒤 `twinx`/`twiny`로 ax2를 만들고, ax2의 해당 축 `.units is not None` **그리고** ax1의 units와 `is`(동일 객체) 동치임을 단언.
- **픽스 증명:** 패치 없으면 ax2.{x,y}axis.units가 None이라 `units is not None`이 곧장 실패. 패치 후엔 `self.{x,y}axis.units`를 그대로 대입하므로 `is` 동일성까지 성립 → 단위 공유가 객체 수준에서 보장됨을 직접 관찰.
- **overfit 관점:** 테스트가 dataLim=inf 증상을 직접 보지 않고 *원인*(units 공유)을 본다. special-case 우회(예: dataLim을 사후 복구)로는 `units is ...` 동치를 못 만족시키므로 overfit-가짜픽스를 배제. x/y 양쪽 parametrize로 대칭 커버.
- **regression 관점:** units가 None인 비단위 축에선 `self.xaxis.units`도 None이라 대입이 no-op과 동치 → 기존 813개 P2P(일반 twinx/twiny/logscale 등)는 영향 없음. 추가 2줄은 새 상태를 만들지 않고 기존 값을 미러링.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈의 "dataLim→inf, twinx, stackplot(문자열 index)" + hints("unit machinery 안 쓰면 / plot 먼저면 / twin 먼저면 동작")를 결합 → 트리거가 *unit 변환*임을 추론. 증상 함수(dataLim 갱신)가 아니라 `_base.py`의 `twinx`/`twiny`가 ax2 생성 시 공유 축 단위를 안 옮긴다는 점으로 수렴.
2. **픽스와 일반화 근거:** "x축을 공유(sharex)하면 단위 컨텍스트도 공유돼야 한다"는 불변식을 코드화 — `ax2.xaxis.units = self.xaxis.units`. converter 재추론이 ax1 상태를 덮어쓰는 근원을 제거하므로, stackplot 한정이 아니라 모든 단위/카테고리 축 조합에 일반적으로 옳다.
3. **regression 안전:** twinx/twiny는 5만+ PTP가 의존하는 hot API. 단위 미사용 축에선 None=None 대입이라 무해함을 보장해야 813 P2P 통과. 단위를 변환·강제하지 말고 *그대로 참조 복사*만 할 것.
4. **함정 회피:** (a) 증상에 낚여 dataLim 갱신 로직/stackplot에 사후 패치를 넣으면 stackplot 한정 overfit이 되고 `is` 동치 테스트를 못 넘는다. (b) `units`를 새로 계산/변환하면 비단위 축의 기존 동작을 깰 수 있다 — 반드시 원본 축 값을 그대로 미러링. (c) `twinx`만 고치고 `twiny`를 빠뜨리면 parametrize의 절반(FTP[y])이 실패하므로 대칭 수정 필수.
