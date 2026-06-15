---
instance_id: django__django-12193
repo: django/django
base_commit: 3fb7c12158a2402f0f80824f6778112071235803
version: 3.1
difficulty: <15 min fix
created_at: 2019-12-08T01:38:25Z
fail_to_pass: 1
pass_to_pass: 11
gold_files: [django/forms/widgets.py]
primary_type: T-DirectMap
tier: T1
loc_axis: L0
repair_strategy: S1 (+S6)
knowledge: K-Gen
flags: [has-repro, cross-file-dep]
---

# django__django-12193

## 문제 요약
`SplitArrayField`에 `BooleanField`를 쓰고 기존 데이터를 채워 렌더링하면, 데이터 배열에서 첫 번째 `True`를 만난 이후의 모든 위젯이 백킹 데이터가 `False`임에도 전부 checked로 나온다. 원인은 `CheckboxInput.get_context()`가 전달받은 `attrs` dict를 in-place로 변형(`attrs['checked'] = True`)하기 때문이다. `SplitArrayWidget`은 size만큼의 subwidget에 동일한 `final_attrs` dict를 재사용하므로, 한 번 mutate된 `checked` 키가 이후 subwidget으로 새어나간다. 사용자는 각 subwidget이 자기 데이터값(`True`/`False`)에 맞게 독립적으로 렌더링되기를 기대한다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)** — problem_statement가 `django/forms/widgets.py#L527`의 `CheckboxInput`이 `attrs['checked']`를 세팅하는 라인을 URL까지 박아 직접 지목하고, "this is the only widget that modifies the attrs dict passed into its get_context()"로 원인 위치를 못박는다. grep 한 방(`attrs[`)으로 즉시 수렴. 탐색 노력 0.
- **S (Repair Strategy) = S1 Direct-Map (+S6 보조)** — 결함이 정형 결함클래스(공유 mutable 인자 in-place 변형 → aliasing 누수)에 정확히 매칭되고, 표준 처방(인자를 mutate하지 말고 fresh copy를 만들어 전달)이 곧 픽스다. "입력 dict 비변형" 템플릿이 사실상 명세돼 있어 추론으로 식을 합성(S2)할 필요가 없다. copy-then-set이 `if attrs is None` 가드를 흡수하는 미세 구조 변경이라 S6를 보조로 단다. 후보가 다수라 테스트로 골라야 하는 G&V(S3/S4)도 아니다 — 정답 형태가 하나로 정해짐.
- **K (Knowledge) = K-Gen** — 픽스에 필요한 건 파이썬 참조 의미론(dict aliasing, 공유 객체 변형)에 대한 일반 추론뿐이다. 증상이 `SplitArrayWidget`(심지어 postgres contrib)에서 드러나지만 forms 위젯 렌더 파이프라인의 내부 지식이나 ORM/query-compiler 도메인지식은 픽스에 불필요하다.
- **primary_type = T-DirectMap** — 위치가 명확(L0)하고 픽스가 기계적(S1: 가드/비변형 패턴)이므로 T-DirectMap. L0+S1이면 T-LocTrivial 후보지만, "찾으면 끝"을 넘어 mutation→copy로 바꾸면서 `None` 가드를 보존하는 최소한의 정형 처방이 있어 DirectMap이 더 정확하다.

## 난이도 티어
**T1 (존나쉬움).** 이 티어로 미는 구조적 피처:
- **파일/줄수**: gold patch가 단일 파일 `django/forms/widgets.py` 1함수, 실질 3줄 삭제 + 1줄 추가. 1파일·<5줄 컷은 ~48% solve 구간의 최상단.
- **localize 직접성**: L0 — 이슈가 파일·라인·메서드·"유일한 mutate 위젯"까지 적어줘 탐색이 사실상 면제됨.
- **repro/도메인**: 이슈 본문이 트리거 시나리오(`SplitArrayField`+`BooleanField`+preexisting data, "첫 True 이후 전부 checked")를 정확히 서술 → `has-repro`에 준하는 강한 easiness 신호. 도메인 지식 불요(K-Gen).
- **P2P trap**: PASS_TO_PASS 11개가 모두 같은 `CheckboxInputTest` 클래스의 render/value_from_datadict 류로 좁고 동질적 — regression-trap 약함.

공식 라벨도 `<15 min fix`로 T1과 일치한다(이견 없음). 굳이 하향(T2)하지 않는 이유는 이슈가 픽스를 거의 받아쓰게 해주는 수준이라 T1의 "이슈가 픽스를 거의 적어줌" 프로파일에 정확히 맞기 때문.

