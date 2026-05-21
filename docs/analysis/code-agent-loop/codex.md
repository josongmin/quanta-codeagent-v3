# Codex (codex-rs) — 입력→Envelope→LLM / 응답 타입 / 분기 트리

> **수집 방법**: 이 머신의 **실제 live rollout** `~/.codex/archived_sessions/rollout-*.jsonl`
> (6,855 세션) 를 직접 파싱해 추출. 이전 forensic 추론(`docs/reviews-codex-agent/`)을
> **실측으로 검증·정정**한 버전이다. 값은 privacy 위해 truncate(`…`)했으나 **필드 구조는
> verbatim FACT** (실파일에서 직접). 표본 파일: `rollout-2026-05-21T03-16-29-…ca.jsonl`
> (39 session_meta / 7080 event_msg / 17331 response_item / 96 turn_context / 54 compacted).
>
> **transport**: WS/HTTP `chatgpt.com/backend-api/codex/responses` (OpenAI Responses API, **api.openai.com 아님**).
> Electron renderer ↔ app-server 는 JSON-RPC 2.0 over stdio.

---

## 0. rollout JSONL 5 top-level type (FACT, 실측)

```
session_meta    세션당 1회 (헤더)
turn_context    매 턴 1회 (per-turn 정책 스냅샷)
response_item   모델 입출력 아이템 (대부분 — 위 표본 17331/24600)
event_msg       런타임→UI 이벤트
compacted       compaction 시 replacement_history 기록
```
모든 레코드 envelope = `{ "timestamp": ISO, "type": <5종>, "payload": {...} }` (FACT).

---

## A. 입력 → Envelope → LLM (3계층)

```
[사용자 입력 (Codex Desktop / CLI)]
   │  Electron renderer ↔ app-server : JSON-RPC 2.0 over stdio
   ▼
① Submission { id, op: Op }                         ← 턴 입력 (op명 FACT, 구조 INFERENCE)
   │
   ▼
② turn_context (16필드) + session_meta 병합          ← 엔진 보관/스냅샷  [FACT, 실측]
   │  instruction stack + tools[](content-hash 캐시) 패킹
   ▼
③ Responses-API request { model, instructions, input[], tools[], reasoning }  [필드명 INFERENCE]
   │  app-server가 WS/HTTP+zstd로 전송
   ▼
   POST/WS  chatgpt.com/backend-api/codex/responses               [FACT]
```

### ① 클라→엔진: Submission op (6종) [FACT]
```
user_input | user_input_with_turn_context | user_turn | shutdown | interrupt | reload_user_config
```

### ② turn_context — 매 턴 전체 스냅샷 [FACT, 실측 verbatim 구조]
```jsonc
{
  "turn_id": "019e40a6-…",
  "cwd": "/Users/songmin/…",
  "current_date": "2026-05-19",
  "timezone": "Asia/Seoul",
  "approval_policy": "never",                       // never|on-request|on-failure|always
  "sandbox_policy": { "type": "danger-full-access" },// ★ 객체! (string 아님) read-only|workspace-write|danger-full-access
  "permission_profile": { "type": "disabled" },
  "model": "gpt-5.4",                               // ★ per-turn — 세션 중 모델 변경 가능
  "personality": "pragmatic",
  "collaboration_mode": {
    "mode": "default",
    "settings": { "model": "gpt-5.4", "reasoning_effort": "high", "developer_instructions": "# Collaboration Mode…" }
  },
  "realtime_active": false,
  "effort": "high",                                 // low|medium|high
  "summary": "none",
  "user_instructions": "Be concise, direct, and technical…",
  "developer_instructions": "<app-context># Codex desktop context…"
}
```
**정정**: 이전 forensic 문서는 `sandbox_policy`를 string으로 적었으나 **실제는 `{type:…}` 객체**. `permission_profile`도 `{type:"disabled"}`.

