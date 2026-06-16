---
instance_id: matplotlib__matplotlib-25960
repo: matplotlib/matplotlib
base_commit: 1d0d255b79e84dfc9f2123c5eb85a842d342f72b
version: "3.7"
difficulty: "15 min - 1 hour"
created_at: 2023-05-23T21:58:53Z
fail_to_pass: 1
pass_to_pass: 137
gold_files: [lib/matplotlib/figure.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [has-repro, regression-trap, cross-file-dep]
---

## 문제 요약

`Figure.subfigures(nrows, ncols, wspace=..., hspace=...)`에 `wspace`/`hspace`를 넘겨도 아무 효과가 없다 — 값과 무관하게 동일한 figure가 그려진다. 이슈는 재현코드와 facecolor 비교 이미지까지 제공한다. hint에서 "constrained layout일 때는 동작한다", "이건 깨진 게 아니라 애초에 한 번도 동작한 적 없다"가 핵심 단서로, 원인은 subfigure 인스턴스화 경로가 GridSpec의 `wspace`/`hspace`를 자식 subfigure 위치 계산에 반영하지 않는 데 있다.

## 유형 (정형화)

- **L (Localization) = L1 (Traceable).** 이슈가 `Figure.subfigures`를 직접 지목하고 hint가 `figure.py`의 `_redo_transform_rel_fig`, `gridspec.py`의 `get_grid_positions`까지 링크로 짚어준다. 단일 함수 `subfigures`로 수렴하나, 픽스에 필요한 협력 심볼(`gs.get_grid_positions`, `Bbox.from_extents`, `sf._redo_transform_rel_fig`)을 찾아내는 약간의 탐색이 필요해 L0는 아니다.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S6 Design).** 고칠 위치는 명확하지만, "subfigure가 GridSpec spacing을 무시한다"를 단순 토글로 못 고친다. layout engine 부재 시 GridSpec의 `get_grid_positions`로 각 셀의 bbox를 직접 계산해 자식에 재적용하는 **올바른 기하 식을 합성**해야 한다(S2). 동시에 `GridSpec(...)` 생성에 `left=0,right=1,bottom=0,top=1`을 추가하고 사후 재배치 루프를 끼워넣는 작은 구조 변경(S6)을 동반한다.
- **K (Knowledge) = K-Domain.** matplotlib 내부의 layout engine / GridSpec / SubFigure transform 생애주기 지식이 병목. `_redo_transform_rel_fig(bbox=...)`가 SubFigure를 figure-상대 bbox로 재배치한다는 사실, layout engine이 있으면 그쪽이 spacing을 처리한다는 분기를 알아야 한다.
- **primary = T-ConstraintReason.** 위치는 잡혀 있으나 난점이 "spacing을 반영한 자식 bbox를 어떻게 일반적으로 계산하느냐"는 추론에 있다. APR 관점에서 가드 추가/상수 변경(S1)으로는 안 되고, GridSpec이 이미 제공하는 `get_grid_positions` 불변식을 빌려 식을 세우는 semantic repair여서 S2 dominant.

## 난이도 티어

**T4 (약간 어려움).** 구조적 피처: 단일 파일(`figure.py`) 단일 함수지만 (1) layout engine 유무 분기를 정확히 골라야 하고(`get_layout_engine() is None`), (2) cross-symbol 의존(`gs.get_grid_positions` + `Bbox.from_extents` + `_redo_transform_rel_fig`)을 조율해야 하며, (3) PASS_TO_PASS 134개에 subfigure/mosaic/savefig 회귀군이 두껍게 깔려 있어 regression-trap이 강하다. has-repro로 localize는 쉬워 T5까지는 아니지만, 픽스의 기하 추론과 기존 `test_subfigure_scatter_size` 같은 "subfigure가 wspace를 무시해야 정상"인 테스트와의 양립성 때문에 T2/T3보다 위. 공식 라벨 "15 min - 1 hour"와 정합 — 개발자 시간 기준 중급.

## 골드패치 분석

- **파일·함수:** `lib/matplotlib/figure.py`의 `FigureBase.subfigures`. (docstring 1문장 + 로직 1블록)
- **근본원인:** `subfigures`가 GridSpec을 `wspace`/`hspace`로 만들긴 하지만, 자식 SubFigure는 생성 시 GridSpec spacing을 좌표에 반영하지 않는다. layout engine이 없으면 spacing을 적용해 줄 주체가 없어 "한 번도 동작한 적 없는" 상태였다.
- **수정요지:** (1) `GridSpec(...)` 호출에 `left=0, right=1, bottom=0, top=1`을 추가해 그리드가 figure 전체를 채우게 고정. (2) 자식 생성 루프 뒤에, `get_layout_engine() is None and (wspace is not None or hspace is not None)`일 때만 `gs.get_grid_positions(self)`로 `bottoms, tops, lefts, rights`를 받아 각 셀의 `Bbox.from_extents(left, bottom, right, top)`를 만들어 해당 SubFigure에 `sf._redo_transform_rel_fig(bbox=bbox)`로 재배치. layout engine이 있으면 기존 경로가 spacing을 처리하므로 건드리지 않는다. docstring도 "rcParams(constrained layout 시) 또는 layout engine 없으면 0"으로 정정.

## 검증 (test_patch)

