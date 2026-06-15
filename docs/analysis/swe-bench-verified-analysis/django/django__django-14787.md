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
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-14787

## 문제 요약
`method_decorator()`로 메서드를 감쌀 때, 사용자 데코레이터에게 전달되는 함수가 `functools.partial` 객체라서 `__name__`, `__module__` 같은 함수 속성이 없다. 그래서 데코레이터 내부에서 `@wraps(func)`를 쓰거나 `func.__name__`을 참조하면 `AttributeError: 'functools.partial' object has no attribute '__name__'`가 터진다. 사용자는 평범한 함수처럼 wrapper 메타데이터(`__name__`/`__module__` 등)가 보존되기를 기대했고, problem_statement에 재현 코드와 정확한 예외 메시지가 첨부되어 있다.

## 유형 (정형화)
- **L0 (Pinpointed)** — 이슈가 "the function that is passed to the decorator is a partial object"라고 결함 객체(`functools.partial`)를 직접 지목하고, `method_decorator`라는 심볼을 명시한다. `method_decorator`/`partial` 구현은 `django/utils/decorators.py`의 `_multi_decorate._wrapper` 단 한 곳이며 grep 한 방으로 수렴한다. cross-module 추적·후보 다수 없음 → L0.
- **S1 Direct-Map (+S2 보조)** — 이슈가 사실상 픽스를 명세한다: "should preserve wrapper assignments" = `functools.wraps` 적용. 정형 결함클래스(메타데이터 전파 누락 → `wraps`로 복사)에 템플릿 매칭되는 기계적 픽스라 dominant는 S1. 다만 "`wraps`를 *partial 객체에* 적용해야지 inner 함수에 적용하는 게 아니다"라는 적용 지점 선택에 가벼운 의미 추론이 필요해 S2를 보조로 단다. 후보를 마구 시도해 테스트로 거르는 G&V(S3)나 과소명세 일반화(S4)가 아니다.
- **K-Domain** — `WRAPPER_ASSIGNMENTS`, `functools.wraps`가 partial 객체에도 속성을 *복사 가능*하다는 점, `method.__get__(self, type(self))`로 만든 bound method를 partial로 싸는 django 데코레이터 내부 구조를 알아야 정답 라인을 고른다. 순수 일반 파이썬 추론(K-Gen)만으로도 `wraps` 발상은 가능하지만, "왜 partial이 들어가는가"를 이해하려면 django utils 데코레이터 내부지식이 병목이라 K-Domain.
- **primary type = T-DirectMap** — 위치가 명확(L0)하고 픽스가 기계적인 메타데이터 전파 보강(S1)이다. 진짜 어려움이 localize에 있는 T-DiffuseLoc도, 식 합성이 본질인 T-ConstraintReason도 아니다. K-Domain이 있지만 dominant 병목은 "지식"이 아니라 "명확한 위치 + 자명한 1라인 픽스"라서 T-DomainBound보다 T-DirectMap이 맞다.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처:
- **파일 1개 / 헌크 1개 / 실질 1라인** 수정 — 구조적 컷에서 1파일·<5줄은 ≈48% solve 구간.
- **L0 + has-repro** — 이슈에 재현 코드와 네이티브 예외 메시지가 있어 localize 직접성이 최상(repro는 가장 강한 easiness 신호, ~87% 해결률).
- **K-Domain + 가벼운 S2** 가 T1(존나쉬움)에서 한 단계 올린다: 순수 L0+S1+K-Gen이면 T1이지만, `wraps`를 partial에 거는 적용 지점 통찰과 django 내부 이해가 필요해 완전 자명은 아니다.
- **regression-trap 약하게 존재** — `wraps`가 `__dict__`까지 복사하므로 PASS_TO_PASS의 `test_preserve_attributes`/`test_preserve_signature`를 깨지 않는지 확인이 필요하나, 골드 픽스가 이를 안전하게 통과한다.

공식 라벨은 `<15 min fix`(T1에 가까운 prior)이고 실제 1라인이라 개발자 구현시간은 짧다. 그러나 tier는 "에이전트가 정답 라인을 정확히 고르고 일반화를 그르치지 않는" 구조 난이도로 재조정 — 적용 지점 선택(partial vs inner)과 약한 regression-trap, K-Domain 때문에 T1이 아닌 **T2**로 둔다(여전히 공식 라벨과 큰 괴리는 없음).

