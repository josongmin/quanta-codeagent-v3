# 2026-06-02 4사 기능 합집합 어딧 — quanta 흡수/강화 델타

> 3회 어딧(R1 vendor 인벤토리 추출 → R2 stale-claim ground-truth 검증 + 교차수렴/buried 스윕 → R3 진짜-갭 숏리스트 실코드 최종검증). 입력 = [quanta-comparison.md](quanta-comparison.md) + vendor 원본 문서들([claude.md](claude.md)/[codex.md](codex.md)/[cursor.md](cursor.md) + 변종 + [repomaps](../code-agent-suit/)) + [10.feature-catalog.md](../../../10.feature-catalog.md) + 실제 `src/`.
>
> 표기: ✅보유(wired) · 🟡부분/seam/default-OFF · ❌없음. ROI = 흡수가치/비용.

---

## 0. 헤드라인 — 비교 문서가 stale다

[quanta-comparison.md](quanta-comparison.md)는 5/27 기준인데, 거기 "★ quanta 갭"으로 적힌 항목 **대부분이 이미 landed + wired**다. R2/R3에서 실제 `src/`로 ground-truth를 찍어 확인:

| comparison이 "갭"이라 한 것 | 2026-06-02 실측 | 증거 |
|---|---|---|
| A8 idle/stream-hang timeout (HIGH 갭) | ✅ **LANDED·wired** | `src/llm/stream-timeout.ts` `withStreamTimeout`(firstChunk 60s+idle 120s), 전 어댑터(anthropic/openai/responses/bedrock/vertex/foundry) 호출. ADR-0200/0227 |
| B8 OS sandbox (★★★ 최대 갭) | ✅ **LANDED·enforcing** | `os-sandbox/{seatbelt,landlock,landlock-native,bubblewrap}.ts` + verbatim profile. `runShell`이 `getShellSandbox()` 소비(global) + bash `mode=read` 시 실제 `sandbox-exec`/Landlock wrap(per-call, fail-closed). Darwin VZ만 scaffold |
| B9 shell 격리 | ✅ disclaimer + 위 OS wrap | `shell-disclaim.ts` `--noprofile --norc` + B8 |
| B12 MCP Tasks+Elicitation | 🟡 **split** | Elicitation ✅ wired(`mcp/client.ts` routeElicitation). Tasks 🟡 port+in-memory store만, **live JSON-RPC transport 없고 `mcp_tasks` 툴 미등록** |
| C2 identity variant | ✅ static wired | `buildSystemPromptForMode` variantFor(mode).identity, 6-mode 테이블. ⚠️ per-turn `buildIdentityReminderText`만 dead-code(test-only) |
| F11 vision/image | ✅ **LANDED·default-on** | `tool/image/{read,from-url}.ts`, `buildDefaultTools` 무조건 등록 |
| F12 web | ✅ web_fetch always-on / web_search default-OFF | `webFetchTool()` 무조건. `web-search.ts`는 `config.webSearch.provider` 필요 |
| A9 background subagent fork | ✅ **LANDED·wired e2e** | `tool/subagent-bg/` fork→handle 즉시반환·detached, `session-execution-plane.ts` 실 scheduler + stuck-detector(ADR-0223) |
| B11 hook updated_input | ✅ wired | `admissibility-gate.ts` onInputMutation→`dispatch.ts` effectiveCall. ADR-0113 |
| retrieval 합성루트 (deferred) | ✅ **wired 양 surface** | `apps/cli/internal.ts` + `apps/agent/index.ts` `buildSearchPipelineFromEnv` → `search_codebase` |

**결론**: "OS sandbox가 단일 최대 갭"이라는 옛 결론은 틀렸다 — 이미 enforcing 중이고 남은 건 Darwin VZ scaffold 하나. quanta는 합집합 대부분을 hard-gate 철학으로 이미 덮었다.

---

## 1. 합집합 골격 (R1, 축별 vendor signature)

전체 인벤토리는 R1 에이전트 4건이 A~H축으로 떴음(이 문서 범위 밖, 요약만):

