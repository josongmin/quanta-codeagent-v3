# Cursor 3.2.16 — Service Deep Dives (Shadow / FastApply / PtyHost + 58-service map)

> 흡수 후보로 지목됐던 3개 서비스 정밀 분석 + 58개 `aiserver.v1.*Service` 전수 매핑 + 다음 deep-dive 후보. 자매: [cursor.md](cursor.md) / [cursor-localization.md](cursor-localization.md) / [cursor-rust-engine.md](cursor-rust-engine.md) / [cursor-audit-corrections.md](cursor-audit-corrections.md). 마킹 ✅/≈/🔒/❓.

## 0. 한눈 결론

| 서비스 | 기대 | 실측 | quanta 흡수 |
|---|---|---|---|
| **ShadowWorkspaceService** (13) | "fork+verify before merge" (Tier 0 희망) | **두 번째 VS Code 창**(같은 디스크), fork 아님, verify-merge 아님 | **❌ SKIP** (Electron surface 종속) |
| **FastApplyService** (2) | Cursor edit 차별화 엔진 | 2 메서드는 bookkeeping뿐. 진짜 fast-apply는 `AiService.StreamFastEdit` | infra 🔒SKIP, **envelope ✅ABSORB (Tier 0)** |
| **PtyHostService(6)+TmuxSessionService(4)** | long-running CLI 인프라 (P1 희망) | cloud dev-VM 터미널 제어 평면 (로컬 셸과 별개 SIBLING) | **Tier 2** (cloud-VM 생기면) |
| **신규 ★** AiProjectService(8) / AiBranchService(6) | — | HITL multi-gate 계획 루프 / Opus 멀티파일 edit chain | **Tier 0 후보 — 다음 dive 1·2순위** |

---

## 1. ShadowWorkspaceService — ❌ SKIP (이름이 미끼였다)

### 1.1 실체: "두 번째 창" (fork 아님)
`aiserver.v1.ShadowWorkspaceService`(13 unary 메서드, `IDE` @33696771, 실제 구현은 `extensions/cursor-shadow-workspace/dist/extension.js`)는 **server 서비스가 아니라 같은 Cursor의 두 데스크톱 창 사이 cross-window RPC** (Connect-Web over **Unix domain socket** `{cacheHome}/sw{workspaceId}.sock`).

- main 창이 `nativeHostService.openWindow([{workspaceUri}], {forceNewWindow:true, shadowWindowForWorkspaceId})`로 **숨겨진 두 번째 창** 생성
- 두 창은 **같은 on-disk 폴더를 mount** (`Jvh`가 원본 `fsPath` 그대로 씀) — **fork/copy/overlay/worktree 전부 아님**
- 저장 위치 `~/Library/Application Support/Cursor/shadow-workspaces/Untitled-*.code-workspace` (최근 5개 유지)
- **singleton** — 동시 다중 shadow 구조적 불가
- 기본 OFF: `cursor.general.enableShadowWorkspace`
- TTL: shadow 창은 `keepalive()` 후 15분(`destroy-after-N-minutes` workspace-id로 override 가능)에 자가 종료

### 1.2 13 메서드 (전부 Unary)
`GetLintsForChange`, `ShadowHealthCheck`, `SwSyncIndex`, `SwProvideTemporaryAccessToken`, `SwCompileRepoIncludeExcludePatterns`, `SwCallClientSideV2Tool`, `SwGetExplicitContext`, `SwWriteTextFileWithLints`, `SwGetEnvironmentInfo`, `SwGetLinterErrors`, `SwGetMcpTools`, `SwTrackModel`, `SwCallDiagnosticsExecutor`.

### 1.3 "verify before merge"? — **NO** ✅확인
- `GetLintsForChange`: in-memory `ITextModel`에 edit 주입 → 마커 관찰 → `undo`. **디스크 안 건드림 (dry-run lint probe)**. 센티넬 `"THIS SHOULD BE A LINTER ERROR"`로 마커 강제 후 diff.
- `SwWriteTextFileWithLints`: **실제 디스크 파일에 `force:true` save** — commit/merge 게이트 없음.
- `SwCallClientSideV2Tool`: **`RUN_TERMINAL_COMMAND_V2` 외 전부 "not supported in shadow"** — edit/grep/read는 main 창에서 실행.
- `WorkspaceFork`/`Sandbox`/`Speculative*`/`Preview*` sibling 타입 **0개**.

