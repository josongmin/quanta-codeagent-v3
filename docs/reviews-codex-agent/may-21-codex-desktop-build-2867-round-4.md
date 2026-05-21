# Codex Desktop build 2867 — Round-4 Deep Dives + Round-3 정정 (2026-05-21)

Round-3 (`may-21-codex-desktop-build-2867-round-3.md`) 위에 5개 영역 추가 deep-dive 결과 + 정정 사항. 본 문서는 build-reference 강도가 가장 높음.

## Round-3 정정 사실 (Round-4 logs/strings forensics 결과)

| 항목 | Round-3 결론 | Round-4 확정 |
|---|---|---|
| Transport framing | "stdio + **h2-style flow control** 위에" | **HTTP/1.1 pooled connections**. h2/HTTP/2 framing 미사용. (logs: `http1 handshake complete, spawning background dispatcher task`) |
| 모델 API endpoint | "OpenAI API" 추정 (api.openai.com) | **`wss://chatgpt.com/backend-api/codex/responses`** (WS) / **`https://chatgpt.com/backend-api/codex/responses`** (HTTP+zstd) / Analytics: `https://chatgpt.com/backend-api/codex/analytics-events/events`. **api.openai.com 직접 호출 아님** |
| Anthropic SDK 사용 여부 | "vendored, 트리거 미확정" | **dead code 확정**. logs에서 anthropic/claude API call 0건. Sentry @sentry/node auto-instrumentation hook 부산물 |
| primary-runtime marketplace 규모 | "100+ plugins (asana, figma, github, notion, slack, stripe, vercel, zoom 등)" | **3 plugins only**: documents/spreadsheets/presentations (모두 OpenAI 자체 artifact editor, 외부 API integration 0개). 잘못된 추정 정정 |

## Round-4 5-dive 통합 결과

### 1. V4A patch grammar — **`*** Move to:` rename 발견**

```ebnf
patch          ::= "*** Begin Patch" LF environment_id? hunk+ "*** End Patch" LF
environment_id ::= "*** Environment ID: " filename LF
hunk           ::= add_hunk | delete_hunk | update_hunk
add_hunk       ::= "*** Add File: " filename LF add_line+
delete_hunk    ::= "*** Delete File: " filename LF
update_hunk    ::= "*** Update File: " filename LF change_move? change?
change_move    ::= "*** Move to: " filename LF     ★ rename + edit atomic
change_context ::= ("@@" | "@@ " /(.+)/) LF
change_line    ::= ("+" | "-" | " ") /(.*)/ LF
```

예시 (rename + 수정):
```
*** Begin Patch
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** End Patch
```

### 2. OTel canonical attribute vocabulary (70+ keys)

- 세션/턴: `codex.conversation.turn.count`, `codex.thread.{started,fork,rename,side}`, `codex.turn.{e2e_duration_ms, ttft.duration_ms, ttfm.duration_ms, tool.call, reasoning_effort, memory, token_usage.{input,cached_input,non_cached_input,output,reasoning_output,total}_tokens}`
- MCP/Tool: `codex.mcp.{tools.{list,fetch_uncached,cache_write}.duration_ms, call.duration_ms}`, `codex.tool.{call, unified_exec}`, `codex.tool_result`, `codex.tool_decision`
- Multi-agent/Compaction: `codex.task.{compact, review, user_shell}`, `codex.multi_agent.{spawn, resume, nickname_pool_reset}`
- Startup: `codex.startup.{phase.duration_ms, prewarm.duration_ms, prewarm.age_at_first_turn_ms}`, `codex.{process.start, sse_event.duration_ms, websocket.{request,event}.duration_ms, api_request.duration_ms}`
- Storage: `codex.sqlite.{init.count, init.duration_ms, fallback.count}`, `codex.db.{error, backfill.duration_ms}`, `codex.memory.{startup, phase}`
- Network/Approval: `codex.network_proxy.policy_decision`, `codex.approval.requested`

Span hierarchy 10-11단계 nested tree (한 turn당):
```
session_loop → submission_dispatch{otel.name="op.dispatch.*"}
            → turn{otel.name="session_task.turn", model, codex.turn.reasoning_effort}
            → run_turn → run_sampling_request{cwd}
            → try_run_sampling_request → receiving_stream/stream_request
            → handle_responses{tool_name, from=...}
            → handle_output_item_done → handle_tool_call → handle_tool_call_with_source
            → dispatch_tool_call_with_code_mode_result{tool_name, call_id, aborted}
```

OTLP exporter: opentelemetry-otlp 0.31.0 (HTTP + gRPC tonic 둘 다 링크). env: `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_TIMEOUT`.