- **Claude**: 13툴 풀 JSON 스키마 클라전송 · stop_reason 8-enum 1급 · MCP 풀스택(Tasks+Elicitation+OAuth-upscope+Sampling+Streaming) · rewind+fork 타임트래블 · disclaimer POSIX_SPAWN_SETDISCLAIM · trust 5-tier space×time · Cowork microVM(Go runtime+vsock+MITM) · Computer Use Carbon-level · 22+ env 멀티클라우드(Foundry+OIDC) · section-granular prompt cache · post-compact 파일복원(50K/5K).
- **Codex**: exec_command 원툴-셸 철학 · native multiple function_call(max 17) · apply_patch V4A(`*** Move to:` atomic rename) · 2-phase LLM 메모리 consolidator(임베딩 0, injection 방어 codified) · Chronicle ambient 메모리 · mid-turn cancellation-free steer + NonSteerableTurnKind · 16-type closed error enum · shell_snapshots 헤르메틱 env · Node REPL 영속 커널 · RRULE automations + inbox · 6-engine 브라우저 + exportGsuite · `::git-*` directive(실행/보고 분리) · Guardian post-denial precedence · OTel `_safe`/`_log_only` dual-copy.
- **Cursor**: 44 typed ToolCall + per-failure-mode oneof · model_visible≠client_visible 에러 · FastApply(stream full-content + 25 모델 A/B) · fused cursor-prediction(Tab-Tab 다음위치) · 25/60ms 디바운서 · .mdc glob 룰 + read-time `related_cursor_rules` · 20 hook(updated_input + followup_message) · provider-backed rejection-history 휴리스틱 · 구조화 5-field `reflect` + lint-grounded OpusChainReflect 3-way · crepe ngram-역색인 grep · shadow git ODB(AIMD budget + geometric repack) · `await{regex}` + async-shell BACKGROUND · in-process network proxy · pr-review-canvas moved-code detection · AI-tracking provenance DB.
- **quanta**: 합집합 대비 위치는 §2~3. 고유자산(3사 어디에도 없음): B5 ApprovalOutcome 8-state+invariant · B3 admissibility 8-stage 단일함수 SSOT · B10 fs-jail branded type+scanner · A3 RecoveryAction 6-enum · A4 streaming HOL barrier+order · C1 정책스택 L1-L9 코드화 · C3 escapeReminderBoundary · D5 verify-guard+closeout hard-gate("test 안 하면 종료 불가" 유일) · E2 3단 edit 회복.

---

## 2. 신규 흡수 — ❌ 진짜 없음 (R3 실코드 검증)

| 기능 | 출처 | 왜 좋은지 | ROI |
|---|---|---|---|
| **diff→PR본문/커밋메시지 자동 작성** | Copilot/Codex yeet/Cursor | `git_commit`은 `wip:` 타임스탬프만 자동, regular는 메시지를 받기만 함. diff를 읽어 conventional-commit 메시지/PR body를 **저작**하는 스텝 없음. usecase상 Copilot 압도 최대 *볼륨* 카테고리(PR설명 28K·커밋 1.2K), CLI/git 에이전트에 딱·위험 낮음 | **높음 / 비용↓** |
| **compaction 후 워킹셋 파일 복원** | Claude(50K총/5K파일) | 현 compaction은 "건드린 파일 목록" terse brief만, 편집 중이던 파일 *내용* 재주입 없음. 긴 멀티파일 작업서 압축 직후 작업대상 파일이 컨텍스트서 빠짐. (rewind/checkpoint restore는 user-triggered라 직교) | 중 |
| **read_paths(이미 읽은 파일) 추적** | Cursor `ConversationStateStructure.read_paths`(field 18) | 재읽기 dedup + closeout R1("진짜 소스 읽었나") 백업 신호. 현재 read 도구가 무엇을 읽었는지 추적 안 함 | 중·저 / 비용↓ |
| **실행중 셸 mid-flight 백그라운드 detach** | Cursor `force_background_shell` + `ShellBackgroundReason` | `bash timeout_behavior=background`는 *자기 데드라인* 만료시에만 detach. 이미 돌고있는 명령을 죽이지 않고 지금 백그라운드 전환하는 경로 없음 | 저 |

---

## 3. 강화 — 🟡 부분 보유 (R3 실코드 검증)

