---
instance_id: django__django-16136
repo: django/django
base_commit: 19e6efa50b603af325e7f62058364f278596758f
version: 4.2
difficulty: 15 min - 1 hour
created_at: 2022-09-29T11:47:50Z
fail_to_pass: 2
pass_to_pass: 7
gold_files: [django/views/generic/base.py]
---

# django__django-16136

## 문제 요약
`async def post`만 정의한 `View` 서브클래스에 GET 요청이 들어오면 500 에러와 함께 `TypeError: object HttpResponseNotAllowed can't be used in 'await' expression`가 발생한다. 비동기 핸들러가 있는 뷰는 ASGI 경로에서 디스패치 결과를 `await` 하는데, 405 응답을 만드는 `http_method_not_allowed()`가 코루틴이 아닌 일반 `HttpResponseNotAllowed`를 그대로 반환해서 await 대상이 될 수 없기 때문이다. 사용자는 단순히 405 Method Not Allowed가 정상 반환되기를 기대했다.

## 유형 분류
- 버그 카테고리: regression (hints에서 9ffd4eae2ce7 커밋의 회귀로 명시) / 누락처리(async 분기 누락)
- 서브시스템: django generic class-based views (async view dispatch)
- 증상 타입: 예외 / 크래시 (500 Internal Server Error)
- 로컬라이제이션 신호: 트레이스백 마지막 줄 `object HttpResponseNotAllowed can't be used in 'await' expression`와 "Method Not Allowed (GET)" 메시지가 곧장 `HttpResponseNotAllowed`를 반환하는 핸들러, 즉 `View.http_method_not_allowed()`를 가리킨다. hints에도 "http_method_not_allowed() needs to be adjusted ... same way as options()"라고 정확히 박혀 있다.

## 골드패치 분석
- 건드린 파일/함수: `django/views/generic/base.py` : `View.http_method_not_allowed()`
- 근본 원인: 비동기 뷰(`view_is_async`가 True)의 디스패치 경로는 핸들러 반환값을 `await` 한다. 그러나 `http_method_not_allowed()`는 sync/async 구분 없이 항상 동기 `HttpResponseNotAllowed`를 반환했고, 이는 awaitable이 아니라 await 시 TypeError가 난다. 형제 핸들러인 `options()`는 이미 async 분기를 갖고 있었는데 이 메서드만 누락된 상태였다.
- 수정 요지: 응답을 `response = HttpResponseNotAllowed(self._allowed_methods())`로 만든 뒤, `self.view_is_async`가 True면 그 응답을 반환하는 내부 코루틴 `async def func(): return response`를 정의해 `func()`(코루틴)을 반환하고, 아니면 동기 `response`를 그대로 반환한다. `options()`와 동일한 패턴으로 sync/async 양쪽을 처리한다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_http_method_not_allowed_responds_correctly`가 핵심. `RequestFactory().post("/")`로 POST 요청을 만들고, `SyncView`/`AsyncView` 두 케이스에 대해 `instance.http_method_not_allowed(...)`를 호출한다.
- 픽스 증명: 반환값에 `asyncio.iscoroutine(response)`가 sync 뷰면 False, async 뷰면 True여야 함을 `assertIs`로 검증한다. 코루틴이면 `asyncio.run(response)`로 풀어낸 뒤, 두 경우 모두 최종 객체가 `HttpResponseNotAllowed` 인스턴스인지 확인한다. 즉 async 뷰에서 405 핸들러가 await 가능한 코루틴을 돌려주고, 그 결과가 올바른 405 응답임을 보장한다. (`test_mixed_views_raise_error`도 함께 통과로 전환된다.)

## 공략 포인트 (뭘 조져야)
- localization 전략: 에러 메시지 + "Method Not Allowed (GET)" → `grep`으로 `HttpResponseNotAllowed` 반환 지점을 찾으면 `http_method_not_allowed()` 단일 메서드로 수렴. 같은 파일의 `options()`가 정답 템플릿이므로 그 구조를 그대로 복제하면 된다.
- 함정/난이도: 단일 파일·단일 메서드 1-hop 수정이라 난이도 자체는 낮음. 함정은 (1) `view_is_async` 게이트를 빼먹고 무조건 코루틴을 반환하면 sync 뷰가 깨진다(테스트의 sync 케이스가 잡아냄), (2) 응답 객체를 코루틴 안에서 새로 만들지 말고 바깥에서 한 번 만들어 캡처해야 `options()`와 일관됨.
- 우리 에이전트 관점: `options()`라는 명백한 인접 정답 코드가 같은 파일에 있어 패턴 모방이 쉽다. 막힐 만한 지점은 sync 경로를 보존하는 분기를 빠뜨리는 것 — async-only로 단순 변환해버리면 PASS_TO_PASS의 `test_views_are_correctly_marked`/sync 동작에서 회귀가 날 수 있으니 양쪽 분기를 반드시 유지해야 한다.
