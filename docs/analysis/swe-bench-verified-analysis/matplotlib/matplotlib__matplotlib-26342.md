---
instance_id: matplotlib__matplotlib-26342
repo: matplotlib/matplotlib
base_commit: 2aee6ccd7c7e1f8d282c1e7579f4ee546b838542
version: "3.7"
difficulty: "15 min - 1 hour"
created_at: "2023-07-18T10:06:19Z"
fail_to_pass: 1
pass_to_pass: 81
gold_files: [lib/matplotlib/collections.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S6)
knowledge: K-Domain
flags: [regression-trap]
---

## 문제 요약
Cartopy는 contour 라벨링을 위해 `ContourSet`의 모든 path를 변환본으로 교체해야 하는데, 현재는 `cs.get_paths()[:] = transformed_paths` 같은 in-place 슬라이스 대입이라는 냄새나는 우회를 쓴다. 이슈는 이를 `cs.set_paths(transformed_paths)`로 깔끔하게 쓸 수 있게 해달라는 ENH 요청이다. 핵심 문제는 베이스 클래스 `Collection.set_paths`가 `NotImplementedError`를 던지고 있어, `Collection`을 상속한 `ContourSet`이 setter를 못 쓴다는 점이다. hints에서 이미 `PathCollection.set_paths`(self._paths 대입) 구현을 베이스로 끌어올리면 된다고 거의 답을 적어준다.

## 유형 (정형화)
- **L (Localization) = L0**: 이슈가 `set_paths`를 심볼 단위로 직접 지목하고, hints가 `collections.py:1004-1006`의 `PathCollection.set_paths`까지 라인으로 찍어준다. grep 한 방.
- **S (Repair Strategy) = S1 (+S6)**: 픽스가 사실상 명세되어 있다 — `raise NotImplementedError`를 `self._paths = paths; self.stale = True`로 교체(S1, 기계적). 동시에 같은 구현이 자식 `PathCollection`에 중복으로 존재하므로 이를 삭제해 베이스로 끌어올리는 작은 lifting/리팩터(S6 보조)가 따라온다. 새 식·조건을 추론할 게 없어 S2가 아니다.
- **K (Knowledge) = K-Domain**: 정답 자체는 자명하나, "왜 `get_paths`는 `self._paths`를 반환하는데 setter만 NotImplementedError였나", "`stale` 플래그를 함께 세팅해야 재렌더가 일어난다"는 matplotlib artist 내부 계약 지식이 필요하다. 순수 일반 파이썬은 아니다.
- **primary type = T-DirectMap**: 위치 명확(L0) + 기계적 픽스(S1)의 정석. 결함클래스는 "미구현 stub을 부모로 끌어올려 채우기".

## 난이도 티어
**T2 (쉬움).** 구조적 피처: 단일 파일(`collections.py`) / 순변경 +2줄·−3줄(net −1) / localize 직접성 최상(L0, 심볼+라인 지목) / `has-repro`는 아니지만 hints가 패치를 거의 받아쓰기 수준으로 제공 / 도메인 지식은 얕음(stale 플래그 관례 정도). FAIL_TO_PASS는 1개로 얇지만 새 기능 추가라 overfit 여지가 작다. 공식 difficulty 라벨("15 min - 1 hour")과 대체로 일치 — 다만 그 시간 대부분은 베이스로 끌어올렸을 때 다른 서브클래스(`PathCollection` 등)의 기존 동작을 안 깨는지 확인하는 회귀 점검에 들어간다(`regression-trap`). 그래서 T1(존나쉬움)보다는 한 단계 위.

## 골드패치 분석
- **건드린 파일·함수**: `lib/matplotlib/collections.py` 한 곳, 두 헌크.
  1. 베이스 `Collection.set_paths`: `raise NotImplementedError` → `self._paths = paths; self.stale = True`.
  2. `PathCollection.__init__` 직후에 중복 정의돼 있던 `PathCollection.set_paths`(동일한 `self._paths = paths; self.stale = True` 본문)를 **삭제**.
