---
instance_id: django__django-17084
repo: django/django
base_commit: f8c43aca467b7b0c4bb0a7fa41362f90b610b8df
version: "5.0"
difficulty: 15 min - 1 hour
created_at: 2023-07-17T16:54:19Z
fail_to_pass: 1
pass_to_pass: 107
gold_files: [django/db/models/sql/query.py]
---

# django__django-17084

## 문제 요약
Django 4.2 업그레이드 이후, Window 함수를 참조하는 annotation 위에 `aggregate()`를 적용하면 PostgreSQL에서 `GroupingError: aggregate function calls cannot contain window function calls` 예외가 발생한다. 예를 들어 `annotate(cumul=Coalesce(Window(Sum("DJR"), order_by=...), 0.0))` 후 `aggregate(Sum("cumul"))`을 호출하는 코드다. 사용자는 4.1처럼 정상적으로 윈도우 함수 위의 집계가 동작하길 기대했다.

## 유형 분류
- 버그 카테고리: regression (4.2에서 aggregate-pruning 최적화가 들어오며 깨짐) + 누락처리 (window 케이스 미고려)
- 서브시스템: django ORM query 컴파일 — `SQLAggregateCompiler`/subquery wrapping 결정 로직
- 증상 타입: 예외 (DB 레벨 GroupingError, 잘못된 SQL 생성)
- 로컬라이제이션 신호: "since 4.2", aggregate-over-window, GroupingError → 4.2에서 추가된 aggregate-annotation pruning 로직, 즉 `get_aggregation`에서 outer-query/subquery wrapping 여부를 결정하는 분기

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/sql/query.py` : `Query.get_aggregation`
- 근본 원인: 4.2의 aggregate pruning 최적화는 집계 대상이 subquery를 참조할 때만 (`refs_subquery`) 바깥 쿼리를 별도 subquery로 감싸 평면화를 막았다. 하지만 윈도우 함수를 참조하는 경우는 wrapping 조건에서 빠져 있어, 집계 함수가 윈도우 함수 호출을 같은 SELECT 레벨에서 직접 감싸버려 DB가 거부하는 SQL이 생성됐다.
- 수정 요지: `refs_window` 플래그를 도입. 각 aggregate의 참조(`aggregate.get_refs()`)에 대해 참조된 annotation이 `contains_over_clause`(기본값 True로 보수적 처리)를 가지면 `refs_window`를 True로 설정한다. 그리고 outer-query subquery wrapping을 강제하는 조건절(`is_sliced` / `has_existing_aggregation` / `refs_subquery` / `qualify` / `distinct` / `combinator` 나열)에 `or refs_window`를 추가한다. 결과적으로 윈도우 참조 시 집계를 바깥 subquery로 감싸 윈도우-인-aggregate 충돌을 회피한다.

## 검증 (test_patch)
- FAIL_TO_PASS: `AggregateAnnotationPruningTests.test_referenced_window_requires_wrapping` — `Window` import 추가 후, `Coalesce(Window(Avg("pages"), partition_by=F("publisher")), 0.0)`로 annotate한 뒤 `Sum`/`Count`로 aggregate.
- 증명 방식: `@skipUnlessDBFeature("supports_over_clause")`로 윈도우 지원 DB에서만 수행. `assertNumQueries(1)`로 단일 쿼리임을 확인하고, 캡처된 SQL에서 `sql.count("select") == 2`로 바깥 집계가 윈도우 annotation을 subquery로 한 겹 감쌌음을 확인한다(픽스 전엔 wrapping이 없어 깨진 SQL이거나 잘못된 SELECT 카운트). 또 집계 결과가 `{"sum_avg_publisher_pages": 1100.0, "books_count": 2}`로 정확히 나오는지 검증한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: "4.2 regression + aggregate over window" 단서로 `query.py`의 `get_aggregation`을 먼저 본다. 인접한 기존 `refs_subquery` 처리 패턴이 그대로 모범 답안 — 동일한 패턴을 window에 복제하면 된다.
- 함정/난이도: (1) `contains_over_clause`의 `getattr` 기본값을 `True`로 둔 점이 핵심 — annotation이 해당 속성을 노출하지 않아도 보수적으로 wrapping하도록 fail-safe 처리. 이를 False로 잘못 두면 일부 표현식에서 wrapping이 누락된다. (2) wrapping 조건절 한 줄에만 추가하고 플래그 계산 루프를 빼먹으면 동작하지 않는 부분 수정에 빠지기 쉽다. (3) 멀티파일 아님 — 단일 파일, 단일 함수.
- 우리 에이전트 관점: 근본 원인이 "왜 4.2에서 추가된 pruning이 윈도우를 빠뜨렸나"라는 의도 이해에 있다. 단순 grep으로 윈도우 에러 메시지를 찾는 접근은 ORM 컴파일러까지 닿지 못할 수 있어, `aggregate()` → `get_aggregation` 호출 경로를 추적하고 기존 `refs_subquery` 분기를 모델로 삼는 것이 막힘 없는 길이다.
