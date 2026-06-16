---
instance_id: sympy__sympy-22456
repo: sympy/sympy
base_commit: a3475b3f9ac662cd425157dd3bdb93ad7111c090
version: "1.10"
difficulty: "15 min - 1 hour"
created_at: 2021-11-10T12:24:42Z
fail_to_pass: 1
pass_to_pass: 29
gold_files: [sympy/codegen/ast.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L0
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, overfit-risk]
---

## 문제 요약

`codegen.ast`의 `String` 클래스는 모든 `Basic` 서브클래스가 만족해야 하는 인자 불변식 `expr.func(*expr.args) == expr`를 지원하지 않는다. 대신 `Token`이 제공하는 `expr.func(**expr.kwargs()) == expr` 키워드 기반 불변식만 만족한다. `String`은 `Basic` 서브클래스이므로 위치인자 기반 재구성 불변식도 성립해야 한다는 것이 이슈의 요구다.

## 유형 (정형화)

- **L (Localization) = L0**: 이슈가 클래스(`String`)와 불변식(`func(*args)`)을 직접 지목. `sympy/codegen/ast.py`의 `class String` 한 곳으로 grep 즉시 수렴. 탐색 비용 거의 없음.
- **S (Repair Strategy) = S2 (+S6)**: 고칠 지점은 자명하나, "왜 `func(*args)`가 깨지는가"를 `Basic`/`Atom`의 args·func 계약으로부터 추론 합성해야 한다. `String`은 `text`를 `not_in_args`로 빼므로 `args == ()`인데, 상속받는 `Token.func`/`kwargs` 경로가 위치 재구성을 보장하지 않는다. 픽스는 단순 가드가 아니라 **MRO를 `(Atom, Token)`로 바꾸고 `func`/`kwargs`를 오버라이드**하는 소규모 구조 변경(S6)이라, S2 추론 + S6 구조 보조의 결합.
- **K (Knowledge) = K-Domain**: SymPy core의 `Basic.args`/`Atom`/`Token.kwargs` 계약, atomic 객체가 args를 갖지 않는다는 내부 규약을 알아야 픽스가 도출된다. 일반 파이썬 추론만으론 불가.
- **primary type = T-DomainBound**: 위치는 자명(L0)이라 난점이 localize가 아니다. 핵심 병목은 "atomic 객체의 args/func 재구성 계약"이라는 sympy 내부 지식이며, 이게 픽스 형태를 결정한다.

APR 관점: 이슈가 불변식을 명시(스펙 명확)하지만 픽스는 템플릿 매칭이 안 되고 `Atom`의 의미를 끌어와야 하므로 S1(Direct-Map)이 아닌 S2/S6다.

## 난이도 티어

**T4 (약간 어려움)**. 구조적 피처:
- 파일수 1 / 줄수 ~10(논리 추가 ~7줄) — scope는 작다(T2~T3 신호).
- localize 직접성 L0, has-repro 없음(이슈에 한 줄 불변식만, 네이티브 스택트레이스 없음).
- 그러나 **K-Domain이 티어를 끌어올림**: `String(Atom, Token)`의 MRO 변경이 `Token`이 제공하던 동작을 깨지 않으면서 `Atom`의 atomic 의미만 취해야 하고, `func`를 `property`로 오버라이드하는 비직관적 트릭(`return lambda: self`)이 필요.
- **P2P trap (regression-trap)**: PASS_TO_PASS 29개가 전부 같은 `test_ast.py`의 `Token` 파생 클래스들(`Assignment`, `CodeBlock`, `Variable`, `FunctionDefinition` 등)이라, `String`의 베이스/메서드 변경이 인접 `Token` 동작을 깨면 즉시 다수 회귀.

공식 라벨 "15 min - 1 hour"과 일치(T3~T4 경계). 구현 줄수는 작지만 도메인 추론과 회귀면이 시간라벨에는 안 잡히는 약간의 상향 압력을 주어 T4로 둔다.

## 골드패치 분석

