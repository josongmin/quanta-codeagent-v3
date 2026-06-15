---
instance_id: django__django-16502
repo: django/django
base_commit: 246eb4836a6fb967880f838aa0d22ecfdca8b6f1
version: 5.0
difficulty: 15 min - 1 hour
created_at: 2023-01-26T09:21:31Z
fail_to_pass: 1
pass_to_pass: 4
gold_files: [django/core/servers/basehttp.py]
---

# django__django-16502

## 문제 요약
`runserver`(개발 서버)가 HTTP HEAD 요청에 대해 응답 본문(body)을 반환한다. RFC 2616 §4.3 / RFC 9110 §9.3.2에 따르면 HEAD 응답은 헤더만 보내고 본문은 없어야 한다. #26052에서 Django가 본문 stripping을 제거하고 서버(gunicorn/mod_wsgi)에 위임했는데, 정작 `runserver`의 WSGI 서버는 본문을 제거하지 않아 Django 1.10부터 비표준 동작이 됐다. 부작용으로 호환 클라이언트가 헤더 수신 후 연결을 끊으면서 "Broken pipe" 에러가 runserver 출력에 나타난다.

## 유형 분류
- 버그 카테고리: 누락처리 (API-contract / spec 위반) — HEAD 메서드에 대한 특수 처리가 빠짐
- 서브시스템: django dev server (WSGI) — `django/core/servers/basehttp.py`
- 증상 타입: silent-wrong (HEAD에 본문이 딸려 옴) + 부수적 크래시(Broken pipe)
- 로컬라이제이션 신호: "runserver", "HEAD requests", "response body" 키워드가 곧장 dev server WSGI handler(`basehttp.py`)를 가리킨다. #26052 회귀라는 명시도 강한 단서.

## 골드패치 분석
- 건드린 파일/함수: `django/core/servers/basehttp.py` — `ServerHandler.cleanup_headers()`, 신규 `ServerHandler.finish_response()`
- 근본 원인: 상위 `wsgiref` 핸들러는 HEAD를 일반 응답처럼 처리해 result iterator를 그대로 써내고, `Content-Length`를 보정/유지한다. Django는 본문 제거를 서버에 위임했지만 자체 dev 서버에 그 처리가 없었다.
- 수정 요지:
  - `cleanup_headers()`에서 HEAD 요청이면 `Content-Length` 헤더를 삭제. 그리고 기존 `Content-Length` 없을 때 `Connection: close`를 거는 로직을 HEAD에는 적용하지 않도록 `REQUEST_METHOD != "HEAD"` 조건으로 가드.
  - 신규 `finish_response()` 오버라이드: HEAD면 `deque(self.result, maxlen=0)`로 응답 iterator를 본문 출력 없이 소비(앱의 close 보장)하고, `finish_content()`를 호출하지 않아 `Content-Length: 0` 강제를 회피(RFC 9110 §9.3.2의 Content-Length 생략 허용). 헤더 미전송 시 `send_headers()`만 보내고 `close()`. HEAD가 아니면 `super().finish_response()`.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_no_body_returned_for_head_requests` (servers.test_basehttp)
- 증명 방식: 동일 WSGI 앱(`hello_world_body` 반환)에 대해 두 번 요청.
  - GET `/` → 마지막 라인 본문이 `hello_world_body`와 같고, `Content-Length: <len>` 헤더 존재, `Connection: close` 없음 (정상 동작 보존).
  - HEAD `/` → 마지막 라인이 `b"\r\n"` (본문 없음), `Content-Length:`로 시작하는 헤더가 하나도 없음, `Connection: close` 없음.
- 보강: 테스트의 `Stub`이 `ThreadingMixIn`을 상속하도록 바꿔(`elif not isinstance(... ThreadingMixIn)` 경로 회피) persistent-connection 분기에서 `Connection: close`가 끼지 않게 함. `UnclosableBytesIO`를 모듈 레벨로 승격(close no-op로 wfile 내용 재독).

## 공략 포인트 (뭘 조져야)
- localization 전략: `runserver` + HEAD는 `django/core/servers/basehttp.py`의 `ServerHandler`가 유일 후보. `cleanup_headers`/`finish_response` 두 메서드에 손대야 함.
- 함정/난이도 메모:
  - 단순히 본문만 비우면 안 됨 — `finish_content()`가 `Content-Length: 0`을 강제해 헤더 생략 요건(RFC 9110)을 깬다. iterator는 반드시 소비(`deque(maxlen=0)`)해 앱 리소스 정리를 보장해야 함.
  - `Connection: close` 로직과 `Content-Length` 삭제 순서/조건이 얽혀 있어, HEAD 분기를 두 군데 모두 추가해야 GET 동작 회귀가 안 난다.
  - 단일 파일 수정이지만 wsgiref 내부(`finish_response`/`send_headers`/`headers_sent`) 동작 이해가 필요.
- 우리 에이전트 관점: 본문 제거를 `cleanup_headers`에서만 시도하다 `Content-Length: 0` 함정에 걸리거나, `finish_response` 오버라이드 없이 끝내 GET 회귀를 유발하기 쉽다. wsgiref result iterator를 "출력 없이 소비"해야 한다는 비자명한 요건이 핵심 난관.
