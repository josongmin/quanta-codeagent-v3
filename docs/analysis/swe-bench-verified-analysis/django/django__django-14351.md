---
instance_id: django__django-14351
repo: django/django
base_commit: 06fd4df41afb5aa1d681b853c3c08d8c688ca3a5
version: "4.0"
difficulty: 15 min - 1 hour
created_at: 2021-05-05T03:50:44Z
fail_to_pass: 1
pass_to_pass: 58
gold_files: [django/db/models/lookups.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep]
---

# django__django-14351

## 문제 요약
`Q(rel__in=queryset) | Q(rel__count=0)` 형태로 OR 필터를 걸면, `__in` 우변 서브쿼리가 GROUP BY 절에 들어갈 때 PK 1개 컬럼이 아니라 모델의 default column 전부를 SELECT 하게 되어 `subquery must return only one column` (DB ProgrammingError)가 발생한다. `__id__in` + `values_list("id")`로 우회하면 정상 동작하고, 2.2.5에서는 동작했으나 3.2에서 깨진 회귀(regression in `35431298226165986ad07e91f9d3aca721ff38ec`)다. 사용자는 `__in` 형태도 단일 컬럼 서브쿼리로 GROUP BY에 들어가길 기대했고, 이슈에는 도커 기반 완전한 재현 프로젝트(`ticket32690.django.proj.tar.gz`)와 네이티브 psycopg2 스택트레이스가 첨부되어 있다.

## 유형 (정형화)

- **L = L1 (Traceable)** — 이슈가 클래스/메서드를 직접 이름으로 지목하진 않지만, `"subquery must return only one column"` + `__in` lookup + GROUP BY + `get_default_columns`/`select_fields`가 1개가 아니라 전체 필드를 뱉는다는 PDB 디버그 로그가 좁은 단일 후보(GROUP BY 컬럼을 만드는 lookup 경로)로 수렴시킨다. grep 한 방은 아니고 ORM 구조 이해가 약간 필요해 L0는 아니다.
- **S = S2 Constraint-Reasoning (+S6 Design-Refactor 보조)** — 고칠 지점(`RelatedIn`)은 좁혀지지만, 픽스 자체는 "우변 서브쿼리가 select 필드를 안 가질 때 PK 단일 컬럼으로 축소한다"는 **불변식**을 group-by 경로에 정확히 재현하는 추론 합성이다. 기존 `process_rhs`가 갖는 `clear_select_clause()` + `add_fields(['pk'])` 조건(`has_select_fields`가 False일 때만)을 따져 동일 의미로 옮겨야 한다(=S2). 동시에 한 줄 수정이 아니라 **새 메서드 오버라이드(`get_group_by_cols`)를 도입**하는 소규모 구조 변경이라 S6를 보조로 둔다. 단순 가드/상수 변경(S1)이 아니므로 Direct-Map은 부적합.
- **K = K-Domain** — django ORM query-compiler 내부지식(lookup의 `process_rhs`/`get_group_by_cols` 프로토콜, `Query.has_select_fields`/`clear_select_clause`/`add_fields(['pk'])` 계약, HAVING/GROUP BY에 서브쿼리가 들어가는 경로)이 병목. 일반 파이썬 추론으로는 도달 불가.
- **primary_type = T-DomainBound** — 위치는 L1로 비교적 잡히고 변경 범위도 1파일/1메서드로 작지만, 정답을 도출하는 진짜 병목은 "ORM이 OR-결합된 `__in` 서브쿼리를 group-by 컬럼으로 어떻게 직렬화하는가"라는 프레임워크 내부지식이다. localize가 가장 어려운 것(T-DiffuseLoc)도, 식 합성이 순수 추론(T-ConstraintReason)인 것도 아니고, 도메인 지식이 dominant 병목이라 T-DomainBound.

## 난이도 티어
**T4 (약간 어려움).** 공식 라벨은 `15 min - 1 hour`(중하)지만 에이전트 난이도는 그보다 약간 위로 본다.