- **건드린 파일**: `sympy/codegen/ast.py` 단일.
- **건드린 심볼**: import에 `Atom` 추가(`from sympy.core.expr import Expr, Atom`), `class String(Token)` → `class String(Atom, Token)`, `String`에 `kwargs(self, exclude=(), apply=None)` 오버라이드(`return {}`)와 `func` `@property`(`return lambda: self`) 신설.
- **근본원인**: `String`은 `text`를 `not_in_args = ['text']`로 선언해 `args == ()`인 atomic 객체다. 하지만 베이스가 `Token`뿐이라 `Basic`의 atomic 재구성 계약(`func(*args) == self`)이 보장되지 않았다. `Token`은 `func`를 정의하지 않으므로(`__slots__` 사용, `_fields` 속성은 ast.py에 존재하지 않음) `String.func`는 `Basic.func`(`sympy/core/basic.py:683`, line 706 `return self.__class__`)로 resolve되어 `String` 클래스 자체를 반환한다. 따라서 `func(*())`는 인자 0개로 `String` 클래스를 인스턴스화하려 하고, `Token.__new__`가 `text` 슬롯에 default가 없어 `TypeError("No value for 'text' given and attribute has no default")`를 raise한다(원본 복원 실패가 아닌 예외 발생).
- **수정요지**: `Atom`을 첫 베이스로 추가해 atomic 의미(args 없음, `is_Atom`)를 부여하고, `func`를 인자 없이 호출 시 자기 자신을 돌려주는 `lambda: self`로 오버라이드해 `func(*args) == func() == self`를 성립시킨다. `kwargs()`는 빈 dict로 단순화해 기존 키워드 불변식도 보존한다. 주석 `#to be removed when Atom is given a suitable func`가 임시 우회임을 명시.

## 검증 (test_patch)

- **FAIL_TO_PASS = `test_String`**: 기존 단언 `st.func(**st.kwargs()) == st` 뒤에 **`assert st.func(*st.args) == st`** 한 줄 추가. 픽스 전에는 `String.args == ()`이고 `func`는 `Token` 기반이 아니라 `Basic.func`(클래스 반환, `basic.py:706 return self.__class__`)다. `func(*args)=func()`는 원본을 복원하지 못해 실패하는 것이 아니라, `String` 클래스를 빈 인자로 인스턴스화하려다 `Token.__new__`가 `TypeError("No value for 'text' given and attribute has no default")`를 raise하여 실패한다(behavioral 비매칭이 아닌 예외); 픽스 후 `func`가 `lambda: self`라 `func(*()) == self`로 통과.
- **픽스 증명**: 테스트가 정확히 이슈의 불변식(`func(*args) == expr`)을 직접 검사하므로, 추가 단언 통과 = 불변식 성립 = 이슈 해결.
- **overfit 관점(overfit-risk)**: FAIL_TO_PASS가 1개 단언뿐이라 얇다. 다만 `func(*args)==self`는 `args==()`인 atomic에서 일반적으로 성립하는 구조적 픽스라 special-case 우회는 아니다. `func`를 테스트만 통과하도록 하드코딩(예: `String` 텍스트 비교)했다면 overfit이겠지만, 골드는 `Atom` 합성이라 일반화됨.
- **regression 관점**: PASS_TO_PASS 29개가 같은 모듈의 `Token` 파생 클래스 전반을 커버 → MRO 변경이 `Token` 동작을 깨지 않음을 보증. `kwargs()` 오버라이드가 `String`에만 국한되고 `Token.kwargs`는 그대로라 다른 클래스 무영향.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈가 `codegen.ast`의 `String`과 불변식 `func(*args)==expr`를 명시 → `sympy/codegen/ast.py`의 `class String(Token)` 직행(L0). `not_in_args = ['text']`와 `is_Atom = True`를 보고 "args가 비어 있는데 func가 atomic 재구성을 못 함"을 진단.
2. **픽스와 일반화 근거**: `String`은 의미상 `Atom`(서브식 없는 atomic)이다. 베이스에 `Atom`을 추가하고 `func`를 인자 0개로 자기 자신을 반환하게 만들면 `func(*args)==func()==self`가 모든 빈-args atomic에서 성립 → 단일 테스트가 아닌 `Basic` 계약 전체를 만족하는 올바른 일반화. `kwargs() -> {}`로 키워드 불변식도 동시 보존.
3. **regression 안전**: PASS_TO_PASS의 `Token` 파생(`Assignment`/`CodeBlock`/`Variable`/`FunctionDefinition` 등)을 깨면 안 됨. 변경을 `String`에 국한(MRO에 `Atom`을 앞세우되 `Token`은 유지, `kwargs`/`func`는 `String`만 오버라이드)하여 `Token` 공통 경로 무손상.
4. **함정 회피**: 오라클 없는 에이전트가 빠질 함정 — (a) `func`를 일반 메서드로 두면 `Basic.func`(클래스 반환)와 충돌해 `func(*args)`가 깨짐 → 반드시 `@property`로 `lambda: self` 반환. (b) `not_in_args`/`is_Atom`을 이미 가진 상태를 무시하고 `args`에 `text`를 넣어버리면 atomic 의미가 망가지고 다른 코드와 충돌. (c) MRO를 `(Token, Atom)`으로 잘못 두면 `func`/`kwargs` 해석 우선순위가 뒤집힐 수 있어 `(Atom, Token)` 순서가 의도. (d) 테스트만 통과시키는 하드코딩은 overfit — `Atom` 상속으로 구조적으로 풀어야 함.
