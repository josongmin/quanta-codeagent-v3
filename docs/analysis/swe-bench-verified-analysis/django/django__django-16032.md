---
instance_id: django__django-16032
repo: django/django
base_commit: 0c3981eb5094419fe200eb46c71b5376a2266166
version: 4.2
difficulty: 15 min - 1 hour
created_at: 2022-09-06T09:54:57Z
fail_to_pass: 2
pass_to_pass: 77
gold_files: [django/db/models/fields/related_lookups.py, django/db/models/sql/query.py]
---

# django__django-16032

## 문제 요약
`__in` 룩업의 우변(RHS)에 QuerySet을 넘길 때, `.annotate()` 다음에 `.alias()`를 같이 호출하면 RHS가 PK 1컬럼으로 축소되지 않는다. 그 결과 서브쿼리가 여러 컬럼을 반환해 `OperationalError: sub-select returns 10 columns - expected 1`가 발생한다. 사용자는 `.values()` 없이도 `pk__in=subquery`가 자동으로 PK 단일 컬럼으로 제한되길 기대했다 (`.alias`만 또는 `.annotate`만 쓰면 정상 동작).

## 유형 분류
- 버그 카테고리: logic / edge-case (heuristic이 특정 조합에서 오판)
- 서브시스템: django ORM query — related lookups(`__in`) + SQL Query 빌더
- 증상 타입: 예외 (DB 레벨 `OperationalError`, 서브쿼리 컬럼 수 불일치)
- 로컬라이제이션 신호: problem_statement의 `__in` + `.annotate().alias()` 조합, hints_text가 직접 `RelatedIn.get_prep_lookup`과 `Query.has_select_fields`를 지목함

## 골드패치 분석
- 건드린 파일/함수:
  - `django/db/models/sql/query.py` : `Query.has_select_fields` (동적 property → 클래스 속성), `Query.set_values`
  - `django/db/models/fields/related_lookups.py` : `RelatedIn.get_prep_lookup`
- 근본 원인: `has_select_fields`가 `bool(self.select or self.annotation_select_mask or self.extra_select_mask)`로 동적 계산됐다. `f4ac1671`로 도입된 `QuerySet.alias`는 `add_annotation`에서 `set_annotation_mask`를 호출해 `annotation_select_mask`를 materialize한다. 따라서 `annotate + alias` 조합에서는 실제로 `.values()`를 안 했는데도 mask가 차서 `has_select_fields`가 True가 되고, `RelatedIn`이 "이미 select 필드가 있다"고 오판해 PK 축소(`In` 단일 컬럼 제한)를 건너뛴다.
- 수정 요지: `has_select_fields`를 default `False` 클래스 속성으로 바꾸고, `set_values`가 명시적으로 `self.has_select_fields = True`를 세팅하도록 했다. 즉 "values()가 실제 호출됐는가"를 내부 mask 엿보기 대신 명시 플래그로 추적한다. 그리고 `RelatedIn.get_prep_lookup`에서 `clear_select_clause()` + `add_fields([target_field], True)` 두 단계를 `set_values([target_field])` 한 번으로 교체해, RHS 축소가 동일한 플래그 경로를 거치게 했다.

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `test_annotation_and_alias_filter_in_subquery` — `Publisher.filter(num_awards__gt=4).annotate(...).alias(...)`를 `pk__in` 서브쿼리로 사용, `[p3, p4]` 기대.
  - `test_annotation_and_alias_filter_related_in_subquery` — `Book.filter(pages__gt=400).annotate().alias()`를 `book__in` 서브쿼리로 사용해 4개 publisher name 기대.
- 테스트가 픽스를 증명하는 방식: 패치 전에는 RHS 서브쿼리가 모든 select 컬럼(annotate 포함 ~10컬럼)을 그대로 내보내 DB가 단일 컬럼만 기대하는 `IN (subquery)`에서 에러를 던졌다. 패치 후 `set_values([target_field])`가 PK 단일 컬럼으로 강제되어 서브쿼리가 1컬럼만 반환 → 정상 비교 → 기대 row 집합과 일치.

## 공략 포인트 (뭘 조져야)
- localization 전략: `__in` 우변이 QuerySet일 때 컬럼 축소 로직은 `related_lookups.py`의 `RelatedIn.get_prep_lookup`. 여기서 분기 조건이 `has_select_fields`이므로, 그 property 정의(`sql/query.py`)까지 따라가야 한다. hints가 거의 정답 위치를 알려줌.
- 함정/난이도 메모: 멀티파일 픽스다. `query.py`만 고쳐 `has_select_fields`를 속성화하면 `RelatedIn`이 여전히 `clear_select_clause`+`add_fields` 옛 경로를 타서 `queries.tests.ToFieldTests`의 `test_in_subquery`/`test_nested_in_subquery`가 회귀한다(힌트에 실제 실패 기록). `related_lookups.py`의 `set_values` 전환이 반드시 함께 가야 PASS_TO_PASS가 깨지지 않는다.
- 우리 에이전트 관점: 단일 파일 수정으로 그치기 쉬운 함정. `annotation_select_mask` materialize 같은 간접 부작용을 추적해야 근본 원인이 보이고, 동적 property를 명시 플래그로 바꾸는 "설계 교체"라 표면적 핫픽스(특정 조합 가드)로 우회하면 다른 IN-subquery 경로가 깨진다. set_values로의 경로 통일이 핵심 통찰.
