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
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, has-repro]
---

# django__django-15629

## 문제 요약
PK 필드에 `db_collation`(예: `utf8_bin`)을 지정하면, 그 PK를 참조하는 다른 모델의 FK 컬럼에는 collation이 전파되지 않는다. makemigrations가 생성한 SQL에서 FK 컬럼은 `MODIFY account_id varchar(22) NOT NULL`로만 변경되고 `COLLATE utf8_bin`이 빠진다. 결과적으로 PK와 FK의 collation이 불일치해 MySQL의 `ADD CONSTRAINT`(외래키 제약) 추가가 실패한다. 이슈 본문은 잘못 생성된 SQL과 올바른 SQL을 나란히 보여주는 재현 사례를 포함한다. 사용자는 FK 컬럼도 참조 대상 PK와 동일한 collation으로 변경되길 기대한다.

## 유형 (정형화)
- **L (Localization) = L3 (Multi-site).** 픽스가 4개 파일에 걸쳐 **함께** 바뀌어야 한다: `related.py`(FK가 collation을 노출), `base/schema.py`(두 군데 — drop 조건 + rels_to_update 루프), `sqlite3/schema.py`(백엔드별 FK 재구성 조건), `oracle/features.py`(미지원 테스트 skip). 한 곳만 고치면 다른 백엔드/경로에서 깨진다. hints_text가 진입점을 지목해 주지만 그건 단일 표면(`db_parameters`)일 뿐, 진짜 작업은 조율된 멀티사이트라 L3.
- **S (Repair Strategy) = S6 Design-Refactor (+S2 Constraint-Reasoning).** 한 줄 가드가 아니라 **데이터 흐름을 재배치하는 구조 변경**이다: (a) `ForeignKey.db_parameters`가 단순 `{type, check}`에서 타겟 필드의 collation을 proxy하도록 계약을 확장, (b) `_alter_field`에서 collation 변수 추출 위치를 함수 상단으로 끌어올려 drop 조건 시점에 가용하게 하는 코드 이동, (c) rels_to_update 루프에 collation-vs-type 분기 도입. 그 위에 S2가 얹힌다 — "type 불변이지만 collation은 변함"이라는 엣지 불변식을 정확히 추론해 `(old_type != new_type) or (old_collation != new_collation)` 조건식을 합성해야 한다(특수케이스 시도가 아니라 불변식 사고). overfit-and-iterate가 아니라 의미적으로 올바른 구조를 짜야 하므로 S3/S4가 아니다.
- **K (Knowledge) = K-Domain.** django schema-editor 내부 지식이 병목이다: `db_parameters`/`db_type`/`db_db_collation`의 계약, `_alter_field`의 drop-FK → alter-column → re-add-FK lifecycle, `_alter_column_collation_sql` vs `_alter_column_type_sql`의 의미 차이, 백엔드별(sqlite3 remake-table, oracle 인덱스 컬럼 제약) 분기. 일반 파이썬 추론으로는 도달 불가. API 시그니처 호환(K-API)도 끼지만 dominant는 도메인.
- **Primary type = T-DesignRefactor.** dominant 축이 S6(조율된 구조 변경)이다. 위치가 모호한 게 아니라(hints가 지목) 한 줄로 안 되고 여러 사이트의 data-flow/조건을 함께 재배치해야 한다는 점이 본질. T-DomainBound도 후보지만, 도메인지식은 *수단*이고 난점의 형태는 멀티사이트 구조변경이므로 Refactor가 더 정확.

## 난이도 티어
**Tier = T5 (어려움).** 공식 라벨은 "1-4 hours"(T3~T4 prior)지만 구조적 피처가 T5로 민다:
- **파일수 4개 / 헌크 다수**: gold patch가 4파일·5헌크. 루브릭 구조컷에서 ≥3파일은 solve <10% 구간. base/schema.py 한 곳에만 두 개의 독립 수정점.
- **localize 직접성 낮음(L3)**: hints가 `db_parameters` 진입점을 주지만, 그것만 고치면 FAIL_TO_PASS의 절반(CreateModel 케이스)만 통과하고 AlterField 케이스는 여전히 실패한다 — hints의 PR 작성자가 정확히 이 함정에 빠졌음이 기록돼 있다. 진짜 localize는 `_alter_field`의 type-only 분기 두 곳과 멀티백엔드까지 추적해야 완결.
- **넓은 P2P trap(regression-trap)**: PASS_TO_PASS 115개가 migrations.test_operations 전체 — AlterField/CreateModel/FK/M2M lifecycle 광범위. `_alter_field` drop 조건과 rels 루프를 건드리므로 collation 무관 케이스를 깨면 대량 회귀.
- **깊은 도메인(K-Domain)**: schema editor 내부 + 백엔드별 차이.
- 공식 "1-4h"와 다른 이유: 개발자 *구현시간* 라벨은 (a) hints/PR이 절반의 진실만 줘서 생기는 localize 함정과 (b) 멀티백엔드 회귀 위험을 반영하지 못한다. 에이전트 입장의 실패 위험(표면 픽스로 만족 + 백엔드 누락 + P2P 회귀)이 시간라벨보다 높다.