### session_meta (세션당 1회) [FACT, 실측 12필드]
```
id, forked_from_id, timestamp, cwd, originator, cli_version,
source, thread_source, model_provider,
base_instructions{ text(~12950자 코어 시스템프롬프트) },
dynamic_tools[]{ namespace, name, description, inputSchema(JSON-schema) },
git
```
→ `forked_from_id` = fork 계보, `dynamic_tools` = **세션 도구 카탈로그(풀 스키마)**, `base_instructions.text` = 코어 시스템프롬프트. (자세한 내용 §A+ 참고.)

### ③ 엔진→모델: Responses-API request [transport FACT, 필드명 INFERENCE]
| 필드 | 의미 |
|---|---|
| `model` | per-turn 모델명 |
| `instructions` | 시스템 프롬프트 (= base_instructions, 서버푸시·ETag·personality 템플릿). **메시지가 아니라 별도 필드** |
| `input[]` | response item 배열 (message / function_call / function_call_output …) |
| `tools[]` | 도구 카탈로그 (스키마는 content-hash 캐시 `cache/codex_apps_tools/{hash}.json`) |
| `reasoning` | `{effort}` |

### ★ 역할(role) enum — 4종 [FACT, 실측: developer 확인됨]
```
user | assistant | developer | (system)
```
- 실측: 시스템성 컨텍스트(permissions/app-context/memory)는 **`role:"developer"` + `content:[{type:"input_text",text}]`** 로 들어옴.
- 도구결과는 role이 아니라 **독립 `function_call_output` response_item**.
- → Cursor(HUMAN/AI 2-role)와 결정적 차이: **Codex는 OpenAI 표준 role**.

### 요청측 enum [FACT]
```
approval_policy : never | on-request | on-failure | always
sandbox_policy.type : read-only | workspace-write | danger-full-access
effort / reasoning_effort : low | medium | high
collaboration_mode.mode : default | (plan 등)
personality : pragmatic | …
```

---

## A+. 무엇을 보내나 — 프롬프트 조립 + 상황별 페이로드 (실측 FACT)

### 턴 경계 레코드 시퀀스 (실측, 세션 시작)
```
session_meta ×2              ← 헤더 (base_instructions + dynamic_tools 포함)
event_msg:task_started
response_item:message(developer)   ← 시스템/정책 블록 스택 (아래 7블록)
response_item:message(user)        ← AGENTS.md + environment_context (repo rules)
turn_context                       ← per-turn 정책 스냅샷
response_item:message(user)        ← 실제 사용자 입력 (+ IDE context)
event_msg:user_message
event_msg:token_count
response_item:reasoning
event_msg:agent_message
response_item:message(assistant) → function_call ×N → output ×N → …
```

### 1) 코어 시스템 프롬프트 — `session_meta.base_instructions.text` (실측 12,950자)
시작: `"You are Codex, a coding agent based on GPT-5. You and the user share the same workspace…"`
13개 섹션 (실측 마크다운 헤더):
```
# Personality (## Values / ## Interaction Style / ## Escalation)
# General (## Editing constraints / ## Special user requests /
           ## Autonomy and persistence / ## Frontend tasks)
# Working with the user (## Formatting rules / ## Final answer instructions /
                         ## Intermediary updates)
```
→ 세션당 1회, 서버푸시·ETag 버전·personality 템플릿. **Responses-API `instructions` 필드로 매핑.**

### 2) 도구 카탈로그 — `session_meta.dynamic_tools[]` (★ 풀 스키마 포함, 실측)
```jsonc
dynamic_tools: [
  { "namespace":"codex_app", "name":"automation_update",
    "description":"Create, update, view, or delete recurring automati…",
    "inputSchema":{ "type":"object", "properties":{ "id":{…}, "mode":{…} } } },
  { "name":"read_thread_terminal", … },
  { "name":"load_workspace_dependencies", … }
]
```
**정정**: 빌트인 도구 스키마가 "전부 서버전용"은 아님 — **dynamic_tools는 session_meta에 full inputSchema(JSON-schema)로 박혀있음** (실측). 코어 빌트인(exec/read/grep…)은 별도 카탈로그(content-hash 캐시)일 수 있으나, app/MCP/automation 류는 session_meta에 동적 등재.

