# Cursor 3.2.16 — Git ecosystem (통합 catalog)

> Cursor 3.2.x의 **모든 git 관련 기능**을 한 곳에. 기존 13 cursor-* doc에 분산된 git 부분을 정리 + 신규 발견. ✅verbatim / ≈inferred / 🔒server-side / ❓unverifiable.

## TL;DR — Cursor git 기능 9-layer 풀세트

| 레이어 | 무엇 | 출처 doc | quanta 흡수 |
|---|---|---|---|
| ① Shadow git ODB | `~/.cursor/snapshots/` 자체 git repo, ref `cursor/snapshots/{headCodebase,last-registered,last-verified}` + `gix-snapshot` Rust 크레이트 | rust-engine §1.2 | ★Tier0 **패턴** |
| ② GitGraph (server) | 9 RPC — 서버측 commit-graph + **co-change retrieval** (encrypted_relative_path + weight) | bugbot-review | Tier1 (로컬 변종) |
| ③ GitIndex (PR history) | 6 RPC — PR을 별도 retrieval corpus로 인덱싱 | bugbot-review | Tier2 (PR 기능 도입 시) |
| ④ captureGitHistory | Rust NAPI — 단계별 DAG walk + 5-knob budget | rust-engine §1.4 | Tier1 패턴 |
| ⑤ ToolCall git 5종 | blame_by_file_path / set_active_branch / pr_management / update_pr_code_tour / edit_pr_labels | cursor.md §3 | 부분 Tier1 |
| ⑥ BC PR ops 12 | MakePR/OpenPR/Merge/EnableAutoMerge/ConvertFromDraft 등 cloud 직접 조작 | background-composer | 🔒SKIP (cloud) |
| ⑦ Diff-tab git 액션 10 | UI pill: commit/push/createPr/babysitPrInCloud/multitaskSplitPrs… | cursor.md §2G.1.q | UI bound |
| ⑧ CTK git 스킬 7 | babysit/fix-merge-conflicts/get-pr-comments/loop-on-ci/make-pr-easy-to-review/new-branch-and-pr/pr-review-canvas/review-and-ship | (신규) | ★Tier0 prompt-only |
| ⑨ CursorCommits AI 기여도 | scored_commits DB + GetCommitMetrics(ByFilePath) RPC | repomap §9 | Tier2 (commit trailer로 단순화) |
| ⑩ `.git` write deny | cursorsandbox seatbelt deny-regex (`.git/{hooks,config}`/`.cursorignore`/`.vscode`) | ADR-0091 | ✅SHIPPED (0091/git-write-guard) |

→ Cursor는 git을 **단순 도구가 아니라 retrieval/메모리/실행 환경 통합 평면**으로 다룬다. 가장 기깔난 건 **①shadow ODB**(workspace history를 .git 안 더럽히고 추적), **②co-change weight**(자주 같이 바뀌는 파일 자동 surface), **⑧babysit 클라우드 loop**(PR을 merge-ready로 유지하는 장기 에이전트).

---

## ① Shadow git ODB — `~/.cursor/snapshots/` (gix-snapshot Rust)

**가장 기깔난 git 기능.** Cursor는 사용자 `.git`을 안 건드리고 **자체 shadow git repo**를 운영해서 agent diff/workspace history를 추적.

### 위치 & ref namespace ✅
- 경로: `~/.cursor/snapshots/`
- ref namespace: `cursor/snapshots/{headCodebase, last-registered, last-verified}`
- 별도 Rust 크레이트 `crates/gix-snapshot/` (41 source files) — gitoxide fork + 커스텀 coordinator + repack + storage budget
- NAPI 노출: `CodebaseSnapshotClient` (file-service.node) — `addCodebase / disposeFast / removeCodebase / commitAll / recordChanges / getBfsPaths / markRegistered / markVerified / markVerifiedV2`

