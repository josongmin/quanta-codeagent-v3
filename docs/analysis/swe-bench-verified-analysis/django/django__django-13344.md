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
primary_type: T-DomainBound
tier: T5
loc_axis: L3
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, has-repro]
---

# django__django-13344

## 문제 요약
ASGI(+uvicorn) 환경에서 MIDDLEWARE 리스트의 첫 번째 미들웨어의 `process_response()`가 `HttpResponse`가 아니라 `coroutine` 객체를 response 인자로 받는다. 나머지 하위 미들웨어들은 정상적으로 `HttpResponse`를 받는다. 미들웨어가 2개 이상일 때 체인 맨 앞의 것만 깨지며(단독이면 정상), django-cors-headers처럼 보통 맨 앞에 두는 패키지에서 실제 장애를 일으켰다. hints_text에서 이미 근본원인이 진단되어 있다: 일부 미들웨어의 `__init__`이 `super().__init__()`를 호출하지 않아 `MiddlewareMixin._async_check()`가 안 돌고, `async_capable=True` 선언에도 불구하고 `_is_coroutine` 매직 속성이 인스턴스에 붙지 않는다.

## 유형 (정형화)

- **L (Localization) = L3** — 수정이 3개 파일(`security.py`/`sessions/middleware.py`/`cache.py`)·5개 클래스(`SecurityMiddleware`, `SessionMiddleware`, `UpdateCacheMiddleware`, `FetchFromCacheMiddleware`, `CacheMiddleware`)에 **함께** 걸려야 한다. cache 3종은 상속 사슬(`CacheMiddleware(UpdateCacheMiddleware, FetchFromCacheMiddleware)`)로 묶여 조율 수정이 강제된다. 한두 곳만 고치면 부분 통과. 단일 심볼이 아니라 "패턴을 공유하는 모든 사이트"를 전수 식별해야 하므로 multi-site.
- **S (Repair Strategy) = S2 (+S6)** — 근본 원인은 데이터플로우 추론으로 합성한다: 증상(coroutine 누수)에서 `_async_check`/`_is_coroutine` 마커 → `MiddlewareMixin.__init__` 미경유라는 인과를 따져야 한다(S2, "생각으로" 푸는 것이지 후보를 마구 시도하는 G&V가 아님). 보조로 `CacheMiddleware.__init__`은 단순 한 줄 치환이 아니라 kwargs 폴백 로직을 base가 이미 세팅한 값을 보존하도록 **재배치**해야 하므로 소규모 구조변경(S6)이 섞인다 — `key_prefix`/`cache_alias`/`cache`/`cache_timeout` 할당을 KeyError 분기 안쪽으로 옮기고 "kwargs 제공 시에만 덮어쓰기" 의미로 바꾼다.
- **K (Knowledge) = K-Domain** — django의 sync/async 미들웨어 어댑테이션 내부(`MiddlewareMixin`, `_async_check`, `_is_coroutine` 마커, `async_capable`, ASGI handler가 마커를 보고 미들웨어를 async로 어댑트하는 계약)를 알아야 원인에 도달한다. 일반 파이썬 추론(K-Gen)만으로는 "왜 첫 미들웨어만, 왜 coroutine이"가 안 풀린다.

**primary type = T-DomainBound** — 진짜 병목은 "어디"보다(hints가 짚어주긴 하나) 프레임워크 내부 async 어댑테이션 지식이다. L3 멀티사이트지만 각 사이트의 식별은 도메인 지식(`MiddlewareMixin` 계약)에 종속되어 있어, DiffuseLoc(탐색 자체가 난점)보다 DomainBound가 dominant. repair strategy로 S2를 고른 이유는 APR 관점에서 이게 semantic-reasoning 결함이기 때문이다 — 실패 테스트를 통과시키는 후보를 생성·검증(G&V)하는 게 아니라, 인스턴스 초기화 불변식("MiddlewareMixin 하위는 반드시 base init을 경유해 _async_check를 거쳐야 한다")을 추론으로 복원해 다섯 사이트에 일관 적용하는 문제다.

