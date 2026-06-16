---
instance_id: sympy__sympy-12489
repo: sympy/sympy
base_commit: aa9780761ad8c3c0f68beeef3a0ce5caac9e100b
version: "1.0"
difficulty: 1-4 hours
created_at: 2017-04-04T08:12:37Z
fail_to_pass: 1
pass_to_pass: 8
gold_files: [sympy/combinatorics/permutations.py]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L1
repair_strategy: S6 (+S1)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`combinatorics.Permutation`은 객체 생성을 `Permutation.__new__`에서 하지만 내부적으로 모듈수준 별칭 `_af_new`(= `Permutation._af_new` staticmethod)를 사용하고, 그 안에서 `Basic.__new__(Perm, perm)`로 항상 `Permutation` 인스턴스를 만든다(`Perm`은 `Permutation`의 모듈수준 별칭). 그래서 `Permutation`을 상속해도 모든 팩토리 경로가 부모 타입을 반환해 서브클래스 인스턴스가 나오지 않는다. 이슈는 "파이썬의 인스턴스 생성 규약(classmethod의 첫 인자 `cls`)을 따르라"고 해법까지 제시한다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 `Permutation.__new__` / `_af_new` / `Basic.__new__(Perm, perm)`를 직접 지목 → 파일·함수가 사실상 확정. 다만 픽스가 한 줄이 아니라 `_af_new`를 호출하는 모든 사이트로 퍼져 단순 L0는 아님.
- **S6 (+S1)**: dominant는 Design-Refactor. `_af_new`/`rmul_with_af`를 staticmethod → classmethod로 승격하고, 모든 호출부의 하드코딩된 `Perm`/모듈별칭 `_af_new`를 `cls`/`self` 바인딩으로 일괄 치환하는 **조율된 구조 변경**이다. 개별 치환 자체는 `_af_new(...)→self._af_new(...)`, `Perm(...)→cls(...)` 식의 기계적(S1) 변환.
- **K-Domain**: sympy `Basic.__new__` 생성 규약, `Permutation`의 `_array_form`/`_size` 내부 상태 캐싱, staticmethod와 모듈 별칭(`Perm`, `_af_new`)이 같은 객체를 가리키는 구조를 알아야 안전하게 손댄다.
- **primary = T-DesignRefactor**: 핵심 난점이 "어디" 추론(L1로 쉬움)이 아니라, 타입 폴리모피즘이 깨지지 않도록 생성 경로 전체를 `cls`-aware하게 **일관 재배선**하는 데 있다.

## 난이도 티어 — T4
- 파일수 1, 줄수는 적당(약 20개 헌크, 순치환 위주). 단일파일이라 멀티파일 조율(L3)은 아니지만 **한 파일 안에서 ~18개 호출 사이트를 빠짐없이** 고쳐야 한다(하나라도 `Perm`/`_af_new` 하드코딩이 남으면 서브클래스가 그 경로에서만 부모타입으로 새어나감).
- has-repro: 이슈가 서브클래싱 실패 시나리오와 해법(classmethod+`cls`)을 명시 → easiness 신호.
- regression-trap: `test_Permutation`/`test_ranking`/`test_mul`/`test_josephus` 등 P2P 8개가 생성 경로를 광범위하게 밟는다. `_af_new`의 `_array_form`/`_size` 캐싱 시맨틱을 한 줄이라도 바꾸면 즉시 깨진다.
- 공식 라벨 `1-4 hours`와 일치: 위치는 쉽지만 변경이 산개(diffuse-within-file)하고 회귀면이 넓어 T4.