| 기능 | 현 상태 | 강화 포인트 | ROI |
|---|---|---|---|
| **co-change를 검색 신호로** | `git_churn`/`blame_heatmap`/`git_moved_code` **툴**은 있으나 `src/retrieval/`에 co-change feed 없음(commit-*메시지* 임베딩만) | 함께 바뀌는 파일을 context로 surface(Cursor GetGitGraphRelatedFiles `{path,weight}`). usecase상 Learning 19%+Read-mode 40%가 요구 | **높음** |
| **시맨틱 코드검색 default** | `search_codebase` 기본 `lexical-only`, 임베딩은 `QUANTA_INDEX=on` 필요 | 기본 도달성/자동 인덱싱 — 단 BYO-key 비용 트레이드오프 신중히 | 중(비용주의) |
| **MCP Tasks** | port+in-memory store+poller만, live JSON-RPC transport 없고 `mcp_tasks` 툴 미등록 | 실 transport 바인딩 + 툴 등록(Elicitation은 이미 완비). Claude/Codex 둘 다 보유 | 중 |
| **automation 엔진** | RRULE파서+sqlite+ticker+`QUANTA_AUTOMATION=on`+`automation_update` 툴 다 있는데 base가 stub agentLoop 주입 → 재귀 실행 라이브 아님(mode-preset만 override) | live loop handler 와이어. **단 CLI 단일세션 scope 질문이라 의도적 보류일 수 있음 — scope 판단 먼저** | 중 |
| **plan-effort 분리 + xhigh** | effort 5단(default/max/high/med/low) 세션 단일축, plan/exec 공유, xhigh 없음 | plan-mode 별도 effort + xhigh 추가(Codex). "계획은 깊게 실행은 빠르게" | 저·중 |
| **identity per-turn 리마인더** | static per-mode 슬롯 wired, `buildIdentityReminderText` dead-code(test-only) | 프로덕션 호출부 1줄 연결 | 사소 |

---

## 4. 검토할 buried gems (미구현 검증, 후보)

R2 교차수렴/buried 스윕에서 나온 것 중 quanta가 안 가진 것으로 보이는 것 (실코드 미검증, 흡수 전 확인 필요):

- **read-time 룰 자동첨부** — Cursor `read_file`이 glob 매칭된 `.mdc` 룰을 결과에 붙임(`related_cursor_rules`). quanta는 per-turn glob 룰 주입이라 read시점 첨부가 더 샤프(룰이 read 시점에 맥락화).
- **context chunk 출처 태그** — Cursor `CodeChunk.Intent` 9종(MENTIONED/VISIBLE/AI_EDITED/SELECTION/TERMINAL_SELECTION/...). 각 컨텍스트 조각이 왜 들어왔는지 모델에 알려 가중치 부여.
- **`verify-this` falsifiable verdict 스킬** — Cursor: claim을 반증가능 형태로 + baseline/treatment + exactly-one verdict{VERIFIED/NOT/INCONCLUSIVE}. quanta verify-guard 하드게이트가 더 세지만, 타입드 verdict 스킬은 추가 여지.
- **automation용 `agentic_filter_prompt`** — Cursor: 트리거 발화↔에이전트 기상 사이 LLM 게이트(ALLOW/BLOCK + rationale). 노이즈 이벤트마다 에이전트 스폰 차단. automation 엔진 강화와 짝.
- **WriteStdin 직전 오프셋 반환** — Cursor `terminal_file_length_before_input_written`. stdin 주입 후 모델이 응답을 정확히 어디서부터 읽을지 앎.

---

## 5. 의도적 보류 (흡수 안 함 — scope/철학)

- **browser-drive / E2E 6엔진**(Cursor/Codex) — 고비용, CLI surface 밖. Testing 카테고리 상한이지만 빈도·비용상 보류 정당.
- **Computer Use 네이티브**(Carbon/NSXPC) — surface 밖.
- **microVM / desktop IPC / marketplace / BLE pet / Squirrel** — 제품/운영 인프라(ADR-0011 근거).
- **Fernet reasoning 암호화**(Codex) — 멀티테넌트 아님, IP보호 불필요.
- **Statsig/Datadog/Sentry 원격 텔레메트리** — BYO-key 프라이버시 의도적 opt-in(Codex와 동일 철학).

---

## 6. 권장 착수 순서

1. **diff→PR/커밋메시지 자동 작성** (§2, ROI 1위) — 최고 볼륨·최저위험. `git_commit` 메시지 저작 스텝 + PR-body-from-diff 스킬/툴.
2. **co-change 검색 신호** (§3) — 기존 `git_churn`/`blame_heatmap` 출력을 retrieval context feed로 연결. Learning/Read-mode 빈도 가중 최상위.
3. **MCP Tasks live transport** (§3) — Elicitation 완비 상태라 sibling 마무리.
4. **compaction 워킹셋 복원** (§2) + **read_paths 추적** (§2) — 긴 작업 신뢰성.
5. automation live handler / plan-effort+xhigh / identity per-turn 리마인더 — scope 판단 후.

방법론은 기존 패턴(worktree-isolated SOTA++ 병렬 + cherry-pick, default-OFF seam, hellgate-first TDD) 그대로. 전부 신규/leaf 슬라이스라 conflict-free 흡수 가능.

