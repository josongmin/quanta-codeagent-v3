---
instance_id: django__django-16116
repo: django/django
base_commit: 5d36a8266c7d5d1994d7a7eeb4016f80d9cb0401
version: 4.2
difficulty: <15 min fix
created_at: 2022-09-25T23:54:49Z
fail_to_pass: 1
pass_to_pass: 137
gold_files: [django/core/management/commands/makemigrations.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S6)
knowledge: K-API
flags: [regression-trap, has-repro]
---

# django__django-16116

## 문제 요약
`makemigrations --check`는 변경분이 있으면 비정상 종료 코드를 반환하지만, 그 전에 실제로 마이그레이션 파일을 디스크에 써버린다. 이는 `migrate --check`나 `optimizemigration --check`가 아무것도 쓰지 않고 그냥 종료(possibly logging a bit)하는 동작과 불일치한다. 사용자는 "누락된 마이그레이션이 있는지"만 검사하고 싶어 `--check`를 쓰는데, 파일을 안 만들려면 `--dry-run`을 함께 줘야 하는 비일관성이 있었다. 이슈는 명시적으로 "makemigrations --check should just exit without making migrations"를 요청하고, 메인테이너 hint("I think this makes sense.")까지 합의된 상태다. 기대 동작은 `--check` 단독으로 파일 생성 없이 종료.

## 유형 (정형화)

- **L (Localization) = L0 (Pinpointed).** problem_statement가 `makemigrations --check`를 문자 그대로 지목한다. grep `--check`/`check_changes` 한 방이면 `makemigrations.py`의 `handle()` 분기로 직행. 후보 탐색이 사실상 없음.
- **S (Repair Strategy) = S1 Direct-Map (+S6 보조).** 이슈가 픽스를 사실상 명세한다("just exit without making migrations"). 픽스의 본질은 `if check_changes: sys.exit(1)`을 두 write 호출(`write_to_last_migration_files`/`write_migration_files`)보다 **앞으로** 옮기는 statement 재배치 — 정형 결함클래스(잘못된 부수효과 순서)에 템플릿 매칭. 새 식을 추론 합성할 필요가 없으니 S2가 아니다. 다만 단순 "한 토큰 변경"이 아니라 두 write 분기 공통 상위로 exit를 끌어올리는 **소규모 제어흐름 재배치**라 S6(Design-Refactor)를 보조로 단다 — collect/write 단계의 lifecycle 순서를 바꾸는 성격.
- **K (Knowledge) = K-API.** 일반 파이썬 추론으로 한 줄을 옮길 순 있으나, "왜/어디까지" 옮길지는 django 명령어 계약 지식을 요한다: `migrate --check`/`optimizemigration --check`의 기존 의미와 **일관**되게 맞춰야 하고, `--check` 옵션의 공개 동작(부수효과 없음)을 새로 확정한다. CLI 동작은 사용자에게 노출된 계약이라 K-Gen보다 K-API가 정확. 골드가 help 텍스트("and don't actually write them.")까지 수정한 것이 계약 변경임을 방증.
- **primary type = T-DirectMap.** 위치 명확(L0) + S1 기계적 픽스(부수효과 순서 교정). T-LocTrivial이 아닌 이유: 픽스가 자명한 1-토큰이 아니라 exit를 정확한 스코프(두 write 공통 상위, 단 "changes 있음" else 분기 내부)로 위치시키는 판단이 들어가고 회귀면이 넓기 때문.

## 난이도 티어
**T2 (쉬움).** 공식 라벨 `<15 min fix`와 일치한다.

이 티어로 미는 구조적 피처:
- **파일·줄수:** 단일 파일(`makemigrations.py`), 본질 변경은 ~4줄(exit 2줄 이동 + help 텍스트). 1파일·소규모는 T1~T2 구간.
- **localize 직접성:** L0 — 이슈가 심볼을 지목, 탐색 비용 0. has-repro에 준하는 강한 신호(명령어+옵션이 그대로 재현 레시피).
- **합의된 스펙:** 이슈에 메인테이너 동의 hint가 있고 의도가 명확 → underspecified 아님.

T1로 더 내려가지 않는 이유: (1) 픽스가 "이슈가 적어준 그대로 한 줄"이 아니라 exit를 **두 write 분기 공통 상위 + else 분기 내부**라는 정확한 스코프에 놓는 위치 판단이 필요(과수정 함정 존재), (2) **PASS_TO_PASS 137개**라는 넓은 regression-trap — `--dry-run`/`--update`/`--merge`/scriptable 등 인접 makemigrations 동작과 migrate/optimizemigration 계약을 모두 안 깨야 한다. 이 regression 표면이 순수 T1 대비 한 단계 끌어올린다. 다만 추론·도메인 깊이가 얕아 T3 이상은 아니다.

## 골드패치 분석
- **건드린 파일·함수:** `django/core/management/commands/makemigrations.py` — `Command.handle()`, `Command.add_arguments()`.
- **근본 원인:** `handle()`의 "변경 감지됨" else 분기에서 순서가
  ```
  if self.update: self.write_to_last_migration_files(changes)
  else:           self.write_migration_files(changes)
  if check_changes: sys.exit(1)
  ```
  였다. write가 exit보다 **먼저** 실행되므로 `--check`여도 마이그레이션 파일이 디스크에 기록된 뒤 종료. 부수효과(파일 쓰기)와 종료의 순서가 뒤바뀐 결함.
