---
instance_id: django__django-14017
repo: django/django
base_commit: 466920f6d726eee90d5566e0a9948e92b33a122e
version: 4.0
difficulty: 15 min - 1 hour
created_at: 2021-02-18T13:05:27Z
fail_to_pass: 2
pass_to_pass: 147
gold_files: [django/db/models/query_utils.py]
primary_type: T-DirectMap
tier: T3
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap, overfit-risk]
---

# django__django-14017

## 문제 요약
`Exists(...) & Q()`는 동작하지만, 피연산자 순서를 뒤집은 `Q() & Exists(...)`는 `TypeError`를 던진다. `&`/`|` 연산이 Q-Exists 조합에서 교환법칙(commutative)을 따라야 하는데 그렇지 않다. 사용자는 두 방향 모두 정상적으로 `Q` 객체로 결합되기를 기대했으나, `Q()`가 좌측 피연산자일 때(즉 `Q.__and__`가 디스패치될 때)만 예외가 발생한다. problem_statement에 IPython repro 세션과 풀 traceback(`__and__` → `_combine` → `raise TypeError(other)`)이 박혀 있다.

## 유형 (정형화)
- **L0 (Pinpointed)** — traceback이 파일(`query_utils.py`)·함수(`Q._combine`)·정확한 라인(`if not isinstance(other, Q): raise TypeError(other)`)까지 떠먹여 준다. hints_text는 한발 더 나가 "이 두 줄은 `Combinable._combine`에는 없다"고 원인 라인을 명시. grep 한 방, 탐색 노력 사실상 0.
- **S1 Direct-Map (+S2)** — 결함 클래스가 정형(과도하게 좁은 타입 가드)이고 픽스가 "가드 완화" 템플릿에 기계적으로 매칭된다는 점에서 dominant는 S1. 다만 "무엇을 허용하도록 완화하느냐"가 자명하지 않다 — `Exists`만 화이트리스트하면 안 되고 모든 conditional 표현식을 받아야 한다는 올바른 일반화를 합성해야 하므로 보조로 S2가 붙는다. 후보를 여러 개 던져 테스트로 거르는 류(S3/S4)가 아니라, 도메인 불변식을 따져 한 줄을 정확히 쓰는 일이다.
- **K-Domain** — 정답이 `getattr(other, 'conditional', False) is True` duck-typing이라는 것은 django 표현식 계층에서 `Exists`/불리언 표현식이 `conditional = True` 플래그를 갖는다는 ORM 내부 지식을 요구한다. 일반 파이썬 추론(K-Gen)만으로는 `isinstance(other, Exists)` 같은 좁은 수정에 머물기 쉽다.
- **primary = T-DirectMap** — 위치가 명확(L0)하고 픽스가 기계적 가드 완화(S1)이므로 T-DirectMap. T-ConstraintReason이 아닌 이유: 추론 부담(S2)이 보조적이고, "올바른 식 합성"보다 "이미 떠먹여진 가드 한 줄을 어떻게 넓힐까"가 본질. T-DomainBound도 아닌 이유: 도메인 지식이 병목이긴 하나 localize·repair 자체는 trivial해서 K-Domain이 dominant difficulty driver는 아님.

## 난이도 티어
**T3 (중간).** 공식 라벨은 "15 min - 1 hour"로 T2~T3 경계인데, 다음 구조적 피처가 T3 쪽으로 민다.
- **단일 파일·1줄 변경** — patch scope는 최소(`query_utils.py` 한 줄). 이것만 보면 T1~T2.
- 그러나 **올바른 일반화의 비자명성** — FAIL_TO_PASS를 통과시키는 좁은 수정(`isinstance(other, Exists)`)과 골드의 정답(`conditional` duck-typing)이 갈린다. overfit 함정이 존재해 T1/T2의 "픽스 자명" 조건을 위반.
- **regression-trap (P2P 147개)** — `_combine`은 모든 `Q` 결합의 chokepoint다. 변경이 빈 `Q()` 단축 경로, `__and__`/`__or__`/`__rand__`/`__ror__`, `CombinableTests`의 reversed_and/reversed_or 등 광범위한 인접 동작을 깨면 안 된다.
- **K-Domain** — `conditional` 플래그 인지가 정답 분기점.