---

## 7. 최신 소스 갭 어딧 (문서에 없는 신규 기능) — `.extracted_source/` 코드 직접

> ⚠️ 리뷰 문서(§0~6)는 옛 버전 기반(Cursor 3.2.16 / Codex 2867·0.131 / Claude 1.7196·cc 2.1.138). 아래는 **최신 추출 빌드**(Cursor **3.5.33** / Codex **3390·codex-rs 0.135.0-alpha.1** / Claude Desktop **1.0.734** + cc-cli **2.1.150**) 코드를 직접 grep해 찾은 **문서 미수록** 기능. evidence는 `.extracted_source/` 파일. **단 quanta src 대조(R3 ground-truth)는 아직 — 흡수 전 §2 방식으로 실코드 확인 필요.**

### 7.1 ★ 교차수렴 (2+ vendor 최신 빌드가 독립적으로 같은 걸 추가 — table-stakes 강신호)

| 수렴 기능 | vendor | 메커니즘 | quanta | ROI |
|---|---|---|---|---|
| **레이어드 정책 merge (per-user/per-repo/team-admin)** | Cursor `SandboxPolicyMergeSources`{per_user,per_repo,team_admin} + Codex `ConfigLayer`/`ConfigLayerSource`/`MergeStrategy`/`OverriddenMetadata` | 정책/설정을 출처 레이어별로 병합 + override 추적 | 🟡 우리 rule 3-layer(project>user>system)와 동형이나 sandbox/config 전반엔 미적용 | **높음** (독립 2사 확증) |
| **네트워크 egress MITM 프록시 + 런타임 정책 amendment** | Cursor in-process HTTP/SOCKS proxy(per-conn decision.log) + Codex `codex_network_proxy` 크레이트(http_proxy/socks5/mitm/certs) + `NetworkPolicyAmendment`(거부→승인 후 allow셋 확장) | 도메인 allowlist MITM 프록시로 전 egress 게이팅, 거부 후 승인 시 정책 증분 | 🟡 net-guard egress seam은 있으나 실 프록시 없음. amendment-after-denial은 Guardian post-denial과 짝 | **높음** |
| **경쟁사 import / 상호운용** | Codex `external-agent-import`(Claude Code/Cowork 세션+MCP+skills+plugins+hooks 가져오기) + Cursor `.claude-plugin/plugin.json` + `~/.claude/plugins` 읽기 + SHA-pin git plugin | 경쟁사 config·세션·플러그인을 자기 포맷으로 흡수(switch-cost 제거) | 🟡 ADR-0205 5-vendor rule 감지 + Claude transcript 파서(smoke) 보유 — 80% 부품 있음 | **높음** (adoption lever, 부품 재사용) |
| **타입드 비동기 subagent await + per-mode 권한** | Cursor `SubagentAwait`{Complete/StillRunning/NotFound/Error} + `children_completed_message_template` + `CustomSubagentPermissionMode`{DEFAULT/READONLY/AGENT_ONLY} | non-blocking 폴링 4-state + 자식완료 부모 자동 nudge | ✅ ADR-0128/0130/0218과 동형 — **우리 설계 확증** | 확증(흡수 불필요) |

### 7.2 Cursor 3.5.33 신규

- **client-side AST chunking/outline** — `@anysphere/tree-chunk-napi`(`CompressedFileOutline`/`PartialFileContext`/`FileTree`/`ChunkerRouter`) + `tree-sitter-bash`가 agent 런타임에 번들. 청킹/아웃라인이 **서버→클라**로 이동. bash는 `simple_commands`로 분해해 per-command sandbox/approval. ROI **높음**(file_tree_summary/retrieval 축 + per-command HARD_DENY).
- **SmartMode LLM 명령위험 분류기** — `SmartModeClassifierArgs`→`{ALLOW,BLOCK,block_reason}`. 정적 allow/deny 중간의 학습형 게이트. ⚠️ `no-heuristics-only-validated`와 긴장 — 임계 아니라 분류기, 검증 후 판단. ROI 중.
- **cursor-agent-worker** — cloud/browser-launched 에이전트를 로컬 워크스페이스에 브리지하는 per-workspace 데몬(unix-socket HTTP/2 PrivateWorkerApi). 신규 루프 아님. ROI 중(remote→local 패턴 청사진).
- **MCP 전용 UtilityProcess** — MCP 서버+OAuth store를 별도 Electron 프로세스로 격리(`mcpProcessMain.js`). ROI 중(MCP 보안/견고성).
- 기타: `AI_ATTRIBUTION` 툴화, hook 신규(`afterAgentThought`/`beforeTabFileRead`/subagent·remote 강제), AgentMode 확장(DEBUG/MULTITASK/PROJECT/TRIAGE)+`SWITCH_MODE` 셀프툴, 생성형 `.canvas.tsx` SDK(`useCanvasState`→`.canvas.data.json` 영속), Cloud Environment(`environment.json` spec+snapshot/restore).

