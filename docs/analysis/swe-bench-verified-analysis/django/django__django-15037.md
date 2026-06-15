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
primary_type: T-DomainBound
tier: T4
loc_axis: L0
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, has-repro, underspecified]
---

# django__django-15037

## 문제 요약
`inspectdb` 관리 명령은 외래키가 참조 테이블의 PK가 아닌 특정 컬럼(UNIQUE 컬럼 등)을 가리킬 때 이를 처리하지 못한다. 예를 들어 `bar.other_id`가 `foo(other_id)`(UNIQUE)를 참조하면, 생성된 모델은 단순히 `ForeignKey('Foo')`로만 만들어져 실제 참조 대상 컬럼 정보(`to_field`)가 사라진다. 결과적으로 생성된 모델이 원본 스키마와 의미적으로 다른 FK(non-PK 참조 → PK 참조로 묵시 변환)를 만들어낸다. 사용자는 생성 모델이 `to_field='other_id'`를 포함하길 기대한다. problem_statement에 CREATE TABLE 재현 스키마가 첨부되어 있다(has-repro).

## 유형 (정형화)

3축 점수:

- **L0 (Localization=Pinpointed)** — problem_statement가 "inspectdb"를 명시하고 증상이 "the generated model ... will have the other_id be a FK to foo and not foo(other_id)"라 곧장 단일 파일 `django/core/management/commands/inspectdb.py`의 FK 코드 생성부로 지목된다. grep 한 방 수준. cross-file 추적 불필요.
- **S2 (Constraint-Reasoning) (+S5)** — 고칠 지점은 자명하지만, "non-PK 참조일 때만 `to_field`를 추가한다"는 **올바른 조건식을 추론으로 합성**해야 한다. 단순 `to_field=ref_db_column` 추가(S1 기계적)로는 PK를 참조하는 정상 FK 전부에 불필요한 `to_field`가 붙어 회귀가 난다. 정확한 불변식은 `ref_pk_column and ref_pk_column != ref_db_column`이다. 보조로 S5(Spec-Inference): 이슈 본문은 "to_field가 빠진다"고만 말하고 PK-동일 케이스나 OneToOne 케이스의 기대 동작을 명세하지 않아(underspecified), 의도된 스펙(PK 참조엔 to_field 생략, FK 분기 한정)을 코드 계약/django 관례에서 재구성해야 한다.
- **K-Domain** — `connection.introspection.get_primary_key_column(cursor, table)` 라는 django DB introspection 백엔드 API의 존재·시그니처·반환(컬럼명 or None)을 알아야 하고, `relations[column_name]` 튜플이 `(ref_column, ref_table)` 순서임을 introspection 계약에서 확인해야 한다. 일반 파이썬 추론만으로는 막힘.

**Primary type = T-DomainBound** — 병목이 "django introspection 내부 지식"(get_primary_key_column API + relations 튜플 의미 + to_field 모델 계약)에 있다. localize는 자명(L0)하고 줄 수도 적지만, 올바른 픽스는 introspection 백엔드를 알아야만 도출된다. S2 추론이 두 번째 축이지만 그 추론조차 도메인 API에 의존하므로 dominant는 K-Domain.

왜 이 repair strategy인가(APR 관점): 픽스 위치는 후보 패치 탐색이 필요 없을 만큼 명확하므로 G&V(S3)/CEGIS(S4)가 아니다. 또 이슈가 픽스 코드를 그대로 받아쓰게 명세하지 않으므로(PK-동일/OneToOne 케이스의 가드를 직접 알려주지 않음) S1 template-map도 아니다. 핵심은 "어떤 입력에서 to_field를 붙이고 어떤 입력에서 붙이지 않는가"라는 조건을 의미적으로 따져 합성하는 SemFix/Angelix류 constraint-reasoning이다.

## 난이도 티어
**T4 (약간 어려움).** 공식 difficulty 라벨은 "15 min - 1 hour"(T3 근방)이지만 한 단계 올려 T4로 잡는다.

