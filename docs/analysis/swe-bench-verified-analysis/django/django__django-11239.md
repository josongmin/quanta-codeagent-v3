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
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [has-repro]
---

# django__django-11239

## 문제 요약
PostgreSQL 백엔드는 `DATABASES['OPTIONS']`에 `sslmode`/`sslrootcert`/`sslcert`/`sslkey`를 넣어 상호 TLS(mutual TLS)로 DB에 접속하는 설정을 이미 지원한다. 하지만 `manage.py dbshell` 명령은 이 SSL 클라이언트 인증서 파라미터들을 psql 서브프로세스로 전달하지 않아, 일반 ORM 접속은 되는데 dbshell만 인증서 없이 실행되어 접속에 실패한다. 사용자는 dbshell도 동일한 SSL 설정을 인식해 psql에 넘겨주길 기대한다(#28322의 password 처리와 동일한 패턴). problem_statement에 동작 가능한 `DATABASES` 설정 예시가 그대로 들어 있어 재현 입력이 명시된다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed).** problem_statement가 postgresql + dbshell + #28322(password를 환경변수로 넘긴 선례)를 직접 지목한다. dbshell은 백엔드별 `client.py`에 있고, 픽스 대상은 `django/db/backends/postgresql/client.py`의 `runshell_db` 단일 함수로 grep 한 방에 수렴한다. cross-file 추적 불필요.
- **S (Repair Strategy) = S1 (Direct-Map / template).** 이슈가 사실상 픽스를 명세한다("Should be a trivial fix to add in support for the other 'ssl' parameters"). 같은 함수 안에 `passwd = conn_params.get('password', '')` → `if passwd: subprocess_env['PGPASSWORD'] = str(passwd)`라는 완성된 카피 템플릿이 존재한다. 4개 ssl 파라미터를 동일 패턴으로 복제하는 기계적 작업으로, 새 식·조건 추론(S2)이 필요 없다. APR 관점: PAR/TBar류 "fix pattern from existing precedent"의 교과서 사례 — 결함클래스가 "missing feature-parity branch"이고 인접 코드에 정확한 패치 템플릿이 같이 산다.
- **K (Knowledge) = K-Domain.** 일반 파이썬 추론(K-Gen)만으로는 부족하다. libpq가 `PGSSLMODE`/`PGSSLROOTCERT`/`PGSSLCERT`/`PGSSLKEY`라는 표준 환경변수로 SSL 설정을 받는다는 PostgreSQL/Django 백엔드 도메인 지식이 핵심이다(K-API는 아님 — 공개 시그니처/리턴형 계약을 맞추는 문제가 아니라 외부 도구 환경변수 이름을 아는 문제). conn_params의 키 이름(`sslmode` 등)도 Django OPTIONS 패스스루 관례를 알아야 한다.
- **primary type = T-DirectMap.** 위치 명확(L0) + S1 기계적 픽스(환경변수 가드 추가). T-LocTrivial이 아닌 이유는 픽스가 완전 자명(K-Gen)하기보다 libpq 환경변수 매핑이라는 도메인 디테일을 동반하기 때문. T-DomainBound이 dominant가 아닌 이유는 도메인 지식이 병목 수준이 아니라 인접 password 선례가 그 지식을 사실상 떠먹여 주기 때문.

## 난이도 티어
**티어 = T2 (쉬움).** 공식 difficulty 라벨 `<15 min fix`와 일치한다.
- 이 티어로 미는 구조적 피처: (1) **파일/함수 수 = 1/1** — gold patch가 `client.py`의 `runshell_db` 단독, 2개 헌크 추가만. (2) **줄수 = +14줄 순수 추가**, 삭제 0, 기존 로직 비변경. (3) **localize 직접성 = L0** — 이슈가 파일·선례를 지목. (4) **has-repro** — problem_statement에 동작하는 `OPTIONS` 설정 예시가 있어 재현/검증 입력이 명시됨(가장 강한 easiness 신호). (5) **P2P trap 약함** — PASS_TO_PASS가 5개로 좁고 모두 같은 테스트클래스의 인접 케이스라 regression 표면이 작다.
- T1이 아닌 이유: 완전 K-Gen(이슈가 코드까지 적어줌)이 아니라 `PG*` 환경변수 이름이라는 도메인 디테일을 끼워야 해서 한 단계 위. T3+가 아닌 이유: 실질 추론(S2)·약한 localize·underspecified가 전혀 없다. 공식 라벨과 본 티어가 어긋나지 않으므로 재조정 불필요.

## 골드패치 분석
- **건드린 파일/함수:** `django/db/backends/postgresql/client.py` : `DatabaseClient.runshell_db`
- **근본 원인:** `runshell_db`는 `conn_params`에서 `database`/`user`/`password`만 추출해 처리하고, password는 `subprocess_env['PGPASSWORD']`로 넘기는 패턴이 이미 있었지만 `sslmode`/`sslrootcert`/`sslcert`/`sslkey`는 아예 읽지도, 환경변수로 전달하지도 않았다. ORM 경로는 libpq에 OPTIONS를 넘기지만 dbshell 경로는 이 feature parity가 누락된 silent-wrong(예외 없이 인증서 무시) 결함.
- **수정 요지:** 첫 헌크에서 `conn_params.get('sslmode', '')` 등으로 4개 값을 추출하고, 둘째 헌크에서 password→`PGPASSWORD`와 동일하게 **값이 truthy일 때만** 각각 `subprocess_env`에 `PGSSLMODE`/`PGSSLROOTCERT`/`PGSSLCERT`/`PGSSLKEY = str(...)`로 설정한다. psql은 이 표준 libpq 환경변수를 인식하므로 명령줄 인자 리스트(`args`)는 건드리지 않고 환경변수 주입만으로 해결한다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1):** `test_ssl_certificate (dbshell.test_postgresql.PostgreSqlDbshellCommandTestCase)` — `sslmode: 'verify-ca'`, `sslrootcert/sslcert/sslkey`를 가진 dbinfo로 `runshell_db` 실행 시, 명령줄은 평소와 동일한 `['psql', '-U', 'someuser', '-h', 'somehost', '-p', '444', 'dbname']`이고 수집된 env dict가 정확히 `{'PGSSLCERT':'client.crt','PGSSLKEY':'client.key','PGSSLMODE':'verify-ca','PGSSLROOTCERT':'root.crt'}`인지 검증.
- **픽스 증명:** test_patch가 헬퍼 `_run_it`을 "PGPASSWORD 단일 값 반환"에서 "`PG`로 시작하는 모든 env var를 dict로 수집(`{key: env[key] for key in env if key.startswith('PG')}`)"으로 일반화한다. 픽스 전엔 4개 변수가 주입되지 않아 env dict가 `{}` → 기대값과 불일치 RED. 픽스 후 GREEN. PASS_TO_PASS의 `test_basic`/`test_nopass`/`test_column`/`test_accent`도 반환 형태를 dict로 맞춰(`{'PGPASSWORD': ...}` / `{}`) 회귀를 같이 보증한다.
- **overfit / regression 관점:** FAIL_TO_PASS가 1개로 얇지만 overfit-risk 플래그는 미부여 — 픽스가 special-case 분기가 아니라 4개 파라미터에 일관 적용되는 truthy-guard 루프형 패턴이라 테스트 너머 입력공간(다른 SSL 값 조합)으로 자연히 일반화된다. CEGIS류 구별입력이 필요한 과소명세가 아니다. regression 표면은 password 처리 블록과 동일 구조라 인접 case(nopass/accent)를 깨지 않는다.

