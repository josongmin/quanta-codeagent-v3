# Cursor 3.2.16 — Repo Map (기깔나는 기능 × 코드 위치)

> 경쟁사 흡수용 레포맵. Cursor 설치본(`/Applications/Cursor.app` + `~/.cursor/`)을 3라운드 감사해 추출. 엔진은 minified protobuf-es라 심볼/enum/필드명으로 위치 표기. 한 줄 = 기능 → 한다는 일 → `위치 (심볼)`. `★`=quanta 흡수 우선순위.

## 증거 파일 (Evidence roots)
- `ENGINE` = `/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-agent-exec/dist/main.js` — 에이전트 실행엔진, protobuf 패키지 `agent.v1`
- `IDE` = `/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js` — IDE + service stubs + 모델-facing 도구문자열
- `EXTHOST` = `/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/api/node/extensionHostProcess.js` — DDL/persistence
- `RETRIEVAL` = `…/app/extensions/cursor-retrieval/dist/main.js` — 인덱싱/검색
- `COMMITS` = `…/app/extensions/cursor-commits/dist/main.js` — AI 코드 추적
- `SANDBOX` = `…/app/resources/helpers/cursorsandbox` — Rust Mach-O, Seatbelt+Bubblewrap+네트워크 프록시
- `CREPE` = `…/app/resources/helpers/crepectl` — Rust grep 데몬(aho-corasick+gitoxide)
- `SKILLS` = `~/.cursor/skills-cursor/**` — 1st-party 스킬 (plaintext, authoritative)
- `CTK` = `~/.cursor/plugins/cache/cursor-public/cursor-team-kit/<sha>/` — cursor-team-kit 플러그인
- `TRACKDB` = `~/.cursor/ai-tracking/ai-code-tracking.db` — SQLite (6 테이블)
- `PLANS` = `~/.cursor/plans/*.plan.md` — plan 아티팩트
- `TRANSCRIPTS` = `~/.cursor/projects/<proj>/agent-transcripts/<uuid>/<uuid>.jsonl`

---

## 1. Agent Runtime & Wire-Protocol
- **단일 BiDi 멀티플렉스 스트림** — 에이전트 루프 전체가 한 스트림 — `ENGINE` `agent.v1.AgentService.Run` (kind=BiDiStreaming)
- ★ **엔진은 도구를 직접 안 돌림, 클라에 위임** — `ExecServerMessage{<tool>_args}` → 호스트 실행 → `ExecClientMessage{<tool>_result}`, 공유 `exec_id` — `ENGINE` `ExecServerMessage`/`ExecClientMessage` oneof
- **per-exec 시크릿 리댁션 + OTel 전파** — read 결과 리댁션/트레이스 — `ENGINE` `redacted_read_args`(field 29), `span_context`(field 19)
- **요청 envelope** — 19 typed 필드 (conversation_state/action/model_details/mcp_tools/skill_options/custom_system_prompt/subagent_type_name/harness…) — `ENGINE`/`IDE` `AgentRunRequest`
- **resume-by-ID (프로세스 경계 넘어)** — agentId로 어젯밤 에이전트 재개 — SDK `Agent.resume(id)`, 상태=`TRANSCRIPTS` JSONL (per-project)
- **subagent fork/persist** — 자식 에이전트 fork·영속·재개 — `ENGINE` `SubagentArgs.fork_agent_id`/`resume_agent_id`, `SubagentPersistedState{conversation_state,created/last_used_ts,type}`
- ★ **루프 거버너를 데이터 계약으로** — idle/max_loops/nudge/escape/wait-children — `ENGINE` `ClientContinuationConfig`
- **token+cache 회계 wire 노출** — 턴 종료 시 in/out/cache_read/cache_write — `ENGINE` `TurnEndedUpdate`
- **pooled-VM 워커 풀** — claim/release 워커 — `IDE` `LifecycleService.{ClaimWorker,ReleaseWorker,ResetInstance}` *(cloud-bound)*
- **스킬/플러그인 핫리로드** — 재시작 없이 — `IDE` `ControlService.{ReloadAgentSkills,ReloadPlugins}`
- **클라→엔진 envelope** — run_request/exec_client_message/conversation_action/interaction_response/kv/heartbeat/prewarm — `ENGINE` `AgentClientMessage` oneof (8 members)
- **엔진→클라 envelope** — interaction_update/exec_server_message/conversation_checkpoint_update/interaction_query/kv — `ENGINE` `AgentServerMessage` oneof (6 members)
- **스트림 변종 3종** — BiDi/SSE/Poll (네트워크·환경별) — `IDE` `AgentService.{Run,RunSSE,RunPoll}`
- **에이전트 이름짓기/요약 RPC** — 거장 nickname + transcript overview — `IDE` `AgentService.{NameAgent,CreateTranscriptOverview,GetUsableModels,GetDefaultModelForCli}`
- **호스트 file-op RPC 표면** — read/write/ls/diff/artifacts/env-update — `IDE` `ControlService.{ReadTextFile,WriteTextFile,ListDirectory,GetDiff,ListArtifacts,UpdateEnvironmentVariables}`
- **모델 라우팅 서버측 alias 해소** — auto/default/fast/composer-N, max_mode만 클라 — `ENGINE` `RequestedModel{model_id,max_mode}`, `ModelDetails.aliases`