### 3. macOS Seatbelt 샌드박스 프로파일 — production verbatim 추출

```scheme
(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow ipc-posix-sem)
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow user-preference-read)
(allow file-read*
  (subpath "/Library/Apple") (subpath "/Library/Filesystems/NetFSPlugins")
  (subpath "/private/var/db/timezone") (subpath "/usr/lib") (subpath "/usr/share")
  (subpath "/Library/Preferences") (subpath "/var/db") (subpath "/private/var/db")
  (subpath "/Library/Apple/System/Library/Frameworks")
  (subpath "/System/Library/Extensions") (subpath "/System/Library/Frameworks")
  (subpath "/System/Library/PrivateFrameworks") (subpath "/System/Library/SubFrameworks")
  (subpath "/System/iOSSupport/System/Library/Frameworks") (subpath "/usr/lib"))
(allow file-read*
  (literal "/etc") (literal "/tmp") (literal "/var") (literal "/private/etc/localtime"))
```

3 모드: `read-only | workspace-write | danger-full-access`. Linux는 `codex-linux-sandbox` 크레이트 (Landlock kernel 5.13+, `useLegacyLandlock` toggle 시 seccomp fallback).

### 4. 6 subagent tools 풀 인벤토리 (6,386 sessions 실측)

| Tool | 빈도 | 용도 |
|---|---:|---|
| `exec_command` | 75% | 셸 명령 |
| `write_stdin` | 24% | interactive REPL/터미널 stdin 주입 |
| `spawn_agent` | 0.5% | subagent 명시적 spawn |
| `wait_agent` | 0.45% | subagent join |
| `update_plan` | 0.4% | Plan 모드 작업 계획 변경 |
| `close_agent` | 0.2% | subagent 종료 |
| `send_input` | <0.01% | write_stdin 변형 |

`exec_command` 풀 스키마: 입력 `{cmd, workdir, login, tty, yield_time_ms, max_output_tokens, timeout_ms}` → 반환 `{exit_code, stdout, stderr, aggregated_output, parsed_cmd}`.

**🎭 39 거장 nickname pool**: Averroes, Banach, Beauvoir, Bohr, Carson, Chandrasekhar, Confucius, Curie, Dalton, Dirac, Erdos, Euler, Faraday, Feynman, Godel, Goodall, Harvey, Hegel, Hooke, James, Kant, Kuhn, Linnaeus, Lorentz, Maxwell, Meitner, Mill, Nash, Nietzsche, Noether, Ohm, Pascal, Peirce, Poincare, Rawls, Russell, Sartre, Schrodinger, Tesla. `codex.multi_agent.nickname_pool_reset` 텔레메트리 짝.

agent_role enum: `explorer` 42% / `none` 28% / `worker` 16% / 미배정 14%.

### 5. 6,386 session corpus 풀 통계

| 분위 | 사이즈 | 레코드 | Turn |
|---|---|---|---|
| P50 | 766 KB | 232 | 1 |
| P90 | 10 MB | 1,400 | 5-10 |
| P99 | 52 MB | 5,581 | 20-50 |
| Max | **141 MB** | **51,794** | **287** |

- 18일 / 6,386 sessions / 26 GB / 일평균 355
- subagent 86% (depth=1만 관측), forking 32%, compaction 34%
- reinit 38% (한 세션 최대 61 session_meta — 정상 패턴)
- task_complete 92% / turn_aborted 3.7%
- 모델 affinity: 세션 내 모델 스위치 0건 (96% gpt-5.4)
- 워크스페이스: 90% semantica-codegraph-v2

새 event_msg subtype: `thread_name_updated`, `agent_reasoning`, `item_completed` (총 12종)
새 response_item subtype: `custom_tool_call`, `custom_tool_call_output`, `web_search_call` (총 7종)

### 6. System skills `.system/` 디렉토리

```
~/.codex/skills/
├── .system/
│   ├── .codex-system-skills.marker          (16-char hex)
│   ├── skill-creator/
│   ├── skill-installer/                      (curated + GitHub install)
│   ├── plugin-creator/
│   ├── imagegen/
│   └── openai-docs/
└── chronicle/                                (system bundled)

~/.codex/memories/
├── skills/code-only-progress-audit/SKILL.md  (memory-side skill)
└── extensions/
    ├── chronicle/{instructions.md, resources/}
    └── ad_hoc/{instructions.md, notes/}
```

SKILL.md frontmatter:
```yaml
---
name: <slug>
description: <prescriptive 1-sentence>
argument-hint: "[optional]"
user-invocable: true | false                  ← 슬래시 호출 여부
allowed-tools: [Read, Grep, Bash, ...]
---
```

