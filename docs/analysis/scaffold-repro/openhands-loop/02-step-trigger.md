# OpenHands agent-sdk — step / loop / LLM 발사(trigger) 메커니즘 코드 분석

분석 소스: `/Users/songmin/Documents/code-new/competitor-scaffolds/openhands-agent-sdk/`
모든 file:line 은 위 루트 기준 `openhands-sdk/openhands/...` 상대경로.

핵심 결론을 먼저 박아두면: **OpenHands 의 agent loop 에는 "reproduce 먼저", "탐색 먼저" 같은 phase 분기가 코드상 존재하지 않는다.** 한 step 은 (1) pending action 처리, (2) blocked message 체크, (3) condensation, (4) LLM 호출 1회, (5) 응답 타입 분기 — 그게 전부다. 무엇을 reproduce 할지/탐색할지/코딩할지의 "시점"은 전적으로 매-step LLM 이 어떤 tool_call 을 뱉느냐로 결정된다. 코드는 그 결정을 phase-aware 하게 강제하지 않는다 (입증은 §7).

---

## 1. step() 한 번의 전체 흐름

진입점: `Agent.step()` — `agent/agent.py:542`. 동기 버전 기준으로 따라가고, 차이는 §1.6 에서 비교.

### 1.1 pending action 우선 실행 (agent.py:548-558)

```
pending_actions = ConversationState.get_unmatched_actions(state.events)   # agent.py:551
if pending_actions:
    self._execute_actions(conversation, pending_actions, on_event)        # agent.py:557
    return                                                                # 이 step 은 LLM 안 부름
```

confirmation mode 에서 이전 step 이 action 을 만들어만 두고 실행 보류한 경우, 이번 step 은 LLM 을 호출하지 않고 보류된 action 을 먼저 집행하고 곧장 return 한다. 즉 한 step = 항상 LLM 호출 1회가 아니다. "보류 action 실행만 하는 step" 이 존재한다.

### 1.2 blocked user message 체크 (agent.py:562-572)

`last_user_message_id` 가 UserPromptSubmit hook 에 의해 차단됐으면 status 를 `FINISHED` 로 두고 return (agent.py:564-567). 정상 경로면 통과.

### 1.3 메시지 구성 (agent.py:576-585)

```
_messages_or_condensation = prepare_llm_messages(
    state.view, condenser=self.condenser, llm=self.llm)                   # agent.py:576
```

`prepare_llm_messages` (utils.py:547) 가 무엇을 LLM 에 보낼지를 결정한다 — §4 에서 상세. 요지: **state.view 에 들어있는 전체 LLMConvertible 이벤트(system prompt + 그동안의 모든 action/observation/message)를 통째로 메시지 리스트로 변환**한다. 부분 슬라이스가 아니라 (condenser 가 끼지 않는 한) 전체 history 다.

반환이 `Condensation` 이면 condensation 이벤트만 emit 하고 return (agent.py:581-583) — 이 step 도 LLM 을 안 부른다.

### 1.4 LLM 호출 — make_llm_completion (agent.py:593-598)

```
llm_response = make_llm_completion(
    self.llm,
    _messages,                                  # 위에서 만든 전체 history 메시지
    tools=list(self.tools_map.values()),        # 매번 전체 tool set 전달
    on_token=on_token,
)
```

`make_llm_completion` (utils.py:602) 이 실제 LLM 호출. §4.2 참조. 여기서 한 step 당 정확히 LLM 호출 1회가 발생한다 (예외/condensation 으로 빠지지 않은 경우).

예외 처리 3종 (agent.py:599-651):
- `FunctionCallValidationError` → user role 에러 메시지를 history 에 넣고 return (다음 step 에서 모델이 교정)
- `LLMMalformedConversationHistoryError` → condenser 있으면 `rebuild_view()` 후 `CondensationRequest()` emit, 없으면 raise
- `LLMContextWindowExceedError` → condenser 있으면 `CondensationRequest()` emit, 없으면 raise

### 1.5 응답 타입 분기 (agent.py:653-674)

