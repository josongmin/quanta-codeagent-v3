---
instance_id: astropy__astropy-13977
repo: astropy/astropy
base_commit: 5250b2442501e6c671c6b380536f1edb352602d1
version: "5.1"
difficulty: "15 min - 1 hour"
created_at: "2022-11-01T22:24:58Z"
fail_to_pass: 20
pass_to_pass: 322
gold_files: [astropy/units/quantity.py]
primary_type: T-SpecInference
tier: T4
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep]
---

## 문제 요약
`Quantity.__array_ufunc__()`가 인식할 수 없는 피연산자(예: `unit` 속성만 가진 duck-type)를 만나면 `NotImplemented`를 돌려주지 않고 `core.py`의 `_condition_arg` 깊은 곳에서 `ValueError`("Value not scalar compatible...")를 던진다. 그 결과 `(1 * u.m) + DuckArray(1 * u.mm)`처럼 왼쪽 피연산자 단위가 다를 때 numpy의 타입별 디스패치(`+` 예시에선 `__radd__` → 상대편 `__array_ufunc__`)로 넘어가지 못하고 예외로 죽는다. 이슈는 numpy subclassing 계약(구현 불가 시 `NotImplemented` 반환)에 맞춰, 처리할 수 없는 입력이면 예외 대신 `NotImplemented`를 반환하자고 제안한다. 다만 실제 FAIL_TO_PASS 테스트(`TestBinaryUfuncs::test_full`)는 `+` 연산자가 아니라 `ufunc(quantity, duck_quantity, out=out)`처럼 numpy ufunc를 직접 호출하므로, 거기서 통과를 만드는 폴백은 `__radd__`가 아니라 numpy ufunc 머신러리의 `__array_ufunc__` 프로토콜 디스패치다(한 피연산자가 `NotImplemented`를 반환하면 다른 피연산자의 `__array_ufunc__`를 시도). 근본 메커니즘(`NotImplemented` 반환→타입별 디스패치)은 동일하나 F2P 경로엔 `__radd__`가 끼지 않는다.

## 유형 (정형화)
- **L1 (Traceable)**: 스택트레이스가 `quantity.py:617 __array_ufunc__` → `core.py _condition_arg`까지 정확히 찍혀, 고칠 메서드(`Quantity.__array_ufunc__`)는 한 방에 좁혀진다. 다만 "어디를 어떻게 감쌀지"는 단순 grep 한 줄이 아니라 메서드 전체 흐름 이해가 필요해 L0는 아니다.
- **S5 (Spec-Inference) +S6 (Design-Refactor)**: 픽스의 본질은 "처리 불가 입력에서 무엇을 반환해야 하는가"라는 **계약(numpy `__array_ufunc__` 프로토콜)을 이슈/numpy docs에서 재구성**하는 것이다(S5). 그 계약을 만족하려면 메서드 본문 전체를 `try/except (TypeError, ValueError)`로 감싸고, 예외 발생 시 입력/출력이 모두 표준 ufunc 핸들러(ndarray/자기자신/None)일 때만 진짜 raise하고 아니면 `NotImplemented`를 돌리는 **구조 재배치**가 필요하다(S6).
- **K-Domain**: numpy `NDArrayOperatorsMixin`/`__array_ufunc__` 디스패치, reflected operator fallback, `Column` 같은 기존 duck-type과의 상호운용 보존 등 astropy/numpy 내부 지식이 병목.
- **primary = T-SpecInference**: "어디"는 명확하지만 진짜 난점은 코드만으론 안 나오는 의도(올바른 반환 규약)를 numpy 서브클래싱 계약에서 추론해 재구성하는 데 있다. S1식 단순 가드 추가로는 풀리지 않는다.

## 난이도 티어
**T4 (약간 어려움)**. 구조 피처: 단일 파일(`quantity.py`) 단일 메서드지만 (a) 수정이 ~17줄 헌크 전체 들여쓰기 재배치 + 신규 except 절로, 단순 1줄 가드가 아니다(S6). (b) `has-repro`(완전 재현 코드 + 네이티브 스택)로 localize는 쉬워 T5는 아니다. (c) `regression-trap`이 핵심 — P2P가 **322개**로 기존 단위연산·비교·in-place·reduce·outer 전 경로를 하나도 안 깨야 한다. 특히 hints가 경고한 `Quantity ↔ Column` 상호작용이 깨지면 안 된다. (d) except 절의 일반화 조건(`ignored_ufunc` 멤버십 검사)을 정확히 짜야 overfit/over-catch를 동시에 피한다. 공식 라벨 "15분~1시간"과 대체로 일치하나, 넓은 P2P trap과 계약 추론 난점이 시간라벨엔 안 잡혀 T3가 아닌 T4로 본다.

