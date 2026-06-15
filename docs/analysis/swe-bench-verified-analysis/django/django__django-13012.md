---
instance_id: django__django-13012
repo: django/django
base_commit: 22a59c01c00cf9fbefaee0e8e67fab82bbaf1fd2
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-06-02T21:19:37Z
fail_to_pass: 2
pass_to_pass: 137
gold_files: [django/db/models/expressions.py]
primary_type: T-DomainBound
tier: T3
loc_axis: L1
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-13012

## 문제 요약
`ExpressionWrapper`로 감싼 상수 표현식(예: `Value(3)`)을 `annotate()` + `values()` + 집계(`Sum`)와 함께 쓰면, Django가 그 상수를 GROUP BY 절에 잘못 포함시킨다. Postgres에서는 `SELECT "model"."column_a", 3 AS "expr_res", SUM("model"."column_b") AS "sum" ... GROUP BY "model"."column_a", 3` 형태가 되어 `django.db.utils.ProgrammingError: aggregate functions are not allowed in GROUP BY` 예외가 난다. 결정적 단서: `ExpressionWrapper` 없이 같은 `Value(3)`를 직접 annotate하면 상수가 GROUP BY에서 정상적으로 빠진다 — 즉 래퍼가 정상 동작을 망가뜨린다는 대조가 이슈 본문에 명시되어 있다.

## 유형 (정형화)
- **L (Localization) = L1 (Traceable).** 이슈가 `ExpressionWrapper` 클래스를 명시하지만, 정확한 수정 심볼(`get_group_by_cols`)을 직접 지목하진 않는다. "GROUP BY clause" + "래핑 안 하면 정상"이라는 대조 신호로 `django/db/models/expressions.py`의 단일 클래스로 빠르게 수렴하지만, 그 클래스 안에서 어느 메서드가 누락됐는지는 GROUP BY 컬럼 산출 경로를 한 번 더 추적해야 한다. L0(grep 한 방)은 아니다.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S5 Spec-Inference).** 고칠 클래스는 좁혀지지만, "어떤 메서드를 추가하고 무엇을 반환해야 하나"를 후보 난사가 아니라 추론으로 합성해야 한다. `BaseExpression.get_group_by_cols`가 집계 미포함 시 `[self]`를 반환하고 `Value.get_group_by_cols`는 `[]`로 오버라이드돼 있다는 불변식을 비교해, 래퍼는 "그룹화 컬럼 결정을 래핑된 표현식에 위임해야 한다"는 올바른 조건을 도출하는 게 핵심이다(S2). 동시에 "래퍼가 어떻게 행동해야 옳은가"는 코드만으론 안 떨어지고, 다른 위임 메서드(`get_source_expressions`/`as_sql`)가 이미 따르는 위임 계약에서 의도된 스펙을 재구성해야 한다(S5 보조).
- **K (Knowledge) = K-Domain.** django ORM의 query-compiler / expression GROUP BY 해석(집계 포함 여부 → `[self]` vs `[]` 규칙)을 알아야 근본 원인이 보인다. 일반 파이썬 추론(K-Gen)만으로는 "왜 상수가 GROUP BY에 들어가나"를 설명할 수 없는, 프레임워크 내부 지식 의존 문제다.
- **Primary type = T-DomainBound.** 패치는 3줄·단일파일로 사소해 보이지만, 진짜 병목은 위치 찾기(L1, 그리 어렵지 않음)도 픽스 타이핑도 아니라 **GROUP BY 컬럼 해석이라는 ORM 내부 계약 지식**이다. K-Domain이 dominant하므로 T-DomainBound. (위임 식 합성이라는 S2 색채가 있어 T-ConstraintReason과 경쟁하지만, 식 자체는 자명한 1줄 위임이고 난점은 "왜 위임이 옳은가"를 아는 도메인 지식 쪽이라 T-DomainBound가 우세하다.)