## 1b. Streaming I/O & tool-call events (에이전트 출력 어휘)
- **InteractionUpdate 21-member union** — 에이전트 출력 전체 어휘 — `ENGINE` `InteractionUpdate` oneof
- **텍스트/사고 델타** — `text_delta`(1)/`thinking_delta`(4)/`thinking_completed`(5) — `ENGINE`
- **도구콜 스트리밍 4단** — partial→delta→started→completed — `ENGINE` `partial_tool_call`(7)/`tool_call_delta`(15)/`tool_call_started`(2)/`tool_call_completed`(3)
- **step 진행 표시** — 멀티스텝 작업 단계 — `ENGINE` `step_started`(16)/`step_completed`(17)
- **셸 실시간 출력 1급** — 도구결과 기다리지 않고 stream — `ENGINE` `shell_output_delta`(12), `ShellStream` oneof(stdout/stderr/exit/start/backgrounded)
- **요약 스트리밍** — compaction 진행 가시화 — `ENGINE` `summary_started`(10)/`summary`(9)/`summary_completed`(11)
- **턴 종료 + 토큰회계** — `ENGINE` `turn_ended`(14) `{input/output/cache_read/cache_write_tokens}`
- **proactive 제안 surface** — 다음프롬프트/CTA/평가요청 — `ENGINE` `prompt_suggestion`(18)/`post_request_prompt`(19)/`feedback_request`(21) *(일부 cloud/upsell)*
- **heartbeat** — "생각중" 표시용 — `ENGINE` `heartbeat`(13)
- **user_message_appended** — 큐된 메시지 합류 알림 — `ENGINE` `user_message_appended`(6)

## 2. Hooks (20 events, BLOCK/MUTATE/STEER)
- **이벤트 enum 20종** — preToolUse/postToolUse(Failure)/beforeShell·MCPExecution(+after)/beforeReadFile/afterFileEdit/subagentStart·Stop/stop/beforeSubmitPrompt/sessionStart·End/preCompact/afterAgentResponse·Thought/beforeTabFileRead·afterTabFileEdit — `packages/hooks/src/hook-step.ts` enum `Sw` (in `IDE`)
- ★ **`preToolUse.updated_input`** — 도구 인자 mid-flight 재작성 (CC 불가) — `IDE` validator `*Response.ts`
- ★ **`followup_message` 루프제어** — 턴 안끝내고 재프롬프트, `loop_limit`=5 bound — `IDE` `Lnb`, `B0h=5`, CC `{decision:block}`→followup normalize
- **permission allow/ask/deny + agent_message≠user_message** — 모델용·사람용 거부사유 분리 — `IDE` permission-capable set `F0h`
- **precedence deny>ask>allow + failClosed** — most-restrictive-wins — `IDE` `Zp_`, exit code 2 = block
- **prompt-type hook** — shell 대신 LLM 프롬프트를 hook으로 — `IDE` `_executePromptHookScript`

