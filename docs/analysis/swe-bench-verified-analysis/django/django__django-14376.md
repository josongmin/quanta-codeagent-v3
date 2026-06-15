---
instance_id: django__django-14376
repo: django/django
base_commit: d06c5b358149c02a62da8a5469264d05f29ac659
version: 4.0
difficulty: <15 min fix
created_at: 2021-05-10T20:42:18Z
fail_to_pass: 3
pass_to_pass: 6
gold_files: [django/db/backends/mysql/base.py, django/db/backends/mysql/client.py]
---

# django__django-14376

## 문제 요약
Django MySQL 백엔드가 `mysqlclient`에 연결 파라미터를 넘길 때 `db`, `passwd` kwargs를 사용하는데, mysqlclient가 이 두 키를 deprecated 처리하고 `database`, `password`를 권장한다. mysqlclient 1.3.8부터 새 키를 지원하고 Django가 요구하는 최소 버전이 그보다 높으므로, deprecation 경고를 피하기 위해 새 키 이름으로 교체해 달라는 요청이다.

## 유형 분류
- 버그 카테고리: API-contract (외부 라이브러리의 deprecated 인자 사용)
- 서브시스템: django db backends / mysql (연결 파라미터 + dbshell 클라이언트)
- 증상 타입: silent-wrong (deprecation warning, 향후 키 제거 시 크래시 위험)
- 로컬라이제이션 신호: problem_statement가 정확히 `django/db/backends/mysql/base.py#L202-L205`를 링크로 지목하고 "db", "passwd" 문자열을 명시 → 골드 파일 직행

## 골드패치 분석
- 건드린 파일/함수:
  - `django/db/backends/mysql/base.py:get_connection_params`
  - `django/db/backends/mysql/client.py:DatabaseClient.settings_to_cmd_args_env`
- 근본 원인: base.py가 `kwargs['db']`/`kwargs['passwd']`로 연결을 맺고 있어 mysqlclient deprecation 경로를 탄다. client.py는 `OPTIONS`에서 옛 키(`db`)만 조회해 새 키를 인지하지 못한다.
- 수정 요지:
  - base.py: `kwargs['db'] → kwargs['database']`, `kwargs['passwd'] → kwargs['password']`로 단순 교체.
  - client.py: `OPTIONS.get('db', NAME)` 대신 `OPTIONS.get('database', OPTIONS.get('db', NAME))`로 중첩 폴백 — 새 키 `database`를 우선, 없으면 deprecated `db`, 그래도 없으면 `NAME`. 이후 변수명 `db → database`로 리네임하고 인자 추가 분기도 동일하게 변경.

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `test_options_override_settings_proper_values`: `OPTIONS`에 deprecated/non-deprecated 키 두 조합 `('database','password')`, `('db','passwd')`을 `subTest`로 돌려 양쪽 모두 dbname/password가 명령 인자·env에 반영되는지 확인.
  - `test_options_non_deprecated_keys_preferred`(구 `test_options_password`에서 개명): `OPTIONS`에 `database`/`db`, `password`/`passwd`가 동시에 있을 때 non-deprecated 키 값(`optiondbname`, `optionpassword`)이 deprecated 값보다 우선되는지 확인 — 폴백 우선순위 증명.
  - `test_parameters`: 회귀 보호용 기존 테스트.
- 증명 방식: 새 키만으로도 동작(첫 테스트의 `database` 조합) + 두 키 공존 시 새 키 우선(두 번째 테스트) → 골드의 중첩 `get` 폴백 순서가 정확해야만 통과.

## 공략 포인트 (뭘 조져야)
- 어디부터: problem_statement의 링크가 base.py 라인을 직접 찍어주므로 거기서 시작. 단, base.py만 고치면 client.py의 dbshell 경로가 미커버 — FAIL_TO_PASS 3개가 전부 `dbshell.test_mysql`이라 client.py 수정이 사실상 채점의 핵심.
- 함정/난이도: (1) 멀티파일 — base.py는 자명하지만 client.py를 놓치기 쉽다. (2) client.py는 단순 리네임이 아니라 `database`→`db`→`NAME` 3단 폴백을 새로 만들어야 하며, deprecated 키 하위호환을 깨면 안 됨. (3) 변수명 `db`를 `database`로 바꾸면 하단 인자 추가 분기(`if db:`)도 같이 고쳐야 함.
- 우리 에이전트 관점: base.py만 보고 "한 줄 수정"으로 종료할 위험이 크다. 채점 테스트가 dbshell에 몰려 있으므로 client.py의 `OPTIONS` 폴백을 함께 손대고, non-deprecated 우선순위(새 키가 옛 키를 이김)를 정확히 구현해야 3개 모두 green.