```
message = llm_response.message                  # agent.py:654
response_type = classify_response(message)      # agent.py:655 → response_dispatch.py:53

match response_type:
    case LLMResponseType.TOOL_CALLS:    self._handle_tool_calls(...)        # agent.py:658-661
    case LLMResponseType.CONTENT:       self._handle_content_response(...)  # agent.py:662-665
    case REASONING_ONLY | EMPTY:        self._handle_no_content_response(...) # agent.py:666-674
```

`classify_response` (response_dispatch.py:53-77) 는 순수 함수. 우선순위 first-match:
1. `message.tool_calls` 있으면 → `TOOL_CALLS` (response_dispatch.py:64-65)
2. 비어있지 않은 TextContent 있으면 → `CONTENT` (response_dispatch.py:67-68)
3. reasoning 만 있으면 → `REASONING_ONLY` (response_dispatch.py:70-75)
4. 아무것도 없으면 → `EMPTY` (response_dispatch.py:77)

분기별 의미:
- **TOOL_CALLS**: tool 실행 후 status 를 건드리지 않음 → **루프 계속** (§3).
- **CONTENT**: `_handle_content_response` 가 message 를 emit 하고 `execution_status = FINISHED` 로 둠 (response_dispatch.py:294) → **루프 종료, 유저 입력 대기**. 즉 모델이 tool 없이 그냥 텍스트로 답하면 그게 "턴 종료" 신호다.
- **REASONING_ONLY / EMPTY**: message emit 후 `_send_corrective_nudge` (response_dispatch.py:316, 340-365) 로 "tool 을 써서 진행하라"는 user 메시지를 history 에 주입 → status 안 건드림 → **루프 계속**(다음 step 에서 모델이 재시도).

### 1.6 비동기 버전 astep() 차이 (agent.py:677-816)

구조 동일. 차이는 (a) `aprepare_llm_messages` / `amake_llm_completion` 사용 (agent.py:717, 733), (b) TOOL_CALLS 분기에서 `_ahandle_tool_calls` 호출 (agent.py:801) → tool 실행을 thread 로 돌려 event loop 비점유. CONTENT/REASONING/EMPTY 핸들러는 동기와 동일 함수 공유 (agent.py:804-816). 분기 로직·종료 의미는 step() 과 byte-for-byte 동등.

---

## 2. ASCII 시퀀스 — step loop

```
 run()  conversation/impl/local_conversation.py:1199
  │  status ∈ {IDLE,PAUSED,ERROR,STUCK} → RUNNING        :1216-1222
  │  iteration = 0                                         :1224
  ▼
 ┌───────────────────────── while True ───────────────────────────┐  :1227
 │ with state-lock:                                       :1229     │
 │   PAUSED / STUCK ? ───────────────► break              :1233-1237│
 │   FINISHED ? ──► run_stop hook ──► (denied→RUNNING,continue)     │
 │                                  └─(allowed)──► break   :1240-1267│
 │   stuck_detector.is_stuck() ? ──► STUCK, continue      :1270-1278│
 │   WAITING_FOR_CONFIRMATION → RUNNING                   :1281-1287│
 │                                                                  │
 │   ┌─ agent.step(self, on_event, on_token) ─────────────┐ :1294   │
 │   │  agent/agent.py:542                                 │        │
 │   │   pending actions? ─► _execute_actions; return      │ :551   │
 │   │   prepare_llm_messages(state.view)                  │ :576   │
 │   │     └► Condensation? emit; return                   │ :581   │
 │   │   make_llm_completion(llm, msgs, ALL tools)         │ :593   │
 │   │   classify_response(message)                        │ :655   │
 │   │     ├ TOOL_CALLS  → _handle_tool_calls              │ :658   │
 │   │     │    _get_action_event* → ActionEvent(s) emit   │        │
 │   │     │    _execute_actions → ObservationEvent(s) emit│        │
 │   │     │    finalize: FinishTool? → status=FINISHED    │        │
 │   │     ├ CONTENT     → emit MessageEvent; status=FINISHED      │
 │   │     └ EMPTY/REASON→ emit; corrective nudge (user msg)│       │
 │   └──────────────────────────────────────────────────────┘      │
 │   iteration += 1                                       :1299     │
 │   WAITING_FOR_CONFIRMATION ? ──► break                 :1309-1313│
 │   budget exceeded ? ──► error; break                   :1315-1321│
 │   iteration ≥ max_iteration_per_run ? ──► error; break :1323-1345│
 └──────────────────────────── loop ──────────────────────────────┘
```

