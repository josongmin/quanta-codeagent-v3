---
instance_id: django__django-11734
repo: django/django
base_commit: 999891bd80b3d02dd916731a7a239e1036174885
version: "3.0"
difficulty: 15 min - 1 hour
created_at: 2019-09-01T18:46:50Z
fail_to_pass: 1
pass_to_pass: 275
gold_files: [django/db/models/fields/__init__.py, django/db/models/fields/related_lookups.py, django/db/models/sql/query.py]
---

# django__django-11734

## 문제 요약
`exclude()` 또는 `~Q()` 안에서 `OuterRef('pk')`를 쓰면 서브쿼리가 깨진다. `filter(tags__category_id=OuterRef('pk'))`는 정상 동작하지만, 동일 lookup을 `exclude()`로 바꾸면 `ValueError: This queryset contains a reference to an outer query...`가 발생하거나(초기), 이후 패치로는 `OuterRef`가 바깥 쿼리(`queries_number`)가 아니라 split된 내부 alias(`V0`)로 잘못 resolve되어 `missing FROM-clause entry for table "V0"` 에러가 난다. 사용자는 exclude/부정 Q에서도 filter와 동일하게 바깥 쿼리를 참조하길 기대했다.

## 유형 분류
- 버그 카테고리: 누락처리 / edge-case (exclude의 split_exclude 경로에서 OuterRef를 다루지 않음)
- 서브시스템: django ORM query — exclude/negated-Q의 subquery 분리(split_exclude)와 related-field lookup 준비
- 증상 타입: 크래시 (ValueError / DB ProgrammingError로 SQL 생성 실패)
- 로컬라이제이션 신호: 증상이 `exclude()`/`~Q()` 한정이고 `filter()`는 정상 → 두 경로가 갈리는 지점인 `Query.split_exclude()`가 핵심 후보. hints의 SQL 덤프가 `OuterRef`가 `V0`로 잘못 매핑됨을 직접 가리킨다.

## 골드패치 분석
- 건드린 파일/함수:
  - `django/db/models/sql/query.py:Query.split_exclude` — exclude를 내부 NOT IN 서브쿼리로 분리할 때 RHS가 `OuterRef`인 경우를 처리.
  - `django/db/models/fields/related_lookups.py:RelatedLookupMixin.get_prep_lookup` — 직접값 판정 조건 변경.
  - `django/db/models/fields/__init__.py:AutoField.get_prep_value` — 불필요해진 OuterRef 특수처리 제거.
- 근본 원인: `split_exclude`는 부정 조건을 `pk__in=<inner subquery>` 형태로 재작성하는데, 기존 코드는 RHS가 `F`일 때만 `OuterRef`로 다시 감싸 바깥 쿼리 컨텍스트를 보존했다. RHS가 이미 `OuterRef`인 경우는 처리하지 않아, 새 inner `Query`로 분리될 때 `OuterRef`의 참조 대상이 한 단계 안쪽(`V0`)으로 밀려 잘못된 테이블을 가리켰다.
- 수정 요지:
  - `split_exclude`에서 `isinstance(filter_rhs, OuterRef)` 분기를 추가해 `OuterRef(filter_rhs)`로 다시 한 번 래핑 → 분리된 inner query 기준으로 다시 한 단계 바깥(원래 outer)을 참조하도록 relabel.
  - `RelatedLookupMixin.get_prep_lookup`의 가드를 `self.rhs_is_direct_value()`에서 `not hasattr(self.rhs, 'resolve_expression')`로 바꿔, `OuterRef` 같은 resolvable 표현식을 직접값으로 오인해 `get_normalized_value`/`get_prep_value`를 돌려버리는 일을 방지.
  - 위 변경으로 `AutoField.get_prep_value`의 임시 `OuterRef` 우회 코드가 불필요해져 삭제.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_subquery_exclude_outerref (queries.tests.ExcludeTests)`
- 테스트가 어떻게 픽스를 증명하는지:
  - `JobResponsibilities.objects.filter(Exists(Responsibility.objects.exclude(jobs=OuterRef('job'))))` 형태로 exclude+OuterRef 서브쿼리를 구성. 패치 전에는 SQL 생성/실행 단계에서 크래시.
  - 재현 입력→기대 출력: 초기 상태에서 `qs.exists()`가 `True`(매칭되는 row 존재)여야 하고, `self.r1.delete()`로 데이터를 지운 뒤에는 `qs.exists()`가 `False`로 바뀌어야 한다. 즉 단순히 크래시가 안 나는 것을 넘어 `OuterRef`가 올바른 바깥 row를 참조해 결과가 데이터 변화에 따라 정확히 토글되는지 확인한다.
  - setUpTestData에서 `r1`을 `cls.r1`로 승격시켜 테스트 내부에서 삭제 가능하게 한 것이 보조 변경.

## 공략 포인트 (뭘 조져야)
- localization 전략: filter는 OK인데 exclude/~Q만 깨지는 비대칭이 결정적 단서. `exclude`가 내부적으로 negated-Q → subquery로 분리되는 `Query.split_exclude`를 먼저 읽고, 기존 `F` 처리 분기 바로 옆에 `OuterRef` 케이스가 빠졌음을 확인하는 게 정공법.
- 함정/난이도 메모:
  - 3개 파일을 동시에 손대지만 핵심은 `split_exclude` 한 줄. 나머지 둘(related_lookups 가드, AutoField 우회 제거)은 OuterRef를 "직접값"으로 오인하던 우회 코드를 정리하는 동반 변경이라, 핵심만 고치면 다른 경로에서 다시 막힐 수 있다.
  - `OuterRef(filter_rhs)`를 OuterRef로 한 번 더 감싸는 게 직관에 반함(이미 OuterRef인데 또 감쌈) — relabel/depth 한 단계 보정이라는 의미를 이해해야 함.
  - `rhs_is_direct_value()` vs `hasattr(rhs, 'resolve_expression')`의 의미 차이를 놓치면 related lookup 쪽에서 OuterRef가 다시 정규화되어 버린다.
- 우리 에이전트 관점: filter/exclude의 SQL이 어떻게 분기되는지 모르면 표면 증상(ValueError 메시지)만 보고 OuterRef 클래스나 resolve_expression 쪽을 헤맬 수 있다. hints의 SQL 덤프(`V0` 오매핑)를 신호로 잡아 `split_exclude`까지 좁히는 게 관건이고, 핵심 1줄을 고친 뒤 동반 가드 2건을 빠뜨리면 PASS_TO_PASS의 다른 exclude/related-lookup 테스트가 회귀할 위험이 있다.
