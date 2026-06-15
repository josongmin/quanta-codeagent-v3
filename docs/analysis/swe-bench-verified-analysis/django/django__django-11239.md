---
instance_id: django__django-11239
repo: django/django
base_commit: d87bd29c4f8dfcdf3f4a4eb8340e6770a2416fe3
version: 3.0
difficulty: <15 min fix
created_at: 2019-04-16T09:44:54Z
fail_to_pass: 1
pass_to_pass: 5
gold_files: [django/db/backends/postgresql/client.py]
---

# django__django-11239

## 문제 요약
PostgreSQL 백엔드는 `DATABASES['OPTIONS']`에 `sslmode`/`sslrootcert`/`sslcert`/`sslkey`를 넣어 상호 TLS(mutual TLS)로 DB에 접속하는 설정을 이미 지원한다. 하지만 `manage.py dbshell` 명령은 이 SSL 클라이언트 인증서 파라미터들을 psql 서브프로세스로 전달하지 않아, 일반 ORM 접속은 되는데 dbshell만 인증서 없이 실행되어 접속에 실패한다. 사용자는 dbshell도 동일한 SSL 설정을 인식해 psql에 넘겨주길 기대한다(#28322의 password 처리와 동일한 패턴).

## 유형 분류
- 버그 카테고리: 누락처리 (기능 미구현 / feature parity 누락)
- 서브시스템: django db backends — postgresql dbshell client
- 증상 타입: silent-wrong (psql이 인증서 없이 떠서 연결 실패, 예외 없이 설정 무시)
- 로컬라이제이션 신호: problem_statement가 "dbshell command does not support the client cert params"와 #28322(이미 password를 환경변수로 넘긴 선례)를 직접 지목 → `postgresql` 백엔드의 dbshell 진입점인 `client.py`로 바로 연결됨.

## 골드패치 분석
- 건드린 파일/함수: `django/db/backends/postgresql/client.py` : `DatabaseClient.runshell_db`
- 근본 원인: `runshell_db`는 `conn_params`에서 database/user/password만 꺼내 처리하고, password는 `PGPASSWORD` 환경변수로 넘기는 패턴이 이미 있었지만 sslmode/sslrootcert/sslcert/sslkey는 아예 읽지도 환경변수로 전달하지도 않았다.
- 수정 요지: `conn_params.get(...)`로 `sslmode`, `sslrootcert`, `sslcert`, `sslkey` 4개를 추출하고, password→`PGPASSWORD`와 동일하게 값이 존재할 때만 각각 `subprocess_env`에 `PGSSLMODE`/`PGSSLROOTCERT`/`PGSSLCERT`/`PGSSLKEY`로 설정한다. psql은 이 표준 libpq 환경변수를 인식하므로 인자 리스트(`args`)는 건드리지 않고 환경변수 주입만으로 해결.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_ssl_certificate` — `sslmode: verify-ca`, `sslrootcert/sslcert/sslkey`를 가진 dbinfo로 `runshell_db` 실행 시 4개 `PGSSL*` 환경변수가 정확히 세팅되는지 확인.
- 증명 방식: 테스트 헬퍼 `_run_it`을 기존 "PGPASSWORD 단일 값 반환"에서 "`PG`로 시작하는 모든 env var를 dict로 수집"하도록 일반화. 재현 입력(ssl 4개 옵션) → 기대 출력은 명령줄은 평소와 동일한 `['psql', '-U', ...]`이고 env dict가 `{'PGSSLCERT':'client.crt','PGSSLKEY':'client.key','PGSSLMODE':'verify-ca','PGSSLROOTCERT':'root.crt'}`. 픽스 전엔 env가 비어 RED. 기존 test_basic/nopass/column/accent도 반환 형태를 dict로 맞춰 회귀 보장.

## 공략 포인트 (뭘 조져야)
- localization 전략: dbshell은 백엔드별 `client.py`에 있다. problem_statement가 postgresql + #28322(password env var 선례)를 명시하므로 `django/db/backends/postgresql/client.py`의 `runshell_db` 한 함수만 보면 된다. 기존 `PGPASSWORD` 처리 블록이 정확한 카피 템플릿.
- 함정/난이도: 단일 파일·단일 함수, <15분 난이도. 주의점은 (1) psql 인자(`args`)가 아니라 libpq 환경변수로 넘겨야 한다는 것(인자 플래그를 찾으려 하면 헤맴), (2) password처럼 "값이 truthy일 때만" 주입해야 빈 값이 env를 오염시키지 않음.
- 우리 에이전트 관점: 막힐 지점은 거의 없음 — 선례 패턴이 같은 함수 안에 그대로 있어 흡수가 쉽다. 유일한 리스크는 mysql/oracle 등 다른 백엔드 client.py까지 손대거나, psql CLI 플래그(`--sslmode` 등 존재하지 않음)를 만들어내는 과잉/오답. 환경변수 4개로 좁히는 절제가 핵심.
