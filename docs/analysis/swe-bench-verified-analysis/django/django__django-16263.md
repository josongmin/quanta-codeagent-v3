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
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, has-repro]
---

# django__django-16263

## 문제 요약
`Book.objects.annotate(Count('chapters')).count()`처럼 어노테이션을 단 뒤 `count()`를 호출하면, 어디서도(필터·다른 어노테이션·정렬) 참조되지 않는 어노테이션이 SQL에 그대로 포함된다. 그 결과 불필요한 서브쿼리 + GROUP BY가 생성되어, 결과는 `Book.objects.count()`와 같지만 매우 느린 SQL이 나간다(GROUP BY가 매칭된 모든 행을 dedup시켜 대형 결과셋에서 치명적). 이슈는 비참조 어노테이션을 count 쿼리에서 가지치기해 단순 `COUNT(*)`로 떨어뜨리기를 요구한다. `select_related`가 `count()`에서 무시되는 선례가 있다고 명시.

## 유형 (정형화)
- **L = L3 (Multi-site)**: 픽스가 4개 파일에 걸쳐 **함께** 바뀌어야 한다. 핵심은 `sql/query.py:get_aggregation`이지만, 그게 동작하려면 `expressions.py`/`where.py`에 신규 `get_refs()` 프로토콜을 동시 도입하고 `query_utils.py`의 `refs_expression` 반환 시그니처를 바꿔야 한다. problem_statement가 `get_aggregation` 라인을 지목해 진입점은 L0급으로 쉽지만, **올바른 픽스가 펼쳐지는 면적이 다지점·조율형**이라 L3.
- **S = S6 Design-Refactor (+S2 Constraint-Reasoning)**: 한 줄 수정이 아니다. (a) "표현식이 어떤 `Ref`를 참조하는가"를 산출하는 신규 메서드 `get_refs()`를 `BaseExpression`/`Ref`/`WhereNode` 3곳에 일관 구조로 도입(collect-then-mask 구조 신설), (b) `solve_lookup_type→build_filter→_add_q→Q.resolve_expression`에 `summarize` 파라미터를 4단계 스레딩하는 lifecycle 변경이 필요 → 전형적 S6. 동시에 "서브쿼리가 정말 필요한가"를 `has_existing_aggregation`(집계/윈도우/HAVING·QUALIFY 존재)로 **불변식을 재합성**하는 부분은 S2.
- **K = K-Domain**: django ORM query-compiler 깊은 내부지식 의존. `annotation_select` vs `annotations`, `set_annotation_mask`, `contains_aggregate`/`contains_over_clause`, `split_having_qualify`, `Ref`/`replace_expressions` 같은 비공개 컴파일러 메커니즘을 정확히 알아야만 픽스 가능. 일반 파이썬 추론으로는 불가.
- **primary type = T-DesignRefactor**: dominant 축이 S6 구조 변경이다. 진짜 어려움은 "어디인지"(L은 지목됨)도, 단일 식 추론(S2)도 아니라, **참조추적 인프라(get_refs)를 새로 깔고 summarize 플래그를 파이프라인에 스레딩하는 조율된 설계 변경**에 있다. 그래서 T-DiffuseLoc(찾기가 어려움)이 아니라 T-DesignRefactor.

