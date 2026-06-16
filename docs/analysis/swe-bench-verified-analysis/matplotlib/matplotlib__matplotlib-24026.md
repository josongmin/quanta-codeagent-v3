---
instance_id: matplotlib__matplotlib-24026
repo: matplotlib/matplotlib
base_commit: 14c96b510ebeba40f573e512299b1976f35b620e
version: "3.6"
difficulty: "15 min - 1 hour"
created_at: 2022-09-28T02:45:01Z
fail_to_pass: 2
pass_to_pass: 764
gold_files: [lib/matplotlib/stackplot.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`ax.stackplot(..., colors=['C0','C1','C2'])`처럼 `CN` 색상 별칭을 넘기면 `ValueError: Cannot put cycle reference ('C2') in prop_cycler`로 죽는다. 원인은 stackplot이 사용자 colors를 `axes.set_prop_cycle(color=colors)`로 Axes의 cycler에 밀어넣는데, prop_cycle 검증기(`validate_color_for_prop_cycle`)가 `CN` 참조를 금지하기 때문이다. 게다가 이 방식은 stackplot이 호출한 Axes의 컬러 cycler 상태까지 영구 변경하는 부작용을 낳는다(이슈 제목 "should not change Axes cycler"). 사용자는 plot/Rectangle처럼 stackplot에서도 `CN`을 쓰고 컬러를 동기화하고 싶어한다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 스택트레이스가 `stackplot.py:73 axes.set_prop_cycle(color=colors)`를 직접 지목. grep 한 방으로 결함 라인 도달. 탐색 노력 0.
- **S2 (Constraint-Reasoning)**: 고칠 지점은 자명하나 "set_prop_cycle을 지우면 됨"이 아니라, colors가 주어졌을 때와 안 주어졌을 때 두 경로를 **동일한 색 소비 의미론**으로 합성해야 한다. `itertools.cycle(colors)`(순환 소비) vs `axes._get_lines.get_next_color()` 제너레이터(cycler 위임)라는 올바른 식을 추론해야 함. 후보 난사가 아니라 불변식 추론.
- **K-Domain**: matplotlib 내부의 `_get_lines.get_next_color()`(Axes 컬러 cycler 진행 API)와 `set_prop_cycle`/prop_cycle 검증 계약을 알아야 한다. 일반 파이썬 지식만으론 "왜 set_prop_cycle이 CN을 거부하는지"를 못 짚음.
- **primary = T-ConstraintReason**: 위치(L0)는 공짜지만 올바른 픽스가 단순 가드 추가/상수 변경(S1)이 아니라 두 분기를 의미보존하며 재설계하는 식 합성이라 ConstraintReason이 dominant. S2가 핵심 난점이라 APR 관점에서 SemFix류 의미수리에 해당.

## 난이도 티어
**T3 (중간).** 구조적 피처: 1파일(`stackplot.py`) 단일함수, gold +6/-5줄 수준의 작은 변경, has-repro(네이티브 스택트레이스 완비)로 localize는 사실상 무료. 그러나 단순 한 줄 가드가 아니라 colors-있음/없음 두 경로를 cycle 제너레이터로 통합하고, fill_between 루프 안의 `get_next_color()` 호출 2곳을 `next(colors)`로 치환하는 **소규모 의미 재배선**이 필요해 S1을 넘어선다. P2P 764개로 regression-trap이 존재(stackplot 기본 동작·기존 컬러 시퀀스를 안 깨야 함)하나 변경이 국소적이라 T4까지는 안 감. 공식 라벨 "15분-1시간"과 정합 — has-repro·단일파일이라 T1/T2로 내려갈 듯하지만, 색 소비 의미론 추론과 Axes-cycler 부작용 제거라는 정확성 요구가 T3로 끌어올린다.

## 골드패치 분석
- **파일·함수**: `lib/matplotlib/stackplot.py`의 `stackplot()` 하나.
- **근본원인**: 사용자 colors를 `axes.set_prop_cycle(color=colors)`로 prop_cycle에 주입한 것. (1) prop_cycle 검증기가 `CN` 참조를 거부 → ValueError. (2) Axes의 컬러 cycler 상태를 영구 변경 → 같은 Axes의 후속 plot 색이 오염되는 부작용.
- **수정요지**:
  1. `import itertools` 추가.
  2. `set_prop_cycle` 호출을 제거하고, colors 유무에 따라 단일 이터레이터로 정규화: colors가 있으면 `colors = itertools.cycle(colors)`(주어진 색을 순환), 없으면 `colors = (axes._get_lines.get_next_color() for _ in y)`(Axes cycler에 위임).
  3. fill_between 루프에서 기존의 줄별 `color = axes._get_lines.get_next_color()` 두 군데를 삭제하고 `facecolor=next(colors)`로 통일.

  핵심: 이제 두 경로 모두 `next(colors)`라는 동일 인터페이스로 소비되며, prop_cycle을 우회하므로 `CN` 검증 거부와 Axes-cycler 부작용이 함께 사라진다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2)**: `test_stackplot[png]`, `test_stackplot[pdf]`. 기존 labeled-data 테스트케이스에 `colors=["C0","C1","C2"]` 인자를 추가. base에서는 이 호출이 `set_prop_cycle`에서 ValueError로 즉사 → FAIL. 패치 후 `itertools.cycle(["C0","C1","C2"])` 경로로 정상 렌더 → 이미지 비교 통과(PASS).
