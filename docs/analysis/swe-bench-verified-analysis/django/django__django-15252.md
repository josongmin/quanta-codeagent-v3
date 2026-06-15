---
instance_id: django__django-15252
repo: django/django
base_commit: 361bb8f786f112ee275be136795c0b1ecefff928
version: 4.1
difficulty: 15 min - 1 hour
created_at: 2021-12-28T15:51:06Z
fail_to_pass: 2
pass_to_pass: 34
gold_files: [django/db/migrations/executor.py]
---

# django__django-15252

## 문제 요약
멀티 DB 환경에서 `db_router`의 `allow_migrate` 규칙이 `MigrationRecorder`에 의해 무시되어, 마이그레이션을 적용하면 안 되는 연결(예: 읽기 전용 또는 관리 대상이 아닌 DB)에도 `django_migrations` 테이블이 생성되거나 권한 오류가 발생한다. 특히 `TEST: {'MIGRATE': False}`로 마이그레이션을 끈 테스트 DB에서도 앱 동기화(sync) 과정에서 `migrate`가 호출되며, `ensure_schema()`가 불필요하게 테이블을 만들려 한다. 사용자는 적용할 마이그레이션이 없으면 해당 DB에 어떤 테이블도 만들지 않기를 기대했다.

## 유형 분류
- 버그 카테고리: 누락처리 / edge-case (빈 plan일 때 schema 생성을 건너뛰지 않음)
- 서브시스템: django migrations executor / recorder (멀티 DB 라우팅)
- 증상 타입: 불필요한 부작용(테이블 생성) + 권한 오류 크래시(read-only 연결)
- 로컬라이제이션 신호: problem_statement가 직접 `django/db/migrations/executor.py`의 `migrate`/`apply_migration`과 `recorder.py`의 `ensure_schema`/`record_applied`를 지목. 마지막 코멘트가 "적용할 마이그레이션이 없으면 migration 테이블을 만들지 말아야 한다"고 해법 방향까지 명시.

## 골드패치 분석
- 건드린 파일/함수: `django/db/migrations/executor.py` : `MigrationExecutor.migrate()`
- 근본 원인: `migrate()`가 진입하자마자 무조건 `self.recorder.ensure_schema()`를 호출했다. plan이 비어 있어(적용할 게 없어) 실제로 아무 마이그레이션도 기록하지 않을 상황에서도 `django_migrations` 테이블 생성을 시도하므로, 라우터가 막은 DB나 read-only DB에서 불필요한 DDL/권한 오류가 발생했다.
- 수정 요지: `ensure_schema()` 무조건 호출을 조건 분기로 교체. `plan == []`(적용할 게 명시적으로 없음)이면 테이블이 아직 없을 때(`not self.recorder.has_table()`) schema를 만들지 않고 `self._create_project_state(with_applied_migrations=False)`를 반환해 조기 종료한다. 그 외(`plan`이 None이거나 비어있지 않음)에는 기존대로 `ensure_schema()`를 호출한다. 즉 "기록할 마이그레이션이 없으면 테이블도 만들지 않는다".

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `test_migrate_test_setting_false_ensure_schema`: `TEST['MIGRATE']=False`로 테스트 DB를 만들 때 `MigrationExecutor.ensure_schema`가 호출되지 않음(`mocked_ensure_schema.assert_not_called()`)을 검증하고, 앱 sync는 여전히 일어남(`mocked_sync_apps` 호출, `{'app_unmigrated'}`)을 함께 확인.
  - `test_migrate_skips_schema_creation` (migrations.test_executor): `has_table`를 False로 mock한 뒤 `executor.migrate([], plan=[])`를 `assertNumQueries(0)` 안에서 실행 — schema 생성 쿼리가 0건임을 보증한다.
- 테스트가 픽스를 증명하는 방식: 빈 plan(`plan=[]`)이고 테이블이 없는(`has_table=False`) 입력에서, 골드 분기가 조기 반환하므로 `ensure_schema`/DB 쿼리가 전혀 발생하지 않는다. 기존 동작(무조건 ensure_schema)이면 쿼리가 발생하므로 assertion이 실패한다. 기존 `false`/`true` 테스트는 데코레이터 인자 순서만 재배치되어 회귀가 없음을 보장.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement·hints가 `executor.py`/`recorder.py`를 직접 지목하므로 `MigrationExecutor.migrate` 진입부의 `ensure_schema()` 호출을 먼저 본다. 마지막 hint("기록할 게 없으면 테이블 만들지 마라")가 골드 분기 위치(executor.migrate)를 정확히 지시.
- 함정/난이도 메모: 토론 길이에 비해 실제 변경은 5줄. `recorder.py`의 `ensure_schema`/`allow_migrate`를 손대거나 라우터 전수 검사를 추가하려는 방향(hint에 등장)은 오버엔지니어링 — 골드는 router를 건드리지 않고 `plan == []` 조기 종료로만 해결한다. `_create_project_state(with_applied_migrations=False)` 반환값을 빠뜨리면 후속 코드가 state를 받지 못해 깨진다. `plan is None`(아직 계산 전)과 `plan == []`(계산 결과 빈 plan)를 구분하는 것이 핵심.
- 우리 에이전트 관점: problem_statement가 장황하고 "라우터 버그 vs 프레임워크 버그" 논쟁이 길어, 라우터/`allow_migrate` 호출을 추가하는 잘못된 큰 패치로 빠지기 쉽다. 실제 최소 수정은 `migrate()`의 단일 분기라는 점을 hint 후반부에서 잡아내야 하며, `plan == []` 빈 리스트 비교(`is None`과 다름)의 미묘함이 막힐 지점.
