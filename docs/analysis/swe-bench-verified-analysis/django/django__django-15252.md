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
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, underspecified, cross-file-dep]
---

# django__django-15252

## 문제 요약
멀티 DB 환경에서 `db_router`의 `allow_migrate` 규칙이 `MigrationRecorder`에 의해 무시되어, 마이그레이션을 적용하면 안 되는 연결(읽기 전용 또는 관리 대상이 아닌 DB)에도 `django_migrations` 테이블이 생성되거나 권한 오류(`ProgrammingError`)가 발생한다. 특히 `TEST: {'MIGRATE': False}`로 마이그레이션을 끈 테스트 DB에서도 앱 동기화(sync_apps) 과정에서 Django가 `migrate`를 호출하며, `MigrationExecutor.migrate()`가 진입 즉시 `recorder.ensure_schema()`를 무조건 실행해 불필요하게 `django_migrations` 테이블을 만들려 한다. 사용자 기대는 "적용·기록할 마이그레이션이 없으면 그 DB에 어떤 테이블도 만들지 않는다"이다.

## 유형 (정형화)
- **L (Localization) = L1 (Traceable).** problem_statement와 hints가 `django/db/migrations/executor.py`와 `recorder.py`의 `ensure_schema`/`record_applied`를 이름으로 지목하지만, 정작 골드 수정 지점은 `recorder.ensure_schema`(이슈가 가장 많이 가리킨 곳)가 아니라 그것을 호출하는 상위 `MigrationExecutor.migrate()` 진입부다. 즉 "지목된 심볼"과 "고쳐야 할 심볼"이 한 단계 어긋나 있어 grep 한 방(L0)은 아니고, 호출 그래프를 한 단계 거슬러 올라가는 약한 탐색이 필요하다.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S5 Spec-Inference).** 단순 None-가드/상수 변경이 아니다. 올바른 조건식(`plan == []` 일 때만, 그리고 `not has_table()` 일 때만 schema 생성을 건너뛴다)과 그때 반환해야 할 값(`_create_project_state(with_applied_migrations=False)`)을 불변식 추론으로 합성해야 한다. 핵심은 `plan is None`(아직 계산 전 → 계산해서 ensure_schema 필요)과 `plan == []`(이미 계산된 빈 plan → 기록할 게 없음)을 의미적으로 구분하는 것. 보조로 S5: 이슈 본문은 "라우터 버그냐 프레임워크 버그냐"로 장황하게 흩어져 있고 최종 의도("기록할 게 없으면 테이블을 만들지 마라")는 마지막 코멘트에서야 스펙으로 재구성된다.
- **K (Knowledge) = K-Domain.** Django migrations executor/recorder의 lifecycle(ensure_schema → has_table → record_applied), `MigrationExecutor.migrate`가 sync_apps 경로에서 `plan=[]`로 호출된다는 사실, `_create_project_state` 반환 계약을 알아야 한다. 일반 파이썬 추론(K-Gen)으로는 빈 plan 분기가 안전한지 판단 불가.
- **Primary type = T-ConstraintReason.** 위치는 좁게 수렴(L1)하지만 진짜 난점은 "어디"가 아니라 올바른 조건·반환값을 의미 추론으로 합성하는 데 있다. T-DomainBound 후보도 있으나 도메인 지식은 picker(조건 합성)를 돕는 보조이고 dominant는 constraint reasoning이다.

## 난이도 티어
**T4 (약간 어려움).** 공식 difficulty 라벨은 "15 min - 1 hour"(T2~T3급 개발자 시간). 본 분류는 T4로 한 단계 상향한다.

