---
instance_id: django__django-13195
repo: django/django
base_commit: 156a2138db20abc89933121e4ff2ee2ce56a173a
version: "3.2"
difficulty: 15 min - 1 hour
created_at: 2020-07-15T11:00:07Z
fail_to_pass: 5
pass_to_pass: 382
gold_files: [django/contrib/messages/storage/cookie.py, django/contrib/sessions/middleware.py, django/http/response.py]
---

# django__django-13195

## 문제 요약
`HttpResponse.delete_cookie()`가 쿠키를 만료시킬 때 원래 쿠키의 `SameSite` 속성을 보존하지 않는다. 그 결과 messages/sessions처럼 `SameSite=Lax`로 설정됐던 쿠키를 삭제하면 `SameSite` 없이 `Set-Cookie`가 내려가고, `SameSite=None`인데 `Secure`가 없는 경우 Chrome/Firefox가 곧 그 `Set-Cookie`를 무시하게 된다. 사용자는 쿠키 삭제 시에도 `SameSite`(그리고 `none`일 때 `Secure`)가 유지되기를 기대했다.

## 유형 분류
- 버그 카테고리: 누락처리 / API-contract (delete가 set 시점 속성을 보존 안 함)
- 서브시스템: django HTTP response (쿠키) + sessions/messages 미들웨어
- 증상 타입: silent-wrong (브라우저가 삭제 `Set-Cookie`를 무시 → 쿠키가 안 지워짐, 콘솔 경고)
- 로컬라이제이션 신호: problem_statement가 `HttpResponseBase`의 `delete_cookie`를 직접 지목하고, messages가 그걸 호출해 쿠키를 만료시킨다고 명시. Firefox 경고문이 "SameSite + secure" 조합을 정확히 가리킴.

## 골드패치 분석
- 건드린 파일/함수:
  - `django/http/response.py`:`HttpResponseBase.delete_cookie` — 핵심 수정
  - `django/contrib/sessions/middleware.py`:`SessionMiddleware.process_response` — delete 호출에 samesite 전달
  - `django/contrib/messages/storage/cookie.py`:`CookieStorage._update_cookie` — delete 호출에 samesite 전달
- 근본 원인: `delete_cookie(key, path, domain)` 시그니처에 `samesite` 인자 자체가 없었다. 내부적으로 `set_cookie(max_age=0, ...)`를 호출하지만 samesite를 넘기지 않아 만료 응답에 `SameSite`가 빠졌다. 또 `secure`는 `__Secure-`/`__Host-` 접두사로만 켜져서, `SameSite=None`인 일반 쿠키는 secure 없이 나가 브라우저가 무시.
- 수정 요지:
  - `delete_cookie`에 `samesite=None` 파라미터 추가, 내부 `set_cookie(...)` 호출에 `samesite=samesite` 전달.
  - `secure` 판정을 확장: 접두사 조건 `or (samesite and samesite.lower() == 'none')` — none이면 secure 강제.
  - `SessionMiddleware`와 `CookieStorage`가 만료 시 `samesite=settings.SESSION_COOKIE_SAMESITE`를 넘기도록 호출부 동기화.

## 검증 (test_patch)
- FAIL_TO_PASS가 체크하는 동작:
  - `responses.test_cookie`: `test_delete_cookie_samesite`(samesite='lax' → 쿠키에 `samesite=='lax'`), `test_delete_cookie_secure_samesite_none`(samesite='none' → `secure` is True).
  - `sessions_tests`: `test_session_delete_on_end`, `..._with_custom_domain_and_path` — 세션 종료 Set-Cookie 문자열에 `; SameSite={SESSION_COOKIE_SAMESITE}`가 붙는지.
  - `messages_tests`: `test_cookie_setings` — 삭제된 messages 쿠키의 `samesite`가 `settings.SESSION_COOKIE_SAMESITE`와 같은지.
- 증명 방식: 픽스 전에는 만료 `Set-Cookie`에 `SameSite`가 전혀 없으므로 위 단언이 모두 빈 값/누락으로 실패. 픽스 후 set_cookie로 전달돼 그대로 헤더에 직렬화되어 통과. none 케이스는 secure 강제 분기로 `secure is True` 보장.

## 공략 포인트 (뭘 조져야)
- 시작점: problem_statement가 `HttpResponseBase.delete_cookie`를 직접 지목하므로 `django/http/response.py`의 해당 메서드부터. 시그니처에 samesite 추가 + 내부 set_cookie 전달이 1차 수정.
- 함정/난이도:
  - 멀티파일이다. response.py만 고치면 FAIL_TO_PASS의 sessions/messages 케이스는 여전히 실패 — 호출부(middleware.py, cookie.py)에서 `samesite=...`를 실제로 넘겨줘야 한다. 호출부 2곳을 빠뜨리기 쉽다.
  - `secure` 판정에 `samesite=='none'` 분기를 추가하지 않으면 `test_delete_cookie_secure_samesite_none`만 콕 집어 실패.
  - 기본값 `samesite=None`이어야 기존 호출(인자 안 넘기는 곳)이 깨지지 않음 — `test_default`가 `samesite==''` 기대(PASS_TO_PASS 회귀 보호).
- 우리 에이전트 관점: response.py 단일 수정으로 "끝"이라 조기 종료하면 sessions/messages 테스트가 빨갛게 남는다. FAIL_TO_PASS 목록이 세 서브시스템에 걸쳐 있다는 점을 보고 호출부 동기화까지 추적해야 한다. none→secure 강제라는 보안 디테일은 problem_statement의 경고문에서 단서를 읽어야 놓치지 않는다.
