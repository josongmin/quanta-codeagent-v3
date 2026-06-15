---
instance_id: django__django-15561
repo: django/django
base_commit: 6991880109e35c879b71b7d9d9c154baeec12b89
version: "4.1"
difficulty: 15 min - 1 hour
created_at: 2022-04-01T18:29:04Z
fail_to_pass: 1
pass_to_pass: 141
gold_files: [django/db/backends/base/schema.py, django/db/models/fields/__init__.py]
---

# django__django-15561

## 문제 요약
SQLite 백엔드에서 `choices`만 추가/변경하는 것처럼 컬럼 정의에 영향이 없는 마이그레이션조차 불필요한 SQL(new table + insert + drop + rename, 즉 테이블 재생성)을 생성한다. 동일한 변경이 PostgreSQL/MySQL/Oracle에서는 noop(SQL 0건)인데 SQLite에서만 다르게 동작한다. 사용자는 `AlterField`로 `choices`만 바꿀 때 DB 변경이 없어야(noop이어야) 한다고 기대한다.

## 유형 분류
- 버그 카테고리: 누락처리 (no-op 판정 화이트리스트에 `choices`가 빠짐)
- 서브시스템: django ORM migrations / schema editor (DDL 생성)
- 증상 타입: 잘못된 출력 (불필요한 DDL 생성 = 성능/안정성 부작용)
- 로컬라이제이션 신호: problem_statement가 "noop", "still generates sql"을 언급하고, hints_text가 `#25253`/`django/db/backends/base/schema.py`의 `non_database_attrs` 리스트와 `_field_should_be_altered`를 직접 지목한다. "왜 pg는 noop인가"의 답은 SQLite만 테이블 재생성을 하기 때문이며, 진짜 공통 판정 로직이 `_field_should_be_altered`에 있다.

## 골드패치 분석
- 건드린 파일/함수:
  - `django/db/backends/base/schema.py:_field_should_be_altered` (`BaseDatabaseSchemaEditor`)
  - `django/db/models/fields/__init__.py:Field` (클래스 속성 `non_db_attrs` 신설)
- 근본 원인: `_field_should_be_altered`가 "스키마에 영향 없는 속성"을 메서드 안에 하드코딩된 `non_database_attrs` 리스트로 들고 있었고, 그 리스트에 `choices`가 없었다. 그래서 `choices`만 바뀐 경우에도 old/new kwargs가 달라 alter가 필요하다고 판정 → SQLite는 테이블 재생성 DDL을 뱉었다.
- 수정 요지: 하드코딩 리스트를 제거하고, 무시 대상 속성을 `Field` 클래스의 `non_db_attrs` 튜플로 옮겨 필드 클래스 레벨로 끌어올렸다(`choices` 추가 포함). `_field_should_be_altered`는 `old_field.non_db_attrs` / `new_field.non_db_attrs`를 각각 순회하며 kwargs에서 pop한다. 이로써 (1) `choices`가 noop 처리되고, (2) hints의 우려(django-mysql `EnumField` 같은 서드파티 enum 필드 회귀)는 서브클래스가 `non_db_attrs`를 오버라이드해 해결 가능한 확장 지점이 된다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_alter_field_choices_noop (schema.tests.SchemaTests)`
- 테스트가 증명하는 방식: `Author` 모델을 생성한 뒤 `name` 필드(`old_field`)와, `choices`만 추가된 동등한 `CharField(max_length=255, choices=...)`(`new_field`)를 만든다. `editor.alter_field(...)`를 `old→new`, `new→old` 양방향으로 호출하면서 둘 다 `assertNumQueries(0)` 컨텍스트로 감싼다. 즉 choices만 바뀌면 SQLite에서도 발생 SQL이 0건이어야 한다는 것을 직접 단언한다. 픽스 전에는 테이블 재생성 쿼리가 나가 0건 단언이 깨진다.

## 공략 포인트 (뭘 조져야)
- 어디부터: "noop", "AlterField", "generates sql"에서 schema editor의 alter 판정 진입점인 `_field_should_be_altered`를 찾는 게 핵심. hints가 `non_database_attrs` 화이트리스트를 명시하므로 localization은 비교적 쉽다.
- 함정/난이도: 가장 빠른(naive) 패치는 hints 1번 답대로 리스트에 `'choices'` 한 줄만 추가하는 것이지만, 이는 서드파티 enum 필드(django-mysql `EnumField` 등)에서 회귀를 일으킨다. 골드는 이를 피하려고 "메서드 하드코딩 리스트 → 필드 클래스 속성 `non_db_attrs`"로 구조를 바꿔 멀티파일(2파일) 수정이 됐다. naive 1줄 픽스도 FAIL_TO_PASS는 통과시킬 수 있어, 테스트만 보면 구조 변경 동기를 놓치기 쉽다.
- 우리 에이전트 관점: FAIL_TO_PASS 단일 테스트만 만족시키는 최소 수정(리스트에 `choices` 추가)으로 수렴하기 쉽고, 그러면 `django/db/models/fields/__init__.py`는 건드리지 않아 gold_files 매칭이 어긋난다. old/new 양쪽 kwargs를 각 필드의 `non_db_attrs`로 따로 pop하는 미묘한 변경(서브클래스 확장성 보장)을 재현하려면 hints_text의 서드파티 회귀 논의를 읽고 설계 의도를 반영해야 한다.