## 3. 도구 레이어 (44 baked-in tools)
- **ToolCall oneof 44멤버** — shell/read/edit/glob/grep/ls/sem_search/web_search/task/ask_question/reflect/await/write_shell_stdin/create_plan… — `ENGINE` `ToolCall` oneof
- ★ **per-failure-mode typed 에러 oneof** — generic string 아님, 케이스별 진단필드 — `ENGINE` `EditResult`/`ShellResult`/`DeleteResult`/`ReadResult`/`WriteResult`
- **`is_readonly` 플래그** — readonly모드 거부 vs 진짜 권한거부 구분 — `ENGINE` `EditWritePermissionDenied.is_readonly`
- **model_visible_error ≠ client_visible_error** — 모델용·UI용 분리 — `ENGINE` `EditError.model_visible_error`
- ★ **async shell: TimeoutBehavior CANCEL/BACKGROUND** — timeout시 죽이지않고 shell_id 발급 — `ENGINE` `ShellArgs.{timeout_behavior,hard_timeout}`, `ShellStreamBackgrounded.shell_id`
- ★ **`await{block_until_ms,regex}`** — 특정 출력 패턴까지 폴링 대기 — `ENGINE` `AwaitArgs`, `AwaitTaskComplete`/`AwaitTaskStillRunning`
- **`write_shell_stdin`** — 대화형 명령에 stdin 주입(+주입직전 offset 반환) — `ENGINE` `WriteShellStdinArgs`, `…Success.terminal_file_length_before_input_written`
- **출력 spill: OutputLocation** — threshold 초과 출력을 파일로, 경로만 컨텍스트 — `ENGINE` `OutputLocation{file_path,size_bytes,line_count}`, `ShellArgs.file_output_threshold_bytes`
- **2단 truncation 플래그** — client vs ripgrep 어디서 잘렸나 + 페이지네이션 echo — `ENGINE` `GrepContentResult.{client_truncated,ripgrep_truncated,head_limit_applied,offset_applied}`
- **edit = streamed full-content + 클라 fast-apply** — old/new도 diff도 아님, 결과로 구조화 diff 반환 — `ENGINE` `EditArgs.stream_content`, `EditSuccess.{diff_string,lines_added,after_full_file_content}`
- **delete undo 보존** — 삭제 전 원본 보존 — `ENGINE` `DeleteSuccess.prev_content`
- **`reflect` 구조화 자기재계획** — 5필드 강제(자유 reasoning 아님) — `ENGINE` `ReflectArgs{unexpected_action_outcomes,scenario_analysis,critical_synthesis,next_steps}`
- **todo DAG + 증분 병합** — todo 의존성 + merge — `ENGINE` `TodoItem.dependencies`, `UpdateTodosArgs.merge`
- **read시 연관 rule 자동주입** — 읽은 파일 glob에 매칭되는 cursor rule 끼워넣기 — `ENGINE` `ReadToolSuccess.related_cursor_rules`
- **TruncatedToolCall** — 컨텍스트서 잘린 과거 콜을 blob 참조로 — `ENGINE` `TruncatedToolCall.original_step_blob_id`
- **exec sub-protocol 도구별 verb** — shell/read/write/delete/grep/ls/diagnostics/mcp/fetch/record_screen/computer_use/execute_hook/subagent — `ENGINE` `ExecServerMessage`↔`ExecClientMessage` 병렬 oneof
- **실행중 강제 백그라운드화** — 셸·서브에이전트를 in-flight로 — `ENGINE` `force_background_shell`(30)/`force_background_subagent`(31), `ForceBackgroundShellArgs{status:ACCEPTED|NOT_FOUND}`
- **백그라운드 서브에이전트 await** — 비동기 자식 결과 회수 — `ENGINE` `subagent_await`(37)
- **셸 abort 사유 typed** — user_abort/timeout — `ENGINE` `ShellAbortReason`, `ShellSuccess.aborted`
- **도구 실패모드 세부** — EditFileNotFound/WriteNoSpace/ShellTimeout/LsTimeout(부분결과반환)/DeleteFileBusy/DeleteNotFile — `ENGINE` per-tool `*Error` 메시지
- **truncation 다층 플래그** — read truncated/exceeded_limit, blob spill — `ENGINE` `ReadSuccess.{truncated,output_blob_id}`, `data_blob_id`

