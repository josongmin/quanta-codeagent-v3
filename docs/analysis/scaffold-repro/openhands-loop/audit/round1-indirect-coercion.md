# Round 1 — 적대 어딧: "OpenHands는 reproduce를 0% 강제, 시점은 순수 모델 자율" 반증 시도

분석 소스 루트: `/Users/songmin/Documents/code-new/competitor-scaffolds/openhands-agent-sdk/`
모든 file:line은 그 트리 기준. 검증된 코드만 인용. 추측 표기.
대상 결론(docs 01~05 종합): "reproduce를 코드로 강제하는 분기 0%, reproduce 시점은 순수 모델 자율(prompt soft-guidance만)."

임무: 이 "0% 강제 / 순수 자율" 주장을 **깨라.** 숨은 간접 강제/유도 채널 탐색.

---

## 0. 판정 요약 (먼저)

결론은 **부분적으로 깨진다.** 정확히는:

- **"0% hard-gate"는 *default config 한정*으로만 참이다.** 코드에는 finish를 거부하고 작업을 강제 재개시키는 **진짜 loop-level hard gate가 존재한다**(`CriticMixin._check_iterative_refinement`, `agent.py:270-282`). docs 02/04가 "phase 분기·finish 게이트 없음"이라 단언한 것은 **critic 채널을 누락한 over-claim**이다. 다만 이 게이트는 `critic=None`(default, `base.py:419-420`, "EXPERIMENTAL")이라 **기본 OFF**이고, shipped critic 어느 것도 *reproduce/test*를 검사하지 않는다(non-empty patch + FinishAction만, `agent_finished.py:49-65`).
- 따라서 reproduce **특정** 행동에 한정하면 "0% 강제"는 여전히 참(default·opt-in 모두). 그러나 일반 "작업 완료 검증"에 대한 hard-gate는 코드에 분명히 **존재하되 default-OFF**. 정밀 표현은 **"reproduce는 0% hard-gate(default+opt-in 전부), 일반 verify는 default-OFF인 critic hard-gate 존재, 그리고 다층 soft-steering 존재"**.
- few-shot 간접강제(#1): **native FC(Claude/GPT-5)에선 영향 0이 확정**된다(아래 §1, config로 뒤집힐 수 있으나 어떤 preset도 안 뒤집음). docs 04의 "미주입" 주장 **유지**.
- terminal `:42` 가드(#2): reproduce 강제가 **아니다.** Python-literal 오입력 교정기일 뿐(§2). docs 03의 "reproduce 행동 강제" 프레이밍은 **over-claim → 정정**.
- condenser preserve(#3): test-우선 *편향*은 맞으나 condenser는 **default None**(§3). soft-bias이되 inert by default.
- finish tool(#4): finish description은 verify/repro를 **강제하지 않음**(§4). 단 finish는 critic 게이트의 *발화 지점*이라 간접 연결됨.

---

## 1. few-shot 간접강제 (#1) — native FC 영향 0 확정, 단 config-gated

### 1.1 주입 조건 직독 (`fn_call_converter.py:398`)

```python
def _convert_user_to_non_fncall(content, tools, is_first_user_message,
                                add_in_context_learning_example):
    if is_first_user_message and add_in_context_learning_example:      # :398
        example = IN_CONTEXT_LEARNING_EXAMPLE_PREFIX(tools)            # :399
        if example:
            content = _wrap_content_with_example(...)                 # :401
    return {"role": "user", "content": content}
```

이 함수 자체가 **non-fncall 변환기 내부**다. 진입 게이트를 위로 추적:

- `non_native_fc.py:33-36` `should_mock_tool_calls = bool(tools) and not self.native_tool_calling`.
- `llm.py:1060` `use_mock_tools = self.should_mock_tool_calls(cc_tools)`, `:1066` `pre_request_prompt_mock(...)` → `non_native_fc.py:51` `convert_fncall_messages_to_non_fncall_messages(...)` → 위 `:398` 도달.
- 즉 **`native_tool_calling=True`면 `_convert_user_to_non_fncall`은 호출조차 안 된다** → few-shot 주입 0.

### 1.2 native_tool_calling 기본값·자동변경 여부

- `llm.py:413-416` `native_tool_calling: bool = Field(default=True, ...)`. **기본 True.**
- `_init_model_info_and_caps()` (`llm.py:2094-2160+`) 전수 확인: `max_input/output_tokens`, context window만 다룸. **`native_tool_calling`을 모델 capability로 자동 flip하는 코드 없음** (grep `native_tool_calling` 히트 = `:413/:1047/:2366` 3곳뿐, 전부 *읽기*).
- 어떤 preset도 안 끔: `grep native_tool_calling` repo 전체에서 llm.py/non_native_fc.py/test 외 히트 0건.

→ **Claude/GPT-5를 default로 띄우면 few-shot은 확정적으로 미주입.** docs 04의 "native FC엔 영향 0" 주장은 **코드로 확정 유지**.

### 1.3 추가 게이트 (이중 안전): add_iclex

`non_native_fc.py:48-50`: `add_iclex = not any(s in self.model for s in ("openhands-lm","devstral","nemotron"))`. 즉 비-native라도 이 3 모델군엔 또 미주입. few-shot은 **비-native FC ∧ 비-(openhands-lm/devstral/nemotron) ∧ 첫 user 메시지**라는 3중 교집합에서만 발화.

### 1.4 적대적 반론과 그 한계

반론: "`native_tool_calling`은 *config 필드*이지 모델의 물리적 사실이 아니다. 사용자가 Claude에 `native_tool_calling=False`를 주면 few-shot이 들어가고, 그 few-shot은 build-run-debug 루프(실행→로그→고침→재실행)를 시연한다 → 간접 강제 채널 부활."

한계(반론 무력화): (a) default가 True이고 어떤 shipped preset도 안 끄므로 **표준 경로에선 0**. (b) 설사 들어가도 시연 내용은 docs 04 §3-1 분석대로 *reproduce/test-first가 아니라* pip-install 환경 디버그(`fn_call_examples.py`의 flask/ModuleNotFoundError 리터럴) — reproduce를 시연하지 않음. 즉 채널이 켜져도 *reproduce* 유도력은 약함. 두 번째 call site `fn_call_converter.py:687` `_strip_in_context_example`은 **역방향(제거)**이라 주입 경로 아님.

**#1 판정: docs 04 유지.** few-shot은 native FC에 영향 0(config-gated이나 default·전 preset에서 OFF), 켜져도 reproduce 시연 아님.

---

## 2. tool-description 강제 (#2) — terminal `:42`는 reproduce 강제 아님

### 2.1 `:42` 가드 발화 조건 직독

`terminal/definition.py:37-52` `_LITERAL_ARG_HINT_TEMPLATE`("Write a script first with `file_editor` ...")는 `impl.py:549-568`에서만 반환된다:

```python
if not action.is_input:                                       # impl.py:549
    literal_kind = looks_like_python_literal_argument(action.command)  # :550
    if literal_kind is not None:                              # :551
        return TerminalObservation.from_text(_LITERAL_ARG_HINT_TEMPLATE..., is_error=True)  # :560-568
```

`looks_like_python_literal_argument` (`definition.py:55-83`)는 `command`가 `[{`, `["`, `[[x`, `{"` 같은 **Python/JSON 리터럴**로 시작할 때만 reason을 반환. 그 외 모든 정상 shell 명령엔 `None` → 가드 미발화 → 정상 실행.

### 2.2 이게 reproduce를 간접 강제하나? — **아니다**

- 이 가드는 "버그를 재현하라"와 **무관**하다. 모델이 `terminal(command=[{...}])`처럼 **dict/list를 shell 자리에 잘못 넣은 오입력**을 교정해 "그건 `file_editor`로 스크립트 만들어 실행하라"고 되돌릴 뿐이다.
- "Write a script first"의 "first"는 *reproduce 워크플로의 선행*이 아니라 *"shell에 literal 넣지 말고 스크립트로 우회"*라는 좁은 syntax 교정 의미.
- 발화 트리거가 **command 문자열의 첫 1~2바이트 패턴**이므로 reproduce 의도/단계와 0 상관.

→ docs 03이 이를 "tool이 reproduce 행동을 강제하는 사례"로 든 것은 **over-claim**. 정정: *malformed-argument 교정기*이지 reproduce/test 워크플로 steering 아님. (docs 03 본문도 "흔한 실패를 tool 계층이 교정"이라 정확히 적었으나, "reproduce 행동을 tool이 강제하는 사례"라는 라벨은 부정확.)

### 2.3 다른 tool description의 워크플로 강박 여부

- `file_editor` "Verify the directory ... view the parent directory exists"(`definition.py:169-172`), "EXACT MATCHING"(`:181`) — 이는 *편집 안전*(broken-state 회피) 지침이지 reproduce/test 유도 아님.
- `task_tracker` "Never mark done when: Test suites are failing / Implementation remains incomplete"(`definition.py:388-392`) — **이건 진짜 test-우선 soft-bias**다. "테스트 실패 중엔 done 찍지 마라"는 *간접 test 게이트*. 단 (a) description 텍스트(=프롬프트)일 뿐 코드 검사 아님, (b) `task_tracker` 자체가 default preset엔 있으나(`preset/default.py:52-64`) 모델이 안 쓰면 무력. soft-steering 1채널로 계상.

**#2 판정: terminal `:42`는 reproduce 강제 아님(정정). 단 `task_tracker` description의 "테스트 실패 중 done 금지"는 별개의 test-우선 soft-bias로 새로 식별.**

---

## 3. condenser preserve 강제 (#3) — test-우선 bias 맞음, 단 default OFF

- `summarizing_prompt.j2:16-21`이 `TESTS`(실패 케이스·에러·출력)/`CHANGES`/`VERSION_CONTROL_STATUS`를 요약에 **강제 보존**. 이는 long-horizon에서 "테스트 상태를 항상 살린다"는 **구조적 test-우선 편향**이 맞다 — docs 05 §1.4/1.5 정확.
- 그러나 이 편향이 발화하려면 condenser가 켜져야 함: `agent/base.py:402-404` `condenser: CondenserBase | None = Field(default=None, ...)`. **메인 agent condenser 기본 None**(docs 05 §1.6 확인). condenser 미설정이면 요약 자체가 안 일어나므로 이 보존 bias는 **inert by default**.
- `handles_condensation_requests()` 기본 False(`condenser/base.py:64`)까지 겹쳐 이중 OFF.

**#3 판정: test-우선 soft-bias는 실재하나 default OFF. "항상 test 상태 보존"은 condenser opt-in 시에만.** docs 05 유지 + "default OFF" 정밀화.

---

## 4. finish tool gate (#4) — finish description은 verify 강제 안 함, 그러나 critic이 finish를 가로챈다

### 4.1 finish description 직독 (`builtins/finish.py:46-57`)

```
Use this tool when:
- You have successfully completed the user's requested task
- You cannot proceed further due to technical limitations or missing information
The message should include: ... summary of actions taken and their results ...
```

"검증/재현 없이 끝내지 마라"류 문구 **없음.** "successfully completed" 판단은 모델에 위임. → finish description 자체는 reproduce/verify 간접 강제 채널 **아님**. (#4의 "finish가 verify를 간접 강제하나?" → 텍스트 레벨에선 No.)

### 4.2 ★핵심 반증: finish를 거부하는 loop-level hard gate가 존재한다★

docs 02 §7-4·docs 04 §6은 "유일한 특별취급 tool은 finish이고 그것도 *종료신호*일 뿐, phase 강제 없음"이라 단언했다. 이는 **critic 경로를 누락**했다. 실제 코드:

`agent.py:495-504` (및 async `:529-538`)가 finish 처리 시 `_ActionBatch.finalize`에 `check_iterative_refinement` 콜백을 넘긴다:

```python
batch.finalize(
    check_iterative_refinement=lambda ae: self._check_iterative_refinement(conversation, ae),  # :497-499
    mark_finished=lambda: setattr(... FINISHED),                                                # :500-504
)
```

`finalize` (`agent.py:251-282`):
```python
should_continue, followup = check_iterative_refinement(self.action_events[-1])   # :270
if should_continue:
    # inject followup user message, do NOT mark finished
    ...                                                                          # :271-280 (추정: followup emit)
else:
    mark_finished()                                                             # :282
```

`_check_iterative_refinement` (`critic_mixin.py:76-138`): critic 점수가 `success_threshold`(default 0.6, `base.py:42-47`) 미만이고 `max_iterations`(default 3) 미달이면 **`(True, followup_prompt)` 반환 → finish 무효화 → 작업 강제 재개.** followup은 `get_followup_prompt` (`base.py:88-107`): *"The task appears incomplete ... verify each requirement is met. List what's working and what needs fixing, then complete the task."*

→ 이것은 **prompt soft-guidance가 아니라 loop-level hard gate**다. 모델이 finish를 내도 코드가 가로채 거부하고 재작업을 강제한다. docs 02/04의 "harness가 단계를 못박지 않는다" 단언은 **이 채널에 한해 깨진다.**

### 4.3 단, 이 게이트는 default OFF이고 reproduce를 검사하지 않는다

게이트 무력화 한계:
- `self.critic is None`이면 `_check_iterative_refinement`가 즉시 `(False, None)` 반환(`critic_mixin.py:91-92`). 그리고 `agent/base.py:419-420` `critic: CriticBase | None = Field(default=None, ...)` + description "**EXPERIMENTAL**". → **default OFF.**
- 켜더라도 shipped critic이 검사하는 건 *reproduce/test*가 아님:
  - `AgentFinishedCritic` (`agent_finished.py:49-65`): **non-empty git_patch + FinishAction 존재** 두 가지만.
  - `EmptyPatchCritic` (`empty_patch.py:44-49`): **non-empty patch만.**
  - `get_followup_prompt` default 문구도 generic "verify each requirement"이지 "테스트를 작성/실행해 재현하라"가 아님.
  - API critic(`critic/impl/api/critic.py`)은 외부 서버 점수기(별도 인프라, default 미배선).
- 즉 *reproduce 특정* hard-gate는 critic을 켜도 shipped 범위엔 없다. critic 게이트는 "패치를 만들었나 + finish로 끝냈나"라는 **완료성** 게이트이지 reproduce 게이트가 아니다.

**#4 판정: finish description은 verify 강제 안 함(주장 유지). 그러나 finish를 거부하는 critic hard-gate가 실재 → docs 02/04의 "finish는 종료신호일 뿐, hard gate 없음"은 over-claim(정정). 단 default OFF + reproduce 비검사라, "reproduce 0% 강제"는 살아남고 "일반 verify 0% hard-gate"는 깨진다(default-OFF 단서 붙여).**

---

## 5. 부수 채널 점검 (반증 보강)

- **corrective nudge** (`response_dispatch.py:340-365`): EMPTY/REASONING 응답 시 "use a tool to proceed"를 user 메시지로 주입. **content-agnostic** — reproduce/test 유도 아님. 강제 채널 아님(정상 진행 유도뿐).
- **security_risk escalation** (docs 05 §3.4, `static.py:308`): repo-context 파일발 action을 HIGH risk로. reproduce와 무관, 패스.
- **stuck_detector** (`local_conversation.py:1270-1278`): 단조 반복 차단. reproduce 유도 아님.
- **few-shot 두 번째 call site** (`fn_call_converter.py:687` `_strip_in_context_example`): 제거 경로, 주입 아님 — 누수 없음.

---

## 6. 결론 — "순수 자율" 정밀화

"0% 강제 / 순수 자율"은 **두 조각으로 갈라야 정확**하다:

1. **reproduce 특정** 관점: "0% 강제"는 **참 유지**. default·opt-in·전 preset 어디에도 "재현했는가/테스트 먼저 썼는가"를 검사·차단하는 코드 분기 없음(critic조차 패치-비어있음/finish-여부만 봄). few-shot도 native FC 미주입+reproduce 비시연.
2. **일반 완료-검증** 관점: "0% hard-gate"는 **깨진다.** `_check_iterative_refinement`(critic_mixin.py:76-138)가 finish를 거부하고 재작업을 강제하는 진짜 loop-level hard gate다. 단 `critic=None` default라 **표준 경로에선 inert**.

따라서 정밀 명제는: **"OpenHands는 reproduce를 0% hard-gate(default+opt-in 모두)하나, '순수 자율'은 과장이다 — (a) default-OFF인 critic finish-게이트라는 일반 완료-검증 hard-gate가 코드에 실재하고, (b) task_tracker description의 '테스트 실패 중 done 금지'·system_prompt TESTING `:64`·condenser TESTS 보존이라는 다층 soft-steering이 reproduce/test 방향으로 편향을 건다."** "0% 강제지만 다층 soft-steering"이 "순수 자율"보다 정확하며, 여기에 **"default-OFF인 hard-gate 1종(critic) 존재"**를 추가해야 완전하다.

---

## 7. 10줄 요약 (무엇이 "순수 자율"을 흔드나)

1. ★최대 반증: finish를 거부하고 재작업을 강제하는 **loop-level hard gate가 실재**한다 — `_check_iterative_refinement`(critic_mixin.py:76-138)가 critic 점수 미달 시 `(True, followup)`로 finish를 무효화(agent.py:270-282). docs 02/04의 "finish는 종료신호일 뿐 hard gate 없음"은 **over-claim**.
2. 단 이 게이트는 `critic=None` default(base.py:419-420, "EXPERIMENTAL")라 **표준 경로 inert** — "순수 자율"을 흔들되 무너뜨리진 못함.
3. 게다가 shipped critic은 **reproduce/test를 검사하지 않음**(non-empty patch + FinishAction만, agent_finished.py:49-65) → *reproduce* 0% 강제는 critic을 켜도 유지.
4. few-shot(#1): native FC(Claude/GPT-5)에 **영향 0 확정** — `native_tool_calling=True` default(llm.py:413), `_init_model_info_and_caps`가 자동 flip 안 함(llm.py:2094-), 전 preset 미변경. docs 04 유지.
5. few-shot은 config로 켤 순 있으나(`native_tool_calling=False`) 켜져도 flask/pip 디버그 시연이지 reproduce 시연 아님(fn_call_examples.py).
6. terminal `:42`(#2)는 reproduce 강제 **아님** — Python-literal 오입력 교정기(impl.py:549-568, command 첫바이트 패턴 트리거). docs 03의 "reproduce 강제" 라벨은 **정정**.
7. 그러나 `task_tracker` description "Never mark done when test suites failing"(definition.py:388-392)는 새로 식별한 **test-우선 soft-bias**(텍스트, 비강제).
8. condenser(#3) TESTS/CHANGES 강제보존(summarizing_prompt.j2:16-21)은 test-우선 bias 맞으나 condenser **default None**(base.py:402)이라 inert.
9. finish description(#4) 자체는 verify/repro를 강제하지 않음(finish.py:46-57) — 주장 유지. corrective nudge도 content-agnostic.
10. **정밀 판정**: "reproduce 0% hard-gate"는 참이나 "순수 자율"은 과장 — (a) default-OFF인 critic finish-게이트라는 *일반 완료-검증* hard-gate가 코드에 실재, (b) system_prompt `:64`·task_tracker `:388`·condenser TESTS라는 다층 soft-steering이 test 방향 편향. 정확한 명제 = "0% hard-gate(reproduce 한정) + default-OFF hard-gate 1종(critic, 완료성) + 다층 soft-steering", 단순 "순수 자율" 아님.