주목: 루프는 FINISHED 를 **다음 iteration 의 맨 위에서** 검사한다 (`:1240`). step() 안에서 FINISHED 로 세팅돼도 그 자리에서 break 하지 않고 (`:1302-1308` 의 주석 명시), 한 바퀴 더 돌아 lock 잡고 검사 → 그 사이 들어온 concurrent user message 를 잃지 않기 위함.

---

## 3. 무엇이 step 을 반복 트리거하나 (run loop · 종료조건)

step() 을 루프로 부르는 주체는 `LocalConversation.run()` — `conversation/impl/local_conversation.py:1199`. (async 버전 `arun()` 은 `:1375` 부근, `agent.astep()` 호출, 구조 동일.) `condense()` (`:2167`) 도 step 을 부르지만 단 1회 (condensation 처리용)이지 루프가 아니다.

루프 본체는 `while True:` (`:1227`). step 을 다시 부르냐/멈추냐는 **execution_status** 단일 변수가 좌우한다 (`ConversationExecutionStatus`). 반복 트리거 = "step 이 status 를 종료계열로 바꾸지 않았다" 는 사실 그 자체. 종료/탈출 조건 정리:

| 조건 | 위치 | 효과 |
|---|---|---|
| status PAUSED/STUCK | :1233-1237 | break |
| status FINISHED (+ stop hook 허용) | :1240-1267 | break |
| stuck_detector.is_stuck() | :1270-1278 | STUCK 세팅, continue → 다음 바퀴서 break |
| WAITING_FOR_CONFIRMATION | :1309-1313 | break (유저 승인 대기) |
| budget 초과 | :1315-1321 | error 이벤트, break |
| iteration ≥ max_iteration_per_run | :1323-1345 | error 이벤트, break |

`max_iteration_per_run` 기본값 = **500** (`:170` 의 생성자 디폴트; 필드 선언 `:140`). 이게 하드 상한 안전판.

**"agent 가 stop 을 결정"하는 정상 경로 두 가지**:
1. 모델이 `FinishTool` (name `"finish"`, tool.py:241 의 `_camel_to_snake` 로 도출) 을 호출 → `_ActionBatch.finalize` 가 `mark_finished` 콜백으로 `execution_status = FINISHED` (agent.py:500-504, 281-282). 다음 iteration 상단에서 break.
2. 모델이 tool 없이 그냥 텍스트만 답함 → `_handle_content_response` 가 `FINISHED` (response_dispatch.py:294).

즉 **종료는 model-driven** (finish tool 또는 plain content) 이거나 **guard-driven** (max iter / budget / stuck / pause). "특정 단계를 N번 했으니 종료" 같은 phase counter 종료는 없다.

---

## 4. tool_call dispatch — observation 이 다음 LLM 호출에 어떻게 들어가나

### 4.1 _handle_tool_calls (response_dispatch.py:187-230)

1. `message.content` 중 TextContent 만 추려 `thought_content` 로 보존 (response_dispatch.py:202).
2. `message.tool_calls` 를 순회하며 각각 `_get_action_event` (agent.py:983) 로 **ActionEvent** 생성 (response_dispatch.py:206-219). reasoning/thinking 메타는 첫 tool_call(i==0)에만 부착 (response_dispatch.py:213-218). `_get_action_event` 내부에서 인자 파싱·정규화·검증 후 `on_event(action_event)` 로 history 에 ActionEvent 적재 (agent.py:1117).
3. confirmation 필요하면 여기서 return (response_dispatch.py:224-225) — action 은 emit 됐지만 미실행(=pending). 다음 run() 호출 시 §1.1 경로로 집행.
4. 아니면 `_execute_actions` (agent.py:478) 로 실제 실행 (response_dispatch.py:227-228).

### 4.2 _execute_actions → observation 적재 (agent.py:478-505)

