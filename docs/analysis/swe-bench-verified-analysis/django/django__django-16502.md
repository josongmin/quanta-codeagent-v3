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
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro, underspecified]
---

# django__django-16502

## 문제 요약
`runserver`(개발 서버)가 HTTP HEAD 요청에 응답 본문(body)을 반환한다. RFC 2616 §4.3 / RFC 9110 §9.3.2상 HEAD 응답은 헤더만 보내고 본문은 없어야 한다. #26052에서 Django가 본문 stripping을 제거하고 그 책임을 서버(gunicorn/mod_wsgi 등 일반 WSGI 서버는 이미 처리)에 위임했는데, 정작 `runserver`가 쓰는 `wsgiref` 기반 dev 서버에는 그 처리가 없어 Django 1.10부터 HEAD 응답이 비표준이 됐다. 부작용으로, 헤더 수신 후 연결을 끊는 호환 클라이언트 때문에 "Broken pipe" 에러가 runserver 출력에 나타난다. STR(curl `-iX HEAD`)과 기대/실제 출력이 이슈에 명시되어 있다.

## 유형 (정형화)

**L = L1 (Traceable).** 이슈가 심볼을 직접 지목하진 않지만 "runserver" + "HEAD requests" + "response body" + "#26052 회귀"라는 키워드가 dev server WSGI 핸들러 단일 파일 `django/core/servers/basehttp.py`로 곧장 수렴한다. grep 한 방까지는 아니고(`runserver` 명령 → `WSGIServer`/`ServerHandler` 한 단계 추적), 후보는 사실상 `ServerHandler` 클래스 하나뿐. 단일 파일·단일 클래스라 L0에 가깝지만, "어떤 메서드를 어디서 오버라이드할지"는 wsgiref 라이프사이클을 읽어야 정해지므로 L1.

**S = S2 (Constraint-Reasoning) +S6 (Design-Refactor).** 고칠 지점(`ServerHandler`)은 명확하지만, 올바른 픽스는 wsgiref의 응답 라이프사이클(`finish_response`→`send_headers`/`finish_content`, `headers_sent`, `result` iterator) 불변식을 따져 "생각으로" 합성해야 한다. "본문만 비우면 된다"는 순진한 가설은 두 군데서 깨진다: (1) `finish_content()`가 빈 본문에 `Content-Length: 0`을 강제해 RFC가 허용하는 Content-Length 생략을 막고, (2) iterator를 소비하지 않으면 앱 리소스 정리가 안 된다. 단순 가드 추가(S1)가 아니라 `finish_response()`를 통째로 오버라이드하는 **소규모 구조 변경(S6)** 이 동반되어 보조 strategy로 표기. CEGIS(S4)는 아니다 — 실패 테스트가 픽스를 과소명세하지 않고 GET/HEAD 양방향을 모두 못 박는다.

**K = K-Domain.** 일반 파이썬 추론으론 부족하고, Python 표준 `wsgiref.handlers.BaseHandler`의 내부 동작 — `finish_response`의 기본 구현이 result를 써내고 `finish_content`로 Content-Length를 채운다는 것, `headers_sent`/`send_headers`의 의미, `cleanup_headers` 훅 위치 — 을 알아야 픽스가 올바르게 나온다. API-contract(K-API)라기보다 프레임워크/표준라이브러리 내부지식 의존이라 K-Domain.

**primary type = T-ConstraintReason.** 위치는 명확(L1)하나 진짜 난점이 "올바른 식·조건·라이프사이클 처리를 추론으로 합성"하는 데 있다. S2가 dominant이고 K-Domain·S6가 그 추론을 어렵게 만드는 요소. T-DirectMap이 아닌 이유: 기계적 가드 한 줄이 아니라 `Content-Length: 0` 함정을 회피하는 비자명한 분기 설계가 핵심.

## 난이도 티어
**T4 (약간 어려움).** 공식 라벨 "15분-1시간"(T3 prior)보다 한 단계 올린다.