### 7.3 Codex 3390 / codex-rs 0.135 신규

- **메모리를 agent-callable 툴로** — `codex_memories_extension::tools`{ad_hoc_note/list/read/search} + `MemoryCitation{lineStart,lineEnd}` + per-thread memory mode + write `guard{min_remaining_percent}`. 우리가 가진 2-phase consolidator(배경)와 별개로 **모델이 능동 쿼리**. ROI **중·높음**(retrieval 슬라이스 확장, line-citation grounding).
- **PermissionProfile 시스템** — `PermissionProfile`{List/Select/Apply/Resolve} + FS 4-tier(Legacy/Managed/Unrestricted/Canonical) + network-in-profile(HTTPS/SOCKS). named-profile resolve/apply 파이프라인. ROI 중(permission 레이어 hardening).
- **interactive PTY `command_exec`** — `CommandExec/Write/Terminate/Resize` 실 터미널 프로토콜(write_stdin 넘어 full PTY). ROI 중(REPL/TUI 툴 세션).
- **`fs` RPC + Thread goals + `CyberPolicy` 에러클래스 + deviceAttestation** — fs 9-verb agent RPC / 영속 objective+status / 보안정책 거부를 generic refusal과 분리한 에러종류 / 기기증명 auth. ROI 저·중(CyberPolicy는 typed-error-enum ADR-0203에 미러 가치).
- **heartbeatAutomations** — thread-targeted 재귀 트리거(next-run/error 추적). 우리 automation-engine 정련 참조. ROI 중.
- 스코프 밖: appgen("Sites" 플러그인+클라우드 호스팅), realtime WebRTC voice, computer-use Chrome확장/background-auth, worktree cloud snapshot.
- 정정: collaboration-mode는 **모드 추가 없음**(여전히 plan/default) — 단 **서버-fetch**로 바뀜(`{model,reasoning_effort,developer_instructions}` per-host).

### 7.4 Claude Desktop 1.0.734 / cc-cli 2.1.150 신규

- **★ Advisor 툴** — `advisor_20260301`{model} "더 강한 모델에 2nd opinion 요청". 슬래시 `/advisor`. 우리 dual-provider + verify/closeout 게이트에 딱. model-swap-on-retry(ADR-0064)는 있으나 **의도적 in-loop 에스컬레이션 툴** 없음. ROI **높음**.
- **★ init-verifiers — 적대적 멀티보터 검증 스킬** — surface별 verifier 스킬 자동생성(cli/api/backend/playwright) + `VOTES_PER_BUG` N-voter 적대적 verdict 집계. 우리 verify/closeout hard-gate 철학 + hellgate 방법론의 정확한 확장. branch-search(ADR-0083) N-best에 멀티보터 verdict 레이어 추가. ROI **높음**.
- **origin-tagged + UUID + schema-validated IPC** — Desktop 전면 재설계(`$eipc_message$_<uuid>_<origin>_<interface>_<method>`, 24 interface, `senderFrame.url` origin 검증 매 콜). Tauri/Web seam에 통째 흡수가치. ROI **높음**(우리 web↔native 경계 미정형).
- **DXT 확장 + org allowlist/blocklist(암호화 캐시) + compat-matrix** — `@anthropic-ai/mcpb` 2.0.1, MDM-style 원격정책 + safeStorage 암호화 캐시 + per-ext 호환성 매트릭스 게이트. 우리 trust-scope 있으나 org-pushed allowlist 없음. ROI **높음**(MCP trust 레이어).
- **task-budgets(소프트 self-moderation 예산)** — `task_budget:{type:"tokens",total:N}` 모델이 스스로 절제(enforced max_tokens와 별개). 우리 하드 토큰 breaker(ADR-0138)와 보완. ROI 중·높음.
- **unified background daemon** — `claude daemon`{assistants/scheduled/remote-control} + isolation 백엔드 matrix(docker/worktree/tmux/none) + rendezvous-socket. 우리 scheduled-agent(0161)+subagent bg 있으나 통합 supervisor 없음. ROI 중·높음(isolation-backend enum 캘리브레이션).
- 기타: `/goal`(predicate 만족까지 Stop 차단), `/batch`(5~30 worktree 병렬 실행), hook 신규(`Setup`/`SubagentStart`/`PostCompact`), `mid-conversation-system`(턴중 시스템프롬프트 교체), `tool-search-tool`(서버 동적 툴탐색 — 우리 ToolSearch 유사), 모델 카탈로그 opus-4-6/4-7, 344 `CLAUDE_*` env(`BUBBLEWRAP`/mTLS cert/BYOC datadog). Managed Agents(서버호스팅 루프)·`/ultrareview`(클라우드 멀티에이전트)는 아키텍처 divergent — 미흡수.