- **픽스 증명**: 테스트가 정확히 회귀 트리거(`CN` colors)를 친다. png+pdf 두 백엔드 모두 통과해야 하므로 렌더 결과까지 검증.
- **overfit/regression 관점**: F2P가 2개(같은 케이스 2백엔드)로 얇아 보이나, 이미지 비교 테스트라 색 매핑이 정확해야만 통과 → special-case 우회 어려움. colors가 데이터 수보다 적을 때의 `itertools.cycle` 순환·colors 미지정 시 cycler 위임은 직접 검증되진 않지만(여기서 overfit-risk를 표기하지 않은 이유는 이미지 비교의 강한 변별력), 광범위 P2P(764)로 stackplot 무인자 기본 경로가 보호된다.

## 모범답안 (오라클 기반)
1. **localize**: 스택트레이스 마지막 사용자 프레임 `stackplot.py:73 axes.set_prop_cycle(color=colors)`로 직행(L0). 이슈 제목 "should not change Axes cycler"가 부작용까지 명시 → set_prop_cycle 주입이 범인임이 이중 확인.
2. **픽스(올바른 일반화)**: set_prop_cycle을 쓰지 말고 colors를 로컬 이터레이터로 만들어 소비. colors 있으면 `itertools.cycle`(개수 부족 시 순환·`CN` 허용), 없으면 `_get_lines.get_next_color()` 제너레이터로 기존 cycler 동작 보존. 루프 내 색 획득을 `next(colors)`로 단일화. prop_cycle 검증을 우회하므로 `CN` 거부와 Axes 상태 오염이 동시에 해소 — 증상 하나가 아니라 두 결함의 공통 원인을 제거하는 일반화.
3. **regression 안전**: colors 미지정 시 `_get_lines.get_next_color()`를 줄마다 호출하던 기존 동작을 제너레이터로 그대로 재현해야 함 — 기본 stackplot 색 시퀀스 P2P가 안 깨짐. label은 여전히 `next(labels, None)`로 분리 소비.
4. **함정 회피**: 단순히 `set_prop_cycle` 호출을 try/except로 감싸거나 `CN`을 색으로 변환해 다시 prop_cycle에 넣는 식(S1 가드)으로 가면, "Axes cycler를 바꾸지 말라"는 두 번째 요구를 못 채워 부작용이 남고 의미상 틀린 부분픽스가 된다. 또 colors-없음 경로를 빠뜨리고 colors-있음만 고치면 무인자 P2P가 깨진다. 정답은 두 경로를 `next(colors)`로 통합해 부작용 자체를 제거하는 것.