이 티어로 미는 구조적 피처:
- **K-Domain 병목** — 단일 파일·~9줄 추가로 patch scope는 작지만(T1~T2 신호), 픽스가 `get_primary_key_column` introspection API와 `to_field` 모델 계약을 정확히 알아야 도출된다. 루브릭상 K-Domain이 dominant면 T4로 분류된다.
- **regression-trap (P2P=14)** — `test_introspection`("Test introspection of various Django field types"), 특수문자 컬럼/테이블명, json_field, unique_together 등 14개 인접 introspection 동작이 모두 그대로 통과해야 한다. PK-동일 가드를 빠뜨리면 정상 FK 전체가 깨져 다수 P2P 회귀.
- **underspecified** — 이슈가 PK-동일 케이스/OneToOne 케이스의 기대 동작을 명세하지 않음. has-repro(CREATE TABLE 스키마 첨부)는 easiness 신호로 작용하지만, 조건식의 정확한 경계는 본문에 없다.

공식 라벨과 다른 이유: 시간 라벨은 "개발자 구현시간"(이미 patch 초안을 제출자가 첨부했으니 빠름)을 반영하지만, **오라클 없는 에이전트 관점에선 to_field 추가 조건의 경계(PK 동일 제외, FK 분기 한정, None 가드)를 introspection 지식 없이 정확히 잡기가 어렵고 회귀 위험이 크다**. localize 쉬움은 시간 라벨에 잡히지만 K-Domain+regression-trap은 안 잡힌다.

## 골드패치 분석
- **건드린 파일/함수**: `django/core/management/commands/inspectdb.py` — `Command.handle()` 내부 `handle_inspection`의 컬럼 루프, `if is_relation:` 분기(`table2model` 헬퍼가 정의된 영역).
- **근본 원인**: 기존 코드는 `relations[column_name]` 튜플에서 참조 테이블명(`relations[column_name][1]`)만 꺼내 쓰고 참조 컬럼(`[0]`)은 무시했다. FK 코드를 생성할 때 참조 대상이 참조 테이블의 PK인지 비-PK인지 확인하지 않으므로, non-PK(UNIQUE 등) 참조 정보가 소실되고 항상 묵시적으로 PK를 가리키는 `ForeignKey`로 생성된다.
- **수정 요지**:
  - `ref_db_column, ref_db_table = relations[column_name]`로 참조 (컬럼, 테이블)을 모두 언패킹.
  - `ForeignKey` 분기(`else` 가지)에서만 `ref_pk_column = connection.introspection.get_primary_key_column(cursor, ref_db_table)`로 참조 테이블의 PK 컬럼을 조회.
  - `if ref_pk_column and ref_pk_column != ref_db_column:` 일 때만 `extra_params['to_field'] = ref_db_column` 설정 — 즉 PK가 존재하고(None 가드) 참조 컬럼이 그 PK와 다를 때만 `to_field`를 붙인다.
  - `rel_to` 계산을 `relations[column_name][1]` 인덱싱 대신 언패킹한 `ref_db_table`을 쓰도록 정리(`'self' if ref_db_table == table_name else table2model(ref_db_table)`).
  - `OneToOneField` 분기(unique/primary_key 참조)에는 `to_field`를 붙이지 않는 골드 선택을 따른다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1)**: `test_foreign_key_to_field (inspectdb.tests.InspectDBTestCase)`.
- 동작: 테스트 모델 `ForeignKeyToField`가 `to_field='people_unique'`로 `PeopleMoreData`를 참조하는 FK를 정의 — PK가 아닌 UNIQUE 컬럼(`people_unique`)을 가리킨다. 테스트는 `call_command('inspectdb', 'inspectdb_foreignkeytofield')` 출력에 정확히
  `to_field_fk = models.ForeignKey('InspectdbPeoplemoredata', models.DO_NOTHING, to_field='people_unique_id')`
  가 포함되는지 `assertIn`으로 확인. `@skipUnlessDBFeature('can_introspect_foreign_keys')`로 FK 인트로스펙션을 지원하는 백엔드에서만 실행(visible-skip).