## 골드패치 분석
- **파일**: `sympy/combinatorics/permutations.py` 단일.
- **근본원인**: 인스턴스 생성이 `cls` 대신 구체 클래스 `Permutation`(별칭 `Perm`)에 하드코딩됨. `_af_new`/`rmul_with_af`가 `@staticmethod`라 호출 클래스 정보를 못 받고, 본문도 `Basic.__new__(Perm, perm)`로 부모타입을 고정.
- **수정요지**:
  - `_af_new`를 `@staticmethod`→`@classmethod`로 바꾸고 본문을 `Basic.__new__(cls, perm)`로 변경. `rmul_with_af`도 동일하게 classmethod화.
  - `__new__` 내부 분기의 `_af_new(...)`/`Perm(...)`/`Perm(a.array_form, size=size)`/`isinstance(a, Perm)`를 각각 `cls._af_new(...)`/`cls(...)`/`isinstance(a, cls)`로 치환. `__new__` 말미의 `Basic.__new__(cls, aform)` 인라인 생성도 `return cls._af_new(aform)`로 통일.
  - 인스턴스 메서드들(`__mul__`, `__pow__`, `__xor__`, `__invert__`, `mul_inv`, `commutator`, `next_lex`, `next_trotterjohnson`, `__add__` 등)의 `_af_new(...)`→`self._af_new(...)`, `Perm.unrank_lex(...)`→`self.unrank_lex(...)`.
  - classmethod들(`unrank_lex`/`unrank_trotterjohnson`/`josephus`/`from_inversion_vector`/`random`)의 첫 인자 `self`→`cls`로 정정하고 `_af_new(...)`→`cls._af_new(...)`, `Perm(perm)`→`cls(perm)`.
  - `__pow__`의 `type(n) == Perm` 가드를 `isinstance(n, Permutation)`로 바꿔 서브클래스 인스턴스도 `p**p` 금지에 걸리게 함. `__rmul__`은 `Perm(other)`→`cls = type(self); cls(other)`.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_Permutation_subclassing` 1개. `CustomPermutation(Permutation)`을 정의하고 `p = CustomPermutation([1,2,3,0])`이 실제로 서브클래스 타입인지, `type(p * q) == CustomPermutation`(좌측 `__mul__`이 `self._af_new`로 `cls`를 보존)인지, `type(q * p) == Permutation`(부모의 `__mul__` 호출이므로 부모타입)이 맞는지를 단언.
- **픽스 증명**: `cls`-aware 생성으로 바뀌지 않으면 `p`가 `Permutation`이 되거나 `p*q`가 `Permutation`이 되어 즉시 실패. 또한 테스트는 `wrapped_test_Permutation`으로 globals의 `Permutation`을 `CustomPermutation`으로 몽키패치한 뒤 **전체 `test_Permutation`을 서브클래스에서 재실행** → 단 한 곳이라도 `Perm`/모듈 `_af_new` 하드코딩이 남으면 그 경로에서 타입이 새어 깨진다(산개 누락 탐지).
- **overfit 관점**: special-case로 통과 불가. 모든 팩토리 경로를 `cls`로 일반화해야만 wrapped 재실행을 견딘다 → overfit-risk 낮음(그래서 플래그 제외).
- **regression 관점**: `_af_new`의 `_array_form`/`_size` 바인딩 시맨틱은 그대로 유지(클래스만 `Perm`→`cls`). P2P 8개가 생성·곱·랭킹 경로를 전수로 밟아 시맨틱 변형을 즉시 검출.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 `__new__`→`_af_new`→`Basic.__new__(Perm, perm)` 체인을 그대로 지목. `permutations.py`에서 `_af_new`와 `Perm`(모듈 별칭)을 grep해 호출 사이트 전수 수집 — 이것이 진짜 작업 범위.
2. **픽스/일반화**: `_af_new`·`rmul_with_af`를 classmethod로 만들고 `Basic.__new__(cls, perm)` 사용. 그 위에서 "하드코딩된 구체 클래스 참조"를 컨텍스트별 올바른 바인딩으로 치환 — classmethod 안은 `cls`, 인스턴스 메서드 안은 `self`. 이는 special-case가 아니라 파이썬 인스턴스 생성 규약(`cls` 첫 인자)을 따르는 정통 일반화라 서브클래스 다형성이 모든 경로에서 보존된다.
3. **regression 안전**: `_af_new`의 캐싱 의미(`p._array_form = perm; p._size = len(perm)`)는 건드리지 말 것 — 클래스 인자만 교체. `__pow__`의 `type(n)==Perm`→`isinstance(n, Permutation)`는 의도적: 부모타입 동치가 아니라 "퍼뮤테이션이면 거부"라는 원래 의도를 서브클래스로 확장하는 것.
4. **함정 회피**: (a) `cls` vs `self` 혼동 — classmethod 본문에서 실수로 `self._af_new`를 쓰면 안 됨(첫 인자를 `cls`로 rename하는 것까지가 픽스). (b) **산개 누락**: 단 한 사이트라도 `_af_new`/`Perm`을 남기면 wrapped 재실행이 그 경로에서만 부모타입을 토해내며 실패 — grep으로 전수 치환 필수. (c) `q * p`가 `Permutation`인 것을 버그로 오인해 `__mul__`을 양방향 cls-병합하려 들지 말 것: 좌측 객체의 `__mul__`이 우선이라 `type(q*p)==Permutation`이 정상 기대값이다.
