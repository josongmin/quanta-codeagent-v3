---
instance_id: django__django-16263
repo: django/django
base_commit: 321ecb40f4da842926e1bc07e11df4aabe53ca4b
version: 4.2
difficulty: 1-4 hours
created_at: 2022-11-06T07:38:18Z
fail_to_pass: 3
pass_to_pass: 100
gold_files: [django/db/models/expressions.py, django/db/models/query_utils.py, django/db/models/sql/query.py, django/db/models/sql/where.py]
---

# django__django-16263

## 문제 요약
`Book.objects.annotate(Count('chapters')).count()`처럼 어노테이션을 단 뒤 `count()`를 호출하면, 어디서도 참조되지 않는 어노테이션이 SQL에 그대로 포함된다. 그 결과 불필요한 서브쿼리/GROUP BY가 생성되어 `Book.objects.count()`와 동일한 결과를 매우 느리게 계산한다. 사용자는 필터·다른 어노테이션·정렬에서 참조되지 않는 어노테이션이 count 쿼리에서 자동으로 제거되어 단순 `COUNT(*)`로 떨어지길 기대했다.

## 유형 분류
- 버그 카테고리: logic / 성능 최적화 누락 (불필요한 어노테이션 미가지치기)
- 서브시스템: django ORM query 컴파일 — 집계(aggregation) 경로
- 증상 타입: 성능 저하 (불필요한 서브쿼리 + GROUP BY로 잘못된 SQL 생성, 결과는 맞지만 비효율)
- 로컬라이제이션 신호: problem_statement가 `queryset.count()`와 `django/db/models/sql/query.py`의 특정 라인(get_aggregation 주변 주석)을 직접 지목. "annotations that are not referenced by filters/other annotations/ordering" 문구가 `get_aggregation`의 어노테이션 마스킹 로직으로 이어진다.

## 골드패치 분석
- 건드린 파일/함수:
  - `sql/query.py:Query.get_aggregation` — 핵심. `solve_lookup_type`, `build_filter`, `_add_q`에 `summarize` 인자 전파
  - `expressions.py:BaseExpression.get_refs` / `Ref.get_refs` (신규)
  - `sql/where.py:WhereNode.get_refs` (신규)
  - `query_utils.py:Q.resolve_expression` (summarize 전달), `refs_expression` (반환 시그니처 변경)
- 근본 원인: `get_aggregation`은 기존 어노테이션이 하나라도 있으면 그것이 집계가 아니어도 무조건 서브쿼리 + GROUP BY를 강제했다. "어떤 어노테이션이 실제로 집계에 참조되는지" 판별하는 수단(`get_refs`)이 없어 전부 보수적으로 끌고 갔다.
- 수정 요지:
  1. 모든 표현식이 자신이 참조하는 `Ref` 집합을 반환하는 `get_refs()`를 갖도록 추가(`Ref`는 자기 이름, 컨테이너는 자식 합집합).
  2. `get_aggregation`에서 `has_existing_aggregation`을 진짜 집계/윈도우/HAVING·QUALIFY 존재 여부로 재정의 → 비집계 어노테이션만 있으면 서브쿼리를 안 만든다.
  3. 서브쿼리가 필요한 경우, `added_aggregate_names`가 `get_refs`로 참조하는 어노테이션만 `set_annotation_mask`로 남기고 나머지는 마스킹.
  4. 서브쿼리가 불필요하면 기존 어노테이션을 `Ref→실표현식`으로 `replace_expressions` 인라인 후 마스킹.
  5. 어노테이션을 필터처럼 푸는 경로에 `summarize` 플래그를 추가해 `Ref`로 감쌀지 결정.

## 검증 (test_patch)
- `tests/aggregation/tests.py`의 신규 `AggregateAnnotationPruningTests`가 `CaptureQueriesContext`로 실제 SQL 문자열을 캡처해 검사.
- FAIL_TO_PASS:
  - `test_unused_aliased_aggregate_pruned`: `.alias(Count(...)).count()` → SELECT 1개(서브쿼리 없음), `authors_count` 미포함.
  - `test_non_aggregate_annotation_pruned`: `.annotate(name_lower=Lower("name")).count()` → SELECT 1개, `name_lower` 미포함.
  - `test_unreferenced_aggregate_annotation_pruned`: `.annotate(authors_count=Count(...)).count()` → 집계라 서브쿼리(SELECT 2개)는 유지하되 `authors_count` 자체는 마스킹되어 미포함.
- PASS_TO_PASS의 `test_referenced_aggregate_annotation_kept`: `.annotate(authors_count=Count(...)).aggregate(Avg("authors_count"))` → 참조되므로 `authors_count`가 SQL에 2번 등장(유지). 가지치기가 과하게 일어나지 않음을 증명.

## 공략 포인트 (뭘 조져야)
- 시작점: `django/db/models/sql/query.py`의 `get_aggregation`. problem_statement가 라인까지 지목하므로 로컬라이제이션은 쉬운 편.
- 함정/난이도:
  - 단순히 어노테이션을 다 빼면 집계가 참조하는 어노테이션(예: `Avg('authors_count')`)까지 날아가 결과가 깨진다 → 참조 추적(`get_refs`)이 필수. 이걸 `Ref`/`WhereNode`/`BaseExpression` 3곳에 일관되게 추가하는 게 핵심 난이도.
  - 비집계 어노테이션(서브쿼리 불필요)과 집계 어노테이션(서브쿼리 필요하나 미참조분 마스킹) 두 케이스 분기를 정확히 가르는 `has_existing_aggregation` 재정의(HAVING/QUALIFY split까지 포함)가 미묘하다.
  - `summarize` 플래그를 `solve_lookup_type`→`build_filter`→`_add_q`→`Q.resolve_expression`까지 4단계 전파해야 해 멀티파일 일관 수정이 필요.
- 우리 에이전트 관점: 한 군데만 고쳐 테스트 일부를 통과시키기 쉬우나, `test_referenced_aggregate_annotation_kept`(PASS_TO_PASS)와 99개 회귀를 동시에 지키려면 `get_refs` 기반 마스킹을 정확히 구현해야 한다. 가지치기 범위를 과하게 잡아 참조된 어노테이션을 날리는 over-pruning이 가장 흔한 실패 지점.
