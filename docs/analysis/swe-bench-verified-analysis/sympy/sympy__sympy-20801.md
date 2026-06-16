---
instance_id: sympy__sympy-20801
repo: sympy/sympy
base_commit: e11d3fed782146eebbffdc9ced0364b223b84b6c
version: "1.8"
difficulty: "15 min - 1 hour"
created_at: 2021-01-15T02:01:23Z
fail_to_pass: 1
pass_to_pass: 96
gold_files: [sympy/core/numbers.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`S(0.0) == S.false`가 `True`를 반환하는데, 역순인 `S.false == S(0.0)`은 `False`를 반환해 비대칭이다.
정수 `S(0)`은 양방향 모두 `S.false`와 `False`로 비교되므로, `Float(0.0)`도 동일하게 `False`여야 일관적이다.
근본 원인은 `Float.__eq__`가 자기 자신이 0일 때(`not self`) `other`의 boolean 여부를 따지지 않고 `not other`를 곧바로 반환하는 데 있다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 `==` 비교 비대칭을 명시하고 `S(0.0)`/`S.false`라는 구체 객체를 준다. `Float.__eq__`로 수렴하기까지 약간의 추적(어느 피연산자의 `__eq__`가 `True`를 만드는지)이 필요하지만 단일 파일·단일 함수다.
- **S2 (Constraint-Reasoning)**: 픽스는 "코드 한 줄 추가"가 아니라 `__eq__` 내부 분기 **순서**라는 불변식을 올바르게 재배열하는 의미 추론이다. `if not self: return not other` 가드가 Boolean 검사보다 앞서면 `Float(0.0) == False`가 `not False == True`로 새는 인과를 짚어야 한다.
- **K-Domain (Domain-bound)**: SymPy의 `Boolean`/`S.false` 싱글턴, `Float`의 truthiness, `__eq__`의 `NotImplemented`/순서 의존 분기라는 코어 내부 계약을 알아야 한다. 일반 파이썬 추론만으로는 "Boolean을 숫자 0과 동치로 보면 안 된다"는 의도가 안 잡힌다.
- **primary = T-ConstraintReason**: 위치는 좁게 잡히나(L1), 진짜 난점은 분기 순서 불변식을 추론으로 합성하는 데 있다. 템플릿(가드 추가/상수 변경)으로는 안 되고, 기존 분기를 어디로 옮겨야 의미가 보존되는지를 "생각으로" 풀어야 하므로 S2 → T-ConstraintReason.

## 난이도 티어 → **T3 (중간)**
구조적 피처: 1파일(`sympy/core/numbers.py`)·실질 2줄(삭제 1블록 + 동일 블록 재삽입), localize는 L1로 비교적 직접적, has-repro(이슈에 REPL 재현 4줄). 그러나 픽스가 "어디에 추가"가 아니라 "어느 위치로 이동"이라는 순서 불변식 추론이라 S1 기계적 픽스가 아니다. PASS_TO_PASS 95개 중 `test_Float`, `test_Float_eq`, `test_bool_eq`, `test_relational` 등 부동소수 0 비교 경로를 많이 건드리므로 **regression-trap**이 실재 — 가드를 단순 삭제하면 `Float(0) == 0` 류가 깨질 수 있다.
공식 라벨("15 min - 1 hour")과 일치: localize는 빠르나 올바른 이동 위치를 고르는 데 한 번의 의미 추론이 든다. 한 줄 자명 픽스(T1/T2)는 아니고, 멀티파일/overfit 고위험(T5)도 아니라 T3.

## 골드패치 분석
- **파일·함수**: `sympy/core/numbers.py`의 `Float.__eq__`.
- **근본원인**: `__eq__` 시작부의 `if not self: return not other` 단락이 `isinstance(other, Boolean)` 검사보다 **먼저** 실행된다. `self`가 `Float(0.0)`이면 `not self`가 참이 되어 `not other`를 반환하는데, `other = S.false`이면 `not S.false == True`라서 `Float(0.0) == S.false`가 `True`로 샌다. 역방향(`Boolean.__eq__`)은 이 단락이 없어 `False`라 비대칭이 생긴다.
- **수정요지**: `if not self: return not other` 블록을 **삭제 후, 모든 타입 분기(Boolean / NumberSymbol / Float / Rational / Number) 다음으로 이동**한다. 이로써 `other`가 `Boolean`이면 먼저 `isinstance(other, Boolean): return False`에 걸려 `S(0.0) == S.false`가 `False`가 되고, `not self` 단락은 비-Boolean·비-Number(`Float != non-Number`) 경로에서만 0 비교 단축으로 살아남는다. 분기 순서만 바꿔 의미를 보존하는 것이 핵심.

## 검증 (test_patch)
- **FAIL_TO_PASS** `test_zero_not_false` 신설: `S(0.0) == S.false`, `S.false == S(0.0)`, `S(0) == S.false`, `S.false == S(0)` **네 방향 모두 `False`**를 단언한다. 패치 전엔 첫 줄(`S(0.0) == S.false`)이 `True`라 실패, 패치 후 `isinstance(other, Boolean)` 분기로 `False`가 돼 통과.
- **픽스 증명**: 테스트가 양방향(Float 우선/Boolean 우선) + Float/Integer 두 0 표현을 모두 검증해 비대칭 자체를 잠근다. 단순 `S(0.0)==S.false`만 검사하지 않아 special-case 통과를 막는다.
- **overfit 관점**: FAIL_TO_PASS가 1개지만 4 assert로 대칭·타입 교차를 커버해 overfit 위험이 낮다(overfit-risk 미표기). regression 관점: 95개 PASS_TO_PASS가 `Float`/`Rational`/`Number` 0 비교 경로를 광범위하게 지키므로(`test_Float_eq`, `test_relational`, `test_Number_cmp` 등) 가드를 잘못 이동·삭제하면 즉시 깨진다 → regression-trap 정당.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 비대칭 단서("`S(0.0)==S.false`만 True")에서 `True`를 만드는 쪽 `__eq__`를 찾는다. `Float(0.0).__eq__(S.false)`를 추적하면 `sympy/core/numbers.py:Float.__eq__` 최상단 `if not self: return not other`가 `not S.false == True`를 반환함을 발견. 역방향이 `False`인 이유는 `Boolean.__eq__`엔 이 단락이 없어서임을 확인.
2. **픽스와 일반화 근거**: 0-단축 가드를 **삭제하지 말고** Boolean/숫자 타입 분기 뒤로 이동. 이유 — `not self` 단축은 `Float(0) == 0` 같은 정당한 0 비교엔 여전히 필요하지만, `other`가 `Boolean`일 때는 숫자 동치로 처리하면 안 된다. 순서 재배열은 "Boolean은 숫자가 아니다"라는 타입 계약을 한 곳에서 강제하므로 special-case가 아닌 올바른 일반화다.
3. **regression 안전**: `test_Float_eq`/`test_relational`/`test_Number_cmp`/`test_Float`의 0·부동소수 비교가 안 깨져야 한다. 가드를 "삭제"가 아니라 "이동"으로 한 덕에 비-Number(`Float != non-Number`) 직전에 `not self` 단축이 남아 0 비교 동작이 보존된다.
4. **함정 회피**: 오라클 없는 에이전트가 흔히 저지를 실수는 (a) 가드를 통째로 **삭제** → 다른 0 비교 회귀, (b) Boolean에만 `if isinstance(other, Boolean): return False`를 추가하되 `not self` 단락은 그대로 둬 NumberSymbol 등 다른 순서 의존 버그를 남기는 것. 정답은 **분기 우선순위 재배치**임을 인지하고, FAIL_TO_PASS가 양방향·Integer 교차까지 요구한다는 점을 살려 비대칭 자체를 제거해야 한다.