- **근본원인**: `Collection.get_paths`는 `self._paths`를 그대로 반환하는데, 대칭 setter인 `Collection.set_paths`는 미구현 stub(`NotImplementedError`)으로 남아 있었다. 그래서 `PathCollection`만 자체적으로 setter를 따로 구현했고, `ContourSet`처럼 `Collection`을 상속한 다른 클래스는 setter를 못 썼다.
- **수정요지**: getter와 대칭이 되도록 setter 본문을 베이스로 승격하고(`_paths` 대입 + 재렌더용 `stale=True`), 자식의 중복 구현을 제거해 단일 정의로 통일. 결과적으로 `ContourSet`을 포함한 모든 `Collection` 서브클래스가 `set_paths`를 상속받는다.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_contour.py::test_contour_set_paths[png]` 1개. `check_figures_equal(extensions=['png'])` 데코로 fig_test/fig_ref 두 figure를 그린다. test는 `[[0,1],[1,2]]`로, ref는 좌우 반전된 `[[1,0],[2,1]]`로 contour를 그린 뒤, `cs_test.set_paths(cs_ref.get_paths())`를 호출해 test의 path를 ref의 것으로 덮어쓴다. 픽스 전에는 `NotImplementedError`로 즉시 실패. 픽스 후에는 `_paths`가 교체되고 `stale=True`로 재렌더되어 두 figure가 픽셀 동일해진다.
- **픽스 증명**: `check_figures_equal`은 단순 호출 성공이 아니라 "set_paths가 실제로 path를 교체해 렌더 결과를 바꿨다"를 픽셀 비교로 검증한다 — `stale=True`를 빠뜨려 재렌더가 안 되면 test/ref가 어긋나 fail한다. 즉 두 줄 모두 필요함이 테스트로 강제된다.
- **overfit·regression 관점**: 새 동작 추가라 special-case overfit 위험은 낮다(setter는 일반적 `_paths` 대입이라 입력공간 일반화가 자명). 진짜 리스크는 `PathCollection.set_paths` 삭제로 인한 회귀인데, 78개 PASS_TO_PASS(`test_quadcontourset_reuse`, `test_contour_remove`, 다수 image_comparison 포함)가 기존 contour/collection 렌더 경로를 폭넓게 지킨다. 베이스 본문이 삭제된 자식 본문과 바이트 동일하므로 동작 변화가 없어야 함이 이들로 담보된다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `ContourSet.set_paths`를 원하고, `ContourSet`이 `Collection` 서브클래스임을 안다 → `collections.py`에서 `set_paths`를 grep → 베이스 `Collection.set_paths`가 `raise NotImplementedError`임을 발견. hints가 `PathCollection.set_paths`(`self._paths = paths; stale=True`)를 정답 템플릿으로 지목.
2. **픽스와 일반화 근거**: 베이스 setter를 `self._paths = paths; self.stale = True`로 채운다. 이것이 올바른 일반화인 이유는 (a) `get_paths`가 `self._paths`를 반환하므로 setter도 같은 필드를 쓰는 것이 getter/setter 대칭 계약에 맞고, (b) artist는 `stale=True`라야 다음 draw에서 재렌더되므로 setter의 부수효과로 반드시 함께 세팅해야 한다. 특정 입력에 끼워맞춘 게 아니라 모든 `Collection`에 유효한 보편 동작.
3. **regression 안전**: `PathCollection.set_paths` 중복 정의를 삭제할 때, 본문이 베이스로 올린 것과 정확히 동일해야 `PathCollection` 사용자(scatter 등)가 안 깨진다. PASS_TO_PASS 78개 — 특히 `test_quadcontourset_reuse`, `test_contour_remove`, image_comparison류 — 가 collection 렌더 경로의 비회귀를 보증한다.
4. **함정 회피**: (a) `stale=True`를 빠뜨리는 것 — 그러면 `set_paths` 호출은 통과해도 `check_figures_equal`가 재렌더 누락으로 fail. 베이스 채울 때 두 줄 다 넣어야 한다. (b) 베이스에 추가만 하고 `PathCollection`의 중복 정의를 안 지우는 것 — 기능상 동작은 하지만 골드패치는 중복 제거를 포함하며, 오라클 없이도 "자식과 부모에 동일 메서드 중복"은 코드 스멜이므로 lifting이 올바른 형태다. (c) `ContourSet`/`QuadContourSet`에 setter를 따로 다는 좁은 픽스 유혹 — 베이스에 올리는 것이 이슈가 원한 일반 해법이고 중복을 더 늘리지 않는다.