이 티어로 미는 구조적 피처:
- **단일 파일(1파일, ~25줄 추가)** 이라 scope 자체는 작음 → T5/T6는 아님.
- 그러나 **S2 constraint추론 + S6 소규모 refactor + K-Domain** 세 요소가 겹친다. TAXONOMY T4 프로파일("constraint추론·소규모 refactor·도메인지식 중 하나")의 조건을 하나가 아니라 사실상 다 충족.
- **비자명한 라이프사이클 함정**: `finish_content()`의 `Content-Length: 0` 강제, iterator 미소비 시 리소스 누수 — 오라클 없이는 이 둘을 놓치기 쉽다(localize는 쉬워도 "올바른 픽스 합성"이 어려운 전형).
- **regression-trap**: PASS_TO_PASS에 `test_https`, underscore-header 무시, broken-pipe 처리가 있어 GET/HTTPS/persistent-connection 경로를 안 깨야 한다. `cleanup_headers`의 `Connection: close` 분기를 잘못 건드리면 회귀.

공식 difficulty와 다른 이유: 시간라벨은 "개발자 구현시간" 기준이라, 한번 wsgiref 동작을 아는 사람에겐 30분~1시간일 수 있다. 하지만 에이전트 관점에선 localize는 쉬워도 `Content-Length: 0` 함정/iterator 소비 요건이 시간라벨에 안 잡히는 추론 난점이라 T4로 재조정.