### 1.4 실제 용도 ≈
"Cursor가 백그라운드에서 코드를 **로컬에서 다듬는**(lint-aware CPP/Tab 보정 + 백그라운드 인덱싱)" 숨겨진 창. 마케팅: cursor.com/blog/shadow-workspace. **engine(cursor-agent-exec)은 shadow 참조 0건** — 에이전트 루프가 shadow에 도구콜 안 함. cloud Background Composer가 로컬 sandbox 실행 sidecar로 쓰는 정도.

### 1.5 quanta 흡수: ❌ SKIP (Tier 1/2 fallback 없음)
- fork 아니고 verify-merge 아님 → 우리 `verify-this`/`closeout-guard`/4-truth-surface가 **이미 더 강함** (실제 test/lint를 진짜 repo에 실행).
- "두 번째 VS Code 창" = Electron+VS Code surface 자체. quanta(CLI/Web-Tauri/CLI-browser)에 portable한 숨은 개념 없음.
- **negative invariant 기록**: quanta는 "shadow workspace" 개념 구현 안 함. 미래 RFC가 "두 번째 에디터 인스턴스로 lint dry-run"을 제안하면 이 audit 인용해 reject.
- 유일한 nugget: **`destroy-after-N-minutes` workspace-id TTL 트릭** (리소스 식별자에 TTL 인코딩) — 이미 `subagent-sota-hardening` cleanup에 implicit.

---

## 2. FastApplyService — infra SKIP, **envelope ABSORB (Tier 0)**

### 2.1 헤드라인: FastApplyService(2)는 bookkeeping, 진짜는 AiService에
```
aiserver.v1.FastApplyService {
  ReportEditFate (Unary)   — "사용자가 이 edit 유지했나" 사후 텔레메트리
  WarmApply (Unary)        — 3.2.16에선 클라 측 warmFastApply(e){} 빈 stub
}
```
**실제 fast-apply 스트리밍은 `aiserver.v1.AiService`에**:
- `StreamFastEdit` (ServerStream) ← 핵심 line-streaming 패치 RPC
- `SlashEdit` / `SlashEditFollowUpWithPreviousEdits` / `StreamEdit` / `PreloadEdit`

### 2.2 `StreamFastEditResponse` = 서버 스트림 patch primitive ✅
```
{ line_number:int32, replace_num_lines:int32, done:bool?,
  edit_uuid:string, new_line:string?, reset_new_lines:bool }
```
**`(line_number, replace_num_lines, new_line)` 트리플 스트림** — splice 스타일. 서버 fast-apply 모델이 직접 생성, 클라는 diff 파싱 0. `reset_new_lines`로 mid-stream 재생성.

### 2.3 `FastApplyModelType` enum (25값) ✅
`DEFAULT/DEEPSEEK/SONNET/OPUS_DIFF/SMART_REWRITE/GPT4/.../CODESTRAL_V4..V7/SONNET_35_{DIFF,REWRITE}/PROMPTED_DEEPSEEK_V2` — 25개. A/B testing용 (cloud에서 모델 swap). `FastApplySource`: COMPOSER/CLICKED_APPLY/CACHED_APPLY/COMPOSER_AGENT. `EditFate`: ACCEPTED/REJECTED/PARTIALLY_ACCEPTED.

### 2.4 engine↔IDe edit 흐름 ✅
```
[Cloud LLM] ToolUse: edit_tool_call{ path, stream_content="<전체 새 파일, 스트림>" }
   ↓ engine (agent.v1.EditArgs{path, stream_content})
[IDE] agent.v1.EditToolCall → aiserver.v1.EDIT_FILE_V2(EditFileV2Params{
        relative_workspace_path, streaming_edit:text{stream_content} })
   ↓ Monaco 인라인 적용 (여기선 네트워크 호출 아님) + diff 렌더
[IDE→engine] EditResult.success{
        path, lines_added, lines_removed, diff_string,
        before_full_file_content, after_full_file_content(REQUIRED), message }
   ↓ tool_call_completed → 다음 LLM 턴
[병렬 텔레메트리] FastApplyService.ReportEditFate(request_id, fate, num_accepted/rejected_partial_diffs)
```

