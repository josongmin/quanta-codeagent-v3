---
instance_id: django__django-14007
repo: django/django
base_commit: 619f26d2895d121854b1bed1b535d42b722e2eba
version: "4.0"
difficulty: 1-4 hours
created_at: 2021-02-13T09:00:02Z
fail_to_pass: 1
pass_to_pass: 12
gold_files: [django/db/models/sql/compiler.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L1
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [regression-trap, has-repro, overfit-risk]
---

# django__django-14007

## 문제 요약
`BigAutoField`를 서브클래싱하고 `from_db_value` 컨버터를 정의해도, INSERT 시 DB가 반환한 PK 값에는 그 컨버터가 적용되지 않는다. 일반 쿼리(`first()` 등)로 가져온 인스턴스의 `id`는 래퍼 클래스(`MyIntWrapper`)인데, `objects.create()`나 `bulk_create()`로 생성한 직후의 `id`는 컨버터를 거치지 않은 raw 정수다. 이슈는 재현 코드(필드 정의 + 모델 + REPL 출력 비교)를 명시적으로 제공하며, INSERT 반환값도 다른 쿼리 경로와 동일하게 `from_db_value`를 통과하길 기대한다.

## 유형 (정형화)

- **L (Localization) = L1 (Traceable)**: 이슈가 파일/함수를 직접 지목하진 않지만, "on insert the returned integer is not passed through database converters", `returning_fields`, `from_db_value` 키워드로 `SQLInsertCompiler.execute_sql`이라는 좁은 단일 후보로 수렴한다. grep 한 방은 아니고 INSERT returning 경로가 어디인지 한 단계 추적이 필요하다.
- **S (Repair Strategy) = S6 (Design-Refactor) +S2 (Constraint-Reasoning)**: 한 줄 가드 추가로 끝나지 않는다. 기존 코드는 세 백엔드 분기에서 각각 즉시 `return` 하는데, 이를 `rows` 로컬에 모으는 collect-then-process 구조로 재배치(S6)한 뒤 공통 converter 후처리를 끼워야 한다. 어떤 `cols`로 `get_converters`를 호출해야 SELECT 경로와 의미가 같아지는지(=`returning_fields` 기준 `field.get_col`)는 불변식 추론(S2)이 필요한 부분이다.
- **K (Knowledge) = K-Domain**: 픽스의 핵심은 SELECT 경로가 쓰는 `get_converters(cols)` / `apply_converters(rows, converters)` 파이프라인을 INSERT 경로에 이식하는 것이다. 이 컨버터 메커니즘의 존재·계약·`field.get_col(db_table)` 관용구는 django ORM/SQL compiler 내부 지식이다. 일반 파이썬 추론으로는 `from_db_value`를 직접 호출하는 우회 구현으로 빠진다.
- **Primary type = T-DomainBound**: localize는 L1로 어렵지 않고 멀티파일도 아니지만(L3 아님), 진짜 병목은 "django 컨버터 파이프라인을 알고 그 관용구로 INSERT 경로를 SELECT 경로와 동형으로 만드는" 도메인 지식이다. S6 구조변경은 가볍고 K-Domain이 dominant이므로 T-DesignRefactor보다 T-DomainBound가 맞다.

APR 관점에서 이 문제는 PAR/TBar류 템플릿(S1) 매칭이 안 된다 — 정형 결함클래스(None가드/off-by-one)가 아니라 "다른 경로엔 있는 처리 단계가 이 경로엔 누락"이라 인접 정답 경로(SELECT)에서 패턴을 transplant 해야 한다. 그래서 dominant가 S6(구조 재배치)이고, 올바른 `cols` 식 합성이 S2 보조다.

## 난이도 티어
**Tier = T4 (약간 어려움)**.

이 티어로 미는 구조적 피처:
- **파일/줄수**: gold patch는 1파일(`compiler.py`)·1함수(`execute_sql`)·~20줄 변경. 단일 헌크에 가깝다 → 단독으로는 T2~T3 신호.
- **localize 직접성**: L1. 키워드로 좁혀지지만 INSERT returning 경로라는 한 단계 추적 필요 → T3 가산.
- **repair 성격**: 즉시-return 3분기를 collect-then-process로 바꾸는 S6 구조변경 + 컨버터 적용 위치(커서 컨텍스트 종료 후)·`cols` 정렬 조건 추론(S2) → T4로 끌어올림.
- **K-Domain**: 컨버터 파이프라인을 모르면 못 푼다. 지식 병목이 dominant → T4의 핵심 근거.
- **regression-trap(P2P 12)**: `custom pks do not affect save`, `New objects can be created both with pk and the custom name`, `test_custom_field_pk` 등 INSERT/create 경로가 P2P에 다수 포함. 세 백엔드 분기 중 하나만 고치거나 converter 미존재 시 처리를 잘못하면 인접 동작이 깨진다.
- **overfit-risk**: FAIL_TO_PASS가 1개뿐이라 `from_db_value`만 특수 호출해도 통과할 수 있다(아래 함정 참고).

공식 difficulty 라벨은 **1-4 hours**로 본 분석의 T4와 **정합**한다. 시간 라벨이 잡지 못하는 overfit-risk(얇은 F2P)와 도메인 지식 병목까지 고려해도 T4가 적정이며, L3 멀티파일 조율이나 >100줄 대규모가 아니라 T5로는 올리지 않는다.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/sql/compiler.py` : `SQLInsertCompiler.execute_sql`
- **근본 원인**: `execute_sql`이 `fetch_returned_insert_rows` / `fetch_returned_insert_columns` / `last_insert_id` 세 백엔드 분기에서 각각 곧바로 `return` 했다. SELECT 경로는 `get_converters`/`apply_converters`로 DB 값을 필드 컨버터에 통과시키지만, INSERT returning 경로에는 그 단계 자체가 없어 raw DB 값이 그대로 모델 attribute로 들어갔다.
- **수정 요지**:
  - 상단에 `opts = self.query.get_meta()`를 호이스트. 이는 단순 중복제거가 아니다 — base에서 `get_meta()`는 분기마다 반복된 게 아니라 오직 `last_insert_id` 단일 분기에서만(그 안에서 `db_table`·`pk.column` 두 번) 호출됐다. 호이스트의 진짜 이유는, 새로 추가된 `cols = [field.get_col(opts.db_table) for field in self.returning_fields]` 라인이 `with cursor` 블록을 빠져나온 뒤(converter 후처리 단계)에 `opts`를 필요로 하기 때문이다. 즉 호이스트는 컨버터 후처리의 전제조건이다.
  - 세 분기의 즉시 `return`을 `rows` 로컬 변수에 대입하는 `if / elif / else`로 변경(`last_insert_id` 분기는 `opts.db_table`, `opts.pk.column` 사용).
  - `with cursor` 컨텍스트를 빠져나온 뒤, `self.returning_fields`에 대해 `field.get_col(opts.db_table)`로 컬럼 표현식 리스트 `cols`를 만들고 `self.get_converters(cols)` 호출.
  - `converters`가 있으면 `rows = list(self.apply_converters(rows, converters))`로 변환 후 `return rows`.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_auto_field_subclass_create` — `CustomAutoFieldModel.objects.create()`로 만든 객체의 `id`가 `MyWrapper` 인스턴스인지(`assertIsInstance(obj.id, MyWrapper)`) 검증.
- **테스트 셋업**: `tests/custom_pk/fields.py`에 `MyAutoField(models.BigAutoField)`를 신규 추가(`from_db_value`가 값을 `MyWrapper`로 감싸고 `get_prep_value`로 int 강제). 기존 `MyAutoField`(CharField 기반)는 `MyWrapperField`로 rename해 이름 충돌 회피. `tests/custom_pk/models.py`에 `CustomAutoFieldModel(id=MyAutoField)` 추가(기존 `Bar.id`는 `MyWrapperField`로 교체).
- **픽스 증명**: 픽스 전 `create()` 반환 객체의 `id`는 raw int → `assertIsInstance` 실패. 픽스 후 INSERT 반환값이 `apply_converters`를 거쳐 `MyWrapper`로 래핑되어 통과. 추가된 `test_auto_field_subclass_bulk_create`는 `@skipUnlessDBFeature('can_return_rows_from_bulk_insert')`로 게이트되어 지원 백엔드(예: PostgreSQL)에서 bulk 경로(`fetch_returned_insert_rows`)까지 동일 변환을 확인.
- **overfit 관점**: F2P가 사실상 단일 단언이라 얇다(`overfit-risk`). `last_insert_id` 분기만 컨버터를 적용하고 bulk 분기를 빼먹어도 SQLite F2P는 통과할 수 있다 — bulk_create 테스트가 `skipUnless`로 분리돼 있어 backend에 따라 안 돌기 때문. 골드는 세 분기를 한 지점으로 모아 공통 적용하므로 backend-무관하게 일반화된다.
- **regression 관점**: P2P 12개에 `custom pks do not affect save`, `New objects can be created both with pk and the custom name`, `test_custom_field_pk`, `test_unique_pk` 등 create/insert 경로가 다수 포함. `converters`가 없을 때는 `apply_converters`를 건너뛰고 `rows`를 그대로 반환해야(=`if converters:` 가드) 컨버터 없는 평범한 필드의 기존 동작을 보존한다.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈의 "on insert ... not passed through database converters" + `returning_fields` + `from_db_value` 신호 → INSERT의 returning 값을 처리하는 지점을 찾는다. `returning_fields`로 grep하면 `SQLInsertCompiler.execute_sql`이 유일한 핵심 후보로 수렴(L1). 동일 모듈의 SELECT 경로(`SQLCompiler.execute_sql`/`results_iter`)가 `get_converters`/`apply_converters`를 쓰는 것과 대조하면 INSERT 경로에 그 단계가 통째로 없음이 드러난다.

2. **픽스와 올바른 일반화 이유**: 세 백엔드 분기의 즉시 `return`을 `rows`로 모은 뒤, `returning_fields` 각각에 대해 `field.get_col(opts.db_table)`로 `cols`를 만들고 `get_converters(cols)` → `apply_converters(rows, converters)`를 적용한다. 이것이 올바른 일반화인 이유: (a) SELECT 경로가 이미 쓰는 검증된 컨버터 파이프라인을 그대로 재사용하므로 "다른 쿼리 경로와 동일하게"라는 이슈 요구와 정확히 동형. (b) 특정 필드의 `from_db_value`를 직접 호출하는 게 아니라 필드의 컨버터 등록 메커니즘을 통과시키므로 모든 컨버터 정의 필드에 동작. (c) `cols`를 `returning_fields` 기준으로 만들어 rows 컬럼 순서와 정렬이 맞는다.

3. **regression 안전**: `if converters:` 가드로 컨버터가 없는 평범한 필드는 변환을 건너뛰고 `rows`를 그대로 반환 → P2P의 `custom pks do not affect save`, `New objects can be created ...`, `test_custom_field_pk` 등 기존 create/save 동작 불변. 세 분기를 한 곳으로 모았으므로 SQLite(`last_insert_id`), `RETURNING` 지원(`fetch_returned_insert_columns`), bulk(`fetch_returned_insert_rows`) 모두에서 동일하게 동작 → 백엔드별 회귀 없음. 커서 컨텍스트 종료 후 변환해야 커서 점유 시간을 늘리지 않는다.

4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) `from_db_value`를 직접 호출하는 우회 구현. 이러면 컨버터가 `get_db_converters`로 여러 개 등록된 필드나 backend converter를 놓쳐 일반화 실패. → SELECT 경로의 `get_converters`/`apply_converters` 관용구를 transplant 해야 한다. (b) 세 분기 중 SQLite `last_insert_id` 분기만 고치고 bulk 분기를 빠뜨림. F2P(SQLite)는 통과하지만 backend별 회귀 — bulk 테스트가 `skipUnless`라 CI에서 안 잡힐 수 있다. → 세 분기를 collect-then-process로 통합해야 안전. (c) `cols`를 잘못된 db_table/필드 기준으로 만들어 converter-컬럼 정렬이 어긋남. → `opts.db_table` + `returning_fields`로 일관되게 구성. (d) 변환을 커서 컨텍스트 안에서 수행. → `with` 블록 밖으로 빼야 한다.