## 골드패치 분석
- **건드린 파일/함수**: `django/core/servers/basehttp.py` — `ServerHandler.cleanup_headers()` 수정 + 신규 `ServerHandler.finish_response()` 오버라이드 (+ `from collections import deque` 임포트).
- **근본 원인**: 상위 `wsgiref.handlers.BaseHandler.finish_response()`가 HEAD를 일반 응답처럼 처리해 `self.result` iterator를 그대로 써내고, `finish_content()`로 `Content-Length`를 보정한다. #26052에서 Django는 본문 제거를 서버에 위임했으나 자체 dev 서버(`ServerHandler`)에는 HEAD 특수 처리가 없었다.
- **수정 요지**:
  1. `cleanup_headers()`: HEAD 요청이고 `Content-Length`가 헤더에 있으면 `del self.headers["Content-Length"]` (RFC 9110 §9.3.2 Content-Length 생략 허용). 그리고 기존의 "`Content-Length` 없으면 `Connection: close`" 로직을 `REQUEST_METHOD != "HEAD"` 조건으로 가드해 HEAD엔 `Connection: close`가 끼지 않도록 함.
  2. 신규 `finish_response()`: HEAD면 `deque(self.result, maxlen=0)`로 result iterator를 **본문 출력 없이 소비**(앱의 close/리소스 정리 보장), `finish_content()`는 호출하지 않아 `Content-Length: 0` 강제를 회피, `headers_sent`가 아니면 `send_headers()`만 보내고 `finally`에서 `self.close()`. HEAD가 아니면 `super().finish_response()`로 위임.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_no_body_returned_for_head_requests` (servers.test_basehttp.WSGIRequestHandlerTestCase).
- **픽스 증명**: 동일 WSGI 앱(`hello_world_body` 반환)에 GET·HEAD 두 번 요청해 양방향을 못 박는다.
  - GET `/` → 마지막 라인이 `hello_world_body`와 같고(`assertEqual(body, hello_world_body)`), `Content-Length: <len>` 헤더 존재(`assertIn`), `Connection: close` 없음 → 정상 동작 보존 확인.
  - HEAD `/` → 마지막 라인이 `b"\r\n"`(본문 없음), `Content-Length:`로 시작하는 라인이 **하나도 없음**(`assertIs(any(...), False)`), `Connection: close` 없음.
- **테스트 보강**: `Stub`이 `ThreadingMixIn`을 상속하도록 바꿔 `cleanup_headers`의 `elif not isinstance(server, ThreadingMixIn)` persistent-connection 경로를 회피(`Connection: close`가 끼지 않게). `UnclosableBytesIO`(close no-op)를 메서드 로컬에서 모듈 레벨로 승격해 GET/HEAD 두 케이스에서 재사용.
- **overfit 관점**: 테스트가 GET 정상 경로와 HEAD 부재 경로를 **동시에** 검사하므로, "HEAD든 GET이든 무조건 본문/Content-Length 제거" 같은 over-general 패치는 GET assert에서 즉시 깨진다. 즉 special-case overfit이 통과하기 어렵게 설계됨 → overfit-risk 플래그 미부여.
- **regression 관점**: PASS_TO_PASS 4개(`test_https`, `test_log_message`, underscore-header 무시, broken-pipe 처리)가 `cleanup_headers`/연결처리 인접 동작을 지키므로 `Connection: close` 분기·헤더정제 경로를 잘못 건드리면 회귀 → regression-trap 플래그.

## 모범답안 (오라클 기반)

**1) localize 경로.** 이슈의 "runserver" → `django/core/management/commands/runserver.py`가 아니라 실제 WSGI 처리부 `django/core/servers/basehttp.py`로 이동. "HEAD requests" + "response body" + "#26052에서 본문 stripping을 서버에 위임" → `ServerHandler`(wsgiref `BaseHandler` 서브클래스)가 유일 후보. 응답 본문/Content-Length를 다루는 메서드 → `cleanup_headers`와 (상위의) `finish_response`가 표적임을 wsgiref 소스 일독으로 확정.

**2) 픽스와 올바른 일반화.** 두 가지를 `REQUEST_METHOD == "HEAD"` 조건으로 분기: (a) 본문을 안 써내려면 `finish_response`를 오버라이드해 result iterator를 `deque(maxlen=0)`로 소비만 하고 `finish_content`를 건너뛴다. (b) Content-Length는 HEAD에선 헤더에서 삭제하고, "length 없으면 close" 로직에서 HEAD를 제외. 이게 over-general이 아닌 이유: 변경이 전부 `REQUEST_METHOD == "HEAD"` 게이트 뒤에 있어 GET/POST 등 다른 메서드의 본문·Content-Length·Connection 동작은 byte-identical로 보존된다. RFC 9110 §9.3.2(HEAD에서 Content-Length 생략 허용)에 정확히 맞춘 spec-aligned 일반화.

**3) regression 안전.** GET 응답은 여전히 본문 + `Content-Length: <len>`을 내야 한다(`super().finish_response()` 경로 유지). persistent-connection/`Connection: close` 분기(`test_https`, broken-pipe)와 underscore-header 무시 경로를 안 깨야 한다 — 그래서 픽스를 새 분기로 *추가*만 하고 기존 non-HEAD 흐름은 그대로 위임. `Content-Length` 삭제도 HEAD-게이트 안에서만.

**4) 함정 회피.** 오라클 없는 에이전트가 틀릴 지점:
- **함정 A — Content-Length: 0**: `finish_content()`를 그대로 두거나 본문만 빈 리스트로 바꾸면 wsgiref가 `Content-Length: 0`을 강제로 채워 RFC 생략 허용을 위반, 테스트의 "Content-Length 라인 부재" assert가 깨진다. → `finish_content()`를 호출하지 않고 `send_headers()`만 직접 호출해야 함.
- **함정 B — iterator 미소비**: 본문 출력을 스킵하면서 `self.result`를 소비하지 않으면 WSGI 앱의 close/리소스 정리가 누락된다. → `deque(self.result, maxlen=0)`로 반드시 drain하고 `finally: self.close()`.
- **함정 C — 단일 지점 수정**: `cleanup_headers` 한 군데에서 헤더만 손대고 `finish_response`를 안 건드리면 본문이 그대로 나가 픽스가 안 된다. 반대로 `finish_response`만 손대고 `Connection: close`/Content-Length 분기를 안 가드하면 HEAD에 불필요한 헤더가 붙어 assert 실패. 두 메서드를 함께 조율해야 함(S6 성격).
