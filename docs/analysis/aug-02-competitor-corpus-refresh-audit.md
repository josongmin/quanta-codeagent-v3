# Competitor Corpus Refresh & Deep Audit — 2026-08-02

**Scope**: OpenAI Codex/ChatGPT desktop **5059 → 5973**, Anthropic Claude Code CLI **2.1.198 → 2.1.220**, Codex CLI **0.142.5 → 0.146.0**. Codex IDE extension skipped (local install stale — see §1.1).
**Method**: corpus re-extraction + beautify, then a 6-track parallel adversarial audit (webview UI, rust engine, advanced subsystems, code_mode, claude-code full catalog, integration/providers), every claimed gap cross-checked against quanta `src/`.
**Corpus** (gitignored, local-only): `.extracted_source/`. Per-track detail files: `_audit-codex-{userfacing,engine,subsystems,codemode,integration}.md`, `_audit-claude-code-full.md`, master synthesis `_audit-MASTER-2026-08-02.md`.

---

## 1. Corpus state after refresh

| Corpus | Was | Now | Notes |
|---|---|---|---|
| Codex Desktop (ChatGPT.app) | 5059 / 26.707.31428 | **5973 / 26.721.81911** | 4852 firstparty JS / 200 MB. Bin strings 198,860줄 + **NEW** code-mode host strings 78,169줄 |
| claude-code CLI | 2.1.198 | **2.1.220** | `sdk-tools.d.ts` 3493 → 3807줄; 신규 4툴 |
| codex CLI (npm) | 0.142.5 | **0.146.0** | JS 플랫폼 셰임만; rust는 optionalDep(앱 strings로 대체) |
| Codex IDE (openai.chatgpt) | 26.5623 (rs 0.142.3) | **skip** | §1.1 |
| Claude.app / Cursor.app / claude-code-ide | 1.0.734 / 3.5.33 / 2.1.170 | unchanged | — |

### 1.1 함정 — IDE 확장 로컬 설치본이 corpus보다 구버전
로컬 `~/.vscode/extensions/openai.chatgpt-0.4.56`는 codex-rs **0.103.4**(mtime Dec-2025), corpus 기존 `26.5623`은 rs **0.142.3**(2026-07). `0.4.x`는 구 버전 스킴, `26.x`가 신 스킴. `--list-extensions --show-versions`가 `26.5721`로 보고하지만 package.json은 `0.4.56` — **혼동 주의**. 처음에 갱신했다가 다운그레이드임을 발견하고 revert. → **교훈: IDE 확장 리프레시는 번들 codex-rs 버전(strings의 `0.14x` vs `0.10x`) + 폴더 mtime으로 판정.** 로컬<corpus면 skip.

---

## 2. ⚠️ 방법론 정정 — strings-only 1차 감사가 gap을 과장했다

첫 패스(REFRESH-DIFF-2026-08-02)는 바이너리 심볼만 봐서 "quanta에 없다"고 오판한 항목이 여럿. `src/` 직접검증(2026-08-02)으로 **이미 존재** 확인:

| 오판된 gap | 실제 quanta 위치 | 실제 gap |
|---|---|---|
| Lifecycle hooks 엔진 | `src/agent/command-hooks/{types,runner}.ts` (PreToolUse/PostToolUse/UserPromptSubmit + matcher + stdin-JSON + isAllowed 게이트, default-OFF) | 이벤트 폭(session/compact/subagent 훅포인트) + trust-hash만 |
| code_mode (tools-as-code) | `src/codemode/`(QuickJS-WASM) + `src/tool/codemode-tool.ts` + `src/agent/codemode-wire.ts`, ADR-0488, jun-07 LIVE | 없음 — 구조 동일, 재흡수 불필요 |
| config import | `src/migration/translators/claude-code-config.ts` | 원클릭 import UX만 |
| capability discovery / goal / scheduler | `src/capability/` · `src/agent/objective/` · `src/scheduler/`(cron+heartbeat+sqlite, Codex보다 강함) | — |
| MCP elicitation / git commit / rollback | `src/mcp/elicitation/schemas.ts` · `src/tool/git/commit.ts` · `src/skill/system-skills/rewind/SKILL.md` | rollback은 op/event 레벨 승격만 |

