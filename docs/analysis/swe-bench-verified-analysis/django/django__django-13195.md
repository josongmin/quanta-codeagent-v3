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
primary_type: T-DirectMap
tier: T3
loc_axis: L3
repair_strategy: S1 (+S2)
knowledge: K-API
flags: [regression-trap, has-repro, cross-file-dep]
---

# django__django-13195

## 문제 요약
`HttpResponse.delete_cookie()`가 쿠키를 만료시킬 때 원래 쿠키의 `SameSite` 속성을 보존하지 않는다. 그 결과 messages/sessions처럼 `SameSite=Lax`로 설정됐던 쿠키를 삭제하면 `SameSite` 없이 `Set-Cookie`가 내려가고, `SameSite=None`인데 `Secure`가 없는 쿠키는 Chrome/Firefox가 곧 그 `Set-Cookie`를 무시(→ 쿠키가 안 지워짐)하게 된다. 이슈 작성자는 Firefox 콘솔 경고("sameSite=none without secure")로 증상을 재현했고, 직접 패치한 `delete_cookie` 시안까지 본문에 적어 두었다. 기대 동작: 쿠키 삭제 시에도 `samesite`(그리고 `none`일 때 `secure`)가 유지될 것.

## 유형 (정형화)

3축 점수:
- **L3 (Multi-site)** — 픽스가 `django/http/response.py`(핵심)뿐 아니라 호출부 `sessions/middleware.py`·`messages/storage/cookie.py` 2곳에서 **함께** `samesite=...`를 넘기도록 조율돼야 FAIL_TO_PASS가 전부 녹색이 된다. response.py 한 파일만 고치면 sessions/messages 케이스는 여전히 빨갛다. 개별 site의 localize는 자명하나(이슈가 `HttpResponseBase.delete_cookie`를 직접 지목), 3-site 동시변경이라는 조율 요건이 L0가 아니라 L3로 미는 결정적 피처다.
- **S1 (Direct-Map) +S2** — 지배 전략은 S1: 이슈가 사실상 픽스를 적어줬다("add the samesite argument to delete_cookie() and preserve it"). 시그니처에 `samesite=None` 파라미터 추가 + 내부 `set_cookie(..., samesite=samesite)` 전달은 기계적 인자-스레딩. 보조로 S2가 붙는 이유는 `secure` 판정식 합성: `key.startswith(('__Secure-','__Host-')) or (samesite and samesite.lower() == 'none')` — 단순 인자 전달이 아니라 "samesite=none이면 브라우저가 secure 없는 Set-Cookie를 무시한다"는 불변식을 조건식으로 명시해야 한다. 이건 템플릿이 아니라 약한 추론이다.
- **K-API (API-contract)** — 공개 메서드 `delete_cookie`의 시그니처를 확장하는 것이라 하위호환이 계약이다. 신규 인자는 반드시 끝에 `samesite=None` 기본값으로 와야 기존 모든 호출부(인자 안 넘기는 코드)가 안 깨진다. samesite 직렬화/유효성은 `set_cookie`의 기존 API 계약에 위임된다.

primary type = **T-DirectMap**: 위치가 명확하고(이슈가 심볼 지목) 픽스가 본질적으로 "인자 추가 + 전달"이라는 기계적 매핑이기 때문. T-DiffuseLoc이 아닌 이유는 어려움이 "어디인지 찾기"에 있지 않다(이슈가 다 알려줌) — 멀티사이트지만 각 site는 grep 한 방이다. T-ConstraintReason도 아니다: secure 분기 합성은 보조일 뿐 dominant 노력이 아니다.

왜 이 repair strategy인가 (APR 관점): PAR/TBar류 template-repair가 그대로 들어맞는 "add-parameter + thread-through" 패턴이다. 이슈 본문이 oracle에 가까운 픽스 시안을 제공하므로 generate-&-validate로 후보를 넓게 탐색할 필요가 없고, SemFix식 깊은 의미합성도 secure 한 줄에만 국한된다. 핵심 난점은 합성이 아니라 **다중 호출부 일관성**(cross-site coordination)이라, S1을 멀티사이트로 적용하는 문제로 보는 게 정확하다.

## 난이도 티어
**T3 (중간).** 공식 difficulty 라벨은 "15 min - 1 hour"(T2~T3 prior)인데, 본 분류는 T3로 둔다 — 공식 라벨과 일치하는 쪽이다.

