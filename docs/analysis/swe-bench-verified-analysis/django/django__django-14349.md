---
instance_id: django__django-14349
repo: django/django
base_commit: a708f39ce67af174df90c5b5e50ad1976cec7cb8
version: 4.0
difficulty: 15 min - 1 hour
created_at: 2021-05-04T20:10:27Z
fail_to_pass: 1
pass_to_pass: 18
gold_files: [django/core/validators.py]
---

# django__django-14349

## 문제 요약
`URLValidator`가 LF/CR/Tab 문자를 포함한 URL을 ValidationError로 거부하는 동작이 bpo-43882 패치가 적용된 Python(3.9.5+, 3.10.0b1)에서 깨졌다. 기존 Django는 `urlsplit`으로 쪼갠 URL 컴포넌트를 보고 거부했는데, bpo-43882 픽스가 split 전에 LF/CR/Tab을 모두 silently strip하면서 이 문자들이 validator까지 도달하지 못한다. 그 결과 `http://www.djangoproject.com/\n` 같은 입력이 통과돼버려 `test_validators`가 "ValidationError not raised"로 실패한다.

## 유형 분류
- 버그 카테고리: regression / 누락처리 (상류 stdlib 동작 변경에 대한 방어 부재)
- 서브시스템: django core validators (URL 검증)
- 증상 타입: silent-wrong (위험한 URL이 검증을 통과)
- 로컬라이제이션 신호: problem_statement에 실패 테스트가 `validators.tests.TestValidators [URLValidator]`로 명시되고 클래스명 `URLValidator`가 직접 언급됨 → `django/core/validators.py`의 `URLValidator`로 바로 직결.

## 골드패치 분석
- 건드린 파일/함수: `django/core/validators.py` : `URLValidator` (클래스 속성 추가 + `__call__`)
- 근본 원인: Django는 LF/CR/Tab 제거를 stdlib `urlsplit` 동작에 암묵적으로 의존했다. bpo-43882가 이 strip 시점을 split 이전으로 옮기면서, 정규식 검증에 도달하기 전 위험 문자가 사라져 거부 로직이 우회됨.
- 수정 요지: `URLValidator`에 클래스 속성 `unsafe_chars = frozenset('\t\r\n')`를 추가하고, `__call__`의 str 타입 체크 직후에 `if self.unsafe_chars.intersection(value): raise ValidationError(...)`를 넣어 split/정규식 검증 이전에 명시적으로 조기 거부한다. stdlib 동작에 의존하지 않고 Django가 직접 차단하는 방향(첫 번째 옵션)을 택함.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_validators (validators.tests.TestValidators)` — URL 검증 케이스 테이블 기반 파라미터 테스트.
- 테스트가 증명하는 방법: `tests/validators/tests.py`의 케이스 테이블에 trailing `\n`뿐 아니라 `\r`, 그리고 URL 중간(`http://www.django\rproject.com/`, `http://[::\rffff:192.9.5.5]`)과 선두(`http://\twww.djangoproject.com/`)에 위치한 CR/Tab 케이스까지 추가해 모두 `ValidationError` 기대값으로 등록. strip-before-split이 적용된 Python에서도 `unsafe_chars.intersection` 조기 거부가 있어야만 이들이 거부되므로, 픽스 없이는 통과 못 하고 픽스 후 전부 통과.

## 공략 포인트 (뭘 조져야)
- localization 전략: `URLValidator` 단일 클래스가 정답지. `django/core/validators.py`에서 `class URLValidator`의 `__call__`만 보면 됨. 단일 파일·단일 메서드.
- 함정/난이도 메모: 정규식 `regex` 패턴을 손대 LF/CR/Tab을 잡으려 하면 함정이다 — bpo-43882 환경에서는 그 문자들이 정규식에 도달하기 전에 사라지므로 정규식 수정은 무효. 반드시 split/regex "이전" 단계에서 raw `value`를 검사해야 한다. 또 trailing 케이스만 막으면(예: `value.endswith`) 중간/선두 삽입 케이스를 놓침 — `intersection` 같은 위치 무관 검사가 필요.
- 우리 에이전트 관점: 막힐 지점은 "왜 기존 정규식이 안 잡냐"의 원인 분석. 환경별(Python 버전별) 동작 차이라 로컬에서 재현이 안 되면 문제를 못 느낄 수 있다. problem_statement이 원인(strip-before-split)과 권장 해법(early reject vs silent strip)을 친절히 설명하므로 이를 읽고 "조기 거부, 위치 무관 검사"를 도출하는 게 핵심.
