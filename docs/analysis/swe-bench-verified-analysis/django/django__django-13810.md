---
instance_id: django__django-13810
repo: django/django
base_commit: 429d089d0a8fbd400e0c010708df4f0d16218970
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-12-26T12:31:18Z
fail_to_pass: 1
pass_to_pass: 30
gold_files: [django/core/handlers/base.py]
---

# django__django-13810

## 문제 요약
ASGI 컨텍스트에서 미들웨어를 로딩할 때, 어떤 미들웨어가 `MiddlewareNotUsed`를 던지면 미들웨어 체인이 "오염"된다. `load_middleware` 루프에서 `handler` 변수가 이미 `adapt_method_mode()` 결과로 덮어써진 뒤 예외로 `continue` 하기 때문에, 그 적응된 handler가 다음 미들웨어로 전달되어 이전의 sync/async 적합성 검사를 무시하게 된다. 결과적으로 응답 사이클 마지막 미들웨어가 코루틴 대신 동기 `HttpResponse`를 반환해 `TypeError: object HttpResponse can't be used in 'await' expression`이 발생한다.

## 유형 분류
- 버그 카테고리: edge-case / logic (예외 경로에서의 상태 누수)
- 서브시스템: django core request handler / middleware loading (sync↔async 어댑테이션)
- 증상 타입: 크래시 (런타임 `TypeError`, await 불가 객체)
- 로컬라이제이션 신호: 리포터가 problem_statement에서 직접 `django/core/handlers/base.py#L58`과 `handler` 변수가 `adapt_method_mode()` 출력으로 덮어써진다는 점을 정확히 지목 — 거의 파일/라인 단위로 손가락질해 준 케이스.

## 골드패치 분석
- 건드린 파일/함수: `django/core/handlers/base.py` : `BaseHandler.load_middleware`
- 근본 원인: `handler = self.adapt_method_mode(...)`가 `try` 블록 안에서 즉시 `handler`를 덮어쓴다. 바로 다음 줄 `middleware(handler)`가 `MiddlewareNotUsed`를 던지면 `continue`로 그 미들웨어는 스킵되지만, `handler`는 이미 적응된 값으로 갱신된 상태로 남는다. 그 미들웨어는 체인에 추가되지 않았는데도 어댑테이션만 적용된 셈이라, 다음 패스에서 sync/async 모드가 어긋난 handler가 전파된다.
- 수정 요지: 어댑테이션 결과를 임시 변수 `adapted_handler`에 받고(`handler`는 그대로 둠), `mw_instance = middleware(adapted_handler)`로 인스턴스화한다. `try`가 예외 없이 성공한 경우에만 `else:` 절에서 `handler = adapted_handler`로 실제 갱신한다. 즉 미들웨어가 실제로 체인에 편입될 때만 handler가 진행되도록 commit을 미룬다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_async_and_sync_middleware_chain_async_call` (MiddlewareNotUsedTests). MIDDLEWARE를 `[SyncAndAsyncMiddleware, MyMiddleware]`로 오버라이드하고, `MyMiddleware`는 `MiddlewareNotUsed`를 던지도록 한 뒤 `async_client.get()`으로 비동기 요청을 보낸다.
- 증명 방식: 픽스 전이면 `MyMiddleware`가 던진 `MiddlewareNotUsed`로 handler가 오염되어 async 호출이 깨졌을 것. 픽스 후엔 응답이 정상적으로 `b'OK'` / status 200 이어야 한다. 추가로 DEBUG 로그를 캡처해 첫 레코드가 `Asynchronous middleware ... MyMiddleware adapted.`, 둘째 레코드가 `MiddlewareNotUsed: 'middleware_exceptions.tests.MyMiddleware'`임을 단언 — 어댑테이션 로그는 찍히되 그 handler가 다음으로 새지 않았음을 정상 동작으로 간접 증명한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: report가 파일/라인을 직접 줬으므로 `load_middleware`의 `try/except MiddlewareNotUsed` 블록을 먼저 본다. 핵심은 "예외 경로에서 `handler` 변수가 이미 변경됐는가"라는 상태 누수 패턴.
- 함정/난이도: 단일 파일·소규모 diff지만 `handler`를 즉시 갱신하지 않고 `else:` 절로 미루는 구조가 비직관적. 단순히 `try` 안에서 두 변수를 쓰는 것만으로는 부족하고, 성공 시에만 commit하는 `try/except/else` 시맨틱을 정확히 써야 한다. sync/async 어댑테이션 흐름과 `MiddlewareNotUsed`가 정상 제어 흐름(에러 아님)이라는 점을 이해해야 함.
- 우리 에이전트 관점: ASGI/async 미들웨어 체인을 실제로 재현하기 어려워 "왜 버그인지" 인과를 잡는 데서 막힐 수 있다. 다만 report가 라인을 짚어줘 코드 자체 수정은 작다. `else:` 절 없이 `try` 안에서 조건 분기로 처리하면 로그 순서/시점이 어긋나 PASS_TO_PASS 회귀 위험이 있으니 골드의 try-else 형태를 따르는 것이 안전.
