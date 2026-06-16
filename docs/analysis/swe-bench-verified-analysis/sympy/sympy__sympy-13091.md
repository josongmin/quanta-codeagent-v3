---
instance_id: sympy__sympy-13091
repo: sympy/sympy
base_commit: d1320814eda6549996190618a21eaf212cfd4d1e
version: "1.1"
difficulty: "15 min - 1 hour"
created_at: 2017-08-05T08:04:32Z
fail_to_pass: 2
pass_to_pass: 89
gold_files: [sympy/core/basic.py, sympy/core/exprtools.py, sympy/core/numbers.py, sympy/geometry/entity.py, sympy/physics/optics/medium.py, sympy/physics/vector/dyadic.py, sympy/physics/vector/frame.py, sympy/physics/vector/vector.py, sympy/polys/agca/modules.py, sympy/polys/domains/domain.py, sympy/polys/domains/expressiondomain.py, sympy/polys/domains/pythonrational.py, sympy/polys/domains/quotientring.py, sympy/polys/fields.py, sympy/polys/monomials.py, sympy/polys/polyclasses.py, sympy/polys/polytools.py, sympy/polys/rings.py, sympy/polys/rootoftools.py, sympy/tensor/array/ndim_array.py, sympy/utilities/enumerative.py]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, has-repro]
---

## 문제 요약
sympy 객체의 rich comparison(`__eq__`, `__lt__` 등)이 알 수 없는 타입을 만나면 `NotImplemented` 대신 `False`를 반환한다. 그 결과 파이썬이 reflected 메서드로 위임하지 못해, 외부 커스텀 클래스 `Foo`에서 `f == s`는 True지만 `s == f`는 False가 되는 **비대칭 동치관계**가 생긴다. 이슈는 `basic.py:316`의 `return False`를 `return NotImplemented`로 바꾸라고 직접 지목하면서, "패키지 전반에 비슷한 곳이 더 있을지 모른다"고 명시한다.

## 유형 (정형화)
- **L = L3 (Multi-site)**: 이슈는 진입점 한 줄(`basic.py:316`)을 정확히 짚어주지만, 올바른 픽스는 동일 패턴이 흩어진 **21개 파일**을 함께 고쳐야 성립한다. `__eq__`만 `NotImplemented`로 바꾸고 `__ne__`가 `not self.__eq__(other)`로 남으면 `__ne__`가 `NotImplemented`에 `not`을 씌워 깨지므로 둘은 반드시 동반 수정이다 → cross-file 조율.
- **S = S2 Constraint-Reasoning (+S1)**: 단일 치환은 기계적(S1)이지만, 핵심은 "왜 `__ne__`를 `not self == other`로 바꿔야 하는가"라는 **불변식 추론**이다. `NotImplemented`는 truthy라 `not self.__eq__(other)`는 잘못된 결과를 내고, `not self == other`로 써야 파이썬이 reflected 위임을 거쳐 동치를 완성시킨다. numbers.py의 Float/Rational 부등호 메서드 안 NumberSymbol 분기는 위임의 **논리 대칭성**(`other.__le__` → `other.__lt__`)까지 따져야 한다.
- **K = K-Domain**: 파이썬 데이터모델(`NotImplemented` 반사 프로토콜)이라는 일반 지식 + sympy의 `_sympify`/`SympifyError` 경계와 NumberSymbol 비교 규약이라는 도메인 지식이 결합된다.
- **primary = T-DiffuseLoc**: 진짜 난점은 "픽스가 무엇인가"(자명)가 아니라 "동일 결함이 어디어디에 퍼져 있는가"를 빠짐없이 찾는 데 있다. 21파일을 놓치면 부분 통과로 끝난다.

## 난이도 티어
**T4 (약간 어려움).** 공식 라벨 "15분-1시간"과 정합. 한 헌크 한 헌크는 trivial하나 구조적 피처가 난이도를 밀어올린다: (1) **파일 21개·헌크 다수** — ICLR 컷의 "≥3파일 → solve<10%" 구간이지만 각 변경이 **동형 패턴의 반복**이라 조율 부담은 낮음. (2) **localize 직접성**: 이슈가 진입점과 패턴을 명시(has-repro 수준의 강한 신호)해 grep `def __ne__` / `return not self.__eq__`로 거의 전수 수집 가능. (3) **P2P trap 큼**(89개) — comparison은 sympy 전반의 hot path라 인접 동작을 깨기 쉽다. localize는 쉽지만 *누락 위험*과 *광범위 regression*이 T3가 아닌 T4로 미는 요인.

