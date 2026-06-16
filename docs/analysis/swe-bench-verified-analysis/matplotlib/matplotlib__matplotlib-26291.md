---
instance_id: matplotlib__matplotlib-26291
repo: matplotlib/matplotlib
base_commit: fa68f46289adf4a8a4bc7ba97ded8258ec9d079c
version: "3.7"
difficulty: "15 min - 1 hour"
created_at: "2023-07-12T04:29:07Z"
fail_to_pass: 1
pass_to_pass: 49
gold_files: [lib/mpl_toolkits/axes_grid1/inset_locator.py]
primary_type: T-DirectMap
tier: T3
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약

`mpl_toolkits.axes_grid1.inset_locator.inset_axes`로 만든 inset axes를 `bbox_inches="tight"`로 저장(또는 inline 백엔드로 표시)하면 `AttributeError: 'NoneType' object has no attribute '_get_renderer'`로 죽는다. tight bbox 계산 경로(`_tight_bbox.adjust_bbox`)가 axes locator를 `locator(ax, None)` 형태로 renderer=None을 넘겨 호출하는데, `AnchoredLocatorBase.__call__`이 그 None을 그대로 `get_window_extent`로 흘려보낸다. matplotlib이 "아티스트는 자기 figure를 안다"는 전제로 `get_window_extent`에 renderer를 기본 전달하지 않게 바뀐(#22745) 뒤로, figure가 세팅 안 된 이 locator는 None renderer에서 figure를 못 찾아 터진다.

## 유형 (정형화)

- **L (Localization) = L0 (Pinpointed).** 네이티브 스택트레이스가 `inset_locator.py:73 __call__` → `offsetbox.py:399 get_window_extent`까지 정확히 가리킨다. grep 한 방으로 `AnchoredLocatorBase.__call__` 도착.
- **S (Repair) = S1 (Direct-Map, +S2).** 결함클래스가 전형적 None-가드다: renderer가 None이면 채워준다. 다만 "어디서 renderer를 얻느냐"(`self.figure` vs `ax.figure`)는 잠깐의 불변식 추론(S2)이 필요 — 이슈 토론에서 실제로 두 후보가 충돌했다.
- **K (Knowledge) = K-Domain.** offsetbox/locator/renderer 플러밍과 #22745 회귀 맥락을 알아야 "왜 renderer가 None으로 오나"를 이해한다. 일반 파이썬 추론만으론 픽스의 정합성을 판단하기 어렵다.
- **primary_type = T-DirectMap.** 위치는 자명(L0)하고 픽스는 None-가드 1줄 삽입(S1)이라 직접 매핑형. localize에 난점이 없고, 추론은 "renderer 소스 선택" 한 점에 국한.
- 왜 S1인가(APR 관점): PAR/TBar식 정형 결함 템플릿(Null-check insertion)에 그대로 매칭된다. 후보 패치를 테스트로 수렴시킬 필요(S3/S4) 없이, 결함 위치에서 가드를 합성하면 끝.

## 난이도 티어

**T3 (중간).** 공식 라벨 "15 min - 1 hour"과 정합.

구조적 피처:
- 파일 1개·실질 +2줄(헌크 1개) → scope 최소(48% solve 구간의 1파일·소규모).
- has-repro: 완전한 재현코드 + 네이티브 traceback(가장 강한 easiness 신호) → localize는 거의 공짜.
- 그럼에도 T1/T2가 아닌 이유: (1) renderer를 `self.figure`에서 끌지 `ax.figure`에서 끌지가 **비자명** — 이 locator는 add_axes에 들어가도 figure가 안 잡힐 수 있어 `self.figure`는 여전히 None일 수 있다(이슈 토론에서 실제로 첫 시도가 이걸로 실패). 올바른 답은 "axes는 항상 figure를 갖는다"는 불변식에 기댄 `ax.figure`. (2) regression-trap: PASS_TO_PASS 48개가 전부 같은 모듈(`test_axes_grid1.py`)의 inset/divider/grid 렌더링이라, 정상 draw 경로(renderer가 정상 전달되는 경우)를 절대 안 바꿔야 한다. None일 때만 분기하는 게 그래서 중요.

## 골드패치 분석

- **파일/함수:** `lib/mpl_toolkits/axes_grid1/inset_locator.py`의 `AnchoredLocatorBase.__call__(self, ax, renderer)`.
- **근본원인:** `_tight_bbox.adjust_bbox`가 `locator(ax, None)`로 호출(tight bbox 단계엔 아직 renderer가 없음). #22745 이후 `get_window_extent`는 None을 받으면 `self.figure._get_renderer()`로 자체 해결하려 하는데, 이 locator 인스턴스는 `figure`가 None이라 `NoneType._get_renderer` AttributeError. 즉 "renderer가 None일 때 figure로 폴백"하는 표준 메커니즘이 이 아티스트에선 figure 미세팅 때문에 깨진다.
- **수정요지:** `__call__` 진입부에서 `if renderer is None: renderer = ax.figure._get_renderer()`. None이면 인자로 받은 axes의 figure에서 renderer를 만들어 주입한다. 이후 `get_window_extent(renderer)`·`get_offset(...)`이 모두 유효한 renderer를 받는다. locator의 `self.figure`에 의존하지 않고 `ax.figure`를 쓰는 게 핵심 — axes는 항상 figure를 갖기 때문.

## 검증 (test_patch)

- **FAIL_TO_PASS (1개): `test_inset_axes_tight`.** gh-26287 재현을 그대로 옮긴 회귀 테스트: `inset_axes(ax, width=1.3, height=0.9)` 후 `fig.savefig(BytesIO(), bbox_inches="tight")`가 예외 없이 끝나면 통과. 픽스 전엔 adjust_bbox → `locator(ax, None)` → AttributeError로 savefig가 raise → 실패. 픽스 후엔 None 폴백으로 renderer가 채워져 정상 종료.
- **픽스 증명:** 테스트는 `savefig`가 raise하지 않는 것만 단언(smoke). 픽스가 정확히 그 raise 지점(None renderer)을 제거하므로 인과가 일치.
- **overfit/regression 관점:** 분기가 `renderer is None`에만 걸려 정상 draw 경로는 바이트 동일 → 48개 PASS_TO_PASS(같은 모듈 inset/grid 렌더링)에 영향 없음. 다만 FAIL_TO_PASS가 1개 smoke뿐이라(픽셀 비교 없음) "터지지만 않으면 OK" 수준의 약한 명세 — overfit 위험 자체는 낮으나(가드가 일반적), 결과 bbox의 정확성까지는 검증 안 함.

## 모범답안 (오라클 기반)

1. **localize:** traceback 마지막 프레임이 `inset_locator.py:73 __call__` → `offsetbox.py get_window_extent`에서 `renderer = self.figure._get_renderer()`가 `self.figure`=None으로 터짐. 한 단계 위 `_tight_bbox.adjust_bbox`가 `locator(ax, None)`을 호출함을 보면, renderer=None이 `__call__`을 관통해 들어온다는 게 명확. 수정 지점 = `AnchoredLocatorBase.__call__`.
2. **픽스/일반화:** `__call__` 진입부에서 `renderer is None`이면 채워준다. **renderer 소스로 `ax.figure._get_renderer()`를 택하는 게 올바른 일반화** — `self.figure`는 이 locator가 figure에 정식 등록되지 않아 None일 수 있지만(첫 시도가 이걸로 실패), `ax`(=호출 인자)는 정의상 figure를 갖는다. None일 때만 폴백하므로 정상 경로엔 무해.
3. **regression 안전:** PASS_TO_PASS 48개가 전부 inset/divider/grid 정상 렌더링(renderer가 제대로 전달되는 경로). 가드를 `is None`으로만 한정하면 이들은 분기 자체를 안 타 안전. `test_anchored_locator_base_call`이 정상 호출 경로를 직접 커버하므로 거기서 깨지면 즉시 잡힌다.
4. **함정 회피:** (a) 이슈 초기 diff처럼 `self.figure._get_renderer()`로 가거나 `_add_inset_axes`에서 `axes_locator.figure = inset_axes.figure`를 추가로 세팅하는 건 "iffy"하고 figure가 여전히 None인 다른 경로를 남긴다 — 오라클은 이 두 줄을 버리고 `ax.figure` 단일 폴백으로 수렴했다. (b) `get_window_extent`/offsetbox 쪽을 고치려 들면 광범위 회귀를 부른다(48개 P2P가 그 코어를 공유). 수정은 locator의 None-진입에 국한해야 한다. (c) None 가드 없이 무조건 `ax.figure._get_renderer()`로 덮으면 정상 draw에서 이중 renderer 생성/불일치 위험 — 반드시 None일 때만.
