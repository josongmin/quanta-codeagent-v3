---
instance_id: django__django-11292
repo: django/django
base_commit: eb16c7260e573ec513d84cb586d96bdf508f3173
version: "3.0"
difficulty: 15 min - 1 hour
created_at: 2019-04-27T14:23:07Z
fail_to_pass: 1
pass_to_pass: 31
gold_files: [django/core/management/base.py]
---

# django__django-11292

## 문제 요약
관리 명령(management command)은 이미 `skip_checks`라는 stealth 옵션(파서에 정의되지 않은 내부 옵션)을 가지고 있지만, 커맨드라인에서는 노출되지 않는다. 사용자는 `--skip-checks` 플래그를 CLI에서 직접 줘서 시스템 체크를 건너뛰고 싶어한다. 개발 환경에서 system check 에러를 당장 고치지 않고 작업을 진행하기 위한 편의 기능 요청이다.

## 유형 분류
- 버그 카테고리: 누락처리 (기능 누락 / API-contract 확장)
- 서브시스템: django core management (management command 인프라 / argparse 파서)
- 증상 타입: 기능 부재 (CLI 플래그 미노출) — 잘못된 출력 아님, feature gap
- 로컬라이제이션 신호: problem_statement가 "management commands", "skip_checks stealth option"을 직접 지목 → `django/core/management/base.py`의 `BaseCommand`와 stealth option 정의로 직결

## 골드패치 분석
- 건드린 파일/함수: `django/core/management/base.py`
  - `DjangoHelpFormatter.show_last` (집합 리터럴)
  - `BaseCommand.base_stealth_options`
  - `BaseCommand.create_parser()`
  - `BaseCommand.execute()`
- 근본 원인: `skip_checks`가 stealth option으로만 존재하고 argparse 파서에 정의된 적이 없어 CLI에서 전달 불가능했다. `execute()`는 `options.get('skip_checks')`로 안전하게 읽어 부재 시 None 처리했다.
- 수정 요지:
  1. `create_parser()`에서 `self.requires_system_checks`가 True일 때만 `--skip-checks` (store_true) 인자를 추가 — 체크가 없는 명령엔 무의미한 플래그를 노출하지 않음.
  2. `skip_checks`가 이제 실제 파서 인자가 되었으므로 `base_stealth_options`에서 `'skip_checks'`를 제거 (더 이상 stealth가 아님).
  3. `execute()`에서 `options.get('skip_checks')` → `options['skip_checks']`로 변경 — 인자가 항상 정의되므로 직접 인덱싱 가능.
  4. `--skip-checks`를 `DjangoHelpFormatter.show_last`에 추가해 help 출력 시 공통 옵션처럼 뒤로 정렬.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_skip_checks (user_commands.tests.CommandRunTests)`
- 테스트는 일부러 `STATICFILES_DIRS = '"foo"'` (튜플/리스트 아님)로 staticfiles.E001 system check 에러가 발생하도록 settings를 작성한 뒤, `set_option --skip-checks --set foo`를 실제 서브프로세스로 실행한다.
- 픽스 증명: `--skip-checks`가 없으면 system check가 E001로 stderr에 에러를 뱉어야 하지만, 플래그가 동작하면 체크를 건너뛰고 `assertNoOutput(err)`(에러 없음) + stdout이 `'Set foo'`가 된다. 즉 재현 입력(깨진 settings + 플래그) → 기대 출력(에러 없이 정상 명령 수행).

## 공략 포인트 (뭘 조져야)
- localization 전략: "skip_checks" / "stealth_options" / "requires_system_checks"를 `django/core/management/base.py`에서 grep하면 바로 `BaseCommand`로 수렴. 단일 파일, 단일 클래스 작업.
- 함정/난이도 메모:
  - 단순히 `parser.add_argument('--skip-checks')`만 추가하면 `requires_system_checks=False`인 명령에도 무의미한 플래그가 붙는다 → 골드는 조건부 추가로 처리.
  - 인자를 추가했으면 반드시 `base_stealth_options`에서 빼야 한다. 안 빼면 stealth/실제 인자 이중 정의로 의미 충돌(미묘한 회귀).
  - `options.get` → `options[...]` 전환을 놓치면 동작은 하지만 의도(항상 존재 보장)가 드러나지 않음 — PASS_TO_PASS의 `test_call_command_no_checks` 등이 call_command 경로에서 `skip_checks` 처리를 검증하므로 둘 다 깨지지 않게 유지 필요.
  - help 정렬(show_last)은 기능엔 무관하지만 일관성 항목.
- 우리 에이전트 관점: 멀티파일 아님, 난이도 낮음. 막힐 만한 지점은 (a) 조건부 추가의 필요성을 인지하느냐, (b) `base_stealth_options` 정리와 `call_command` 경로(PASS_TO_PASS)를 깨지 않는지까지 챙기느냐. 표면적으론 "한 줄 add_argument"로 보이지만 stealth→real 전환의 부수 정리가 핵심.
