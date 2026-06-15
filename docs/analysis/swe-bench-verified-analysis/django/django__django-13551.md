---
instance_id: django__django-13551
repo: django/django
base_commit: 7f9e4524d6b23424cf44fbe1bf1f4e70f6bb066e
version: 3.2
difficulty: <15 min fix
created_at: 2020-10-17T17:22:01Z
fail_to_pass: 2
pass_to_pass: 56
gold_files: [django/contrib/auth/tokens.py]
---

# django__django-13551

## 문제 요약
패스워드 리셋 토큰이 발급된 후 사용자가 이메일 주소를 바꾸면, 발급된(미사용) 리셋 토큰이 무효화되어야 하는데 여전히 유효하게 통과된다. 시나리오: foo@ 계정으로 리셋 요청 → 계정이 이메일을 변경 → 기존 리셋 메일의 토큰을 사용하면 거부되어야 하지만 허용된다. 사용자는 `PasswordResetTokenGenerator._make_hash_value()`의 해시 입력에 이메일을 포함시켜 이메일 변경 시 토큰이 무효화되기를 기대한다.

## 유형 분류
- 버그 카테고리: 누락처리 (보안 관련 상태 누락 — 해시 입력에서 email 빠짐)
- 서브시스템: django.contrib.auth / 패스워드 리셋 토큰 생성
- 증상 타입: silent-wrong (무효화되어야 할 토큰이 조용히 유효 처리됨, 보안 결함)
- 로컬라이제이션 신호: problem_statement가 `PasswordResetTokenGenerator._make_hash_value()`를 직접 지목하고 "이메일을 해시에 추가하라"고 명시. `get_session_auth_hash()` 패턴 언급이 모델 팩토링 힌트지만 골드는 그건 안 함.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/auth/tokens.py:PasswordResetTokenGenerator._make_hash_value`
- 근본 원인: 토큰 해시가 `pk + password + last_login + timestamp`만 사용해 이메일을 포함하지 않았다. 이메일 변경은 password/last_login을 건드리지 않으므로 해시가 그대로 유지되어 발급된 토큰이 계속 유효했다.
- 수정 요지: `user.get_email_field_name()`으로 이메일 필드명을 얻고 `getattr(user, email_field, '') or ''`로 값을 추출(이메일이 없거나 None이어도 안전). 반환을 f-string `f'{user.pk}{user.password}{login_timestamp}{timestamp}{email}'`로 바꿔 해시 입력 끝에 email을 추가. AbstractBaseUser는 이메일을 강제하지 않으므로 `get_email_field_name()` + `or ''`로 email 미보유/null 케이스를 방어. docstring도 "email (if available)" 포함하도록 갱신.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_token_with_different_email` ("Updating the user email address invalidates the token.") 및 `test_token_with_different_secret`.
- 테스트가 어떻게 픽스를 증명하는지: `test_token_with_different_email`은 `(CustomEmailField, None)`, `(CustomEmailField, 'test4@example.com')`, `(User, 'test4@example.com')` 세 케이스를 subTest로 돌린다. 각각 유저 생성 → `make_token`으로 tk1 발급 → `check_token(user, tk1)`가 True인지 확인 → `setattr(user, user.get_email_field_name(), 'test4new@example.com')`로 이메일 변경 후 save → 같은 토큰 `check_token`이 **False**여야 한다. 픽스 전에는 해시에 email이 없어 변경 후에도 True라 실패. 보조로 `with_custom_email_field.py`의 `email_address`를 `null=True`로 바꿔 이메일이 없는(None) 케이스도 커버한다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement가 함수명을 그대로 줘서 로컬라이제이션은 매우 쉽다. `django/contrib/auth/tokens.py`의 `_make_hash_value` 단일 함수.
- 함정/난이도 메모: (1) `user.email`을 직접 쓰면 커스텀 유저 모델(EMAIL_FIELD가 다른 필드명)에서 깨진다 — 반드시 `get_email_field_name()` 사용. (2) AbstractBaseUser는 이메일이 없을 수 있고 null일 수도 있어 `getattr(..., '') or ''`로 None/미존재 둘 다 방어해야 한다. (3) 해시 입력 순서/포맷을 바꾸면 기존 발급 토큰이 전부 무효화되지만, 이는 의도된 보안 동작이라 OK. 단일 파일·단일 함수라 멀티파일 위험은 없음.
- 우리 에이전트 관점: 막힐 지점은 거의 없으나, `user.email` 하드코딩 같은 순진한 구현으로 PASS_TO_PASS(커스텀 이메일 필드 테스트)나 None 케이스를 깨뜨릴 수 있다. `get_email_field_name()` + `or ''` 방어가 정답임을 인지하는 것이 품질 분기점.