## 난이도 티어
**Tier = T3 (중간).** 공식 difficulty 라벨은 `15 min - 1 hour`(T2~T3 경계의 prior).

이 티어로 미는 구조적 피처:
- **수정 범위는 T1~T2급**: 1파일·3줄·단일 메서드 추가. patch scope만 보면 "존나쉬움" 구간(1파일 <5줄 ≈ 48% solve).
- **그러나 localize 직접성이 L1**: 이슈가 클래스는 주지만 메서드는 안 줘서, `BaseExpression` 기본 구현 vs `Value` 오버라이드의 차이를 비교해야 누락 지점이 드러난다 — 단순 grep 한 방(L0)이 아님.
- **K-Domain 진입장벽**: GROUP BY 컬럼이 집계 포함 여부에 따라 `[self]`/`[]`로 갈리고, 래퍼가 그 결정을 삼킨다는 인과는 ORM 내부 지식 없이는 안 보인다. 이 지식 비용이 패치 줄 수가 주는 "쉬움" 인상을 상쇄한다.
- **regression-trap이 약하지 않음**: P2P 137개가 대부분 expression/aggregate/subquery 동작이라, 위임을 잘못 구현하면(예: 무조건 `[]` 반환) 비상수 래핑의 GROUP BY 동작을 깰 수 있다.

공식 라벨(15분-1시간)이 T2가 아닌 T3로 올라가는 이유: 시간 라벨은 "픽스를 아는 개발자의 구현 시간"이라 3줄 타이핑이 빠른 것이지, 오라클 없는 에이전트가 GROUP BY 해석 규칙을 이해하고 올바른 위임을 합성하는 비용(K-Domain + S2)은 시간 라벨에 안 잡힌다. has-repro가 있어 T4까지 올리진 않는다.

## 골드패치 분석
- **건드린 파일·함수**: `django/db/models/expressions.py` — `ExpressionWrapper`에 `get_group_by_cols(self, alias=None)` 메서드 신규 추가(`get_source_expressions`와 `as_sql` 사이에 삽입).
- **근본 원인**: `ExpressionWrapper`는 `BaseExpression.get_group_by_cols`를 상속하는데, 이 기본 구현은 expression이 집계를 포함하지 않으면 `[self]`(자기 자신)를 그룹화 컬럼으로 반환한다. 반면 `Value.get_group_by_cols`는 `[]`를 반환하도록 오버라이드되어 있어 상수는 GROUP BY에서 빠진다. 래퍼가 기본 구현을 쓰면서, 래핑된 `Value`의 "나는 GROUP BY에서 빠져야 한다"는 정보를 삼키고 래퍼 자신(`[self]`)을 그룹화 컬럼으로 내보낸다 → 상수 `3`이 GROUP BY에 끼어든다.
- **수정 요지**: 그룹화 컬럼 결정을 래핑된 표현식에 위임 — `return self.expression.get_group_by_cols(alias=alias)`. 이미 `get_source_expressions`/`as_sql`이 따르는 "래퍼는 내부 표현식에 위임한다"는 패턴을 `get_group_by_cols`로 확장한 것. 상수 래핑 시 `Value`의 `[]`가 전파되고, 비상수 래핑 시 내부 표현식의 그룹화 컬럼이 그대로 전달된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2)**: `tests/expressions/tests.py`에 신규 `ExpressionWrapperTests(SimpleTestCase)` — `test_empty_group_by`, `test_non_empty_group_by`.
- **픽스 증명**:
  - `test_empty_group_by`: `ExpressionWrapper(Value(3), output_field=IntegerField())`의 `get_group_by_cols(alias=None)`이 `[]`임을 단언. 버그 상태에서는 `[self]`(래퍼)를 반환하므로 RED, 위임 후 `Value`의 `[]`가 전파되어 GREEN. 상수가 GROUP BY에서 빠지는지 직접 확인.
  - `test_non_empty_group_by`: `ExpressionWrapper(Lower(Value('f')), output_field=IntegerField())`의 결과가 `[expr.expression]`임을 단언. 비상수일 때 위임이 내부 표현식으로 정확히 전달되는지 확인 — "무조건 `[]`" 같은 과교정을 적발하는 paired-control 역할.