### 2.5 왜 "stream full content"가 old/new보다 나은가 ✅ (핵심 설계 통찰)
| 방식 | 단점 |
|---|---|
| old/new string (Claude Code식) | old_string 환각→silent 실패/오영역, 다중 매치 모호 |
| unified diff | 모델이 hunk 헤더 환각 |
| placeholder("// ... existing") | 강한 fast-apply 모델 서버 필요 |
| **Cursor: 전체 새 파일 stream** | • 모델이 anchor-match 안 함(그냥 재작성)<br>• 스트리밍이 latency 가림<br>• diff는 before/after 스냅샷에서 결정론적 계산(파싱 에러 0)<br>• `after_full_file_content`가 single source of truth<br>• patch 모델 A/B를 cloud-model 프롬프트 변경 없이 |

### 2.6 quanta 흡수 — envelope만 (Tier 0 ADR 1개 권장)
| 항목 | 판정 | ROI | 비용 |
|---|---|---|---|
| **`stream_content` 엔진 계약** (old/new 매칭 폐기, 전체 새 파일 1 스트림) | ✅ ABSORB | **HIGH** | LOW (rename + matcher 제거) |
| **`EditSuccess` shape** (`after_full_file_content` REQUIRED + `diff_string`/`lines_added` derived) | ✅ ABSORB | MED | LOW |
| **`EditResult` oneof typed 실패** (`success\|file_not_found\|read_perm_denied\|write_perm_denied{is_readonly}\|rejected{reason}\|error{model_visible_error}`) | ✅ ABSORB | **HIGH** | MED (에러 refactor) — quanta는 현재 raw stack trace leak. `model_visible_error`(LLM용 sanitized)가 Tier-0 |
| **`ReportEditFate` 텔레메트리** (`fate∈{ACCEPTED,REJECTED,PARTIALLY_ACCEPTED}` + partial counts) | ✅ ABSORB | MED | LOW — work-metrics(ADR-0065)에 자연 fit |
| **diff fallback 우선순위** (`QAh`: diff_string → before/after 계산 → streaming-diff) | ≈ ABSORB | LOW-MED | LOW (~30줄) |
| fast-apply 패치 모델 자체 / `StreamFastEdit`/`WarmApply`/`FastApplyModelType` | 🔒 SKIP | — | — |

**→ 단일 ADR: "EditTool envelope refactor: stream_content + typed EditResult"** (P0 0069 typed failure modes의 확장/superset). 단 quanta는 fast-apply 모델 없으니 *적용*은 로컬 결정론 diff/patch (Cursor의 cloud fast-apply 모델 대체).

---

## 3. PtyHostService + TmuxSessionService — Tier 2 (cloud-VM 종속)

### 3.1 위치 정정 ✅
`agent.v1.PtyHostService`(6) + `agent.v1.TmuxSessionService`(4) **존재 확인**. 단 위치는 **IDE workbench + ExtHost** (`agent.v1`이라고 ENGINE이라 했던 건 틀림 — engine 0 hits). 호출은 `aiConnectRequestService.transport()` 경유 = **Cursor cloud backend**.

### 3.2 PtyHostService 6 메서드 ✅
| 메서드 | Kind | I/O |
|---|---|---|
| `SpawnPty` | Unary | `{process:{shell,args}, cwd, env:map, cols, rows}` → `{pty_id}` |
| `AttachPty` | **ServerStream** | `{pty_id, last_event_id?}` → stream `PtyEvent{event_id, pty_data:bytes \| pty_exited{exit_code,signal?}}` |
| `SendInput` | Unary | `{pty_id, data:bytes}` → `{success}` |
| `ResizePty` | Unary | `{pty_id, cols, rows}` → `{success}` |
| `ListPtys` | Unary | `{}` → `{ptys:[{pty_id,shell,cwd,cols,rows,pid,process_args}]}` |
| `TerminatePty` | Unary | `{pty_id}` → `{success}` |

★ `last_event_id` = **disconnect 후 resume** (event-sourced replay) — flaky cloud 연결 핵심. `pty_data`는 stdout/stderr **병합**(PTY 정의상). `TerminatePty`에 signal 필드 **없음**(의도적 minimalism).

### 3.3 TmuxSessionService 4 메서드 ✅
| 메서드 | Kind | I/O |
|---|---|---|
| `CreateSession` | Unary | `{session_name?, display_name, kind, process, cwd, env}` → `{session}` |
| `ListSessions` | Unary | `{}` → `{sessions:[TmuxSession]}` |
| `KillSession` | Unary | `{session_id}` → `{success}` |
| `AttachSession` | **Unary** ⚠️ | `{session_id, cols, rows}` → `{pty_id, session}` |

