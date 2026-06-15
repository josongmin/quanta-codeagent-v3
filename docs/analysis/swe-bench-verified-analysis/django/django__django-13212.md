---
instance_id: django__django-13212
repo: django/django
base_commit: f4e93919e4608cfc50849a1f764fd856e0917401
version: 3.2
difficulty: 1-4 hours
created_at: 2020-07-21T02:53:58Z
fail_to_pass: 5
pass_to_pass: 2
gold_files: [django/core/validators.py, django/forms/fields.py]
---

# django__django-13212

## 문제 요약
Django 내장 validator들이 `ValidationError`를 raise할 때 검증에 실패한 실제 값(value)을 에러에 전달하지 않아, 사용자가 커스텀 에러 메시지에서 `%(value)s` placeholder를 쓸 수 없었다. 예를 들어 "blah" is not a valid email. 같은 메시지를 만들고 싶어도 value가 params에 없어 치환이 불가능했다. 문서(ref/validators)에는 이미 `%(value)s` 사용 예시가 있는데 내장 validator들은 이를 지원하지 않는 불일치 상태였다. 기대 동작은 모든 내장 validator가 `params={'value': value}`를 넘겨 커스텀 메시지에서 값을 참조할 수 있게 하는 것.

## 유형 분류
- 버그 카테고리: API-contract / 누락처리 (ValidationError params에 value 누락)
- 서브시스템: django core validators / forms fields
- 증상 타입: silent-wrong (placeholder가 치환되지 않아 사용자가 원하는 메시지를 못 만듦; 기능 결손)
- 로컬라이제이션 신호: problem_statement이 "built-in validators provide value to ValidationError" 와 `%(value)s` placeholder를 직접 언급 → `django/core/validators.py`의 모든 `raise ValidationError(...)` 지점이 타깃임을 강하게 시사

## 골드패치 분석
- 건드린 파일/함수:
  - `django/core/validators.py`: `RegexValidator.__call__`, `URLValidator.__call__`, `EmailValidator.__call__`, `validate_ipv4_address`, `validate_ipv6_address`, `validate_ipv46_address`, `DecimalValidator.__call__`, `FileExtensionValidator.__call__`, `ProhibitNullCharactersValidator.__call__`
  - `django/forms/fields.py`: `DecimalField.validate` (제거)
- 근본 원인: 각 validator가 `raise ValidationError(self.message, code=self.code)`만 호출하고 `params`에 실패한 value를 싣지 않아, 메시지 포매팅 시 `%(value)s`를 채울 데이터 자체가 없었다.
- 수정 요지:
  - 모든 raise 지점에 `params={'value': value}`를 추가. 이미 params가 있던 `DecimalValidator`(max_digits/max_decimal_places/max_whole_digits)와 `FileExtensionValidator`(extension/allowed_extensions)는 기존 dict에 `'value': value`를 합쳐 넣음.
  - `DecimalValidator`의 'invalid'(NaN/Inf) raise에는 누락돼 있던 `code='invalid'`까지 명시적으로 추가.
  - `forms/fields.py`의 `DecimalField.validate`에서 finite 검사를 제거 — 이 검사가 value를 안 실은 채 별도로 'invalid'를 던지고 있었고, `DecimalValidator`가 이미 동일 검사를 (이제는 value 포함하여) 수행하므로 중복/약한 경로를 삭제해 단일 경로로 일원화.

## 검증 (test_patch)
- FAIL_TO_PASS: `forms_tests.tests.test_validators.ValidatorCustomMessageTests`의 char/decimal/file/integer/null_character 5개 테스트.
- 증명 방식: 각 테스트는 `error_messages={code: '%(value)s'}`로 메시지를 value만 출력하도록 오버라이드한 폼 필드를 만들고 invalid 값을 넣는다. 픽스 전에는 params에 value가 없어 KeyError 또는 미치환이 발생, 픽스 후에는 `form.errors == {'field': [value]}`로 입력값이 그대로 에러 메시지에 나타남.
  - 예: `validate_email`에 `'a'` → errors `['a']`; `validate_ipv4_address`에 `'256.1.1.1'`; DecimalField NaN/max_digits/max_decimal_places/max_whole_digits; null character `'a\0b'` → `['a\x00b']`; FileField에 `myfile.txt` 업로드 → `['myfile.txt']`. subTest로 RegexValidator/URLValidator/Min·MaxLengthValidator 등 다수 validator를 망라 검증.

## 공략 포인트 (뭘 조져야)
- 어디부터: `django/core/validators.py`에서 `raise ValidationError`를 전수 grep해 모든 지점에 value를 싣는 것이 핵심. localization은 쉬움(문제 진술이 파일·placeholder를 거의 지목).
- 함정/난이도 메모:
  - 단순 일괄치환처럼 보이지만 빠뜨리기 쉬운 케이스가 많다 — IPv4/IPv6/46 함수형 validator, ProhibitNullCharacters, FileExtension 등 클래스가 아닌 함수까지 모두 커버해야 5개 테스트가 통과.
  - 이미 `params={...}`가 있는 raise(DecimalValidator, FileExtensionValidator)는 덮어쓰지 말고 value를 병합해야 함.
  - DecimalValidator 'invalid'에는 원래 `code`가 없어 `code='invalid'`를 같이 넣어야 테스트의 `error_messages={'invalid': ...}` 오버라이드가 먹힘.
  - 멀티파일: `forms/fields.py`의 `DecimalField.validate` 중복 검사 제거를 놓치면 NaN 케이스에서 value 없는 옛 경로가 먼저 터져 decimal 테스트가 실패할 수 있음 — validators.py만 고치면 불완전.
- 우리 에이전트 관점: "한 줄 추가"로 보여 일부 raise만 고치고 끝낼 위험이 큼. 전수성(모든 raise + 함수형 validator) 확보와, 겉보기 무관해 보이는 `DecimalField.validate` 삭제까지 연결짓는 cross-file 추론이 막힐 지점.
