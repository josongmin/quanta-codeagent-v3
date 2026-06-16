---
instance_id: matplotlib__matplotlib-14623
repo: matplotlib/matplotlib
base_commit: d65c9ca20ddf81ef91199e6d819f9d3506ef477c
version: "3.1"
difficulty: "15 min - 1 hour"
created_at: 2019-06-25T14:01:17Z
fail_to_pass: 1
pass_to_pass: 400
gold_files: [lib/matplotlib/axes/_base.py, lib/matplotlib/ticker.py, lib/mpl_toolkits/mplot3d/axes3d.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep]
---

## 문제 요약
matplotlib 3.1.0부터 log scale 축에서 `set_ylim(high, low)`처럼 한계값을 역순으로 줘서 축을 뒤집는(invert) 동작이 더 이상 작동하지 않는다. linear scale에서는 정상 반전되지만 log scale에서는 무시되고 정방향으로 그려진다. PR #13409에서 회귀가 도입되었고, 재현코드와 정확한 회귀 origin(`LogLocator.nonsingular`)이 이슈/hint에 제시되어 있다.

## 유형 (정형화)
- **L (Localization) = L1** — 이슈 본문이 "log scale 한계 반전"이라는 증상을 주고, hint가 회귀 PR(#13409)과 정확한 메서드(`nonsingular`)까지 짚어준다. 다만 실제 데이터플로우(`set_ylim` → locator의 `nonsingular` → 정렬됨)는 약간의 추적이 필요하고, 동일 결함이 2D/3D 축의 6개 메서드에 걸쳐 복제되어 있어 grep 한 방은 아니다. cross-file이라 L1 상한.
- **S (Repair Strategy) = S2 (+S6)** — 픽스 지점은 명확하나, 올바른 조건을 추론으로 합성해야 한다. log 축에서 반전을 깨는 정렬원은 `LogLocator.nonsingular`(line 2378) 내부의 무조건 `if vmin>vmax: swap`이며, 이 swap을 호출자가 `swapped` 플래그로 되돌려 사용자의 반전 의도를 복원해야 한다(`mtransforms.nonsingular`의 `increasing=False`는 순서를 보존하는 인자이지 오름차순을 강제하는 인자가 아님). 단순 가드 추가가 아니라 (a) base `Locator.nonsingular`의 시그니처 의도를 바꾸고(increasing 제거 → v0<=v1 일관화), (b) 호출자 6곳에서 `swapped` 플래그로 반전 의도를 보존·복원하는 조율된 소규모 구조 변경이라 S6 보조.
- **K (Knowledge) = K-Domain** — `Locator.nonsingular`, `limit_range_for_scale`, `viewLim.intervaly`의 역할과 `mtransforms.nonsingular`의 `increasing` 인자 의미를 알아야 한다. matplotlib 축/스케일 내부 계약 지식.
- **primary = T-ConstraintReason** — 위치는 비교적 명확하나 "왜 log에서만 깨지는가 = locator가 정렬을 강제한다"를 따져 올바른 보존 로직을 합성하는 게 본질. 기계적 가드(S1)가 아니므로 T-DirectMap이 아니다.

## 난이도 티어
**T4 (약간 어려움)**. 구조적 피처:
- 파일수 **3개**(`axes/_base.py`, `ticker.py`, `mplot3d/axes3d.py`), 함수 **7곳** 수정(`set_xlim`/`set_ylim`/`set_xlim3d`/`set_ylim3d`/`set_zlim3d` + `LogLocator.nonsingular`) — 동일 패턴 멀티사이트 복제.
- localize 직접성: 중간. hint가 origin을 줘서 L1이지만, 호출자 6곳을 빠짐없이 동기화해야 하는 조율 부담(cross-file-dep).
- repro: 있음(has-repro, easiness 신호).
- 도메인: K-Domain(스케일/locator 계약).
- P2P trap: **400개**로 매우 넓음 — log margins/autoscale/twin/shared/loglog 등 인접 한계계산 동작을 하나도 깨면 안 된다(regression-trap).
공식 라벨 "15 min - 1 hour"와 정합. 근본원인 자체는 1줄(`increasing=False` 제거)이라 T3로 내려갈 여지가 있으나, 동일 결함을 빠짐없이 복제 수정하지 않으면 3D나 x축에서 회귀가 남고 넓은 P2P를 깰 위험이 있어 T4로 유지.

## 골드패치 분석
- **`lib/matplotlib/ticker.py::Locator.nonsingular`** (BASE 클래스 `Locator` @1467, line 1523 — `LogLocator.nonsingular`가 **아님**; LogLocator의 동명 오버라이드는 line 2378에 따로 있고 골드패치가 건드리지 않는다) — `mtransforms.nonsingular(v0, v1, increasing=False, expander=.05)` 호출에서 `increasing=False` 인자를 제거. `mtransforms.nonsingular`에서 `increasing=False`는 입력 순서(역순 포함)를 **보존**하는 인자이고, 오름차순 강제는 기본값 `increasing=True`다. 따라서 이 제거는 base `Locator.nonsingular`를 "순서 보존" → "오름차순 강제(v0<=v1)"로 바꾸는 변경이다(API 노트: "Locator.nonsingular now returns v0<=v1, consistent with LogLocator/LogitLocator subclasses"). docstring도 "Modify the endpoints..." → "Expand a range..."로 의미 정정.
- **`lib/matplotlib/axes/_base.py::set_xlim`, `set_ylim`** — `nonsingular`/`limit_range_for_scale` 호출 직전에 `swapped = left > right`(또는 `bottom > top`)로 반전 의도를 캡처하고, 두 변환 후 `if swapped: left, right = right, left`로 복원. 변환 과정에서 순서가 뒤집혀도 사용자 의도를 강제로 되돌린다.
- **`lib/mpl_toolkits/mplot3d/axes3d.py::set_xlim3d`, `set_ylim3d`, `set_zlim3d`** — 2D와 동일한 `swapped` 캡처·복원 패턴을 3D 3개 메서드에 동형으로 적용.
- **근본원인**: log 축에서 invert를 깨는 정렬원은 `LogLocator.nonsingular`(line 2378, 미수정) 내부의 무조건 `if vmin > vmax: vmin, vmax = vmax, vmin` swap이다((10,1)→(1,10)). 골드패치는 이 LogLocator swap을 제거하지 않고, 호출자(`set_ylim` 등)가 `swapped` 플래그로 사용자의 반전 의도를 캡처·복원해 정렬을 되돌리는 방식으로 고친다. ticker.py의 base `Locator.nonsingular` 변경(increasing=False 제거)은 base Locator를 쓰는 축의 v0<=v1 일관성을 위한 것이지 log F2P 경로(LogLocator 사용)를 타지 않는다.

## 검증 (test_patch)
- **FAIL_TO_PASS = 1**: `test_inverted_limits`. 기존 linear invert 단언(`get_xlim()==(-5,4)`, `get_ylim()==(5,-3)`)에 더해, 새 figure에서 `ax.set_yscale("log")` 후 `ax.set_ylim(10, 1)` → `ax.get_ylim() == (10, 1)`을 추가. 픽스 전에는 log축이 `(1, 10)`으로 정렬되어 실패, 픽스 후 입력 순서가 보존되어 통과.
- **픽스 증명**: log F2P(`set_yscale('log')`; `set_ylim(10,1)`; `get_ylim()==(10,1)`)를 통과시키는 진짜 linchpin은 호출자 `set_ylim`의 `swapped` 캡처/복원 **단독**이다. log 축의 major locator는 `LogLocator`(scale.py:406)이므로 `nonsingular(10,1)`은 미수정 `LogLocator.nonsingular`(line 2378)로 라우팅되어 (1,10)으로 정렬되고, `LogScale.limit_range_for_scale`(scale.py:420)는 양수 클램프만 할 뿐 재정렬하지 않는다(`minpos if vmin<=0 else vmin`). 이 (1,10)을 (10,1)로 되돌리는 것이 호출자의 `if swapped: bottom,top = top,bottom`이다. ticker.py의 base `Locator.nonsingular`(increasing=False 제거)는 log 경로를 전혀 타지 않으므로 이 테스트의 필요조건이 아니다 — 그 변경은 base Locator를 쓰는 축의 v0<=v1 일관성용이다.
- **overfit 관점**: F2P가 1개뿐이라 얇지만(overfit-risk 잠재), 골드는 테스트가 검사하지 않는 x축·3D 5개 메서드까지 일반화 적용했다. 즉 골드는 테스트 너머로 일반화했고, 테스트만 통과시키는 special-case(ylim log만 swap)는 회귀를 남긴다.
- **regression 관점**: P2P 400개에 `test_log_margins`, `test_autoscale_log_shared`, `test_loglog`, `test_shared_axes_autoscale`, `test_invalid_axis_limits`, `test_inverted_cla` 등 한계·스케일 계산 핵심이 포함. `swapped` 복원은 `left > right`일 때만 발동하므로 정상(오름차순) 호출은 byte-identical하게 유지되어 이들을 깨지 않는다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 "3.1.0부터 log만 반전 안 됨" + hint의 PR #13409 → log scale의 한계 정규화 지점을 의심. `set_ylim`이 `self.yaxis.get_major_locator().nonsingular(...)`를 호출함을 확인 → log 축의 major locator는 `LogLocator`(scale.py:406)이고 `LogLocator.nonsingular`(ticker.py line 2378)가 무조건 `if vmin>vmax: swap`으로 endpoint를 오름차순 정렬함을 발견. "linear는 되고 log만 안 됨" 증상이 locator-별 분기를 정확히 가리킨다(linear는 base `Locator.nonsingular`를 쓰며 거기엔 `increasing=False`라 순서가 보존됐기 때문).
2. **픽스와 일반화 근거**: `increasing=False` 제거로 locator가 순서를 보존하게 하고, 호출자에서 `swapped = bottom > top` 캡처 후 변환 뒤 복원. 이게 올바른 일반화인 이유 — 결함은 "log일 때만"이 아니라 "한계 정규화가 순서를 강제하는 모든 축"의 문제이므로, x/y/z·2D/3D 6개 호출 지점 전부에 동형 적용해야 증상이 재발하지 않는다.
3. **regression 안전**: `swapped` 분기는 입력이 역순일 때만 동작하므로 정상 오름차순 한계 설정(대다수 P2P)은 동작 불변. `nonsingular`의 expander(.05) 동작도 유지되어 singular(left==right) 자동확장 경고/동작이 보존된다.
4. **함정 회피**: 오라클 없는 에이전트가 빠지기 쉬운 함정 — (a) `set_ylim`만 고치고 x축/3D 5곳을 누락(F2P는 1개라 통과해도 회귀 잔존), (b) base `Locator.nonsingular`(increasing 제거)는 base Locator를 쓰는 축의 v0<=v1 일관화용일 뿐이라, 이를 누락해도 log F2P는 통과한다(log 정렬원은 미수정 `LogLocator.nonsingular`의 if-swap이고 그 결과를 호출자 `swapped` 복원이 되돌림; `LogScale.limit_range_for_scale`는 정렬을 하지 않으므로 "limit_range_for_scale 경로의 정렬을 못 막는" 위험은 존재하지 않음), (c) `increasing=False`의 의미를 오해해 무관한 정렬 로직을 추가하는 과교정. 회피법: hint의 정확한 origin(`nonsingular` increasing 인자)을 신뢰하고, 동일 패턴을 grep으로 전수 찾아 6곳 모두 동기화하며, F2P 1개에 만족하지 말고 x/3D 대칭성을 직접 검증.