### 3) 정책/컨텍스트 블록 스택 — 첫 `message(role:developer)` content[] (실측 7블록)
상황에 따라 켜지는 조건부 주입 (각 `{type:"input_text", text}`):
```
<permissions instructions>     ← sandbox/approval 규칙 (항상)
<app-context>                  ← Codex desktop 환경 (desktop일 때)
## Memory                      ← memory 폴더 가이드 (memory 활성 시)
<collaboration_mode>           ← Default/Plan 모드 지침 (mode별 내용 다름)
<personality_spec>             ← 사용자 커뮤니케이션 스타일 (personality 설정 시)
<skills_instructions>          ← 활성 skill (skill 매칭 시)
<plugins_instructions>         ← 설치 plugin (plugin 있을 때)
```
→ **상황별 = 조건부 블록**. mode=Plan이면 `<collaboration_mode>` 내용이 Plan 지침으로, skill 매칭되면 `<skills_instructions>` 주입, plugin 없으면 그 블록 생략.

### 4) repo 규칙 — 첫 `message(role:user)` (실측)
```
# AGENTS.md instructions for <repo path>
# AGENTS.md
<environment_context>          ← cwd/git/OS 등 환경
```
→ AGENTS.md(레포-로컬 규칙) + environment_context를 **사용자 입력 앞에** 주입.

### 5) 실제 사용자 입력 — 연속 턴 `message(role:user)` (실측, IDE context 주입)
```
# Context from my IDE setup:
## Active file: docs/rfc/…           ← 현재 열린 파일
## Open tabs: …                       ← 열린 탭
## My request for Codex:              ← 진짜 사용자 텍스트는 여기
<실제 프롬프트>
```
→ **매 턴 IDE 상태(active file/open tabs)를 사용자 텍스트와 함께 패킹**. Cursor의 SelectedContext에 대응하나 Codex는 마크다운 텍스트로 인라인.

### 6) turn_context (§A ② 참고) — per-turn 정책
사용자 입력과 함께 매 턴 16필드 스냅샷 (model/approval/sandbox/effort/instructions). **모델 변경·정책 변경이 턴 단위로 반영.**

### 상황별 페이로드 요약 (무엇이 언제 바뀌나)
| 상황 | 페이로드 변화 |
|---|---|
| 세션 첫 턴 | session_meta(base_instructions+dynamic_tools) + developer 7블록 + AGENTS.md/environment_context |
| 연속 턴 | turn_context 갱신 + user message에 IDE context(active file/tabs) 재주입 |
| mode=Plan | `<collaboration_mode>` 내용이 Plan 지침으로 / turn_context.collaboration_mode.mode="plan" |
| skill 매칭 | `<skills_instructions>` 블록 추가 |
| compaction 후 | `compacted.replacement_history`로 과거 치환 + turn_context.summary 연속성 |
| 모델 교체 | turn_context.model 변경 (세션 중 gpt-5↔gpt-5.4 가능) |
| subagent | 별도 thread (spawn_agent), 자식은 자체 turn_context |

---

## B. 응답: typed enum / 메시지 형태 / 전체 타입

### (a) 스트림 이벤트 — `event.kind` 12종 [FACT, Responses-API SSE]
```
response.created / in_progress(Codex가 silent-drop) / completed
response.output_item.{added, done}
response.content_part.{added, done}
response.output_text.{delta, done}
response.function_call_arguments.{delta, done}   ← arguments JSON string을 델타 누적, .done 확정
response.custom_tool_call_input.delta
```

### (b) `response_item` — 조립/저장 아이템 [FACT, 실측 verbatim]

**message** — `{type, role, content[]}`, content 원소 = `{type, text}`:
```jsonc
{ "type":"message", "role":"developer",
  "content":[ {"type":"input_text","text":"<permissions instructions>…"}, … ] }
```
- 입력측 content part = `input_text`, 출력측 = `output_text` (FACT). assistant 최종 답변은 `phase:"final_answer"` 마커.

