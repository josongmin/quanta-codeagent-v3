---
instance_id: django__django-14315
repo: django/django
base_commit: 187118203197801c6cb72dc8b06b714b23b6dd3d
version: 4.0
difficulty: <15 min fix
created_at: 2021-04-26T12:39:01Z
fail_to_pass: 11
pass_to_pass: 0
gold_files: [django/db/backends/base/client.py, django/db/backends/postgresql/client.py]
---

# django__django-14315

## 문제 요약
DB 클라이언트의 `runshell`이 일부 경우에 `os.environ`을 존중하지 않는 버그다. postgresql 클라이언트의 `settings_to_cmd_args_env`가 추가 환경변수가 없을 때 `None`이 아니라 빈 dict `{}`를 반환하는데, `runshell`은 `if env:` (truthy 검사)로 분기하므로 빈 dict는 falsy라서 `os.environ` 병합 로직을 건너뛴다. 그 결과 빈 env가 그대로 `subprocess.run`에 전달되어 자식 프로세스가 `os.environ`을 상속받지 못한다.

## 유형 분류
- 버그 카테고리: edge-case / regression (truthy-vs-None 혼동, 빈 컬렉션 처리 누락)
- 서브시스템: django DB backends / dbshell (database client)
- 증상 타입: silent-wrong (예외 없이 자식 프로세스 환경이 잘못 전달됨)
- 로컬라이제이션 신호: problem_statement이 "postgresql client returns empty dict instead of None for env"라고 정확히 지목하고, 회귀를 도입한 커밋 bbe6fbb의 R23-R26(base/client.py runshell)을 링크로 명시. 파일·함수가 거의 그대로 노출된 매우 친절한 케이스.

## 골드패치 분석
- 건드린 파일/함수:
  - `django/db/backends/base/client.py:BaseDatabaseClient.runshell`
  - `django/db/backends/postgresql/client.py:DatabaseClient.settings_to_cmd_args_env`
- 근본 원인: postgresql의 `settings_to_cmd_args_env`는 누적용 `env = {}`로 시작해 옵션이 없으면 빈 dict를 그대로 반환. `runshell`은 `if env:`로 검사하므로 `{}`(falsy)는 분기 밖으로 빠지고, 결과적으로 `subprocess.run(env={})`가 호출돼 `os.environ`이 완전히 무시된 채 빈 환경으로 실행된다.
- 수정 요지:
  1. `runshell`을 `env = {**os.environ, **env} if env else None`로 변경 — env가 비어있으면 `None`을 넘겨 subprocess가 부모 `os.environ`을 그대로 상속하게 한다(빈 dict로 환경을 비우지 않음).
  2. postgresql `settings_to_cmd_args_env`의 반환을 `return args, (env or None)`로 바꿔 빈 dict 대신 `None`을 반환하도록 정규화. 두 변경이 합쳐져 "추가 env 없음 → None → os.environ 상속" 계약을 명확히 한다.

## 검증 (test_patch)
- FAIL_TO_PASS가 체크하는 동작:
  - `test_runshell_use_environ` (base): `settings_to_cmd_args_env`가 `([], None)`과 `([], {})` 둘 다 반환하는 경우를 `subTest`로 돌면서, `subprocess.run`이 항상 `env=None`으로 호출되는지 검증.
  - postgresql 측 `test_nopass`, `test_parameters` 등은 기대 반환값을 `{}`에서 `None`으로 갱신.
- 테스트가 어떻게 픽스를 증명하는지: `mock.patch('subprocess.run')`과 `mock.patch.object(BaseDatabaseClient, 'settings_to_cmd_args_env', return_value=([], env))`로 두 입력(None, {})을 주입한 뒤 `runshell(None)` 호출 → `run.assert_called_once_with([], env=None, check=True)`로 빈 env가 None으로 정규화돼 전달됨을 확인. 픽스 전에는 `env={}`(혹은 `{**os.environ}` 미적용)으로 호출되어 단언 실패.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement이 base/client.py의 `runshell`과 postgresql/client.py의 `settings_to_cmd_args_env`를 사실상 지목. 회귀 커밋 링크의 R23-R26 라인이 정확한 지점.
- 함정/난이도 메모: 멀티파일(2개) 수정이 핵심. base 한 곳만 고치면(`if env else None`) 충분해 보이지만, postgresql이 여전히 `{}`를 반환하면 base의 `if env`가 falsy로 받아 동일 경로를 타므로 base 수정만으로도 동작은 맞지만, 테스트는 postgresql 반환값이 `None`이길 기대(test_nopass/test_parameters)하므로 두 파일 모두 손봐야 FAIL_TO_PASS 전체 통과. truthy(`{}`)와 None의 의미 차이를 정확히 이해해야 함.
- 우리 에이전트 관점: 막힐 만한 지점은 "한 줄 고치면 끝"이라 base 파일만 수정하고 postgresql의 반환 정규화를 빠뜨리는 것. dbshell/test_postgresql.py의 기대값이 `None`으로 바뀐 점을 못 보면 부분 통과에 그친다. 빈 dict와 None을 동치로 취급하지 말고 테스트가 요구하는 반환 계약(None)까지 맞춰야 한다.
