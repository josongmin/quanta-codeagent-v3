---
instance_id: django__django-14534
repo: django/django
base_commit: 910ecd1b8df7678f45c3d507dde6bcb1faafa243
version: "4.0"
difficulty: <15 min fix
created_at: 2021-06-17T15:37:34Z
fail_to_pass: 2
pass_to_pass: 118
gold_files: [django/forms/boundfield.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-14534

## 문제 요약
`CheckboxSelectMultiple` 같은 위젯의 서브위젯을 렌더링할 때, `BoundWidget.id_for_label`이 `'id_%s_%s' % (self.data['name'], self.data['index'])` 형태로 id를 직접 재조립한다. 그래서 폼 초기화 시 `auto_id`를 커스텀 포맷(예: `'prefix_%s'`)으로 넘겨도 서브위젯 label의 id에는 그 prefix가 전혀 반영되지 않는다. 반면 `BoundField.subwidgets`는 이미 `auto_id`/widget attrs를 반영한 실제 id를 계산해 `self.data['attrs']['id']`에 담아 두고 있다. 사용자는 이 계산된 id가 label에도 그대로 쓰이길 기대하며, problem_statement에 픽스 코드(`return self.data['attrs']['id']`)까지 직접 적어 두었다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed).** problem_statement가 `BoundField.subwidgets`와 `BoundWidget.id_for_label` 두 메서드를 코드까지 인용하고 "this has nothing to do with `BoundField.id_for_label()`"라고 혼동 지점까지 명시. `django/forms/boundfield.py`의 `BoundWidget` 클래스로 grep 한 방에 수렴. 단일 파일·단일 함수·단일 라인.
- **S (Repair Strategy) = S1 Direct-Map (+S2 보조).** 이슈가 사실상 픽스를 명세("By changing the code ... to `return self.data['attrs']['id']`")하므로 기계적 매핑(S1)이 dominant. 다만 골드는 이슈가 적어준 직접 인덱싱 대신 `.get('id')`를 써서 `auto_id=False`(attrs에 id 부재) 케이스의 KeyError를 회피 → "id 없으면 None"이라는 불변식을 추론으로 보강한 **S2가 얇게 동반**. 즉 이슈 그대로 베끼면 회귀가 나는, S1 위에 한 톨의 엣지 추론이 얹힌 형태.
- **K (Knowledge) = K-Domain.** django forms의 `BoundField` → `subwidgets` → `widget.subwidgets()`가 dict를 만들어 `BoundWidget.data`로 흐르고, 그 `data['attrs']['id']`가 무엇인지 이해하려면 forms 렌더링 파이프라인 내부 지식이 필요. 일반 파이썬 추론만으론 "왜 attrs에 이미 옳은 id가 있는가"를 못 짚음.
- **Primary = T-DirectMap.** 위치가 완전히 명확하고(L0) 픽스가 기계적 한 줄 교체(S1)다. 위치 찾기가 어려운 T-DiffuseLoc도, 식을 처음부터 합성하는 T-ConstraintReason도 아니다 — 올바른 식이 이슈에 적혀 있다. K-Domain이 끼지만 병목은 지식이 아니라 "이슈가 지목한 한 줄을 정확히 옮기는 것"이라 T-DomainBound로 올리지 않는다.

## 난이도 티어
**Tier = T2 (쉬움).** 공식 라벨은 `<15 min fix`로 T1~T2 prior. 다음 구조적 피처가 T2로 민다:
- 파일 1개 / 함수 1개 / 변경 1줄 — patch scope 최소(1파일·<5줄 ≈ 48% solve 구간).
- L0 + has-repro(problem_statement에 재현 코드와 기대 출력이 모두 있음) → localize 비용 거의 0.
- **T1로 안 내리는 이유:** 이슈가 적어준 직접 인덱싱(`self.data['attrs']['id']`)을 그대로 쓰면 `test_iterable_boundfield_select`(`auto_id=False`)에서 attrs에 id가 없어 KeyError로 깨질 수 있고, 무엇보다 그 P2P/F2P가 기대값을 `'id_name_0'` → `None`으로 **바꾸는** 회귀 테스트라 `.get()`으로의 미세 일반화가 필요. 이슈를 글자 그대로 베끼면 안 되는 한 톨의 엣지가 있어 "픽스 자명(T1)"보다 한 칸 위.
- regression-trap이 가벼운 게 아님: PASS_TO_PASS 118개에 `test_boundfield_id_for_label`, `test_form_with_iterable_boundfield_id`, `test_id_on_field` 등 인접 id 동작이 다수 포함되어, label-id 의미를 바꾸되 인접 경로를 안 깨야 함.
- 공식 `<15 min fix`(개발자 구현시간)과 본질적으로 부합. 에이전트 관점에서 굳이 차이를 두자면 위 "이슈를 그대로 베끼면 회귀" 함정이 시간라벨엔 안 잡힌다는 점 정도.

## 골드패치 분석
- **건드린 파일/함수:** `django/forms/boundfield.py` — `BoundWidget.id_for_label` (property).
- **근본 원인:** `BoundField.subwidgets`는 `id_ = self.field.widget.attrs.get('id') or self.auto_id` → `attrs = {'id': id_}`를 만들어 `self.field.widget.subwidgets(...)`에 넘기고, 그 결과 dict가 `BoundWidget.data`가 되어 `self.data['attrs']['id']`에 **이미 auto_id/widget-attrs를 반영한 올바른 id**가 담긴다. 그런데 `id_for_label`은 이 값을 무시하고 `name`과 `index`로 `'id_%s_%s'`를 새로 합성 → 커스텀 `auto_id` 포맷도, widget attrs id override도 전부 누락된다. 동일 정보의 중복·불일치 재구현이 근본 결함.
- **수정 요지:** 합성 로직을 제거하고 이미 계산된 attrs의 id를 그대로 반환.
  ```python
  -        return 'id_%s_%s' % (self.data['name'], self.data['index'])
  +        return self.data['attrs'].get('id')
  ```
  `.get('id')`를 써서 attrs에 id가 없을 때(예: `auto_id=False`) KeyError 대신 `None`을 반환하도록 안전 처리.

