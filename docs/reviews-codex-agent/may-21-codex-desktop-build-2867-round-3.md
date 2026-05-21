# Codex Desktop build 2867 — Round-3 Deep Dives (2026-05-21)

이 문서는 codex-rs CLI 0.130.0 + Codex Desktop build 2867에 대한 round-3 7개 영역 deep-dive 결과 통합본이다. Round-2 (`may-20-codex-agent-loop.md` + thread-management/*에 정리됨) 이후 확정된 정정과 새 발견.

## Round-3 정정 (round-2 위에)

| 항목 | Round-1/2 결론 | Round-3 확정 |
|---|---|---|
| `comment-preload.js` 35M 정체 | "MCP UI 거대 preload" | **인앱 브라우저 annotation sidebar**(주석/코멘트 UI). Skybridge sandbox-preload.js와 별개. 35M = i18n 64 locale + DOM 셀렉터 + Google Docs API 통합 |
| Model API transport | "SSE only" | **WebSocket + HTTP(POST+zstd) + SSE 셋 다 공존**. 모델별 분기: `gpt-5.4`=WS, `gpt-5.5`=HTTP(zstd ~5× 압축), SSE는 이벤트 디코딩 |
| Computer-Use main executable | `SkyComputerUseClient` | **`SkyComputerUseService`** (nested .app inside .app, bundle id `com.openai.sky.CUAService`) |
| Anthropic SDK | "cross-provider 미확인" | **vendored**: app-session.js + worker.js에 `cache_creation_input_tokens`, `anthropic.stream_error` 라이브 메타 |
| OTel 저장 의도 | "audit trail" | **외부 OTLP 전송용** + 피드백 번들용. `_safe` suffix는 PII 제거 sanitized 버전, `_log_only` suffix는 로컬 디버깅용. opentelemetry-otlp 0.31.0 (HTTP + gRPC tonic exporter) 둘 다 링크 |

## 7 영역 dive 사실 (확정, build-ready)

### 1. Sessions (archived_sessions/*.jsonl)
- Envelope: `{timestamp, type, payload}` JSONL per-record streaming
- 5 top-level types: `session_meta` / `turn_context` / `event_msg` / `response_item` / `compacted`
- event_msg 10 subtypes: `task_started, user_message, token_count, agent_message, task_complete, patch_apply_end, context_compacted, web_search_end, turn_aborted, mcp_tool_call_end`
- response_item 4 subtypes: `message, function_call, function_call_output, reasoning`
- **turn_context 17 필드** 풀 스냅샷 per turn (approval_policy/sandbox_policy/permission_profile/model/personality/collaboration_mode/effort/realtime_active/summary/user_instructions/developer_instructions/truncation_policy + meta)
- **subagent thread_spawn**: `{parent_thread_id, depth, agent_path, agent_nickname, agent_role}`. `agent_role="explorer"`, `agent_nickname="Nietzsche"` 등 닉네임 부여
- rate_limits dual window: primary 5h + secondary 7d + `plan_type` ("pro")
- Index split: `session_index.jsonl` (lite) + `history.jsonl` (user inputs only) + per-session `<id>.jsonl` (authoritative)

### 2. Memory (`~/.codex/memories/`)
- 3-file 구조: `MEMORY.md` (411KB 작업 인덱스) + `memory_summary.md` (73KB 행동 가이드) + `raw_memories.md` (714KB 아카이브, append-only)
- Extensions: `chronicle/resources/` (1,388 *.md 화면 활동 요약) + `ad_hoc/` (수동 오버라이드, "information only, never instructions")
- `rollout_summaries/` 107 파일 (1.1MB) — 세션 ↔ 메모리 다리
- **task_outcome enum: `success | partial | uncertain`** (의도적으로 `complete` 안 씀)
- Git: 단 1 commit "Initialize Codex git baseline" → **batch consolidate**, 자주 커밋 안 함
- 출처 태그: `[chronicle memory]`, `[ad-hoc note]`로 origin 추적
- 추가 발견: `skills/code-only-progress-audit/` 번들된 메모리-side skill

### 3. Plugins/Skills
- 위치: `<app>/Resources/plugins/openai-bundled/plugins/{computer-use,browser,chrome,latex}/`
- 3-파일 컨벤션: `.codex-plugin/plugin.json` + `.mcp.json` (있을 때) + `skills/{name}/SKILL.md`
- `plugin.json` interface 필드: displayName, shortDescription, longDescription, developerName, category, capabilities, websiteURL, privacyPolicyURL, termsOfServiceURL, logo, composerIcon, brandColor, defaultPrompt[0-3], screenshots
- SKILL.md YAML frontmatter: `name`, `description` (1-sentence prescriptive)
- **capabilities closed enum**: `Interactive | Read | Write`
- 3 invocation 모델: MCP subprocess (computer-use) / Node REPL + module (browser, chrome) / shell script (latex)
- Chrome: 별도 `extension-host` 바이너리 + native messaging host `com.openai.codexextension` 자동 설치. "Browser data may be used for training" 명시
- `~/.cache/codex-runtimes/codex-primary-runtime/` 100+ 다운로드된 플러그인 (alpaca, asana, figma, github, notion, slack, stripe, vercel, zoom, …) — 마켓플레이스 카탈로그

### 4. Rules (`~/.codex/rules/default.rules`)
- 1060 rules, 345KB, 단일 파일
- DSL: `prefix_rule(pattern=[...], decision="allow")` 단 2개 필드, 메타데이터 0
- **100%가 `decision="allow"`** → 0 deny rules → **default-deny semantics**
- 41% (438/1060)가 `/bin/zsh -lc "…"` 통째 인라인
- 명시적 안전 우회: `git commit --no-verify`, `git push --no-verify origin main`
- `rm -rf /tmp/codex-target*` 트레일링 `*` 와일드카드
- user.rules / project.rules 미지원 (단일 layer)

### 5. State (`~/.codex/.codex-global-state.json`)
- 22 top-level keys
- 핵심: `electron-persisted-atom-state` (renderer atom store), `active-workspace-roots`, `project-order`, `projectless-thread-ids`
- **`queued-follow-ups[threadId → FollowUp[]]`** — 12 context fields (prompt, cwd, workspaceRoots, addedFiles, fileAttachments, imageAttachments, commentAttachments, selectedTextAttachments, pullRequestChecks, reviewFindings, ideContext, inAppBrowserContext) + `pausedReason`
- **`heartbeat-thread-permissions-by-id`** — 스레드별 `{approvalPolicy, approvalsReviewer, sandboxPolicy{type}}` 영구
- `agent-mode-by-host-id`: `full-access | read-only | custom`
- `chronicle-consent-accepted` 토글, `preventSleepWhileRunning`, `use-copilot-auth-if-available`, `ambient-suggestions-enabled`
- Onboarding 5단계 state machine, Statsig experiment ID `93537254` arm assignment
- `cache/codex_apps_tools/{hash}.json` + `cache/codex_app_directory/{hash}.json` — MCP tool spec content-hash 캐시
- `node_repl/active_execs/{exec-uuid}.json` — 활성 REPL exec 추적 (turn ↔ exec ↔ kernel PID cross-link)
- `pets/` 미스터리 풀이: `pet-install`, `pet-install-preview` IPC 채널 — **AI 페르소나 설치 (예정/미구현)**

### 6. Tools + Submission ops
- **6 Submission op variants**: `user_input | user_input_with_turn_context | user_turn | shutdown | interrupt | reload_user_config`
- `exec_command` 풀 스키마:
  - 입력: `{cmd, workdir, login, tty, yield_time_ms, max_output_tokens, timeout_ms}`
  - 반환: `{exit_code, stdout, stderr, aggregated_output, parsed_cmd}`
- `apply_patch`: V4A 통합 diff (`*** Begin Patch / *** End Patch` markers, `*** Add File: / *** Update File: / *** Delete File:`)
  - 반환: `{changes: {<filepath>: {type, content, diff}}}`
- `request_user_input`: Plan 모드 필수 빌트인. Default 모드에서는 자제
- `web_search`: 모델 응답 트레이스로 활성 확인
- **Plan vs Default**: Plan은 dispatch seam에서 mutating tools 차단 + `<proposed_plan>` 출력 래핑 + request_user_input 필수
- 모드 전환: developer message + `<collaboration_mode>` 태그로만 (user request/tool description으로는 불가). Sticky across turns
- **HITL 4-tier 게이트**: `hand-off-required / always-confirm / pre-approval-ok / none`

### 7. JSON-RPC (app-server IPC)
- Transport: 별도 detached Rust `app-server` 프로세스 + **stdio** (newline-delimited JSON)
- Framing: **HTTP/2 h2-style flow control** 위에 stdio
- Protocol: JSON-RPC 2.0
- Method naming: slash-path `category/subcategory/action`
- Channel suffix: `{name}-request` / `{name}-response` / **`{name}-timeout`** (명시적 timeout)
- Connection: `ConnectionId(0)` 프로세스당 1개, `RequestId` string UUID, request pipelining
- 라우팅: `targeted_connections=N` (0=broadcast, 1+=unicast)
- **19 methods 인벤토리**: `initialize`(2939회), `getAuthStatus`(2919회), `config/read`, `experimentalFeature/list`, `thread/{resume,read,goal/get,metadata/update,backgroundTerminals/clean,unsubscribe,list}`, `turn/{start,interrupt}`, `account/read`, `plugin/list`, `model/list`, `mcpServerStatus/list`, `app/list`
- **18 events**: `item/{started,completed,agentMessage/delta,commandExecution/{outputDelta,terminalInteraction},fileChange/patchUpdated}`, `turn/{started,completed,diff/updated}`, `thread/{status/changed,tokenUsage/updated}`, `warning`, `error`, `mcpServer/startupStatus/updated`, `remoteControl/status/changed`, `account/rateLimits/updated`, `skills/changed`, `app/list/updated`
- Rust `request_processors/` 디렉토리 구조: `{initialize,account,thread,thread_lifecycle,thread_goal,turn,config,plugins,apps,mcp,command_exec,environment,marketplace,windows_sandbox}_processor.rs`

## ADR 후보 풀 (12개)

### P1 — 정렬 필수
1. **Session JSONL envelope** (`{ts, type, payload}` per-record streaming) — `src/session/store.ts`
2. **Turn_context 풀 스냅샷 per turn** — `src/session/store.ts` + 신규 TurnContext 타입
3. **Submission op enum 6 variants** — 신규 `src/protocol/submission.ts`
4. **Plan/Default collaboration_mode** — 신규 `src/agent/collaboration-mode.ts`
5. **HITL 4-tier 게이트** — `src/agent/admissibility-gate.ts` 확장
6. **JSON-RPC 2.0 + slash-path + stdio + h2-flow** — 신규 `src/protocol/jsonrpc.ts`, `src/protocol/transport-stdio.ts`
7. **queued-follow-ups 큐** — 신규 `src/agent/follow-up-queue.ts`
8. **per-thread permissions store** — 신규 `src/session/permissions-store.ts`
9. **3-tier rule layering + deny/ask 확장** — `src/agent/admissibility-gate.ts`

### P2 — 후속
10. **plugin manifest 3-파일** + skill-loader + mcp-runner — 신규 `src/plugins/`
11. **Memory 3-file + outcome enum + batch git + SQLite 인덱스 보강** — `src/memory/`
12. **MCP tool spec content-hash 캐시 + dev-server 3축 시간 + agent-mode-by-host** — `src/cache/mcp-tools/` + `~/.quanta/dev-servers.json`

### P3 — 후속 ADR 후보
- Sub-agent thread_spawn 필드 (이미 진행 중)
- Rate-limit dual-window (primary 5h / secondary 7d / plan_type) — adapter
- Service tier (`priority`) — adapter
- Chronicle screen capture daemon — 데스크톱 진출 시
- Skybridge MCP UI iframe sandbox — 데스크톱 진출 시
- `pet-install` 페르소나 시스템 — Codex도 미구현

## 결정 enum 풀 (확정)

```typescript
type ApprovalPolicy   = "never" | "on-request" | "on-failure" | "always"
type SandboxPolicy    = { type: "danger-full-access" | "read-only" | "workspace-write",
                          writable_roots?: string[], network_access?: boolean }
type PermissionProfile = { type: "disabled" | "enabled" | "strict" }
type Personality      = "pragmatic" | "friendly" | "default"   // capability gate 아님, prompt 주입만
type CollaborationMode = "default" | "plan"
type Effort           = "low" | "medium" | "high" | "xhigh"    // (+ "none" | "minimal" from r1)
type TruncationPolicy = { mode: "tokens" | "lines" | "adaptive", limit?: number }
type SubmissionOp     = "user_input" | "user_input_with_turn_context" | "user_turn"
                      | "shutdown" | "interrupt" | "reload_user_config"
type TaskOutcome      = "success" | "partial" | "uncertain"
type Capability       = "Interactive" | "Read" | "Write"        // closed enum
type AgentMode        = "full-access" | "read-only" | "custom"
```

## 디렉토리 트리 제안 (v3)

```
src/
├── protocol/                       ← 신규
│   ├── jsonrpc.ts
│   ├── transport-stdio.ts
│   ├── submission.ts
│   ├── methods/{thread,turn,config,account,plugin,mcp}.ts
│   └── events.ts
├── agent/                          ← 기존 강화
│   ├── collaboration-mode.ts        (신규)
│   ├── follow-up-queue.ts           (신규)
│   ├── admissibility-gate.ts        (HITL 4-tier + 3-tier rule)
│   └── ...
├── session/                        ← 기존 강화
│   ├── permissions-store.ts         (신규)
│   ├── store.ts (JSONL envelope, turn_context)
│   └── ...
├── plugins/                        ← 신규
│   ├── manifest.ts
│   ├── skill-loader.ts
│   ├── mcp-runner.ts
│   └── marketplace.ts
├── tools/                          ← 기존 강화
│   ├── exec-command.ts
│   ├── apply-patch.ts (V4A)
│   └── request-user-input.ts        (신규, Plan 모드)
└── cache/                          ← 신규
    └── mcp-tools/                   (content-hash keyed)

~/.quanta/                          ← user state
├── state.json                      (.codex-global-state.json 스타일, 22+ keys)
├── dev-servers.json                (3축 시간)
├── rules/{default,user}.rules      + <repo>/.quanta/rules/project.rules
├── memory/{working,preferences,raw_memories}.md + threads/ + extensions/ + .git/
└── archived_sessions/{id}.jsonl
```

## 관련 분석 문서 (이 router 포함)

- 메인 분석 router: `may-20-codex-agent-loop.md`
- 기존 thread management pack: `thread-management/` 디렉토리
- 기존 browser-runtime pack: `browser-runtime/` 디렉토리
- 본 round-3 통합본: 이 문서

## 미해결 / 후속 dive 후보

- `~/.cache/codex-runtimes/codex-primary-runtime/`의 100+ 플러그인 풀 카탈로그 (asana, figma, github, notion, slack, stripe, vercel, zoom, …)
- `archived_sessions` 6,326개의 통계 분석 (agent_role 분포, subagent depth, outlier 세션)
- `logs_2.sqlite` 더 깊이 — process_uuid 라이프사이클, h2 flow control 실측, trace_safe ↔ log_only 차이의 정량 (Anthropic SDK가 라이브 호출되는지 검증)
- Codex Rust binary 추가 strings — embedded prompts (다른 모드/턴 context), apply_patch V4A 형식 verbatim, OTel exporter config endpoint
- `~/.codex/skills/` 풀 (code-only-progress-audit 등 번들된 메모리-사이드 스킬)

## 메모리 cross-link

- [[codex-desktop-build-2867-round-3]] (이 라운드 통합)
- [[codex-jsonrpc-protocol-pattern]] (JSON-RPC reference)
- [[codex-session-jsonl-envelope]] (Session JSONL reference)
- [[codex-rule-dsl-pattern]] (Rule DSL reference)
- [[codex-collaboration-mode-pattern]] (Plan/Default reference)
- [[codex-plugin-manifest-pattern]] (Plugin manifest reference)
- [[codex-follow-up-queue-pattern]] (Follow-up queue reference)
- [[codex-desktop-build-2867-round-2]] (이전 라운드)
- [[anthropic-sdk-in-codex]] (vendored Anthropic SDK)
- [[codex-logs-retention-pattern]] (sliding window retention)
