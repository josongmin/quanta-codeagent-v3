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
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-16136

## 문제 요약
`async def post`만 정의한 `View` 서브클래스에 GET 요청이 들어오면 500 에러와 함께 `TypeError: object HttpResponseNotAllowed can't be used in 'await' expression`가 발생한다. 비동기 핸들러가 있는 뷰(`view_is_async == True`)는 ASGI 디스패치 경로에서 핸들러 반환값을 `await` 하는데, 405 응답을 만드는 `View.http_method_not_allowed()`가 코루틴이 아닌 동기 `HttpResponseNotAllowed`를 그대로 반환해서 await 대상이 될 수 없기 때문이다. hints에 따르면 커밋 `9ffd4eae2ce7`의 회귀이며, 형제 핸들러 `options()`는 이미 sync/async 분기를 갖고 있는데 이 메서드만 누락된 상태였다. 사용자는 단순히 405 Method Not Allowed가 정상 반환되기를 기대했다.

## 유형 (정형화)
- **L (Localization) = L0 — Pinpointed.** 트레이스백 마지막 줄이 `object HttpResponseNotAllowed can't be used in 'await' expression`로 결함 객체를 직접 명명하고, "Method Not Allowed (GET)" 메시지가 405 핸들러를 가리킨다. `grep HttpResponseNotAllowed`로 `http_method_not_allowed()` 단일 메서드에 즉시 수렴. hints에도 "http_method_not_allowed() needs to be adjusted ... same way as options()"라고 파일·함수·정답 템플릿까지 박혀 있다. 단일 파일·단일 함수·단일 헌크.
- **S (Repair Strategy) = S1 (+S2) — Direct-Map.** 결함 클래스가 정형(sync 컨텍스트에서 동기값을 반환하는데 async 컨텍스트가 awaitable을 기대 → "async 분기 누락")이고, 같은 파일의 `options()`가 정답 템플릿을 그대로 제공한다. `view_is_async` 게이트로 동기 응답을 코루틴으로 감싸는 패턴을 기계적으로 복제하면 됨 → 주축은 S1. 보조 S2는 "응답 객체를 코루틴 안에서 새로 만들지 말고 바깥에서 한 번 만들어 캡처"하는 작은 불변식(sync/async가 같은 객체를 돌려준다) 추론 — 하지만 이 추론도 `options()`를 보면 거의 사라지므로 보조에 머문다.
- **K (Knowledge) = K-Domain.** 일반 파이썬으로 "코루틴 안 됨"은 보이지만, *왜* async 분기가 필요한지(`view_is_async` 플래그, ASGI 디스패치가 핸들러 반환을 await, `options()`의 기존 관례)는 django CBV/async-view 내부지식이다. 픽스의 정확한 형태(`view_is_async` 게이트 + 내부 `async def` 래퍼)는 프레임워크 관례에 묶여 있다.
- **primary type = T-DirectMap.** 위치가 명확(L0)하고 픽스가 인접 정답 템플릿(`options()`)에 매칭되는 기계적 가드/래핑(S1). 추론 합성(S2 dominant)이나 localize 난점(L2/L3)이 본질이 아니므로 T-ConstraintReason/T-DiffuseLoc이 아니라 T-DirectMap.

## 난이도 티어
**Tier = T2 (쉬움).** 공식 라벨은 "15 min - 1 hour"(=T3 prior에 해당). 이를 구조적 피처로 하향 재조정한다:
- **하향 미는 피처:** 단일 파일(`base.py`) · 단일 함수 · 단일 헌크(+9/-1줄) · L0 직접 localize · `has-repro`(네이티브 트레이스백 + 재현 코드, 해결률 ~87% 신호) · 같은 파일 `options()`라는 명백한 인접 정답 템플릿 존재. 1파일·<10줄 프로파일은 ICLR 2024 컷에서 가장 쉬운 구간(≈48% solve).
- **약간 상향 유지하는 피처:** `regression-trap` — sync 경로를 보존하는 `view_is_async` 분기를 빠뜨리면 동기 뷰가 깨진다. K-Domain(async-view 관례). 이 둘 때문에 최하 T1로는 내리지 않는다. T1은 "이슈가 픽스를 거의 적어주는 K-Gen"인데, 여기선 픽스 형태가 django async 관례 + sync 분기 보존 의무에 묶여 순수 일반지식만으론 완전하지 않다.
- **공식 라벨과 다른 이유:** 공식 "15분-1시간"은 첫 기여자가 컨트리뷰션 가이드를 따르고 회귀 테스트를 작성하는 *개발자 구현시간* 기준(hints에서 실제 첫 기여자였음). 에이전트 관점에선 localize가 trivial하고 픽스가 인접 코드 복제라 시간 라벨이 과대평가 — 그래서 T2.