## 골드패치 분석
- **건드린 파일/함수:**
  - `django/db/models/fields/related.py:ForeignKey.db_parameters` — collation 노출.
  - `django/db/backends/base/schema.py:BaseDatabaseSchemaEditor._alter_field` — (1) collation 변수 추출을 함수 상단으로 hoist, (2) `drop_foreign_keys` 조건 확장, (3) `rels_to_update` 루프 분기.
  - `django/db/backends/sqlite3/schema.py:DatabaseSchemaEditor._alter_field` — FK 재구성(remake) 조건 확장.
  - `django/db/backends/oracle/features.py:DatabaseFeatures.django_test_skips` — Oracle은 인덱스 컬럼 collation 변경 미지원(#33671)이라 `test_alter_field_pk_fk_db_collation`을 skip 등록.
- **근본 원인:** `ForeignKey.db_parameters`가 `{"type", "check"}`만 반환하고 `collation` 키를 노출하지 않아, schema editor가 FK 컬럼을 alter할 때 타겟 PK의 collation을 알 수 없었다. 게다가 `_alter_field`는 incoming FK drop/재생성 및 관련 컬럼 변경 여부를 **type 변화(`old_type != new_type`)만으로** 판단해, type은 그대로고 collation만 바뀌는 케이스를 통째로 무시했다.
- **수정 요지:**
  1. `ForeignKey.db_parameters`가 `target_field.db_parameters(connection)`에서 `collation`을 가져와 자기 dict에 포함(PK → FK 전파의 핵심 seam). 이로써 CreateModel 신규 케이스가 풀린다.
  2. base `_alter_field`에서 `old_collation`/`new_collation` 추출을 함수 상단으로 끌어올리고(중복 정의 제거), `drop_foreign_keys` 조건을 `and ((old_type != new_type) or (old_collation != new_collation))`로 확장 — type 불변이어도 collation 변화면 FK를 drop/재생성.
  3. base `_alter_field`의 `rels_to_update` 루프에서, 관련 FK의 collation이 바뀌었으면 `_alter_column_collation_sql`을 호출(아니면 기존 `_alter_column_type_sql`)하도록 분기. collation 변화가 type 변화도 흡수하므로 `other_actions=[]`.
  4. sqlite3 `_alter_field`에서 FK 재구성 조건을 `new_field.unique and (old_type != new_type or old_collation != new_collation)`로 확장.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개):**
  - `test_alter_field_pk_fk_db_collation` — PK의 `db_collation`을 AlterField로 변경하면 이를 참조하는 FK/M2M 컬럼에도 collation이 반영되는지. (정확히 표면 픽스로는 못 잡는 케이스)
  - `test_create_fk_models_to_pk_field_db_collation` — db_collation이 걸린 PK를 처음부터 FK/OneToOne으로 참조하는 모델 생성 시 FK 컬럼이 같은 collation을 갖는지.
