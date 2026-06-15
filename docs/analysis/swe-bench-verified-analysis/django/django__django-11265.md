---
instance_id: django__django-11265
repo: django/django
base_commit: 21aa2a5e785eef1f47beb1c3760fdd7d8915ae09
version: 3.0
difficulty: 15 min - 1 hour
created_at: 2019-04-21T12:57:28Z
fail_to_pass: 1
pass_to_pass: 30
gold_files: [django/db/models/sql/query.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L1
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [overfit-risk, regression-trap, has-repro]
---

# django__django-11265

## 문제 요약
`annotate()`로 만든 `FilteredRelation` alias(예: `book_alice`)를 `exclude()`에서 참조하면 `FieldError: Cannot resolve keyword 'book_alice' into field`가 발생한다. 동일한 alias가 `filter()`로는 정상 동작하지만 `exclude()`만 깨진다. 사용자는 `exclude(book_alice__isnull=False)`가 alias를 인식하고 "조건을 만족하는 책이 없는 author"(`self.author2`)를 돌려주길 기대했다. 더 나아가 hints_text에서 드러나듯, 단순히 예외만 막으면 생성 SQL에서 FilteredRelation의 INNER JOIN 조건이 통째로 사라져 **silent-wrong** 결과를 낳는 2차 결함이 숨어 있다.

## 유형 (정형화)

**L (Localization) = L1 (Traceable).** problem_statement가 네이티브 traceback을 그대로 첨부해 `split_exclude(self, filter_expr, can_reuse, names_with_path)` → `query.add_filter(filter_expr)` → `names_to_path`에서 `FieldError`가 터지는 경로를 줄단위로 지목한다. 마지막 줄에서 제보자가 "split_exclude ... A new query is created without all extra datas from the original query"라며 원인 함수까지 짚어준다. 다만 2차 결함의 수정 지점(`trim_start`)은 traceback에 없어 grep 한 방(L0)은 아니다 — 같은 파일 내 인접 함수로의 약한 추가 탐색이 필요하다.

**S (Repair Strategy) = S2 Constraint-Reasoning (+S5 Spec-Inference).** 1차 픽스(`split_exclude`에 `query._filtered_relations = self._filtered_relations` 한 줄 추가)는 거의 S1에 가까운 상태-전파 누락 복구다. 그러나 hints_text 대화가 명시적으로 보여주듯, 그 한 줄만으로는 alias는 인식되지만 생성 SQL의 INNER JOIN이 trim되어 `WHERE NOT (id IN (SELECT ... WHERE NULL))` 형태의 **조건 누락 SQL**이 나온다. 핵심 난점은 `trim_start`에서 "어떤 join은 트리밍해도 되고 어떤 join은 안 되는가"라는 불변식을 SQL 의미론으로 추론 합성하는 데 있다 — FilteredRelation에서 온 INNER JOIN을 트리밍하면 그 부착 조건(`title LIKE ...`)이 소실되므로 LOUTER와 동일하게 트리밍을 금지해야 한다. 이건 후보를 던져보며 맞추는 G&V가 아니라(S3 아님), join_type·filtered_relation 속성을 따져 올바른 가드 조건을 "생각으로" 만드는 S2다. 의도된 SQL semantics를 이슈 대화/ORM 관례에서 재구성해야 하는 점에서 S5가 보조로 붙는다.

**K (Knowledge) = K-Domain.** django ORM query compiler 내부 지식이 병목이다. `_filtered_relations` 딕셔너리의 역할, `split_exclude`가 IN-subquery pushdown으로 negation을 구현한다는 사실, `trim_start`의 leading-join 트리밍이 LOUTER에서 금지되는 이유(outer-side null 행 누락), `alias_map[...].join_type`/`.filtered_relation` 메타데이터의 의미를 알아야 픽스가 올바른지 판단할 수 있다. 일반 파이썬 추론(K-Gen)으로는 닿지 않는다.

**Primary type = T-DomainBound.** 위치는 traceback 덕에 비교적 잡히지만(L1), 진짜 병목은 ORM compiler의 subquery/join-trim 내부 동작에 대한 도메인 지식이다. 1차 한 줄은 쉬워 보여도 K-Domain 없이는 2차 silent-wrong을 인지·수정할 수 없어, dominant 축은 knowledge다.

## 난이도 티어
**Tier = T4 (약간 어려움).** 공식 difficulty 라벨은 "15 min - 1 hour"(개발자 구현시간)이며, 이는 T3~T4 경계의 prior다. 구조적 피처로 재조정하면 T4로 민다:

- **파일 1개·줄수 소규모(+2/-3 헌크 2개)**: scope 자체는 작아 T5/T6은 아니다.
- **L1 localize**: has-repro(네이티브 traceback)가 1차 지점을 직접 줘서 아래쪽으로 압력. 단독이면 T2~T3.
- **K-Domain + S2 추론**: ORM join-trim 불변식 추론이 T4 쪽으로 끌어올림.
- **두 헌크 강제 P2P**: FAIL_TO_PASS인 `test_with_exclude`(`isnull=False`)는 **두 헌크를 모두 강제한다** — `_filtered_relations` 전파 한 줄만 적용하면 PASS가 아니라 FAIL한다(실측: `AssertionError: <QuerySet []> != [<Author: Jane>]`). 가드 없이 FilteredRelation의 INNER JOIN(`title LIKE 'poem by alice'`)이 trim되면 서브쿼리가 `SELECT author_id FROM book WHERE id IS NOT NULL`(=책 가진 모든 author)이 되어 exclude가 Alice·Jane 둘 다 제외 → `[]`. 따라서 이 단일 테스트로도 join-trim 결함이 직접 노출되며, `trim_start` 보강이 FAIL_TO_PASS 통과의 필수 전제다. K-Domain + S2 추론(두 단계가 같은 negation-subquery 파이프라인임을 이해해야 함)이 T4 쪽으로 끌어올리는 요인이다.

공식 라벨(시간)이 잡지 못하는 도메인 추론 비용 때문에 시간 prior보다 한 단계 높게 본다.

## 골드패치 분석
- **건드린 파일·함수**: `django/db/models/sql/query.py` 내 `Query.split_exclude`, `Query.trim_start` (단일 파일, 2 헌크).
- **근본 원인**:
  1. `split_exclude`는 negated lookup을 `id IN (subquery)`로 변환하려고 새 `query = Query(self.model)`를 만든다. 이때 원본 쿼리의 `self._filtered_relations`(alias→FilteredRelation 매핑)를 복사하지 않아, 서브쿼리가 `book_alice` alias를 모른 채 `query.add_filter(filter_expr)` → `names_to_path`에서 alias 해석 실패 → `FieldError`.
  2. alias를 전파해 예외가 사라져도, `trim_start`가 inner 쿼리의 leading join을 트리밍할 때 FilteredRelation에서 온 INNER JOIN을 제거하면 그 부착 조건(`title LIKE 'poem by alice'`)이 통째로 소실된다. 기존 가드는 `join_type != LOUTER`만 검사해 INNER JOIN(=filtered relation)을 무조건 트리밍 → 조건 없는 잘못된 서브쿼리.
- **수정 요지**:
  1. `split_exclude`에서 `query = Query(self.model)` 직후 `query._filtered_relations = self._filtered_relations` 한 줄 추가 → alias 메타데이터를 서브쿼리로 전파(`FieldError` 제거).
  2. `trim_start`의 가드를 `first_join = self.alias_map[lookup_tables[trimmed_paths + 1]]`로 캡처한 뒤 `if first_join.join_type != LOUTER and not first_join.filtered_relation:`로 강화. LEFT JOIN뿐 아니라 filtered relation에서 온 INNER JOIN도 트리밍 금지해 필터 조건을 보존.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_with_exclude (filtered_relation.tests.FilteredRelationTests)`.
- **동작**: `Author.objects.annotate(book_alice=FilteredRelation('book', condition=Q(book__title__iexact='poem by alice'))).exclude(book_alice__isnull=False)`를 실행하고 결과가 `[self.author2]`(Poem by Alice 책이 없는 author)인지 단언한다.
- **픽스 증명**: 패치 전에는 alias 해석 단계에서 `FieldError`로 즉시 예외. 패치 후 (1) `_filtered_relations` 전파로 서브쿼리가 `book_alice`를 인식하고, (2) `trim_start` 보강으로 INNER JOIN 조건이 보존되어 `id IN (SELECT author_id FROM book WHERE title LIKE 'poem by alice')`의 negation이 올바르게 만들어진다 → author2만 반환.
- **overfit 관점**: 이 오라클은 **약하지 않다 — 두 헌크를 모두 강제한다**. `isnull=False` 케이스도 두 픽스를 명백히 구별한다: 1차 한 줄(`_filtered_relations` 전파)만 적용하면 PASS가 아니라 FAIL한다(실측: `<QuerySet []> != [<Author: Jane>]`). `trim_start` 가드가 없으면 FilteredRelation의 INNER JOIN(`title LIKE 'poem by alice'` 조건)이 trim되어 서브쿼리가 `SELECT author_id FROM book WHERE id IS NOT NULL`(=책 가진 모든 author)이 되고, exclude가 Alice와 Jane 둘 다 제외 → `[]`. 즉 `trim_start` 보강 없이는 이 단일 테스트가 곧바로 join-trim 결함을 드러낸다. overfit-risk 플래그의 실제 근거는 따로 있다: hints_text가 끝내 요청한 "잘못된 결과를 드러내는 추가 테스트"(예: `exclude(book_alice__title__contains='Jane')`)가 머지된 test_patch에 포함되지 않았다는 점이다. 다만 "한 줄만으로 그린"이라는 인과는 측정으로 반증되므로, 골드패치의 두 헌크는 모두 이 테스트로 직접 강제된다.
- **regression 관점**: PASS_TO_PASS 30개가 전부 `filtered_relation.tests` 모듈(`test_with_join`, `test_with_m2m*`, `test_exclude_relation_with_join`, `test_as_subquery`, `test_select_related*`, `test_union/intersection/difference` 등)이다. `trim_start` 가드 변경은 leading-join 트리밍 최적화에 직접 영향을 줘, filtered relation이 아닌 일반 join 경로(`test_with_join`, `test_exclude_relation_with_join`)나 subquery 경로(`test_as_subquery`)를 깨면 즉시 잡힌다 → regression-trap. `not first_join.filtered_relation` 조건이 비-filtered 경로에서 항상 True이므로 기존 동작을 보존한다는 점이 안전성의 핵심.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈의 네이티브 traceback이 `split_exclude` → `query.add_filter(filter_expr)` → `names_to_path`에서 `FieldError: Cannot resolve keyword 'book_alice'`를 줄단위로 지목한다. 제보자가 직접 "A new query is created without all extra datas from the original query"라 적시했으므로 `django/db/models/sql/query.py:Query.split_exclude`의 `query = Query(self.model)` 라인에서 시작. 이 새 query가 원본의 어떤 상태(특히 `_filtered_relations`)를 복사 안 하는지 확인하면 1차 결함이 잡힌다.

2. **픽스와 왜 올바른 일반화인지**: 1차로 `query._filtered_relations = self._filtered_relations` 전파. 하지만 여기서 멈추면 안 된다 — hints_text 대화가 보여주듯 생성 SQL에서 INNER JOIN 조건이 사라진다. SQL semantics 추론: FilteredRelation은 조건을 INNER JOIN의 ON에 부착하는데, `trim_start`의 leading-join 트리밍은 그 join을 통째로 제거해 조건을 날린다. 따라서 가드를 `join_type != LOUTER`에서 `... and not first_join.filtered_relation`으로 확장하는 것이 올바른 일반화다. LOUTER 금지 이유(outer-side null 행 보존)와 filtered_relation 금지 이유(부착 조건 보존)는 둘 다 "트리밍하면 의미가 바뀌는 join"이라는 동일 원리의 두 인스턴스 — 특정 alias명에 하드코딩하지 않고 join 메타데이터로 판정하므로 모든 FilteredRelation에 일반화된다.

3. **regression 안전**: PASS_TO_PASS 30개가 `filtered_relation` 모듈 전체(일반 join/m2m/subquery/select_related/set-operations 포함)를 커버한다. `not first_join.filtered_relation` 가드는 filtered relation이 아닌 join에서 항상 True라 기존 트리밍 최적화를 그대로 유지 → `test_with_join`·`test_exclude_relation_with_join`·`test_as_subquery`가 안 깨짐. `_filtered_relations` 전파도 alias가 없는 쿼리에선 빈 딕셔너리라 무해. 이 두 불변(비-filtered 경로 byte-동일)을 지키는 게 안전성의 본질.

4. **함정 회피**: 오라클 없는 에이전트의 최대 함정은 **조기 종료**다. 단, 이 문제에서는 FAIL_TO_PASS `test_with_exclude(isnull=False)` 자체가 두 헌크를 모두 강제하므로(1차 한 줄만으로는 `<QuerySet []> != [<Author: Jane>]`로 FAIL) "예외 사라짐 = 해결"로 멈추면 테스트가 RED로 잡아준다 — 함정이 테스트 통과로 가려지지 않는다. 그러나 에이전트가 1차 한 줄만 적용하고 테스트를 돌리지 않거나(예외만 사라진 걸 보고 종료), 생성 SQL을 검사하지 않으면 여전히 silent-wrong을 놓친다. 회피법: (a) 픽스 후 반드시 `test_with_exclude`를 돌려 RED→GREEN을 확인하고, (b) 생성 SQL을 실제로 검사해 INNER JOIN과 그 조건이 보존되는지 확인하거나, (c) `split_exclude`/`trim_start`가 같은 negation-subquery 파이프라인의 두 단계임을 ORM 도메인 지식으로 이해해 두 곳을 함께 보는 것. (overfit-risk 자체의 근거는 hints_text가 요청한 `title__contains='Jane'` 구별 테스트가 머지본에 빠진 점이지, 주어진 테스트가 약하다는 게 아니다.)
