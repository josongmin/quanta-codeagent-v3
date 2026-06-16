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
primary_type: T-DomainBound
tier: T4
loc_axis: L1
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [regression-trap, overfit-risk, underspecified]
---

# django__django-17084

## 문제 요약
Django 4.2 업그레이드 이후, Window 함수를 참조하는 annotation 위에 `aggregate()`를 적용하면 PostgreSQL에서 `psycopg2.errors.GroupingError: aggregate function calls cannot contain window function calls` 예외가 발생한다. 재현 코드는 `annotate(cumul_DJR=Coalesce(Window(Sum("DJR"), order_by=F("date").asc()), 0.0))` 후 `aggregate(cumul_DJR_total=Sum("cumul_DJR"))`이다. 4.1에서는 정상 동작했으나 4.2에서 도입된 aggregate-annotation pruning 최적화가 윈도우 참조 케이스를 누락하여, 집계 함수가 윈도우 함수 호출을 같은 SELECT 레벨에서 직접 감싸는 — DB가 거부하는 — SQL을 생성한다.

## 유형 (정형화)

**L1 (Traceable)** — 이슈가 심볼을 직접 지목하진 않지만 "since 4.2 regression" + "aggregate over Window" + `GroupingError`라는 강한 단서가 4.2에서 추가된 aggregate-pruning/outer-query wrapping 로직, 즉 `django/db/models/sql/query.py`의 `Query.get_aggregation`이라는 좁은 단일 후보로 수렴한다. grep 한 방은 아니지만(에러 메시지는 ORM 컴파일러 소스에 없음) `aggregate()` → `get_aggregation` 호출경로와 4.2 변경분 추적으로 닿는다.

**S2 (+S1) (Constraint-Reasoning, 보조 Direct-Map)** — 고칠 지점 바로 옆에 `refs_subquery` 처리 블록이 거의 동형 템플릿으로 존재해서 구조는 복제(S1)다. 그러나 픽스의 본질은 "윈도우 함수를 참조하는 집계는 바깥 subquery로 한 겹 감싸야 SQL 충돌을 피한다"는 불변식을 추론하고(S2), 어떤 annotation 속성이 그 신호인지(`contains_over_clause`)와 그 `getattr` 기본값을 보수적으로 `True`로 둬야 한다는 결정을 합성하는 데 있다. 후보를 테스트로 굴려 수렴하는 게 아니라 SQL 의미론을 따져 "생각으로" 푸는 구조라 S3/S4가 아닌 S2다.

**K-Domain** — `get_aggregation`의 wrapping 결정 분기, `contains_over_clause`, `aggregate.get_refs()`, GROUP BY/subquery 평면화 의미론은 모두 django ORM query-compiler 내부지식이다. 일반 파이썬 추론으로는 "왜 4.2 pruning이 윈도우를 빠뜨렸나"에 닿을 수 없다.

**primary type = T-DomainBound** — L1 + S2가 맞물리지만 진짜 병목은 ORM 컴파일러 내부지식(4.2 pruning 최적화의 의도와 `contains_over_clause` 계약)이다. 일단 도메인 맥락을 이해하면 인접 `refs_subquery` 템플릿 덕에 constraint 합성 자체는 쉬워지므로, dominant 축은 S2가 아니라 K-Domain → T-DomainBound로 분류한다.

## 난이도 티어
**T4 (약간 어려움).** 이 티어로 미는 구조적 피처:
- **K-Domain 병목** — ORM 컴파일러 내부의 4.2 pruning 의도 이해가 핵심. T4의 "K-Domain 중 하나" 프로파일에 정확히 부합.
- **regression-trap (P2P=107)** — `get_aggregation`은 모든 `aggregate()` 호출의 chokepoint다. wrapping 조건을 잘못 넓히면 `test_referenced_subquery_requires_wrapping`, 다수 `aggregation_default_*`, GROUP BY 관련 테스트 등 광범위한 인접 동작이 깨진다. 넓은 P2P trap은 T4 신호.
- **localize 직접성** — 단일 파일·단일 함수라 L1이고, 수정 자체는 3헌크 ~6줄로 작다. 이 점은 아래로 당기는 요소(T2~T3쪽).

