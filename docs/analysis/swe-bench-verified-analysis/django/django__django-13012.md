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
---

# django__django-13012

## 문제 요약
`ExpressionWrapper`로 감싼 상수 표현식(예: `Value(3)`)을 `annotate()` + `values()` + 집계(`Sum`)와 함께 쓰면, Django가 그 상수를 GROUP BY 절에 잘못 포함시킨다. Postgres에서는 `SELECT ... 3 AS expr_res, SUM(...) ... GROUP BY model.column_a, 3` 형태가 되어 `ProgrammingError: aggregate functions are not allowed in GROUP BY` 예외가 난다. `ExpressionWrapper` 없이 같은 `Value(3)`를 직접 annotate하면 정상적으로 GROUP BY에서 제외되므로, 래퍼가 동작을 망가뜨린다는 점이 핵심이다.

## 유형 분류
- 버그 카테고리: logic / 누락처리 (메서드 오버라이드 누락)
- 서브시스템: django ORM query — expression / GROUP BY 컴파일
- 증상 타입: 잘못된 SQL 생성 → 백엔드 예외(크래시) (silent-wrong에 가까운 invalid SQL)
- 로컬라이제이션 신호: "ExpressionWrapper", "GROUP BY clause", 그리고 "래핑 안 하면 정상"이라는 대비는 곧장 `ExpressionWrapper` 클래스와 GROUP BY 컬럼을 산출하는 `get_group_by_cols`로 향한다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/expressions.py` : `ExpressionWrapper.get_group_by_cols`
- 근본 원인: `ExpressionWrapper`는 `BaseExpression.get_group_by_cols`를 상속하는데, 이 기본 구현은 집계를 포함하지 않으면 `[self]`를 반환한다. 반면 `Value.get_group_by_cols`는 `[]`를 반환하도록 오버라이드되어 있어 상수는 GROUP BY에서 빠진다. 래퍼가 기본 구현을 쓰면서 래핑된 표현식의 "GROUP BY에서 빠져야 함" 정보를 삼켜버려, 래퍼 자신(`[self]`)을 그룹화 컬럼으로 내보낸다.
- 수정 요지: `ExpressionWrapper`에 `get_group_by_cols(self, alias=None)`를 추가하고, 결정을 래핑된 표현식에 위임한다 — `return self.expression.get_group_by_cols(alias=alias)`. 이렇게 하면 상수 래핑 시 `Value`의 `[]`가 전달되고, 비상수 래핑 시에는 내부 표현식의 그룹화 컬럼이 그대로 전파된다.

## 검증 (test_patch)
- FAIL_TO_PASS: `tests/expressions/tests.py`의 신규 `ExpressionWrapperTests`(SimpleTestCase) — `test_empty_group_by`, `test_non_empty_group_by`.
- 테스트가 증명하는 방식:
  - `test_empty_group_by`: `ExpressionWrapper(Value(3), output_field=IntegerField())`의 `get_group_by_cols(alias=None)`이 `[]`임을 단언 → 상수가 GROUP BY에서 빠지는지 직접 확인(버그 시 `[expr]` 반환).
  - `test_non_empty_group_by`: `ExpressionWrapper(Lower(Value('f')), ...)`의 결과가 `[expr.expression]`임을 단언 → 비상수일 때 위임이 내부 표현식으로 정확히 전달되는지 확인. DB 없이 메서드 반환값만 검사하는 단위 테스트라 빠르고 결정적이다.

## 공략 포인트 (뭘 조져야)
- localization 전략: `expressions.py`에서 `class ExpressionWrapper`를 찾고, `get_group_by_cols`를 grep. 래퍼에 없음을 확인 → `BaseExpression.get_group_by_cols`(기본 `[self]`)와 `Value.get_group_by_cols`(`[]`)의 차이를 비교하면 누락된 오버라이드가 드러난다.
- 함정/난이도 메모: 단일 파일·3줄 패치지만 "왜 래핑하면 달라지나"를 이해하려면 GROUP BY 컬럼 결정 로직(집계 포함 여부 → `[self]` vs `[]`)을 알아야 한다. `as_sql`/`get_source_expressions`는 이미 위임하고 있어, 같은 위임 패턴을 `get_group_by_cols`로 확장한다는 점이 힌트. 멀티파일 아님.
- 우리 에이전트 관점: 증상(잘못된 SQL/Postgres 예외)에서 출발해 SQL 컴파일러 쪽(`sql/compiler.py`의 GROUP BY 수집)으로 빠지면 헤맬 수 있다. 진짜 수정 지점은 컴파일러가 호출하는 표현식 측 `get_group_by_cols`이며, "래핑 vs 비래핑 대비"라는 단서를 잡으면 래퍼 위임 누락으로 빠르게 수렴한다.