이 티어로 미는 구조적 피처:
- **K-Domain dominant** — 픽스가 ORM lookup의 group-by 직렬화 프로토콜을 정확히 알아야 가능. 루브릭상 K-Domain 단독으로도 T4 진입 조건.
- **regression-trap (P2P=58)** — `aggregation_regress` 스위트 58개를 안 깨야 한다. `get_group_by_cols`는 GROUP BY 생성의 핵심 경로라 잘못 건드리면 광범위한 인접 동작(annotate/having/distinct count 등)이 깨진다. 넓은 P2P trap은 T4 근거.
- **misdirection 함정** — 증상이 `compiler.get_group_by`/`query.get_default_columns`에서 표출되고 사용자조차 `query.py:233` 해킹(`cols[0].alias == 'U0'`)을 제안하므로, 호출부 상류를 고치고 싶게 만든다. 올바른 수정점은 lookup 클래스다.

T4를 넘어 T5로 가지 않는 이유: 단일 파일·단일 메서드(<10줄)에 변경이 국한되고(L3 멀티사이트 조율 아님), `has-repro`(도커 재현 + 네이티브 스택트레이스)라는 강한 easiness 신호가 있으며, 픽스의 올바른 형태가 바로 옆 `process_rhs`에 이미 존재해 overfit 위험이 낮다.

