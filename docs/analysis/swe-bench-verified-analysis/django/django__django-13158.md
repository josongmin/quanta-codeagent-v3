---
instance_id: django__django-13158
repo: django/django
base_commit: 7af8f4127397279d19ef7c7899e93018274e2f9b
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-07-06T19:18:11Z
fail_to_pass: 1
pass_to_pass: 29
gold_files: [django/db/models/sql/query.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep]
---

# django__django-13158

## 문제 요약
`union()`(또는 intersection/difference) 같은 결합 쿼리셋에 `.none()`을 호출하면 빈 결과가 아니라 모든 결과가 반환된다. 증상은 `ModelMultipleChoiceField`에 union 쿼리셋을 넣고 빈 폼을 제출했을 때 드러나는데, 아무것도 선택하지 않았는데도 쿼리셋에 매칭되는 모든 객체가 저장된다(silent-wrong, 예외 없음). 동일 시나리오에서 OR(`|`) 쿼리셋은 정상적으로 0개를 반환하므로, 사용자는 `.none()`이 결합 쿼리셋에서도 똑같이 빈 결과를 내길 기대한다. hint는 "QuerySet.none() doesn't work properly on combined querysets, it returns all results instead of an empty queryset"으로 결함을 거의 확정해준다.

## 유형 (정형화)

3축 점수:

- **L1 (Traceable)** — 이슈 본문/hint가 심볼을 직접 지목하진 않지만 `QuerySet.none()`이라는 공개 API와 "combined querysets"라는 키워드를 준다. `none()` → `query.set_empty()` 호출 경로를 따라가면 `django/db/models/sql/query.py` 단일 파일의 좁은 후보로 수렴한다. grep 한 방(L0)은 아니고, `none`이 어떤 내부 메서드로 내려가는지 한 단계 추적이 필요해 L1.
- **S2 (Constraint-Reasoning) +S6 (Design-Refactor)** — 고칠 지점(`set_empty`)은 추적으로 알 수 있지만, "결합 쿼리셋이 empty여야 한다는 불변식이 `combined_queries` 본체에 전파되어야 한다"는 의미적 추론이 픽스의 본질이다. 단순 None가드/상수변경(S1) 류 템플릿이 아니라, ORM의 UNION 컴파일 구조(바깥 where가 아니라 `combined_queries`가 실제 SQL을 만든다)를 이해해 올바른 전파 식을 합성해야 한다. 보조로 S6: `clone()`에서 `combined_queries`를 깊은 복사하도록 lifecycle(객체 소유권/격리)을 손봐야 하므로 단순 한 줄이 아닌 작은 구조 변경이 동반된다.
- **K-Domain** — 일반 파이썬 추론으로는 풀 수 없다. `set_empty`가 `where.add(NothingNode(), AND)`로 동작하는 것, union/intersection/difference가 `combined_queries` 튜플에 하위 Query를 보관하고 compiler가 이를 SET 연산으로 합치는 것, `clone`이 어떤 필드를 얕게/깊게 복사하는지 — 이 모든 게 django ORM query-compiler 내부지식이다. 이 도메인지식이 병목이라 primary는 **T-DomainBound**.

**primary type 근거**: 위치는 L1로 비교적 가깝고 strategy는 S2지만, 픽스를 도출하는 진짜 병목은 "왜 바깥 where의 NothingNode가 결합 쿼리에 안 먹히는가"라는 ORM 컴파일 내부지식(K-Domain)이다. 그래서 T-ConstraintReason보다 **T-DomainBound**가 dominant. APR 관점에서 이 픽스는 SemFix/Angelix식 semantic repair(올바른 조건/불변식을 추론으로 합성)에 해당하지만, 그 추론을 가능케 하는 전제가 프레임워크 내부 모델이라 knowledge-bound로 라벨링한다.

## 난이도 티어

**T4 (약간 어려움)**.

이 티어로 미는 구조적 피처:
- **K-Domain 의존**: T4 프로파일의 "constraint추론·소규모 refactor·도메인지식 중 하나"에 정확히 해당. ORM UNION 컴파일 모델을 모르면 `set_empty` 한 줄로 끝냈다 선언하기 쉽다.
- **cross-file-dep / 숨은 절반**: 픽스가 `set_empty`와 `clone` 두 메서드에 걸쳐 **함께** 바뀌어야 한다. `clone` 수정은 problem_statement·hint 어디에도 안 적혀 있어, 이슈만 보고는 절반만 고치게 된다(L1.5 성격 — 단일 파일이지만 멀티-헌크 조율).
- **regression-trap (P2P 29개)**: PASS_TO_PASS가 `test_qs_combinators`의 union/intersection/difference 전 영역 29 케이스다. `clone`에서 `combined_queries`를 깊은 복사로 바꾸는 변경은 결합 쿼리 클론 의미를 건드리므로, count/ordering/values/with_empty_qs 등 인접 동작을 안 깨야 한다.

T5까지는 안 가는 이유: 패치가 2헌크 +3줄, 단일 파일이고 localize가 L1로 어렵지 않다. overfit 고위험(S4)도 아니다. T3보다 높은 이유는 도메인지식 병목 + 숨은 clone 절반 + 넓은 P2P trap.

