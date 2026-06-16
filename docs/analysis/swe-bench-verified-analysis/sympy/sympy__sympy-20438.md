---
instance_id: sympy__sympy-20438
repo: sympy/sympy
base_commit: 33b47e4bd60e2302e42616141e76285038b724d6
version: "1.8"
difficulty: "15 min - 1 hour"
created_at: 2020-11-17T08:24:33Z
fail_to_pass: 2
pass_to_pass: 93
gold_files: [sympy/core/relational.py, sympy/sets/handlers/comparison.py, sympy/sets/handlers/issubset.py]
primary_type: T-DomainBound
tier: T5
loc_axis: L3
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep]
---

# sympy__sympy-20438

## 문제 요약
`ProductSet(a, a).is_subset(FiniteSet(...))`가 정답(`True`)을 못 내고 `None`을 반환한다. 같은 두 집합을 `Eq(b, c).simplify()`로 비교하면 `AttributeError: 'Complement' object has no attribute 'equals'`로 크래시한다. 근본 문제는 (1) `ProductSet`→`FiniteSet` 방향 부분집합 판정 디스패치가 아예 없고, (2) 집합 동치(`Eq`) simplify 경로가 집합 차(`lhs - rhs`)에 `Set`가 끼면 `Expr`가 아닌 객체에 산술/`equals`를 시도하기 때문이다.

## 유형 (정형화)
- **Localization = L3.** 픽스가 3개 파일에 **조율되어** 걸린다: 부분집합 디스패치 신규(`issubset.py`), 동치 디스패치 일반화(`comparison.py`), simplify 크래시 가드(`relational.py`). 이슈는 증상 두 개(`is_subset` 오답 + `simplify` 크래시)를 보여주지만 어느 한 곳만 고쳐선 FAIL_TO_PASS가 다 안 풀린다.
- **Repair = S2 (+S6).** 핵심은 multipledispatch 테이블에 **올바른 의미식**을 합성하는 것(`ProductSet`의 원소가 모두 `FiniteSet`에 포함되는가 = `fuzzy_and(b_fs.contains(x) for x in a_ps)`). 동시에 `Set,Set` fallback을 `return None`에서 양방향 `is_subset` 기반 정의로 바꾸고, simplify에 타입가드를 끼우는 소규모 구조 변경(S6)이 함께 든다.
- **Knowledge = K-Domain.** sympy의 set 대수, `multipledispatch` 등록 관례, fuzzy 3-value 로직(`fuzzy_and`/`tfn`), `Expr` vs `Set` 타입 경계를 알아야 한다. 일반 파이썬 추론으론 안 됨.
- **Primary = T-DomainBound.** 병목이 "어디"보다 sympy 내부 디스패치/퍼지로직 도메인지식에 있고, 그 위에서 의미식 추론(S2)이 얹힌다.

## 난이도 티어
**T5 (어려움).** 공식 라벨은 "15분-1시간"이나, 구조 피처는 그보다 무겁다: 3파일·4헌크, L3 멀티사이트 조율, P2P 90개로 **regression-trap 광범위**(set 비교/부분집합/`as_relational` 계열이 다수). `Set,Set` 동치 fallback을 `None`→subset 기반으로 바꾸는 변경은 인접 동작을 깰 잠재력이 커서, test_patch가 `Eq(ProductSet({1},{2}), Interval(1,2))`를 기존 `not in (S.true,S.false)`에서 `is S.false`로 **명세를 강화**한 점이 그 위험을 보여준다. has-repro(네이티브 스택트레이스)는 easiness 신호지만 localize가 한 지점에 안 모이고 의미식을 직접 합성해야 해서 T5로 민다.