## 골드패치 분석
- **건드린 파일·함수**: `Basic.__eq__/__ne__/_has_matcher`(basic.py), numbers.py에서는 `Float`(클래스 L774-1358)와 `Rational`(L1358-1939)만 `__eq__/__ne__/__gt__/__ge__/__lt__/__le__` 전부가 바뀌고, `Integer`(L1939-)는 `__ne__`만(L2112; `__gt__`는 미변경), `NumberSymbol`(L3316-)은 `__eq__/__ne__`만 바뀐다(자신의 `__lt__/__gt__` 등은 미변경). 그리고 exprtools/geometry/physics/polys/tensor/utilities 전반의 `__ne__`(및 polyclasses/polytools의 `eq`, medium의 `__gt__`).
- **근본원인**: ① `__eq__`가 `_sympify` 실패(`SympifyError`) 시 `return False`로 하드코딩 → 반사 위임 차단. ② `__ne__`가 `return not self.__eq__(other)`로 **직접 호출** → `__eq__`가 `NotImplemented`(truthy)를 줘도 `not`이 `False`를 만들어 위임이 무력화. ③ numbers.py의 `Float`/`Rational` 부등호 메서드 안 `if isinstance(other, NumberSymbol):` 분기(즉 NumberSymbol을 *피연산자*로 만났을 때)가 반사 위임 시 잘못된 연산자(`other.__le__` 대신 `__lt__` 등)를 호출하던 **대칭성 버그**. NumberSymbol 자신의 부등호 메서드가 아니라 Float/Rational 쪽 분기다.
- **수정요지**: ①은 `return False` → `return NotImplemented`. ②는 `not self.__eq__(other)` → `not self == other`(연산자를 거쳐야 `NotImplemented` 반사 프로토콜이 동작). `_has_matcher`도 `self.__eq__` → `lambda other: self == other`. ③은 Float/Rational 부등호 메서드의 NumberSymbol 분기에서 `__gt__`↔`__lt__`, `__ge__`↔`__le__` 짝을 올바르게 교정. polyclasses의 `F.__lt__(G)` 류도 `F < G`로 통일해 위임 일관성 확보.

## 검증 (test_patch)
- **FAIL_TO_PASS (채점 대상 2개뿐)**: `test_equality`는 `Basic`을 모르는 `Foo`와 `Basic`을 동등 취급하는 `Bar`에 대해 `b == bar`와 `bar == b`가 **양방향 대칭**임을 단언. `test_comparisons_with_unknown_type`은 `Integer/Float/Rational` 및 `oo/-oo/zoo/nan`에 대해 동치 대칭 + 부등호가 `Foo`와는 `TypeError`를, `Bar`와는 대칭 결과를 내는지 전수 검증. **두 채점 테스트 모두 `pi`(유일한 NumberSymbol)를 쓰지 않고 평범한 `Foo/Bar`와 `oo/-oo/zoo/nan`만 다루므로 `SympifyError`/비교 분기만 타며, ③의 Float/Rational 부등호 짝 교정은 채점 통과에 *불필요*하다.**
- **참고(채점 외)**: `test_NumberSymbol_comparison`은 `(rpi < pi) == (pi > rpi)` 식으로 ③ 부등호 대칭 버그를 직격하지만, FAIL_TO_PASS에도 PASS_TO_PASS에도 없어 SWE-bench가 채점하지 않는다. test_patch가 새로 추가한 테스트일 뿐이다.
- **픽스 증명**: 채점 대상에서는 `NotImplemented` 반환 + `__ne__`가 연산자 경유로 바뀌어야만 양방향 위임이 닫히므로, 두 변경 중 하나라도 빠지면 테스트가 RED. ③ 부등호 대칭 교정은 채점되지 않는 `test_NumberSymbol_comparison`에서만 검증된다.
- **overfit·regression 관점**: FAIL_TO_PASS가 2개로 얇아 보이나 테스트 본문이 7개 타입 × 8개 연산자를 루프로 돌려 입력공간을 넓게 덮어 overfit 위험 낮음. 진짜 위험은 **regression**: 89개 P2P가 comparison에 의존하므로 `NotImplemented` 전환이 기존 `==`/`!=`/정렬 동작을 깨면 즉시 노출된다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 `basic.py:316`과 패턴(`return False` on `SympifyError`, `not self.__eq__`)을 명시 → `grep -rn "return not self.__eq__\|return False    # sympy != other\|def __ne__"`로 전 패키지 동형 사이트를 전수 수집. "더 있을지 모른다"는 힌트를 **반드시 전수 검색 신호**로 해석하는 것이 관건.
2. **픽스와 일반화**: `__eq__`의 `SympifyError` 분기를 `NotImplemented`로, 모든 `__ne__`를 `not self == other`로 통일. 이는 파이썬 데이터모델의 보편 규약을 따르는 **올바른 일반화**다(특정 `Foo`가 아니라 반사 프로토콜 자체를 복원). Float/Rational 부등호의 NumberSymbol 분기는 반사 짝(`__gt__`↔`__lt__`)을 논리적으로 맞춘다(NumberSymbol 자신의 부등호가 아니라 Float/Rational 쪽 분기다).
3. **regression 안전**: 89개 P2P(`test_Float_eq`, `test_Rational_cmp`, `test_Infinity_inequations`, `test_relational`, `test_zoo` 등)는 sympy 내부 타입끼리의 비교를 검증 — 이들은 `_sympify`가 성공하는 경로라 `SympifyError` 분기에 도달하지 않으므로 영향 없음을 확인해야 안전.
4. **함정 회피**: ① `__eq__`만 고치고 `__ne__`를 `not self.__eq__`로 남기는 **반쪽 수정**(NotImplemented가 truthy라 조용히 틀림). ② 21파일 중 일부 누락 → 부분 통과. ③ Float/Rational 부등호의 NumberSymbol 분기 반사 짝을 단순 복붙으로 두면 `test_NumberSymbol_comparison`(채점 외 추가 테스트)이 적발 — 단 SWE-bench 채점에는 영향 없음. ④ `medium.py`의 `__gt__`처럼 `__eq__`가 아닌 다른 메서드의 self-호출(`not self.__lt__`)도 같은 클래스 결함이므로 함께 잡아야 함.
