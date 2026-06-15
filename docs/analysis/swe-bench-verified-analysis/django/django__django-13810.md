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
primary_type: T-ConstraintReason
tier: T4
loc_axis: L0
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [overfit-risk, regression-trap, has-repro, underspecified]
---

# django__django-13810

## 문제 요약
ASGI 컨텍스트에서 미들웨어를 로딩할 때, 어떤 미들웨어가 `MiddlewareNotUsed`를 던지면 미들웨어 체인이 "오염"된다. `BaseHandler.load_middleware` 루프에서 `handler` 변수가 이미 `adapt_method_mode()` 결과로 덮어써진 뒤 `MiddlewareNotUsed` 예외로 `continue` 하기 때문에, 그 적응된(adapted) handler가 다음 미들웨어로 전달되어 직전의 sync/async 적합성 검사를 무시하게 된다. 결과적으로 응답 사이클 마지막 미들웨어가 코루틴 대신 동기 `HttpResponse`를 반환해 `TypeError: object HttpResponse can't be used in 'await' expression`이 발생한다. 리포터가 `django/core/handlers/base.py#L58`과 `handler` 변수 누수를 거의 라인 단위로 정확히 짚어줬다.

## 유형 (정형화)

- **L0 (Pinpointed)** — 이슈 본문이 `django/core/handlers/base.py#L58`을 URL로 직접 링크하고, `handler` 변수가 `adapt_method_mode()` 출력으로 덮어써진다는 인과까지 명시. grep 한 방으로 `load_middleware`에 도달. localize는 사실상 공짜.
- **S2 (Constraint-Reasoning) +S6 (Design-Refactor)** — 고칠 지점은 알지만, 올바른 픽스는 "성공한 미들웨어에 한해서만 `handler`를 진행시킨다"는 불변식을 추론으로 합성해야 한다. 한 줄 가드/상수 변경(S1)이 아니라, `try` 안의 즉시 대입을 `adapted_handler` 임시변수로 분리하고 `else:` 절로 commit을 미루는 작은 제어흐름 재구성(S6)이 필요. SemFix식 "조건/시점을 따져 생각으로 푸는" 결함이지 후보를 다수 던지고 테스트로 거르는 것(S3/S4)이 아니다.
- **K-Domain** — 왜 이게 버그인지 이해하려면 django 3.1+의 sync↔async 미들웨어 어댑테이션(`adapt_method_mode`, `async_capable`/`sync_capable` 플래그, ASGI handler 체인이 코루틴을 기대)이라는 프레임워크 내부 지식이 필수. "모델빨"이라기보다 django 미들웨어 lifecycle 지식빨.

**primary type = T-ConstraintReason**: 위치는 명확(L0)하나 픽스가 기계적이지 않다. 핵심 난점이 "예외 경로에서 어떤 상태를 commit/rollback 해야 정합적인가"라는 제어흐름·불변식 추론에 있으므로 T-DirectMap(S1 기계픽스)이 아니라 T-ConstraintReason. L0이라 T-DiffuseLoc도 아니고, 도메인 지식은 병목이 아니라 인과이해의 전제일 뿐이라 dominant는 추론(S2)이라 T-DomainBound로 잡지 않는다.

## 난이도 티어

**T4 (약간 어려움).** 공식 라벨은 "15 min - 1 hour"(T2~T3 prior)이지만 에이전트 난이도로 재조정하면 T4로 민다.

- patch scope는 작다(1파일·1함수·~6줄, 헌크 2개) → 단독으로는 T2 쪽.
- 그러나 (1) **S2+S6 추론 비용**: `try/except/else` 시맨틱으로 "성공 시에만 commit"을 표현해야 하는데, `try` 본문 안 조건분기나 `handler`를 그대로 두고 `adapted_handler`만 쓰는 절반짜리 픽스는 로그 시점/체인 진행이 어긋난다.
- (2) **K-Domain 인과 장벽**: report가 라인은 줬어도 "왜 handler 누수가 async 체인을 깨는가"를 검증하려면 ASGI 미들웨어 체인을 머릿속(또는 실행)으로 재현해야 하는데 이게 비싸다. `underspecified` — 이슈가 "이게 의도된 동작인지 문서 문제인지 모르겠다"며 모호하게 끝나, 에이전트가 "문서 고치기"로 오답할 유인이 있다.
- (3) **regression-trap**: PASS_TO_PASS 30개 중 `MiddlewareSyncAsyncTests` 9개·`MiddlewareNotUsedTests` 로그테스트들이 어댑테이션 로그 시점과 정상 sync/async 분기를 그대로 검증 → 픽스가 로그 순서나 정상경로를 건드리면 회귀.