**function_call** — `{type, name, arguments, call_id}` (★ `id`/`status` 없음):
```jsonc
{ "type":"function_call", "name":"exec_command",
  "arguments":"{\"cmd\":\"rg -n …\"}",   // arguments = JSON 문자열
  "call_id":"call_HPD1kMpUR5Qd7JOIwQCQ2DoX" }
```

**function_call_output** — `{type, call_id, output}` (★ **`output`** — `content`/`status` 아님!):
```jsonc
// 99.99% case — 문자열
{ "type":"function_call_output", "call_id":"call_HPD1k…",
  "output":"Chunk ID: f62338\nWall time: …\nProcess exit…" }

// 0.01% case (10/82322) — 멀티모달/automation 출력은 content-part 배열
{ "type":"function_call_output", "call_id":"…",
  "output":[{"type":"input_text","text":"Created automation in the app."}] }
// 또는 [{"type":"input_image","image_url":"data:image/jpeg;base64,…"}]
```
**정정**: forensic 메모리는 `{call_id,status,content}`라 했으나 **실측은 `{call_id,output}`** (output은 보통 string, 드물게 content-part 배열).

**custom_tool_call** — apply_patch 등은 function_call이 아니라 별도 타입 (★ `status` + `input` 보유):
```jsonc
{ "type":"custom_tool_call", "status":"completed",
  "call_id":"call_Fhv…", "name":"apply_patch",
  "input":"*** Begin Patch\n*** Update File: …" }      // V4A patch grammar
```
**실측 (500파일 4297건)**: custom_tool_call.name은 **`apply_patch` 단 1종**. 다른 이름은 없음.

**reasoning** — 4필드 [FACT live, 18,082건]:
```jsonc
{ "type":"reasoning",
  "summary":[{"type":"summary_text","text":"**Considering automation status**\n\n…"}],  // 99.9% 빈 []
  "content":null,                                          // 항상 null
  "encrypted_content":"gAAAAABp-8Dh80gs9aW9FcG_urJ5Bgk7uWyHQSFA…"  // ★ Fernet 암호화, 1200-1800자
}
```
★ **reasoning 본문은 Fernet 암호화돼 클라이언트에 평문 없음**. 가끔(20/18082=0.1%) `summary[]`에 plaintext digest. 모델 사고가 보안적으로 보호됨.

**+ `custom_tool_call_output`, `web_search_call`** — `{type, status}`만 (query/result 안 남음).

**response_item 전체 (500파일 실측, 비율)**:
- function_call ~73% (`exec_command` 단일이 ~73% 차지) — 91,795건
- write_stdin (function_call.name) ~22% — 27,670건
- reasoning ~12% — 19,060건 (codex.md 이전 추정 3223보다 훨씬 많음)
- message ~mid, custom_tool_call(apply_patch) ~수천, web_search_call 매우 드묾

### (c) `event_msg` — 런타임→UI/rollout [FACT live, **20종 실측**]
이전 추정 12종 → 실제 **20종** (150파일 109,280건 분석):
```
token_count (61%)         agent_message (28%)       patch_apply_end          user_message
task_started              task_complete             context_compacted        exec_command_end
web_search_end            turn_aborted              thread_name_updated      collab_waiting_end
item_completed            collab_agent_spawn_end    mcp_tool_call_end        thread_rolled_back
collab_close_end          agent_reasoning           error                    (+1)
```