### 7.5 최신-소스 흡수 우선순위 (교차수렴·ROI 가중)

1. **네트워크 egress MITM 프록시 + 정책 amendment** (7.1, Cursor+Codex 수렴) — 보안축 production shape, Guardian post-denial과 짝.
2. **레이어드 정책 merge per-user/repo/team** (7.1, Cursor+Codex 수렴) — 우리 rule 3-layer를 sandbox/config 전반으로 일반화.
3. **경쟁사 import 온보딩** (7.1, Codex+Cursor 수렴) — adoption lever, ADR-0205 + transcript 파서 재사용.
4. **Advisor 툴 + init-verifiers 멀티보터** (7.4, Claude) — dual-provider + verify hard-gate 철학에 직접 부합.
5. **메모리 search 툴 + line-citation** (7.3, Codex) — retrieval 슬라이스 확장.
6. **DXT org allowlist(암호화) / task-budgets / origin-tagged IPC** — MCP trust·소프트예산·Tauri seam.

> 다음 스텝: 위 1~6을 §2 방식으로 quanta src 대조(R3 ground-truth) 후 진짜-갭만 확정 → 기존 worktree-병렬 흡수.

---

## 8. ★ 기깔나는 기능 ground-truth 확정 (실코드 대조 완료, jun-01 흡수와 분리)

> §7 최신소스 killer 후보 10개를 실제 `src/` + git log로 대조. jun-01 Tier1~2 흡수([[jun-01-tier12-gap-absorption]], commit `2cb147ea`)와 jun-02 `96821b77`가 일부를 이미 먹었음 — 그걸 빼고 **진짜 남은 갭**만 확정.

### ✅✅ 보완 SHIPPED (2026-06-02 2차 sprint — knob/configurable + fc 등록 + 빡센 hellgate/e2e)

10 슬라이스 전부에 (1) knob/configurable wiring + (2) feature-catalog 등록 + (3) 더 빡센 hellgate unit + e2e 추가. 2 웨이브 × 5 worktree-격리 TDD agent + cherry-pick. **휴리스틱 0 (검증신호·결정성만)**.

| 슬라이스 | knob env | fc | 신규 테스트 |
|---|---|---|---|
| advisor | `QUANTA_ADVISOR_MODEL` | 02-tool-system | +21 (allowlist bypass/injection/pure-consult/throw) |
| task-budget | `QUANTA_TASK_BUDGET` | 04-context | +knob+e2e (multi-turn decrement, no-hard-stop) |
| memory mode/citation/guard | `QUANTA_MEMORY_MODE`/`_WRITE_GUARD_PCT`/`_LINE_CITATIONS` | 05-memory | +36 (spy zero-call, guard boundary, line-span) |
| multi-voter | `QUANTA_MULTI_VOTER` | 07-resilience | +20 (quorum boundary, byzantine, all-throw fail-closed, e2e winner-flip) |
| policy-layers | `QUANTA_POLICY_MERGE_STRATEGY` | 03-permission | +16 (property precedence, most-restrictive invariant, TwoLayerManager decision-flip) |
| compose-authoring | `QUANTA_COMPOSE_AUTHORING` | 02-tool-system | +62 (conventional parse edges, real-git-repo e2e) |
| network-proxy | `QUANTA_NETWORK_PROXY` | 03-permission | +12 (real spawned-child socket egress block/allow/amend/SSRF) |
| import | (CLI `session import`) | 09-integration | +5 RT (persist→resumable round-trip, dedup, N10 syscall-spy) |
| mcp-tasks | (MCP capability-negotiated) | 09-integration | +23 (capability gate, malformed→typed, cancel race) |
| profile-list | `QUANTA_PROFILES_DIR` | 03-permission | +45 (per-axis ceiling breach, shadow-built-in, path-traversal) + slice-boundary env fix |

