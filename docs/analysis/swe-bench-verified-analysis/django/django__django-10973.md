---
instance_id: django__django-10973
repo: django/django
base_commit: ddb293685235fd09e932805771ae97f72e817181
version: "3.0"
difficulty: 15 min - 1 hour
created_at: 2019-02-11T01:19:56Z
fail_to_pass: 5
pass_to_pass: 0
gold_files: [django/db/backends/postgresql/client.py]
---

# django__django-10973

## 문제 요약
PostgreSQL 백엔드의 `dbshell`(`runshell_db`)이 psql에 비밀번호를 넘길 때 임시 `.pgpass` 파일을 만들고 `PGPASSFILE` 환경변수로 가리키는 방식을 쓰고 있었다. Python 3.5(Django 2.1부터 최소 버전)에 추가된 `subprocess.run`은 서브프로세스에 커스텀 환경을 직접 넘길 수 있으므로, `PGPASSWORD` 환경변수를 자식 프로세스 env에만 주입하면 임시파일 생성·escape·정리 로직 전체를 제거해 코드가 단순해지고 더 신뢰성 있어진다. 즉 버그 수정보다는 리팩터링/개선 요청이다.

## 유형 분류
- 버그 카테고리: API-contract / 누락처리 (구식 우회 방식 → 표준 API 사용으로 단순화)
- 서브시스템: django db backends / postgresql client (dbshell)
- 증상 타입: 기능은 동작하나 불필요하게 복잡·취약 (temp 파일, escape, 글로벌 os.environ 오염, UnicodeEncodeError 폴백)
- 로컬라이제이션 신호: problem_statement가 파일 경로(`django.db.backends.postgres.client`)와 기법(`subprocess.run`, `PGPASSWORD`)을 직접 명시 → 사실상 핀포인트 제공

## 골드패치 분석
- 건드린 파일/함수: `django/db/backends/postgresql/client.py:DatabaseClient.runshell_db` (+ 모듈 레벨 `_escape_pgpass` 삭제, `NamedTemporaryFile` import 삭제)
- 근본 원인: 버그라기보다 레거시 우회. `.pgpass` 파일 방식은 (1) 임시파일 I/O, (2) `:`/`\` escape를 위한 `_escape_pgpass`, (3) 전역 `os.environ['PGPASSFILE']` 변경 후 finally 정리, (4) 로케일 인코딩 실패 시 UnicodeEncodeError 폴백 등 불필요한 복잡성과 전역 상태 오염을 동반했다.
- 수정 요지:
  - `subprocess_env = os.environ.copy()` 후 `passwd`가 있으면 `subprocess_env['PGPASSWORD'] = str(passwd)`로 자식 env에만 주입.
  - `subprocess.check_call(args)` → `subprocess.run(args, check=True, env=subprocess_env)`로 교체.
  - 임시 `.pgpass` 생성/escape/`PGPASSFILE` 설정·정리 블록과 `_escape_pgpass`, `NamedTemporaryFile` import 전부 제거.
  - SIGINT ignore/복원 try/finally 구조는 유지.

## 검증 (test_patch)
- FAIL_TO_PASS가 체크하는 동작: `tests/dbshell/test_postgresql.py`의 `_run_it`이 더 이상 `subprocess.call`/`PGPASSFILE` 파일 내용을 보지 않고 `subprocess.run`을 목킹해 자식에 전달된 `env`의 `PGPASSWORD` 값을 반환하도록 변경됨.
- 테스트가 픽스를 증명하는 방법:
  - `test_basic`: password=`somepassword` → 기대 PGPASSWORD가 `'somepassword'` (이전엔 `'somehost:444:dbname:someuser:somepassword'` pgpass 라인).
  - `test_column`: user `some:user`, password `some:password` → 기대값이 `'some:password'`. escape가 사라졌으므로 `:`를 그대로 보존함을 검증 (이전엔 `\:` escape).
  - `test_accent`: 비ASCII 비밀번호 `sésame`를 그대로 PGPASSWORD로 전달 → 로케일 인코딩 폴백 제거가 회귀 없음을 증명.
  - `test_escape_characters` 테스트는 escape 개념 자체가 사라져 삭제됨.
  - `test_sigint_handler`: 목 대상을 `subprocess.run`으로 바꿔 SIGINT가 SIG_IGN으로 무시·복원되는지 유지 확인.

## 공략 포인트 (뭘 조져야)
- 어디부터: problem_statement가 파일/기법을 명시하므로 로컬라이제이션 난이도는 사실상 0. `runshell_db` 본문만 보면 됨.
- 함정/난이도 메모: 단일 파일·단일 메서드라 멀티파일 아님. 핵심은 (1) `os.environ`을 직접 건드리지 말고 `.copy()`한 env에만 PGPASSWORD를 넣을 것, (2) `subprocess.run(..., check=True)`로 비-제로 종료 시 예외 보존(기존 `check_call` 동등), (3) `_escape_pgpass`/`NamedTemporaryFile`/`PGPASSFILE` 잔재를 완전히 제거해야 테스트의 escape 기대 변경과 일치. escape 로직을 어설프게 남기면 `test_column`이 깨진다.
- 우리 에이전트 관점: 위험은 "최소 변경" 본능으로 PGPASSFILE 경로를 유지한 채 PGPASSWORD만 추가하는 것 — 그러면 삭제된 `test_escape_characters`·변경된 `test_column` 기대와 충돌. 테스트가 escape 없는 raw 값을 요구함을 인지하고 우회 로직을 통째로 들어내야 그린이 된다.