- T4로 미는 구조적 피처: (1) **localize 미스디렉션** — 이슈가 `ensure_schema`/`recorder.py`를 집중적으로 가리키지만 골드는 그 함수가 아니라 상위 `executor.migrate`를 고친다(L1, 한 단계 어긋남). 에이전트가 지목된 심볼에 그대로 패치하면 틀린다. (2) **S2 의미 추론** — `plan is None` vs `plan == []` 구분은 한 글자 차이지만 인과적으로 다르며, 잘못 합치면 정상 migrate 경로(plan을 계산해야 하는 경우)의 ensure_schema까지 죽인다. (3) **underspecified** — Verified 38% 기저율에 부합, 이슈가 해법이 아니라 증상·논쟁 위주. (4) **regression-trap** — P2P 34개 중 다수가 executor의 일반 마이그레이션 적용(`Tests running a simple set of migrations`, squashed/atomic/replaced 등)이라 분기를 잘못 넣으면 광범위하게 깨진다.
- 공식 라벨과 다른 이유: 시간 라벨은 "정답 위치를 아는 개발자의 구현 시간"(5줄, 빠름)만 잡는다. 하지만 에이전트 난이도를 결정하는 localize 미스디렉션과 빈-plan 조건의 미묘함은 시간 라벨에 안 잡힌다 — 그래서 구조 피처 기준 T4. 다만 단일 파일·5줄·단일 헌크라 T5 이상(멀티파일 조율/overfit 고위험)은 아니다.

## 골드패치 분석
- **건드린 파일/함수:** `django/db/migrations/executor.py` 단일 파일, `MigrationExecutor.migrate()` 진입부.
- **근본 원인:** `migrate()`가 진입하자마자 무조건 `self.recorder.ensure_schema()`를 호출했다. `ensure_schema()`는 `django_migrations` 테이블이 없으면 `CREATE TABLE`을 시도한다. 그런데 `TEST['MIGRATE']=False` 등으로 적용할 마이그레이션이 없어(`plan == []`) 실제로는 아무것도 기록하지 않을 상황에서도 이 DDL이 선행되므로, 라우터가 막은 DB나 read-only 연결에서 불필요한 테이블 생성/권한 오류가 발생했다.
- **수정 요지:** 무조건 호출을 조건 분기로 교체.
  ```python
  if plan == []:
      if not self.recorder.has_table():
          return self._create_project_state(with_applied_migrations=False)
  else:
      self.recorder.ensure_schema()
  ```
  `plan == []`(적용할 게 명시적으로 없음)이고 테이블이 아직 없으면(`not has_table()`) schema를 만들지 않고 빈 project state(`with_applied_migrations=False`)를 반환해 조기 종료한다. 그 외(`plan`이 None=미계산 또는 비어있지 않음)에는 기존대로 `ensure_schema()` 호출. 라우터/`allow_migrate`는 건드리지 않고 "기록할 게 없으면 테이블도 안 만든다"로만 푼다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2):**
  - `test_migrate_test_setting_false_ensure_schema` (backends.base.test_creation): `TEST['MIGRATE']=False`로 테스트 DB를 만들 때 `MigrationExecutor.ensure_schema`(recorder)가 호출되지 않음(`mocked_ensure_schema.assert_not_called()`)을 검증하고, 동시에 앱 sync는 여전히 일어남(`mocked_sync_apps.assert_called()`, 인자 `{'app_unmigrated'}`)을 확인해 "schema는 안 만들되 sync는 유지"라는 의도를 정확히 못박는다.
  - `test_migrate_skips_schema_creation` (migrations.test_executor): `has_table`를 False로 mock한 뒤 `executor.migrate([], plan=[])`를 `with self.assertNumQueries(0)` 안에서 실행 — schema 생성 쿼리가 0건임을 보증.