실측 shape (주요):
```jsonc
// token_count — primary+secondary 둘 다 + plan_type
{ "type":"token_count",
  "info": null OR {                                    // 초기 null, 이후 채움
    "total_token_usage":{"input_tokens":N,"cached_input_tokens":N,
      "output_tokens":N,"reasoning_output_tokens":N,"total_tokens":N},
    "last_token_usage":{…같은 5필드…},
    "model_context_window":121600 },
  "rate_limits":{
    "limit_id":"codex", "limit_name":null,
    "primary":{"used_percent":75.0,"window_minutes":300,"resets_at":…},
    "secondary":{"used_percent":86.0,"window_minutes":10080,"resets_at":…},   // ★ 5분/주 2윈도우
    "credits":null, "plan_type":"pro", "rate_limit_reached_type":null } }

// task_started — config 운반 (model_context_window!)
{ "type":"task_started", "turn_id":"…",
  "started_at":…, "model_context_window":121600, "collaboration_mode_kind":"default" }

// task_complete — 3 필드 추가 (duration/TTFT)
{ "type":"task_complete", "turn_id":"…", "last_agent_message":"…",
  "completed_at":…, "duration_ms":…, "time_to_first_token_ms":… }

// turn_aborted (74건 실측)
{ "type":"turn_aborted", "turn_id":"…", "reason":"interrupted",
  "completed_at":…, "duration_ms":… }

// thread_rolled_back — 단 1필드
{ "type":"thread_rolled_back", "num_turns":7 }

// exec_command_end — 15필드 (parsed_cmd/source/stdout/stderr/exit_code/duration/…)
{ "type":"exec_command_end", "call_id":"…", "process_id":…, "turn_id":"…",
  "command":"…", "cwd":"…", "parsed_cmd":…, "source":"…",
  "stdout":"…","stderr":"…", "aggregated_output":"…", "exit_code":0,
  "duration":{…}, "formatted_output":"…", "status":"…" }

// agent_message — memory_citation 필드 보유
{ "type":"agent_message", "message":"…", "phase":"commentary",
  "memory_citation": null OR {…} }   // 1360/47999 non-null (메모리 인용)

// collab_agent_spawn_end — 멀티에이전트 lifecycle
{ "type":"collab_agent_spawn_end", "call_id":"…", "sender_thread_id":"…",
  "new_thread_id":"…", "new_agent_nickname":"…", "new_agent_role":"…",
  "prompt":"…", "model":"…", "reasoning_effort":"…", "status":"…" }

// context_compacted — 마커만
{ "type":"context_compacted" }

// error
{ "type":"error", "message":"…", "codex_error_info":"usage_limit_exceeded" }
```

### compacted — `{message, replacement_history[]}` [FACT]
`replacement_history`는 message 아이템 배열 (assistant엔 `phase:"final_answer"` 마커). compaction이 과거 히스토리를 요약본으로 치환한 기록.

### ★ stop_reason enum — 없음 [FACT, Cursor와 동형]
명시적 FinishReason 없음. 턴 종료 = `event_msg:task_complete`(표본 43회) + `token_count`로 구조적 전달. 결과 품질은 메모리층 `TaskOutcome = success|partial|uncertain`.

---

## ★★ C. 멀티 도구 사용 — 실측 정정 (가장 중요)

### 결론: **NATIVE multiple-function_call (option a)** — 메타툴 wrapper 아님

실측 시퀀스 (한 표본 파일):
```
REASON → MSG:assistant → FC:exec_command → FC:exec_command → FC:exec_command
       → FC:exec_command → FC:exec_command → out → out → out → out → out → REASON → …
```
→ **한 assistant 턴이 function_call 5개를 연속 emit**, 각자 독립 `call_id`, 이어서 output 5개. = OpenAI Responses API **네이티브 parallel tool calls**.

### `multi_tool_use.parallel`의 진실 [FACT, 실측으로 정정]
| 항목 | 실측 결과 |
|---|---|
| 코퍼스 grep "multi_tool_use" | 75,096회 — **그러나 전부 시스템 프롬프트 텍스트** ("Use `multi_tool_use.parallel` to parallelize tool calls and only this") |
| 실제 `function_call name=="multi_tool_use.parallel"` | **50개 rollout에서 0건** |
| 결론 | `multi_tool_use.parallel`은 **모델에게 병렬을 지시하는 프롬프트 문구**일 뿐, 실제 호출 메커니즘이 아님. 실제 병렬 = **네이티브 다중 function_call** |

**→ `docs/reviews-codex-agent/` 의 "(b) 메타툴 wrapper" 결론은 틀렸음. 실측 정답은 (a) 네이티브 다중 function_call.** 프롬프트가 `multi_tool_use.parallel`이라는 OpenAI 메타툴 *이름*을 언급하지만, 모델은 그것을 호출하는 게 아니라 그냥 여러 function_call을 한 턴에 낸다.