### 커스텀 메커니즘 ✅
- **Geometric repack** + storage budget (`storage_budget.usage_ratio`, `operational_exceeded` strings)
- **Loose→packfile 마이그레이션** (`Legacy loose migration: <n> objects packed`)
- **Maintenance lock** (`Failed to acquire maintenance.lock`)
- **Primary + secondary index** + diff/patch/slice 작업
- File watcher (`notify-rs fsevents loop`) + debounce
- 멀티 워크스페이스: snapshot 매니저가 workspace 추가/제거 관리

### 왜 기깔나나
사용자 `.git`을 절대 안 건드림 → workspace history(agent edit 포함) 추적이 **non-invasive**. agent diff를 replay/rewind 가능. PR로 promote할 때만 정식 commit으로 변환.

### quanta 흡수 ★ Tier0 (패턴)
**Rust 크레이트 자체는 안 베낌** (41 source). 대신 패턴 차용: `isomorphic-git`으로 `~/.quanta/snapshots/` shadow repo, ref namespace `quanta/snapshots/*`. *동작 정의는 ADR 후보*. EffectChannel(0093)과 결합 = effect가 snapshot에 자동 기록되는 *provenance* layer.

---

## ② GitGraphService 9 — co-change retrieval ✅

**서버측 commit-graph 인덱스**. 9 RPC (IDE @33975756):
- `InitGitGraph` / `InitGitGraphChallenge` — Merkle 챌린지 핸드셰이크
- `BatchedUploadCommitsIntoGitGraph` — commit 묶음 업로드
- `GetPendingCommits` / `MarkPendingCommits` — 동기화 트래킹
- ★ **`GetGitGraphRelatedFiles`** — co-change retrieval (이 파일이 자주 같이 바뀌는 파일들). 응답 `{encrypted_relative_path: bytes, weight: float}` ← **E2E 암호화된 path + weight 점수**
- `GetGitGraphStatus` / `DeleteGitGraph` / `IsGitGraphEnabled`

### 왜 기깔나나
- **co-change weight**: 사용자가 `foo.ts`를 보고 있으면 자동으로 같이 자주 바뀌는 `bar.ts`/`baz.ts`를 컨텍스트에 surface — 인덱스가 아니라 *commit 패턴*에서 유도
- **E2E 암호화**: 클라가 path를 해시/암호화한 형태로만 서버에 보내고 받음 → privacy
- Cursor의 retrieval과 별도 entity (서버측 commit graph 인덱스)

### quanta 흡수 ★ Tier1
**로컬 변종 가능**: gitoxide나 isomorphic-git으로 commit 메타 walk → co-change matrix 빌드. quanta `ContextSource`(0096) 구현체로 1개 추가. 암호화는 quanta 로컬이라 불필요.

---

## ③ GitIndexService 6 — PR history 별도 corpus ✅

**PR을 retrieval corpus로 따로 인덱싱.** 6 RPC (IDE @24948954):
- `RepoHistoryInitHandshake` — PR history 인덱싱 초기화
- `RepoHistorySyncOne` / `RepoHistorySyncComplete` — resumable sync
- `RemoveRepoHistory` — 삭제
- ★ **`SearchPRHistory`** — 과거 PR 본문/메타 검색
- `GetPRIndexingStatus` — 진행률

### 왜 기깔나나
chat에서 "이전에 비슷한 이슈 어떻게 풀었지" → 과거 PR 검색해 컨텍스트로 가져옴. **retrieval과 분리된 별도 corpus**(코드 인덱스 ≠ PR 인덱스).

### quanta 흡수 Tier2 (PR 기능 도입 시)
quanta가 PR-bound 작업 흡수 안 했으니 deferred. 도입 시: `gh pr list`로 메타 fetch → SQLite FTS5로 로컬 검색 (quanta `apps/eval/` 패턴 재사용).

---

## ④ captureGitHistory NAPI — 단계별 DAG walk + 5-knob budget ✅

`@anysphere/file-service` Rust NAPI top-level function (rust-engine §1.4):

**`CaptureBudget`** 5 필드:
```
maxCommits, maxWallTimeMs, maxPackBytes, targetDurationMs, consecutiveOverBudget
```

**`GitHistoryStage`** 5단계: `RefStore → Commit → PackTree → PackBlob → Pack`