이 티어로 미는 구조적 피처:
- **L3 멀티사이트(3파일/4헌크)**: 골드패치가 `response.py`·`middleware.py`·`cookie.py` 3파일에 걸쳐 있고, response.py만 고치는 "조기 종료"가 가장 흔한 실패 모드. 이 cross-file 조율이 T1/T2(1파일)에서 T3로 끌어올린다.
- **localize 직접성은 매우 높음**: 이슈가 `HttpResponseBase.delete_cookie`를 명시하고 패치 시안까지 줌(has-repro). 이 신호가 강해서 T4 이상으로는 안 간다.
- **약한 P2P trap**: PASS_TO_PASS 382개로 외형은 넓지만, 대부분 sessions backend 매트릭스(Cache/DB/File 변형)라 동일 코드경로의 중복일 뿐 실제 regression 표면은 좁다. `test_default`(samesite=='')와 `test_delete_cookie_secure_prefix`가 진짜 회귀 가드. 기본값 `samesite=None`을 지키면 안전.
- **도메인 지식 얕음**: ORM/query-compiler 같은 깊은 django 내부가 아니라 HTTP 쿠키 + 브라우저 SameSite 규약 수준. T5/T6의 깊은 도메인 병목이 아니다.

요약: localize는 T1급으로 쉽지만 멀티사이트 조율 + secure 분기 추론이 T3로 끌어올린, "쉬운 localize × 중간 조율"의 전형.

## 골드패치 분석
- 건드린 파일/함수:
  - `django/http/response.py` : `HttpResponseBase.delete_cookie` — 핵심 수정.
  - `django/contrib/sessions/middleware.py` : `SessionMiddleware.process_response` — 세션 종료 시 `delete_cookie(...)` 호출에 `samesite=settings.SESSION_COOKIE_SAMESITE` 추가.
  - `django/contrib/messages/storage/cookie.py` : `CookieStorage._update_cookie` — 빈 메시지 삭제 분기의 `response.delete_cookie(...)`에 `samesite=settings.SESSION_COOKIE_SAMESITE` 추가.
- 근본 원인: `delete_cookie(key, path='/', domain=None)` 시그니처에 `samesite` 인자 자체가 없었다. 내부적으로 `set_cookie(key, max_age=0, ...)`를 호출하지만 samesite를 넘기지 않아 만료 응답에 `SameSite`가 누락됐다. 또 `secure`는 `__Secure-`/`__Host-` 접두사로만 켜져서 `SameSite=None`인 일반 쿠키는 secure 없이 나가 브라우저가 곧 무시할 상황이었다.
- 수정 요지:
  - `delete_cookie`에 `samesite=None` 파라미터 추가, 내부 `set_cookie(...)` 호출에 `samesite=samesite` 전달, `expires`와 함께 직렬화되도록 함.
  - `secure` 판정을 `secure = key.startswith(('__Secure-', '__Host-')) or (samesite and samesite.lower() == 'none')`로 확장 — samesite가 none이면 secure 강제. 주석도 "__Host-/__Secure- 접두사 **또는** samesite가 none" 두 조건으로 갱신.
  - 두 호출부(`SessionMiddleware`, `CookieStorage`)가 만료 시 `settings.SESSION_COOKIE_SAMESITE`를 실제로 넘기도록 동기화.

## 검증 (test_patch)
- FAIL_TO_PASS(5개)가 체크하는 동작:
  - `responses.test_cookie.DeleteCookieTests.test_delete_cookie_samesite` — `delete_cookie('c', samesite='lax')` → `cookies['c']['samesite'] == 'lax'`.
  - `..test_delete_cookie_secure_samesite_none` — `delete_cookie('c', samesite='none')` → `cookies['c']['secure'] is True`(secure 강제 분기 증명).
  - `sessions_tests.tests.SessionMiddlewareTests.test_session_delete_on_end` / `test_session_delete_on_end_with_custom_domain_and_path` — 세션 종료 `Set-Cookie` 문자열에 `; SameSite={SESSION_COOKIE_SAMESITE}`가 붙는지(미들웨어 호출부 동기화 증명).
  - `messages_tests.test_cookie.CookieTests.test_cookie_setings` — 삭제된 messages 쿠키의 `['samesite']`가 `settings.SESSION_COOKIE_SAMESITE`와 같은지.
