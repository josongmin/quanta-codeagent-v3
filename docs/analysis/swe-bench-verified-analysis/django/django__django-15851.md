---
instance_id: django__django-15851
repo: django/django
base_commit: b4817d20b9e55df30be0b1b2ca8c8bb6d61aab07
version: 4.2
difficulty: <15 min fix
created_at: 2022-07-18T01:36:33Z
fail_to_pass: 1
pass_to_pass: 8
gold_files: [django/db/backends/postgresql/client.py]
---

# django__django-15851

## 문제 요약
`./manage.py dbshell -- -c "select * from some_table;"` 처럼 추가 인자를 넘기면 psql이 `extra command-line argument "-c" ignored` 경고를 내고 인자를 무시한다. psql은 모든 옵션이 데이터베이스 이름보다 **앞**에 와야 하는데, Django가 만든 argv는 dbname을 먼저 넣고 사용자 파라미터를 뒤에 붙여서 그렇다. 사용자는 넘긴 `-c` 옵션이 정상 적용되길 기대한다.

## 유형 분류
- 버그 카테고리: logic (인자 순서 오류) / API-contract (psql CLI 규약 위반)
- 서브시스템: django DB backend — PostgreSQL dbshell 클라이언트 (`manage.py dbshell`)
- 증상 타입: silent-wrong (예외 없이 사용자 인자가 무시됨)
- 로컬라이제이션 신호: "PostgreSQL", "psql", "args list just need to be constructed in the proper order", "leaving the database name for the end" — 정확히 args 배열을 구성하는 postgresql client로 직결

## 골드패치 분석
- 건드린 파일/함수: `django/db/backends/postgresql/client.py` : `DatabaseClient.settings_to_cmd_args_env` (classmethod)
- 근본 원인: argv를 만들 때 `if dbname: args += [dbname]` 를 먼저 실행하고 그 뒤에 `args.extend(parameters)` 를 호출했다. 결과 argv가 `[psql, ..., dbname, --help]` 형태가 되어 dbname 이후의 옵션을 psql이 무시함.
- 수정 요지: 두 줄의 순서를 뒤집는다. `args.extend(parameters)` 를 dbname 추가 **이전**으로 끌어올려서, 사용자 파라미터가 먼저 들어가고 dbname이 항상 argv 끝에 오도록 했다. 즉 `[psql, ..., --help, dbname]` 순서로 생성된다. 한 줄 이동(2-line swap)으로 psql의 "옵션 먼저, dbname 마지막" 규약을 충족.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_parameters (dbshell.test_postgresql.PostgreSqlDbshellCommandTestCase)`
- 테스트가 어떻게 픽스를 증명하는지: `settings_to_cmd_args_env({"NAME": "dbname"}, ["--help"])` 를 호출했을 때 기대값을 기존 `(["psql", "dbname", "--help"], None)` 에서 `(["psql", "--help", "dbname"], None)` 으로 변경. 재현 입력은 dbname과 추가 파라미터 `--help`, 기대 출력은 dbname이 마지막에 오는 argv. PASS_TO_PASS 8개(test_basic/test_passfile/test_service 등)는 파라미터가 없거나 인증 관련이라 순서 변경의 영향을 받지 않음을 보장.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement에 "psql", "PostgreSQL", "dbshell"이 명시되어 있어 `django/db/backends/postgresql/client.py` 의 `settings_to_cmd_args_env` 로 바로 진입. argv를 조립하는 부분에서 dbname과 parameters 추가 순서만 보면 됨.
- 함정/난이도 메모: 단일 파일·2줄 swap이라 난이도 매우 낮음. 다만 다른 backend(mysql/oracle/sqlite)의 client.py도 같은 패턴이 있어 "전부 고쳐야 하나" 헷갈릴 수 있으나, 이 이슈와 골드는 postgresql만 대상. 과교정 주의.
- 우리 에이전트 관점: 막힐 지점은 거의 없음. 위험은 (1) 다른 backend까지 손대는 over-edit, (2) `args += [dbname]` 를 지우거나 parameters를 dbname 뒤가 아닌 잘못된 위치로 옮기는 실수. 테스트 기대값이 정확히 `["psql", "--help", "dbname"]` 이므로 순서만 정확히 맞추면 통과.