**`CaptureGitHistoryOptions`**:
```
includePreimageBlobs, tipOverrides, maxBlobBytes, baselineOidsPath,
stage, budget, maxCommits, packSizeLimitBytes
```

**결과**:
```
stage, capturedCommits, shallowCommits, pendingFrontier, packs,
deferredBlobs, refStateHash, updatedBudget, elapsedMs
```

### 왜 기깔나나
- **단계별 점진 capture**: 한 번에 전체 history 안 빨아들이고 stage별로 — `RefStore`(refs만) → `Commit`(메타) → `PackTree`(트리) → `PackBlob`(blob) → `Pack`(최종 packfile)
- **5-knob budget**: wall-time/commit-count/byte-count/target-duration/consecutive-over-budget → unbounded walk 차단
- agent context용 commit history packfile 점진 생성

### quanta 흡수 Tier1 (capture-budget 패턴)
unbounded git walk가 있는 어떤 도구에도 적용 가능. 5-knob budget + consecutive-over-budget backoff는 우리 `git_upstream_check`(ADR-0064) 같은 hot-loop에 정확히 fit.

---

## ⑤ ToolCall git 5종 ✅

`agent.v1.ToolCall` oneof 44 중 git 관련 5개:

| no | tool name | args | 용도 |
|---|---|---|---|
| 40 | `pr_management_tool_call` | `PrManagementArgs` | PR 메타 조작 (제목/설명/라벨/상태) |
| 43 | `blame_by_file_path_tool_call` | `BlameByFilePathArgs` | git blame (라인별 commit/author) |
| 46 | `set_active_branch_tool_call` | `SetActiveBranchArgs` | 브랜치 체크아웃 |
| 50 | `update_pr_code_tour_tool_call` | `UpdatePrCodeTourArgs` | PR code tour 업데이트 (StreamCodeTour 짝) |
| 52 | `edit_pr_labels_tool_call` | `EditPrLabelsArgs` | PR 라벨 직접 편집 |

각 도구는 모델이 호출 가능 (cloud agent path에서 주로).

### quanta 흡수 부분 Tier1
`blame_by_file_path`는 portable (gitoxide blame). `set_active_branch`는 셸로 충분. `pr_management`/`update_pr_code_tour`/`edit_pr_labels`는 cloud PR ecosystem 종속 → SKIP.

---

## ⑥ BackgroundComposer PR ops 12 🔒 (cloud SKIP)

cursor-background-composer.md §4 참조. 12 RPC: `MakePRBackgroundComposer`, `OpenPRBackgroundComposer`, `GetBackgroundComposerPullRequest`, `MergePullRequest`, `EnablePullRequestAutoMerge`, `ConvertPullRequestFromDraft` 등.

**클라우드 백엔드 종속 — quanta 인프라 없음.** 단 **shape는 reference**: PR을 first-class entity로 다루는 RPC 디자인.

---

## ⑦ Diff-tab git 액션 10 — UI pill 트리거

cursor.md §2G.1.q에 verbatim. 10 액션 = `qfu` 함수가 `SimulatedMsgReason` 매핑:

| pill | one-liner | reason |
|---|---|---|
| createBranchAndCommit | "Execute the selected diff-tab create-branch-and-commit action." | (UI) |
| createBranchCommitAndPush | "...create-branch-commit-and-push action." | (UI) |
| commit / commitAndPush / push | "...commit / commit-and-push / push action." | DIFF_TAB_COMMIT / _AND_PUSH / _PUSH |
| createPr | "...create-pull-request action." | DIFF_TAB_CREATE_PR |
| createPrWithChanges | "...commit-and-create-pull-request action." | (combined) |
| fixMergeConflicts | "...fix-merge-conflicts action." | DIFF_TAB_FIX_MERGE_CONFLICTS |
| babysitPrInCloud | "...babysit-pull-request-in-cloud action." | **BABYSIT_PR_IN_CLOUD** |
| multitaskSplitPrs | (KtC 멀티라인, split-to-prs 스킬 사용) | MULTITASK_SPLIT_PRS |