Skills (agent turn 시) vs Extensions (consolidation daemon 시) 명확 분리.

### 7. Side conversation prompt 발견

> "You are a side-conversation assistant, separate from the main thread. Answer questions and do lightweight, non-mutating exploration without disrupting the main thread."

→ main thread + sub-thread 동시 운영. `codex.thread.side` 텔레메트리 키와 짝.

### 8. Realtime WebSocket 8 methods (음성)

```
thread/realtime/started
thread/realtime/itemAdded
thread/realtime/transcript/{delta, done}
thread/realtime/outputAudio/delta
thread/realtime/sdp                            ← WebRTC SDP negotiation
thread/realtime/{error, closed}
```

### 9. Guardian "Post-denial precedence" 정책

> "Post-denial user approval has highest precedence: if the user clearly and explicitly re-approves the exact previously denied action after seeing the concrete risk, set `user_authorization = "high"` and `outcome = "allow"`, overriding the other allow/deny rules in this section."

### 10. WebSocket event.kind 12종 (forward compat gap 포함)

```
response.{created, in_progress, completed}     ← in_progress는 Codex가 미처리(silent drop)
response.output_item.{added, done}
response.content_part.{added, done}
response.output_text.{delta, done}
response.function_call_arguments.{delta, done}
response.custom_tool_call_input.delta
```

## ADR 후보 풀 (Round-3 12개 + Round-4 9개 = 21개)

P3 → P2 승격 권장 (Round-4 신규):
13. V4A `*** Move to:` rename atomic 지원
14. OTel 70-key canonical vocabulary 채택
15. macOS Seatbelt 프로파일 직접 channeling
16. 6 subagent tools 1급 시민 (spawn/wait/close_agent + exec_command + write_stdin)
17. 30-50 거장 nickname pool + `nickname_pool_reset` 메커니즘
18. Skills vs Extensions 명확 분리 (agent turn vs consolidation daemon)
19. `user-invocable: true|false` frontmatter 필드
20. Guardian "Post-denial precedence" 어프루벌 정책
21. `response.in_progress` 이벤트 처음부터 처리 (Codex forward compat gap 보완)

## 정정된 build-ready 매트릭스

### Endpoints
| 용도 | URL |
|---|---|
| WS Responses API | `wss://chatgpt.com/backend-api/codex/responses` |
| HTTP Responses API | `https://chatgpt.com/backend-api/codex/responses` (POST + zstd) |
| Analytics | `https://chatgpt.com/backend-api/codex/analytics-events/events` |
| OAuth | `https://auth.openai.com/oauth/token` (client_id=`app_EMoamEEZ73f0CkXaXp7hram`) |
| Sparkle | `https://persistent.oaistatic.com/codex-app-prod/appcast.xml` |
| MCP UI iframe | `https://web-sandbox.oaiusercontent.com/` |

### v3 캘리브레이션
- In-memory session buffer: **≥50MB** (P99=52MB), stress-test 150MB (max=141MB)
- Compaction trigger: 20MB in-memory
- Record batch: 1,000
- Subagent depth 지원: **2+** (현재 corpus depth=1만, 가정 확장)
- Max turn/session: **300+** (outlier max=287)
- Nickname pool: **30-50 거장 + reset**

## 미해결 / 다음 dive 후보
- MCP server lifecycle logs (logs_2 에 안 보임 — 다른 logging level? 비활성?)
- `~/Library/Application Support/Codex/` 풀 (Crashpad, Cookies, Network Persistent State, Partitions)
- `~/.cache/codex-runtimes/` 외 runtime cache (codex-texlive 등)
- Sentry actual DSN + Datadog API key (network instrumentation)
- depth=2+ subagent 시나리오 reproduce (가정 검증)

## Cross-link 메모리
- [[codex-desktop-build-2867-round-4]] — 이 라운드 통합
- [[codex-desktop-build-2867-round-3]] — 이전 round (round-4에서 정정됨)
- [[codex-desktop-build-2867-round-2]] — 6-agent SOTA audit (보완적)
- [[codex-feature-catalog-2026-05-21]] — 15 카테고리 feature audit (보완적)
- [[codex-v4a-patch-grammar]], [[codex-otel-attribute-vocabulary]], [[codex-seatbelt-sandbox-profile]], [[codex-subagent-tools]], [[codex-session-corpus-calibration]], [[codex-system-skills-pattern]]
- [[codex-jsonrpc-protocol-pattern]] — endpoint/h2 정정 반영
- [[anthropic-sdk-in-codex]] — dead code 확정
