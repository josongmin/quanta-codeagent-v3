---
instance_id: django__django-15732
repo: django/django
base_commit: ce69e34bd646558bb44ea92cecfd98b345a0b3e0
version: 4.2
difficulty: 15 min - 1 hour
created_at: 2022-05-24T12:58:31Z
fail_to_pass: 1
pass_to_pass: 125
gold_files: [django/db/backends/base/schema.py]
---

# django__django-15732

## 문제 요약
단일 필드에 `unique_together = (('id',),)`처럼 이미 `unique=True`(또는 primary key)인 컬럼과 겹치는 unique_together 제약이 걸려 있으면, 이를 제거하는 마이그레이션이 실패한다. `alter_unique_together`가 해당 컬럼의 unique 제약을 찾을 때 정확히 1개만 있을 거라 가정하는데, PK 제약과 unique_together 제약 2개가 잡혀서 `ValueError: Found wrong number (2) of constraints for foo_bar(id)`로 크래시한다. 사용자는 잘못 들어간 unique_together 제약을 드롭하는 마이그레이션이 정상 동작하길 기대했다.

## 유형 분류
- 버그 카테고리: edge-case / 누락처리 (단일 필드 unique_together가 다른 unique 제약과 충돌하는 케이스 미처리)
- 서브시스템: django migrations / DB backend schema editor (DDL 생성)
- 증상 타입: 예외 (ValueError 크래시로 마이그레이션 중단)
- 로컬라이제이션 신호: hints/traceback이 `db/backends/schema.py`의 `alter_unique_together`와 "Found wrong number of constraints" 메시지를 직접 지목. unique_together 제약 이름 규칙(`<table>_<field>_<hash>_uniq`)이 unique=True(`<table>_<field>_key`)와 다르다는 힌트가 핵심 단서.

## 골드패치 분석
- 건드린 파일/함수:
  - `django/db/backends/base/schema.py:alter_unique_together` — 삭제 분기의 `_delete_composed_index` 호출 인자
  - `django/db/backends/base/schema.py:_delete_composed_index` — 후보 제약 필터링 로직 추가
  - `django/db/backends/base/schema.py:_create_unique_sql` / 신규 `_unique_constraint_name` — 이름 생성 헬퍼 추출
- 근본 원인: 단일 필드 unique_together 제약은 같은 컬럼의 `unique=True`/PK 제약과 DB상에서 컬럼 집합으로는 구분되지 않는다. 그래서 `_constraint_names(... unique=True)`가 2개를 반환하고 `len(constraint_names) != 1` 가드에서 예외가 난다.
- 수정 요지:
  1. `_create_unique_sql`에 박혀 있던 `create_unique_name` 클로저를 `_unique_constraint_name(table, columns, quote)` 메서드로 추출해 unique_together 기본 이름을 재사용 가능하게 만듦.
  2. `_delete_composed_index`에서 `unique=True`이고 후보가 여러 개이며 백엔드가 `allows_multiple_constraints_on_same_fields`를 지원하면, Django가 unique_together에 기본으로 부여하는 이름(`_unique_constraint_name(...)`)과 일치하는 제약만 골라 `constraint_names`를 그 하나로 좁힘.
  3. `alter_unique_together`의 삭제 호출에 `{"unique": True, "primary_key": False}`를 넘겨 PK 제약을 후보에서 애초에 배제.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_remove_unique_together_on_unique_field` — `name`에 `unique=True`가 있고 동시에 `unique_together={("name",)}`인 Pony 모델을 만든 뒤 `AlterUniqueTogether("Pony", set())`로 제약을 비운다.
- 증명 방식: 적용 후 `<table>_name_key`(unique=True 제약)는 여전히 존재해야 하고(`assertConstraintExists`), `<table>_name_694f3b9f_uniq`(unique_together 제약)는 사라져야 한다(`assertConstraintNotExists`). 즉 두 제약 중 unique_together 것만 정확히 골라 드롭됐음을 확인. PK 케이스인 `test_remove_unique_together_on_pk_field`도 같은 방식으로 PASS_TO_PASS에 포함되며 `allows_multiple_constraints_on_same_fields` 지원 백엔드(PostgreSQL)에서만 돈다.

## 공략 포인트 (뭘 조져야)
- localization 전략: traceback의 "Found wrong number ... constraints" 문자열을 grep하면 `_delete_composed_index`의 `len(constraint_names) != 1` 가드로 바로 도달. 거기서 호출 체인을 위로(`alter_unique_together`) 추적.
- 함정/난이도 메모: 단순히 "2개 중 아무거나 드롭"하면 unique=True/PK 제약을 잘못 지운다. 정답은 unique_together의 **기본 이름 규칙**을 재구성해 일치하는 것만 좁히는 것. 그래서 이름 생성 로직(`IndexName`/`_create_index_name`/`quote` 분기)을 헬퍼로 빼서 동일 규칙을 재사용해야 한다. 또 `allows_multiple_constraints_on_same_fields` feature flag로 게이팅해 SQLite 등 다중 제약 미지원 백엔드의 회귀를 막아야 함.
- 우리 에이전트 관점: 막힐 지점은 (1) "후보가 2개면 어느 걸 지울지"를 휴리스틱(이름 LIKE 패턴 등)으로 처리하려는 유혹 — 골드는 Django 내부 이름 규칙 재사용이라는 정확한 기준을 씀. (2) `_create_unique_sql` 안 클로저를 메서드로 추출(리팩터)해야 quote=False로 raw 이름을 만들 수 있는데, 이 리팩터를 빼먹으면 이름 비교가 quote 때문에 어긋남. 멀티파일은 아니고 단일 파일이지만 세 군데를 일관되게 손봐야 통과.
