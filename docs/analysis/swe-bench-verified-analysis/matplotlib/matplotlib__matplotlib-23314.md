---
instance_id: matplotlib__matplotlib-23314
repo: matplotlib/matplotlib
base_commit: 97fc1154992f64cfb2f86321155a7404efeb2d8a
version: "3.5"
difficulty: "15 min - 1 hour"
created_at: 2022-06-21T02:41:34Z
fail_to_pass: 1
pass_to_pass: 862
gold_files: [lib/mpl_toolkits/mplot3d/axes3d.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L1
repair_strategy: S1
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약

`projection='3d'` 서브플롯에서 `ax.set_visible(False)`를 호출해도 해당 축이 화면에서 사라지지 않는다. 일반 2D `Axes`는 `set_visible(False)`가 정상 동작하지만, 3D 전용 `Axes3D`는 동일 동작이 누락되어 있다. 이슈에 최소 재현 코드가 첨부되어 있고 기대/실제 결과가 명확하다.

## 유형 (정형화)

- **L (Localization) = L1 (Traceable)**: 이슈가 `set_visible` 동작 누락을 가리키지만 정확한 수정 지점(어느 메서드가 visibility 체크를 빠뜨렸는가)은 한 번의 탐색이 필요하다. 2D `Axes.draw`가 어떻게 visibility를 처리하는지 본 뒤 `Axes3D.draw`에 같은 가드가 없음을 확인하는 비교 추적. 단일 파일(`axes3d.py`)로 수렴하므로 L0는 아니나 diffuse도 아니다.
- **S (Repair Strategy) = S1 (Direct-Map)**: 픽스가 사실상 명세돼 있다 — "draw 진입 시 not visible이면 그리지 말 것". 정형 결함클래스(누락된 early-return 가드)에 템플릿 매칭된다. 추론 합성(S2)이 아니라 2D 경로의 기존 패턴을 미러링하는 기계적 추가.
- **K (Knowledge) = K-Domain**: matplotlib 렌더 파이프라인 도메인 지식 필요 — `Artist.get_visible()` 계약과 `draw(renderer)`가 모든 Artist 렌더의 chokepoint라는 사실, 그리고 `Axes3D`가 2D `Axes.draw`를 오버라이드하면서 base의 visibility 가드를 상속하지 못한다는 구조를 알아야 한다.
- **primary_type = T-DirectMap**: 위치는 약간의 추적으로 명확해지고, 픽스는 가드 추가라는 기계적 매핑이다. APR 관점에서 PAR/TBar식 "missing-null/missing-guard" 템플릿이 그대로 적용되는 케이스라 S1으로 분류한다.

## 난이도 티어

**T2 (쉬움).** 구조적 피처:
- **파일수 1 / 추가 2줄**: ICLR 2024 구조컷에서 1파일·<5줄은 최고 solve 구간(~48%+).
- **localize 직접성**: L1 — 2D vs 3D `draw` 비교 한 단계. has-repro로 동작 차이가 즉시 관찰된다.
- **repro 존재**: 이슈에 minimal example + 기대 이미지 첨부 → 가장 강한 easiness 신호.
- **P2P trap**: PASS_TO_PASS가 862개로 넓다 → `regression-trap`. 다만 픽스가 `if not self.get_visible(): return` early-return이라 visible=True 기존 경로의 바이트 동작을 전혀 바꾸지 않으므로 trap의 실질 위험은 낮다.

공식 라벨 "15 min - 1 hour"와 정합. 추론 부담은 없고(가드 한 줄) 도메인 구조 이해만 필요해 T2로 둔다. T1이 아닌 이유는 K-Domain(렌더 파이프라인 chokepoint 이해)과 약한 L1 탐색이 끼어서다.

## 골드패치 분석

- **건드린 파일·함수**: `lib/mpl_toolkits/mplot3d/axes3d.py`의 `Axes3D.draw(self, renderer)`.
- **근본원인**: `Axes3D`가 base `matplotlib.axes.Axes.draw`를 완전히 오버라이드하면서, base가 메서드 초입에서 수행하는 `if not self.get_visible(): return` visibility 가드를 옮겨오지 않았다. 그 결과 `set_visible(False)`로 `_visible` 플래그가 꺼져도 3D 축의 `draw`는 무조건 `_unstale_viewLim()`부터 전체 렌더를 수행해 축이 계속 그려진다.
- **수정요지**: `@martist.allow_rasterization` 데코레이터가 붙은 `draw` 본문 최상단, `self._unstale_viewLim()` 직전에 다음 두 줄을 추가:
  ```python
  if not self.get_visible():
      return
  ```
  2D `Axes.draw`의 visibility 단락(short-circuit)을 3D 경로에 동일하게 복원한다.

## 검증 (test_patch)

- **FAIL_TO_PASS (1개)**: `lib/mpl_toolkits/tests/test_mplot3d.py::test_invisible_axes[png]`. `@check_figures_equal(extensions=["png"])`로 `fig_test`에는 3D 서브플롯을 만들고 `ax.set_visible(False)` 한 뒤, `fig_ref`(빈 figure)와 픽셀 동등성을 비교한다. 픽스 전에는 보이지 않아야 할 3D 축이 렌더되어 `fig_ref`와 픽셀이 달라 실패하고, early-return 추가 후 두 figure가 동일해져 통과한다 — 픽스가 실제 렌더 효과를 관찰로 증명.
- **test_patch 부수 변경**: 2D `test_axes.py`에 동일한 `test_invisible_axes`(check_figures_equal) 추가 + 기존 이벤트 테스트를 `test_invisible_axes_events`로 개명(이름 충돌 회피). 2D는 이미 통과 동작이라 회귀 가드 성격.
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇지만, 검증이 special-case 단언이 아니라 **렌더 픽셀 전체 동등성**(빈 figure와 일치)이므로 `if not visible: return`보다 약한 패치(특정 artist만 숨기기 등)로는 통과하기 어렵다. CEGIS류 과소명세 위험은 낮고 가드 한 줄이 올바른 일반화다.
- **regression 관점**: PASS_TO_PASS 862개 — visible=True인 모든 기존 3D 렌더가 안 깨져야 한다. early-return은 not-visible일 때만 발동하므로 정상 경로 무영향이 구조적으로 보장된다.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈 신호 "set_visible가 3D에서 무효" → `set_visible`는 `Artist`의 공통 메서드이고 효과는 `draw` 시점에 발현됨을 안다 → 2D `Axes.draw`가 초입에서 `if not self.get_visible(): return`로 단락하는 것을 확인 → `Axes3D`가 `draw`를 오버라이드(axes3d.py)했고 그 본문에 동일 가드가 없음을 대조해 수정 지점 확정.
2. **픽스와 일반화 근거**: `draw` 최상단에 `if not self.get_visible(): return` 추가. 이는 `Axes3D`만의 특수 로직이 아니라 모든 Artist가 따르는 visibility 계약을 chokepoint(draw)에서 복원하는 것 — 그래서 scatter/surface 등 어떤 3D 콘텐츠든 보편적으로 숨겨진다. 특정 자식 artist만 끄는 패치는 overfit.
3. **regression 안전**: 862개 PASS_TO_PASS 중 visible=True 경로는 분기 조건이 거짓이라 `_unstale_viewLim()` 이하 기존 렌더가 그대로 실행 → 바이트 동등. 데코레이터(`@martist.allow_rasterization`)와 이후 로직 순서를 건드리지 않는 점이 안전성의 핵심.
4. **함정 회피**: 오라클 없는 에이전트가 (a) 2D `Axes.draw`를 손대거나 base 클래스에 이중 가드를 넣어 다른 경로를 깨는 것, (b) `set_visible` 자체를 오버라이드하려다 `_visible` 플래그 세팅과 무관함을 놓치는 것, (c) 가드를 `_unstale_viewLim()` 뒤에 넣어 불필요한 부수효과를 남기는 것이 전형적 오류. 정답은 "2D가 이미 하는 일을 draw 초입에서 그대로 미러링"이며, FAIL_TO_PASS의 픽셀 동등 비교가 이 일반화를 강제한다.