★ **2-step attach**: `AttachSession`(Unary)이 `pty_id` 발급 → `PtyHostService.AttachPty(pty_id)`로 byte 스트림. `TmuxSessionKind`: USER_MANUAL / AGENT_BACKGROUND / AGENT_INTERACTIVE. `attached_client_count`로 multi-client.

### 3.4 핵심 발견: 기존 셸 도구와 SIBLING ✅
이 RPC들은 `shell_tool_call`/`write_shell_stdin_tool_call`/`await_tool_call`/`background_shell_spawn_args`와 **layer 관계 아님**. 후자는 engine에서 **로컬 `vscode.Pseudoterminal` + `node-pty`** path 사용 (`/node_modules/node-pty/build/Release/spawn-helper`). PtyHost+Tmux는 **cloud dev-VM 터미널 viewer/control 평면** — Background Composer 패널에 live xterm으로 surface.

### 3.5 라이프사이클 ✅
```
CreateSession(kind, process, cwd, env) → TmuxSession{session_id}
     │ (cloud: tmux spawn + initial process)
AttachSession(session_id, cols, rows)  → {pty_id, session}
     │
AttachPty(pty_id, last_event_id?)      → stream PtyEvent{pty_data|pty_exited}
SendInput(pty_id, bytes)               ← 키스트로크
ResizePty(pty_id, cols, rows)          ← xterm resize
     │
TerminatePty(pty_id) -or- KillSession(session_id) → {success}
```

### 3.6 quanta 흡수 — Tier 2 (cloud dev-VM 생기면)
- 지금 quanta 셸은 sync exec. PTY/tmux는 **cloud VM 백엔드 전제** — 그게 없으면 schema import는 dead weight.
- engine 자체도 이 서비스 안 씀(로컬 셸은 node-pty path). 진짜 흡수 타겟은 **로컬 PTY-backed shell**(node-pty)이지 cloud Tmux 아님.
- **통합 경로**:
  - Phase A (Tier 1, 독립): `src/tool/shell/`을 PTY-backed runner로 (`@lydell/node-pty`). cols/rows/ANSI/SIGWINCH/keystroke 스트리밍. surface-agnostic. → long-running dev server / interactive REPL / loop-on-ci 안정 셸.
  - Phase B (Tier 2, cloud 필요): `src/runtime/pty-host/`를 `PtyHostService`+`TmuxSessionService` 스키마로. **`last_event_id` resume 1일차부터** (flaky 연결 가정).
- **함정 회피** (Cursor 의도적 설계 차용): `TerminatePty`에 signal 필드 추가 X (OS portability 버그), `PtyEvent`에 stdout/stderr 분리 X (PTY 병합), **`last_event_id` resume 그대로 복사**.

---

## 4. 58개 `aiserver.v1.*Service` 전수 매핑

(`IDE` brace-match, 정확 카운트. 이전 `strings` 추정의 `MetadataService`/`PagerDutyService`/`GetService` 등은 **false positive** — `GetServerConfig`/`RotateServiceAccount` 등의 substring.)

| 카테고리 | 서비스 (메서드수) |
|---|---|
| **Chat/agent loop** | ChatService(14), ReplayChatService(1), ChatRequestEventService(1) |
| **Indexing/retrieval** | RepositoryService(19), CodebaseSnapshotService(6), GitIndexService(6), FastSearchService(2), FileSyncService(9), GitGraphService(9) |
| **Editing** | FastApplyService(2), CmdKService(6), LinterService(5) |
| **Background/cloud** | **BackgroundComposerService(114)**, AutopilotService(1), SCMService(9), **AutomationsService(31)**, SchedulerService(2), DistributorService(1) |
| **Review/PR/scan** | ReviewService(7), BugbotService(3), BugbotAdminService(5) |
| **Auth/billing** | AuthService(14), **DashboardService(370)**, EnterpriseAdminService(11), TeamCreditsService(3) |
| **Telemetry/eval** | AnalyticsService(7), MetricsService(4), PerformanceEventService(1), ProfilingService(1), WebProfilingService(1), TraceService(1), ToolCallEventService(1), CiMetricsService(5), **EvalTrackingService(21)**, ClientLoggerService(2), OnlineMetricsService(1), RequestReplayService(3), UsageSimulationService(5) |
| **Settings/marketplace** | ServerConfigService(1), MarketplaceService(1), UploadService(9), InAppAdService(4) |
| **VM/sandbox/shadow** | VmDaemonService(22), ShadowWorkspaceService(13) |
| **MCP** | MCPRegistryService(1) |
| **Autocomplete(Tab)** | CppService(5), CursorPredictionService(1) |
| **AI chain/project** ★ | AiService(185), **AiBranchService(6)**, **AiProjectService(8)**, HallucinatedFunctionsService(5), InferenceService(2) |
| **Misc infra** | BidiService(1), DebuggerService(3), DeeplinkService(3), HealthService(7), NetworkService(2) |

