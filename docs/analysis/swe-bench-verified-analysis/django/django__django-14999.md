---
instance_id: django__django-14999
repo: django/django
base_commit: a754b82dac511475b6276039471ccd17cc64aeb8
version: "4.1"
difficulty: <15 min fix
created_at: 2021-10-16T09:31:21Z
fail_to_pass: 1
pass_to_pass: 113
gold_files: [django/db/migrations/operations/models.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L0
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [regression-trap]
---

# django__django-14999

## 문제 요약
이미 명시적 `db_table`이 정의된 모델에 `RenameModel` 마이그레이션 연산을 적용하면, 실제 테이블명은 바뀌지 않는데도 DB 작업이 발생한다. Postgres에서는 FK 제약을 drop 후 재생성하고, sqlite에서는 테이블을 통째로 재생성한다. 사용자는 db_table이 고정돼 물리 테이블명이 그대로이므로 이 연산이 noop(아무 DB 쿼리도 발생하지 않음)이길 기대한다.

## 유형 (정형화)
- **L = L0 (Pinpointed)**: problem_statement가 `RenameModel`과 `db_table`을 심볼 단위로 직접 지목한다. migrations 연산 클래스이므로 `django/db/migrations/operations/models.py`의 `RenameModel.database_forwards`로 grep 한 방에 수렴한다. 후보 탐색이 사실상 없다.
- **S = S2 (Constraint-Reasoning), 보조 S1**: 픽스 자체는 early-return 가드(S1 템플릿: None가드/경계가드류)지만, **가드 조건을 무엇으로 잡느냐**가 비자명하다. "모델명이 같으면 noop"은 틀린다(이름은 Rider→Runner로 분명히 바뀜). 올바른 불변식은 `old_model._meta.db_table == new_model._meta.db_table` — 물리 테이블명 동일성이다. 이 조건을 추론으로 합성해야 하므로 dominant는 S2, 가드 삽입의 기계적 형태는 S1.
- **K = K-Domain (Domain-bound)**: `_meta.db_table`이 명시 db_table일 때는 모델명과 무관하게 고정된다는 사실, `RenameModel`이 메인 테이블 ALTER 외에 related_objects/M2M까지 건드린다는 사실, `database_backwards`가 forwards를 swap 호출한다는 사실 — 모두 django migrations/_meta 도메인 지식이다. 일반 파이썬 추론만으론 도달 불가.
- **primary type = T-DomainBound**: 위치는 L0로 자명하고 픽스도 ~5줄이지만, 병목은 "alter_db_table을 언제 건너뛰는 게 정당한가"라는 django 스키마-에디터/`_meta` 도메인 모델에 있다. 그래서 T-DirectMap(순수 기계적)이 아니라 T-DomainBound가 dominant. APR 관점으로 가드의 *형태*는 template repair지만 *조건 합성*은 도메인 불변식 추론이라 S2가 strategy를 지배한다.

## 난이도 티어
- **티어 = T4 (약간 어려움)**.
- 미는 피처: (1) 1파일·1함수·~5줄이라 patch scope는 T1~T2급으로 작다. (2) 그러나 **K-Domain 의존**(db_table 동일성 불변식 + schema_editor 부작용 모델)이 핵심 병목이라 T4의 "도메인지식 중 하나" 조건에 해당. (3) **regression-trap이 비교적 무겁다**: P2P 113개 중 다수가 `RenameModel`/`AlterModelTable`/related_objects/M2M 경로(`test_rename_model_with_m2m`, `test_rename_m2m_through_model`, `Tests the RenameModel operation.`, `AlterModelTable should rename auto-generated M2M tables.` 등)라, 가드를 잘못된 위치(related_objects 루프 내부)에 두면 정상 rename이 깨진다.
- **공식 라벨(<15분)과의 차이**: 공식은 "개발자 구현시간"이라 한 번 핵심 통찰(db_table 동일성)을 잡으면 5줄이라 15분 안에 끝난다 — 그래서 <15min이 맞다. 그러나 에이전트 난이도 축에서는 그 통찰 자체(이름이 아니라 _meta.db_table을 비교)가 도메인지식 게이트이고, 잘못된 가드 조건/위치가 P2P 회귀를 부른다. localize는 쉬워도 조건 합성+회귀안전이 T2를 넘기므로 T4로 상향한다(루브릭: 시간라벨은 localize 어려움·overfit·회귀trap을 못 잡음).

## 골드패치 분석
- **건드린 파일/함수**: `django/db/migrations/operations/models.py` : `RenameModel.database_forwards`
- **근본 원인**: `database_forwards`가 모델명만 보고 무조건 `schema_editor.alter_db_table(new_model, old_model._meta.db_table, new_model._meta.db_table)`를 호출했다. 명시 `db_table`이 있으면 모델명을 Rider→Runner로 바꿔도 `_meta.db_table` 값은 동일한데, 이 경우를 구분하지 않아 같은 테이블명으로 ALTER를 실행 → 백엔드별 부작용(Postgres FK drop/recreate, sqlite 테이블 재생성)이 발생.
- **수정 요지**: `old_db_table = old_model._meta.db_table` / `new_db_table = new_model._meta.db_table`로 추출한 뒤, `if old_db_table == new_db_table: return`으로 조기 종료(noop). 두 값이 다를 때만 기존처럼 `schema_editor.alter_db_table(new_model, old_db_table, new_db_table)`를 호출하고 이어서 `old_model._meta.related_objects` 루프 등 후속 처리를 진행한다. 가드는 메인 테이블 ALTER와 related_objects 처리 **둘 다의 상류**에 위치하므로 noop일 때 부수 테이블 작업도 함께 차단된다. `database_backwards`는 내부적으로 forwards를 swap 호출하므로 별도 수정 없이 함께 noop가 된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_rename_model_with_db_table_noop (migrations.test_operations.OperationTests)`.
- **동작**: `options={'db_table': 'rider'}`로 db_table을 고정한 Rider 모델과 이를 FK로 참조하는 Pony를 생성한 뒤 `RenameModel('Rider', 'Runner')`를 수행. `database_forwards`와 `database_backwards`를 각각 실 `connection.schema_editor()`로 실행하면서 둘 다 `with self.assertNumQueries(0):`로 감싼다. db_table이 바뀌지 않으므로 SQL이 단 한 건도 나가면 안 된다.
- **픽스 증명**: 패치 전에는 alter_db_table → FK 재생성/테이블 재생성 쿼리가 발생해 쿼리수 > 0이라 실패. 패치 후 `old_db_table == new_db_table` 가드로 조기 return → 정확히 0건이 되어 통과.
- **overfit 관점**: 가드 조건이 `_meta.db_table` 동일성이라는 **일반 불변식**이지 테스트 상수('rider')에 묶이지 않아 overfit-risk 없음 — 그래서 flags에 미포함. assertNumQueries(0)는 부분 감소가 아닌 완전 0을 요구하므로 "쿼리 일부만 줄이는" 부분 픽스를 거부하는 강한 oracle이다.
- **regression 관점**: P2P 113개가 인접 동작(정상 RenameModel, M2M rename, AlterModelTable, related_objects)을 광범위하게 커버한다. 가드를 함수 진입 상류에 두면 db_table이 *다른* 통상 rename은 그대로 통과하므로 회귀가 막힌다 → regression-trap 플래그는 실재하나 골드 위치가 안전하게 회피.

## 모범답안 (오라클 기반)
1. **localize 경로**: problem_statement의 "RenameModel" + "db_table" + "noop"을 키로 `django/db/migrations/operations/models.py`의 `RenameModel` 클래스를 열고, 부작용(FK drop/recreate, 테이블 재생성)이 실제로 발생하는 메서드인 `database_forwards`로 진입. 부작용의 진원지는 `schema_editor.alter_db_table(...)` 호출이므로 그 직전이 가드 후보 지점.
2. **픽스와 일반화 정당성**: noop 판정 기준을 **모델명 동일성이 아니라 `_meta.db_table` 동일성**으로 잡는다. 명시 db_table이 있을 때 모델명은 바뀌어도 물리 테이블명은 고정 — 이것이 "테이블이 안 바뀌면 ALTER도 불필요"라는 의미적 불변식이다. 따라서 `old_model._meta.db_table == new_model._meta.db_table`일 때 return. 이는 테스트 상수가 아니라 db_table의 의미에 근거하므로 미명시 db_table(auto-generated)·M2M·향후 백엔드 모두에 올바르게 일반화된다.
3. **regression 안전**: 안 깨야 할 P2P는 db_table이 *실제로* 바뀌는 정상 경로 — `Tests the RenameModel operation.`, `test_rename_model_with_m2m`, `test_rename_m2m_through_model`, related_objects/M2M 재명명, `AlterModelTable should rename auto-generated M2M tables.` 등. 가드를 함수 상류 단일 분기로 두면 db_table이 다른 케이스는 조건이 거짓이라 기존 경로를 그대로 타므로 이들이 보존된다.
4. **함정 회피**: (a) **잘못된 조건** — "old_name == new_name이면 noop"이나 모델명 비교로 가면 db_table 고정 케이스를 못 잡아 FAIL_TO_PASS 실패. 반드시 `_meta.db_table`을 비교해야 함. (b) **잘못된 위치** — 가드를 `related_objects` 루프 내부에 두면 메인 테이블 ALTER만 막고 FK/M2M 부수 작업이 새서 assertNumQueries(0)를 못 맞춘다. 반드시 `alter_db_table` 호출과 후속 루프 *모두의 상류*에 둘 것. (c) **과잉수정** — `database_backwards`를 따로 고치려는 유혹이 있으나 forwards swap 구조라 불필요하고, 손대면 P2P 회귀 위험만 키운다. (d) **부분 픽스** — 쿼리를 줄이기만 하면 oracle(완전 0건)을 못 넘으므로 early-return으로 경로 전체를 차단해야 한다.