- **픽스 증명:** `tests/migrations/test_base.py`에 `_get_column_collation`/`assertColumnCollation` 헬퍼 추가 — 실제 DB의 `get_table_description`에서 컬럼의 `collation`을 읽어 검증한다(코드 상태가 아닌 실제 DDL effect 관찰). alter 테스트는 Pony(PK CharField) → Rider(FK) → Stable(M2M)를 만든 뒤 PK에 `db_collation=collation` AlterField를 적용하고, `{app}_pony.id`·`{app}_rider.pony_id`·`{app}_stable_ponies.pony_id` 세 컬럼이 모두 같은 collation인지 확인. `database_backwards`로 역방향(reversal)도 검사. 둘 다 `@skipUnlessDBFeature("supports_collation_on_charfield", "supports_foreign_keys")`로 게이트되고, `test_collations["non_default"]`가 없으면 skip(가시적 skip).
- **overfit 관점:** FAIL_TO_PASS가 2개로 얇아 보이나, 두 케이스가 서로 다른 코드경로(CreateModel vs AlterField)를 강제해 `db_parameters` 한 줄만으로는 통과 불가 — 표면 overfit을 구조적으로 차단한다. M2M까지 검증하고 reversal을 보므로 special-case 통과 여지가 작다. overfit-risk는 낮은 편이지만, 실제 effect를 보는 백엔드가 collation 지원 백엔드(주로 MySQL)로 한정돼 다른 백엔드는 skip-by-feature라 "통과"의 의미가 백엔드 의존적(그래서 flags에 overfit-risk는 미표기, regression-trap이 더 큰 위험).
- **regression 관점:** P2P 115개(test_operations 전반)가 `_alter_field` drop 조건·rels 루프·sqlite3 remake 조건 변경에 노출. 특히 "Tests the AlterField operation on primary keys changes any FKs pointing to it." 같은 기존 PK→FK 전파 케이스가 collation 무관 상태에서 그대로 통과해야 한다(조건을 OR로 확장한 게 기존 type 경로를 안 바꿔야 함).

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈의 "FK 컬럼에 `COLLATE`가 빠짐 → `ADD CONSTRAINT` 실패" + 제시된 ALTER SQL 비교가 곧 **DDL 생성 = schema editor**를 가리킨다. "FK가 타겟 PK의 collation을 모름"이라는 증상은 `ForeignKey.db_parameters`(related.py)와 그것을 소비하는 `BaseDatabaseSchemaEditor._alter_field`(base/schema.py)로 수렴. hints_text가 두 파일을 명시. 여기서 멈추지 말고 — `_alter_field`가 collation을 어디서 type과 함께 판단하는지(`drop_foreign_keys` 조건, `rels_to_update` 루프), 그리고 백엔드별 오버라이드(sqlite3 remake-table, oracle 제약)까지 grep으로 펼쳐야 진짜 멀티사이트가 보인다.
2. **픽스와 올바른 일반화:** 핵심 seam은 `db_parameters`에 `collation` 키를 추가해 FK가 타겟의 collation을 **proxy**하는 것 — hints의 "`db_collation` property" 대안보다 "collation을 db_params에 흘려보내고 schema editor가 params['collation']으로 분기"가 더 일반적(이슈 작성자도 후자가 낫다고 토론). 이게 overfit이 아닌 이유: collation을 db_params 레벨에서 전파하면 CreateModel(신규)·AlterField(변경)·M2M·reversal이 *같은 메커니즘*으로 일관되게 처리된다. 조건식은 type-only를 collation-OR로 일반화(`old_type != new_type or old_collation != new_collation`) — 특정 테스트를 노린 if가 아니라 "alter가 필요한가"의 정의를 collation까지 넓힌 불변식.
3. **regression 안전:** P2P 115개 중 collation 무관 AlterField/CreateModel/FK/M2M lifecycle을 안 깨야 한다. 조건을 **OR로만 확장**해 기존 `old_type != new_type` 경로의 동작을 보존(collation이 동일하면 기존과 byte-identical 분기). `db_parameters`에 키 추가는 additive라 기존 `["type"]`/`["check"]` 소비자에 무해. rels 루프 분기도 collation 동일 시 else로 떨어져 기존 `_alter_column_type_sql` 호출 유지.
4. **함정 회피:** (a) **표면 픽스 만족 금지** — `db_parameters`에 collation만 넣으면 `test_create_fk...`는 통과하나 `test_alter_field_pk_fk...`는 `_alter_field`의 type-only 분기 때문에 여전히 실패한다(hints의 PR 작성자가 빠진 바로 그 함정). FAIL_TO_PASS 둘을 **모두** 풀어야 완결. (b) **멀티백엔드 누락 금지** — base/schema.py만 고치면 sqlite3는 remake-table 경로라 FK 재구성이 안 걸린다. (c) **collation 변수 hoist** — drop 조건에서 collation이 필요한데 원래 정의가 함수 후반부라, 위로 끌어올리는 코드 이동을 빠뜨리면 NameError 또는 잘못된 판단. (d) **Oracle skip 등록** — Oracle은 인덱스 컬럼 collation 변경 미지원이라 features.py에 skip을 등록하지 않으면 Oracle CI가 깨진다(에이전트가 놓치기 쉬운 백엔드별 예외).
