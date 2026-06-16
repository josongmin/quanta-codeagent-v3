---
instance_id: matplotlib__matplotlib-25775
repo: matplotlib/matplotlib
base_commit: 26224d96066b5c60882296c551f54ca7732c0af0
version: "3.7"
difficulty: "15 min - 1 hour"
created_at: 2023-04-26T21:26:46Z
fail_to_pass: 7
pass_to_pass: 89
gold_files: [lib/matplotlib/backends/backend_agg.py, lib/matplotlib/backends/backend_cairo.py, lib/matplotlib/text.py]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, underspecified]
---

## 문제 요약

`Text` 객체는 안티앨리어싱 상태를 항상 전역 `rcParams["text.antialiased"]`에서만 읽어, 다른 artist들처럼 per-artist `set_antialiased`/`get_antialiased`로 설정할 수 없다. 이슈는 `Text`(및 `Annotation`)에 getter/setter를 추가하고, 그 상태를 그리기 단계에서 실제로 사용하라고 요청한다. 단, "backend 코드에서 `rcParams` 직접 접근을 GraphicsContext 상태 경유로 바꿔야 한다"는 점이 핵심 난점으로 명시된다.

## 유형 (정형화)

- **L = L3 (Multi-site)**: 픽스가 3개 파일에 걸쳐 **조율되어** 바뀌어야 함. `text.py`에 상태/getter/setter를 추가하는 것만으로는 부족하고, drawing 단계에서 `gc.set_antialiased(...)`로 GC에 실어 보내고, `backend_agg`·`backend_cairo`의 `draw_text`가 `rcParams` 대신 `gc.get_antialiased()`를 읽도록 **동시에** 고쳐야 그림이 실제로 바뀐다.
- **S = S6 (Design-Refactor) + S5 (Spec-Inference)**: 한 줄 가드가 아니라 "per-artist 상태를 도입 → GC 채널로 전파 → backend가 GC에서 소비"라는 작은 lifecycle/데이터플로우 재배치다. 또한 antialiased를 backend별로 어떻게 GC에 표현할지(cairo는 enum, agg는 bool)는 이슈가 명세하지 않아 기존 artist 관례에서 스펙을 재구성해야 한다.
- **K = K-Domain**: matplotlib backend 내부(GraphicsContext 추상화, agg `draw_glyphs_to_bitmap`, cairo `FontOptions.set_antialias`/`get_antialias`)를 알아야 함. 일반 파이썬 추론으론 안 됨.
- **primary = T-DesignRefactor**: 진짜 작업은 신규 기능을 위한 **조율된 구조 변경**이지, 위치 찾기(L)나 식 추론(S2)이 아니다. APR 관점에서 단일-hunk 템플릿이 아니라 collect(상태)→propagate(GC)→consume(backend) 다지점 변경이라 S6.

## 난이도 티어

**T4 (약간 어려움).** 구조적 피처:
- 파일 수 3개 / 헌크 다수(text.py 6헌크 + 두 backend) — 3파일 컷(solve 급락 구간) 경계에 걸침.
- localize 직접성: 낮음. 이슈는 신규 메서드라 "고칠 줄"이 아예 없고, "drawing 단계 + backend GC 경유"라는 데이터플로우를 스스로 깔아야 함(L3).
- repro 없음: 버그 재현 스택트레이스가 아니라 enhancement 요청. easiness 신호(has-repro) 부재.
- 도메인 지식: agg/cairo 두 backend의 antialias 표현 차이를 알아야 함.
- P2P trap: `test_antialiasing[png]` 등 90개 회귀 케이스가 기본 동작 불변을 강제.

공식 라벨 "15분-1시간"은 **개발자 구현시간** prior로는 맞지만(코드량 자체는 작음), 에이전트 난이도는 multi-site 조율 + backend 도메인지식 + repro 부재 때문에 시간라벨보다 한 단계 높게 본다. 그래서 T3가 아니라 T4.

## 골드패치 분석