## 골드패치 분석
- **`sympy/sets/handlers/issubset.py`** — `ProductSet` import 추가 후 `@dispatch(ProductSet, FiniteSet)`로 `is_subset_sets(a_ps, b_fs)` 신규: `fuzzy_and(b_fs.contains(x) for x in a_ps)`. 곱집합의 각 튜플 원소가 유한집합에 포함되는지 퍼지로 묶는다. 부재했던 디스패치가 채워져 `is_subset`이 `None` 대신 결정값을 낸다.
- **`sympy/sets/handlers/comparison.py`** — `@dispatch(FiniteSet, Interval) -> False` 특수 디스패치를 **삭제**하고, `@dispatch(Set, Set)` fallback을 `return None`에서 `tfn[fuzzy_and(a.is_subset(b) for a,b in [(lhs,rhs),(rhs,lhs)])]`로 일반화. 동치 = 양방향 부분집합으로 정의해 위 신규 `is_subset`을 재사용한다.
- **`sympy/core/relational.py`** — `Relational._eval_simplify`와 `Equality._eval_simplify` 두 곳에 `from sympy.core.expr import Expr` 후 `if not isinstance(lhs/rhs, Expr): return r/e` 가드 추가. `lhs - rhs`(집합 차 → `Complement`)에 `.equals(0)`를 호출하던 크래시를, 피연산자가 `Expr`가 아니면 단순화를 포기하고 원식을 돌려주는 식으로 막는다.

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_issue_19378`, `test_Eq`.** `test_issue_19378`은 `b.is_subset(c) is True`, `b.is_subset(d) is False`(곱집합 vs 다른 유한집합), `Eq(c, b).simplify() is S.true`, `Eq(a, c).simplify() is S.false`, 그리고 비-`Expr` 경우 `Eq({1}, {x}).simplify() == Eq({1}, {x})`(단순화 보류)를 모두 요구 — 세 파일 변경을 동시에 강제한다. `test_Eq`는 `Eq(ProductSet({1},{2}), Interval(1,2))`가 이제 `is S.false`로 **결정**됨을 요구(comparison.py fallback 일반화의 직접 결과).
- **픽스 증명.** `is_subset` 디스패치만으론 `Eq(...).simplify()`가 안 풀리고, comparison fallback만 바꾸면 `is_subset`이 여전히 `None`이라 fallback도 `None`이 된다. relational 가드가 없으면 `Eq({1},{x}).simplify()`가 여전히 크래시. 세 변경이 맞물려야 5개 단언이 통과 → 인과 정합.
- **overfit/regression.** `Set,Set` 동치를 양방향 subset으로 일반화한 건 special-case가 아니라 set 동치의 정의 그 자체라 overfit-risk 낮음. 다만 P2P 90개(set/relational 광역)를 안 깨야 하고, 특히 simplify 가드가 비-`Expr`에서 `return`으로 빠지는 게 기존 `Expr` 경로 동작을 건드리지 않아야 한다(가드가 isinstance로 좁혀 안전).

## 모범답안 (오라클 기반)
1. **Localize.** 스택트레이스가 `relational.py:308 elif dif.equals(0)` + `'Complement' has no attribute 'equals'`를 직접 가리킨다 → `dif = r.lhs - r.rhs`가 `Set`일 때 `Expr` API를 호출하는 게 1차 버그. 동시에 `b.is_subset(c)`가 `None`인 증상 → `sets/handlers/issubset.py`의 dispatch 테이블에 `ProductSet,FiniteSet`가 없음을 확인. 두 증상이 한 PR 의도임을 hint(`ProductSet.is_subset(FiniteSet)`)로 묶는다.
2. **픽스와 일반화 근거.** `ProductSet,FiniteSet` subset = 모든 튜플 원소의 contains를 `fuzzy_and`로 — 곱집합의 외연이 유한하므로 원소 열거가 정확한 정의. `Set,Set` 동치를 양방향 subset으로 정의하면 `FiniteSet,Interval` 같은 개별 특수 디스패치가 불필요해져 삭제 가능(중복 제거이자 일반화). simplify 가드는 "`Expr` 산술이 성립 안 하는 피연산자면 단순화 안 함"이라는 보수적 일반 규칙.
3. **Regression 안전.** P2P의 `test_is_subset`/`test_is_proper_subset`/`test_intersection`/`test_*_as_relational` 등이 깨지면 안 된다. comparison fallback을 `None`→결정값으로 바꿀 때, 이전에 `None`(미정)으로 동작하던 set 쌍이 이제 `False`로 결정될 수 있으므로(예: `ProductSet vs Interval`) test_patch가 `test_Eq`의 기대를 `not in (...)`→`is S.false`로 함께 갱신해 의미 변화를 명시한다.
4. **함정 회피.** (a) relational 가드만 넣고 끝내면 크래시는 막아도 `is_subset`/`Eq.simplify`가 정답을 못 내 FAIL_TO_PASS 미달. (b) `is_subset` 디스패치만 추가하고 comparison fallback을 안 바꾸면 `Eq(c,b).simplify()`가 여전히 `None`. (c) simplify에서 비-`Expr`을 `return` 대신 강제 산술하면 `Eq({1},{x}).simplify() == Eq({1},{x})` 단언 깨짐 — 단순화 **보류**가 정답이지 거짓 결정이 아님. 세 파일을 함께 건드려야만 오라클이 닫힌다는 점이 최대 함정.