- **overfit 관점**: 두 테스트가 상수(`[]`)와 비상수(`[expr.expression]`) 양 갈래를 모두 고정하므로, "항상 `[]`를 반환"하는 special-case 패치는 `test_non_empty_group_by`에서 잡힌다. FAIL_TO_PASS가 2개뿐이라 얇긴 하지만 두 케이스가 동작 양극단을 짚어 overfit-risk는 낮다(그래서 플래그에서 제외).
- **regression 관점**: DB 없이 메서드 반환값만 검사하는 단위 테스트라 빠르고 결정적. P2P 137개가 expression/aggregate/subquery 전반을 커버하므로, 위임을 잘못 구현하면 여기서 회귀가 드러난다(regression-trap 플래그).

## 모범답안 (오라클 기반)
1. **Localize 경로**: 이슈의 "ExpressionWrapper" + "incorrectly placed at the GROUP BY clause" + "래핑 안 하면 정상" 대조 → `django/db/models/expressions.py`의 `class ExpressionWrapper`로 직행. 그 안에서 `get_group_by_cols`를 grep해 **래퍼에 정의가 없음**을 확인. 이어서 `BaseExpression.get_group_by_cols`(집계 미포함 시 `[self]`)와 `Value.get_group_by_cols`(`[]`)를 비교하면, 래퍼가 상속한 기본 구현이 `Value`의 `[]`를 못 받고 `[self]`를 내보낸다는 누락이 드러난다.
2. **픽스와 왜 올바른 일반화인가**: `ExpressionWrapper`에 `get_group_by_cols(self, alias=None)`를 추가하고 `self.expression.get_group_by_cols(alias=alias)`로 위임. 이게 올바른 일반화인 이유 — (a) 같은 클래스의 `get_source_expressions`/`as_sql`이 이미 내부 표현식에 위임하는 확립된 계약을 따른다, (b) 상수든 비상수든 "GROUP BY에 들어갈지"는 본질적으로 **래핑된 표현식의 속성**이지 래퍼의 속성이 아니다. 따라서 위임이 상수(`Value`→`[]`)와 비상수(`Lower`→내부 컬럼) 모두에 자연스럽게 옳다.
3. **Regression 안전**: P2P 137개(특히 `BasicExpressionsTests`의 subquery/aggregate/annotate-values 다수, `FTimeDeltaTests` 등)가 깨지면 안 된다. 위임은 비상수 표현식에 대해 기존 `get_group_by_cols` 결과를 그대로 통과시키므로, 일반 expression 래핑의 GROUP BY 동작은 불변이다. `test_non_empty_group_by`가 이 불변을 잠근다 — `[]`만 반환하는 과교정은 즉시 RED.
4. **함정 회피**: 오라클 없는 에이전트가 빠지기 쉬운 곳 — (a) 증상(잘못된 SQL/Postgres 예외)에서 출발해 `sql/compiler.py`의 GROUP BY **수집 로직**으로 가서 헤맴. 실제 수정 지점은 컴파일러가 호출하는 표현식 측 `get_group_by_cols`다. (b) 래퍼에 `get_group_by_cols`를 추가하면서 무조건 `[]`를 반환해 상수 케이스만 맞추는 overfit — 비상수 래핑의 그룹화를 깨고 `test_non_empty_group_by`에서 잡힌다. 회피법: "래핑 vs 비래핑 대비"라는 이슈 단서를 잡고, 위임이 양 갈래를 동시에 푼다는 점을 확인한 뒤 `as_sql`/`get_source_expressions`의 기존 위임 패턴을 그대로 모방한다.