## 골드패치 분석
- **건드린 파일/함수:** `django/views/generic/base.py` : `View.http_method_not_allowed()`
- **근본 원인:** 비동기 뷰(`self.view_is_async == True`)의 디스패치 경로는 핸들러 반환값을 `await` 한다. 그러나 `http_method_not_allowed()`는 sync/async 구분 없이 항상 동기 `HttpResponseNotAllowed`를 반환했고, 동기 응답 객체는 awaitable이 아니므로 await 시 `TypeError`가 난다. 형제 핸들러 `options()`는 이미 이 async 분기를 갖고 있었으나 이 메서드만 누락(`9ffd4eae2ce7` 회귀).
- **수정 요지:** 응답을 `response = HttpResponseNotAllowed(self._allowed_methods())`로 **먼저 한 번** 생성한 뒤, `self.view_is_async`가 True면 그 응답을 반환하는 내부 코루틴 `async def func(): return response`를 정의해 `func()`(코루틴)을 반환하고, 아니면 동기 `response`를 그대로 반환한다. 즉 동기 응답 객체를 코루틴으로 감싸 양쪽 컨텍스트에서 동일 객체를 돌려준다 — `options()`와 동일한 패턴.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개):** `test_http_method_not_allowed_responds_correctly` (핵심), `test_mixed_views_raise_error`. 핵심 테스트는 `RequestFactory().post("/")`로 POST 요청을 만들고 `SyncView`(기대 sync) / `AsyncView`(기대 coroutine) 두 케이스에 대해 `instance.http_method_not_allowed(request)`를 호출한다.
- **픽스 증명:** `assertIs(asyncio.iscoroutine(response), is_coroutine)` — sync 뷰면 코루틴이 **아니어야** 하고 async 뷰면 코루틴이어야 한다. 코루틴이면 `asyncio.run(response)`로 풀어낸 뒤, 두 경우 모두 최종 객체가 `HttpResponseNotAllowed` 인스턴스인지 `assertIsInstance`로 확인. 즉 (1) async 뷰에서 405 핸들러가 await 가능한 코루틴을 돌려주고 (2) 그 결과가 올바른 405 응답이며 (3) sync 뷰는 회귀 없이 여전히 동기 응답을 돌려줌을 동시에 증명한다.
- **overfit 관점:** 테스트가 sync/async **양쪽**을 parametrize한 paired-control 구조라 "무조건 코루틴 반환" 같은 special-case 픽스를 배제한다 — special-case로는 sync 케이스의 `assertIs(..., False)`가 깨지므로 overfit 위험 낮음. 다만 `iscoroutine`이라는 좁은 검증이라, 코루틴이 실제 ASGI await 경로에서 올바르게 동작하는 통합 검증은 없음(hints에서 carltongibson이 "full asgi/tests lifecycle은 not required"라 명시) — 이론상 얇음이나 단위 검증으로 충분.
- **regression 관점:** PASS_TO_PASS에 `test_options_handler_responds_correctly`(같은 패턴의 형제 핸들러)와 `test_views_are_correctly_marked` / sync 동작이 포함 → 이들이 sync 경로 보존을 강제하는 `regression-trap`.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈 트레이스백 마지막 줄 `object HttpResponseNotAllowed can't be used in 'await' expression` + "Method Not Allowed (GET)" → `HttpResponseNotAllowed`를 *반환*하는 지점을 grep → `django/views/generic/base.py`의 `View.http_method_not_allowed()` 단일 메서드로 즉시 수렴(L0). 같은 파일에서 `view_is_async` / `options()`를 함께 읽어 정답 템플릿을 확보.
2. **픽스 (왜 올바른 일반화):** 응답을 한 번 만들고 `self.view_is_async` True면 `async def func(): return response`로 감싸 코루틴을 반환, 아니면 동기 반환. 이것이 overfit이 아닌 이유 — (a) ASGI 디스패치가 핸들러 결과를 await 한다는 **구조적 계약**을 충족하고, (b) `options()`가 이미 채택한 프레임워크 관례를 일관되게 따르며, (c) sync/async 두 컨텍스트를 *플래그로* 분기해 어느 한쪽에 특화하지 않는다. "무조건 코루틴" 또는 "응답을 코루틴 내부에서 새로 생성" 같은 변형보다 형제 핸들러와 동형이라 유지보수 일반화가 우수.
3. **regression 안전:** `view_is_async` 게이트를 반드시 유지해야 PASS_TO_PASS의 sync 경로(`test_views_are_correctly_marked`, `test_options_handler_responds_correctly`와 동일 계열의 동기 디스패치)가 안 깨진다. 동기 뷰가 코루틴을 받으면 WSGI 경로에서 응답을 await 하지 않으므로 깨짐 — 따라서 sync 분기 보존이 핵심.
4. **함정 회피:** 오라클 없는 에이전트가 틀릴 지점 — (1) `view_is_async` 분기를 빼고 항상 코루틴 반환 → 테스트 sync 케이스 `assertIs(iscoroutine, False)`에서 적발(이걸 피하려면 반드시 양쪽 분기). (2) 응답을 `async def func()` *내부에서* 새로 생성 → `options()`와 비일관, 부수효과/중복 생성 위험; 바깥에서 한 번 만들어 캡처하는 게 정답. (3) async 분기를 다른 곳(dispatch 등)에 추가하려는 산만한 시도 → hints가 명시했듯 핸들러 메서드 자체에 국소 수정하는 게 의도. `options()`를 정답 템플릿으로 그대로 모방하면 세 함정을 모두 회피.
