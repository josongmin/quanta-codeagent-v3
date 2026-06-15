---
instance_id: django__django-11099
repo: django/django
base_commit: d26b2424437dabeeca94d7900b37d2df4410da0c
version: "3.0"
difficulty: <15 min fix
created_at: 2019-03-20T03:46:18Z
fail_to_pass: 3
pass_to_pass: 19
gold_files: [django/contrib/auth/validators.py]
---

# django__django-11099

## 문제 요약
`ASCIIUsernameValidator`와 `UnicodeUsernameValidator`는 `r'^[\w.@+-]+$'` 정규식으로 username을 검증한다. 의도는 영숫자와 `.@+-` 문자만 허용하는 것이지만, Python 정규식에서 `$`는 문자열 끝뿐 아니라 끝에 붙은 개행(`\n`) 직전 위치에도 매치된다. 따라서 `"trailingnewline\n"` 같은 후행 개행이 포함된 username이 검증을 통과해 버린다. 사용자는 이런 username이 거부되기를 기대한다.

## 유형 분류
- 버그 카테고리: validation / edge-case (정규식 앵커 오용)
- 서브시스템: django.contrib.auth (username validators)
- 증상 타입: silent-wrong (잘못된 입력을 유효하다고 받아들임)
- 로컬라이제이션 신호: problem_statement가 `contrib.auth.validators`의 두 validator와 문제 regex `r'^[\w.@+-]+$'`, 권장 수정 `r'\A[\w.@+-]+\Z'`까지 명시 — 파일/심볼이 그대로 지목됨.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/auth/validators.py` — `ASCIIUsernameValidator.regex`, `UnicodeUsernameValidator.regex`
- 근본 원인: `$` 앵커가 multiline이 아니어도 "문자열 끝 또는 끝의 단일 `\n` 직전"에 매치되는 Python 정규식 특성. 따라서 `^[\w.@+-]+$`는 `"foo\n"`을 통과시킨다.
- 수정 요지: 두 validator의 `regex`에서 끝 앵커 `$`를 `\Z`로 교체 (`r'^[\w.@+-]+$'` → `r'^[\w.@+-]+\Z'`). `\Z`는 후행 개행을 허용하지 않고 오직 문자열의 절대 끝에만 매치하므로 후행 `\n`을 거부. (시작 앵커 `^`는 그대로 둠 — `\A`로 바꾸지 않아도 시작 측은 동작상 차이가 없어 최소 변경.)

## 검증 (test_patch)
- FAIL_TO_PASS: `test_ascii_validator`, `test_unicode_validator` (둘 다 `UsernameValidatorsTests`). `test_help_text`는 패치로 인한 부수 검증.
- 테스트가 어떻게 픽스를 증명하는지: 각 테스트의 `invalid_usernames` 목록에 후행 개행 케이스가 추가됨 — ascii는 `'trailingnewline\n'`, unicode는 `'trailingnewline
'`. 테스트는 invalid username마다 `validator(...)`가 `ValidationError`를 던지길 기대한다. 버그가 있는 `$` regex에서는 이 입력들이 통과해 예외가 발생하지 않아 FAIL, `\Z` 패치 후에는 정상적으로 거부되어 PASS.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement가 파일·심볼·수정 regex까지 다 줬으므로 `django/contrib/auth/validators.py` 직행. localization 난이도는 사실상 0.
- 함정/난이도 메모: 핵심 지식은 "`$`가 후행 개행에 매치된다"는 Python regex quirk. 이를 모르면 왜 regex를 바꿔야 하는지 못 깨닫고 검증 로직을 덧붙이는 식으로 잘못 접근할 수 있음. 또한 두 validator 모두 고쳐야 함(멀티 클래스, 단일 파일). 권장안은 `\A...\Z`이지만 골드는 끝 앵커만 `\Z`로 바꿔도 충분 — 시작은 `^` 유지.
- 우리 에이전트 관점: 1줄×2 수정의 trivial fix라 막힐 지점은 거의 없음. 유일한 리스크는 regex를 `r'\A[\w.@+-]+\Z'`로 (시작도 `\A`로) 바꾸는 변형 — 동작은 동일하고 테스트도 통과하므로 골드 파일과 diff가 달라도 FAIL_TO_PASS/PASS_TO_PASS는 모두 그린.