- **픽스 증명:** 빈 plan(`plan=[]`) + 테이블 없음(`has_table=False`) 입력에서 골드 분기가 조기 반환하므로 `ensure_schema`/DB 쿼리가 전혀 발생하지 않는다. 기존(무조건 ensure_schema)이면 쿼리가 발생해 `assertNumQueries(0)`와 `assert_not_called()`가 깨진다 — 즉 두 테스트가 분기를 직접 관찰한다.
- **overfit 관점:** `assert_not_called` + `assertNumQueries(0)` 두 각도로 동일 동작(부작용 부재)을 잡지만, `plan == []` 분기만 통과하면 둘 다 만족하므로 special-case 골드와 잘 정합한다. overfit 위험은 낮음 — 테스트가 관찰하는 invariant(빈 plan일 때 DDL 0)가 곧 의도된 일반 동작이라 overfit-risk 플래그는 부여하지 않는다.
- **regression 관점:** test_patch가 `false`/`true`/`mark_*` 기존 테스트의 `@mock.patch` 데코레이터를 메서드 단위로 재배치하고 인자 순서를 바꾼 것은 새 분기가 정상 migrate 경로(`plan != []`)를 건드리지 않음을 P2P로 확인하기 위함. P2P 34개의 일반 마이그레이션 적용/squashed/atomic 시나리오가 그대로 통과해야 하므로 regression-trap이 실재한다.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈가 `recorder.ensure_schema`를 가장 강하게 가리키지만, 마지막 코멘트("it shouldn't try to create the migration table on a database if it doesn't need to record any migrations there")가 진짜 신호다. `ensure_schema`의 호출자를 역추적하면 `MigrationExecutor.migrate()` 진입부에서 무조건 호출됨을 발견 → 여기가 "기록할 게 없는지"를 판단할 수 있는 유일한 상위 지점이므로 수정 대상은 recorder가 아니라 executor.migrate.
2. **픽스와 올바른 일반화:** `migrate()` 진입부에서 `plan == []`(이미 계산된 빈 plan = 적용할 게 없음)이고 테이블이 없으면 schema를 만들지 않고 빈 state로 조기 반환한다. 이게 올바른 일반화인 이유: 라우터별 특수 분기를 추가(`router.allow_migrate(...)` 호출)하는 hint 방향은 모든 DB·모델 조합에 대해 정책을 재구현하는 과한 결합이지만, "기록할 마이그레이션이 0개면 테이블도 불필요"라는 명제는 라우터·DB·권한과 무관하게 항상 참인 불변식이라 router를 몰라도 옳다. read-only DB 권한 오류, 멀티 DB 라우팅, 테스트 sync 케이스를 단 하나의 조건으로 한꺼번에 덮는다.
3. **regression 안전:** `plan is None`(아직 plan 미계산) 경로와 `plan != []`(적용할 게 있음) 경로는 반드시 기존대로 `ensure_schema()`를 타야 한다. P2P의 `Tests running a simple set of migrations`, squashed/atomic/replaced/rollback 시나리오는 전부 비어있지 않은 plan이므로 `else` 분기로 흘러 영향이 없어야 한다. `if plan == []` 안에 `not has_table()` 가드를 둔 것도 중요 — 테이블이 이미 있으면 굳이 분기하지 않고 일반 흐름을 유지해 기존 동작 보존.
4. **함정 회피:** (a) 지목된 `recorder.ensure_schema`/`record_applied`를 직접 고치거나 거기에 `router.allow_migrate` 검사를 넣는 큰 패치 — hint가 유도하지만 골드는 거부한다(과결합·과수정). (b) `plan == []`을 `not plan`이나 `plan is None`과 혼동 — `plan is None`은 "아직 계산 안 함"이라 ensure_schema가 필요하고, `not plan`은 None까지 삼켜 정상 경로를 죽인다. 빈 리스트 동등 비교가 의미적으로 필수. (c) 조기 반환 시 `_create_project_state(with_applied_migrations=False)` 반환을 누락 — 후속 코드가 project state를 받지 못해 깨진다. 오라클 없는 에이전트는 이슈의 장황한 라우터 논쟁에 끌려 (a)로 빠지기 쉽고, (b)/(c)의 미묘함에서 막힌다.
