---
instance_id: django__django-14787
repo: django/django
base_commit: 004b4620f6f4ad87261e149898940f2dcd5757ef
version: 4.1
difficulty: <15 min fix
created_at: 2021-08-23T12:59:59Z
fail_to_pass: 1
pass_to_pass: 20
gold_files: [django/utils/decorators.py]
---

# django__django-14787

## 문제 요약
`method_decorator()`로 메서드를 감쌀 때, 사용자 데코레이터에게 전달되는 함수가 `functools.partial` 객체라서 `__name__`, `__module__` 같은 함수 속성이 없다. 그래서 데코레이터 내부에서 `@wraps(func)`를 쓰거나 `func.__name__`을 참조하면 `AttributeError: 'functools.partial' object has no attribute '__name__'`가 터진다. 사용자는 평범한 함수처럼 wrapper 속성이 보존되기를 기대했다.

## 유형 분류
- 버그 카테고리: 누락처리 (메타데이터 전파 누락) / API-contract
- 서브시스템: django utils — 데코레이터 헬퍼 (`method_decorator`)
- 증상 타입: 예외 (AttributeError), wrapper 메타데이터 손실(silent-wrong)
- 로컬라이제이션 신호: problem_statement가 "passed to the decorator is a partial object"라고 정확히 지목 → `partial(...)`을 만드는 곳을 찾으면 되고, `method_decorator` 구현은 `django/utils/decorators.py` 단 한 곳이다.

## 골드패치 분석
- 건드린 파일/함수: `django/utils/decorators.py:_multi_decorate._wrapper`
- 근본 원인: `_wrapper` 내부에서 `bound_method = partial(method.__get__(self, type(self)))`로 메서드를 partial로 감싸는데, `partial` 객체는 함수 속성(`__name__`/`__module__`/`__doc__` 등)을 갖지 않는다. 이 partial이 그대로 사용자 데코레이터 체인에 넘어가서, `functools.wraps` 등이 속성을 복사하려다 실패한다.
- 수정 요지: partial을 `wraps(method)`로 한 번 더 감싸 원래 메서드의 wrapper assignment(`WRAPPER_ASSIGNMENTS`: `__module__`, `__name__`, `__qualname__`, `__doc__`, `__dict__`)를 partial 객체로 복사한다.
  - `bound_method = partial(...)` → `bound_method = wraps(method)(partial(...))`
  - 한 줄 변경. `wraps`는 이미 같은 파일에서 import되어 있어 추가 import 불필요.

## 검증 (test_patch)
- FAIL_TO_PASS: `tests/decorators/tests.py`의 `test_wrapper_assignments` ("@method_decorator preserves wrapper assignments.")
- 테스트가 증명하는 방식: `@wraps(func)`를 쓰는 `decorator`를 정의하고, 그 inner에서 `func.__name__`/`func.__module__`을 nonlocal로 캡처한다. `@method_decorator(decorator)`로 감싼 `Test.method`를 호출하면, 픽스 전엔 partial이라 속성이 없어 깨지고, 픽스 후엔 `func_name == 'method'`, `func_module is not None`이 성립한다. 즉 partial이 원본 메서드의 이름/모듈을 보존하는지 직접 단언한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: 에러 메시지의 "partial object" + `method_decorator` 키워드로 grep하면 곧장 `django/utils/decorators.py`의 `_multi_decorate`로 수렴한다. partial을 생성하는 라인이 유일한 용의자.
- 함정/난이도: 단일 파일·단일 라인 수정이라 난이도는 낮음. 다만 `wraps(method)(partial(...))` 처럼 `wraps`를 *partial에* 적용해야지, bound_method 변수를 재할당하는 위치나 데코레이터 루프(`for dec in decorators`) 안쪽을 건드리면 안 된다. 또 `wraps`는 `__dict__`까지 복사하므로 PASS_TO_PASS의 `test_preserve_attributes`/`test_preserve_signature` 회귀를 깨지 않는지 확인 필요.
- 우리 에이전트 관점: 막힐 만한 지점은 partial 자체에 `wraps`를 거는 발상. 흔히 "내부 inner 함수에 wraps" 패턴에 익숙해서, partial을 wrappable 대상으로 보고 `wraps(method)(partial)` 형태로 데코레이트하는 한 줄을 떠올리는 게 핵심. 수정 자체는 작지만 정답 라인을 정확히 고르는 통찰이 관건.