- `_ActionBatch.prepare` (agent.py:159) 가 FinishTool 뒤 잘림처리(`_truncate_at_finish`, agent.py:131-157), blocked action 분리, `ParallelToolExecutor.execute_batch` 로 실행 (agent.py:181).
- 각 tool 실행은 `_execute_action_event` (agent.py:1120) — `tool(action_event.action, conversation)` 호출 (agent.py:1154), 결과를 **ObservationEvent** 로 래핑 (agent.py:1170-1176). ValueError 면 `AgentErrorEvent` (agent.py:1163-1168).
- `batch.emit(on_event)` (agent.py:494 → 232-249) 가 ObservationEvent/AgentErrorEvent 를 원래 action 순서대로 history 에 emit.
- `batch.finalize` (agent.py:495 → 251-282): FinishTool 있었으면 iterative-refinement 체크 후 없으면 `mark_finished` → FINISHED.

**다음 LLM 호출로의 연결 고리** — 핵심: tool 실행은 status 를 RUNNING 으로 유지(FinishTool 아닌 한)하므로 run loop 은 다음 iteration 에서 step() 을 또 부른다. 그 step 의 `prepare_llm_messages(state.view)` (agent.py:576) 가 방금 적재된 ObservationEvent 까지 포함한 **전체 history 를 다시 메시지로 변환**한다. ObservationEvent 는 `to_llm_message()` 에서 `role="tool"` + `tool_call_id` 로 직렬화 (event/llm_convertible/observation.py:21-26) → 직전 assistant tool_call 과 짝지어진 tool result 로 모델에 다시 들어간다. **즉 observation 의 재주입은 별도 배선 없이 "history 전체를 매 step 다시 보낸다"는 구조의 자연스러운 귀결**이다.

### 4.3 make_llm_completion 실구현 (utils.py:602-646)

```
if llm.uses_responses_api():
    return llm.responses(messages, tools or [], include=None, store=False,
                         add_security_risk_prediction=True, on_token=on_token)  # :632
else:
    return llm.completion(messages, tools or [],
                          add_security_risk_prediction=True, on_token=on_token) # :641
```

- messages = §4.2 가 만든 전체 history 변환물.
- tools = `list(self.tools_map.values())` (agent.py:596) — 매 호출마다 전체 tool 셋.
- `add_security_risk_prediction=True` (utils.py:637, 644) 가 항상 tool schema 에 `security_risk` 파라미터를 끼워넣는다. docstring (utils.py:619-626) 명시: analyzer 비활성이어도 schema 일관성 위해 항상 노출, 검증은 런타임에 `_extract_security_risk` (agent.py:861) 가 동적으로. analyzer 없으면 UNKNOWN 으로 무시 (agent.py:877-878). (질문의 ":447-448" 은 agent.py 의 init_state 주석으로, security_risk 노출이 make_llm_completion 책임임을 가리킴 — 실제 주입은 utils.py:637/644.)
- 응답 파싱 보조: `normalize_tool_call` (utils.py:449) 은 LLM 이 뱉은 tool 이름/인자를 정규화(legacy alias `bash→terminal` 등 utils.py:213-222, 미등록명만 적용 utils.py:466, file_editor command 추론 utils.py:507-524, 깨진 이름 XML 파편 복구 utils.py:228-240). `parse_tool_call_arguments` (utils.py:272) 는 JSON 파싱 + 실패 시 control-char sanitize 폴백 (utils.py:276-278). 둘 다 `_get_action_event` (agent.py:1010, 1013) 에서 호출. `fix_malformed_tool_arguments` (utils.py:93) 는 GLM/minimax 류 모델의 string-encoded list/chunked-str 보정 (agent.py:1037 호출).

---

## 5. 이벤트 모델 — history 가 LLM context 가 되는 경로

모든 LLM-가시 이벤트는 `LLMConvertibleEvent` 상속, `to_llm_message()` 구현 (event/base.py:58-63). 매 step 이 보는 "context" = `state.view.events` (LLMConvertibleEvent 리스트) → `events_to_messages` 로 변환 (event/base.py:90-138).