### envelope가 떨어지는 방식 (FACT)
```
모델 응답 (한 턴):
  reasoning
  message{role:assistant, phase:final_answer?}   (있을 수도)
  function_call{name, arguments, call_id}   ┐
  function_call{name, arguments, call_id}   ├─ N개 연속 (네이티브 병렬)
  function_call{name, arguments, call_id}   ┘
런타임:
  각 call → dispatch_tool_call{call_id} → function_call_output{call_id, output}
  N개 output append → 모델 재진입(tick-tock)
```
**디스패치 동시성/순서/실패-단락**은 rollout에 안 남음 (실행 로그가 아니라 결과 기록이라). output 순서는 call 순서와 일치(실측). 동시 실행 여부는 INFERENCE.

---

## D. 응답으로부터의 전체 분기 트리 (D1–D8)

handler 체인 [FACT, OTel]: `handle_responses → handle_output_item_done → handle_tool_call → dispatch_tool_call_with_code_mode_result{tool_name, call_id, aborted}`

| # | 분기 | 동작 |
|---|---|---|
| D1 | reasoning / output_text | 렌더만, 게이트 없음, 계속 |
| D2 | function_call ≥1 (네이티브 다중) | 각 call 디스패치 → `function_call_output{call_id,output}` → 모델 재진입 |
| D3 | custom_tool_call (apply_patch 등) | V4A patch 적용 → `custom_tool_call_output` + `event_msg:patch_apply_end` |
| D4 | 승인 게이트 | admissibility 5-stage(`visible? → sandbox/approval? → HITL? → repo-rule? → exec`) + HITL 4-tier(`hand-off-required\|always-confirm\|pre-approval-ok\|none`) + Guardian post-denial precedence |
| D5 | compaction | `token_count` 압박(20MB in-mem) → `context_compacted` + `compacted{replacement_history}` → `turn_context.summary` 연속성 → 계속 |
| D6 | 턴 종료 | `task_complete{turn_id,last_agent_message}` → closeout 정직성 rail → finish |
| D7 | 루프 재진입 | 새 Submission / follow-up 큐 |
| D8 | 에러/중단 | `interrupt`→`turn_aborted`. `thread_rolled_back`(체크포인트 되돌림). tool error는 status별 reroute([MODEL] 추론) |

---

## E. 저게 다야? — action space vs control

### 닫힌 것 (actuation 동사)
모델이 낼 수 있는 건 **광고된 도구 집합(23개) 중 하나 + response_item 7타입 중 하나**, 클라는 **D1–D8로만** 처리. 숨은 도구도 트리 밖 분기도 없음. → **"동사는 그 enum이 전부" = 참**.

### 안 닫힌 것 (통제 평면 — 프로토콜 밖)
| 통제 | 위치 |
|---|---|
| 어떤 도구/텍스트 고를지 | 서버 (`chatgpt.com/backend-api` 프롬프트 조립 + 모델 weights, **블랙박스**) |
| 실행 막/변형 | repo-rules + admissibility 5-stage + HITL 4-tier + Guardian |
| OS 레벨 강제 | **Seatbelt(macOS) / Landlock+seccomp(Linux)** — deny-default, 3모드 |
| 모델이 뭘 보나 | 서버 retrieval/rerank + `truncation_policy` (블랙박스) |

### enum 닫힘 ≠ 효과 닫힘 — 열린 게이트 2개
- **`exec_command`** — 1개 동사지만 임의 셸 (rm/curl/python -c…). 무한 효과 백도어.
- **`mcp`** — MCP 서버 임의 도구 동적 주입.

→ 진짜 효과 울타리는 enum 옆이 아니라 **아래** = sandbox(Seatbelt/Landlock) + approval×sandbox policy + repo-rules. (Cursor의 cursorsandbox+permission DSL과 구조 동형.)

---

## F. Codex ⇄ Cursor 대조 (흡수 관점)