## 3b. Subagent orchestration (에이전트 위임 — 상세)
- **모델-facing `task` 도구** — 모델이 자식 위임 — `ENGINE` `TaskArgs{description,prompt,subagent_type,model?,resume?,agent_id?,attachments[],mode}`
- **follow-up을 특정 자식에 라우팅** — `ENGINE` `TaskArgs.responding_to_message_ids`(9, rep)
- **wire spawn 풀스키마** — `ENGINE` `SubagentArgs{subagent_type,model_id,prompt,readonly,resume_agent_id?,run_in_background?,continuation_config,parent_conversation_id?,interrupt?,mode,fork_agent_id?,root_parent_conversation_id?,selected_context?}`
- **자식 결과** — `ENGINE` `SubagentSuccess{agent_id,final_message?,tool_call_count,background_reason?,transcript_path?}` / `SubagentError{agent_id,error}`
- **subagent_type enum (확장가능 oneof)** — unspecified/computer_use/custom{name}/explore/media_review/bash/browser_use/shell/vm_setup_helper/debug/cursor_guide — `ENGINE` `SubagentType`
- ★ **권한 모드 (custom permissionMode)** — UNSPECIFIED/DEFAULT/READONLY/AGENT_ONLY — `ENGINE` `CustomSubagentPermissionMode`
- **백그라운드 사유** — agent_request/user_request/queued_follow_up — `ENGINE` `SubagentBackgroundReason`
- **병렬 워커 플래그** — 동시 spawn 표시 — `ENGINE` `SubagentStartRequestQuery.is_parallel_worker`(7)
- **start 텔레메트리** — subagent_id/type/task/parent_conversation_id/tool_call_id/subagent_model/git_branch/generation_id — `ENGINE` `SubagentStartRequestQuery`
- **stop 텔레메트리** — status/duration_ms/summary/message_count/tool_call_count/error_message/modified_files[]/loop_count — `ENGINE` `SubagentStopRequestQuery`
- ★ **persisted·resumable·forkable 상태** — `ENGINE` `SubagentPersistedState{conversation_state,created_timestamp_ms,last_used_timestamp_ms,subagent_type}`
- **subagent 전용 system-reminder 트랙** — 메인과 분리 — `ENGINE` `subagentSystemReminder`
- **subagent 정의 파일** — body=system prompt, frontmatter model:fast/is_background — `~/.cursor/agents/*.md`, `CTK/agents/ci-watcher.md`
- ★ **production 행동 디폴트** — 세션의 5%만 사용, 84% explore, readonly default, fast/cheap 모델, fanout 2-3(max5), depth-1 (깊은 트리 over-engineering) — `TRANSCRIPTS` 통계
- *(cloud-bound: DeepSearch/FixLints/Spec/Task SubagentParams in `aiserver.v1`; computer_use/browser_use는 GUI 결합)*