## 난이도 티어
**Tier = T5 (어려움)**. 공식 라벨은 "1-4 hours"(개발자 구현시간 prior, 대략 T4 상당)인데 한 단계 위로 잡는다. 미는 구조적 피처:
- **L3 멀티파일/멀티헌크 조율**(3파일·5클래스, cache 3종 상속 결합) — ICLR 2024 컷에서 ≥3파일은 solve<10% 구간에 진입한다. "하나 고치면 부분 통과"라 전수성이 강제됨.
- **regression-trap이 큼** — PASS_TO_PASS 356개(대부분 cache 백엔드 전수 테스트). `CacheMiddleware.__init__` kwargs 재배치는 `cache`/`cache_alias`/`key_prefix`/`cache_timeout` 속성을 깨면 광범위한 cache 동작이 회귀한다.
- **silent-wrong 증상 + 오도성 repro** — 예외가 아니라 타입 누수라, ASGI handler/asgi.py 쪽을 파면 시간을 버린다. has-repro 플래그(ASGI 재현 절차 + django-cors-headers 링크)는 easiness 신호지만, 여기선 재현 경로와 실제 수정 경로가 어긋나 있어 repro의 가치가 반감된다.

공식 difficulty(1-4h)와 다른 이유: 시간라벨은 "원인을 안 뒤 손으로 5곳 고치는 시간"을 잰 것이지, 에이전트가 (a) coroutine 누수→`super()` 미호출이라는 인과를 hints 없이 잡고 (b) 5사이트 전수 + (c) CacheMiddleware kwargs 보존까지 정확히 맞추는 난도는 반영하지 않는다. localize 오도성과 멀티사이트 trap이 시간라벨에 안 잡히므로 T5로 상향.

## 골드패치 분석
- **건드린 파일/함수**:
  - `django/middleware/security.py` : `SecurityMiddleware.__init__`
  - `django/contrib/sessions/middleware.py` : `SessionMiddleware.__init__`
  - `django/middleware/cache.py` : `UpdateCacheMiddleware.__init__`, `FetchFromCacheMiddleware.__init__`, `CacheMiddleware.__init__`
- **근본 원인**: 이 미들웨어들이 `__init__`을 오버라이드하면서 `MiddlewareMixin.__init__`을 우회하고 `self._get_response_none_deprecation(get_response)` + `self.get_response = get_response`만 수동 처리했다. 그 결과 base `__init__` 안의 `self._async_check()`가 호출되지 않아, `get_response`가 코루틴일 때 인스턴스에 `_is_coroutine` 마커가 붙지 않는다. ASGI handler는 이 마커로 미들웨어를 async로 어댑트하는데, 마커가 없으면 체인 맨 앞 미들웨어가 sync로 취급되어 다운스트림이 넘긴 코루틴 응답을 await하지 않고 그대로 `process_response`에 전달한다(첫 미들웨어만 깨지는 이유 = 어댑테이션이 경계에서만 발생).
- **수정 요지**: 다섯 곳 모두 수동 `_get_response_none_deprecation`/`self.get_response = ...` 라인을 `super().__init__(get_response)` 한 줄로 교체 — deprecation 경고와 `_async_check()`가 정규 경로로 함께 실행된다. `CacheMiddleware.__init__`은 추가로 kwargs 처리를 재구조화: `super().__init__(get_response)`가 (UpdateCacheMiddleware 경유로) 이미 `key_prefix`/`cache_alias`/`cache`/`cache_timeout`을 settings 기본값으로 세팅하므로, kwargs가 명시 제공된 경우에만 `self.key_prefix`/`self.cache_alias`/`self.cache`/`self.cache_timeout`을 덮어쓰도록 KeyError 분기를 `pass`로 바꾸고 할당을 try 블록 안으로 이동. base 초기화 결과를 보존하면서 데코레이터 커스텀 값을 반영한다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개)**:
  - `test_coroutine` — 빌트인 미들웨어 19종 전부를 async `get_response`와 sync `get_response`로 각각 생성한 뒤 `asyncio.iscoroutinefunction(instance)`가 각각 True/False여야 함을 단언. `_async_check()`가 실제로 돌아 `_is_coroutine` 마커가 붙는지를 sync 단위 테스트로 직접 증명 — ASGI 서버 없이 근본원인을 포착한다.
  - `test_deprecation` — 같은 19종을 인자 없이 생성하면 `RemovedInDjango40Warning`이 떠야 함. `super().__init__()` 경유로 deprecation 경고가 다시 발생함을 보장(수동 경로 제거가 경고를 누락시키지 않았는지).