**공식 라벨("15 min - 1 hour")과의 관계**: 대체로 정합한다. 공식 라벨은 "도메인을 아는 django 코어 개발자의 구현시간"이라 짧지만, 오라클 없는 에이전트 입장에서는 (a) `combined_queries` 컴파일 모델을 모르면 localize 후에도 픽스 식을 못 합성하고 (b) `clone` 절반이 이슈에 안 적혀 있어 회귀로 떨어진다. 즉 시간라벨엔 안 잡히는 도메인지식·숨은의존 비용 때문에 에이전트 기준 T4가 타당하다.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/sql/query.py` — `Query.set_empty`, `Query.clone`
- **근본 원인**: `none()` → `set_empty()`는 바깥 쿼리의 `self.where`에만 `NothingNode`를 `AND`로 추가했다. 하지만 `union()`이 만든 결합 쿼리는 실제 SQL을 `self.combined_queries`(하위 Query 튜플)에 보관하고, compiler가 이들을 UNION/INTERSECT/EXCEPT로 합쳐 컴파일한다. 바깥 where에 추가된 `NothingNode`는 결합 쿼리 본체 SQL에 적용되지 않으므로, 각 subquery는 원래 조건 그대로 실행되고 합집합 전체가 반환된다.
- **수정 요지**:
  1. `set_empty()`에 `for query in self.combined_queries: query.set_empty()`를 추가 — 바깥 where에 `NothingNode`를 넣은 뒤 모든 결합 하위 쿼리에도 empty를 재귀 전파. 이로써 각 subquery가 `WHERE NothingNode`(0행)가 되어 UNION 결과가 빈다.
  2. `clone()`에 `obj.combined_queries = tuple(query.clone() for query in self.combined_queries)`를 추가 — 클론된 쿼리가 원본과 `combined_queries` 객체를 **공유하지 않도록** 각 하위 Query를 깊은 복사. 이게 없으면 `none()`이 만든 클론에서 `set_empty()`를 호출할 때 원본의 결합 쿼리까지 변형되는 부작용(원본 qs 오염)이 생긴다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_union_none (queries.test_qs_combinators.QuerySetSetOperationTests)`.
  ```python
  qs3 = qs1.union(qs2)
  self.assertSequenceEqual(qs3.none(), [])                 # (a) set_empty 전파
  self.assertNumbersEqual(qs3, [0, 1, 8, 9], ordered=False) # (b) clone 격리
  ```
- **픽스 증명**: (a) `qs3.none()`이 실제로 0개를 반환함을 확인 → `set_empty`의 `combined_queries` 전파가 동작함을 증명. (b) 직후 원본 `qs3`가 여전히 `[0,1,8,9]`를 반환함을 확인 → `.none()`(=clone 후 set_empty)이 원본을 오염시키지 않았음, 즉 `clone`의 깊은 복사 격리가 동작함을 증명. **한 테스트가 두 수정(전파 + 격리)을 모두 강제**한다.
- **overfit 관점**: FAIL_TO_PASS가 1개뿐이라 얇아 보이지만, 두 assert가 서로 다른 메커니즘을 검사하므로 `set_empty` one-liner만으로는 (b)를 통과 못 한다 → special-case 통과가 막혀 있어 overfit 위험은 낮다(그래서 overfit-risk 플래그 미부여). union만 테스트하고 intersection/difference는 직접 검증 안 하지만, 픽스가 `combined_queries` 일반에 적용되므로 일반화는 자연스럽다.
- **regression 관점**: P2P 29개(union/intersection/difference의 count·ordering·values·with_empty_qs 등)가 `clone`의 `combined_queries` 깊은 복사 변경을 안전망으로 친다. 깊은 복사가 결합 쿼리 클론 의미를 깨면 이 중 다수가 즉시 빨개진다 → regression-trap이 실재.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈의 "QuerySet.none() on combined queries returns all results" + hint "combined querysets"가 두 신호다. `none()` 공개 API → 구현 추적: `QuerySet.none`이 내부 `query.set_empty()`를 부른다는 걸 확인하고 `django/db/models/sql/query.py`로 진입. 거기서 `set_empty`(바깥 where에 `NothingNode`만 추가), `is_empty`, 그리고 결정적으로 `combined_queries` 필드의 존재를 잡으면 "바깥 where ≠ 결합 쿼리 본체"라는 괴리에 도달한다.

2. **픽스와 왜 올바른 일반화인가**: `set_empty`에서 자기 where를 비운 뒤 `self.combined_queries` 각각에 `set_empty()`를 재귀 호출. 이것이 special-case 하드코딩이 아니라 올바른 일반화인 이유 — empty 불변식이 "이 쿼리가 0행을 내야 한다"는 의미이고, 결합 쿼리의 실제 행은 `combined_queries`가 만들므로 불변식을 그 본체까지 전파하는 게 의미적으로 정확하다. union뿐 아니라 intersection/difference(같은 `combined_queries` 메커니즘)에도 자동 적용되므로 테스트가 union만 봐도 일반적이다.

3. **regression 안전**: 함께 들어가는 `clone`의 깊은 복사가 핵심 안전장치다. `none()`은 항상 쿼리를 clone한 뒤 set_empty하는데, clone이 `combined_queries`를 얕게 공유하면 set_empty가 원본까지 mutate한다. P2P의 union/intersection/difference 클론·count·ordering 케이스 29개가 이 격리를 검증하므로, clone 변경이 결합 쿼리 클론 의미를 보존해야 한다(튜플 재생성 + 각 하위 query.clone()로 보존됨).

4. **함정 회피**: 오라클 없는 에이전트의 전형 실패 — `set_empty`에 한 줄만 추가하고 "FAIL_TO_PASS 통과"를 선언하는 것. 첫 assert `(a)`는 통과하지만, `combined_queries`가 공유 참조라 `.none()`이 원본 `qs3`를 변형시켜 두 번째 assert `(b)`에서 깨진다. `clone` 수정은 problem_statement·hint에 직접 안 적혀 있어 놓치기 쉬운 **숨은 절반**이다. 회피법: 픽스 후 "내가 결합 쿼리 하위 객체를 in-place로 변형하는가? 그 객체가 원본과 공유되는가?"를 점검 — mutation이 clone을 거치는지 데이터플로우를 따라가면 격리 누락이 드러난다.