localize 직접성(L0)·repro 존재는 난이도를 강하게 낮추지만, overfit 위험 + 넓은 P2P trap + 도메인 분기가 T2로 떨어지는 걸 막는다. 공식 시간라벨(개발자 구현시간)은 이 overfit/regression 리스크를 잡지 못하므로 우리는 T3로 본다.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/query_utils.py` : `Q._combine`
- **근본 원인**: `Q._combine`이 `other`를 `isinstance(other, Q)`로만 검사한다. `Exists`(→ `Combinable`/`BaseExpression` 계열)는 `Q`의 인스턴스가 아니므로, `Q()`가 좌측이라 `Q.__and__`가 디스패치되면 곧장 `raise TypeError(other)`. 반대 순서(`Exists(...) & Q()`)는 `Exists` 쪽 `Combinable._combine`이 처리되어 통과하므로 비대칭이 생긴다. 사용자는 `__rand__` 누락을 의심했으나, 실제 결함은 `Q` 쪽의 과도하게 좁은 타입 가드다.
- **수정 요지**: 타입 검사를
  `if not isinstance(other, Q):`
  →
  `if not(isinstance(other, Q) or getattr(other, 'conditional', False) is True):`
  로 완화. `Q`뿐 아니라 `conditional` 속성이 `True`인 객체(불리언 표현식, 예: `Exists`)도 허용해 결합을 진행한다. 단 한 줄 변경으로 양방향 대칭을 복원하며, 이후의 빈 `Q()` 단축 로직과 그대로 호환된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개)**:
  - `test_boolean_expression_combined`: 기존 `Exists | Q` 케이스에 더해 `Q(salary__gte=30) & Exists(is_ceo)`, `Q(salary__lt=15) | Exists(is_poc)`처럼 **Q가 좌측인** 조합을 추가 검증.
  - `test_boolean_expression_combined_with_empty_Q`: 빈 `Q()`와 `Exists`의 4가지 조합(`Exists(is_poc) & Q()`, `Q() & Exists(is_poc)`, `Exists(is_poc) | Q()`, `Q() | Exists(is_poc)`)을 `subTest`로 모두 돌려 결과가 `[self.max]`로 동일함을 단언.
- **픽스 증명**: 픽스 전에는 `Q() & Exists(...)`가 `Employee.objects.filter(...)` 평가 시점에 `TypeError`로 죽었다. 픽스 후 4방향 조합 모두 `filter`가 통과해 동일 결과를 반환 → 교환법칙 성립을 직접 관찰.
- **overfit 관점**: FAIL_TO_PASS는 `Exists`만을 입력으로 쓴다. 따라서 `isinstance(other, Exists)`로 화이트리스트하는 좁은 수정도 이 2개 테스트는 통과시킨다 — 테스트가 정답(`conditional` 일반화)을 **과소명세**한다(overfit-risk). 골드는 `Exists` 외 다른 conditional 표현식까지 commutative하게 받지만, 테스트는 그 일반성을 강제하지 못한다.
- **regression 관점**: P2P 147개 중 `CombinableTests.test_reversed_and`/`test_reversed_or`/`test_and`/`test_or`, `ExistsTests.test_optimizations`, 다수 `BasicExpressionsTests`가 `_combine` 인접 경로를 커버한다. `getattr` 기반 완화는 기존 `Q & Q`, 빈 `Q` 단축, 비-conditional 객체에 대한 `TypeError` 유지를 모두 보존하므로 회귀가 없다.

## 모범답안 (오라클 기반)
1. **localize 경로**: problem_statement의 traceback이 `query_utils.py:__and__ → _combine`를, hints_text가 정확히 `if not isinstance(other, Q): raise TypeError(other)` 두 줄을 지목. → `Q._combine` 단일 함수로 즉시 수렴(L0). `__rand__` 추가하라는 사용자 추측에 끌려가지 말 것 — 그 경로를 파면 엉뚱한 곳에서 헤맨다.
2. **픽스와 올바른 일반화**: `Q`만 허용하던 가드를 "`Q` **또는** conditional 표현식"으로 완화. 핵심은 `Exists`를 이름으로 화이트리스트하지 않고 `getattr(other, 'conditional', False) is True` duck-typing을 쓰는 것. 이게 overfit이 아닌 이유: 버그의 본질은 "불리언 표현식과의 결합 비대칭"이고, django에서 불리언/conditional 표현식은 `conditional` 플래그로 식별되는 계약을 갖는다. 플래그 기반 완화는 미래의 다른 conditional 표현식(`Exists` 외)에도 자동으로 올바르게 동작하므로, 테스트가 `Exists`만 다뤄도 일반화가 정당하다.
3. **regression 안전**: 깨면 안 되는 P2P — `CombinableTests.test_reversed_and/test_reversed_or`(반대방향 결합), `test_and/test_or`(정상 `Q` 결합), `ExistsTests.test_optimizations`, 광범위한 `BasicExpressionsTests`. 가드를 **완화만** 하고(기존 허용은 유지, 비-conditional 객체엔 여전히 `TypeError`), 다음 줄의 빈 `Q()` 단축 로직을 건드리지 않으면 안전. `is True` 명시 비교로 truthy 사고(임의 객체가 우연히 통과)를 막는 것도 회귀 방지 포인트.
4. **함정 회피**: (a) `__rand__`/`__ror__`를 추가하는 방향 — 사용자 추측에 끌리는 가장 흔한 오답. 실제 디스패치는 이미 `Q.__and__`가 잡으므로 reverse-op로는 해결 안 됨. (b) `isinstance(other, Exists)`로 좁게 잡기 — FAIL_TO_PASS는 통과하나 골드 의도(모든 conditional)와 어긋나는 overfit. (c) `conditional` 플래그 존재를 모르면 `BaseExpression` 전체를 허용하는 과도한 완화로 가서, 비-conditional 표현식까지 잘못 받아 의미 회귀를 낼 수 있음 — 정확히 `conditional is True`로 좁혀야 함.