## 4. HITL / 턴-중 스티어링
- ★ **typed ConversationAction 셋** — cancel/cancel_subagent/summarize/resume/user_message{prepend} — `ENGINE` `ConversationAction` oneof (members 1-15), `submitConversationAction()`
- ★ **`cancel_subagent`** — 부모 턴 유지하고 서브 하나만 취소 — `ENGINE` `ConversationAction.cancel_subagent_action{subagent_id}`
- ★ **review-kind × isExecutionBlocking × reason_code 매트릭스** — PLAN만 non-blocking — `IDE` enum `Tbe`, 5× `isExecutionBlocking()`, `*.needs_approval` literals
- **per-gate 결정 동사** — RUN/SKIP/ALLOWLIST_COMMANDS/ALLOWLIST_TOOL/ALLOWLIST_DOMAIN/REJECT_AND_TELL — `IDE` terminal/mcp/web_fetch decision enums
- ★ **simulated-message 루프드라이버** — 모든 재진입=reason 태그 user message — `ENGINE`/`IDE` `SimulatedMsgReason` enum 17값 (PLAN_EXECUTION/COMMIT_REMINDER/BACKGROUND_TASK_COMPLETION/CI_PANEL_INVESTIGATE_FAILURE/USER_*_TO_SUBAGENT…)
- **async ask_question** — non-blocking 질문, 답은 나중에 — `ENGINE` `AskQuestionArgs.run_async`, `AsyncAskQuestionCompletionAction`
- **통합 답변 shape** — single/multi/free/mixed 한 스키마 — `ENGINE` `Question.allow_multiple`, `Answer{selected_option_ids[],freeform_text}`
- **follow-up 큐 3-mode** — queue/interrupt/ask + requeue-on-failure — `IDE` `unprocessedUserMessages[]`, setting `cursor.composer.queueMessageDefaultBehavior` *(quanta 큐가 더 우월)*
- **stop_category + reason_code** — needs_user_approval/provider_error/connection_error — `IDE` `stop_category`, `reason_code:"shell.needs_approval"`

## 5. Plan mode & Context assembly
- ★ **plan mode = enabledTools allowlist (인터셉터 아님)** — 모드가 edit/terminal 도구를 안 줌 — `IDE` 모드 레지스트리 `{id:"plan",enabledTools:[]}`
- **`.plan.md` = live todo 스토어** — create_plan이 쓰고 todo_read/write가 읽음 (한 파일 두 얼굴) — `PLANS` frontmatter `{name,overview,todos[{id,content,status}],isProject}`, `ENGINE` `CreatePlanToolCallHandler`
- **plan 자동제안 키워드매처** — 다국어(plan/refactor/migrate/계획…) — `IDE` `shouldSuggestPlanMode(e)`
- **plan 승인 게이트(non-blocking)** — "Approve this plan?" — `IDE` `PlanReviewModel`, `isExecutionBlocking(){return false}` for PLAN
- **AgentMode enum** — AGENT/ASK/PLAN/DEBUG/TRIAGE/PROJECT/MULTITASK — `ENGINE` `AgentMode`
- **ContextItem typed union** — FileChunk/SparseFileChunk(라인elision)/OutlineChunk/LspSubgraphChunk(call·import이웃)/Lints/CustomInstructions/FileDiffHistory — `IDE` `aiserver.v1.ContextItem`
- **컨텍스트 사후 유용성 평가** — 이 컨텍스트 실제로 쓰였나 — `IDE` `ContextItemStatus.PostGenerationEvaluation`
- **예산초과시 whole-item drop + diff truncate** — `IDE` "All context items were filtered out…", `SparseFileChunk`

## 6. Compaction / Context management
- ★ **compaction 1급 wire 서브시스템** — 라이브 토큰예산 — `ENGINE` `ConversationTokenDetails{used_tokens,max_tokens}`
- ★ **PreCompact HITL hook** — compaction 직전 사람에게 물음 — `ENGINE` `PreCompactRequestQuery{context_usage_percent,messages_to_compact,is_first_compaction}`
- **sliding-window summary archive** — 요약+window_tail+이력 — `ENGINE` `ConversationSummaryArchive{summarized_messages,summary,window_tail}`, `self_summary_count`
- **resumable 전체 상태** — summary+subagent_states+file_states_v2 — `ENGINE` `ConversationStateStructure`

