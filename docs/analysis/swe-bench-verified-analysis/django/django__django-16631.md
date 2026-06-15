---
instance_id: django__django-16631
repo: django/django
base_commit: 9b224579875e30203d079cc2fee83b116d98eb78
version: 5.0
difficulty: 1-4 hours
created_at: 2023-03-06T15:19:52Z
fail_to_pass: 1
pass_to_pass: 12
gold_files: [django/contrib/auth/__init__.py, django/contrib/auth/base_user.py]
---

# django__django-16631

## 문제 요약
사용자가 `SECRET_KEY`를 회전(rotate)하면서 이전 키를 `SECRET_KEY_FALLBACKS`에 넣었는데, 사이트의 모든 사용자가 로그아웃되어 버렸다. 문서는 fallback 키가 세션을 유지시켜 준다고 설명하지만, 실제로는 세션 인증 해시 검증에 fallback 키가 전혀 쓰이지 않는다. `AbstractBaseUser.get_session_auth_hash`가 `salted_hmac`을 호출할 때 `secret` 인자를 넘기지 않아 항상 현재 `SECRET_KEY`로만 해시를 계산하기 때문이다.

## 유형 분류
- 버그 카테고리: 누락처리 (fallback secret 경로 미구현) / API-contract (문서와 동작 불일치)
- 서브시스템: django.contrib.auth (세션 인증 / secret key rotation)
- 증상 타입: silent-wrong (세션이 조용히 무효화되어 전원 로그아웃)
- 로컬라이제이션 신호: problem_statement가 직접 `salted_hmac`, `AbstractBaseUser.get_session_auth_hash`를 지목하고, "sessions"라는 단어 → 세션 검증 진입점인 `auth.get_user(request)`까지 연결됨.

## 골드패치 분석
- 건드린 파일/함수:
  - `django/contrib/auth/base_user.py`: `get_session_auth_hash` / 신규 `get_session_auth_fallback_hash` / 신규 `_get_session_auth_hash(secret=None)`
  - `django/contrib/auth/__init__.py`: `get_user(request)`
- 근본 원인: `get_session_auth_hash`가 `salted_hmac(..., secret=...)`를 지정하지 않아 현재 `SECRET_KEY`로만 HMAC을 만든다. 따라서 키 회전 후 fallback에 있는 구 키로 만들어진 기존 세션 해시는 검증에서 무조건 불일치 → `session.flush()`로 세션이 날아간다.
- 수정 요지:
  1. `base_user.py`에서 해시 계산 로직을 `_get_session_auth_hash(secret=None)`로 분리하고 `salted_hmac`에 `secret`을 전달. `get_session_auth_hash`는 기본(현재 키) 해시를 반환.
  2. `get_session_auth_fallback_hash` 제너레이터를 추가해 `settings.SECRET_KEY_FALLBACKS` 각 키로 해시를 yield.
  3. `__init__.get_user`에서 현재 키 검증 실패 시 곧바로 flush하지 않고, fallback 해시 중 하나라도 `constant_time_compare`로 일치하면 `request.session.cycle_key()` 후 세션 해시를 **현재 키 해시(`session_auth_hash`)로 갱신**(업그레이드)하여 로그인 유지.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_get_user_fallback_secret` (auth_tests.test_basic.TestGetUser)
- 증명 방식:
  - 사용자를 로그인시켜 세션을 만든 뒤, `override_settings(SECRET_KEY="newsecret", SECRET_KEY_FALLBACKS=[기존 SECRET_KEY])`로 키 회전 상황을 흉내낸다.
  - `get_user(request)`가 여전히 올바른 User를 반환하고(로그아웃 안 됨), `session_key`가 이전 값과 달라졌는지(`cycle_key`로 키 재발급 + 해시 업그레이드 발생) 확인.
  - 이어서 `override_settings(SECRET_KEY="newsecret")`(fallback 제거)만으로도 다시 `get_user`가 정상 User를 반환 → 이전 호출에서 세션 해시가 현재 키 기준으로 업그레이드되었음을 증명.

## 공략 포인트 (뭘 조져야)
- localization: problem_statement가 `get_session_auth_hash`와 `salted_hmac`을 명시하므로 `django/contrib/auth/base_user.py`가 1차 타깃. 다만 진짜 수정의 절반은 검증 진입점인 `django/contrib/auth/__init__.py`의 `get_user`에 있어서, "세션이 어디서 검증되고 flush되는가"를 역추적해야 멀티파일을 모두 잡는다.
- 함정/난이도:
  - 단순히 `get_session_auth_hash`에 fallback 루프만 넣어 "유효하면 통과"시키면 hints가 경고한 문제(fallback 제거 시 재로그아웃)가 남는다. 골드는 fallback로 통과할 때 **현재 키로 해시를 재기록(업그레이드)**하는 것까지 요구한다 — `cycle_key()` + `session[HASH_SESSION_KEY] = session_auth_hash`.
  - `constant_time_compare`를 유지해 타이밍 공격 방어를 깨지 않아야 함.
  - `session_hash` 빈 값 가드(`if not session_hash`)를 유지해야 fallback 비교에 빈 해시가 새지 않음.
- 우리 에이전트 관점: base_user.py만 고치고 만족하기 쉬움(테스트가 `cycle_key` 효과와 후속 fallback-제거 케이스까지 검사하므로 `get_user`의 업그레이드 로직 누락 시 FAIL). 두 파일에 걸친 데이터 흐름(해시 생성 vs 해시 검증/갱신)을 끝까지 따라가는 것이 관건.
