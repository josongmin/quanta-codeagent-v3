---
instance_id: django__django-11885
repo: django/django
base_commit: 04ac9b45a34440fa447feb6ae934687aacbfc5f4
version: 3.1
difficulty: 1-4 hours
created_at: 2019-10-08T15:22:07Z
fail_to_pass: 1
pass_to_pass: 43
gold_files: [django/contrib/admin/utils.py, django/db/models/deletion.py]
---

# django__django-11885

## 문제 요약
`on_delete=models.CASCADE`를 흉내내는 `deletion.Collector`가 fast-delete 경로(`DELETE FROM table WHERE fk_id IN ...`)를 탈 때, 같은 테이블을 여러 FK로 가리키는 관계들을 각각 별도 쿼리로 실행한다. 예를 들어 `Entry`가 `created_by`/`updated_by` 두 FK로 `User`를 참조하면 `user.delete()` 시 `entry`에 대해 2개의 DELETE가 나간다. 사용자는 이런 경우 같은 테이블에 대한 쿼리를 `OR`로 묶어 DB 왕복 횟수를 줄이기를 기대한다.

## 유형 분류
- 버그 카테고리: 성능 최적화(누락처리) — 동작은 맞지만 쿼리가 과다
- 서브시스템: django ORM cascade deletion (`django.db.models.deletion`)
- 증상 타입: 성능(불필요한 추가 쿼리 / DB 왕복 N배)
- 로컬라이제이션 신호: "deletion.Collector", "fast queries", "combine such queries by table", "single one by using OR" → `db/models/deletion.py`의 Collector fast-delete 수집 루프가 정확한 타깃

## 골드패치 분석
- 건드린 파일/함수:
  - `django/db/models/deletion.py:Collector.collect` / `Collector.related_objects` / `Collector.get_del_batches` / `Collector.can_fast_delete` / `Collector.__init__`
  - `django/contrib/admin/utils.py:NestedObjects.related_objects` (시그니처 변경 동반 수정)
- 근본 원인: `related_objects(related, objs)`와 fast-delete 수집이 단일 `related`(=단일 필드) 단위로만 동작해서, 동일 모델을 가리키는 여러 FK가 각각 독립 쿼리를 생성했다.
- 수정 요지:
  1. `related_objects` 시그니처를 `(related_model, related_fields, objs)`로 바꿔 여러 필드를 받고, `reduce(operator.or_, Q(**{'%s__in'%f.name: objs}) ...)`로 필드들을 `OR`로 묶은 단일 predicate를 `filter`에 넘긴다.
  2. `collect`에서 fast-delete 가능한 관계를 즉시 실행하지 않고 `model_fast_deletes = defaultdict(list)`에 `related_model`별로 필드를 누적한 뒤, 모델 단위로 한 번에 `related_objects(..., related_fields, batch)`를 호출해 `fast_deletes`에 추가한다.
  3. `get_del_batches(objs, field)` → `(objs, fields)`로 복수 필드를 받아 `bulk_batch_size`에 필드명 리스트를 넘긴다.
  4. `can_fast_delete`를 `related_model`(타입) 기준으로 호출하도록 정리하고, `__init__`의 `data`/`field_updates`/`dependencies`를 `defaultdict`로 바꿔 `setdefault` 보일러플레이트를 제거.
  5. `admin/utils.py`의 오버라이드도 새 시그니처에 맞춰 `select_related(*[f.name for f in related_fields])`로 갱신.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_fast_delete_combined_relationships` — `Origin`/`Referrer`(+`SecondReferrer`가 `referrer_id`와 `unique_field` 두 경로로 참조) 모델에서 `referer.delete()`를 호출.
- 증명 방식: `with self.assertNumQueries(2)`로 쿼리 수를 단정. 패치 전이면 동일 테이블에 대한 fast-delete가 필드별로 쪼개져 쿼리 수가 더 나오지만, 패치 후엔 `referrer_id OR unique_field`로 결합되어 cascade fast-delete 1 + 본체 delete 1 = 정확히 2 쿼리. PASS_TO_PASS 43건(기존 fast_delete_fk/m2m/inheritance, OnDeleteTests 등)은 결합 변경이 기존 cascade 시맨틱을 깨지 않음을 보장.

## 공략 포인트 (뭘 조져야)
- 시작점: `django/db/models/deletion.py`의 `Collector.collect` 안 `get_candidate_relations_to_delete` 루프와 `related_objects`. "OR로 결합"이라는 명시 단서가 곧장 여기를 가리킨다.
- 함정/난이도:
  - 멀티파일: `related_objects` 시그니처를 바꾸면 이를 오버라이드하는 `contrib/admin/utils.py:NestedObjects.related_objects`도 같이 고쳐야 한다. 이걸 놓치면 admin 삭제 경로가 깨진다(PASS_TO_PASS엔 안 잡혀도 회귀 위험).
  - 핵심 로직: fast-delete 가능 여부 판정을 즉시 실행에서 "모델별 필드 수집 후 일괄 실행"으로 재구조화해야 결합이 성립. `can_fast_delete`를 인스턴스 대신 `related_model` 타입으로 호출하도록 바꾸는 미묘한 변경 포함.
  - `get_del_batches`의 단일 field → fields 확장, `bulk_batch_size`가 필드명 리스트를 받는 점.
- 우리 에이전트 관점: 동작이 이미 "정상"이라 테스트가 `assertNumQueries`로만 실패를 드러낸다. 에이전트가 예외/오답이 아니라 쿼리 카운트 회귀를 목표로 인식하고, 단일 함수 패치가 아니라 collect 루프 전체 + 오버라이드 동반 수정이라는 멀티포인트 리팩터링임을 잡아내는 게 관건. `defaultdict` 전환은 본질이 아니므로(선택적 정리) 거기에 매몰되지 않아야 한다.