## 검증 (test_patch)
- **FAIL_TO_PASS (2):**
  1. `test_boundfield_subwidget_id_for_label` (신규): `MultipleChoiceField` + `CheckboxSelectMultiple` 폼을 `auto_id='prefix_%s'`로 생성 → `subwidgets[0].id_for_label == 'prefix_field_0'`, `subwidgets[1].id_for_label == 'prefix_field_1'`. 커스텀 prefix가 서브위젯 label id에 실제로 반영되는지 증명.
  2. `test_iterable_boundfield_select` (수정): `auto_id=False`일 때 첫 옵션의 `id_for_label` 기대값을 과거 하드코딩 `'id_name_0'`에서 `None`으로 변경. attrs에 id가 없으면 `.get('id')`가 `None`을 반환함을 고정.
- **픽스 증명:** 픽스 전에는 항상 `'id_%s_%s'`로 합성 → 케이스1에서 prefix를 못 받아 `'id_field_0'`류가 나와 실패하고, 케이스2에서도 id 부재 상황에 가짜 `'id_name_0'`을 만들어내 새 기대값 `None`과 불일치. 픽스 후엔 attrs를 그대로 읽으므로 둘 다 통과.
- **overfit 관점:** F2P가 2개뿐이지만 (a) "포맷 반영"(case1, 양성)과 (b) "id 부재→None"(case2, 음성) 두 방향을 동시에 고정해 special-case 통과를 차단 → overfit 위험 낮음. attrs를 신뢰하는 단일 책임 구조라 미검증 입력공간도 작다. `overfit-risk` 플래그 미부여.
- **regression 관점:** `regression-trap` — PASS_TO_PASS 118개에 `test_boundfield_id_for_label`, `test_form_with_iterable_boundfield`, `test_form_with_iterable_boundfield_id`, `test_multiple_choice_checkbox`, `test_checkbox_auto_id` 등 인접 id/렌더 동작이 다수. `BoundWidget`(서브위젯)만 바꾸고 `BoundField.id_for_label`(별개 메서드)은 건드리지 않아야 이들이 보존됨.

## 모범답안 (오라클 기반)
1. **localize 경로:** problem_statement가 `BoundField.subwidgets`(데이터 출처)와 `BoundWidget.id_for_label`(결함 위치)을 코드까지 인용하고 "this has nothing to do with `BoundField.id_for_label()`"로 혼동 지점을 명시. → `django/forms/boundfield.py`에서 `class BoundWidget`의 `id_for_label`로 직행. grep `id_for_label`이면 `BoundField`/`BoundWidget` 두 정의가 뜨는데, 이슈가 어느 쪽인지 못 박아 줘 오판 여지가 없다.
2. **픽스와 왜 올바른 일반화인가:** `data['attrs']['id']`는 `subwidgets`가 `auto_id`/widget attrs/`build_widget_attrs`를 모두 거쳐 산출한 **단일 진실원(SSOT)**. 여기를 그대로 반환하면 prefix/override/부재가 자동으로 일관되게 흐른다. `'id_%s_%s'` 합성은 그 SSOT를 무시한 중복 재구현이므로 제거가 맞다. 직접 인덱싱(`['id']`)이 아니라 `.get('id')`로 받는 게 핵심 일반화 — attrs에 id가 아예 없는 경우(`auto_id=False`)를 None으로 흡수하므로 "id 있으면 그 값, 없으면 없음"이라는 전 케이스 불변식을 만족한다. 특정 테스트값을 맞추는 게 아니라 데이터플로우를 정상화한 것이라 overfit이 아니다.
3. **regression 안전:** `BoundWidget.id_for_label`만 바꾸고 `BoundField.id_for_label`은 불변 → `test_boundfield_id_for_label`, `test_boundfield_label_tag_custom_widget_id_for_label` 등 폼-필드 레벨 id 동작 보존. 서브위젯이 아닌 일반 위젯/체크박스 렌더(`test_checkbox_auto_id`, `test_form_with_iterable_boundfield_id`, `test_multiple_choice_checkbox`)는 attrs id 계산 경로가 그대로라 영향 없음. 118개 P2P가 이 격리를 검증한다.
4. **함정 회피:** 오라클 없는 에이전트가 틀릴 두 지점 — (a) `BoundField.id_for_label`을 잘못 고침(이슈가 명시적으로 배제한 메서드). 클래스명을 정확히 보고 `BoundWidget`만 건드려야 함. (b) "기존 동작을 깨면 안 된다"는 과방어로 `self.data['attrs'].get('id') or 'id_%s_%s' % (...)` 같은 폴백을 남기는 것 — 그러면 `auto_id=False`에서 None 대신 `'id_name_0'`이 나와 `test_iterable_boundfield_select`가 실패한다. 골드처럼 합성을 **완전히 제거**하고 attrs만 신뢰하는 게 정답. 또 이슈가 적어준 `['id']` 직접 인덱싱을 글자 그대로 베끼면 KeyError 위험이 있으니 `.get()`으로 바꿔야 한다.