공식 라벨(중하)과 다른 방향(약간 위)인 이유: 시간라벨은 "구현 시간"이라 ORM 내부 call-chain을 추적하는 localize 비용과 group-by 회귀 위험을 반영하지 못한다.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/lookups.py` — `RelatedIn`(`__in` lookup)에 `get_group_by_cols(self, alias=None)` 신규 오버라이드 추가.
- **근본 원인**: `RelatedIn`은 우변이 queryset일 때 `process_rhs`에서 `not getattr(self.rhs, 'has_select_fields', True)`이면 `self.rhs.clear_select_clause()` + `self.rhs.add_fields(['pk'])`로 서브쿼리를 단일 PK 컬럼으로 축소한다. 그러나 OR 결합으로 표현식이 HAVING 절에 들어가 GROUP BY 컬럼이 필요해지면, 베이스 lookup의 기본 `get_group_by_cols`는 우변 서브쿼리의 default columns를 전부 끌어와 multi-column 서브쿼리를 GROUP BY에 박는다. 즉 `process_rhs`가 하던 단일-컬럼 축소가 **group-by 경로에는 적용되지 않은 누락**이 원인.
- **수정 요지**: 좌변 컬럼을 `cols = self.lhs.get_group_by_cols()`로 받고, 우변이 `get_group_by_cols`를 가지면(`hasattr`) `not getattr(self.rhs, 'has_select_fields', True)`일 때 `self.rhs.clear_select_clause()` + `self.rhs.add_fields(['pk'])`로 서브쿼리를 PK 단일 컬럼으로 강제한 뒤 `cols.extend(self.rhs.get_group_by_cols())`로 합쳐 반환. `process_rhs`의 단일-컬럼 축소 로직을 group-by 경로에 동일 의미로 미러링한 것이며, 우변이 단순 컬럼이라 `get_group_by_cols`를 안 가지는 경우엔 좌변 cols만 반환해 기존 동작을 보존한다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1)**: `test_having_subquery_select (aggregation_regress.tests.AggregationTests)` — `@skipUnlessDBFeature('supports_subqueries_in_group_by')`로 해당 기능 지원 DB(postgres 등)에서만 실행되고, 미지원 백엔드(예: 일부 환경)에서는 visible-skip 된다.
- **픽스 증명**: `authors = Author.objects.filter(pk=self.a1.pk)`로 서브쿼리 queryset을 만들고, `Book.objects.annotate(Count('authors')).filter(Q(authors__in=authors) | Q(authors__count__gt=2))`를 평가한다. 픽스 전엔 GROUP BY에 multi-column 서브쿼리가 들어가 DB가 `subquery must return only one column`을 던졌고, 픽스 후엔 단일 PK 서브쿼리로 직렬화되어 쿼리가 실행되며 `set(books) == {self.b1, self.b4}`가 성립한다. 즉 단순 "예외 안 남"이 아니라 OR + annotate(Count) 조합의 **결과 집합 정확성**까지 단언한다.
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇긴 하나, 픽스가 special-case 매칭(예: 이슈가 제안한 `cols[0].alias == 'U0'` 같은 alias 하드코딩)이 아니라 기존 `process_rhs`의 일반 불변식을 재사용하므로 overfit 위험은 낮다. 결과 집합까지 검증해 vacuous pass도 방지.
- **regression 관점**: P2P 58개(`aggregation_regress` 전반 — having/group-by/distinct-aggregate/join-promotion 등)가 `get_group_by_cols`의 핵심 경로를 커버하므로, 좌변 cols 보존 + 우변 `get_group_by_cols` 부재 시 no-op이 깨지면 즉시 적발된다. `flags: regression-trap`의 실질 근거.

## 모범답안 (오라클 기반)
1. **localize 경로**: 에러 문자열 `"subquery must return only one column"` + `__in` lookup이 우변 서브쿼리를 가진다는 점 + PDB 로그의 `select_fields: [0,1,2,3,4,5,6]`(전체) vs 정상의 `[0]`(PK만) 대비 → "우변 서브쿼리 컬럼 축소가 어떤 경로에서만 안 일어난다"로 좁힌다. `__in` lookup → `django/db/models/lookups.py`의 `RelatedIn`을 열고, `process_rhs`가 이미 `clear_select_clause()` + `add_fields(['pk'])`로 단일 컬럼 축소를 하고 있음을 발견. 정상 SQL(having의 IN 절)은 단일 컬럼인데 GROUP BY 항만 multi-column이라는 점에서 "group-by 경로에 동일 축소가 빠졌다"로 귀결.
2. **픽스와 올바른 일반화인 이유**: `RelatedIn.get_group_by_cols`를 오버라이드해 `process_rhs`와 **동일한 조건(`has_select_fields` False일 때만 PK로 축소)·동일한 호출(`clear_select_clause`/`add_fields(['pk'])`)**을 group-by 경로에 적용. 이게 올바른 일반화인 이유: alias 이름(`'U0'`)이나 특정 모델에 의존하지 않고, "select 필드를 명시 안 한 서브쿼리는 group-by에서도 PK 단일 컬럼이어야 한다"는 ORM의 기존 불변식을 한 경로에 마저 적용하는 것이기 때문. 우변이 일반 컬럼이면(`get_group_by_cols` 부재) 좌변 cols만 반환해 비-서브쿼리 케이스를 건드리지 않는다.
3. **regression 안전**: P2P 58개가 group-by/having/aggregate 경로를 폭넓게 커버. 안전 조건은 (a) 좌변 컬럼은 항상 그대로 내보낼 것(`cols = self.lhs.get_group_by_cols()`), (b) 우변이 서브쿼리가 아닐 때 추가 컬럼을 만들지 말 것(`hasattr` 가드), (c) `has_select_fields`가 True(사용자가 명시한 select)면 축소하지 말 것. 이 셋을 지키면 `test_having_group_by`/`test_annotation_disjunction`/distinct-aggregate 류가 안 깨진다.
4. **함정 회피**: 오라클 없는 에이전트는 (i) 증상이 표출되는 `compiler.get_group_by`/`query.get_default_columns` 상류를 고치려다 광범위 회귀를 부르거나, (ii) 이슈가 친절히 제안한 `cols[0].alias == 'U0'` 하드코딩을 그대로 베껴 overfit(다른 alias·중첩 서브쿼리에서 깨짐)하기 쉽다. 회피법은 **`process_rhs`에 이미 존재하는 PK 축소 패턴을 정답의 템플릿으로 삼아** 같은 의미를 `get_group_by_cols`에 복제하는 것 — 상류 hack도, alias 하드코딩도 아닌 lookup-local 오버라이드가 정답임을 `process_rhs` 발견이 강하게 시사한다.
