---
instance_id: django__django-15629
repo: django/django
base_commit: 694cf458f16b8d340a3195244196980b2dec34fd
version: 4.1
difficulty: 1-4 hours
created_at: 2022-04-23T21:58:24Z
fail_to_pass: 2
pass_to_pass: 115
gold_files: [django/db/backends/base/schema.py, django/db/backends/oracle/features.py, django/db/backends/sqlite3/schema.py, django/db/models/fields/related.py]
---

# django__django-15629

## 문제 요약
PK 필드에 `db_collation`(예: `utf8_bin`)을 지정하면, 그 PK를 참조하는 다른 모델의 FK 컬럼에는 collation이 전파되지 않는다. makemigrations가 생성한 SQL에서 FK 컬럼은 `MODIFY account_id varchar(22) NOT NULL`로만 변경되고 `COLLATE utf8_bin`이 빠진다. 결과적으로 PK와 FK의 collation이 불일치해 MySQL의 `ADD CONSTRAINT` (외래키 제약) 추가가 실패한다. 사용자는 FK 컬럼도 PK와 동일한 collation으로 변경되길 기대했다.

## 유형 분류
- 버그 카테고리: 누락처리 (collation 전파 누락) / API-contract
- 서브시스템: django ORM schema editor / migrations (DDL 생성)
- 증상 타입: 크래시 (FK 제약 추가 시 DB 에러), 잘못된 출력 (불완전한 ALTER SQL)
- 로컬라이제이션 신호: "ALTER ... ADD CONSTRAINT FOREIGN KEY 실패" + "FK 컬럼에 COLLATE가 빠짐"은 곧 schema editor의 `_alter_field`와 ForeignKey의 `db_parameters`를 가리킨다. hints_text도 `django/db/models/fields/related.py`의 `db_parameters`와 base `schema.py`의 `_alter_field`를 직접 지목.

## 골드패치 분석
- 건드린 파일/함수:
  - `django/db/models/fields/related.py:ForeignKey.db_parameters`
  - `django/db/backends/base/schema.py:BaseDatabaseSchemaEditor._alter_field`
  - `django/db/backends/sqlite3/schema.py:DatabaseSchemaEditor._alter_field`
  - `django/db/backends/oracle/features.py:DatabaseFeatures` (Oracle 미지원 테스트 skip 등록)
- 근본 원인: `ForeignKey.db_parameters`가 `type`/`check`만 반환하고 `collation` 키를 노출하지 않았다. 그래서 schema editor가 FK 컬럼을 alter할 때 타겟 PK의 collation을 알 수 없었다. 또한 PK collation만 바뀌고 type은 그대로일 때 `_alter_field`가 FK drop/재생성 및 관련 컬럼 변경을 type 변화(`old_type != new_type`)만으로 판단해 collation 변화를 무시했다.
- 수정 요지:
  1. `ForeignKey.db_parameters`가 `target_field.db_parameters(connection)`에서 `collation`을 가져와 자기 dict에 포함시킨다 (PK → FK 전파의 핵심).
  2. base `_alter_field`에서 incoming FK drop 조건에 `(old_collation != new_collation)`을 OR로 추가 — type 불변이어도 collation 변화면 FK를 drop/재생성.
  3. base `_alter_field`의 `rels_to_update` 루프에서 관련 FK 컬럼을 alter할 때, collation이 바뀌었으면 `_alter_column_collation_sql`을 호출(아니면 기존 `_alter_column_type_sql`)하도록 분기 추가.
  4. sqlite3 `_alter_field`에서도 FK 재구성 조건을 `old_type != new_type or old_collation != new_collation`으로 확장.

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `test_alter_field_pk_fk_db_collation` — PK의 `db_collation`을 AlterField로 변경하면 이를 참조하는 FK/M2M 컬럼에도 collation이 반영되는지.
  - `test_create_fk_models_to_pk_field_db_collation` — db_collation이 걸린 PK를 처음부터 FK/OneToOne으로 참조하는 모델 생성 시 FK 컬럼이 같은 collation을 갖는지.
- 증명 방식: `tests/migrations/test_base.py`에 `assertColumnCollation`/`_get_column_collation` 헬퍼 추가 — 실제 DB의 `get_table_description`에서 컬럼의 `collation`을 읽어 검증한다. alter 테스트는 Pony(PK CharField)→Rider(FK)→Stable(M2M)를 만든 뒤 PK에 `db_collation=collation` AlterField를 적용하고, `{app}_pony.id`, `{app}_rider.pony_id`, `{app}_stable_ponies.pony_id` 세 컬럼 모두 같은 collation인지 확인(재현 입력→기대 출력: PK collation 변경 → 모든 참조 FK 컬럼이 동일 collation). `database_backwards`로 역방향도 검사.

## 공략 포인트 (뭘 조져야)
- 시작점: `ForeignKey.db_parameters`(related.py)에서 collation을 노출하지 않는 게 1차 원인. 여기에 `target_field.db_parameters`의 collation을 proxy로 넣는 게 최소 수정.
- 함정/난이도:
  - DDL 경로가 멀티파일·멀티백엔드다. base/schema.py뿐 아니라 sqlite3 schema.py의 FK 재구성 조건도 같이 고쳐야 하고, Oracle은 인덱스 컬럼 collation 변경 미지원이라 features.py에 skip 등록까지 해야 한다. 한 파일만 고치면 일부 백엔드에서 깨진다.
  - `_alter_field`에서 collation 변수 추출 위치를 위로 끌어올리는 리팩터(중복 정의 제거)가 들어가는데, FK drop 조건 판단 시점에서 collation이 필요하기 때문. 단순 add가 아니라 코드 이동을 동반.
  - drop_foreign_keys 조건과 rels_to_update 루프, 두 곳 모두 collation을 고려해야 한다(하나만 고치면 제약은 drop되는데 재생성 SQL이 틀리거나 그 반대).
- 우리 에이전트 관점: `db_parameters`에 collation만 추가하면 신규 CreateModel 케이스(`test_create_fk...`)는 통과하지만, AlterField로 기존 PK collation을 바꾸는 케이스는 `_alter_field`의 type-only 분기 때문에 여전히 실패한다 — hints_text에서 PR 작성자가 정확히 이 함정에 빠졌다. 표면 픽스(property 하나)로 만족하면 FAIL_TO_PASS 절반만 통과. 멀티백엔드 schema editor 전체를 추적해야 완결.