심볼 문자열은 구분자 없는 Rust ident 연접이라 line-count diff는 노이즈. 신뢰 신호 = 토큰별 `grep -Fc` 존재수(5973 vs 5059) + DDL/enum 블롭 직독. **각 "이미 있음" 주장은 파일 존재로 실검증 완료(10/10 EXISTS).**

---

## 3. Codex 5973 — 내부 엔진 로직 (USER 미노출, 에이전트 행동 규정)

### 3.1 영속성 substrate (NEW, 최대 엔진 gap)
On-disk SQLite thread store. 복구된 DDL(verbatim): `thread_turns`, `thread_items`, `thread_history_projection_state.next_rollout_byte_offset` — **rollout(append-only 이벤트) → projection(현재상태) 커서** 모델. Codex는 크래시/재시작 후 rollout byte offset부터 projection 재생.
- quanta: `batch-jobs-sqlite-store.ts`·`memory/consolidate/store.ts` 등 일부 sqlite는 있으나 **session/thread rollout 온디스크 영속은 별개**(jul-16 메모리 "InMemory뿐"). → PARTIAL, **HIGH ROI** (durable resume/crash-recovery 토대). 착수 전 현 persistence 범위 코드확정 필수.

### 3.2 ThreadRollback (turn-level undo)
`ThreadRollback` submission op + `ThreadRolledBackEvent`. 체크포인트에서 적용된 편집을 turn 단위로 durable undo. quanta는 `rewind` 스킬로 부분커버 — op/event 레벨 승격이 gap. MED.

### 3.3 승인 라우팅 — Guardian
`approvals_reviewer = user | auto_review | guardian_subagent` 라우터(심볼 블롭서 enum 복원). `auto_review` = 저위험 자동승인, `guardian_subagent` = 리스크평가 서브에이전트가 검토. quanta는 `user` HITL 루트만. MED.

### 3.4 실행 정책 — 선언적 prefix-rule + 세션 amend
`ExecPolicyToml{pattern, decision, justification}` prefix-rule 엔진 + per-session amendment ledger(`ExecPolicyAmendmentApprovedForSession`, `NetworkPolicyAmendment*`) = "한 번 승인하면 세션 내 기억". quanta는 os-sandbox 백엔드(seatbelt/landlock/windows, `src/runtime/os-sandbox/`)는 있으나 prefix-rule 레이어·세션기억 없음. MED.

### 3.5 전송/컨텍스트/예산
- `wire_api` Responses-over-WebSocket 턴 전송(`responses_websocket`/`responses_lite`/`responses_websockets_v2`) + named retry-config struct + `enable_request_compression`. quanta는 SSE + realtime WS 어댑터, 전환식 WS 턴전송 없음. LOW-MED, measure-first.
- `rollout_budget`(바운디드-자율성 출력예산) + `SafetyBuffering`(오버플로 전 headroom 이벤트). quanta는 compaction만. MED.
- `ModelRerouteEvent` / `ModelVerificationEvent`(턴 중 모델 재라우트/검증 witness). quanta `/retry-with` swap은 있으나 이벤트 없음. LOW(관찰성).

### 3.6 도구/스킬
- 도구 표면: `apply_patch`(freeform + streaming events), `unified_exec`(experimental_use_unified_exec_tool), `exec_command`, `web_search`(request/cached/standalone), `read_file`, `spawn_agent`, `codex_git_commit`, `skill_search`(NEW).
- `skill_search` = load-on-demand 스킬 검색(토큰 경제). quanta HAS skills, search 없음. MED.
- 에러 taxonomy: `CodexErrorInfo` 닫힌 enum(`cyber_policy`/`session_budget_exceeded`/`sandbox_error`).