## 골드패치 분석
- **파일/함수**: `astropy/units/quantity.py`의 `Quantity.__array_ufunc__`.
- **근본원인**: 기존 구현은 "`unit` 속성만 있으면 사실상 Quantity로 취급"하여 변환을 강행한다. 인식 못 하는 입력이 들어오면 변환 단계(`converter(input_)` → `_condition_arg`)에서 `ValueError`/`TypeError`가 그대로 전파되어, numpy가 reflected 연산으로 폴백할 기회를 박탈한다.
- **수정요지**: 메서드 본문(`converters_and_unit` 호출부터 `_result_as_quantity` 반환까지) 전체를 `try`로 감싼다. `except (TypeError, ValueError) as e`에서 `inputs + out`을 모아, 이들의 `type(io).__array_ufunc__`가 모두 `ignored_ufunc = (None, np.ndarray.__array_ufunc__, type(self).__array_ufunc__)` 중 하나면(= 외부 핸들러가 개입할 여지가 없는 진짜 잘못된 입력) 원래 예외를 `raise e`, 아니면(= duck-type 등 다른 `__array_ufunc__` 보유 객체가 섞임) `return NotImplemented`. docstring 반환형도 `Quantity or NotImplemented`로 갱신.

## 검증 (test_patch)
- **FAIL_TO_PASS (20개)**: 신규 `TestUfuncReturnsNotImplemented::TestBinaryUfuncs::test_full[...]` 군. `DuckQuantity3`(자체 `__array_ufunc__` 보유)와 실제 `Quantity`를 `add`/`multiply`/`less`로 연산, `out=None`/`out="empty"`로 호출해 결과가 duck-type 경로로 위임되고 기대값과 같음을 검증. 픽스 전엔 `Quantity.__array_ufunc__`가 `ValueError`로 죽어 `__radd__` 위임이 안 돼 실패한다.
- **픽스 증명**: except 절이 "다른 `__array_ufunc__` 보유 입력 존재"를 감지해 `NotImplemented`를 반환 → numpy가 `DuckQuantity3.__array_ufunc__`로 폴백 → 통과. `test_quantity.py::test_non_number_type`는 `q1 + {"a": 1}`(dict은 표준 핸들러뿐)이라 여전히 `TypeError`가 raise되어야 함을 `pytest.raises(match=...)`로 고정 — over-catch(전부 NotImplemented화)를 차단하는 anti-overfit 테스트.
- **overfit/regression 관점**: F2P가 `add/multiply/less`(산술·곱·비교) 3종 × scalar/array × out 유무로 충분히 일반화돼 special-case 통과가 어렵다. P2P 322개가 기존 ufunc 전 경로를 회귀 가드. `ignored_ufunc` 화이트리스트 방식이라 정상 입력은 except에 진입하지 않아 common-path 무영향.

## 모범답안 (오라클 기반)
1. **localize**: 스택트레이스가 `quantity.py __array_ufunc__` → `core.py _condition_arg`의 `ValueError`를 직접 가리킨다. 근본 처리 지점은 `_condition_arg`가 아니라 그 예외가 전파되는 `Quantity.__array_ufunc__` — 여기서 numpy 계약(NotImplemented 반환)을 책임져야 하므로 이 메서드를 수정 타깃으로 확정.
2. **픽스와 일반화 근거**: 변환 강행을 try로 감싸고, 예외 시 "표준 핸들러 외의 `__array_ufunc__`를 가진 입력/출력이 하나라도 있으면" `NotImplemented`. 이게 올바른 일반화인 이유 — numpy subclassing 계약상 미지원 입력은 NotImplemented여야 reflected/타입별 디스패치가 동작하고, `ignored_ufunc` 멤버십으로 "진짜 잘못된 값(dict 등)"과 "위임 가능한 duck-type"을 구별하므로 무차별 예외 삼킴이 아니다.
3. **regression 안전**: 정상 Quantity 연산은 try 본문에서 예외가 안 나므로 except에 진입조차 안 함 → 322개 P2P 무영향. hints가 짚은 `Quantity ↔ Column`도 Column이 ndarray-backed라 `_condition_arg`가 받아들여 변환이 성공하고 try 본문에서 예외가 나지 않으므로 except에 진입조차 안 한다. (가령 except에 도달하더라도 Column은 ndarray 서브클래스로 `np.ndarray.__array_ufunc__`를 상속해 `ignored_ufunc`에 속하므로, `NotImplemented`가 아니라 `raise e`로 진짜 예외가 난다 — Column엔 "NotImplemented로 안전 폴백"이 성립하지 않으며, 안전성의 실제 근거는 변환 성공으로 except에 들어가지 않는다는 점뿐이다.)
4. **함정 회피**: (a) `_condition_arg`나 `converters_and_unit`을 직접 손대 우회 변환을 넣으면 hints가 명시한 "시도조차 말아야 한다"는 의도를 위반 — 메서드 경계에서 처리해야 함. (b) except를 `except Exception`이나 무조건 `return NotImplemented`로 넓히면 `test_non_number_type`(dict는 TypeError raise 유지)이 깨진다 — `ignored_ufunc` 검사로 반드시 좁혀야 함. (c) `out` kwarg를 정규화(`kwargs.get("out", tuple())`)하지 않으면 `inputs + out` 결합에서 터질 수 있다.