★ **Cursor.md §2G.1.q 표는 9 액션, 여기 10 = createPrWithChanges 포함.** (cursor-audit-corrections에서 9로 정정한 게 더 정확할 수 있음 — qfu가 9개+combined 1개)

### quanta 흡수
UI surface bound. 단 **simulated re-entry 패턴**(pill → reason → 합성 message)은 우리 ConversationAction(0071)과 일맥상통.

---

## ⑧ CTK git 스킬 7 — 가장 즉시 흡수 가능 ★

`~/.cursor/plugins/cache/cursor-public/cursor-team-kit/.../skills/` 7 git 스킬 SKILL.md 본문 verbatim:

### a. `fix-merge-conflicts`
> Resolve merge conflicts non-interactively, validate build and tests, and finalize conflict resolution.
> **Workflow**: 1) Detect all conflicting files from git status and conflict markers. 2) Resolve each conflict with minimal, correctness-first edits.

### b. `get-pr-comments`
> Fetch and summarize review comments from the active pull request.
> **Workflow**: 1) Resolve the active PR for the current branch. 2) Fetch review comments and discussion comments.

### c. `loop-on-ci` (이미 cursor.md §2G.2에 있음 verbatim)
> Use `gh pr checks` as source of truth. Loop: resolve PR → inspect → diagnose/wait → push → re-check.

### d. `make-pr-easy-to-review` ★ (특히 기깔남)
> "make this easy to review"/"tidy this PR"/"clean up commits"/"annotate the diff" 트리거.
> **Workflow**: 1) Resolve target PR. 2) Inspect commits/diff size/changed paths/generated files/PR description. 3) Identify reviewability issues: **noisy commits, stale description, unrelated changes, mixed mechanical and logic changes, missing tests, unclear reviewer entry points**. 4) Propose a plan **before** rewriting history or force-pushing.
> → 자동 PR cleanup, "reviewer 친화"라는 목표 명시.

### e. `new-branch-and-pr`
> Create a fresh branch, complete work, and open a pull request.

### f. `pr-review-canvas` ★ (HTML walkthrough 생성)
> `disable-model-invocation:true` (manual only). GitHub PR URL → `gh api` 병렬 fetch → 파일 categorize(core vs mechanical) → reviewer annotation → **moved-code detection 포함 diff render** → 인터랙티브 HTML.
> → **diff render에 moved-code 감지** (이동/리네임 변경을 일반 add/delete가 아니라 별도 카테고리로) — 단순 git diff보다 훨씬 강함.

### g. `review-and-ship`
> Review current branch → run/write tests → commit focused work → open/update PR.
> "Gather context: diff against base branch, uncommitted changes, recent commits, changed files, and user intent from recent relevant chats."

### h. (cursor.md §2G.2 이미 있음) `babysit` — keep PR merge-ready loop (가장 유명)

### quanta 흡수 ★ Tier0 (prompt-only, 즉시)
7 SKILL.md 본문은 **순수 prompt + gh/git 셸 명령**. quanta 시스템 스킬로 직접 포팅 가능. 특히:
- **make-pr-easy-to-review**: PR cleanup automation (noisy commits/stale desc/unrelated/mixed mechanical+logic 감지)
- **pr-review-canvas**: moved-code detection diff renderer (HTML 대신 마크다운 walkthrough로)
- **fix-merge-conflicts**: build-validated conflict resolution
- **review-and-ship**: end-to-end ship workflow

quanta `src/skill/` 시스템에 7 스킬 일괄 흡수 candidate.

---

## ⑨ CursorCommits — AI authorship tracking ✅

(repomap §9 + audit-corrections에서 부분 정리)

### scored_commits 테이블
`~/.cursor/ai-tracking/ai-code-tracking.db` 안 6 테이블 중 핵심:
```
scored_commits (composite PK commitHash+branchName):
  scoredAt, linesAdded/Deleted,
  tabLinesAdded/Deleted, composerLinesAdded/Deleted,
  humanLinesAdded/Deleted, blankLinesAdded/Deleted,
  commitMessage, commitDate,
  v1AiPercentage TEXT, v2AiPercentage TEXT  ← 사용자별 통계 1129 rows
```

