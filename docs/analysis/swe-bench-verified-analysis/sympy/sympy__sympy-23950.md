---
instance_id: sympy__sympy-23950
repo: sympy/sympy
base_commit: 88664e6e0b781d0a8b5347896af74b555e92891e
version: "1.12"
difficulty: "15 min - 1 hour"
created_at: 2022-08-20T18:21:10Z
fail_to_pass: 1
pass_to_pass: 4
gold_files: [sympy/sets/contains.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [overfit-risk, has-repro]
---

## 문제 요약
`Contains(x, Reals).as_set()`가 set이 아니라 `Contains(x, Reals)` 자기 자신(Boolean)을 돌려준다. `Contains`는 set이 아니라 boolean이므로 이는 잘못이며, 그 결과 `as_relational`이 없어 `Piecewise((6, Contains(x, Reals)), (7, True))`가 `eval` 내부의 `c.as_set().as_relational(x)` 호출에서 `AttributeError: 'Contains' object has no attribute 'as_relational'`로 깨진다. boolean `p`에 대한 `p.as_set()`은 `{x | p}`를 나타내는 set을 줘야 한다.

## 유형 (정형화)
- **L = L0 (Pinpointed)**: 이슈가 `Contains.as_set`을 심볼 단위로 직접 지목한다. `sympy/sets/contains.py`의 `as_set` 메서드 한 곳, grep 한 방이다.
- **S = S2 (Constraint-Reasoning) (+S5)**: 고칠 지점은 자명하나 "무엇을 반환해야 옳은가"는 추론 합성이 필요하다. boolean의 `as_set` 계약(= `{x | p}`)을 따져 `Contains(x, s)`의 그 집합이 바로 `s`(= `self.args[1]`)임을 도출해야 한다. 이슈 본문/힌트가 의도된 스펙("just return `set`")을 제시하므로 spec-inference(S5) 보조가 섞인다.
- **K = K-Domain**: SymPy의 Boolean/Set 계약(`as_set`↔`as_relational` 쌍, `args` 레이아웃, `Contains`가 `BooleanFunction` 서브클래스라는 점)을 알아야 옳은 식을 짠다. 순수 일반 파이썬 추론으로는 `args[1]`이 set 인자임을 알 수 없다.
- **primary = T-ConstraintReason**: 위치는 L0로 명확하나 난점이 "올바른 반환식 합성"에 있어 직접-매핑(T-DirectMap)이 아니다. APR 관점에서 None가드/상수교체식 템플릿이 아니라, set 계약 불변식을 만족하는 식(`self.args[1]`)을 의미론적으로 도출하는 SemFix류 픽스라 S2가 dominant다.

## 난이도 티어
**T3 (중간)**. 구조 피처: 단일 파일(`contains.py`) · 1줄 변경 · localize는 L0로 자명 · `has-repro`(이슈에 실행 스택트레이스 존재). 이 피처들만 보면 T2급으로 보인다. 그러나 (1) 픽스가 상수/가드가 아니라 set 계약을 만족하는 식을 추론해야 하고, (2) FAIL_TO_PASS가 `test_as_set` 단 1개로 **얇아** special-case로도 통과 가능(overfit-risk), (3) 힌트가 `False`일 때 `EmptySet`/일반 `ConditionSet`까지 거론해 "어디까지 일반화하는가"의 스펙 판단이 끼어든다. 추론·스펙 요소가 단순 직접매핑보다 한 단계 위라 T2가 아니라 T3로 민다. 공식 라벨("15 min - 1 hour")과 정합적이다.

## 골드패치 분석
- **건드린 파일·함수**: `sympy/sets/contains.py`의 `Contains.as_set` (단 1메서드, 1줄).
- **근본 원인**: `Contains.as_set`이 `raise NotImplementedError()`로 미구현 상태였고, 상위에서 boolean의 `as_set()`을 호출하는 경로(`Piecewise.eval`의 `c.as_set().as_relational(x)`)가 set을 기대하지만 `Contains`는 set이 아니므로 `as_relational`이 없어 깨진다. (정확히는 base에서 `NotImplementedError`였고, 이슈 표면 증상인 "Contains를 반환"은 그 미구현/우회 동작의 결과로 드러난 것이다.)
- **수정 요지**: `raise NotImplementedError()` → `return self.args[1]`. `Contains(x, s)`의 `args = (x, s)`이므로 `args[1]`이 곧 대상 집합 `s`다. boolean `Contains(x, s)`의 진리집합 `{x | x ∈ s}`은 정확히 `s`이므로, `as_set`이 그 set을 반환하면 후속 `as_relational` 호출이 set의 메서드로 정상 동작한다.

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_as_set`**: 기존엔 `raises(NotImplementedError, lambda: Contains(x, FiniteSet(y)).as_set())`였던 단언을, 픽스 후 `Contains(x, FiniteSet(y)).as_set() == FiniteSet(y)`, `Contains(x, S.Integers).as_set() == S.Integers`, `Contains(x, S.Reals).as_set() == S.Reals` 세 단언으로 교체한다.
- **픽스 증명**: 세 단언 모두 "반환값이 두 번째 인자 set과 동일"임을 요구한다. `return self.args[1]`이 정확히 그 set을 돌려주므로 통과한다. FiniteSet/Integers/Reals 세 종류 set(유한·정수·실수)을 커버해 `args[1]` 경로가 set 종류에 무관함을 보인다.
- **overfit·regression 관점**: FAIL_TO_PASS가 1개 테스트(3 assert)로 얇아 `overfit-risk`다 — 가령 "FiniteSet면 그 set 반환" 같은 special-case로도 통과하나, 골드는 `self.args[1]` 무조건 반환이라 자연스러운 일반화다. 힌트가 언급한 "`Contains`가 False일 때 EmptySet" 케이스는 테스트가 강제하지 않고 골드도 다루지 않는다(미검증 입력공간). PASS_TO_PASS 4개(`test_contains_basic`, `test_issue_6194`, `test_issue_10326`, `test_binary_symbols`)는 `as_set`을 건드리지 않으므로 regression 없음.

## 모범답안 (오라클 기반)
1. **localize**: 스택트레이스의 `c.as_set().as_relational(x)`와 표면 증상 `Contains(x, Reals).as_set()`이 `Contains.as_set`을 직접 지목 → `sympy/sets/contains.py`의 `as_set` 메서드(base에서 `raise NotImplementedError()`)로 한 방에 수렴.
2. **픽스와 일반화 근거**: boolean `p`의 `as_set()` 계약은 진리집합 `{x | p}`. `Contains(x, s)`의 진리집합은 `x ∈ s` ⟺ `s` 자체이고, `args = (x, s)`이므로 `return self.args[1]`이 옳다. set 종류(FiniteSet/Integers/Reals)와 무관하게 두 번째 인자를 그대로 돌려주므로 special-case가 아닌 정당한 일반화다.
3. **regression 안전**: `as_set`은 base에서 항상 예외를 던지던 죽은 경로라 이를 set 반환으로 바꿔도 기존 동작을 깨지 않는다. PASS_TO_PASS 4개는 `eval`/`binary_symbols`/contains 기본동작만 보므로 영향 없음 — 이 한 줄 변경이 인접 동작을 건드리지 않음을 확인.
4. **함정 회피**: (a) 힌트가 "`False`면 EmptySet", "superclass Boolean이 ConditionSet 반환" 등 더 큰 설계를 거론해 과잉구현(다인자/ConditionSet 분기)으로 빠질 수 있으나, 테스트와 골드는 단일 free var · `args[1]` 직반환으로 충분하다 — scope creep 회피. (b) 표면 증상("Contains를 반환")만 보고 `as_set`이 *반환*을 바꾸는 것으로 오해해 `eval`/`contains` 쪽을 손대면 오답이다. 진짜 결함은 `as_set` 미구현이다. (c) `args[0]`(심볼 `x`)와 `args[1]`(set)을 혼동하지 말 것 — 반환해야 하는 건 set인 `args[1]`이다.