**게이트**: typecheck src 0 / fc validate 786 features all-resolved / 신규 ~245 테스트 pass / **회귀 0** (baseline 8845bcd1 = 119 fail → HEAD = 111 fail, *감소*; 잔여 111은 전부 사전존재 = 사용자 in-flight track + global-knob-registry 테스트격리 hazard, 내 슬라이스 이름 0건). knob 17→총 19, `knobs-import-bundle` drift-test를 파일수-파생으로 리팩터(향후 충돌 0). 알려진 사전 hazard: `__resetRegistry` cross-file 오염(임의 다파일 그룹 한정; 자연 CI 그룹 `runner/knobs+cli`=1300/0 clean) — 별도 하네스 리팩터 대상.

### Tier 1 — 진짜 ❌ 없음 · 高ROI · 低~中비용 (바로 흡수 후보)

| # | killer 기능 | 확정 | 근거 | 비용 |
|---|---|---|---|---|
| **1** | **diff→PR본문/커밋메시지 저작** | ❌ ABSENT | `git_commit`은 caller 메시지만 받고 `wip:<ts>`만 자동(commit.ts:37/56), `gh_pr_create`는 body verbatim. `make-pr-easy-to-review`는 *감사*만(auto-apply 금지), `from-pr` composeSummary는 deterministic 템플릿(LLM 아님). **infra(git_diff/staged/gh view/sub-agent injection) 전부 있음** → authoring-prompt + tool/skill glue만. | **~1 슬라이스** |
| **2** | **Advisor 툴 (모델이 in-loop으로 더 강한 모델에 2nd opinion)** | ❌ ABSENT | 최근접 `delegate`(ADR-0393)는 mode 선택이지 model 아님 / role-override(ADR-0256)는 composition resolver지 agent-callable 툴 아님 / model-swap(ADR-0066)은 failure-driven. **모델이 능동 호출하는 advisor 툴 없음.** dual-provider라 백엔드는 준비됨 | 中(툴+프롬프트) |
| **3** | **레이어드 정책 merge (per-user/per-repo/team-admin + override metadata)** | ❌ ABSENT(정책/config) | rule 3-layer(project>user>system)는 *prompt 룰텍스트 전용*, sandbox/config로 일반화 안 됨. `PermissionScope` 4-tier는 ordering primitive(strongerScope)일 뿐 struct merge 엔진/`OverriddenMetadata` 없음. **Cursor+Codex 둘 다 보유 = 가장 깨끗한 갭** | 中 |
| **4** | **task-budget 소프트 self-moderation (모델에 잔여예산 노출)** | ❌ ABSENT | `BudgetMeter`(ADR-0138)는 enforcement 게이트 전용, prompt-body 예산문구는 static prose, UsageBar는 CLI `/context`에만(hot-path OFF). **모델에 surface 안 됨** — 단 UsageBar 배관 있어 surfacing 경로 짧음 | 低~中 |

### Tier 2 — 🟡 부분(절반 jun-01에 먹힘, 절반 진짜 갭)

| # | killer 기능 | 확정 | jun-01/02 기여 vs 남은 갭 |
|---|---|---|---|
| **5** | **네트워크 socket-level MITM 프록시 + 런타임 정책 amendment** | 🟡 | jun-01 `2cb147ea`가 allowlist→`dispatchGuard` 배선(network-guard.ts, "defined-but-not-enforced" 구멍 닫음). **남은 갭**: 소켓 인터셉트 프록시 없음(tool-arg 추출 게이트라 자기 소켓 여는 subprocess는 못 막음) · `NetworkPolicyAmendment`(거부→승인 후 allow셋 확장) 없음 · per-conn decision log·SSRF 체크 없음 |
| **6** | **경쟁사 import 온보딩 (sessions+MCP+skills+plugins+hooks)** | 🟡 (인벤토리 과장) | `src/migration/`(ADR-0038) wired(`session import claude_code|cursor|aider`)지만 detector는 sessions+skills만, **MCP/plugins/hooks/rules/`.claude-plugin` 미탐지**, importer는 `persisted_sessions=0`(translate-prove만, 실제 적재 X), dedup 미적용. ADR-0205 5-vendor는 *rules-파일* 별개 슬라이스 |
| **7** | **MCP Tasks live binding** | 🟡 seam-only | port+store+poller+tools 다 있으나 `client.ts`에 `tasks/*` JSON-RPC 디스패치 0(elicitation은 L303 wired), `mcpTasksTools()` 호출처 없음·defaultTools 미포함. Elicitation은 ✅ |

### Tier 3 — 🟡 다른 모양/이미 충족 (低우선, 추격 ROI 낮음)

