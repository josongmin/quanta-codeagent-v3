---
instance_id: django__django-12308
repo: django/django
base_commit: 2e0f04507b17362239ba49830d26fec504d46978
version: 3.1
difficulty: <15 min fix
created_at: 2020-01-12T04:21:15Z
fail_to_pass: 2
pass_to_pass: 20
gold_files: [django/contrib/admin/utils.py]
---

# django__django-12308

## 문제 요약
admin에서 `JSONField`가 readonly로 표시될 때 값이 파이썬 dict의 `repr`로 그대로 출력된다. 예를 들어 `{"foo": "bar"}`가 `{'foo': 'bar'}`로 보이는데, 이는 작은따옴표 때문에 유효한 JSON이 아니다. 사용자는 readonly admin에서도 정상적인 JSON 문자열(`{"foo": "bar"}`)이 표시되기를 기대한다.

## 유형 분류
- 버그 카테고리: 누락처리 (display 분기에서 JSONField 케이스 미존재) / API-contract
- 서브시스템: django contrib.admin (utils의 display 헬퍼)
- 증상 타입: silent-wrong (예외 없이 잘못된 포맷으로 출력)
- 로컬라이제이션 신호: problem_statement가 명시적으로 `django.contrib.admin.utils.display_for_field`에 special case를 추가하라고 지목, 그리고 `prepare_value`/`json.dumps`/`InvalidJSONInput`을 언급 → 파일·함수가 거의 직접 주어짐.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/admin/utils.py:display_for_field`
- 근본 원인: `display_for_field`의 isinstance 분기 사다리에 `JSONField` 케이스가 없어, 모든 비특수 타입처럼 `else` 가지에서 `display_for_value`로 떨어지고 결국 dict가 `str()`/`repr` 형태로 직렬화되어 JSON이 아닌 문자열이 됨.
- 수정 요지: `FileField` 분기 다음에 `elif isinstance(field, models.JSONField) and value:` 분기를 추가. 정상 케이스는 `field.get_prep_value(value)`로 직렬화해 올바른 JSON 문자열을 반환하고, 직렬화 불가능한 입력(예: 튜플 키처럼 JSON으로 못 만드는 값)에 대해서는 `TypeError`를 catch하여 기존 `display_for_value(value, empty_value_display)` 폴백으로 처리. `json.dumps` 직접 호출 대신 필드 메서드를 써서 `InvalidJSONInput` 케이스를 자연스럽게 흡수.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_json_display_for_field` (신규) + `test_label_for_field`.
- `test_json_display_for_field`는 `display_for_field(value, models.JSONField(), empty_value)`에 대해 4쌍을 검증: `{'a': {'b': 'c'}}` → `'{"a": {"b": "c"}}'`, `['a','b']` → `'["a", "b"]'`, `'a'` → `'"a"'` (큰따옴표 JSON), 그리고 invalid JSON인 `{('a','b'): 'c'}` → 파이썬 repr `"{('a', 'b'): 'c'}"` (폴백 경로).
- `test_null_display_for_field`에도 `JSONField`에 None을 주면 `empty_value`가 나오는 케이스 추가 → `and value` 가드로 None은 분기에 안 들어가고 폴백되는 동작을 증명.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement가 파일·함수·메서드 이름까지 다 줬으므로 `display_for_field` 한 곳만 보면 됨. 단일 파일·단일 함수 수정.
- 함정/난이도 메모: (1) `json.dumps`를 직접 쓰면 `InvalidJSONInput`/직렬화 불가 케이스에서 깨짐 → `get_prep_value` + `TypeError` 폴백이 정석. (2) hints_text가 경고하듯 타입명 문자열 비교나 contrib.postgres 결합은 brittle하고 상속을 못 다룸 → 반드시 `models.JSONField` isinstance 체크여야 함(이 버전 3.1은 #12990로 `django.db.models.JSONField`가 존재). (3) None 가드(`and value`) 누락 시 null 케이스 회귀.
- 우리 에이전트 관점: 막힐 지점은 폴백 설계. 그냥 `format_html`/`json.dumps`로 해결하려다 invalid-JSON 입력에서 예외가 나거나 잘못 표시될 수 있음. 분기 위치(FileField 뒤, 최종 else 앞)와 `try/except TypeError`의 정확한 폴백 대상(`display_for_value`)을 맞추는 게 핵심.
