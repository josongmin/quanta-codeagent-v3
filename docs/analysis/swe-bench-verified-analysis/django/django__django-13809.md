---
instance_id: django__django-13809
repo: django/django
base_commit: bef6f7584280f1cc80e5e2d80b7ad073a93d26ec
version: "4.0"
difficulty: 15 min - 1 hour
created_at: 2020-12-24T15:31:35Z
fail_to_pass: 1
pass_to_pass: 245
gold_files: [django/core/management/commands/runserver.py]
---

# django__django-13809

## 문제 요약
`runserver` 커맨드는 매 실행/리로드마다 시스템 체크를 강제로 수행하는데, 큰 프로젝트에서는 이게 15-20초씩 걸려 개발 중 reload가 느려진다. 다른 management 커맨드들은 이미 `--skip-checks` 옵션을 제공하므로 일관성 차원에서도 `runserver`에도 시스템 체크를 건너뛰는 옵션을 추가해 달라는 기능 요청(feature)이다. 사용자는 CI/CD에서만 체크를 켜고 로컬 개발에서는 끄고 싶어한다.

## 유형 분류
- 버그 카테고리: 누락처리 (기능 추가 / missing-feature, 다른 커맨드와의 API-contract 일관성)
- 서브시스템: django core management commands (`runserver`)
- 증상 타입: 잘못된 출력/UX (체크를 강제 수행, 끌 방법 없음) — 크래시 아님
- 로컬라이제이션 신호: problem_statement가 "runserver command"와 "--skip-checks option"을 명시 → `django/core/management/commands/runserver.py`로 직결. "performing system checks" 메시지와 `self.check()` 호출 지점이 정확한 수정 포인트.

## 골드패치 분석
- 건드린 파일/함수: `django/core/management/commands/runserver.py` → `Command.add_arguments`, `Command.inner_run`
- 근본 원인: `inner_run`이 `self.check(display_num_errors=True)`를 무조건 호출하고, 이를 비활성화할 CLI 인자가 정의돼 있지 않았다. 다른 커맨드는 `BaseCommand`의 `--skip-checks` 플로우를 쓰지만 `runserver`는 자체 `inner_run` 경로라 그 혜택을 못 받았다.
- 수정 요지:
  1. `add_arguments`에 `parser.add_argument('--skip-checks', action='store_true', help='Skip system checks.')` 추가.
  2. `inner_run`에서 `self.check()` 호출을 `if not options['skip_checks']:` 가드로 감싸, 플래그가 켜지면 "Performing system checks..." 출력과 `self.check()` 둘 다 건너뛴다.
  3. `check_migrations()`는 가드 밖에 그대로 둬서 마이그레이션 체크는 항상 수행(주석으로 의도 명시).

## 검증 (test_patch)
- FAIL_TO_PASS: `test_skip_checks (admin_scripts.tests.ManageRunserver)`
- 테스트가 어떻게 픽스를 증명하는지: `runserver.run`, `BaseCommand.check_migrations`, `BaseCommand.check`를 mock한 뒤 `call_command('runserver', use_reloader=False, skip_checks=True)`를 호출 → 출력에 "Performing system checks..."가 없고 `mocked_check.assert_not_called()` 성립. 이어 `skip_checks=False`로 재호출 → 메시지가 있고 `mocked_check.assert_called()` 성립. 즉 플래그의 양방향 동작을 모두 확인한다. (test_autoreload.py 변경은 `autoreload._exception` 전역 상태를 `finally`로 청소하는 테스트 격리 보강이며 본 픽스의 행위 검증은 아님.)

## 공략 포인트 (뭘 조져야)
- 어디부터: problem_statement에 파일이 사실상 박혀 있다. `runserver.py`의 `inner_run`에서 `self.check(...)` 호출 라인과 `add_arguments`만 보면 된다.
- 함정/난이도 메모: (1) `check_migrations()`까지 같이 끄면 안 됨 — 골드는 의도적으로 migration 체크는 유지한다. (2) `BaseCommand`에 이미 `--skip-checks` 처리 로직이 있으나 `runserver`는 `requires_system_checks`/표준 `handle` 흐름이 아니라 `inner_run`을 거치므로, 베이스 클래스만 믿고 인자 추가를 빠뜨리면 `options['skip_checks']` KeyError가 난다. 그래서 `add_arguments`에 명시적으로 추가해야 한다. (3) 단일 파일 수정.
- 우리 에이전트 관점: 막힐 지점은 거의 없는 저난도 기능 추가다. 위험은 과잉수정 — `BaseCommand`의 system-check 메커니즘을 건드리거나 `check_migrations`까지 가드에 넣어 PASS_TO_PASS(특히 migration warning 계열 테스트)를 깨는 것. 옵션 추가와 단일 `if not options['skip_checks']:` 가드로 최소 변경하는 게 정답.