**총 58 서비스.** (RPC binding 합계 IDE 번들 ~1,035개.)

### 4.1 헷갈리는 이름 정정 ✅
- **`ConversationsService`(2)** = `GetCommitMetrics`/`GetCommitMetricsByFilePath` — **대화 아니라 commit AI-authorship 텔레메트리**. 실제 대화 영속은 `BackgroundComposerService`.
- **`SchedulerService`(2)** = `Acquire`/`ReportUsage` — **rate-limit 세마포어**, cron 아님.
- **`CursorPredictionService`(1)** = `CursorPredictionConfig`만 — config 조회. 실제 Tab 추론은 다른 path.
- **`FastSearchService`** = 세션 기반 네트워크 ripgrep / **`RepositoryService.SearchRepositoryV2`** = 벡터 검색. 별개 엔진.
- **`FileSyncService`** = cloud blob store(VM에 워킹트리 read 제공) / **`RepositoryService.syncMerkleSubtreeV2`** = 인덱싱 chunk sync. 별개 layer.
- **`BugbotService`(3)** = 암호화 bug-data fetch만. 실제 Bugbot 룰/스캔은 DashboardService + server.
- **`VmDaemonService`(22)** = cloud pod **안에서 도는 in-VM 에이전트** (ShadowWorkspaceService의 cloud 버전: Exec/CallClientSideV2Tool/ReadTextFile/InstallExtensions/GetMcpTools).

---

## 5. ★ 다음 deep-dive 후보 Top 5 (Shadow/FastApply/PtyHost 이후) — **#1~4 완료 → §7, #5 보류**

| 순위 | 서비스 | 왜 |
|---|---|---|
| **1** | **AiProjectService (8)** | `init → clarification → plan → feedback → breakdown → feedback → step → feedback` — **per-phase feedback gate가 있는 HITL 다단 계획 루프**. quanta HITL 4-tier(ADR-0049) 직접 확장. 최소 비용, 최고 패턴 밀도. (offset 33696019) |
| **2** | **AiBranchService (6)** | `OpusChainGetPlan / GetFilePaths / GetFileInstruction / Reflect / RecordAcceptedPatch / ReportModeSelection` — **explicit reflect + patch-acceptance 텔레메트리 있는 멀티파일 edit chain**. quanta plan-exit-flow + work-metrics에 slot-fit. (offset 33709824) |
| **3** | **EvalTrackingService (21)** | `Eval ⊃ Run ⊃ {RunStatus, RunSummary, RunMetrics, RunParams}` — quanta `apps/eval/` 스켈레톤에 ready-made 스키마. (offset 33957870) |
| **4** | **AutomationsService (31)** | `Spec/Validate/Apply/Test/Memory/WorkflowTemplate/BuilderCompletion/Sentry-trigger` — **declarative 에이전트 워크플로 + memory + trigger**. quanta가 현재 안 다루는 axis. (offset 33833295) |
| **5** | **DashboardService — policy slice만** (~30/370) | `GetTeamRules/GetTeamCommands/GetTeamHooks/GetGlobalCommands/GetRepoSlashCommands/GetManagedSkills/ResolvePluginsByRef/GetEffectiveUserPlugins/InstallUserPlugin/...` — **plugin+rule+command+skill+hook resolution 프로토콜**. 팀 배포 시 필요. (offset 32415489) |

honorable mention: `BackgroundComposerService(114)` babysit 백엔드 (follow-up queue는 Codex와 중복 — non-overlap pass만), `GitIndexService(6)` PR-history 인덱싱(별도 corpus, defer), `HallucinatedFunctionsService(5)` "모델이 발명한 함수명을 서버가 즉석 scaffold"(R&D, defer).

---

## 6. 흡수 우선순위 종합 (이 라운드 신규)

