---
instance_id: matplotlib__matplotlib-22871
repo: matplotlib/matplotlib
base_commit: a7b7260bf06c20d408215d95ce20a1a01c12e5b1
version: "3.5"
difficulty: "15 min - 1 hour"
created_at: 2022-04-21T13:10:50Z
fail_to_pass: 1
pass_to_pass: 88
gold_files: [lib/matplotlib/dates.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약

`ConciseDateFormatter`로 1년 미만 구간을 그릴 때 x축에 1월(January)이 포함되지 않으면 연도("2021")가 offset에도, tick에도 어디에도 표시되지 않는다. 사용자는 우측 하단 offset에 연도가 나오기를 기대한다. 동일 증상처럼 보이는 #21670(#21785에서 수정)과는 다른 별개 케이스로, 월(month)이 변하지만 그 안에 1월이 없는 경우에 특정된 버그다.

## 유형 (정형화)

- **L (Localization) = L1**: 증상이 `ConciseDateFormatter`로 직접 지목되고, offset 표시 로직은 `dates.py`의 `ConciseDateFormatter.format_ticks` 내 단일 루프로 빠르게 수렴한다. grep 한 방은 아니지만 좁은 단일파일 탐색.
- **S (Repair Strategy) = S2 (Constraint-Reasoning)**: 고칠 지점(`show_offset = False`로 가는 조건)은 명확하나, "어떤 경우에 offset을 끄는 게 옳은가"의 **올바른 조건식을 추론으로 합성**해야 한다. `level < 2`라는 기존 조건이 과도하게 넓다는 걸 깨닫고, 거기에 "unique 값에 1(=1월/1일)이 포함될 때만"이라는 불변식을 더해야 한다. 후보를 마구 시도하는 게 아니라 의미를 따져 푸는 결함.
- **K (Knowledge) = K-Domain**: tick 레벨(0:year … 6:micro), `timetuple()[:6]` 분해, zerovals/offset 표시 규약 같은 matplotlib date-formatting 내부 지식이 병목.
- **primary_type = T-ConstraintReason**: 위치는 잡히나 올바른 가드 조건식을 도메인 불변식으로 추론·합성하는 게 본질.

## 난이도 티어

**T3 (중간)**. 구조적 피처: 1파일·실질 +4/-2줄 단일 헌크, has-repro(완전한 재현코드 존재)로 localize 직접성은 높다. 그러나 픽스는 "year가 tick에 나타나면 offset에서 빼도 된다"는 의미를 역으로 추론해 `np.any(unique == 1)` 가드를 합성해야 하므로 S1 기계적 픽스가 아니다. P2P 87개 중 `test_concise_formatter_show_offset` 파라미터 7종이 인접 동작이라 약한 regression-trap이 있다. 공식 라벨 "15 min - 1 hour"와 정합 — has-repro·소규모지만 조건 추론이 있어 T1/T2까지 내려가지 않고 T3.

## 골드패치 분석

- **파일·함수**: `lib/matplotlib/dates.py` → `ConciseDateFormatter.format_ticks`.
- **근본원인**: tick 라벨 레벨을 정하는 루프(`for level in range(5, -1, -1)`)에서, 어떤 레벨의 값이 두 개 이상으로 변하면 그 레벨에서 라벨링하고, `level < 2`(year=0 또는 month=1)이면 `show_offset = False`로 offset(연도)을 꺼버렸다. 문제는 month가 변하지만(예: 2월~8월) 그 안에 1월이 전혀 없는 구간에선 tick 어디에도 연도가 안 나오는데도 offset까지 꺼져, 연도가 완전히 사라진다.
- **수정요지**: `unique = np.unique(tickdate[:, level])`를 변수로 뽑고, offset 억제 조건을 `if level < 2`에서 `if level < 2 and np.any(unique == 1)`로 좁혔다. 즉 해당 레벨에 1(=1월 또는 1일 경계, year가 tick에 노출되는 신호)이 실제로 포함될 때만 offset을 끈다. 1월이 없으면 offset에 연도를 유지한다.

## 검증 (test_patch)

- **FAIL_TO_PASS** `test_offset_changes`: 기존 케이스(3주 → `'1997-Jan'`, 520주 → `''`) 사이에 **신규 구간**을 끼웠다 — `d1+7주 ~ d1+30주`(약 5.7개월, 1월 미포함)에서 `formatter.get_offset() == '1997'`을 단언. 패치 전에는 month 레벨이 변하므로 `level < 2`만으로 offset이 꺼져 `''`가 나왔고, 패치 후엔 `unique`에 month==1이 없어 offset이 유지되어 `'1997'`이 나온다. 픽스가 정확히 이 분기를 통과시킴이 증명된다.
- **overfit 관점**: FAIL_TO_PASS가 단일 테스트 1개라 얇아 보이나, 추가 단언은 "1월 미포함" 정확히 그 빈틈을 찌른다. `np.any(unique == 1)` 가드는 특정 주차에 하드코딩된 게 아니라 도메인 불변식(1월/1일 경계 노출)이라 일반화가 올바르다.
- **regression 관점**: P2P의 `test_concise_formatter_show_offset[...]` 7케이스가 offset이 켜지고 꺼지는 경계를 모두 검사하므로, 가드를 좁히면서 기존 "1월 포함 → offset 끔" 동작이 유지됨이 회귀로 보장된다.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈가 `ConciseDateFormatter`와 "offset에 연도 미표시"를 명시 → `dates.py`에서 `show_offset`을 다루는 `format_ticks`로 직행. 레벨 선택 루프에서 `show_offset = False`로 가는 유일한 분기 `if level < 2`가 용의자.
2. **픽스와 일반화 근거**: offset을 끄는 건 "연도가 tick에 이미 나오니 중복 제거" 의도다. month 레벨이 변해도 그 범위에 1월이 없으면 tick에 연도가 안 나오므로 offset을 끄면 안 된다. 따라서 `np.any(unique == 1)`(1월/1일 경계 존재)일 때만 끄도록 조건을 좁히는 게 의도(중복 제거)를 정확히 보존하는 일반화다. 특정 입력에 맞춘 게 아니다.
3. **regression 안전**: 1월을 포함하는 기존 동작(`test_concise_formatter_show_offset`의 Jan 케이스, `'1997-Jan'` 등)은 `np.any(unique == 1)`이 True라 그대로 offset이 꺼져 깨지지 않는다. 520주(다년) 케이스는 year 레벨(level 0)에서 변하고 거기엔 항상 1이 포함 가능하나 offset은 빈 문자열 규약을 따라 유지.
4. **함정 회피**: 오라클 없는 에이전트는 (a) `level < 2` 조건을 통째로 제거해 1월 포함 시에도 offset이 켜지는 과교정 회귀를 내거나, (b) `level == 1`만 별도 처리하다 day 레벨(1일 경계)을 놓치기 쉽다. 핵심은 "끄는 조건을 없애는 게 아니라 1 포함 여부로 좁힌다"는 미세 조정 — `np.unique`를 한 번만 계산해 재사용하고 `np.any(unique == 1)`로 level 1/0 양쪽(월·일 경계)을 한 번에 커버하는 게 정답.