## 7. Sandbox / Permission / Network
- ★ **`.git/hooks`·`.git/config`·`.vscode`·`.cursorignore` write deny** (✅ verbatim 검증, [cursor-rust-engine.md §3.2](../code-agent-loop/cursor-rust-engine.md)) — `SANDBOX`(cursorsandbox) seatbelt SBPL deny-regex. `.cursor/`는 부분deny+`rules|commands|worktrees|skills|agents` whitelist. ⚠️정정: "preflight symlink 탐지"/"found symlink in .git/hooks"는 **틀림** — symlink는 *resolve*만(`sandbox: found symlink:`), 차단은 deny-regex로. 흡수 타겟 자체는 유효
- **command classifier → sandbox 제안** — 모델이 sandbox필요여부+allowlist패턴 동봉, 클라가 로컬정책 교차검증 — `ENGINE` `CommandClassifierResult{commands,suggested_sandbox_mode,classification_failed}`, `Command.suggestedAllowlistEntry`
- **SandboxPolicy** — RW/RO 경로, tmp차단, allowlist면제 플래그 — `ENGINE` `SandboxPolicy{additional_readwrite_paths,disable_tmp_write,allowlist_escalated,capture_denies}`
- **sandbox mode 3-tier** — insecure_none / workspace_readwrite / workspace_readonly — `ENGINE` `SandboxPolicy.Type` enum
- **3-tier 네트워크 정책** — user_config_only/with_defaults/allow_all + allow/deny/default — `ENGINE` `NetworkPolicy{default_action,allow[],deny[]}`, Zod `sandbox.networkAccess`
- **인-프로세스 네트워크 프록시** — HTTP+SOCKS로 모든 연결 강제경유·판정 — `SANDBOX` `--run-proxy`/`--run-socket-forwarder`, `decision.log{decision,reason,url_hash}`
- **permission DSL** — Shell(**)/Mcp(server,tool)/Read/Write glob — `ENGINE` Zod `permissions{allow,deny}`, `matchesShell`
- **precedence 체인** — hook deny > permissions.deny > team blocklist > rm-protection > readonly위반 > auto-approval > prompt (hook이 최후게이트) — `ENGINE` `shouldBlockShellCommand`
- **정책 폴딩 3소스** — perUser→statsig defaults→perRepo→teamAdmin — `ENGINE` `applyServerAndAdminPolicies`/`NP()`
- **macOS Seatbelt 집행** — deny-default .sb를 sandbox-exec -D 파라미터 주입 — `SANDBOX` (Linux: `--run-linux-inner` Bubblewrap)
- *(정정: 자동 denial→escalation 루프 없음, 클라 임베디드 분류휴리스틱 없음 — 분류는 서버/모델)*

## 8. Skills / Rules / Plugins (4-primitive) — *Subagent는 §3b 참조*
- **Subagent** — body=system prompt, 격리 컨텍스트 (오케스트레이션 상세 → §3b) — `~/.cursor/agents/*.md`
- **Skill** — main 대화서 발동, description 매칭 or `$name` — `SKILLS/<name>/SKILL.md`
- ★ **Rule(.mdc, glob 자동주입)** — CC/quanta 구조적 부재. always/glob-open-file/agent-fetched/manual 4타입 — `~/.cursor/rules/*.mdc` frontmatter `{globs,alwaysApply}`, `IDE` `CursorRuleType`
- **Plugin 번들** — skills+agents+rules+commands+mcp.json — `~/.cursor/plugins/**/plugin.json`
- **MCP-as-plugin** — plugin.json+mcp.json만으로 remote HTTP MCP 자동연결+드라이브 skill 동봉 — `~/.cursor/plugins/cache/cursor-public/{hex,linear,sourcegraph}/mcp.json`
- **killer skill: babysit** — PR merge-ready 루프, intent충돌→abort+ask, CI워크플로 수정금지 — `SKILLS/babysit/SKILL.md`
- **killer skill: loop-on-ci** — `gh pr checks`=SoT, --no-verify 금지, flake 1회retry+증거 — `CTK/skills/loop-on-ci`
- **killer skill: deslop** — AI슬롭 제거(불필요주석/방어try-catch/any캐스트/깊은중첩), 동작불변 — `CTK/skills/deslop`
- **killer skill: verify-this** — VERIFIED/NOT/INCONCLUSIVE 판정 + baseline/treatment 증거트리 — `SKILLS/verify-this`
- **killer skill: control-cli/ui** — harness 재사용→tmux/PTY|CDP attach, action당 deterministic wait — `CTK/skills/control-{cli,ui}`
- **anti-slop 출력계약** — forbidden list(gradient/emoji/box-shadow/rainbow) + "2개↑면 redesign" + 반환전 3-pass self-check — `SKILLS/canvas/SKILL.md`
- **subagent 전용 reminder 트랙** — 메인과 다른 system-reminder — `ENGINE` `subagentSystemReminder`