| 우선 | 항목 | 출처 | 비고 |
|---|---|---|---|
| **P0** | EditTool envelope refactor (stream_content + typed EditResult + ReportEditFate) | FastApply §2.6 | 0069 typed failure modes의 superset, 단일 ADR |
| **P0** | 샌드박스 deny-regex invariant (`.git/{config,hooks}`/`.cursorignore`/`.vscode` write deny) | rust-engine §3.2 | "symlink 탈옥방어"의 *진짜* 근거 — 이제 evidence 있음 |
| **P1 dive** | AiProjectService HITL 다단 계획 루프 | §5 #1 | 다음 라운드 1순위 |
| **P1 dive** | AiBranchService reflect+patch chain | §5 #2 | 다음 라운드 2순위 |
| **P1** | Snapshot shadow git ODB 패턴 (isomorphic-git) | rust-engine §5.1 | ADR 후보 |
| **P2** | EvalTrackingService 스키마 → apps/eval | §5 #3 | 스켈레톤 채우기 |
| **P2** | 로컬 PTY-backed shell (node-pty) | PtyHost §3.6 Phase A | cloud 무관, long-running 셸 |
| **SKIP** | ShadowWorkspaceService | §1.5 | negative invariant 기록 |
| **SKIP** | fast-apply 모델 인프라 / cloud Tmux | §2.6 / §3.6 | 백엔드 종속 |

---

## 7. 라운드2 deep dives — AiProject / AiBranch / EvalTracking / Automations (✅ 완료)

§5 Top-5 중 4개 정밀 분석 완료(DashboardService policy slice는 socket error로 보류). 전부 evidence-based.

### 7.1 AiProjectService(8) — HITL 다단 계획 ladder → **Tier 1 ADR** ✅
- 8 메서드 **전부 ServerStreaming**, descriptor `uby` @33696019. 4-phase: **init → clarification → plan → breakdown → step**, 각 phase마다 **paired `*Feedback` RPC + loop/advance 시그널**:
  - clarification: `repeat_clarification:bool` (Q&A 루프)
  - plan/breakdown/step: `feedback_or_progress:str` + `force_move_to_next_step:bool` → `{revised | repeat_feedback}`
  - step gate가 가장 풍부: `modify_code_payload{files_to_modify[], feedback_text}` — 특정 파일 타겟 수정
- **3-level decomposition**: PROJECT → PLAN(prose) → BREAKDOWN(`.Step{step_number, step_description, step_type}`) → STEP(`StepPayload`: write_code/run_term/creating_files/revise_code). `AiProjectStepType` enum: READ_WRITE_FILE/RUN_TERM/CREATE_RM_FILES. `AiProjectShellType`: BASH/POWERSHELL.
- **STATELESS 서버**: `project_id` 없음. 클라가 orchestrator, `previous_messages:PureMessage[]`(SYSTEM/USER/ASSISTANT) + plan output→breakdown desc/spec→step의 full plan+breakdown[] 재전송으로 state carry. async seam = `background_task_uuid`.
- **DORMANT**: 양 번들에 call-site 0건. schema-registered만, 미사용(legacy or server-driven). ≈ "build me X" scaffolding 의도 추정.
- **Plan mode(`.plan.md`)와 별개** — 다른 schema family, 더 무거운 server-orchestrated 변종.
- ★ **흡수**: Tier 1 — quanta `plan-exit-flow.ts`(ADR-0063 단일 3-way gate)를 **N-phase `PhaseGate` state machine**으로 일반화. 각 phase = (generate → present → {iterate w/ feedback | force-advance}). `step_type`를 permission 4-tier 사전 admissibility 태그로. `force_move_to_next_step`(approve≠advance 분리)·per-step `files_to_modify[]` feedback이 최고가치 primitive. default-OFF seam. **ADR rec**.

### 7.2 AiBranchService(6) — lint-grounded reflect gate → **Tier 1 ADR** ✅
- descriptor `dby`. 6 메서드: `OpusChainGetPlan`(stream)/`OpusChainGetFilePaths`(unary→ranked Path[])/`OpusChainGetFileInstruction`(unary)/`OpusChainReflect`(stream)/`RecordAcceptedPatch`/`ReportModeSelection`.
- ★ **핵심 = `OpusChainReflect`**: edit 후 self-critique gate. 입력 = 실제 diff(`old_file_contents`,`new_file_contents`,`patch_string`) **+ 진짜 linter 출력**(`lints:GetLintsForChangeResponse`) + plan context. 출력 = streamed `text` + **typed `Decision` oneof**:
  - `accept` → 커밋 진행
  - `retry_without_more_information` → 컨텍스트 충분, 재시도
  - `retry_with_codebase_question{codebase_questions[]}` → **"고치기 전에 찾아봐야 함"** — 질문 반환 → 답이 다음 GetPlan의 QA로 환류