### `ai_code_hashes` (~107K rows)
라인별 AI 작성 추적. `{hash:string(FNV류, crypto아님), source:composer|tab|cli|human, fileExtension, fileName, requestId, conversationId, timestamp, model, createdAt}`.

### 작동 방식 ✅
- `repo.onDidCommit` (git hook 아님) workspace event 워처
- 라인 해시 = `filePath:lineText` 정규화 (language-normalized로 Prettier 후도 매칭)
- v1 = strict line-hash match (~23%), v2 = session/commit-귀속 (~99.95% — metric 부풀림)

### ConversationsService (이름 misleading)
- `GetCommitMetrics` / `GetCommitMetricsByFilePath` — commit별 AI authorship 통계 (대화 영속 아님)

### quanta 흡수 Tier2 (단순화)
풀 DB 베끼지 X. **commit trailer로 단순화**:
- 우리 git commit 도구가 `X-Quanta-AI: composer` / `X-Quanta-Model: gpt-5` / `X-Quanta-Conversation: <id>` / `X-Quanta-AI-Lines: <n>/<total>` trailer 추가
- 별도 DB 불필요, git log --grep으로 쿼리, 클론으로 전파
- Edit/Write 시점 ground-truth 있으니 hash 재구성 불필요 (audit §10 이미 정리)

---

## ⑩ `.git` write deny — git-write-protection (SHIPPED)

ADR-0091 (quanta side) — `gitWriteProtectReason(path)` pure detector:
- `git_hooks` (`.git/hooks/**`) — git 다음 op에서 자동 실행 → 코드 실행 탈옥
- `git_hooks_dir` (`.git/hooks/` 자체)
- `git_config` (`.git/config`) — git이 실행할 executables 정의 가능
- `editor_config` (`.vscode/**`) — 에디터가 자동 task 실행

evidence: cursorsandbox seatbelt SBPL deny-regex (cursor-rust-engine §3.2 verbatim).

**SandboxEffectChannel** (ADR-0095)이 이걸 effect 경계에 적용 가능 (`blockGitWrites:true` 정책).

---

## 종합 — 우선 흡수 ★ Top 5

| 우선 | 무엇 | 출처 | 비용 |
|---|---|---|---|
| 1 | **CTK 7 git 스킬 일괄 포팅** (특히 make-pr-easy-to-review, pr-review-canvas의 moved-code 감지, fix-merge-conflicts) | §⑧ | S (prompt-only) |
| 2 | **co-change weight ContextSource** (로컬 commit graph walk) | §② | M (gitoxide/isomorphic-git) |
| 3 | **Shadow git ODB 패턴** (`~/.quanta/snapshots/` + ref namespace + provenance) | §① | L (ADR + 구현) |
| 4 | **captureGitHistory 5-knob budget 패턴** unbounded git walk에 | §④ | S (knob 추가) |
| 5 | **commit trailer로 AI authorship** (DB 대신) | §⑨ | S (git tool seam) |

이미 SHIPPED:
- 0091 git-write-protection (§⑩)
- branch-only.ts (quanta 자체 — protected branch 가드)
- git_upstream_check ADR-0064

🔒 SKIP (cloud 종속):
- BC PR ops 12개 (§⑥)
- GitIndex PR history (§③ — PR 기능 도입 시 재고)
- E2E 암호화 (§② — 우리 로컬이라 불필요)
- diff-tab UI pill (§⑦)

---

## 가장 충격적인 단일 발견

**`pr-review-canvas`의 moved-code detection** — 일반 git diff는 `foo()` 이동을 `delete from A.ts` + `add to B.ts`로 표시하는데, Cursor는 이걸 **별도 카테고리로 인식해서 reviewer에게 "이건 이동/리네임이지 실제 변경 아님"이라고 surface**한다. 큰 refactor PR에서 reviewer 부담 크게 줄임.

quanta가 PR review 도구를 만든다면 **반드시** 이 패턴 흡수. CTK 스킬 `pr-review-canvas/SKILL.md` 본문이 구현 청사진 (HTML 대신 마크다운으로 적응).