## 난이도 티어
**T5 (어려움).** 공식 라벨은 "1-4 hours"(중상). 구조적 피처로 재조정하면 T5가 맞다:
- **patch scope가 크다**: 4개 파일 × 다수 헌크. ICLR 2024 컷에서 ≥3파일은 solve <10% 구간.
- **L3 멀티사이트 조율**: `get_refs()`를 한 곳만 추가하면 컨테이너 표현식에서 AttributeError가 나거나 참조집합이 비어 over-pruning. 3개 클래스에 동시·일관 도입이 강제됨(cross-file-dep).
- **regression-trap이 광범위**: PASS_TO_PASS 100개(거의 전부 aggregation suite). over-pruning이 조금이라도 새면 `test_referenced_aggregate_annotation_kept`를 포함해 `Avg('authors_count')`류 참조 집계, subquery GROUP BY 동작 다수가 깨진다.
- **깊은 도메인지식(K-Domain)** + 비집계/집계 분기의 미묘함(`has_existing_aggregation` 재정의에 HAVING/QUALIFY까지 포함).
- has-repro(이슈에 4-variant SQL 캡처가 있어 진입은 쉬움)가 T6까지는 못 올림. 하지만 진입 쉬움은 "라벨이 시간만 본다"는 루브릭 단서대로 **localize 쉬움 ≠ 픽스 쉬움**이며, 픽스의 조율 면적·회귀 위험이 시간라벨에 안 잡혀 T5로 상향한다.

## 골드패치 분석
- **건드린 파일·함수**
  - `sql/query.py:Query.get_aggregation` — 핵심. 더해 `solve_lookup_type`, `build_filter`, `_add_q`에 `summarize` 파라미터 추가·전파.
  - `expressions.py` — `BaseExpression.get_refs()`(자식 union), `Ref.get_refs()`(`{self.refs}`) 신규.
  - `sql/where.py` — `WhereNode.get_refs()`(자식 union) 신규.
  - `query_utils.py` — `Q.resolve_expression`에 `summarize=summarize` 전달, `refs_expression`이 `(annotation_obj, ...)` 대신 `(level_n_lookup, ...)`(이름) 반환하도록 시그니처 변경.
- **근본 원인**: `get_aggregation`이 `existing_annotations`가 하나라도 있으면(집계 여부 무관) 무조건 서브쿼리 + GROUP BY를 강제했다. "어떤 어노테이션이 실제 집계에 참조되는지" 판별할 수단(`get_refs`)이 없어 전부 보수적으로 끌고 갔다. 코드 주석조차 "we aren't smart enough to remove the existing annotations"라고 자인.
- **수정 요지**
  1. 모든 표현식이 자신이 참조하는 `Ref` 이름 집합을 반환하는 `get_refs()`를 가지도록 추가(`Ref`=자기 이름, 컨테이너=자식 합집합).
  2. `has_existing_aggregation`을 진짜 집계/윈도우(`contains_aggregate`/`contains_over_clause`) 또는 HAVING·QUALIFY(`where.split_having_qualify()[1:]`) 존재로 재정의 → **비집계 어노테이션만 있으면 서브쿼리를 안 만든다**.
  3. 서브쿼리가 필요한 경우: `added_aggregate_names` + 그들이 `get_refs`로 참조하는 어노테이션만 `annotation_mask`에 모아 `set_annotation_mask`로 남기고 나머지 마스킹.
  4. 서브쿼리가 불필요한 경우: 기존 어노테이션을 `{Ref(alias, ann): ann}`로 `replace_expressions` 인라인 후 `set_annotation_mask(added_aggregate_names)`.
  5. 어노테이션을 필터처럼 푸는 경로(`solve_lookup_type`)에 `summarize`를 추가해, 참조를 `Ref(annotation, expression)`로 감쌀지 결정.

## 검증 (test_patch)
- `tests/aggregation/tests.py`에 신규 `AggregateAnnotationPruningTests`. 모두 `CaptureQueriesContext`로 **실제 발행 SQL 문자열**을 캡처해 `select` 개수와 alias 포함 여부를 단언 → 결과값이 아니라 생성 SQL의 형태를 직접 관찰(강한 effect 관찰).
- **FAIL_TO_PASS (3)**
  - `test_unused_aliased_aggregate_pruned`: `.alias(authors_count=Count("authors")).count()` → `select` 1개(서브쿼리 없음), `authors_count` 미포함.
  - `test_non_aggregate_annotation_pruned`: `.annotate(name_lower=Lower("name")).count()` → `select` 1개, `name_lower` 미포함.
  - `test_unreferenced_aggregate_annotation_pruned`: `.annotate(authors_count=Count("authors")).count()` → 집계라 서브쿼리(`select` 2개)는 유지하되 미참조이므로 `authors_count` 자체는 마스킹되어 미포함.