scope만 보면 T3이나, 추론+도메인 인과+넓은 P2P trap 셋이 겹쳐 T4가 방어가능. T5는 아님(멀티파일/멀티사이트 아니고 overfit이 치명적 고위험은 아님).

## 골드패치 분석

- **건드린 파일/함수**: `django/core/handlers/base.py` : `BaseHandler.load_middleware`
- **근본 원인**: `try` 블록 안에서 `handler = self.adapt_method_mode(...)`가 `handler`를 **즉시** 덮어쓴다. 바로 다음 줄 `mw_instance = middleware(handler)`가 `MiddlewareNotUsed`를 던지면 `except` → `continue`로 그 미들웨어는 체인에서 스킵되지만, `handler`는 이미 그 미들웨어 기준으로 적응된 값으로 남는다. 즉 체인에 편입되지도 않은 미들웨어의 sync/async 적응이 다음 미들웨어로 전파되어, 이후 어댑테이션 검사가 어긋난 handler 위에서 수행된다(체인 "오염").
- **수정 요지**: 두 헌크.
  1. **(linchpin)** 어댑테이션 결과를 `handler`가 아니라 임시변수 `adapted_handler`에 받고, `mw_instance = middleware(adapted_handler)`로 인스턴스화 → `handler` 원본 보존. 버그를 실제로 제거하는 것은 바로 이 변수명 분리다. 기존엔 `handler = adapt_method_mode(...)`가 handler를 즉시 오염시키고 `continue`로 그 값이 다음 패스로 전파됐는데, `adapted_handler`로 받으면 `continue`가 일어나도 `handler` 원본이 그대로 보존되어 오염이 차단된다.
  2. `try/except`에 `else: handler = adapted_handler` 절을 추가. 단, 이 `else` 대입은 **success path에서 인과적으로 inert**하다 — 성공 경로에서는 루프 끝 `handler = convert_exception_to_response(mw_instance)`(base.py 88줄)가 `handler`를 무조건 덮어쓰고, 그 사이 코드는 `mw_instance`만 읽지 `handler`를 읽지 않으므로 `else` 대입은 read되기 전에 overwrite된다. 즉 `else`는 의도표현/defensive일 뿐이고, 다음 handler도 `mw_instance`(= `middleware(adapted_handler)` 래핑)에서 파생된다.
  
  정리하면 fix의 본체는 try/except/else 구조가 아니라 **변수명 rename(hunk1)**이다. `MiddlewareNotUsed`가 에러가 아니라 정상 제어흐름이라는 점이 "오염된 adapted 값을 `continue` 경로에서 살리지 않는다"는 핵심을 뒷받침하며, `else` 절을 fix의 본체로 격상하는 것은 과대평가다.

## 검증 (test_patch)