- **SystemPromptEvent** (event/llm_convertible/system.py:12): `init_state` (agent.py:443-454) 에서 **대화당 정확히 1회** emit. system prompt(static) + dynamic_context + tools 를 담음. init_state 는 SystemPromptEvent 가 prefix(index 0/1)에 이미 있으면 재추가 스킵 (agent.py:408-415) — 재개 대화 멱등성.
- **MessageEvent**: user/agent 의 일반 텍스트 턴. agent content-only 응답 (response_dispatch.py:326), corrective nudge user 메시지 (response_dispatch.py:350-364), malformed-call 에러 user 메시지 (agent.py:601-607) 등.
- **ActionEvent** (event/llm_convertible/action.py:24): tool_call 1건 = role="assistant" + tool_calls. 같은 `llm_response_id` 를 가진 연속 ActionEvent 들은 `events_to_messages` 가 lookahead 로 묶어 (event/base.py:102-126) `_combine_action_events` (event/base.py:156-176)로 단일 assistant 메시지(parallel tool_calls)로 재구성.
- **ObservationEvent** (event/llm_convertible/observation.py:31): role="tool" + tool_call_id (observation.py:21-26). action 과 짝지어 모델에 결과 전달.

`events_to_messages` (event/base.py:90-138) 가 이 이벤트열을 OpenAI 메시지열로 펼친다. 연속 plain-user 메시지는 병합 (event/base.py:120-123, 141-153). **이 변환은 매 step 새로 일어나므로, history 에 append 된 모든 것이 다음 LLM 호출의 context 가 된다** — 누적 append-only 모델.

---

## 6. 한 task 의 전체 turn 시퀀스 (코드상 전개)

```
init_state          : SystemPromptEvent 1회 emit                    agent.py:443-454
                       (+ 유저 task 가 user MessageEvent 로 history 진입)
run() while True ┐
  step #1        │   prepare(view=[system, user-task])              agent.py:576
                 │   LLM →  tool_calls (e.g. terminal "ls")         agent.py:658
                 │   ActionEvent emit + ObservationEvent emit       agent.py:1117/1170
                 │   status RUNNING 유지 → 루프 계속
  step #2        │   prepare(view=[system, user, act1, obs1])       (obs1 재주입)
                 │   LLM →  tool_calls (file_editor view / str_replace …)
                 │   …
  step #k        │   LLM →  finish tool                             agent.py:142,500
                 │   finalize → status=FINISHED                     agent.py:281
  next iter top  │   FINISHED 검사 → (stop hook) → break            local_conversation.py:1240,1267
                 ┘
```

- system 은 단 1회. 그 뒤는 `[LLM → tool_calls → observations]` 의 무제한 반복이고, 매 반복마다 직전까지의 전체 history 가 재전송된다.
- 종료는 §3 대로: finish tool / content-only / (guard: max iter, budget, stuck, pause).
- 중간에 EMPTY/REASONING_ONLY 가 나오면 corrective nudge 가 user 메시지로 끼어들고 루프는 계속 (response_dispatch.py:316).

---

## 7. 적대 질문 — reproduce/탐색/코딩 "시점"이 하드코딩인가?

**판정: 코드 레벨에 reproduce-first / explore-first 류의 강제 phase 분기는 없다. 시점은 순전히 매-step 모델의 자율 tool 선택이다.** 입증:

1. **step() 에 phase state 가 없다.** `step` (agent.py:542-674) 의 분기는 오직 (pending-action / blocked-msg / condensation / response_type) 4종뿐. "지금이 reproduce 단계인지" 를 담는 변수도, 그걸로 가르는 if 도 없다. response_type 분기 (agent.py:657-674) 는 tool_call vs content vs empty 일 뿐, 어떤 tool 인지로 가르지 않는다.

2. **run loop 에 phase 카운터가 없다.** `run()` (local_conversation.py:1227-1345) 의 분기는 execution_status + iteration(상한용) + budget + stuck 뿐. "탐색 N회 후 코딩" 같은 단계 전이 로직 부재.

3. **tool 선택은 모델 출력에서 그대로 온다.** `_get_action_event` (agent.py:983-1118) 는 `tool_call.name` 을 정규화(normalize_tool_call)만 하고 `tools_map` 에서 찾아 실행 ActionEvent 로 변환할 뿐, "이 시점엔 이 tool 만 허용" 같은 게이팅이 없다. tool 셋은 매 step 전부 노출 (agent.py:596). 어떤 순서로 무엇을 부를지는 100% LLM 결정.

