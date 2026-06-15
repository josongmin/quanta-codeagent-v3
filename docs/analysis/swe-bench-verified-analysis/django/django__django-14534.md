---
instance_id: django__django-14534
repo: django/django
base_commit: 910ecd1b8df7678f45c3d507dde6bcb1faafa243
version: 4.0
difficulty: <15 min fix
created_at: 2021-06-17T15:37:34Z
fail_to_pass: 2
pass_to_pass: 118
gold_files: [django/forms/boundfield.py]
---

# django__django-14534

## 문제 요약
`CheckboxSelectMultiple` 같은 위젯의 서브위젯을 렌더링할 때, `BoundWidget.id_for_label`이 `'id_%s_%s' % (name, index)` 형태로 id를 직접 재조립한다. 그래서 폼 초기화 시 `auto_id`를 커스텀 포맷(예: `'prefix_%s'`)으로 넘겨도 서브위젯의 label id에는 그 prefix가 전혀 반영되지 않는다. 사용자는 `BoundField.subwidgets`가 이미 계산해 `self.data['attrs']['id']`에 담아 둔 실제 id가 label에도 그대로 쓰이길 기대한다.

## 유형 분류
- 버그 카테고리: API-contract (id 생성 규약 불일치) + 누락처리 (이미 계산된 attrs 무시)
- 서브시스템: django forms / BoundField·BoundWidget 렌더링
- 증상 타입: silent-wrong (예외 없이 잘못된 label id 출력)
- 로컬라이제이션 신호: problem_statement가 `BoundField.subwidgets`와 `BoundWidget.id_for_label` 두 메서드를 코드까지 인용하고, "this has nothing to do with `BoundField.id_for_label()`"라고 명시 → 곧장 `django/forms/boundfield.py`의 `BoundWidget` 클래스로 좁혀짐.

## 골드패치 분석
- 건드린 파일/함수: `django/forms/boundfield.py` : `BoundWidget.id_for_label`
- 근본 원인: `BoundField.subwidgets`는 `attrs={'id': id_}` (auto_id/widget attrs 기반)를 만들어 위젯 subwidget에 넘기고, 그 결과가 `self.data['attrs']['id']`에 들어간다. 그런데 `id_for_label`은 이 값을 쓰지 않고 `name`과 `index`로 `'id_%s_%s'`를 새로 합성 → auto_id 포맷·widget id override가 무시됨.
- 수정 요지: 한 줄 교체.
  ```python
  return self.data['attrs'].get('id')
  ```
  로 바꿔, 이미 계산된 attrs의 id를 그대로 반환. `.get()`을 써서 id가 없으면 (예: `auto_id=False`) `None`을 반환하도록 안전 처리.

## 검증 (test_patch)
- FAIL_TO_PASS:
  1. `test_boundfield_subwidget_id_for_label` (신규): `MultipleChoiceField` + `CheckboxSelectMultiple` 폼을 `auto_id='prefix_%s'`로 생성 → `subwidgets[0].id_for_label == 'prefix_field_0'`, `subwidgets[1].id_for_label == 'prefix_field_1'`. 즉 커스텀 prefix가 서브위젯 id에 반영되는지 증명.
  2. `test_iterable_boundfield_select` (수정): `auto_id=False`일 때 첫 옵션의 `id_for_label`이 과거 `'id_name_0'` 하드코딩 → 이제 `None`이어야 함. attrs에 id가 없으면 `.get('id')`가 `None`을 반환함을 고정.
- 증명 방식: 픽스 전에는 항상 `id_%s_%s`로 합성되어 prefix를 못 받고(케이스1 실패), auto_id 없을 때도 가짜 id를 만들어냄(케이스2 불일치). 픽스 후 attrs를 그대로 읽으므로 둘 다 통과.

## 공략 포인트 (뭘 조져야)
- 어디부터: `django/forms/boundfield.py`의 `BoundWidget` 클래스. problem_statement가 클래스/메서드명을 직접 줘서 grep 한 번이면 도달.
- 함정/난이도: (1) `BoundField.id_for_label`(다른 메서드)과 혼동 금지 — 고쳐야 할 건 `BoundWidget`쪽. (2) `self.data['attrs']['id']` 직접 인덱싱 대신 `.get('id')`를 써야 `auto_id=False`(id 부재) 케이스에서 KeyError 없이 `None` 반환. (3) 멀티파일 아님, 단일 라인 변경.
- 우리 에이전트 관점: 픽스 난이도는 낮지만, FAIL_TO_PASS의 `test_iterable_boundfield_select`가 기대값을 `'id_name_0'` → `None`으로 **바꾸는** 회귀 테스트라, 에이전트가 "기존 동작을 깨면 안 된다"고 과하게 방어해 `id_%s_%s` 폴백을 남기면 이 테스트가 실패한다. 골드처럼 합성을 완전히 제거하고 attrs만 신뢰하는 게 정답.
