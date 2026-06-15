---
instance_id: django__django-14500
repo: django/django
base_commit: 8c3bd0b708b488a1f6e8bd8cc6b96569904605be
version: 4.0
difficulty: 15 min - 1 hour
created_at: 2021-06-08T05:08:08Z
fail_to_pass: 1
pass_to_pass: 21
gold_files: [django/db/migrations/executor.py]
---

# django__django-14500

## 문제 요약
squash(압축) 마이그레이션을 unapply 할 때, 대체된(replaced) 마이그레이션 파일들이 디스크에 그대로 남아 있으면 MigrationExecutor가 squash 마이그레이션 자체는 unapplied로 기록하지 않는다. 결과적으로 replaced 마이그레이션들만 unapplied 표시되고 squash 마이그레이션은 여전히 applied 상태로 남아 일관성이 깨진다. 사용자는 squash 롤백 시 squash 레코드와 그 구성요소 레코드가 모두 unapplied로 정리되기를 기대한다.

## 유형 분류
- 버그 카테고리: logic (잘못된 if/else 분기) / 누락처리
- 서브시스템: django migrations executor (마이그레이션 기록 상태 관리)
- 증상 타입: silent-wrong (예외 없이 마이그레이션 상태 기록이 틀림)
- 로컬라이제이션 신호: "마이그레이션을 unapply", "squash 마이그레이션", "replaced 마이그레이션", "as unapplied" → unapply 경로에서 record_unapplied를 호출하는 코드, 즉 `executor.unapply_migration`이 직접 지목된다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/migrations/executor.py:unapply_migration`
- 근본 원인: 기존 코드가 `if migration.replaces:` 와 `else:` 의 상호배타 분기였다. replaces가 있으면 구성요소(`migration.replaces`)들만 record_unapplied 하고, else에서만 자기 자신(`migration.app_label/name`)을 record_unapplied 했다. 따라서 squash(replaces 있음) 마이그레이션은 자기 자신을 절대 unapplied로 기록하지 못했다. 이는 apply 쪽에서 squash와 구성요소를 모두 applied로 기록하는 동작과 비대칭이다.
- 수정 요지: `else` 분기를 제거하고, replaces가 있을 때 구성요소들을 record_unapplied 한 뒤 분기 밖에서 항상 `self.recorder.record_unapplied(migration.app_label, migration.name)`을 호출하도록 변경. 즉 squash 마이그레이션 자신은 replaces 유무와 무관하게 항상 unapplied로 기록되고, replaces가 있는 경우 구성요소들도 추가로 기록된다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_migrate_marks_replacement_unapplied` — `test_migrations_squashed` 모듈(`0001_squashed_0002`, 구성요소 파일들 존재)을 사용.
- 테스트가 어떻게 픽스를 증명하는지: executor로 `0001_squashed_0002`까지 migrate → `applied_migrations()`에 squash가 포함됨을 확인. 그 뒤 `build_graph()` 후 target None으로 migrate(전체 unapply) → `applied_migrations()`에 `('migrations', '0001_squashed_0002')`가 더 이상 포함되지 않음을 assertNotIn으로 확인. 버그 코드에서는 unapply 시 squash 자신이 record_unapplied 되지 않아 여전히 applied로 남아 assertNotIn이 실패한다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: `migrations/executor.py`에서 `record_unapplied`를 호출하는 유일 지점인 `unapply_migration`. apply 쪽의 `record_migration`/`check_replacements`와 대칭으로 비교하면 unapply만 self-record가 누락됨이 드러난다.
- 함정/난이도 메모: 단일 파일·단일 함수의 4줄 변경으로 패치 자체는 작다. 다만 "else를 지워야 한다"는 점이 함정 — 단순히 if 안에 record를 추가하면 비-squash 마이그레이션이 중복 기록될 수 있으니, else 제거 + 무조건 호출로 정리해야 한다. squash의 apply/unapply 대칭성을 이해하지 못하면 구성요소 쪽만 손대는 잘못된 수정을 하기 쉽다.
- 우리 에이전트 관점: 막힐 지점은 재현 시나리오 구성. "replaced 파일이 남아 있을 때만" 발생하는 조건을 이해해야 하고, MigrationRecorder의 applied/unapplied 의미를 정확히 잡아야 한다. 로컬라이제이션은 쉬우나(키워드가 함수를 직접 가리킴), 분기 의도(상호배타가 왜 잘못인지)를 파악해 else 제거라는 미묘한 형태로 고치는 것이 핵심 난이도다.
