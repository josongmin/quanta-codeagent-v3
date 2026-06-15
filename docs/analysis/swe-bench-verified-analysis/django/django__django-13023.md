---
instance_id: django__django-13023
repo: django/django
base_commit: f83b44075dafa429d59e8755aa47e15577cc49f9
version: 3.2
difficulty: <15 min fix
created_at: 2020-06-04T20:40:44Z
fail_to_pass: 2
pass_to_pass: 9
gold_files: [django/db/models/fields/__init__.py]
---

# django__django-13023

## 문제 요약
`DecimalField.to_python()`에 dict 같은 값을 넘기면 `ValidationError`가 아니라 `TypeError`가 발생한다. 예를 들어 실수로 decimal 필드에 딕셔너리를 세팅한 모델 객체를 저장하려 하면, 사용자는 "어떤 필드가 잘못됐는지" 알려주는 깔끔한 ValidationError를 기대하지만, 대신 raw TypeError가 튀어나와 필드가 많은 객체에서는 원인 추적이 어렵다. 기대 동작은 잘못된 타입도 다른 invalid 값과 동일하게 ValidationError로 정규화되는 것.

## 유형 분류
- 버그 카테고리: 누락처리 (예외 처리 범위 누락) / edge-case
- 서브시스템: django ORM model fields (`DecimalField`)
- 증상 타입: 예외 (잘못된 예외 타입 — TypeError가 ValidationError를 우회)
- 로컬라이제이션 신호: problem_statement가 `DecimalField.to_python()`를 명시적으로 지목 + PR 링크까지 제공. 함수명이 그대로 골드 파일/함수로 직결되는 매우 강한 단서.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/fields/__init__.py` : `DecimalField.to_python`
- 근본 원인: `to_python`은 `decimal.Decimal(value)` 변환 실패를 `except decimal.InvalidOperation`으로만 잡아 ValidationError로 변환했다. 그러나 `Decimal()` 생성자는 dict/list/set/object 등 변환 불가 타입에 대해서는 `InvalidOperation`이 아니라 `TypeError`를, 일부 입력은 `ValueError`를 던진다. 이 두 예외가 except 절을 빠져나가 호출자에게 그대로 전파됐다.
- 수정 요지: except 절을 `except (decimal.InvalidOperation, TypeError, ValueError)`로 확장. 한 줄짜리 변경으로 모든 비-decimal 변환 실패가 동일한 `ValidationError(self.error_messages['invalid'], code='invalid', ...)`로 정규화되도록 했다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_invalid_value` 신규 추가. 기존 `test_to_python` 안의 `'abc'` 단일 케이스를 떼어내 별도 메서드로 만들고, `()`, `[]`, `{}`, `set()`, `object()`, `complex()`, 비숫자 문자열/바이트문자열 8종을 `subTest`로 순회한다. `test_lookup_really_big_value`도 함께 통과 대상(인접 회귀 보장).
- 증명 방식: 각 잘못된 값에 대해 `field.clean(value, None)`을 호출하고 `assertRaisesMessage(ValidationError, '“%s” value must be a decimal number.' % value)`로 검증. 즉 dict/object 등 이전엔 TypeError를 내던 입력이 이제 정확한 메시지의 ValidationError를 던지는지 확인한다.

## 공략 포인트 (뭘 조져야)
- 어디부터: problem_statement가 `DecimalField.to_python()`를 직접 지명하므로 `django/db/models/fields/__init__.py`에서 클래스 `DecimalField`의 `to_python` 메서드 내 `decimal.Decimal(value)` try/except를 바로 찾으면 된다. localization은 거의 공짜.
- 함정/난이도: 핵심은 "어떤 예외를 추가로 잡아야 하나" 판단. `Decimal(dict)` → TypeError, 일부 문자열/`complex()` → ValueError 또는 InvalidOperation을 실제로 재현해 확인하지 않으면, TypeError만 추가하고 ValueError를 빠뜨리기 쉽다. 골드는 둘 다 추가했다. 또 `to_python` 상단의 `value is None` / float 분기는 건드리면 안 됨 — except 절만 좁게 수정.
- 우리 에이전트 관점: 단일 파일 단일 라인 수정이라 난이도는 낮음. 막힐 만한 지점은 (1) except에 TypeError만 넣고 ValueError를 누락해 일부 케이스가 여전히 새는 경우, (2) try 범위를 넘겨 짚어 `create_decimal_from_float` 경로까지 과하게 감싸는 경우. 실제 `Decimal()` 동작을 검증해 추가 예외 집합을 정확히 좁히는 게 관건.