## 모범답안 (오라클 기반)
1. **Localize 경로:** 이슈의 "dbshell command does not support the client cert params" + "#28322"(password를 env로 넘긴 선례) 신호를 따라간다. dbshell은 백엔드별 client 어댑터에 있으므로 `django/db/backends/postgresql/client.py`로 직행, `DatabaseClient.runshell_db` 한 함수에 도달. 그 안의 기존 `PGPASSWORD` 처리 블록이 정확한 패치 템플릿임을 식별한다.
2. **픽스 (왜 올바른 일반화인가):** `conn_params`에서 `sslmode`/`sslrootcert`/`sslcert`/`sslkey`를 `.get(..., '')`로 읽고, 각각 truthy일 때만 `PGSSLMODE`/`PGSSLROOTCERT`/`PGSSLCERT`/`PGSSLKEY`로 `subprocess_env`에 주입한다. psql CLI 플래그가 아니라 libpq 표준 환경변수로 넘기는 게 정답 — Django ORM 경로와 동일한 메커니즘이라 dbshell이 ORM과 같은 SSL 동작을 갖게 되어 진짜 feature parity를 회복한다(특정 테스트값에 맞춘 하드코딩이 아님).
3. **Regression 안전:** PASS_TO_PASS(`test_basic`/`test_nopass`/`test_column`/`test_accent`/SIGINT)를 깨면 안 된다. 픽스가 순수 추가(기존 password/args 로직 비변경)이고 ssl 값이 없으면(`''`) 어떤 env도 주입하지 않으므로, ssl 옵션 없는 기존 케이스는 byte-identical하게 동작한다 — 그래서 회귀가 발생하지 않는다.
4. **함정 회피:** 오라클 없는 에이전트가 틀릴 지점 — (a) psql 인자 리스트(`args`)에 존재하지 않는 `--sslmode` 같은 CLI 플래그를 만들어 넣는 환각(libpq는 환경변수로만 받음), (b) "값이 있을 때만 주입"을 빠뜨려 빈 문자열로 env를 오염시키는 것(password 선례가 truthy-guard를 보여줌), (c) mysql/oracle 등 다른 백엔드 `client.py`까지 손대는 scope 과잉. 환경변수 4개·단일 함수로 좁히는 절제가 핵심.
