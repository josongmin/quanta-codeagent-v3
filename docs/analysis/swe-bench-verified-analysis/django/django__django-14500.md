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
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap]
---

# django__django-14500

## 문제 요약
squash(압축) 마이그레이션을 unapply 할 때, 대체된(replaced) 마이그레이션 파일들이 디스크에 그대로 남아 있으면 `MigrationExecutor`가 squash 마이그레이션 자체는 unapplied로 기록하지 않는다. 결과적으로 replaced 마이그레이션들만 unapplied로 표시되고 squash 마이그레이션(`0001_squashed_0002` 같은 레코드)은 여전히 applied 상태로 남아 일관성이 깨진다. 이는 apply 경로가 squash와 그 구성요소를 **모두** applied로 기록하는 동작과 비대칭이다. 사용자는 squash 롤백 시 squash 레코드와 그 구성요소 레코드가 모두 unapplied로 정리되기를 기대한다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed).** 이슈 문구가 "unapply", "squashed migration", "replaced migration", "mark as unapplied"를 직접 명시 → `record_unapplied`를 호출하는 유일 지점인 `executor.py:unapply_migration`로 grep 한 방에 수렴한다. 후보 탐색이 거의 필요 없다.
- **S (Repair Strategy) = S2 (Constraint-Reasoning).** 고칠 위치는 자명하나, 올바른 픽스는 "else를 지우고 self-record를 무조건 호출한다"는 **불변식 추론**을 요구한다. 단순 체크 추가(S1 Direct-Map)가 아니다 — `if migration.replaces / else`가 왜 상호배타로 잘못 짜였는지, apply/unapply 대칭성이 어떤 불변식("squash 자신은 replaces 유무와 무관하게 항상 자기 상태를 기록")인지를 의미적으로 따져야 정답이 나온다. 단순히 `if` 블록 안에 self-record를 추가하면 비-squash 경로의 중복 기록을 유발한다.
- **K (Knowledge) = K-Domain.** django migrations의 squash/replaces 의미론, `MigrationRecorder`의 applied/unapplied 레코드 모델, apply 측(`record_migration` + `check_replacements`)과의 대칭성을 알아야 "무엇이 올바른 동작인가"를 판정할 수 있다. 일반 파이썬 추론(K-Gen)만으로는 분기 의도를 복원할 수 없다.
- **Primary type = T-ConstraintReason.** 위치는 명확(L0)하지만 진짜 난점이 "올바른 조건·분기 구조를 추론으로 합성"하는 데 있으므로 T-DirectMap이 아닌 T-ConstraintReason. APR 관점: 결함클래스 템플릿 매칭(None가드/off-by-one)으로 풀리지 않고, SemFix/Angelix 계열의 의미적 제약(apply↔unapply 대칭 불변식) 추론으로 분기를 재구성하는 문제다.

## 난이도 티어
**Tier = T3 (중간).** 공식 difficulty 라벨은 "15 min - 1 hour"(T2~T3 prior).

이 티어로 미는 구조적 피처:
- 수정 범위가 **1파일·1함수·4줄**(단일 헌크)로 매우 작다 → 이것만 보면 T2.
- localize 직접성은 L0로 최상 → repro 키워드가 함수를 직접 지목.
- 그러나 **S2 제약추론**이 핵심 난점: "else를 제거하고 무조건 호출"이라는 비자명한 분기 재구조화가 필요하고, apply/unapply 대칭성이라는 django migrations 도메인 불변식(K-Domain)을 잡아야 정답에 도달한다. 단순 가드 추가형(S1)이 아니라서 T2를 넘어선다.
- `has-repro`는 네이티브 스택트레이스 형태가 아니라 약함(이슈가 시나리오를 서술하지만 실행 가능한 repro는 미제공) → easiness 신호가 깎인다.
- `regression-trap`: PASS_TO_PASS 21건이 같은 `ExecutorTests`/migrations executor 인근 동작을 다수 커버 → 비-squash unapply 중복 기록 같은 인접 동작을 깨면 즉시 회귀.

L0의 쉬움과 S2+K-Domain의 어려움이 상쇄되어 T2와 T4 사이, **T3**가 방어 가능하다. 공식 라벨 상단(1시간)과 일치.

## 골드패치 분석
- **건드린 파일/함수:** `django/db/migrations/executor.py` → `MigrationExecutor.unapply_migration`.
- **근본 원인:** 기존 코드가 `if migration.replaces:` 와 `else:`의 **상호배타 분기**였다.
  - replaces가 있으면(=squash) `migration.replaces`의 구성요소 `(app_label, name)`들만 `record_unapplied` 하고,
  - `else`에서만 자기 자신 `(migration.app_label, migration.name)`을 `record_unapplied` 했다.
  - 따라서 squash 마이그레이션은 자기 자신을 **절대** unapplied로 기록하지 못했다. apply 쪽이 squash와 구성요소를 모두 applied로 기록하는 것과 비대칭.