## 골드패치 분석
- **건드린 파일·함수**: `django/forms/widgets.py` → `CheckboxInput.get_context(self, name, value, attrs)`.
- **근본 원인**: `SplitArrayWidget.get_context`는 size개의 subwidget을 동일한 `final_attrs` dict를 재사용하며 루프 렌더한다. `CheckboxInput.get_context`가 `check_test(value)`가 참일 때 `attrs['checked'] = True`로 그 공유 dict를 in-place 변형한다. 첫 `True` subwidget에서 `checked` 키가 박히면, 같은 dict 객체가 다음 subwidget으로 넘어가 `False` 항목까지 checked로 렌더된다(전형적 mutable-default/shared-arg aliasing 버그). 이슈가 지적했듯 `CheckboxInput`은 attrs를 변형하는 유일한 위젯이라 다른 위젯은 무관.
- **수정 요지**: 공유 dict를 건드리지 않고 fresh dict를 만들어 super로 전달. 기존
  ```python
  if attrs is None:
      attrs = {}
  attrs['checked'] = True
  ```
  3줄을 `attrs = {**(attrs or {}), 'checked': True}` 한 줄로 교체. `attrs or {}`가 `None`과 빈 dict를 모두 안전하게 처리하고, dict-unpacking이 호출자 dict를 복사하므로 `checked` 표시는 로컬 복사본에만 반영된다. 호출자(`SplitArrayWidget`)의 `final_attrs`는 불변으로 유지됨.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_get_context_does_not_mutate_attrs` — `attrs = {'checked': False}`를 넘기고 `get_context('name', True, attrs)` 호출 후 `attrs['checked']`가 여전히 `False`인지 `assertIs`로 단언. 픽스 전엔 `attrs['checked']`가 `True`로 덮어써져 실패, 픽스 후엔 호출자 dict가 보존돼 통과. **mutation 부수효과 자체를 직접 관찰**하는 강한 단언(렌더 출력 우회가 아니라 인자 객체를 fresh-readback).
- **추가 회귀(postgres)**: `test_checkbox_get_context_attrs` — `SplitArrayWidget(CheckboxInput(), size=2)`에 `[True, False]`를 렌더해 subwidget attrs가 정확히 `[{'checked': True}, {}]`인지 검증. 즉 둘째 `False` 위젯에 checked가 누수되지 않음을 **실제 SplitArray end-to-end 경로**로 증명(증상 발생 지점에서의 paired control). 단, 이 테스트는 FAIL_TO_PASS에 포함되지 않음(postgres 테스트는 SWE-bench 환경에서 별도 게이팅).
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇지만, 그 테스트가 "특수 케이스 통과"로 우회 불가능한 형태다 — 인자 비변형이라는 일반 불변식을 직접 검사하므로 `attrs = dict(attrs)` 같은 어떤 copy 전략이든 정답이고, special-case 하드코딩으로는 통과시킬 수 없다. 따라서 `overfit-risk` 플래그 미부여.
- **regression 관점**: PASS_TO_PASS 11개(render_true/false/none/int/empty, value_from_datadict 등)가 checked 표시 동작과 None-attrs 경로를 커버. `{**(attrs or {})}`가 `None` 케이스를 깨지 않아야 P2P가 통과 — 이게 회귀 가드.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `django/forms/widgets.py#L527` + `CheckboxInput.get_context` + "유일하게 attrs를 mutate하는 위젯"을 명시 → 곧장 해당 메서드를 열고 `attrs['checked'] = True`(공유 인자 in-place 변형) 라인을 지목. 증상이 `SplitArrayWidget`/postgres에서 나타나도 **원인은 거기로 가지 않고** CheckboxInput에 있음을 이슈가 친절히 분리해줌.
2. **픽스와 왜 올바른 일반화인가**: 변형 라인을 fresh-copy로 교체(`attrs = {**(attrs or {}), 'checked': True}`). 올바른 일반화인 이유는 — 버그의 본질이 "호출자가 넘긴 dict를 callee가 변형해 aliasing 누수"라는 일반 결함이고, 처방은 "input 인자를 mutate하지 말 것"이라는 도메인 무관 불변식이다. size=N 어떤 입력 시퀀스에도 각 subwidget이 독립 dict를 받게 되므로 `[True, False]`라는 특정 테스트 케이스를 넘어 임의 패턴에 일반화된다.
3. **regression 안전**: `attrs or {}`로 기존 `if attrs is None: attrs = {}` 가드를 보존해야 `test_render_none`/`render_empty` 등 None·빈 attrs P2P가 안 깨진다. checked 표시 자체는 그대로 유지(`'checked': True` 동일)되므로 `test_render_true`/`render_check_test` 등 정상 렌더 동작도 보존.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) 증상이 postgres `SplitArrayWidget`에서 드러나 거기서 `final_attrs`를 매 루프 복사하려 들면 잘못된 파일을 건드리고 근본원인을 놓침(이슈 포인터를 신뢰해 CheckboxInput으로 직행해야 함). (b) mutation을 copy로 바꾸되 `if attrs is None` 가드를 떨궈 `None` 입력에서 `TypeError`/None-unpack 회귀를 내는 것 — `attrs or {}`가 `None`과 빈 dict를 한 번에 흡수하는 점이 함정 회피의 핵심. (c) `attrs['checked'] = True`만 `local = dict(attrs)`류로 바꾸고 super에 여전히 원본 `attrs`를 넘기는 half-fix — 반드시 새 dict를 **전달**까지 해야 함.