- **픽스 증명**: 픽스 전에는 `SecurityMiddleware` 등이 `_async_check`를 안 거쳐, `async_get_response`를 줘도 `iscoroutinefunction(instance)`가 False(coroutine 누수)였고 deprecation 경고도 빠졌다. 픽스 후 `super().__init__()` 경유로 둘 다 통과. test_patch는 기존 `test_subclass_deprecation`(5종 한정)을 19종 전체 `middlewares` 리스트 + subTest로 일반화해, "MiddlewareMixin 하위 전부가 계약을 지키는가"를 검사한다.
- **overfit 관점**: 19종 전수 + async/sync 양방향 단언이라, 5개만 고치고 나머지가 우연히 같은 패턴이 아니었다면 잡힌다. special-case 통과가 어려운 강한 테스트(S4/CEGIS 위험 낮음). FAIL_TO_PASS는 2개뿐이지만 각각 19×2 subTest를 품어 실질 커버리지가 넓다.
- **regression 관점**: cache 테스트에 `test_update_cache_middleware_constructor`/`test_fetch_cache_middleware_constructor`가 신설되고, 기존 `test_constructor`에 `middleware.cache == self.other_cache`(및 default/custom) 단언이 추가되어, 재구조화한 `CacheMiddleware`/`UpdateCacheMiddleware`/`FetchFromCacheMiddleware` kwargs 분기가 `cache`/`cache_alias`/`key_prefix`/`cache_timeout`을 깨지 않음을 회귀 보호한다. `runtests.py`의 `CONTRIB_TESTS_TO_APPS`가 deprecation 테스트용으로 flatpages/redirects contrib 앱을 INSTALLED_APPS에 함께 넣도록 확장된 것은 19종 import가 contrib 미들웨어를 포함하기 때문(테스트 인프라 보정).

## 모범답안 (오라클 기반)
1. **localize 경로**: 증상은 "ASGI handler에서 첫 미들웨어에 coroutine 누수". 오도 경로(asgi.py/handler)를 파지 말고, "왜 sync로 취급되나 → 미들웨어가 async 어댑트를 안 받았다 → 어댑트 트리거가 뭔가"를 역추적한다. `MiddlewareMixin.__init__`(django/utils/deprecation.py)이 `_async_check()`를 호출해 `_is_coroutine`/`async_capable` 마커를 세팅한다는 점에 도달 → `MiddlewareMixin`을 상속하면서 `__init__`을 오버라이드하고 `super().__init__()`를 호출하지 않는 클래스를 전수 grep. 그 결과가 정확히 골드의 5개(`SecurityMiddleware`, `SessionMiddleware`, cache 3종).
2. **픽스와 일반화 정당성**: 각 사이트의 수동 `_get_response_none_deprecation`+`self.get_response=...`를 `super().__init__(get_response)`로 교체. 이게 overfit 아닌 올바른 일반화인 이유 — 결함의 본질이 "특정 미들웨어 버그"가 아니라 "MiddlewareMixin 초기화 계약 위반"이고, base init은 deprecation 처리·`get_response` 세팅·`_async_check`를 묶은 단일 진실원이다. 수동 재현 대신 base를 경유하면 동일 계약을 지키는 모든 사이트가 일관 수정된다. test가 19종 전체를 검사하는 것과 일반화 범위가 정확히 일치.
3. **regression 안전**: PASS_TO_PASS 356개 — 핵심은 `CacheMiddleware` 계열의 cache 백엔드 동작. `super().__init__()`가 이미 settings 기본값으로 `key_prefix`/`cache_alias`/`cache`/`cache_timeout`을 세팅하므로, 데코레이터로 kwargs를 넘기는 경로(`as_view` 커스텀 값)에서만 덮어쓰도록 분기를 재배치해야 한다. 무지성 한 줄 치환으로 base 세팅을 그대로 두면 커스텀 cache_alias가 무시되거나, 반대로 base 호출 없이 두면 `cache` 속성이 안 잡혀 cache 미들웨어 동작 전체가 깨진다.
4. **함정 회피**:
   - **오도 repro**: has-repro지만 재현이 ASGI handler를 가리켜 그쪽을 수정하려는 유혹. 실제 수정점은 미들웨어 `__init__`이고, 검증은 sync `iscoroutinefunction` 단위 테스트로 충분하다는 걸 알아야 한다.
   - **부분 통과 trap**: hints가 SecurityMiddleware만 명시해 한 곳만 고치기 쉬움. test가 19종 전수라 cache 3종·session까지 빠짐없이 고쳐야 FAIL_TO_PASS가 green. cache 3종은 상속으로 묶여 함께.
   - **CacheMiddleware kwargs 보존**: 가장 깨먹기 쉬운 지점. base가 세팅한 값과 kwargs 폴백 의미를 혼동하면 regression(`test_constructor`의 `cache==other_cache` 류)에서 터진다 — 골드처럼 "kwargs 제공 시에만 덮어쓰기"로 의미를 명확히 재배치.