### 3.7 이벤트 taxonomy
~69 프로토콜 이벤트(codex/event/*). 신규/성숙: `CollabAgent*`(멀티에이전트 생명주기), compaction 이벤트군, `ModelReroute/Verification`, `SafetyBuffering`, code_mode 런타임 이벤트(§6).

---

## 4. Codex 5973 — 고급 서브시스템

### 4.1 multi_agent_v2 / Collab (성숙)
`spawn_agent` 툴 + 계층 canonical 주소(`/root/task1/task_3`), `fork_turns = none|all`(컨텍스트 carry), `agent_role/nickname/path`. 상태 = **per-thread rollout 격리** + SQL `thread_spawn_edges(parent, child, role, nickname, status)`를 RECURSIVE CTE로 순회. **공유 네임스페이스가 아님.** `CollabAgentStateFileUpdate`로 형제 파일-상태 동기화. quanta HAS(subagent 패널/lineage) → 흡수는 delegation-policy 프롬프트 + `fork_turns` knob만(LOW-MED).

### 4.2 Lifecycle hooks (성숙)
11 이벤트: PreToolUse / PostToolUse / PermissionRequest / PreCompact / PostCompact / SessionStart / SessionEnd / UserPromptSubmit / SubagentStart / SubagentStop / Stop. 구조: `ConfiguredHookMatcherGroup{matcher, hooks}` → `handler{command, timeoutSec, async, statusMessage}`, `trusted_hash` + trustStatus 재신뢰. 별도 MITM 네트워크 훅(host/methods/path_prefixes/headers, inject/strip). quanta HAS 엔진 → **gap = 이벤트 폭(session/compact/subagent 훅포인트 없음) + trust-hash.** MED(cheap).

### 4.3 Goal (성숙 + RepoGoal)
SQL `thread_goals`, 6-state 머신 `active/paused/blocked/usage_limited/budget_limited/complete`, `token_budget` + `rollout_budget` 커플링(SQL 트리거로 budget 초과시 자동전이), `deferGoalContinuation`(fork시), objective-from-file. `RepoGoal` = 렌더러/worldstate 프로젝션(단일 심볼, core SQL 테이블 아님). quanta HAS `/goal` → gap = 6-state 머신 + budget 커플링(MED). **완료판정은 여전히 하드 test-gate 없음** — 모델 self-judgment.

### 4.4 Skills / Scheduled / Collab-mode / Memory
- Skills: `skill_search`(NEW), `skill_approval` 세분 버킷, `SkillMetadata.keywords`, dep-install.
- Scheduled tasks(NEW): `ScheduledTaskSchedule{intervalHours, days, time}`, daily/weekly cadence, Automations 페이지. **quanta 스케줄러가 더 강함**(`src/scheduler/`) → UI/agent-role 바인딩만 흡수(LOW). (주의: `home/project_last_prompted_at`는 config-migration nudge지 cadence 아님.)
- Collaboration mode(성숙): 2-tuple 프리셋(id + reasoning_effort 마스크), `include_collaboration_mode_instructions` 게이트. **바이너리엔 있으나 렌더러 문자열 없음 = 이 빌드선 UI 미노출.** quanta 3축 assembler가 대부분 포섭(LOW-MED).
- Memory: `memory_consolidation`(백그라운드 서브에이전트, idle+ratelimit 게이트), `MemoryCitation`, `external_agent_memory_import`(NEW — Claude/Cursor의 AGENTS_MD/CONFIG/SKILLS/HOOKS/MEMORY/SESSIONS import), `chronicle`+`local_thread_store_compression`(NEW). quanta MISSING → external import = MED-HIGH(기존 translator 확장), consolidation MED(measure-first).

---

## 5. Codex 5973 — 사용자향 UI/UX

렌더러 `app-initial-*.js`서 9,762 i18n 메시지 ID 채굴. 핵심 gap(관찰성/온보딩 북극성 정합):

| 기능 | 근거 | quanta | ROI |
|---|---|---|---|
| **Process Manager**(실행중 서브프로세스 보기/kill) | `codex.processManager.*` 34 IDs | MISSING | **HIGH** |
| **다른 AI앱서 Import**(원클릭) | `external_agent_memory_import`, onboarding "Import Claude setup" | PARTIAL(translator만) | **HIGH** |
| **Worktree 사용자 모드**(격리 실행 + setup-script activity) | `worktreeInitV2.activity.*` | PARTIAL(내부 eval-only) | **HIGH** |
| **Rich @-mentions**(에이전트/MCP/플러그인/스킬/브라우저탭/이전대화) | mention 소스 열거 | PARTIAL(파일만) | MED-HIGH |
| **인라인 code-review 코멘트 + per-hunk apply/reapply/revert** | `::code-comment{}` directive, `codex.unifiedDiff.reapply*/revert*` | PARTIAL(findings 게시만) | MED-HIGH |
| **per-phase activity 상태머신**(env/worktree/convo: running→completed/failed/skipped) | activity 상태 열거 | PARTIAL | MED |
| hooks 설정 UI(11 이벤트 + matcher/handler editor) | `settings.hooks.event.*` | PARTIAL(엔진O UI X) | MED |
| Cmd-K 통합 팔레트 · GUI 단축키 에디터 · reasoning-effort 핫키 + **Ultra tier**(NEW `modelPickerSliderUltra`) | 렌더러 IDs | PARTIAL | LOW-MED |

렌더러-신규 마커: `plugins.detail.scheduledTasks`, `pullRequest.commentGuidance`, `settings.automations.notifications`, `appServerCrash`, `safetyBuffering`.

---

## 6. code_mode (tools-as-code) — deep dive

**정의**: 모델이 도구를 `await tools.X()` JS 함수로 호출하는 raw JS 프로그램을 작성, 별도 하드닝 프로세스 `codex-code-mode-host`(44MB Mach-O, V8 정적임베드, `--jitless`, **Node 아님**)서 한 턴에 완주.
**Isolate 글로벌**(closed allow-list, `_codex-code-mode-host-symbols.txt:20233`): `console/Atomics/SharedArrayBuffer/WebAssembly/setTimeout` + 헬퍼 `image/audio/generatedImage/store/notify/yield_control/tools/ALL_TOOLS`. **fs/net/fetch/require/import 없음**("unsupported import in exec").
**도구 바인딩**: `WireExecuteRequest{tool_call_id, enabled_tools, source, max_output_tokens}`가 `tools.<name>` 바인딩; 각 호출은 `tool/invoke`로 host에 되돌아감(`code_mode_runtime_tool_id` 태그). `js_repl_tools_only` = 셀 통해서만 도달 가능한 도구.
**런타임 이벤트**(`RawTraceEventPayload::` enum): `CodeCell{Started,InitialResponse,Ended}`, `ToolCallRuntime{Started,Ended}`, `CompactionRequest{Started,Completed,Failed}`+`CompactionInstalled`, `AgentResultObserved`, `ProtocolEventObserved`; requester ∈ `{Model, CodeCell}`.
**buffered_exec(NEW)**: `CodeModeExecPragma{exec,yield}` — `yield_time_ms` cadence로 셀 출력 배치, `max_output_tokens` 상한. host round-trip 감소 + runaway 클램프.
**게이팅**: `tool_mode:"code_mode_only"`, `CodeModeConfigToml{enabled, excluded_tool_namespaces, direct_only_tool_namespaces}`, **모델-메타데이터 게이트**(미지원 모델 "may degrade").
**보안**: 셀 내 `apply_patch`/`exec`는 isolate서 안 돎 — `tool/invoke` → 정상 엔진 dispatch(`dispatch_tool_call_with_code_mode_result`) → 정상 approval/sandbox. **새 권한 없음, 같은 게이트 재진입.**

**판단**: quanta가 **이미 흡수**(`src/codemode/` QuickJS-WASM, ADR-0488, no-bypass 불변식 구조 동일). 재흡수 불필요. 실 ROI = 효율(N 도구턴→1)이지 solve-rate 아님, SOTA 벤치 증거 얇음, Codex도 model-gated. → **유일 실작업 = measure-first 효능 A/B.** 저비용 pull 3: per-cell `max_output_tokens` 예산, `excluded/direct_only_tool_namespaces` carve-out, 셀 trace span.

---

## 7. Claude Code 2.1.220 — 전체 카탈로그 (sdk-tools.d.ts 3807줄 전독)

**신규 4툴**: `RefreshMcpTools`, `SendFeedback`, `ClaudeDesign`, `ProposeSkills`(2.1.198서 0 occurrence 확인).

**quanta 부재 (MISSING)**:
- **ProposeSkills** — 관찰된 memory 절차(evidence[] paths)서 완전한 SKILL.md(1~3 제안) 자동초안 → user review 카드. **HIGH**(자기개선 북극성).
- Workflow 엔진(선언적 멀티에이전트 DAG: agent()/parallel()/pipeline()/phase(), meta 블록, resumeFromRunId 결과캐싱). 구조적 최대 gap.
- Task lifecycle DAG(TaskCreate/Get/Update/List, blocks/blockedBy edges + owner, durable) — flat TodoWrite와 별개.
- REPL(영속 stateful JS 샌드박스, cross-call state, 등록가능 도구, image/doc surfacing).
- Monitor(라인지향 stdout / WS-frame 이벤트 워처, 세션수명) — quanta `/loop`은 프롬프트-반복이지 stream watch 아님.
- RemoteTrigger(웹훅/트리거 CRUD+run 레지스트리).

**quanta 협소 (PARTIAL)**:
- **Bash 관찰성 힌트**: `staleReadFileStateHint`, `backgroundCwdHint`(backgrounded cd는 no-op), `gitOperation`(@internal), `timedOutAfterMs`(auto-background), `ghRateLimitHint`. **HIGH·cheap**(관찰성 북극성 저비용 다득점).
- 에이전트 격리: `isolation:"remote"`(클라우드 env), named/addressable bg agents(`SendMessage to:name`), `subagent_type:"fork"`.
- 백그라운드-기본 서브에이전트(`run_in_background` default true) + TaskOutput outputFile 폴링.
- Rich `AgentOutput`: `toolStats{linesAdded, frameCount}`, `modelsUsed[]`(mid-run swap 감지), `worktreeBranch`.
- `dontAsk` 권한모드(default↔bypass 사이).

**설계 시그널(흡수 아님)**: per-spawn `permissionMode`/`team_name`/`mode`는 **deprecated → 부모상속 + frontmatter override**(단일 암묵 team). quanta `narrowChildOwnership` 방향과 정합. client-facing vs model-facing 출력 분리(`gitOperation` @internal). resumability 도처(Workflow 캐싱, durable cron, plans-on-disk). concurrent-write 안전(Artifact 409/force, stale-read 힌트).

**비흡수**: SendFeedback, ClaudeDesign, Artifact 갤러리(hosted HTML/MD 퍼블리싱), Projects(RAG KB), ShowOnboardingRolePicker — 전부 Anthropic hosted 백엔드.
**플랫폼**: package.json 버전 범프만; 신규 dep/bin/engine 없음. cli-wrapper: FreeBSD 네이티브 타겟 **제거**(Linuxulator 힌트) — 지원 축소.

---

## 8. 통합/프로바이더 (확정 gap, quanta `src/` hit 0 검증)

Codex config 상위 섹션: `model / approval_policy / sandbox_mode / [sandbox_workspace_write] / [profiles] / [model_providers] / [mcp_servers] / [projects trust_level] / [features] / [marketplaces] / [plugins] / [notice] / [tui] / [otel]`.

- **D1 선언적 커스텀 `[model_providers.*]`**(base_url + wire_api + env_http_headers + retries, 코드 어댑터 없이 임의 호환 엔드포인트) — quanta는 하드와이어 어댑터(openai/anthropic/bedrock/vertex/foundry/mantle). **MISSING(hit 0), 최대 통합 gap, MED.**
- **D2 로컬 OSS chat provider**(ollama/lmstudio를 chat으로) — quanta ollama는 **embed-only**. **MISSING(hit 0), MED**(오프라인/비용).
- LOW: named `[profiles.*]` overlay, 통합 sandbox-mode enum, `mcp_2026_07_28` rev, OS-keyring 백엔드, apps-MCP host(`namespaceManifest`/`OpenaiFormElicitation` — ChatGPT-desktop 특화, 비흡수).

**MCP는 이미 패리티**: stdio + Streamable-HTTP+SSE(ADR-0391), OAuth, 구조화 elicitation(Number/Integer/String/Enum/Boolean, `src/mcp/elicitation/schemas.ts`). gap = **핫리로드**(RefreshMcpServers)만.
**Auth도 패리티**: chatgpt-oauth/api-key/aws-iam/azure-msi/gcp-sa + 토큰 로테이션.

---

## 9. 흡수 우선순위 (measure-first, 전부 default-OFF, 착수 전 코드-먼저 대조 필수)

**HIGH — 관찰성/자기개선 북극성 정합, 대부분 기존 seam 확장**
1. **§3.1 온디스크 thread store** — durable resume/crash-recovery 토대 (착수 전 현 persistence 범위 확정)
2. **§5 Process Manager UI** — 실행중 서브프로세스 kill/가시화
3. **§7 ProposeSkills** — 스킬 자동초안
4. **§7 Bash 관찰성 힌트 번들** — 저비용 다득점
5. **§5 다른 AI앱 Import UX** — 기존 translator를 원클릭으로
6. **§5 Worktree 사용자 모드** — thread↔worktree 바인딩

**MED**: §3.3 guardian/auto_review 라우트 · §3.4 ExecPolicy prefix-rule+세션기억 · §4.2 hook 이벤트폭+trust-hash · §8 D1 커스텀 provider config · §8 D2 로컬 OSS chat · §4.3 goal 6-state+budget · §3.6 skill_search · §5 rich @-mentions · §5 인라인 리뷰+per-hunk apply/revert · §3.2 ThreadRollback op · §4.4 external_memory_import

**LOW/measure-first**: §3.5 WS 턴전송 · rollout_budget · §6 buffered-exec pragma · §5 팔레트/단축키 UX · claude Workflow/Task-DAG/REPL/Monitor/RemoteTrigger · collaboration_mode

**재흡수 불필요(이미 있음, §2)**: hooks 엔진 · code_mode · config-import 코어 · scheduler · goal · capability · elicitation · rewind

**⛔ 비흡수(제품/계정 특화)**: realtime/voice v2 · in-app browser/computer_use/CDP · personality/Pets · 플러그인 마켓플레이스 + Gmail/Calendar/Drive connectors · artifacts/canvas/image playground · AppGen · Codex Micro 하드웨어 · product_surface/suggestion_id 커머스 · ChatGPT 대화통합 · Business 결제 · (claude) SendFeedback/ClaudeDesign/Projects/Onboarding

---

## 10. 관통 결론
5973은 5059 대비 +66,603 신규 심볼줄의 큰 릴리스지만, **quanta가 이미 상당수를 흡수**(hooks/code_mode/goal/scheduler/capability/config-import) — strings-only 감사의 착시를 코드검증이 걷어냄. 진짜 흡수가치는 **관찰성**(온디스크 store·Process Manager·Bash 힌트)과 **자기개선**(ProposeSkills), **온보딩**(Import UX)에 집중. 나머지 신규는 성숙(멀티에이전트/goal/hooks) 또는 desktop-product 특화. code_mode는 별도 큰 베팅이나 이미 흡수·measure-first 단계. "백로그=무덤"(jul-18) 교훈 재확인 — 이번에도 hooks/codemode가 already-built로 드러났으니 **모든 후보는 착수 전 quanta 코드-먼저 대조**.