- **수정 요지:** `if check_changes: sys.exit(1)`을 두 write 호출보다 **앞으로** 이동.
  ```
  if check_changes: sys.exit(1)
  if self.update: self.write_to_last_migration_files(changes)
  else:           self.write_migration_files(changes)
  ```
  exit가 `self.update` 분기보다 위에 있으므로 update/일반 두 write 경로 모두에서 파일이 안 써진다. 추가로 `--check`의 help를 "Exit with a non-zero status if model changes are missing migrations **and don't actually write them.**"로 갱신해 새 계약을 문서화.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개):** `test_makemigrations_check` — "makemigrations --check should exit with a non-zero status when there are changes to an app requiring migrations."
- **픽스 증명:** 테스트가 `temporary_migration_module()`을 `as tmpdir`로 받도록 바뀌고, 변경이 필요한 `migrations` 앱에 대해 `call_command("makemigrations", "--check", "migrations", verbosity=0)`이 `SystemExit`을 던지는지(`assertRaises(SystemExit)`) 확인한 뒤, 결정적으로 `self.assertFalse(os.path.exists(tmpdir))`로 **마이그레이션 디렉터리/파일이 생성되지 않았음**을 단언한다. 기존(write-then-exit) 코드라면 SystemExit 전에 파일이 써져 tmpdir이 존재 → 이 단언에서 실패. 이 새 단언이 "exit 했는가"를 넘어 "부수효과가 없었는가"까지 검증하므로 결함을 정확히 핀포인트한다.
- **overfit 관점:** F2P는 1개로 얇지만, 추가된 `assertFalse(os.path.exists(tmpdir))`가 픽스의 **본질(부수효과 제거)**을 직접 관측하므로 special-case 통과(exit만 하고 파일은 남기는 식)를 배제한다 → overfit-risk 낮음. 그래서 overfit-risk 플래그는 달지 않음.
- **regression 관점:** PASS_TO_PASS 137개가 넓은 안전망. 같은 클래스의 `test_optimizemigration_check`, `test_migrate_check`, `test_migrate_check_plan`, `test_migrate_check_migrated_app`이 포함되어 있어 **다른 `--check` 명령들의 기존 의미가 안 깨졌음**을 동시에 보장. `makemigrations --dry-run`/`--merge --dry-run`/`--update`/scriptable 계열 테스트도 다수 포함되어 인접 동작 회귀를 막는다.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈가 "makemigrations --check"를 명시 → `git grep "\-\-check"` 또는 `check_changes`로 `django/core/management/commands/makemigrations.py`의 `add_arguments()`(옵션 정의)와 `handle()`(소비 지점)을 즉시 특정. `handle()` 끝의 "changes 존재" else 분기에서 write 호출과 `sys.exit(1)`의 상대 순서가 결함임을 읽어낸다.
2. **픽스와 올바른 일반화:** `if check_changes: sys.exit(1)`을 두 write 호출 **앞**으로 옮긴다. 이게 올바른 일반화인 이유 — exit를 `if self.update:` 분기 위, 두 write의 **공통 상위**에 둬야 update 경로(`write_to_last_migration_files`)와 일반 경로(`write_migration_files`) **양쪽 모두**에서 파일이 안 써진다. 한쪽 write 직전에만 넣으면 다른 경로에 구멍이 생기는 special-case가 된다. 의미적으로 `--check`를 "부수효과 없는 검사"로 정의하는 것이며 `migrate`/`optimizemigration --check`와 일관되므로 계약 정합.
3. **regression 안전:** exit를 **"changes 있음" else 분기 내부**에 둬야 한다("No changes detected" 분기에는 영향 없음). `--dry-run` 경로는 손대지 않는다(기존 `--dry-run` 동작 보존). 깨면 안 되는 P2P: `test_migrate_check*`(다른 명령 계약 불변), `makemigrations --dry-run`/`--merge --dry-run`/`--update`/scriptable 계열(인접 동작 불변), `makemigrations exits when there are no changes`(no-change 분기 불변). help 텍스트 변경은 동작에 무해.
4. **함정 회피(오라클 없는 에이전트):** (a) exit를 너무 위로 — 변경 감지 전이나 "No changes" 분기까지 — 올리면 변경이 없을 때도 종료해버려 `no changes → exit 0`를 깨는 과수정. exit는 반드시 "changes 있음" else 분기 안에 둘 것. (b) `--check`와 `--dry-run`의 조합 로직을 새로 짜려 드는 과한 리팩터링은 불필요(골드는 `--dry-run` 미접촉). (c) write 호출 한쪽 앞에만 exit를 끼워 `self.update` 경로를 빠뜨리는 부분 픽스 — 반드시 두 write의 공통 상위에 둘 것. (d) F2P가 1개라고 exit만 추가하고 끝내면, 새 `assertFalse(os.path.exists(tmpdir))` 단언이 부수효과를 잡아내 실패하므로 "파일을 실제로 안 쓰는가"까지 만족시켜야 한다.