| 축 | Cursor | Codex (실측) |
|---|---|---|
| transport | 커스텀 protobuf `StreamUnifiedChatWithTools` | **OpenAI Responses API (JSON)** |
| role | 2개 (HUMAN/AI), 시스템=explicit_context | **4개 (user/assistant/developer/system)**, 시스템=instructions |
| 도구결과 | 메시지 안 `tool_results` 필드 | **독립 `function_call_output{call_id,output}` response_item** |
| 멀티툴 | (분석상) native? | **네이티브 다중 function_call (실측 확정)**. `multi_tool_use.parallel`은 프롬프트 문구일 뿐 |
| patch | edit ToolCall | **`custom_tool_call(apply_patch)` + V4A grammar** |
| stop_reason | literal enum 없음 (구조적) | **동일** — task_complete/turn_aborted |
| 샌드박스 | cursorsandbox (Seatbelt/Bubblewrap) | **Seatbelt/Landlock** (동형) |
| 통제 모델 | 서버+native+hook 3평면 분산 | **서버+native+repo-rules/HITL 3평면 (동형)** |

---

## G. 흡수 시사점 (quanta v3)

1. **action space 계약(enum+분기트리)은 베낄 수 있음** — v3 ToolRegistry로 이미 닫힘.
2. **통제는 한 곳 아님** — 서버(두뇌)+샌드박스(OS)+정책(rule/HITL) 3평면. v3도 admissibility gate + FS jail + repo-rules로 동형 (이미 구조적으로 맞음).
3. **`exec`/`mcp` 열린 게이트 밑에 sandbox+permission 필수** — v3가 심볼릭링크 탈옥 deny를 P0로 올린 이유와 동일. Codex Seatbelt 프로파일은 `~/.claude/.../memory/codex-seatbelt-sandbox-profile`에 verbatim 보존 → 데스크톱 진출 시 copy-paste.
4. **role 4-체계(OpenAI 표준)가 v3에 친화적** — v3도 user/assistant/system/tool. Codex 쪽이 흡수 용이.
5. **멀티툴은 네이티브 다중 tool_use가 정답** — v3 streaming-dispatch가 이미 한 턴 다중 tool_use 처리(병렬 안전성 플래그 보유). 메타툴 wrapper 흉내낼 필요 없음. ✅ 이미 올바른 방향.
6. **`function_call_output`은 `output` 단일 필드** — 풍부한 status oneof(Cursor식)는 불필요. v3 ToolResult.ok + output로 충분.

---

## 정정 로그 (forensic docs → live 실측)
- `sandbox_policy`: string → **`{type:…}` 객체**
- `function_call_output`: `{call_id,status,content}` → **`{call_id,output}`**
- 멀티툴: "(b) `multi_tool_use.parallel` 메타툴" → **"(a) 네이티브 다중 function_call"** (메타툴 실호출 0건)
- `apply_patch`: function_call → **`custom_tool_call`(status+input)**
- `agent_message`/`message`에 **`phase`** 필드 존재 (commentary / final_answer)
- top-level type에 **`compacted`** 추가 (5종: session_meta/turn_context/response_item/event_msg/compacted)
- `event_msg:thread_rolled_back` 실측 확인
- `session_meta` 9필드 → **12필드** (+`forked_from_id`, `thread_source`, `dynamic_tools[]`)
- `base_instructions` string → **`{text: ~12950자}`** 객체 (코어 시스템프롬프트 13섹션)
- **도구 스키마 "전부 서버전용" → `dynamic_tools[]`가 session_meta에 full inputSchema 박힘** (app/MCP/automation류)
- 시스템 프롬프트 = base_instructions.text 1개가 아니라 **3층**: ①base_instructions(코어) ②developer 7블록(permissions/app-context/memory/collaboration_mode/personality_spec/skills/plugins, 조건부) ③user앞 AGENTS.md+environment_context
- 연속 턴 user message에 **IDE context(active file/open tabs) 매 턴 재주입** 실측

> 출처: `~/.codex/archived_sessions/rollout-2026-05-21T03-16-29-…ca.jsonl` 외 50+ 파일 직접 파싱.
> 이전 추론본: `docs/reviews-codex-agent/{turn-context-and-runtime-interface,may-21-codex-desktop-build-2867-round-3,-round-4}.md`.