순효과: 수정 줄 수만 보면 작지만(공식 라벨 "15분-1시간"과 정합), 도메인지식 의존 + 광역 regression chokepoint가 에이전트 난이도를 T4로 끌어올린다. 공식 difficulty 라벨("15분-1시간", 개발자 구현시간)은 픽스를 이미 아는 개발자 기준이라 작아 보이지만, 오라클 없는 에이전트에겐 (1) 에러 메시지가 소스에 없어 localize에 도메인 추론이 필요하고 (2) `contains_over_clause` 기본값 같은 함정이 overfit으로 빠지기 쉬워 시간라벨보다 높게 잡는다.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/sql/query.py` : `Query.get_aggregation` (3 헌크).
- **근본 원인**: 4.2의 aggregate pruning 최적화는 바깥 쿼리를 별도 subquery로 감싸 평면화를 막는 조건으로 `isinstance(self.group_by, tuple)` / `is_sliced` / `has_existing_aggregation` / `refs_subquery` / `qualify` / `distinct` / `combinator`를 나열했다. 윈도우 함수를 참조하는 집계 케이스는 이 조건에서 빠져 있어, 평면화된 단일 SELECT에서 집계 함수가 윈도우 함수 호출을 직접 감싸게 되고 — SQL 표준상 금지 — PostgreSQL이 `GroupingError`로 거부한다.
- **수정 요지**:
  1. `refs_window = False` 플래그 도입(`refs_subquery` 옆에 동형 추가).
  2. aggregate 참조 루프에서 `refs_window |= any(getattr(self.annotations[ref], "contains_over_clause", True) for ref in aggregate.get_refs())` — 참조된 annotation이 over-clause(윈도우)를 포함하면 True. `getattr` 기본값을 **`True`**로 둬 속성을 노출하지 않는 표현식도 보수적으로 wrapping하도록 fail-safe.
  3. wrapping 강제 조건절에 `or refs_window` 추가. 결과적으로 윈도우 참조 시 바깥 집계를 subquery로 한 겹 감싸 윈도우-인-aggregate 충돌을 회피.

## 검증 (test_patch)
- **FAIL_TO_PASS (1)**: `aggregation.tests.AggregateAnnotationPruningTests.test_referenced_window_requires_wrapping`. `Window` import 추가 후 `Coalesce(Window(Avg("pages"), partition_by=F("publisher")), 0.0)`로 annotate한 뒤 `Sum`/`Count`로 aggregate.
- **픽스 증명**: `@skipUnlessDBFeature("supports_over_clause")`로 윈도우 지원 DB에서만 실행. `assertNumQueries(1)`로 단일 라운드트립을 확인하고, 캡처 SQL에서 `sql.count("select") == 2`로 바깥 집계가 윈도우 annotation을 subquery로 한 겹 감쌌음을(평면화 1-select가 아님) 증명한다. 집계 결과 `{"sum_avg_publisher_pages": 1100.0, "books_count": 2}`로 값 정확성까지 검증 — 픽스 전엔 DB가 SQL 자체를 거부하므로 throw.
- **overfit 관점 (flag: overfit-risk)**: FAIL_TO_PASS가 단 1개이고 `Coalesce(Window(...))`라는 특정 형태만 친다. `if annotation_is_Window: wrap` 같은 isinstance 특수처리로도 이 테스트 1개는 통과 가능 — 그러나 `contains_over_clause`라는 일반 속성을 보는 골드패치가 올바른 일반화다. CEGIS류 추가입력(다른 윈도우 표현식)이 없어 얇은 테스트가 special-case 픽스를 거르지 못하는 구조.
- **regression 관점 (flag: regression-trap)**: P2P 107개 중 인접한 `test_referenced_subquery_requires_wrapping`(여기는 3-select 유지)과 다수 `aggregation_default_*`/GROUP BY 테스트가 wrapping 조건을 조금만 잘못 넓혀도 깨진다. 골드패치가 기존 조건은 건드리지 않고 `or refs_window` 한 항만 추가한 것이 안전한 이유.

## 모범답안 (오라클 기반)
이상적 풀이 궤적 4단계:

1. **localize 경로**: 이슈의 "since 4.2" + "aggregate over Window" + `GroupingError(aggregate function calls cannot contain window function calls)` 단서로 4.2에서 추가된 aggregate pruning/wrapping 로직을 의심한다. 에러 메시지는 DB가 내므로 소스 grep으로 안 잡힌다 → `QuerySet.aggregate()` → `Query.get_aggregation`(`django/db/models/sql/query.py`) 호출경로를 따라가 outer-query를 subquery로 감쌀지 결정하는 조건절을 찾는다. 바로 옆 `refs_subquery` 블록이 정확히 같은 부류의 처리라 이게 모범 답안의 형판임을 인지한다.

2. **픽스와 올바른 일반화인 이유**: "집계는 윈도우 함수를 같은 레벨에서 감쌀 수 없다 → 윈도우를 참조하면 바깥을 subquery로 감싸야 한다"는 불변식을 세운다. 윈도우 여부를 표현식 트리에서 일반적으로 판별하는 신호가 `contains_over_clause`다 → `refs_subquery`와 동형으로 `refs_window` 플래그를 계산하고 wrapping 조건에 `or refs_window`를 더한다. isinstance(Window) 특수처리가 아니라 `contains_over_clause` 속성을 보는 것이 올바른 일반화인 이유: `Coalesce(Window(...))`처럼 윈도우가 다른 표현식에 중첩된 경우, 임의 깊이의 over-clause를 포함한 복합 표현식까지 모두 커버하기 때문. `getattr(..., True)` 기본값은 속성 미노출 표현식도 보수적으로 감싸 거짓음성(미-wrapping → 깨진 SQL)을 막는 fail-safe.

3. **regression 안전**: 기존 wrapping 조건(`isinstance(self.group_by, tuple)`/`is_sliced`/`has_existing_aggregation`/`refs_subquery`/`qualify`/`distinct`/`combinator`)을 한 글자도 수정하지 않고 OR 항 하나만 추가 → 윈도우를 참조하지 않는 모든 경로는 byte-동일하게 동작. 이로써 `test_referenced_subquery_requires_wrapping`(3-select 유지), `test_non_aggregate_annotation_pruned`(불필요 annotation 제거 유지), 다수 `aggregation_default_*`·GROUP BY P2P가 보존된다. 새 플래그 계산은 `aggregate.get_refs()`가 비면 no-op이라 부작용 없음.

4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) `getattr`의 기본값을 `False`로 두면 `contains_over_clause`를 노출 안 하는 표현식에서 wrapping이 누락되어 일부 케이스가 다시 깨진다(보수적 `True`가 정답). (b) wrapping 조건절에만 `or refs_window`를 넣고 위쪽 참조 루프에서 플래그 계산을 빠뜨리면 항상 False라 동작 안 하는 부분-수정에 빠진다(두 곳을 같이 고쳐야 함). (c) 단 1개의 FAIL_TO_PASS만 보고 `isinstance(annotation, Window)` 특수처리로 overfit하면 중첩/복합 윈도우 표현식을 놓치고 일반화에 실패한다 — `contains_over_clause` 일반 속성을 봐야 한다. (d) 에러 메시지 grep만으로 ORM 컴파일러에 닿지 못하면 엉뚱한 곳을 고친다 → `aggregate()`→`get_aggregation` 호출경로 추적 + 인접 `refs_subquery` 패턴 모방이 막힘 없는 길.