- 정체: **hallucinated-function / scaffold-implementation** 기능 (생성코드가 없는 함수 참조시 Opus가 plan→파일선택→per-file edit→lint reflect). v2는 `HallucinatedFunctionsService`(`Opus2ChainPlan/ApplyPlan/Reflect`)에 — **reflect의 3-case Decision은 양세대 공통 = 의도적 stable core**. `override_model` 기본 Opus.
- ★ **흡수**: Tier 1 — **lint-grounded reflect + typed 3-way decision** 패턴(별도 loop/service 아님). quanta closeout-guard/plan-exit-flow에 `needs_context` 3번째 분기(구조화 질문 → search-first 환류) 추가 + work-metrics-collector(ADR-0065) record에 `reflection`/`source` 필드. reflect 입력에 실제 lint/typecheck 결과 주입(verify-workflow 결합). **단일 ADR, cross-ref 0063/0065**. ❌ Opus chain을 별도 loop로 fork 금지(deferred-as-variant regression trap).

### 7.3 EvalTrackingService(21) — eval 스키마 → **Tier 0-1 additive** ✅
- 21 메서드 **전부 Unary**. 정체: **remote 모델-eval/training 파이프라인 sink**(Ray cluster + S3 artifact + Slack cron). write-only — `ListRuns`/`CompareRuns` 없음(aggregation은 dashboard).
- 데이터모델: **`Eval` ⊃ `Run` ⊃ {rollouts, metrics, params}**. `Eval`=named benchmark, `Run`=(model_name × dataset_name × params) 1실행, rollout=(data_point × iteration) 채점단위.
  - `EvalRunStatus` enum: UNSPECIFIED/PENDING/BUILDING/SUBMITTED/RUNNING/FINISHED/FAILED/KILLED
  - `RunMetricItem{key, value_num, value_text, unit, tags, step, ts}` — step+ts로 곡선
  - `RunParamKV{key_path, value_text|num|bool|json|null}` — typed oneof
  - `UpsertRunRolloutStatus`(가장 풍부): data_point_id/iteration_no/status + prompt/completion/cache 토큰 + total_cost_usd + metrics_by_scorer(다중 채점자)
- ★ **흡수**: quanta `apps/eval/`(JSONL append-only, tier 기반)는 **이미 목적에 더 fit** — RPC/Ray/cron/RL 전부 부적합(negative invariant). 단 **3개 작은 shape additive**: `Metric{key,value,unit?,step?}`(단일 score보다 표현력↑, 최고 steal) + `EvalRunStatus` terminal subset(`running|finished|failed|killed`) + `RunParamKV` params(재현성, compare tier가 winner 귀속) + token/cost 필드. 대상: `src/apps/eval/storage/schema.ts`. 전부 optional, non-breaking.

### 7.4 AutomationsService(31) — declarative event-triggered 에이전트 → **Tier 1 ADR (fresh axis)** ✅
- 31 메서드 전부 Unary, descriptor `Bby` @33833308. 정체: **선언적 trigger→agent-invocation** 워크플로 (cloud Background-Agents/Bugbot 제품).
- 모델: `Automation ⊃ Workflow{triggers[], actions[], prompts[{prompt, effort:STANDARD|HARD}], memory_enabled, git_config, agent_options}`. = **trigger(s) → (agentic filter) → agent prompt(s) as background Composer → action(s)**.
- ★ **Trigger oneof 8종 + agentic filter**: cron / git(PR/push/CI/issue_labeled/label) / slack / linear / webhook(+API key mint) / slack_channel_created / pagerduty / sentry + **`agentic_filter_prompt:str`**(LLM이 "이 이벤트가 에이전트 깨울 가치 있나" 판정 → ALLOW/BLOCK/ERROR + rationale, run에 기록).
- **per-automation memory**: `automation_id` scope 파일 bag, CAS(`expected_version`|`expect_missing`→`conflict:bool`), `memory_enabled` 게이트. quanta `src/memory/` CAS와 동형.
- **templates**(`WorkflowTemplate{category, input_schema, mcp_hints}`) + **`BuilderCompletion`**(AI 스펙 작성) + **git-backed `AutomationDeploySpec`**(automations-as-code, `source{repo,path,ref,commit_sha}`, `managed_by`).
- **로컬 cron 절반 존재**: `LocalAutomationsCronContribution`(feature gate `local_automations`) — 60s tick → `trigger.type==="cron"` 매칭 → `composerService.createComposer({localAutomation:true, text:prompt, unifiedMode:"agent"})`.
- **rules/hooks와 관계**: 한 layer **위**. rules/hooks는 *진행 중* 턴을 shape, automation은 **이벤트→에이전트 자율 기동**.
- ★ **흡수**: Tier 1 — quanta에 없는 **fresh axis**. 최소 core: `AutomationSpec{name, enabled, trigger, prompt, model?, effort, memory_enabled}` + **cron + manual 2종 trigger만** + `trigger 발화 → 기존 side-conversation/composer로 agent spawn → AutomationRun{status,error} 기록` + per-automation memory(기존 CAS 재사용) + validate/test/apply. ★ **`agentic_filter_prompt`(trigger↔invocation 사이 LLM 게이트 + rationale)가 비명백한 gem** — Tier 1에도 포함. ❌ 외부 connector(Sentry/Slack/Linear/PagerDuty/webhook) 전부 skip(SaaS plumbing). git-backed deploy spec은 Tier 2. **ADR rec**.