- 픽스 증명: 픽스 전에는 만료 `Set-Cookie`에 `SameSite`가 전혀 없으므로 위 단언이 빈 값/누락으로 실패. 픽스 후 `set_cookie`로 전달돼 그대로 헤더에 직렬화되며 통과. none 케이스는 secure 강제 분기로 `secure is True` 보장.
- overfit 관점: 테스트가 lax(직접 전달 경로)와 none(secure 강제 경로) **두 분기**를 분리해 단언하므로 special-case 패치로는 둘 다 통과 못 한다 — overfit 위험은 낮다(S1이라 애초에 후보 탐색 폭도 좁음). 다만 secure 분기를 빼고 lax만 전달하면 `test_delete_cookie_secure_samesite_none`만 콕 집어 실패하므로 테스트가 그 누락을 잡아낸다.
- regression 관점: `flags: regression-trap`. `test_default`가 `cookie['samesite'] == ''`를 기대하므로 신규 인자 기본값이 반드시 `None`(미전달 시 SameSite 없음)이어야 한다. `test_delete_cookie_secure_prefix`는 접두사 기반 secure가 깨지지 않았는지 확인. PASS_TO_PASS 382개의 대부분(sessions backend 매트릭스)은 동일 코드경로 중복이라, 기본값과 접두사 분기만 보존하면 광범위 녹색이 유지된다.

## 모범답안 (오라클 기반)
1. **localize 경로**: problem_statement가 `HttpResponseBase`의 `delete_cookie`를 직접 지목하고 "set_cookie를 호출하지만 samesite를 안 넘긴다"고 명시 → `django/http/response.py`의 `delete_cookie`로 직행(L0급 신호). 그다음 FAIL_TO_PASS가 `responses`·`sessions`·`messages` **세 서브시스템**에 걸쳐 있음을 보고, `delete_cookie` 호출부를 grep해 `sessions/middleware.py:process_response`와 `messages/storage/cookie.py:_update_cookie` 2곳을 추가 타깃으로 확정.
2. **픽스와 왜 올바른 일반화인가**: `delete_cookie`에 `samesite=None` 파라미터를 끝에 추가하고 내부 `set_cookie`에 그대로 전달 — 이게 set 시점 속성을 delete 시점에 보존하는 일반 원리다(특정 쿠키 이름에 한정하지 않음). `secure`를 `samesite.lower()=='none'`일 때도 켜는 건 브라우저 SameSite=None 규약을 코드 불변식으로 박은 것이라, 임의의 none 쿠키 전반에 올바르게 적용된다(overfit 아님). 호출부는 messages/sessions가 set 시점에 쓰던 `settings.SESSION_COOKIE_SAMESITE`를 delete에도 동일하게 넘겨 대칭을 맞춘다.
3. **regression 안전**: 신규 인자 기본값 `None`을 지켜 `delete_cookie`를 인자 없이 호출하는 기존 전 코드가 SameSite 없는 동작을 유지(→ `test_default`의 `samesite==''` 보호). 접두사 기반 secure 분기를 `or`로 확장만 하고 제거하지 않아 `test_delete_cookie_secure_prefix` 보존. sessions backend 매트릭스 382개는 코드경로가 동일해 자동 보존.
4. **함정 회피**: 오라클 없는 에이전트의 전형적 실패는 (a) **response.py만 고치고 조기 종료** — sessions/messages FAIL_TO_PASS가 빨갛게 남는다. 멀티사이트임을 FAIL_TO_PASS 분포에서 읽고 호출부 2곳까지 동기화해야 한다. (b) **secure 강제 분기 누락** — lax만 전달하면 `test_delete_cookie_secure_samesite_none`만 실패. problem_statement의 Firefox 경고문("SameSite=None without secure")이 이 디테일의 단서다. (c) **기본값을 None 아닌 값(예: 이슈 시안처럼 settings 참조)으로 둠** — 이슈 작성자 본인이 "Definitely wouldn't want to use the session cookie settings for everything"이라 경고했듯, response.py 코어는 settings에 의존하면 안 되고 호출부에서만 주입해야 `test_default`가 깨지지 않는다.