- **수정 요지:** `else` 분기를 제거하고, replaces가 있을 때 구성요소들을 `record_unapplied` 한 뒤 **분기 밖에서 항상** `self.recorder.record_unapplied(migration.app_label, migration.name)`을 호출하도록 변경. 즉 squash 자신은 replaces 유무와 무관하게 항상 unapplied로 기록되고, replaces가 있는 경우 구성요소들도 추가로 기록된다. 주석도 "record individual statuses" → "also record individual statuses"로 의미를 명확화.

## 검증 (test_patch)
- **FAIL_TO_PASS (1건):** `test_migrate_marks_replacement_unapplied (migrations.test_executor.ExecutorTests)`. `MIGRATION_MODULES={'migrations': 'migrations.test_migrations_squashed'}`로 `0001_squashed_0002`와 구성요소 파일들이 모두 존재하는 시나리오를 구성.
- **픽스 증명:** executor로 `0001_squashed_0002`까지 migrate → `applied_migrations()`에 squash가 포함됨을 `assertIn`으로 확인. 이후 `loader.build_graph()` 후 target `None`으로 migrate(전체 unapply) → `applied_migrations()`에 `('migrations', '0001_squashed_0002')`가 더 이상 포함되지 않음을 `assertNotIn`으로 확인. 버그 코드에서는 unapply 시 `else` 미진입으로 squash 자신이 `record_unapplied` 되지 않아 여전히 applied로 남고 `assertNotIn`이 실패한다.
- **overfit 관점:** 픽스는 테스트의 특정 입력에 맞춘 special-case가 아니라 `unapply_migration`의 모든 경로에 적용되는 일반 불변식(self-record 무조건화)이라 overfit-risk 낮음. 따라서 `overfit-risk` 플래그 미부여.
- **regression 관점:** 비-squash 마이그레이션(replaces 없음)은 기존에도 `else`로 self-record 했고, 변경 후에는 분기 밖 무조건 호출로 **여전히 정확히 1회** 기록된다(중복 없음). squash 경로는 구성요소 + 자신을 기록. PASS_TO_PASS의 "A new squash migration will be marked as applied even if all its...", "Applying all replaced migrations marks replacement as applied (#24628)", "Tests running a squashed migration from zero..." 등 squash apply 동작이 안 깨지는지 검증한다 → `regression-trap` 플래그 정당.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈의 "unapply"/"squashed"/"replaced"/"mark as unapplied" 키워드 → `git grep record_unapplied`로 호출 지점을 찾으면 `executor.py:unapply_migration` 단 한 곳으로 수렴(L0). 거기서 `if migration.replaces / else` 분기를 즉시 발견.
2. **픽스와 왜 올바른 일반화인가:** apply 측을 대칭 비교하면(`record_migration`이 squash와 구성요소를 모두 applied로 기록) unapply는 self-record가 `else`에 갇혀 squash 자신을 빠뜨린다는 비대칭이 드러난다. 올바른 일반화는 "squash 마이그레이션의 self-status는 구성요소 기록 여부와 독립적으로 항상 기록되어야 한다"는 불변식 → `else` 제거 + 분기 밖 무조건 `record_unapplied(self)`. 이는 특정 squash 이름이 아닌 모든 마이그레이션에 적용되므로 overfit이 아닌 정답 일반화다.
3. **regression 안전:** 비-squash 경로(replaces 없음)는 변경 후에도 정확히 self만 1회 기록되어야 한다 — `if`에 진입하지 않으므로 분기 밖 호출이 유일한 기록이 되어 보존된다. squash apply 관련 P2P("marked as applied even if...", "#24628", "squashed migration from zero")와 atomic/rollback 계열 P2P를 깨지 않는지 확인.
4. **함정 회피:** 오라클 없는 에이전트가 흔히 저지를 실수는 (a) `if migration.replaces` 블록 **안에** self-record를 추가하는 것 — 이러면 비-squash 경로는 여전히 `else`로 self-record하고 squash 경로는 구성요소+self를 기록하지만, 만약 `else`를 안 지우면 로직은 맞아도 중복/혼란이 남고, `else`를 지우되 self-record를 `if` 안에 두면 비-squash가 self-record를 잃는다. 정답은 **`else` 제거 + 분기 밖 무조건 호출** 한 형태뿐이다. (b) 구성요소(`migration.replaces`)만 추가 기록하고 squash 자신을 빼먹는 것 — 정확히 원래 버그 방향. apply/unapply 대칭과 "replaces 유무와 무관한 self-record" 불변식을 명시적으로 잡으면 두 함정 모두 회피된다.
