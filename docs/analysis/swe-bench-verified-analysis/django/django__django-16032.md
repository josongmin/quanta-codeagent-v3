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
primary_type: T-ConstraintReason
tier: T4
loc_axis: L3
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, has-repro]
---

# django__django-16032

## 문제 요약
`__in` 룩업의 우변(RHS)에 QuerySet을 넘길 때, `.annotate()` 다음에 `.alias()`를 같이 호출하면 RHS가 PK 1컬럼으로 축소되지 않는다. 그 결과 서브쿼리가 여러 컬럼을 반환해 `OperationalError: sub-select returns 10 columns - expected 1`가 발생한다. 사용자는 `.values()` 없이도 `pk__in=subquery`가 자동으로 PK 단일 컬럼으로 제한되길 기대했다 (`.alias`만 또는 `.annotate`만 쓰면 정상 동작). 이슈에 재현 테스트케이스와 정확한 DB 에러 메시지가 함께 첨부되어 있다.

## 유형 (정형화)
- **L = L3 (Multi-site)**: 픽스가 `sql/query.py`와 `fields/related_lookups.py` 두 파일에 **조율되어** 들어가야 한다. `query.py`만 고치면 `RelatedIn`이 옛 경로를 타서 다른 IN-subquery 테스트가 회귀하므로, 두 곳이 함께 바뀌어야 정합. 단순히 후보가 흩어진 L2가 아니라 "함께 변경" 성격이라 L3.
- **S = S2 (Constraint-Reasoning) + S6 (Design-Refactor)**: 고칠 지점(`has_select_fields` 분기)은 hints가 거의 지목해 주지만, 올바른 픽스는 "`annotation_select_mask`가 materialize되는 시점 ≠ 사용자가 `.values()`를 호출한 시점"이라는 **불변식을 추론**해 도출해야 한다(S2). 동적 property를 명시 플래그로 바꾸고 RHS 축소 경로를 `set_values`로 통일하는 작은 구조 교체가 동반되므로 S6 보조.
- **K = K-Domain**: django ORM 쿼리 컴파일러 내부(`annotation_select_mask`/`extra_select_mask`/`set_annotation_mask`/`QuerySet.alias`가 `add_annotation`에 piggyback) 지식이 병목. 일반 파이썬 추론으로는 근본원인이 안 보인다.
- **primary type = T-ConstraintReason**: 위치는 어느 정도 주어졌으나(L3 멀티사이트), 핵심 난점은 "어떤 조건이 진짜 select-fields 의도를 나타내는가"라는 식·불변식의 추론 합성이다. 따라서 T-DiffuseLoc(찾기가 본질)이나 T-DomainBound(지식만이 병목)보다 T-ConstraintReason이 dominant.
- **왜 이 repair strategy인가 (APR 관점)**: 후보를 마구 생성해 테스트로 거르는 G&V로는 위험하다 — `annotate+alias` 조합만 특수가드하는 plausible 패치가 FAIL_TO_PASS 2개를 통과시키지만 의미가 틀린 overfit이 된다. 올바른 해는 "내부 mask를 엿보는 휴리스틱(`bool(select or annotation_select_mask or extra_select_mask)`)을 폐기하고, values 호출 여부를 명시 상태(`has_select_fields` 플래그)로 직접 모델링"하는 SemFix/Angelix류의 의미적 수정이다. 불변식을 바로잡는 것이라 S2가 본질, 그 실현이 작은 구조 교체라 S6 보조.

## 난이도 티어
**T4 (약간 어려움)**. 공식 라벨은 "15 min - 1 hour"(개발자 구현시간 기준, T2~T3 prior)지만 에이전트 난이도로는 한 단계 위로 재조정한다. 이유:
- **멀티파일 조율(L3)**: gold가 2파일이고 둘이 함께 안 가면 회귀한다. 1파일·<5줄(≈48% solve) 구간이 아니다.
- **regression trap이 강함**: PASS_TO_PASS 77개에 더해, hints에 실제 회귀 기록이 박혀 있다 — `query.py`만 고치면 `queries.tests.ToFieldTests.test_in_subquery`/`test_nested_in_subquery`가 깨진다. 이 trap이 부분픽스를 직접 처벌한다.
- **localize 직접성은 높음(↓완화)**: hints_text가 `RelatedIn.get_prep_lookup`, `Query.has_select_fields`, `set_annotation_mask`, 원인 커밋 `f4ac1671`까지 지목하고, 심지어 정답 diff 일부를 보여준다. has-repro도 있어 easiness 신호가 크다.
- **도메인 지식 병목(↑)**: 왜 `annotate+alias`에서만 mask가 차는지 이해하려면 ORM 내부지식이 필요.
종합하면 localize/repro가 T3로 끌어내리려 하지만, 멀티사이트 조율 + 부분픽스를 처벌하는 회귀 trap이 T5 쪽으로 끌어올려 **중간값 T4**가 방어 가능하다.

## 골드패치 분석
- **건드린 파일·함수**:
  - `django/db/models/sql/query.py` — `Query.has_select_fields`를 동적 `@property`(`bool(self.select or self.annotation_select_mask or self.extra_select_mask)`)에서 **클래스 속성 `has_select_fields = False`**로 교체. `Query.set_values()`가 끝에 `self.has_select_fields = True`를 명시 세팅.
  - `django/db/models/fields/related_lookups.py` — `RelatedIn.get_prep_lookup()`에서 RHS 축소를 `self.rhs.clear_select_clause()` + `self.rhs.add_fields([target_field], True)` 2단계에서 **`self.rhs.set_values([target_field])`** 단일 호출로 교체.
