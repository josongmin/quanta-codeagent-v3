---
instance_id: django__django-15382
repo: django/django
base_commit: 770d3e6a4ce8e0a91a9e27156036c1985e74d4a3
version: 4.1
difficulty: 15 min - 1 hour
created_at: 2022-02-01T18:29:41Z
fail_to_pass: 1
pass_to_pass: 161
gold_files: [django/db/models/expressions.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L0
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [regression-trap, has-repro, overfit-risk]
---

# django__django-15382

## 문제 요약
`~Exists(EmptyQuerySet)`를 다른 조건과 AND로 묶어 `filter()`하면 WHERE 블록 전체가 사라진다. `MyModel.objects.filter(~models.Exists(MyModel.objects.none()), name='test')`가 빈 결과를 반환하고 `print(qs.query)`는 `EmptyResultSet`을 띄운다. 의미상 부정된 EXISTS(서브쿼리가 비어 EXISTS가 항상 거짓 → `NOT EXISTS`는 항상 참)는 WHERE에서 무시 가능해야 하므로 `name='test'` 조건만 남아 정상 필터링되어야 한다. 그러나 빈 서브쿼리 컴파일이 던진 `EmptyResultSet`이 `Exists.as_sql`을 통해 위로 전파되며 쿼리 전체를 비워버린다. 이슈 본문에 실행 가능한 재현 스니펫과 참조 티켓 #33018이 포함돼 있다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: problem_statement이 `models.Exists(...)` + `EmptyResultSet`을 직접 언급하고, hints가 "issue with Exists.as_sql when self.invert is True"로 함수까지 못박는다. `EmptyResultSet` 한 번의 grep으로 `expressions.py`의 `Exists.as_sql`이 잡힌다. 탐색 비용 거의 0.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S1 Direct-Map)**: 고칠 지점은 자명(S1처럼 try/except 가드 추가)하지만, **올바른 조건의 합성**이 본질이라 dominant는 S2다. "예외를 잡는다"만으로는 부족하고 (a) `self.negated`일 때만 삼켜야 하고(비부정 EXISTS는 EmptyResultSet이 전파돼 단락되는 게 옳다), (b) 부정일 때 반환값이 "항상 참" 술어로 동작해야 한다는 두 불변식을 추론으로 증명해야 한다. SemFix/Angelix식 조건 합성에 해당. 기계적 None-가드(S1)와 달리 결함클래스 템플릿 매칭만으론 `negated` 비대칭을 놓치므로 보조로만 표기.
- **K (Knowledge) = K-Domain**: `EmptyResultSet`이 ORM SQL 컴파일러의 "빈 결과 단락 신호"라는 의미, `Exists`가 `__invert__`로 부정을 내부 캡슐화한다는 점, `as_sql`이 `('', ())` 빈 SQL을 반환하면 WHERE 결합에서 무시된다는 컴파일러 계약 — 모두 django query-compiler 내부지식. 일반 파이썬 추론(K-Gen)으로는 "왜 빈 문자열이 항상-참이 되는가"를 도출할 수 없다.
- **Primary = T-ConstraintReason**: 위치는 명확(L0)하나 진짜 난점이 "부정일 때만 / 빈 SQL로 / 항상-참" 세 조건을 추론으로 합성하는 데 있어 T-ConstraintReason이 dominant. T-DirectMap이 아닌 이유는 `negated` 가드 누락 시 즉시 회귀가 나기 때문(기계적 가드로 환원 불가).

## 난이도 티어
**T4 (약간 어려움)**. 공식 difficulty 라벨은 "15 min - 1 hour"(T2~T3 prior)인데 T4로 상향한다. 근거:
- **범위는 T1~T2 신호**: 1파일·1함수·실효 +6줄(try/except 래핑), has-repro까지 갖춰 구조적 scope는 작다.
- **그러나 두 축이 위로 민다**: (1) **K-Domain** — `EmptyResultSet` 단락 시맨틱과 `negated` 캡슐화를 모르면 픽스가 도출 안 됨. (2) **regression-trap (P2P=161)** — `BasicExpressionsTests`의 EXISTS/Subquery 계열(test_exists_in_filter, test_order_by_exists, test_in_subquery, test_subquery_* 등 다수)이 인접 동작을 광범위하게 커버한다. `negated` 가드를 빠뜨리고 무조건 빈 문자열을 반환하면 비부정 EXISTS가 잘못 통과되며 이 P2P 다수가 깨진다.
- **overfit-risk**: FAIL_TO_PASS가 단 1개(부정 EXISTS만)라, 이 테스트만 보고 "EmptyResultSet 잡아 무조건 빈 문자열 반환" 같은 special-case 픽스로도 그 1개는 통과한다. 비부정 경로 보호는 P2P가 책임지므로 P2P를 안 보면 회귀 함정에 빠진다.
- 공식 라벨이 낮은 이유: "개발자 구현시간"은 도메인지식을 이미 가진 코어 개발자 기준이라 hints까지 있으면 30분이지만, **에이전트 난이도**(도메인 추론 + regression trap)는 시간라벨에 안 잡힌다 — 그래서 T4.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/expressions.py` : `Exists.as_sql`
- **근본 원인**: 빈 서브쿼리(`.none()`)는 컴파일 시 `EmptyResultSet`을 던진다. `Exists.as_sql`이 `super().as_sql(...)`(`Subquery` 컴파일) 호출에서 이 예외를 그대로 전파시킨다. EXISTS가 부정(`~`, 즉 `self.negated == True`)이면 의미상 "항상 참"이라 WHERE에서 무시 가능해야 하는데, 예외가 위로 올라가 `WhereNode`/쿼리 컴파일이 쿼리셋 전체를 `EmptyResultSet`으로 처리해 WHERE 블록이 통째로 사라진다.
- **수정 요지**: `super().as_sql(...)` 호출을 `try/except EmptyResultSet`로 감싼다. 예외를 잡고 `self.negated`이면 `return '', ()` (빈 SQL)로 떨어뜨려 해당 조건을 사실상 무시(항상 참)하게 한다. 부정이 아니면 `raise`로 기존 단락 동작을 정확히 보존한다. hints는 `'%s = %s', (1, 1)`(즉 `1 = 1` 항상-참 술어)을 제안했지만 골드는 더 간결한 `('', ())` 빈 반환을 택했다 — 빈 SQL이 부울 결합에서 자연히 무시되므로 동등하면서 가볍다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_negated_empty_exists (expressions.tests.ExistsTests)`
- **동작**: `Manager` 한 건 생성 후 `Manager.objects.filter(~Exists(Manager.objects.none()) & Q(pk=manager.pk))`로 필터링. 부정된 빈 EXISTS는 무시되어야 하므로 `pk=manager.pk` 조건만 살아남아 그 객체가 결과에 포함, `assertSequenceEqual(qs, [manager])`를 만족해야 한다.
- **픽스 증명**: 픽스 전이면 `EmptyResultSet`이 전파돼 `qs`가 빈 시퀀스가 되고 `[manager]`와 불일치해 실패. 픽스 후에는 부정 EXISTS가 `('', ())`로 떨어져 WHERE에 `pk=manager.pk`만 남아 manager가 반환되며 통과한다.
- **overfit 관점**: FAIL_TO_PASS가 부정+빈+AND 단일 케이스뿐이라 테스트가 픽스를 과소명세한다. "EmptyResultSet을 무조건 삼켜 빈 문자열 반환"하는 overfit 패치도 이 1개는 통과한다 — 즉 이 테스트만으론 `negated` 가드의 필요성을 강제하지 못한다.
- **regression 관점**: 비부정 경로의 정합성은 P2P(161개)가 방어한다. `test_exists_in_filter`, `test_exist_single_field_output_field`, `test_in_subquery`, `test_order_by_exists`, `test_subquery_in_filter` 등 EXISTS/Subquery 계열이 비부정 EXISTS의 SQL 생성·단락 동작을 커버하므로, `if self.negated:` 가드를 빠뜨려 비부정에서도 빈 문자열을 반환하면 이들이 깨진다. 골드의 `raise` 보존 분기가 이를 통과시키는 핵심이다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 `print(qs.query)` → `EmptyResultSet`과 `~models.Exists(...none())` 신호를 잡는다. `EmptyResultSet`을 `django/db/models/expressions.py`에서 grep → `Exists` 클래스의 `as_sql`(super=`Subquery.as_sql`)과 `__invert__`(`self.negated` 토글)이 바로 떠오른다. hints 없이도 L0로 수렴.
2. **픽스와 올바른 일반화**: `super().as_sql(...)`을 `try/except EmptyResultSet`로 감싸고, `self.negated`일 때만 `return '', ()`. 이게 overfit이 아닌 이유 — `NOT EXISTS(empty)`는 **모든 행에 대해 항상 참**이라는 부울 논리의 일반 진리에 기반하므로 빈 술어(=무시)가 의미상 정확하다. 특정 테스트값에 맞춘 게 아니라 `negated` 불변식에서 도출된 일반화다. 반면 비부정 `EXISTS(empty)`는 항상 거짓이라 쿼리 전체 단락(`EmptyResultSet` 전파)이 옳으므로 `raise`로 보존 — 두 진리값이 비대칭이라 `negated` 분기가 필수다.
3. **regression 안전**: `raise` 분기 덕에 비부정 EXISTS/Subquery 경로의 SQL과 단락 동작이 바이트 동일하게 유지된다. P2P의 `BasicExpressionsTests` EXISTS/Subquery 군(test_exists_in_filter / test_in_subquery / test_order_by_exists / test_subquery_* 등)이 그 보존을 증명한다 — 이들을 안 깨는 게 정답의 조건.
4. **함정 회피**: 오라클 없는 에이전트의 전형적 오답은 (a) `self.negated` 가드를 빠뜨려 비부정 EXISTS까지 빈 문자열로 만들기 → P2P 다수 회귀, (b) FAIL_TO_PASS 1개에만 맞춰 try/except 없이 `__invert__`나 호출부에서 특수 처리 → 일반화 실패, (c) `raise` 누락으로 비부정 빈 EXISTS의 정당한 단락을 죽이기. 회피법: 부정/비부정 두 진리값을 먼저 따지고(constraint reasoning), FAIL_TO_PASS가 아닌 **P2P EXISTS 군을 픽스 정합성의 검증 기준**으로 삼는다.