## 골드패치 분석
- **건드린 파일·함수**: `django/utils/decorators.py` → `_multi_decorate()` 내부 클로저 `_wrapper(self, *args, **kwargs)`.
- **근본 원인**: `_wrapper`가 `bound_method = partial(method.__get__(self, type(self)))`로 bound method를 `functools.partial`로 감싼다. `partial` 객체는 함수 속성(`__name__`/`__module__`/`__qualname__`/`__doc__`/`__dict__`)을 갖지 않는다. 이 partial이 그대로 사용자 데코레이터 체인(`for dec in decorators: bound_method = dec(bound_method)`)에 넘어가, 데코레이터가 `functools.wraps(func)`로 속성을 복사하려 하면 존재하지 않는 `__name__` 접근에서 `AttributeError`가 난다.
- **수정 요지**: partial을 `wraps(method)`로 한 번 더 감싸 원본 메서드의 `WRAPPER_ASSIGNMENTS`를 partial 객체로 복사한다.
  - `bound_method = partial(method.__get__(self, type(self)))`
  - → `bound_method = wraps(method)(partial(method.__get__(self, type(self))))`
  - 한 줄 변경. `wraps`는 이미 같은 파일 상단에서 import되어 있어 추가 import 불필요. `wraps`를 *partial 객체에 호출*해 속성을 partial로 옮기는 것이 핵심(데코레이터 루프 바깥, partial 생성 직후).

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `tests/decorators/tests.py::MethodDecoratorTests.test_wrapper_assignments` — docstring `"@method_decorator preserves wrapper assignments."`.
- **픽스 증명 방식**: 테스트가 `@wraps(func)`를 쓰는 `decorator`를 정의하고, 그 `inner`에서 `func.__name__`/`func.__module__`을 `nonlocal func_name/func_module`로 캡처한다. `@method_decorator(decorator)`로 감싼 `Test.method`를 호출하면 — 픽스 전엔 partial이라 `@wraps(func)`가 `__name__` 접근에서 깨지고, 픽스 후엔 partial이 원본 속성을 보존해 `func_name == 'method'`, `func_module is not None`이 성립한다. 즉 "partial이 원본 메서드의 이름/모듈을 보존하는가"를 직접 단언한다.
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇지만, special-case 우회로 통과하기 어렵다 — `func.__name__`이 실제로 `'method'`여야 하고 `__module__`이 채워져야 하므로 `wraps(method)` 적용 외에 손쉬운 가짜 통과 경로가 없다. overfit-risk는 낮아 플래그하지 않는다(테스트가 동작을 관찰 단언).
- **regression 관점**: PASS_TO_PASS 20개 — 특히 `test_preserve_attributes`("A decorator that sets a new attribute on the method.")와 `test_preserve_signature`가 인접 동작이다. `wraps`가 `__dict__`까지 갱신(`WRAPPER_UPDATES`)하므로 기존에 설정된 메서드 속성을 유지해야 하는데, 골드 픽스는 partial이 원본 `__dict__`를 받도록 해 이들을 깨지 않는다. `@method_decorator` 클래스 데코레이트/튜플 데코레이터/non-callable 에러 경로 등도 partial 생성 라인만 강화했을 뿐이라 안전. → regression-trap 플래그.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 두 신호 — 예외 메시지 `'functools.partial' object has no attribute '__name__'`와 심볼 `method_decorator` — 로 grep. `method_decorator` → `_multi_decorate` → `_wrapper` 내부 `partial(method.__get__(self, type(self)))` 라인이 유일한 partial 생성 지점이자 유일한 용의자. cross-file 추적 불필요(L0).
2. **픽스와 일반화 근거**: partial 객체에 원본 메서드의 함수 메타데이터가 비어 있는 게 근본 원인이므로, partial 생성 직후 `wraps(method)(partial(...))`로 원본의 `WRAPPER_ASSIGNMENTS`를 복사한다. 이는 special-case가 아닌 올바른 일반화 — `functools.wraps`는 partial뿐 아니라 임의의 wrapper에 동일 의미(원본 식별 메타데이터 보존)를 적용하는 표준 기법이고, 특정 데코레이터/특정 속성에 하드코딩하지 않으므로 `__name__` 외 `__module__`/`__qualname__`/`__doc__`/`__dict__` 전부를 한 번에 올바르게 전파한다.
3. **regression 안전**: PASS_TO_PASS의 `test_preserve_attributes`(메서드에 새 속성 설정)와 `test_preserve_signature`를 깨면 안 된다. `wraps`가 `__dict__`를 update하므로 원본에 설정된 속성이 partial로 그대로 넘어가 보존된다. 또 데코레이터 루프(`for dec in decorators`)와 호출부(`return bound_method(*args, **kwargs)`)는 손대지 않아 클래스 데코레이트/튜플 데코레이터/에러 경로 동작이 불변.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) `wraps`를 사용자 데코레이터의 *inner 함수에* 거는 익숙한 패턴으로 착각해, 정작 결함 객체인 *partial에* 안 걸고 엉뚱한 곳을 고침. 정답은 partial 객체 자체를 wrappable 대상으로 보고 `wraps(method)(partial(...))`로 감싸는 것. (b) partial 대신 `lambda`/별도 함수로 bound method를 재작성하는 과한 refactor — 한 줄 `wraps`로 충분하므로 불필요한 구조 변경은 회귀 위험만 키운다. (c) `bound_method` 변수 재할당 위치를 루프 안으로 옮기거나, `method.__get__` 호출 형태를 바꾸는 것 — partial 생성 라인 외엔 손대지 말 것.