- **픽스 증명**: 패치 전엔 `to_field` 없이 `ForeignKey('InspectdbPeoplemoredata', ...)`만 생성되어 `assertIn`이 실패. 패치 후 `ref_pk_column(='id') != ref_db_column(='people_unique_id')`이 참이 되어 `to_field='people_unique_id'`가 주입되며 통과.
- **overfit 관점**: FAIL_TO_PASS가 1개뿐이라 "non-PK FK일 때 to_field 추가"라는 핵심 케이스만 직접 검증한다(얇음). 하지만 골드 픽스는 special-case 하드코딩이 아니라 `get_primary_key_column` 비교라는 일반 조건이라 overfit-risk는 낮다. 다만 PK-동일/None 케이스는 P2P가 간접 커버하므로 단일 테스트의 얇음을 보강한다.
- **regression 관점**: 14개 PASS_TO_PASS(field-type introspection, 특수문자명, json_field, unique_together, managed=False, views 등)가 그대로 통과해야 한다. 정상 PK 참조 FK들은 `ref_pk_column == ref_db_column`이라 `to_field`가 붙지 않아야 회귀가 없다 — 이 가드가 회귀 안전의 핵심.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈가 "inspectdb"를 명시 → `django/core/management/commands/inspectdb.py`. "generated model ... FK to foo and not foo(other_id)" → 모델 코드 문자열을 생성하는 부분 중 FK를 만드는 `if is_relation:` 분기. grep `ForeignKey`/`is_relation`로 즉시 도달(L0). 여기서 `relations[column_name]`이 어떻게 쓰이는지 읽고, introspection의 `relations` 계약(`(ref_column, ref_table)` 튜플)을 확인.

2. **픽스와 올바른 일반화 이유**: 참조 컬럼(`ref_db_column`)을 언패킹하고, FK 분기에서 `get_primary_key_column`으로 참조 테이블의 PK를 조회해 **참조 컬럼이 PK와 다를 때만** `to_field`를 주입. 이게 special-case가 아닌 일반화인 이유 — 조건이 "특정 테이블/컬럼"이 아니라 "참조 컬럼 ≠ 참조 테이블 PK"라는 스키마 불변식이므로, 임의의 non-PK FK(UNIQUE 참조 등) 전체에 정확히 일반화된다. 동시에 PK 참조 FK엔 `to_field`를 생략해 기존 출력과 동일하게 유지.

3. **regression 안전**: P2P의 정상 FK introspection들(field-type 테스트 등)은 모두 PK를 참조하므로 `ref_pk_column == ref_db_column`이 되어 `to_field`가 붙지 않아야 한다 → `!=` 가드가 이를 보장. `OneToOneField` 분기에는 변경을 가하지 않아 unique/PK 참조 동작 불변. `get_primary_key_column`이 None을 줄 수 있는 백엔드(`and ref_pk_column`)도 가드로 안전.

4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 —
   - **무조건 to_field 추가**: `relations`에서 컬럼을 꺼냈으니 항상 `to_field=ref_db_column`을 붙이면 PK 참조 FK 전부에 군더더기가 붙어 다수 P2P 회귀. 반드시 PK-동일 비교 가드를 넣을 것.
   - **튜플 인덱스 추측**: `relations[column_name]`의 0/1 순서를 introspection 코드에서 확인하지 않고 추측하면 컬럼/테이블이 뒤바뀜. 언패킹 전에 introspection 계약을 읽어 `(ref_column, ref_table)`임을 검증.
   - **OneToOneField에도 적용**: `to_field`를 공통 분기로 끌어올리면 OneToOne(unique/PK 참조)에도 붙어 골드와 어긋남. FK 분기(`else`)에 한정.
   - **None 가드 누락**: `get_primary_key_column`이 None을 반환하는 백엔드에서 `None != ref_db_column`이 참이 되어 잘못된 to_field가 붙는다 → `if ref_pk_column and ...`로 막을 것.