### 7.5 라운드2 흡수 종합 (신규 ADR 후보)
| ADR 후보 | 출처 | Tier | 한 줄 |
|---|---|---|---|
| **PhaseGate HITL ladder** | AiProject §7.1 | 1 | plan-exit-flow를 N-phase feedback ladder로 일반화 (project→plan→breakdown→step) |
| **lint-grounded reflect gate** | AiBranch §7.2 | 1 | closeout/plan-exit에 `{accept\|retry\|needs_context}` typed 3-way + 실제 lint 입력 |
| **eval schema additive** | EvalTracking §7.3 | 0-1 | storage/schema.ts에 Metric{key,value,unit,step}+EvalRunStatus+params+token/cost (optional) |
| **declarative automation** | Automations §7.4 | 1 | cron+manual trigger → agentic_filter → agent spawn → run record + per-automation memory |

### 7.6 DashboardService policy slice — **Tier 3 reference-only** ✅ (재시도 완료)
- typeName @32415490. policy 관련 ~25 메서드 검증: `GetTeamRules`/`GetTeamCommands`/`GetGlobalCommands(surface)`/`GetRepoSlashCommands(repo_url,git_ref)`/`GetBackgroundComposerSlashCommands(bc_id)`/`GetTeamHooks`/`GetManagedSkills`/`ResolvePluginsByRef`/`GetEffectiveUserPlugins`/`GetCloudAgentPluginsSnapshot`/`InstallUserPlugin`/`InstallTeamPlugin` + Bugbot rule layer(`GetBugbot{TeamRules,LearnedRules,ManualRepositoryRules,Mode,Settings}`).
- ★ **핵심 구조 발견**: **resolution read는 `team_id`/`user_id`를 안 받음** — 신원은 auth 세션에서 추론, **merge는 서버측**, 클라는 pre-resolved 리스트 수신. `team_id`는 write/admin RPC에만.
- **effective-set = provenance flag**: `EffectivePlugin{plugin, is_team_required, is_enabled, has_team_configured_variables, configured_variables}` — flat merged list 대신 **각 항목에 "어느 layer가 강제/소유하나" 태그**. precedence = `required(team) > user-toggle > default`. `is_required` 비트가 Rule/BugbotRule/EffectivePlugin/install_mode에 반복 = 보편적 mandatory-layer 비트.
- **Plugin = bundle**: marketplace Plugin이 `skills[]/subagents[]/hooks[]/rules[]/commands[]` 함께 carry — plugin 단위 resolution 후 확장. 깔끔한 distribution unit.
- **directory-group scoping**: required-policy가 sub-group(`directory_group_ids`)별, flat team-wide 아님 (monorepo/sub-org).
- ★ **흡수 (Tier 3 — team 기능 도입 시 reference)**: quanta는 team/global/repo/user policy layering·서버 신원 없음. 이식 가능 패턴: ①**서버측 merge + thin client**(read에 tenant id 없음, 신원=auth, agent loop 밖에서 resolve — client precedence 버그 회피) ②**`Effective<T>` envelope w/ source_layer + is_locked + provenance** ③`is_required` 보편 mandatory 비트 ④directory-group scoping ⑤Plugin-as-bundle distribution unit. **흡수 X**: Bugbot GitHub-coupled layer(installation_id/repo_node_id), marketplace CRUD, surface enum(CLASSIC/GLASS/CLI). team 배포 기능 도입 시 reference.
