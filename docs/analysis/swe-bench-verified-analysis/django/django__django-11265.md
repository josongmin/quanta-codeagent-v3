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
---

# django__django-11265

## 문제 요약
`annotate()`로 만든 `FilteredRelation` alias를 `exclude()`에서 참조하면 `FieldError: Cannot resolve keyword 'book_alice' into field`가 발생한다. `filter()`로는 정상 동작하지만 `exclude()`만 깨진다. 사용자는 `filter`와 마찬가지로 `exclude(book_alice__isnull=False)`가 alias를 인식하고 올바른 결과(필터 조건을 만족하지 않는 author)를 돌려주길 기대했다.

## 유형 분류
- 버그 카테고리: 누락처리 (subquery 생성 시 상태 전파 누락) / API-contract (filter는 되는데 exclude는 안 됨)
- 서브시스템: django ORM query compiler (`django.db.models.sql.query`)
- 증상 타입: 예외 (`FieldError`) + 잠재적 silent-wrong (조건이 누락된 SQL 생성)
- 로컬라이제이션 신호: traceback이 명확하게 `split_exclude(...)` → `query.add_filter(filter_expr)`를 지목하고, problem_statement 마지막 줄에서 "split_exclude ... A new query is created without all extra datas from the original query"라고 원인까지 짚어준다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/sql/query.py:Query.split_exclude`, `django/db/models/sql/query.py:Query.trim_start`
- 근본 원인: `exclude()`는 내부적으로 `split_exclude`에서 새 `Query(self.model)`(서브쿼리)를 만든다. 이때 원본 쿼리의 `_filtered_relations` 딕셔너리를 복사하지 않아, 새 쿼리가 `book_alice` alias를 모른 채 `add_filter`를 호출 → alias 해석 실패로 `FieldError`. 또한 `trim_start`는 inner 쿼리의 첫 join을 트리밍하는데, FilteredRelation의 INNER JOIN을 트리밍하면 그 조건(`title LIKE ...`)이 통째로 사라져 잘못된 SQL이 나온다.
- 수정 요지:
  1. `split_exclude`에서 새 query 생성 직후 `query._filtered_relations = self._filtered_relations`를 추가해 alias 메타데이터를 서브쿼리로 전파.
  2. `trim_start`의 첫 join 트리밍 조건을 `join_type != LOUTER`에서 `first_join.join_type != LOUTER and not first_join.filtered_relation`으로 강화. LEFT JOIN뿐 아니라 filtered relation에서 온 INNER JOIN도 트리밍 금지해 필터 조건이 보존되도록 함.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_with_exclude (filtered_relation.tests.FilteredRelationTests)`
- 테스트가 증명하는 방식: `Author.objects.annotate(book_alice=FilteredRelation('book', condition=Q(book__title__iexact='poem by alice'))).exclude(book_alice__isnull=False)`를 실행한다. 재현 입력은 `exclude` + isnull 조합이고, 기대 출력은 `[self.author2]`(Poem by Alice 책이 없는 author). 패치 전에는 alias 해석에서 예외가 났고, 패치 후에는 `_filtered_relations` 전파로 서브쿼리가 alias를 인식하고 join 조건이 보존되어 정확히 author2만 반환된다.

## 공략 포인트 (뭘 조져야)
- localization 전략: traceback이 `split_exclude`를 직접 지목하므로 거기서 시작. `split_exclude` 안의 `query = Query(self.model)` 라인이 원본 쿼리 상태를 어디까지 복사하는지 확인 → `_filtered_relations` 누락이 1차 픽스.
- 함정/난이도 메모: alias 전파만 하면 `FieldError`는 사라지지만 hints_text가 보여주듯 생성 SQL에서 join 조건이 사라지는 2차 silent-wrong 버그가 남는다. 이 두 번째 결함은 `trim_start`의 leading-join 트리밍 로직까지 봐야 잡힌다. 멀티-함수(같은 파일 2곳) 수정이라 첫 픽스에서 멈추면 테스트는 통과해도 인접 결함을 놓칠 수 있다.
- 우리 에이전트 관점: `_filtered_relations` 추가만으로 FAIL_TO_PASS가 통과해버려, `trim_start` 보강을 빠뜨릴 위험이 크다. test_with_exclude는 `isnull=False` 단순 케이스라 join-trim 결함을 직접 드러내지 않으므로(예외만 막아도 통과), 에이전트가 "끝났다"고 조기 판단하기 쉬운 함정. 두 join_type 비교 라인의 의미(LOUTER vs filtered_relation INNER)를 이해하는 ORM compiler 지식이 관건.