- **overfit·regression 관점**
  - PASS_TO_PASS의 `test_referenced_aggregate_annotation_kept`가 핵심 anti-overfit 게이트: `.annotate(authors_count=Count("authors")).aggregate(Avg("authors_count"))` → 참조되므로 `authors_count`가 SQL에 **정확히 2번** 등장(서브쿼리 + 외부 참조). over-pruning을 직접 차단하는 paired-control.
  - 나머지 ~99개 P2P가 aggregation 전 영역(subquery GROUP BY 규칙, default, exists, values 등)을 커버 → 가지치기가 인접 동작을 깨면 즉시 RED. regression-trap이 크다는 분류 근거.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈 본문이 두 신호를 준다 — (a) `queryset.count()`가 비참조 어노테이션을 SQL에 남긴다, (b) `django/db/models/sql/query.py` L404-414(get_aggregation 주변) 주석을 링크로 지목. 따라서 `Query.get_aggregation`을 진입점으로 잡고, `existing_annotations`가 무조건 서브쿼리/GROUP BY를 트리거하는 분기를 찾는다. "참조되는 어노테이션만 남긴다"는 요구에서 곧바로 **참조추적 메서드 부재**가 드러난다 → `Ref`/`replace_expressions`가 사는 `expressions.py`와 `WhereNode`가 사는 `where.py`로 확장.
2. **픽스와 올바른 일반화인 이유**: 단순히 어노테이션을 다 빼면 안 된다 → `get_refs()`로 "added aggregate가 실제 참조하는 어노테이션 집합"을 계산해 그것만 보존하고 나머지를 `set_annotation_mask`로 마스킹. 이는 special-case(`Count`/`Lower`만 처리)가 아니라 **참조 그래프 기반 일반 규칙**이라, 임의 표현식·중첩 집계에도 성립한다. 또 비집계 어노테이션이면 서브쿼리 자체를 제거(인라인+마스킹), 집계면 서브쿼리는 두되 미참조분만 마스킹 — 두 케이스를 `has_existing_aggregation`(집계/윈도우/HAVING·QUALIFY)로 정확히 가르는 게 올바른 일반화의 축.
3. **regression 안전**: `Avg('authors_count')`처럼 어노테이션을 참조하는 집계는 반드시 서브쿼리에 남아야 한다(`test_referenced_aggregate_annotation_kept`). 또 subquery-annotation GROUP BY 규칙, default-after-annotation, values 경로 등 ~99개 P2P를 깨지 않아야 한다. 그래서 마스크는 "보존집합 = added_aggregate_names ∪ 그 refs"의 **포함 기준(allow-list)**으로 만들고, `summarize` 플래그를 필터 빌드 경로에 스레딩해 참조가 `Ref`로 올바르게 잡히도록 한다(끊기면 참조집계가 마스킹돼 회귀).
4. **함정 회피**: 오라클 없는 에이전트의 가장 흔한 실패는 (a) `get_aggregation` 한 곳만 손대 `get_refs` 인프라 없이 어노테이션을 통째로 날려 **over-pruning**(참조집계 깨짐, P2P 다수 RED), (b) `get_refs()`를 `Ref`에만 넣고 컨테이너(`BaseExpression`/`WhereNode`)에 안 넣어 중첩식에서 빈 집합/AttributeError, (c) `summarize` 스레딩을 빠뜨려 HAVING/QUALIFY 참조를 놓침. 회피법: 픽스를 "마스크 계산 = 참조 폐포(closure)"로 설계하고, FAIL_TO_PASS 3개뿐 아니라 `test_referenced_aggregate_annotation_kept` + aggregation suite 전체를 게이트로 돌려 over-pruning을 즉시 적발한다.