## 9. AI Code Tracking (provenance)
- **per-snippet AI 출처 인덱스** — hash→source/model/conversationId — `TRACKDB` 테이블 `ai_code_hashes` (~104k행)
- **per-commit AI% 점수** — human/composer/tab/blank 라인 added/deleted — `TRACKDB` `scored_commits` (composite PK commitHash+branchName)
- **commit 워처(git hook 아님)** — onDidCommit → 캐시된 AI요청 매칭 — `COMMITS` `repo.onDidCommit`, `packages/agent-analytics/src/commit-scoring/score-commit.ts`
- **language-normalized 라인해시** — Prettier 후도 매칭(crypto아닌 FNV류 string hash) — `COMMITS` `s8n` normalizer, `yW_/wW_`
- **v1 vs v2 AI%** — v1=엄격 라인매칭(평균23%) vs v2=세션-commit 귀속(평균99.95%, metric을 product lever로) — `COMMITS` `gW_` 공식, DB v1AiPercentage/v2AiPercentage

## 10. Retrieval / Indexing
- **로컬 grep 데몬** — ripgrep류 literal/regex+glob, .gitignore 존중 — `CREPE` (`GrepClient`, `RIPGREP_RAW_SEARCH`/`GLOB_FILE_SEARCH`)
- **Merkle-tree 증분 sync** — changed subtree만 원격 동기화 — `RETRIEVAL` `merkleClient`, `SyncMerkleSubtreeV2`, `getSimhash()`
- **remote embeddings + reranking 2단계** — 서버 벡터스토어 + 12-algo reranker — `RETRIEVAL` `GetEmbeddings`/`TEXT_EMBEDDINGS_LARGE_3`, `RERANKER_ALGORITHM_*`
- **codebase_search(semantic)는 100% 서버** — 클라에 enum조차 없음 — `RETRIEVAL` `SEMANTIC_SEARCH_CODEBASE`
- **ignore 제어** — .cursorignore/.cursorindexingignore — `RETRIEVAL` `cursor.general.globalCursorIgnoreList`

## 11. Transcript corpus (production calibration, 863 files 전수)
- **transcript = 얇은 call-log** — tool_use에 id없음, tool_result블록 없음, timestamp/token/compaction 마커 0 (결과는 사이드카 재구성) — `TRANSCRIPTS` content 블록 딱 text+tool_use
- **30:1 assistant:user (긴세션)** — 매우 긴 자율체인 — `TRANSCRIPTS` 통계
- **탐색 67% (read 37.7%+search 29.1%) vs edit 19.6%** — 핫패스는 Edit 아닌 Read/Grep — `TRANSCRIPTS` tool-use 분포
- **subagent 세션의 5%만, 84% explore, readonly default, cheap model, fanout 2-3(max5), depth-1** — 깊은 트리는 over-engineering — `TRANSCRIPTS` subagent 통계
- **크기 분포** — P50 24KB/26턴, P99 808KB/798턴, max 1.7MB/2075턴 (right-skewed) — `TRANSCRIPTS`

## 12. System prompt (anti-extraction)
- **코어 persona/도구정의 = 서버전용** — 클라 번들에 없음(`aiserver.v1` 주입), 클라엔 도구 이름 enum만 — `ENGINE`/`IDE` (read_file/edit_file 설명 부재)
- **CLI home/new-project 규칙** — 홈서 시작시 move_agent_to_root 강제 — `ENGINE` `additionalRules` "Home workspace guidance"
- **STATUS.md 표면화 패턴** — MCP 상태를 파일로, 프롬프트가 참조 — `ENGINE` MCP authenticate tool 설명
