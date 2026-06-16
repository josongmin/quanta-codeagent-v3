---
instance_id: matplotlib__matplotlib-20826
repo: matplotlib/matplotlib
base_commit: a0d2e399729d36499a1924e5ca5bc067c8396810
version: "3.4"
difficulty: "15 min - 1 hour"
created_at: "2021-08-11T06:23:50Z"
fail_to_pass: 1
pass_to_pass: 673
gold_files: [lib/matplotlib/axis.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
공유 축(`plt.subplots(2, 2, sharex=True, sharey=True)`)에서 `ax.clear()`를 호출하면 숨겨져 있어야 할 tick·tick label이 다시 나타나고, 각 subplot 위/오른쪽에 불필요한 tick이 생긴다. 3.4.1→3.4.2 사이의 회귀이며, 원인은 PR #20161에서 tick keyword dict를 통째로 비우면서 "어느 변을 보일지" 설정이 함께 날아가는 것. 이슈에 재현 코드와 두 버전 스크린샷이 첨부되어 있다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 직접 심볼을 지목하진 않지만, hints가 회귀 커밋 diff(L810-R823)와 "Clearing the tick keyword dictionaries drops the settings for which sides the ticks should be visible"를 명시해 `Axis.clear`/`_reset_*_tick_kw`로 좁은 단일파일 수렴이 거의 자명하다.
- **S2 (Constraint-Reasoning) (+S6)**: 고칠 지점은 명확하나, "전체 dict를 `clear()`하면 side-visibility(`tick1On/tick2On/label1On/label2On`)까지 날아간다"는 불변식을 추론해야 한다. 픽스는 한 줄 가드 추가가 아니라 `_reset_*_tick_kw()` 호출을 제거하고 `gridOn`만 in-place 갱신하는 작은 호출구조 변경(S6)이다.
- **K-Domain**: matplotlib tick keyword(`_major_tick_kw`)와 `axes.grid`/`axes.grid.which` rcParams, 그리고 shared-axis hiding이 이 dict에 side-flag로 저장된다는 내부 모델을 알아야 올바른 픽스를 합성할 수 있다.
- **primary = T-ConstraintReason**: 위치는 좁게 잡히지만, 무엇을 보존하고 무엇만 갱신해야 하는지 의미적 불변식 추론이 본질이다.

## 난이도 티어
**T4 (약간 어려움)**. 구조 피처: 1파일·`Axis.clear` 6줄 변경(localize 직접성 높음), `has-repro`(해결률 강한 easiness 신호)지만, P2P 673건이라는 광범위한 `regression-trap`이 티어를 끌어올린다. tick/grid/shared-axis 동작 다수가 같은 dict와 `reset_ticks`에 의존하므로 잘못 고치면 grid 표시·retick·기본 tick 동작이 줄줄이 깨진다. 공식 라벨 "15분~1시간"과 정합적이나, "어디를 고치나"보다 "side-flag 보존 vs gridOn 재계산"이라는 의미 추론과 넓은 회귀면 때문에 T3가 아닌 T4로 둔다.

## 골드패치 분석
- **파일·함수**: `lib/matplotlib/axis.py` 의 `Axis.clear()`.
- **근본원인**: `clear()`가 `self._reset_major_tick_kw()` / `self._reset_minor_tick_kw()`를 호출하는데, 이 헬퍼들은 `self._major_tick_kw.clear()`(dict 전체 비움) 후 `gridOn`만 다시 채운다. Axes가 shared-axis 숨김을 위해 dict에 넣어둔 side-visibility 플래그(`tick1On/tick2On/label1On/label2On` 등)가 이때 소실되어, 이어지는 `reset_ticks()`가 기본값(모든 변 표시)으로 tick을 재생성한다. (#20161에서 rcParam 적용이 `Axes.__init__` 끝으로 옮겨지며 `clear` 경로가 더 이상 이를 복원하지 않게 된 것이 회귀의 트리거.)
- **수정요지**: `clear()`에서 두 `_reset_*_tick_kw()` 호출을 제거하고, dict를 비우지 않은 채 `_major_tick_kw['gridOn']`·`_minor_tick_kw['gridOn']`만 `axes.grid`/`axes.grid.which`로 in-place 재계산한다. 나머지 키(side-flag)는 보존된다.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_shared_axes_clear[png]` 1건. `check_figures_equal`로 ref(2×2 sharex/sharey에 그냥 plot)와 test(각 ax를 `clear()` 후 plot)의 렌더 결과 동일성을 비교한다. 픽스 전에는 `clear()`가 side-flag를 날려 test 그림에 숨겨졌어야 할 tick label이 나타나 두 그림이 불일치 → 실패. 픽스 후 side-flag 보존으로 픽셀 동일 → 통과.
- **overfit 관점**: 이미지 동치 비교는 단일 케이스지만 "보이는 모든 tick/label"을 한꺼번에 검사하므로 special-case 회피가 어렵다(`overfit-risk` 낮음). 다만 grid on/off 조합까지 직접 단언하진 않아 얇은 편.
- **regression 관점**: P2P 673건이 `gridOn` 재계산이 여전히 올바른지, `reset_ticks`/`set_tick_params`/grid 동작이 안 깨지는지를 보장. in-place `gridOn` 갱신으로 grid 동작 동치를 유지한 것이 핵심.

## 모범답안 (오라클 기반)
1. **localize**: "3.4.1→3.4.2 회귀 + `ax.clear()`가 shared-axis hiding 해제" → blame/hints가 #20161과 `Axis.clear`를 지목. `clear()`가 부르는 `_reset_major_tick_kw`/`_reset_minor_tick_kw`가 `_major_tick_kw.clear()`로 dict를 통째로 비우는 것을 확인.
2. **픽스(올바른 일반화 이유)**: 문제는 "dict 전체를 reset"하는 과잉 동작이다. `gridOn`은 rcParams에서 재계산해야 맞지만 side-visibility 플래그는 Axes가 설정한 상태이므로 보존돼야 한다. 따라서 reset 호출을 빼고 `gridOn`만 in-place 갱신 → shared든 아니든 모든 `clear()` 경로에 일반적으로 옳다(특정 subplot 배치에 특화된 가드가 아님).
3. **regression 안전**: `gridOn` 계산식을 `_reset_*_tick_kw`와 동일하게 유지해 grid 표시 동작 동치를 보장하고, dict의 다른 키를 건드리지 않아 `reset_ticks`·`set_tick_params`·retick 경로(P2P 673)가 영향받지 않게 한다.
4. **함정 회피**: (a) `_reset_major_tick_kw` 자체를 고치면 `Axes.__init__`의 정상 초기화까지 깨진다 — 고쳐야 할 곳은 호출처인 `clear`다. (b) side-flag를 명시적으로 재설정하려 들면 shared-axis 레이아웃 의존 로직을 재구현하게 돼 overfit/추가 회귀를 부른다 — "비우지 않고 gridOn만 갱신"이 최소·정답. (c) `gridOn` 갱신을 빼먹으면 grid 관련 P2P가 깨진다.
