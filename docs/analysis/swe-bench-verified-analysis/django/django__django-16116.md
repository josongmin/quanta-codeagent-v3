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
---

# django__django-16116

## 문제 요약
`makemigrations --check`는 변경분이 있으면 비정상 종료 코드를 반환하지만, 그 전에 실제로 마이그레이션 파일을 디스크에 써버린다. 이는 `migrate --check`나 `optimizemigration --check`가 아무것도 쓰지 않고 그냥 종료하는 동작과 불일치한다. 사용자는 단지 "누락된 마이그레이션이 있는지"만 검사하고 싶어서 `--check`를 쓰는데, 파일을 안 만들려면 `--dry-run`을 함께 줘야 하는 비일관성이 있었다. 기대는 `--check` 단독으로 파일 생성 없이 종료하는 것.

## 유형 분류
- 버그 카테고리: API-contract (명령어 옵션 간 동작 일관성 위반)
- 서브시스템: django migrations / management command (`makemigrations`)
- 증상 타입: silent-wrong (의도하지 않은 부수효과 — 검사만 원했는데 파일이 써짐)
- 로컬라이제이션 신호: problem_statement가 `makemigrations --check`를 명시 → 해당 커맨드 파일의 `--check`/`check_changes` 처리 분기로 직행. "exit" vs "write" 순서가 핵심.

## 골드패치 분석
- 건드린 파일/함수: `django/core/management/commands/makemigrations.py` — `Command.handle()`, `Command.add_arguments()`
- 근본 원인: `handle()`의 "변경 감지됨" 분기에서 `write_migration_files()`/`write_to_last_migration_files()`를 먼저 호출한 뒤에야 `if check_changes: sys.exit(1)`을 실행했다. 즉 `--check`여도 파일이 먼저 디스크에 기록됨.
- 수정 요지: `check_changes` 검사를 write 호출보다 **앞으로** 이동시켜, `if check_changes: sys.exit(1)`을 write 분기 진입 전에 두었다. 그 결과 `--check`는 어떤 마이그레이션도 쓰지 않고 즉시 종료. 부수적으로 `--check`의 help 텍스트에 "and don't actually write them." 문구를 추가해 새 의미를 문서화.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_makemigrations_check` ("makemigrations --check should exit with a non-zero status when…")
- 증명 방식: `temporary_migration_module()`을 `as tmpdir`로 받아서, 변경이 필요한 `migrations` 앱에 대해 `call_command("makemigrations", "--check", ...)`가 `SystemExit`을 던지는지 확인하고(`assertRaises(SystemExit)`), 그 직후 `self.assertFalse(os.path.exists(tmpdir))`로 **마이그레이션 디렉터리/파일이 생성되지 않았음**을 검증한다. 기존 코드라면 파일이 써져 tmpdir이 존재하므로 이 단언에서 실패한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: `makemigrations.py`의 `handle()` 끝부분, "changes 존재" else 분기에서 write 호출과 `sys.exit(1)`의 **상대적 순서**만 보면 된다. 한 줄 이동이 본질.
- 함정/난이도 메모: 단일 파일·수 줄짜리 변경이라 난이도는 낮음. 다만 `--check`와 `--dry-run`의 조합/상호작용을 과하게 건드리지 않도록 주의 — 골드는 `--dry-run` 경로는 손대지 않고 오로지 write 전에 exit하게만 바꿨다. `self.update`(=`write_to_last_migration_files`) 경로도 동일하게 스킵돼야 하므로 exit를 두 write 분기 공통 상위로 올리는 위치 선정이 포인트.
- 우리 에이전트 관점: 막힐 지점은 적음. 다만 PASS_TO_PASS가 124개로 넓어 `--check`/`--dry-run`/`--update`/scriptable 등 인접 동작을 깨지 않았는지 회귀 확인 필요. exit를 너무 위로(변경 감지 전, "No changes" 분기까지) 올리면 변경 없을 때도 종료해버리는 과수정 위험이 있으니 "changes 있음" 분기 내부에 두는 정확성이 관건.
