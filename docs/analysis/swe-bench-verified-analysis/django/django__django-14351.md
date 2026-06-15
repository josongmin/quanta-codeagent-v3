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
---

# django__django-14351

## 문제 요약
`Q(rel__in=queryset) | Q(rel__count=0)` 형태로 OR 필터를 걸면, `__in` 우변 서브쿼리가 GROUP BY 절에 들어갈 때 PK 1개 컬럼이 아니라 모델의 모든 default column을 SELECT 하게 되어 `subquery must return only one column` (ProgrammingError)가 발생한다. `__id__in` + `values_list("id")`로 우회하면 정상 동작하고, 2.2.5에서는 동작했으나 3.2에서 깨진 회귀다. 사용자는 `__in` 형태도 단일 컬럼 서브쿼리로 GROUP BY에 들어가길 기대했다.

## 유형 분류
- 버그 카테고리: regression (커밋 35431298226165986ad07e91f9d3aca721ff38ec 회귀)
- 서브시스템: django ORM query / lookups (GROUP BY 컬럼 생성)
- 증상 타입: 예외 (DB ProgrammingError — multi-column subquery)
- 로컬라이제이션 신호: 문제 설명의 `__in` lookup이 서브쿼리를 우변으로 가지며 GROUP BY에 들어간다는 점, 그리고 `get_default_columns`/`select_fields`가 1개가 아닌 전체 필드를 뱉는다는 디버그 로그 → GROUP BY 컬럼을 만드는 lookup의 `get_group_by_cols` 누락이 원인임을 가리킨다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/lookups.py` — `RelatedIn.get_group_by_cols` (신규 오버라이드)
- 근본 원인: `RelatedIn`(`__in` lookup)은 `process_rhs`에서 우변이 select 필드를 갖지 않으면 `clear_select_clause()` + `add_fields(['pk'])`로 단일 PK 컬럼으로 줄인다. 그러나 OR 결합으로 HAVING 절에 들어가 GROUP BY 컬럼이 필요해지면, 기본 `get_group_by_cols`가 우변 서브쿼리의 default columns를 전부 가져와 multi-column 서브쿼리를 만든다. `process_rhs`의 컬럼 축소 로직이 group-by 경로에는 적용되지 않았던 것.
- 수정 요지: `RelatedIn`에 `get_group_by_cols`를 오버라이드. 좌변 컬럼(`self.lhs.get_group_by_cols()`)을 받고, 우변이 `get_group_by_cols`를 가지면 `has_select_fields`가 False일 때 `clear_select_clause()` + `add_fields(['pk'])`로 서브쿼리를 PK 단일 컬럼으로 강제한 뒤 그 cols를 합쳐 반환한다. 즉 `process_rhs`와 동일한 단일-컬럼 축소를 group-by 경로에도 그대로 재현한다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_having_subquery_select` — `supports_subqueries_in_group_by` 기능이 있는 DB에서만 실행.
- 테스트가 어떻게 증명하는지: `Author.objects.filter(pk=self.a1.pk)`로 서브쿼리 queryset을 만들고, `Book.objects.annotate(Count('authors')).filter(Q(authors__in=authors) | Q(authors__count__gt=2))`를 평가한다. 픽스 전에는 GROUP BY에 multi-column 서브쿼리가 들어가 DB 예외가 났고, 픽스 후에는 단일 PK 서브쿼리로 정상 실행되어 `set(books) == {self.b1, self.b4}`가 성립한다. 즉 OR 결합 + annotate(Count) 조합에서 쿼리가 실제로 실행되고 올바른 결과를 내는지를 검증.

## 공략 포인트 (뭘 조져야)
- localization 전략: "subquery must return only one column" + `__in` lookup + GROUP BY 키워드로 `django/db/models/lookups.py`의 `RelatedIn` 클래스를 찾는다. `process_rhs`가 이미 `clear_select_clause`/`add_fields(['pk'])`로 단일 컬럼 처리를 하는 것을 보면, 같은 처리가 빠진 경로(`get_group_by_cols`)가 진짜 결함 지점임을 추론할 수 있다.
- 함정/난이도 메모: 증상이 `query.py`나 `compiler.py`의 default_columns/GROUP BY 생성부에서 나타나서 거기를 고치고 싶어지지만(사용자도 `query.py:233` 해킹 제안), 올바른 수정은 lookup 클래스에 `get_group_by_cols`를 추가하는 것이다. `process_rhs`의 PK 축소 로직을 미러링해야 하며 `has_select_fields` 게팅(기본값 True)을 정확히 따라야 한다. 단일 파일·단일 메서드 추가라 변경 범위는 작다.
- 우리 에이전트 관점: 막힐 지점은 (1) `compiler.get_group_by`나 `query.get_default_columns` 같은 넓은 호출부에서 hack을 시도하다 회귀를 부를 위험, (2) `RelatedIn`이 GROUP BY 컬럼 생성에 관여한다는 연결을 놓치는 것. `process_rhs`에 이미 있는 PK 축소 패턴을 발견하면 "동일 처리를 group-by 경로에 복제"라는 정답이 자연히 도출된다.