- **FAIL_TO_PASS (1개)**: `test_async_and_sync_middleware_chain_async_call` (MiddlewareNotUsedTests). `MIDDLEWARE=[SyncAndAsyncMiddleware, MyMiddleware]`로 오버라이드하고 `MyMiddleware`가 `MiddlewareNotUsed`를 던지게 한 뒤 `async_client.get()`으로 비동기 요청.
- **픽스 증명**: 픽스 전이면 `MyMiddleware`의 `MiddlewareNotUsed`가 `handler`를 오염시켜 async 체인이 동기 `HttpResponse`를 흘려 await 불가 → 깨짐. 픽스 후엔 `response.content == b'OK'`, `status_code == 200`. 추가로 DEBUG 로그를 캡처해 `cm.records[0]`가 `Asynchronous middleware ... MyMiddleware adapted.`, `cm.records[1]`이 `MiddlewareNotUsed: '...MyMiddleware'`임을 단언 — 어댑테이션 로그는 정상적으로 찍히되(시도는 함) 그 adapted handler가 다음으로 새지 않았음(content OK)을 간접 증명. 즉 "adapt했지만 commit 안 함"이라는 골드의 분리를 양쪽에서 핀다.
- **overfit 관점 (`overfit-risk`)**: FAIL_TO_PASS가 **단 1개**라 얇다. `else: handler = adapted_handler` 대신 "MyMiddleware라는 이름이면 skip" 같은 special-case로도, 혹은 `MiddlewareNotUsed`만 잡아 handler를 수동 복원하는 우회로도 이 한 테스트는 통과 가능 → 일반화 검증이 약함. 골드의 try-else 구조가 "모든 MiddlewareNotUsed 미들웨어"로 자연 일반화되는 올바른 픽스.
- **regression 관점 (`regression-trap`)**: PASS_TO_PASS 30개가 정상경로의 sync/async 분기, 어댑테이션 로그 시점, MiddlewareNotUsed 로깅을 그대로 검증. 회귀 안전성을 좌우하는 것은 **`handler =` → `adapted_handler =` rename**이다 — 정상 미들웨어는 `mw_instance = middleware(adapted_handler)`로 adapted handler를 직접 받고, 다음 handler도 `mw_instance`에서 파생되므로 rename만으로 P2P가 보존된다. `else: handler = adapted_handler`는 success path에서 루프 끝 `handler = convert_exception_to_response(mw_instance)`(base.py 88줄)로 무조건 덮어써져 read 전에 overwrite되는 dead assignment라 회귀 안전성을 좌우하지 않는다. 반대로 rename 없이 `handler`를 `continue` 경로에서 계속 오염시키면 오염된 adapted 값이 다음 패스로 새어 9개 `MiddlewareSyncAsyncTests` 등이 깨진다.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈가 `base.py#L58`을 직접 링크 + "`handler`가 `adapt_method_mode()`로 덮어써진 채 다음 패스로 전파"라는 인과를 명시 → 바로 `BaseHandler.load_middleware`의 `for middleware_path` 루프, 특히 `try: handler = self.adapt_method_mode(...); mw_instance = middleware(handler) except MiddlewareNotUsed: ... continue` 블록을 연다. 탐색 거의 불필요(L0).
2. **픽스와 올바른 일반화**: 결함은 "예외로 스킵된 미들웨어의 어댑테이션이 `handler` 변수를 오염시켜 다음 패스로 전파된다". 올바른 일반화이자 실제 linchpin은 **어댑테이션 결과를 `handler` 대신 `adapted_handler`로 분리**해 `continue` 경로에서 `handler` 원본이 보존되게 하는 변수명 rename이다(`mw_instance = middleware(adapted_handler)`). `else: handler = adapted_handler`는 부가적으로 추가되지만 success path에서 곧바로 `handler = convert_exception_to_response(mw_instance)`로 overwrite되어 인과적으로 inert하다. 이 rename은 `MyMiddleware` 특정이 아니라 "`MiddlewareNotUsed`를 던지는 임의의 미들웨어"로 자연 일반화되므로 overfit이 아니다.
3. **regression 안전**: 변수명 rename(`adapted_handler`)으로 정상 미들웨어는 `mw_instance = middleware(adapted_handler)`로 adapted handler를 직접 받고 다음 handler도 `mw_instance`에서 파생되므로 `MiddlewareSyncAsyncTests` 9개와 어댑테이션 로그 테스트들이 그대로 통과(`else:` 대입은 success path에서 line 88 `handler = convert_exception_to_response(mw_instance)`로 overwrite되는 dead assignment라 진행을 담당하지 않는다). adapt 호출 자체는 모든 미들웨어에 대해 여전히 일어나므로(로그도 동일 시점) `Asynchronous middleware ... adapted.` 로그 단언이 유지된다 — 어댑테이션을 조건부로 "건너뛰는" 식으로 고치면 이 로그가 사라져 회귀.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) 이슈가 "문서 문제인지 의도인지" 모호하게(`underspecified`) 끝나 코드 대신 문서를 고치려 함 → 하지만 "체인 오염"이라는 명확한 버그 인과가 있으므로 코드 수정이 정답. (b) `try` 본문 안에서 조건분기로 handler를 되돌리는 식의 어긋난 픽스는 로그 시점/체인 진행이 틀어질 수 있다. 단, `handler`는 그대로 두고 `adapted_handler`로 받아 인스턴스화에 쓰되 `else: handler = adapted_handler` commit을 생략하는 것은 **P2P 회귀를 일으키지 않는다** — 정상 미들웨어가 `mw_instance = middleware(adapted_handler)`로 adapted handler를 직접 받고, success path의 `handler`는 어차피 루프 끝 `handler = convert_exception_to_response(mw_instance)`로 무조건 덮어써지므로 `else` 대입은 dead다. 즉 rename(hunk1)만으로 오염 차단과 P2P 보존이 모두 성립하고, `else`는 의도표현일 뿐이다. (c) FAIL_TO_PASS가 1개라 단일 미들웨어 이름 special-case로 green을 받고 멈출 유혹 → 골드의 try-else 구조적 분리가 일반해. (d) async 체인 재현이 어려워 "왜 버그인지" 인과 검증에서 막힐 수 있으나, 핵심은 "예외 경로에서 변수 상태 누수" 패턴 인식이지 ASGI 전체 재현이 아니다.
