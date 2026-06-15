---
instance_id: django__django-13344
repo: django/django
base_commit: e39e727ded673e74016b5d3658d23cbe20234d11
version: "3.2"
difficulty: 1-4 hours
created_at: 2020-08-24T20:50:35Z
fail_to_pass: 2
pass_to_pass: 356
gold_files: [django/contrib/sessions/middleware.py, django/middleware/cache.py, django/middleware/security.py]
---

# django__django-13344

## 문제 요약
ASGI(+uvicorn) 환경에서 MIDDLEWARE 리스트의 첫 번째 미들웨어의 `process_response()`가 `HttpResponse`가 아니라 `coroutine` 객체를 response 인자로 받는다. 나머지 하위 미들웨어들은 정상적으로 `HttpResponse`를 받는다. 미들웨어가 2개 이상일 때 체인 맨 앞의 것만 깨지며, django-cors-headers처럼 보통 맨 앞에 두는 패키지에서 실제 장애를 일으켰다.

## 유형 분류
- 버그 카테고리: 누락처리 (init에서 `super().__init__()` 미호출) / API-contract 위반
- 서브시스템: django middleware / ASGI async adapter (MiddlewareMixin)
- 증상 타입: silent-wrong (예외 없이 잘못된 타입 — coroutine이 response로 전달됨)
- 로컬라이제이션 신호: hints_text가 정답을 거의 짚어줌 — "SecurityMiddleware.__init__가 super().__init__()를 호출하지 않아 `_async_check()`가 안 돌고 `_is_coroutine` 매직 속성이 누락된다". 그리고 cache 계열 미들웨어도 같은 패턴.

## 골드패치 분석
- 건드린 파일/함수:
  - `django/middleware/security.py`:`SecurityMiddleware.__init__`
  - `django/contrib/sessions/middleware.py`:`SessionMiddleware.__init__`
  - `django/middleware/cache.py`:`UpdateCacheMiddleware.__init__`, `FetchFromCacheMiddleware.__init__`, `CacheMiddleware.__init__`
- 근본 원인: 이 미들웨어들이 `__init__`을 오버라이드하면서 `MiddlewareMixin.__init__`을 우회하고 `self._get_response_none_deprecation(...)` + `self.get_response = get_response`만 수동으로 했다. 그 결과 `MiddlewareMixin.__init__` 안의 `self._async_check()`가 호출되지 않아, `get_response`가 코루틴일 때 인스턴스에 `_is_coroutine` 마커가 붙지 않는다. 핸들러는 이 마커로 미들웨어를 async로 어댑트하는데, 마커가 없으면 첫 미들웨어가 sync로 취급되어 다운스트림의 코루틴 응답을 await하지 않고 그대로 받는다.
- 수정 요지: 다섯 곳 모두 수동 `_get_response_none_deprecation`/`self.get_response = ...` 라인을 `super().__init__(get_response)` 한 줄로 교체. 이로써 deprecation 경고 + `_async_check()`가 정규 경로로 실행된다. `CacheMiddleware.__init__`은 추가로 kwargs 처리를 재구조화 — `super().__init__()`가 이미 세팅한 `key_prefix`/`cache_alias`/`cache`/`cache_timeout`을 kwargs가 제공된 경우에만 덮어쓰도록 바꿔서 베이스 초기화 결과를 보존한다.

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `test_coroutine`: 모든 빌트인 미들웨어(19종 리스트)를 async/sync `get_response`로 각각 생성한 뒤 `asyncio.iscoroutinefunction(instance)`가 각각 True/False여야 함을 단언 — `_async_check()`가 제대로 돌아 `_is_coroutine`이 붙는지 직접 증명.
  - `test_deprecation`: 같은 19종 미들웨어를 인자 없이 생성하면 `RemovedInDjango40Warning`이 떠야 함 — `super().__init__()` 경유로 deprecation 경고가 다시 발생함을 보장.
- 증명 방식: 픽스 전에는 SecurityMiddleware 등이 `_async_check`를 안 거쳐 `async_get_response`를 줘도 `iscoroutinefunction`이 False(coroutine 누수)였고 deprecation 경고도 누락. 픽스 후 `super().__init__()` 경유로 둘 다 통과. cache 테스트의 `test_update_cache_middleware_constructor`/`test_fetch_cache_middleware_constructor`와 기존 `test_constructor`에 `middleware.cache == self.other_cache` 단언이 추가되어, 재구조화한 kwargs 분기가 `cache` 속성을 깨지 않음을 회귀 보호.

## 공략 포인트 (뭘 조져야)
- localization 전략: `MiddlewareMixin`(django/utils/deprecation.py)의 `__init__`이 `_async_check()`와 `_is_coroutine` 마커를 세팅한다는 점을 먼저 파악 → `MiddlewareMixin`을 상속하면서 `__init__`을 오버라이드하는데 `super().__init__()`를 안 부르는 클래스를 전수 검색. 그게 정확히 골드의 5개.
- 함정/난이도 메모: (1) 멀티파일(3파일/5클래스)이고 cache 계열은 상속 관계라 함께 고쳐야 함 — 하나만 고치면 부분 통과. (2) `CacheMiddleware.__init__`은 단순 한 줄 치환이 아니라 kwargs 폴백 로직을 base가 이미 세팅한 값을 보존하도록 재배치해야 함(여기서 깨먹기 쉬움). (3) 증상이 예외가 아니라 silent type 누수라 재현에 ASGI 셋업이 필요해 보이지만, 실제 근본 원인은 sync 단위 테스트(`iscoroutinefunction`)로 잡힌다.
- 우리 에이전트 관점: 증상이 "ASGI handler에서 coroutine 누수"라 핸들러/asgi.py 쪽을 파다가 시간을 버릴 수 있음. 진짜 원인은 미들웨어 `__init__`의 `super()` 미호출이라는 점을 hints 없이 잡으려면 `_async_check`/`_is_coroutine` 데이터 흐름을 역추적해야 한다. 또한 5곳을 빠짐없이 + CacheMiddleware kwargs 보존까지 정확히 손봐야 부분 통과를 피한다.
