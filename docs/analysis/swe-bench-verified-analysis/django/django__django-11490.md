---
instance_id: django__django-11490
repo: django/django
base_commit: a7038adbd02c916315b16939b835f021c2ee8880
version: 3.0
difficulty: <15 min fix
created_at: 2019-06-19T07:47:46Z
fail_to_pass: 1
pass_to_pass: 23
gold_files: [django/db/models/sql/compiler.py]
---

# django__django-11490

## 문제 요약
`union()` 등으로 합성한 QuerySet에서 `values()`/`values_list()`로 컬럼 목록을 지정해 여러 번 평가하면, 두 번째 이후의 컬럼 목록 변경이 반영되지 않는다. 예를 들어 `qs1.union(qs1).values_list('name', 'order')`를 먼저 평가한 뒤 같은 합성 쿼리에서 `values_list('order')`를 평가해도 여전히 `('a', 2)`가 나온다. 사용자는 매 평가마다 지정한 컬럼만(`(2,)`) 나오기를 기대한다.

## 유형 분류
- 버그 카테고리: logic / state-mutation (캐시된 객체 in-place 변경)
- 서브시스템: django ORM query / SQL compiler (combinator/union 처리)
- 증상 타입: silent-wrong (잘못된 컬럼 목록으로 결과 반환, 예외 없음)
- 로컬라이제이션 신호: problem_statement가 직접 `compiler.py#L428-L433`를 지목하고 있고, 증상이 combined(`union`) 쿼리에서만 발생하므로 `get_combinator_sql`로 곧장 좁혀진다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/sql/compiler.py` : `SQLCompiler.get_combinator_sql`
- 근본 원인: combined query의 각 하위 컴파일러가 공유하는 `compiler.query` 객체에 대해 `set_values(...)`를 직접 호출(in-place mutation)했다. 합성 쿼리의 하위 쿼리(`compiler.query`)는 캐시/재사용되므로, 첫 평가에서 set_values로 박힌 컬럼 목록이 그대로 남아 다음 평가의 새 컬럼 목록이 무시된다.
- 수정 요지: `set_values`를 호출하기 직전에 `compiler.query = compiler.query.clone()`을 추가해, 원본 하위 쿼리를 건드리지 않고 복제본에만 `set_values`를 적용한다. 이로써 각 평가가 독립적인 컬럼 선택을 갖게 되어, 재평가 시 새로운 values_list 컬럼 목록이 올바르게 반영된다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_union_with_values (queries.test_qs_combinators.QuerySetSetOperationTests)`
- 테스트가 증명하는 방식: 동일한 합성 쿼리 `qs1.union(qs1)`를 여러 번 평가한다. 기존 단언들(`values('name','order')`, `values_list('name','order','id')`) 뒤에 새 단언 `qs1.union(qs1).values_list('order').get() == (2,)`를 추가한다. 패치 전에는 캐시된 하위 쿼리에 이전 컬럼 목록이 남아 `('a', 2)`(또는 잘못된 형태)가 반환되어 실패하고, clone 추가 후에는 `('order')`만 선택되어 `(2,)`가 나오며 통과한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement에 명시된 라인 포인터를 신뢰해 `get_combinator_sql` 내부 `if not compiler.query.values_select and self.query.values_select:` 블록의 `set_values` 호출부로 바로 진입한다.
- 함정/난이도 메모: 단일 파일·단일 라인 추가지만, "왜 in-place mutation이 문제인가"를 이해해야 한다. 하위 쿼리 객체가 평가 간 재사용/캐시된다는 점을 모르면 set_values 자체나 values_select 비교 조건을 잘못 손대기 쉽다. 인접 코드의 `extra_select`/`values_select` 스프레드는 건드릴 필요 없다.
- 우리 에이전트 관점: 증상 재현은 쉽지만 근본 원인이 "객체 공유로 인한 상태 오염"이라 자칫 조건문 분기나 캐시 무효화 같은 과한 수정으로 흐를 수 있다. 정답은 mutation 직전 `clone()` 한 줄이라는 minimal-fix를 분별하는 것이 핵심.
