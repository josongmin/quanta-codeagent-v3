---
instance_id: matplotlib__matplotlib-24627
repo: matplotlib/matplotlib
base_commit: 9d22ab09d52d279b125d8770967569de070913b2
version: "3.6"
difficulty: "15 min - 1 hour"
created_at: 2022-12-05T00:05:54Z
fail_to_pass: 1
pass_to_pass: 776
gold_files: [lib/matplotlib/axes/_base.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`Artist.remove()`로 아티스트를 Axes에서 떼어내면 그 아티스트의 `.axes` 속성이 `None`으로 풀린다. 그러나 `Axes.cla()`(=`clear()`)로 축을 통째로 비우면 자식 아티스트들의 `.axes`/`.figure`가 여전히 옛 Axes/Figure를 가리킨 채 남는다. 즉 두 "deparent" 경로가 비대칭이라, 클리어 후에도 댕글링 참조가 남아 일관성이 깨진다. 이슈는 재현 스니펫 두 줄(`l.remove()` vs `a.cla()`)로 `l.axes`가 한쪽은 `None`, 한쪽은 살아있음을 명확히 보여준다.

## 유형 (정형화)
- **L (Localization) = L1 (Traceable)**: 이슈가 `cla()`/`clf()`를 직접 지목. `cla` → `Axes.clear` → `_AxesBase.__clear` 콜체인을 따라가면 자식을 비우는 단일 지점(`self._children = []`)으로 좁게 수렴한다. 파일 1개. grep 한두 방.
- **S (Repair Strategy) = S2 (Constraint-Reasoning)**: 고칠 지점은 명백하나, 올바른 픽스는 "`remove()`가 유지하는 불변식(deparent 시 `axes`/`figure`를 None화)을 `__clear`도 동일하게 만족시켜야 한다"는 **불변식 추론**에서 나온다. 단순 가드 추가가 아니라 기존 children을 폐기 전에 순회하며 역참조를 끊어야 한다. 템플릿 매칭(S1)이 아니라 "두 경로의 의미를 일치시키는" 의미적 추론.
- **K (Knowledge) = K-Domain**: matplotlib의 Artist↔Axes/Figure 부모-자식 모델, `remove()`가 `self.axes = None`으로 디커플하는 관례를 알아야 같은 계약을 `__clear`에 복제할 수 있다. 일반 파이썬 지식만으론 "무엇이 올바른 상태인가"를 못 정한다.
- **primary = T-ConstraintReason**: 위치는 쉽게 찾히지만(L1), 핵심 난점은 "어떤 상태로 만들어야 remove()와 일관되는가"를 추론·합성하는 데 있다. → S2 dominant.

## 난이도 티어
**T3 (중간)**. 구조적 피처: 파일 1개·핵심 변경 3줄·L1로 localize 직접성 높음·`has-repro`(명확한 재현 스니펫, 가장 강한 easiness 신호). 이것만 보면 T2지만 두 가지가 위로 민다. (1) 픽스가 "삭제 전 순회하여 deparent"라는 **순서 의존 의미 추론**을 요구(빈 리스트로 덮어쓰기 전에 old_children을 잡아야 함) — S2. (2) `pass_to_pass`가 53205개로 **regression-trap이 광범위**: `__clear`는 모든 Axes 생성/리셋 경로에서 호출되므로, `twinx`/공유축/잘못된 디커플은 대량 회귀를 부른다. 공식 라벨 "15min–1h"와 정합. T4까지 가지 않는 이유는 cross-file 조율이 없고(단일 함수), 도메인 지식이 "remove()를 모방"이라는 분명한 참조점이 있어서다.

## 골드패치 분석
- **파일/함수**: `lib/matplotlib/axes/_base.py`의 `_AxesBase.__clear(self)`.
- **근본원인**: `__clear`가 자식 컬렉션을 `self._children = []`로 **그냥 재바인딩**만 해서, 기존 자식 아티스트들이 보유한 `chld.axes`(및 `figure`) 역참조를 끊지 않았다. `Artist.remove()`는 `self.axes = None`/`self._parent_figure = None`으로 명시적으로 디커플하는데, cla 경로엔 그 단계가 없어 비대칭이 발생.
- **수정요지**:
  ```python
  old_children, self._children = self._children, []
  for chld in old_children:
      chld.axes = chld.figure = None
  ```
  리스트를 비우기 *전에* 기존 자식 참조를 `old_children`으로 포획하고, 각 자식의 `axes`/`figure`를 `None`으로 풀어 remove()와 동일한 deparent 계약을 만족시킨다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_cla_clears_children_axes_and_fig`. `ax.plot([],[],[],[])`로 라인 2개 + `ax.imshow([[1]])`로 이미지 1개를 만들고, 클리어 전 각 아티스트의 `.axes is ax`/`.figure is fig`를 단언한 뒤 `ax.clear()` 호출. 클리어 후 모든 아티스트의 `.axes is None`과 `.figure is None`을 단언한다. 픽스 전엔 옛 참조가 살아있어 두 후행 단언이 실패 → 픽스로 통과.
- **픽스 증명**: 테스트가 Line2D(`plot`)와 AxesImage(`imshow`) 두 종류의 자식을 동시에 검사하므로, 픽스가 특정 아티스트 타입이 아니라 `_children` 전체를 순회하는 일반 디커플임을 입증한다.
- **overfit/regression 관점**: F2P가 1개로 얇지만 `figure`와 `axes` 두 속성을 모두 검사해 special-case 통과 여지를 줄였다(overfit 위험 낮음). 진짜 위험은 **regression**: P2P 53205개 — 특히 `test_twinx_cla`, `test_inverted_cla`, `test_subclass_clear_cla` 등 cla 인접 동작과 광대한 렌더 비교 테스트를 안 깨야 한다. 골드패치가 "비우기 전 포획" 순서를 지킨 덕에 클리어 후 새로 추가되는 자식엔 영향 없음.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `cla()`/`clf()`와 "deparented artists의 `.axes`/`.figure`"를 직접 명명 → `Axes.cla`/`clear`가 `_AxesBase.__clear`로 위임됨을 따라가, `__clear` 내 자식 비우기 지점 `self._children = []`을 단일 후보로 특정. 대조군으로 `Artist.remove()`를 읽어 "올바른 deparent"가 `self.axes = None`임을 확인.
2. **픽스와 일반화 근거**: 리스트를 비우기 전에 `old_children`으로 잡고 순회하며 `chld.axes = chld.figure = None`. 이는 remove()의 디커플 계약을 클리어 경로에 복제한 것이라, 특정 입력이 아니라 "모든 자식 아티스트"에 대해 불변식을 회복하는 올바른 일반화다(overfit 아님). 빈 리스트로 먼저 덮으면 참조를 잃으므로 **포획 순서가 정답의 핵심**.
3. **regression 안전**: `__clear`는 Axes 초기화·리셋·`twinx`/공유축 재설정 등 광범위 경로에서 호출된다. 픽스는 *기존* 자식만 디커플하고 직후 비워진 리스트엔 새 자식이 정상 추가되므로, `test_twinx_cla`/`test_inverted_cla` 등 P2P 53205건이 깨지지 않는다.
4. **함정 회피**: (a) `self._children = []`만 두고 디커플을 빼면 버그 그대로 — 반드시 순회 디커플 추가. (b) 비운 *후* 순회하면 빈 리스트라 no-op이 되니 **포획-그다음-비우기** 순서를 지킬 것. (c) `axes`만 풀고 `figure`를 빠뜨리면 테스트의 `.figure is None` 단언에서 탈락 — 두 속성 모두 None화해야 한다.
