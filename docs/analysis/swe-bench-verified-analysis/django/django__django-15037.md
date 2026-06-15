---
instance_id: django__django-15037
repo: django/django
base_commit: dab48b7482295956973879d15bfd4d3bb0718772
version: 4.1
difficulty: 15 min - 1 hour
created_at: 2021-10-30T15:21:38Z
fail_to_pass: 1
pass_to_pass: 14
gold_files: [django/core/management/commands/inspectdb.py]
---

# django__django-15037

## 문제 요약
`inspectdb` 관리 명령은 외래키가 참조 테이블의 PK가 아닌 특정 컬럼(UNIQUE 컬럼 등)을 가리킬 때 이를 처리하지 못한다. 예를 들어 `bar.other_id`가 `foo(other_id)`(UNIQUE)를 참조하면, 생성된 모델은 단순히 `ForeignKey('Foo')`로만 만들어져 실제 참조 대상 컬럼 정보(`to_field`)가 사라진다. 사용자는 생성 모델이 `to_field='other_id'`를 포함하길 기대한다.

## 유형 분류
- 버그 카테고리: 누락처리 (FK가 non-PK 컬럼을 참조하는 케이스 미처리)
- 서브시스템: django core management / inspectdb (DB 인트로스펙션 → 모델 코드 생성)
- 증상 타입: silent-wrong (예외 없이 잘못된/불완전한 모델 코드 생성)
- 로컬라이제이션 신호: problem_statement가 "inspectdb"를 명시하고 "generated model ... FK to foo and not foo(other_id)"라고 함. 곧장 `django/core/management/commands/inspectdb.py`의 FK 생성 로직으로 좁혀진다.

## 골드패치 분석
- 건드린 파일/함수: `django/core/management/commands/inspectdb.py` : `Command.handle_inspection` 내부 컬럼 루프 (`is_relation` 분기)
- 근본 원인: 기존 코드는 `relations[column_name]`에서 참조 테이블명만 꺼내 쓰고(`relations[column_name][1]`), 참조 컬럼(`[0]`)은 무시했다. FK 생성 시 참조 대상이 PK인지 아닌지 확인하지 않아 non-PK 참조 정보를 잃어버린다.
- 수정 요지:
  - `ref_db_column, ref_db_table = relations[column_name]`로 참조 컬럼/테이블을 모두 언패킹.
  - `ForeignKey` 분기에서 `connection.introspection.get_primary_key_column(cursor, ref_db_table)`로 참조 테이블의 PK 컬럼을 조회.
  - PK 컬럼이 존재하고 참조 컬럼과 다르면(`ref_pk_column != ref_db_column`) `extra_params['to_field'] = ref_db_column` 설정.
  - `rel_to` 계산도 `relations[column_name][1]` 대신 언패킹한 `ref_db_table`을 쓰도록 정리.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_foreign_key_to_field (inspectdb.tests.InspectDBTestCase)`
- 테스트 모델 `ForeignKeyToField`는 `to_field='people_unique'`로 `PeopleMoreData`를 참조하는 FK를 정의. 즉 PK가 아닌 UNIQUE 컬럼을 가리킨다.
- 테스트는 `call_command('inspectdb', 'inspectdb_foreignkeytofield')` 출력에 정확히
  `to_field_fk = models.ForeignKey('InspectdbPeoplemoredata', models.DO_NOTHING, to_field='people_unique_id')`
  가 포함되는지 `assertIn`으로 확인. `@skipUnlessDBFeature('can_introspect_foreign_keys')`로 FK 인트로스펙션을 지원하는 백엔드에서만 실행.
- 재현 입력: non-PK 컬럼을 참조하는 FK가 있는 테이블 → 기대 출력: `to_field=...` 인자가 붙은 ForeignKey 코드.

## 공략 포인트 (뭘 조져야)
- localization 전략: `inspectdb.py` 단일 파일, `is_relation` 분기 안의 `ForeignKey`/`OneToOneField` 생성부만 보면 된다. `relations[column_name]` 튜플이 `(ref_column, ref_table)` 형태임을 인지하는 것이 핵심.
- 함정/난이도 메모:
  - PK 동일 여부 체크를 빠뜨리면 PK를 가리키는 일반 FK에도 불필요한 `to_field`가 붙어 14개 PASS_TO_PASS 회귀 발생. `ref_pk_column != ref_db_column` 가드가 필수.
  - `get_primary_key_column` 호출 위치는 `ForeignKey` 분기 한정. `OneToOneField`(unique/PK 참조)에는 `to_field`를 붙이지 않는 골드 선택을 따라야 한다.
  - `ref_pk_column`이 None일 수 있음(가드에 포함됨).
- 우리 에이전트 관점: 단일 파일·소규모 수정이라 난이도는 낮으나, "참조 컬럼이 PK가 아닐 때만 to_field 추가"라는 조건을 정확히 잡지 못하면 회귀가 난다. 또 `relations` 튜플의 인덱스 의미(0=컬럼, 1=테이블)를 인트로스펙션 코드에서 확인하지 않고 추측하면 틀리기 쉽다.