- **FAIL_TO_PASS (1):** `test_subfigures_wspace_hspace` — `plt.figure().subfigures(2, 3, hspace=0.5, wspace=1/6.)`로 2x3 subfigure를 만들고 640x480 figure에서 각 subfigure의 `bbox.min`/`bbox.max`를 `assert_allclose`로 검사. 예: `sub_figs[0,0]`가 `[0, h*0.6]`~`[w*0.3, h]`, `sub_figs[1,2]`가 `[w*0.7, 0]`~`[w, h*0.4]`. 즉 spacing이 실제 좌표에 반영됐는지를 수치로 못 박는다.
- **픽스 증명:** 픽스 전엔 spacing 무시로 6개 셀이 균등(간격 0) 배치돼 좌표가 어긋나 fail. 픽스 후 `get_grid_positions`가 `wspace=1/6`(가로 간격), `hspace=0.5`(세로 간격)를 반영한 셀 경계를 산출하고 `_redo_transform_rel_fig`가 그 bbox로 재배치하므로 6셀 좌표가 정확히 일치.
- **overfit/regression:** FAIL_TO_PASS가 1개뿐이라 overfit-risk는 형식적으로 존재하나, 6개 셀 × min/max를 모두 검사해 단순 special-case로는 통과 불가 — 일반 기하식을 강제한다. regression 관점에서 흔히 `test_subfigure_scatter_size`를 핵심 가드로 오해하기 쉬우나, 이 테스트는 `subfigures()`를 호출하지 않고 `fig.add_gridspec(1, 2)` + `fig.add_subfigure(gs[0])`를 쓴다(test_figure.py L1427-1439). 골드패치는 `subfigures()` 본문만 수정하므로 이 테스트는 None-체크와 무관하게 수정된 코드경로 자체를 안 타서 trivially 보존될 뿐, None-체크가 보호하는 가드가 아니다. 실제로 `subfigures()`를 `wspace` 인자와 함께 호출하는 P2P는 `test_subfigure_double`(wspace=0.07, L1336)·`test_subfigure_ticks`(wspace=0.01, L1403)인데, 둘 다 constrained layout이라 `wspace is not None`임에도 `get_layout_engine() is None`이 False라 새 분기를 타지 않는다. 즉 이들을 지키는 실제 linchpin은 None-체크가 아니라 `get_layout_engine() is None` 가드다 — 새 redo-transform 분기를 실제로 타는 회귀 테스트는 없고 신규 FAIL_TO_PASS만 그 경로를 exercise한다.

## 모범답안 (오라클 기반)

1. **localize:** 이슈의 "subfigures wspace/hspace not working" + "constrained layout에선 동작" hint → `Figure.subfigures`로 직행. layout engine 분기가 핵심임을 hint가 알려줌. spacing을 figure-상대 좌표로 바꿔주는 주체가 없음을 확인하고, GridSpec이 이미 `get_grid_positions`로 셀 경계를 주는 것과 SubFigure가 `_redo_transform_rel_fig(bbox=)`로 재배치됨을 연결.
2. **픽스와 일반화:** layout engine이 **없고** spacing이 명시됐을 때만, GridSpec이 산출한 셀 bbox를 자식에 직접 재적용. layout engine이 spacing을 책임지는 정상 경로는 손대지 않음. `get_grid_positions`를 재사용하므로 wspace/hspace/width_ratios/height_ratios 임의 조합에 일반화 — 테스트 6셀 좌표를 외우는 게 아니라 GridSpec 불변식을 빌린 게 올바른 일반화의 증거. `left=0..top=1` 고정은 그리드가 figure 전체를 채우게 해 좌표계를 정합화.
3. **regression 안전:** P2P 134개 중 subfigure/mosaic/savefig군을 깨면 안 됨. `subfigures()`를 `wspace` 인자와 함께 호출하는 실제 P2P는 `test_subfigure_double`(wspace=0.07)·`test_subfigure_ticks`(wspace=0.01)인데, 둘 다 constrained layout이라 `wspace is not None`임에도 `get_layout_engine() is None`이 False가 되어 새 분기를 타지 않는다 — 이들을 지키는 실제 linchpin 가드는 None-체크가 아니라 `get_layout_engine() is None`이다. None-체크는 `wspace`/`hspace`가 `None`(default)인 호출(constrained layout 없이 spacing 미지정)에서만 새 분기를 막아 기존 동작을 byte-identical 보존하는 역할. (`test_subfigure_scatter_size`는 `subfigures()`를 아예 호출하지 않아 코드경로 밖이라 trivially 보존.)
4. **함정 회피:** 오라클 없는 에이전트가 빠지기 쉬운 함정 — (a) "default wspace를 0으로 바꾸자"는 hint 토론에 휩쓸려 GridSpec 기본값을 건드리면 subplot/scatter_size 회귀. (b) layout engine 유무 분기를 빼고 항상 재배치하면 constrained layout 케이스 이중적용으로 깨짐. (c) spacing 기하를 직접 손계산하려다 width_ratios/height_ratios 비균등 케이스를 틀림 — `gs.get_grid_positions` 재사용이 정답. (d) None-체크를 빠뜨려 기존 "subfigure는 wspace 무시" 계약을 깨는 것. 회피법: spacing 명시 + no-layout-engine으로 분기를 좁히고, 좌표는 GridSpec에서 빌려온다.