- **8 메모리 line-level citation + per-thread mode** — `memory_search/write/update`는 ✅ wired(tooling.ts:139, store 있으면 default-on). 단 `MemoryCitation`은 prompt-window *placement* provenance지 `{lineStart,lineEnd}` 소스라인 아님 · write-guard `min_remaining_percent` 없음. **증분.**
- **9 적대적 멀티보터 검증** — branch-search(ADR-0084)는 deterministic N-best(tsc/test/lint 신호 + 단일 llm_judge weight). per-bug N-voter verdict 집계·surface별 auto-gen verifier 스킬은 없으나, **deterministic 신호가 코드엔 LLM 투표보다 오히려 강함** — "여러 후보 검증" 니즈 이미 충족.
- **10 PermissionProfile List/Select** — 코어 resolve/apply+FS-tier+CLI/env는 jun-02 `96821b77`로 wired. List/Select 발견 verb + 단일콜 network 합성만 남음. **소갭.**

### ✅ SHIPPED (2026-06-02 sprint — 10 슬라이스 전부 main 정착)

ROI 무관 SOTA++ 전량 흡수. 2 웨이브 × 5 worktree-격리 TDD agent + cherry-pick. **typecheck src 0 / 슬라이스 204 hellgate·e2e pass / 0 fail / 회귀 0**. 전부 default-OFF seam(absent ⇒ byte-identical), hexagonal/SOLID. (병행한 사용자 in-flight 커밋 `f264e65a`/`10b0928f`과 무충돌 공존.)

| 슬라이스 | ADR | commit | 테스트 | 상태 |
|---|---|---|---|---|
| diff→PR/커밋메시지 저작 (LLMPort-injected `git_compose_commit`/`_pr`) | — | bd1be1b8 | 26 | ✅ seam (composition root에서 `config.composeAuthoring` 바인딩 follow-up) |
| Advisor 툴 (agent-callable 2nd-opinion consult) | 0429 | 5844d0bc | 17 | ✅ seam (`config.advisor` 바인딩 follow-up) |
| 레이어드 정책 merge (per-user/repo/team + OverriddenMetadata) | — | 58307da4 | 19 | ✅ pure engine (permission layer 소비 follow-up) |
| task-budget 소프트 self-moderation (모델 노출) | — | df1293aa | 16 | ✅ buildDynamicContext wired (`config.taskBudget` 바인딩 follow-up) |
| 네트워크 socket-level MITM 프록시 + 정책 amendment + SSRF | 0428 | 85e5bcdf | 43 | ✅ port+adapter (child-spawn env 주입 follow-up) |
| 경쟁사 import 실적재 (sessions persist + MCP/hooks/rules + dedup, N10 ban) | 0430 | 17ba6831 | 23 | ✅ wired (CLI `session import` opt-in) |
| MCP Tasks live binding (`tasks/*` 아웃바운드 + 툴 등록) | 0431 | 4dfeef97 | 12 | ✅ wired (tasks-capable 서버 시 default-on) |
| 메모리 line-level citation + per-thread mode + write-guard | 0432 | e3761ab0 | 14 | ✅ seam (AgentConfig→tooling 바인딩 follow-up) |
| 적대적 멀티보터 검증 + VerifierSkillSpec | 0433 | 2583f352 | 20 | ✅ additive branch-search 신호 (caller wire follow-up) |
| PermissionProfile List/Select + user-defined disk profiles | 0434 | 0eae1d1f | 17 | ✅ wired (`QUANTA_PROFILES_DIR` opt-in) |

**남은 공통 follow-up**: 대부분 seam은 composition-root 바인딩만 남음(default-OFF라 미바인딩=byte-identical 무해). Tier 3 일부(memory line-citation·multi-voter)는 의도적으로 caller-wire 보류.

### 확정 흡수 우선순위 (jun-01 제외 후)

1. **diff→PR/커밋 저작** (T1#1) — infra 완비, ~1 슬라이스, 최고 빈도. **즉시 착수 1순위.**
2. **Advisor 툴** (T1#2) — dual-provider + verify/closeout에 직결, 차별화.
3. **레이어드 정책 merge** (T1#3) — Cursor+Codex 확증, 가장 깨끗한 ❌.
4. **task-budget 소프트 노출** (T1#4) — UsageBar 배관 재사용, 저비용.
5. **네트워크 MITM 프록시 + amendment** (T2#5) — 보안축 production shape (allowlist 절반은 jun-01 완료).
6. import 진짜 적재 / MCP Tasks live binding — 中ROI, 후속.