건드린 파일·함수:
- **`lib/matplotlib/text.py`** — `Text.__init__`에 `antialiased=None` kwarg 추가, `self._antialiased = mpl.rcParams['text.antialiased']` 초기화, `_reset_visual_defaults`에 `antialiased` 전달(`if antialiased is not None: self.set_antialiased(...)`). 신규 `set_antialiased`/`get_antialiased` 메서드(설정 시 `self.stale = True`). `update_from`에 `self._antialiased = other._antialiased` 복제. `Text.draw`에 `gc.set_antialiased(self._antialiased)` 한 줄 추가(GC로 전파).
- **`backend_agg.py::RendererAgg.draw_text`** — `font.draw_glyphs_to_bitmap(antialiased=mpl.rcParams['text.antialiased'])` → `antialiased=gc.get_antialiased())`.
- **`backend_cairo.py`** — `draw_text`에서 `opts.set_antialias(... rcParams ...)` → `opts.set_antialias(gc.get_antialiased())`; 사용 안 하게 된 `import matplotlib as mpl` 제거; `GraphicsContextCairo`에 `get_antialiased`(=`self.ctx.get_antialias()`) 추가.

근본원인: 안티앨리어싱이 per-artist 상태로 모델링되어 있지 않고 backend가 전역 rcParams를 직접 읽음 → artist 단위 제어 불가. 수정요지: 상태를 `Text._antialiased`로 끌어올리고, draw 시 GC에 실어 backend가 GC에서 소비하게 하는 단방향 데이터플로우를 신설.

## 검증 (test_patch)

FAIL_TO_PASS 7개:
- `test_set_antialiased`/`test_get_antialiased` — 기본값이 `rcParams['text.antialiased']와 같고, `antialiased=` 생성자 kwarg와 setter가 `_antialiased`를 정확히 반영하는지(단위).
- `test_annotation_antialiased` — `Annotation`이 `Text` 상속으로 동일 동작을 얻는지(생성자 kwarg + setter).
- `test_text_antialiased_off/on_default_vs_manual[png/pdf]` — `@check_figures_equal`로 `text(..., antialiased=False)`가 `rcParams['text.antialiased']=False` 전역 설정과 **픽셀 동일**함을 증명. 이게 "GC 경유 전파가 실제 렌더링에 도달"함을 검증하는 핵심 케이스(단위 getter만이 아님).

overfit 관점: 단위 4개만 있으면 getter/setter만 달고 draw 배선을 빼도 통과해버린다(overfit 가능). 하지만 `check_figures_equal` 이미지 동치 테스트가 backend까지의 데이터플로우를 강제해 overfit을 막는다 — 다만 agg/pdf만 커버, cairo·svg 경로는 미검증이라 일부 잔여 overfit-risk 존재. regression 관점: 90개 P2P(특히 `test_antialiasing[png]`)가 기본 경로(`antialiased=None`→rcParams 폴백) 불변을 보장.

## 모범답안 (오라클 기반)

1. **localize**: 이슈가 두 신호를 줌 — (a) "다른 artist처럼 set/get_antialiased 추가"→`text.py`의 `Text` 클래스, (b) "drawing 단계에서 backend의 rcParams 접근을 GraphicsContext 경유로 교체"→`grep rcParams['text.antialiased']`로 `backend_agg.draw_text`와 `backend_cairo.draw_text` 두 소비처를 직접 회수. 즉 명세가 multi-site를 미리 알려준다.
2. **픽스와 일반화**: 상태를 `Text._antialiased`로 보유, `draw`에서 `gc.set_antialiased`로 전파, backend는 `gc.get_antialiased`로 소비. 기존 다른 artist의 antialiased 처리와 동형이라 "특수 케이스"가 아닌 올바른 일반화. `antialiased=None` 기본은 rcParams 폴백을 유지해 기존 사용자 코드와 호환.
3. **regression 안전**: 기본값을 `rcParams['text.antialiased']`로 초기화하고 `None`일 때 setter를 건너뛰어, 미지정 텍스트의 렌더링이 변하지 않게 함 → `test_antialiasing[png]` 등 P2P 보존. `update_from` 복제를 빼먹으면 copy 기반 동작이 깨지므로 함께 처리.
4. **함정 회피**: (i) 단위 getter/setter만 달고 `Text.draw`의 `gc.set_antialiased` 배선을 누락 → 이미지 테스트가 잡아냄. (ii) cairo는 bool이 아니라 enum(`ANTIALIAS_DEFAULT`/`ANTIALIAS_NONE`)을 다루므로 `GraphicsContextCairo.get_antialiased`를 별도로 추가해야 함(agg와 표현 불일치). (iii) `_reset_visual_defaults`에서 무조건 set하면 `None`이 rcParams 폴백을 덮어써 회귀 → `if antialiased is not None` 가드 필수. (iv) `Annotation`은 `Text` 상속이라 자동 획득되지만 테스트가 명시 검증하므로 생성자 kwarg 전달 경로를 빠뜨리면 안 됨.