- **근본 원인**: `has_select_fields`가 내부 mask 상태를 엿봐서 "values() 호출 여부"를 추정했다. `QuerySet.alias`(커밋 `f4ac1671` 도입)는 `add_annotation`에서 `set_annotation_mask(set(self.annotation_select).difference({alias}))`를 호출해 `annotation_select_mask`를 materialize한다. 그래서 `annotate + alias` 조합에서는 `.values()`를 안 했는데도 mask가 차고, `has_select_fields`가 True로 오판되어 `RelatedIn`이 PK 단일 컬럼 축소를 건너뛴다 → 서브쿼리가 ~10컬럼을 반환.
- **수정 요지**: "values()가 실제로 호출됐는가"를 mask 엿보기 대신 **명시 플래그**로 직접 추적(클래스 기본 False, `set_values`가 True). 이 플래그는 shallow 속성이라 `Query.clone`에 자동으로 따라간다(hints의 별도 clone 처리 우려는 불필요로 판명). 동시에 `RelatedIn`의 RHS 축소를 `set_values` 경로로 통일해, RHS도 동일한 플래그를 세팅하고 `clear_select_clause`+`add_fields` 옛 경로가 만들던 불일치를 제거.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개)**:
  - `test_annotation_and_alias_filter_in_subquery` — `Publisher.objects.filter(num_awards__gt=4).annotate(publisher_annotate=Value(1)).alias(publisher_alias=Value(1))`를 `pk__in` 서브쿼리로 사용, `[p3, p4]` 기대.
  - `test_annotation_and_alias_filter_related_in_subquery` — `Book.objects.filter(pages__gt=400).annotate(book_annotate=Value(1)).alias(book_alias=Value(1))`를 `book__in` 서브쿼리로 사용, `[Apress, Sams, Prentice Hall, Morgan Kaufmann]` 4개 name 기대.
- **픽스 증명 방식**: 패치 전에는 RHS 서브쿼리가 모든 select 컬럼(annotate 포함)을 내보내 `IN (subquery)`가 단일 컬럼만 기대하는데 다컬럼이 와서 `OperationalError`. 패치 후 `set_values([target_field])`가 RHS를 PK 단일 컬럼으로 강제 → 서브쿼리 1컬럼 반환 → 비교 정상 → 기대 row 집합 일치. 두 테스트가 `annotate+alias` 조합을 `pk__in`과 reverse-relation `book__in` 두 경로로 검증.
- **overfit 관점**: FAIL_TO_PASS가 2개로 다소 얇다. `annotate+alias`만 특수가드하는 special-case 패치도 이 둘을 통과시킬 수 있어 **overfit 여지 존재**. 다만 골드처럼 플래그를 명시 모델링하면 그 조합을 넘어 일반화된다.
- **regression 관점**: 광범위한 PASS_TO_PASS(77개; AliasTests/NonAggregateAnnotationTestCase 전반)와, 힌트에 박힌 `ToFieldTests.test_in_subquery`/`test_nested_in_subquery` 회귀가 부분픽스를 직접 처벌한다. `related_lookups.py` 동반 수정이 없으면 이 P2P들이 깨진다 — regression-trap 플래그의 근거.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 `__in` + `.annotate().alias()` 조합과 "10 columns - expected 1" 에러에서 출발. `__in` 우변 QuerySet의 컬럼 축소 책임은 `fields/related_lookups.py`의 `RelatedIn.get_prep_lookup`에 있고, 분기 조건이 `has_select_fields`이므로 그 정의(`sql/query.py`의 `Query.has_select_fields` property)까지 따라간다. hints가 원인 커밋 `f4ac1671`과 `set_annotation_mask` 라인까지 지목해 주므로 추적이 단축된다.
2. **픽스와 왜 올바른 일반화인가**: `has_select_fields`를 `bool(select or annotation_select_mask or extra_select_mask)` 휴리스틱에서 **기본 False 클래스 속성 + `set_values`가 True 세팅**으로 바꾼다. 이는 "내부 mask가 차 있다"는 간접 신호 대신 "사용자가 실제로 values/IN 축소를 요청했다"는 의도를 직접 모델링하므로, `annotate+alias`뿐 아니라 mask를 materialize하는 모든 미래 조합에 견고하다. `RelatedIn`도 `set_values([target_field])`로 통일해 RHS 축소가 같은 플래그 경로를 거치게 한다. 특정 조합만 가드하는 패치와 달리 근본 불변식을 바로잡는 일반화다.
3. **regression 안전**: AliasTests/NonAggregateAnnotationTestCase 77개(특히 `test_values_alias`, `test_alias_after_annotation`, `test_annotation_filter_with_subquery`)와 `queries.tests.ToFieldTests`의 IN-subquery 테스트가 안 깨져야 한다. 플래그가 shallow 속성이라 `Query.clone`에 자동 carry되므로 clone 별도 처리 불필요(hints의 함정 회피). `RelatedIn`을 `set_values`로 옮기는 동반 수정이 빠지면 `test_in_subquery`/`test_nested_in_subquery`가 회귀하므로 두 파일을 함께 커밋.
4. **함정 회피**: (a) 단일파일 픽스 유혹 — `query.py`만 고치고 끝내면 회귀. 반드시 `related_lookups.py`도 함께. (b) special-case 가드 유혹 — `if has annotation and alias` 류로 그 조합만 우회하면 FAIL_TO_PASS는 통과해도 overfit이고 다른 IN-subquery 의미가 틀어진다. (c) clone 과잉수정 — hints에서 한 컨트리뷰터가 `Query.clone`에 플래그 복사를 시도하다 막혔는데, 실제로는 shallow 속성이라 불필요. 엿보기 휴리스틱을 명시 상태로 바꾸는 설계 교체가 정답이라는 통찰이 핵심.