4. **유일한 "특별취급" tool 은 finish 뿐, 그것도 순서강제가 아니라 종료신호.** FinishTool 만 `_truncate_at_finish` (agent.py:131-157) 와 finalize 의 FINISHED 전이 (agent.py:281-282) 로 특별취급된다. ThinkAction/FinishAction 은 confirmation 면제 (agent.py:830-834). 그러나 이는 "언제 reproduce 하라"가 아니라 "finish 가 나오면 멈춰라" 일 뿐.

5. **phase 같은 서술은 system prompt 의 자연어 가이드로만 존재.** `system_prompt.j2` 의 `<PROBLEM_SOLVING_WORKFLOW>` (system_prompt.j2:60-75) 가 EXPLORATION→ANALYSIS→TESTING→IMPLEMENTATION→VERIFICATION 를 권하고, "bug fix 는 수정 전에 검증 테스트를 만들라"(system_prompt.j2:64)까지 적는다. **하지만 이것은 모델에게 보내는 프롬프트 텍스트이지 실행 코드의 분기가 아니다.** 모델이 이 순서를 어길 수도, 따를 수도 있다 — 코드는 그것을 검사·강제하지 않는다. 즉 reproduce-first 는 prompt-level soft guidance 이지 loop-level hard gate 가 아니다.

**반증 시도 결과**: loop/step/dispatch 어디에도 "reproduce 했는가?", "테스트부터 작성했는가?" 를 검사해 분기/차단하는 코드는 발견되지 않음. tool 이름 기반 게이팅은 finish 의 종료처리 외엔 없음 (normalize_tool_call 의 alias 는 이름교정이지 순서강제 아님). 따라서 OpenHands 의 작업 순서는 **모델 자율 + prompt 권고**의 조합이며, harness 가 단계를 못박지 않는다.

---

## 10줄 요약

1. `Agent.step()` (agent.py:542) 한 번 = pending-action 처리 → blocked-msg 체크 → `prepare_llm_messages`(전체 history 변환) → `make_llm_completion` LLM 1회 → response_type 분기. LLM 호출은 step 당 최대 1회.
2. step 을 루프로 부르는 건 `LocalConversation.run()` 의 `while True` (local_conversation.py:1227); 반복/종료는 `execution_status` 단일 변수가 좌우.
3. 정상 종료 = 모델이 `finish` tool 호출(→FINISHED, agent.py:281) 또는 tool 없는 content-only 응답(→FINISHED, response_dispatch.py:294); guard 종료 = max_iteration_per_run(기본 500)·budget·stuck·pause.
4. `make_llm_completion` (utils.py:602) 는 전체 history 메시지 + 전체 tool 셋 + `add_security_risk_prediction=True` 로 `llm.completion`/`llm.responses` 호출.
5. tool 실행은 `_handle_tool_calls`→`_execute_actions`→`_execute_action_event` 가 ObservationEvent(role="tool", observation.py:21-26) 로 만들어 history 에 emit.
6. observation 재주입은 별도 배선 없음 — 다음 step 의 `prepare_llm_messages(state.view)` 가 append-only history 를 통째로 다시 메시지화하는 구조의 부산물.
7. 이벤트 모델: SystemPromptEvent 1회(agent.py:443) + ActionEvent/ObservationEvent/MessageEvent 누적; `events_to_messages` (event/base.py:90) 가 매 step OpenAI 메시지열로 변환.
8. response 분기는 tool_calls/content/empty 3종(response_dispatch.py:53)일 뿐, "어떤 tool 인지"로 가르지 않음; EMPTY/REASONING 이면 corrective nudge user 메시지 주입 후 루프 지속.
9. **적대 판정**: step/loop/dispatch 어디에도 reproduce-first·explore-first phase 분기 없음. tool 선택 순서는 100% 매-step 모델 자율; harness 가 단계를 못박지 않음.
10. 단계 순서를 권하는 `<PROBLEM_SOLVING_WORKFLOW>`(system_prompt.j2:60-75)는 모델에게 보내는 prompt 자연어일 뿐, 실행 코드의 hard gate 가 아니다 — soft guidance vs loop-level enforcement 의 구분이 핵심.
