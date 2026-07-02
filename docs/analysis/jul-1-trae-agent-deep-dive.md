# jul-1 -- trae-agent 딥다이브 (객체/프롬프트/도구/전략)

> 대상: ByteDance `trae-agent` (MIT, github.com/bytedance/trae-agent), clean checkout
> `~/Documents/code-new/competitor-scaffolds/trae-agent`. 모든 file:line은 `trae_agent/` 기준
> (offline selector·eval은 `evaluation/` 기준).
> 방식: 객체-레벨 정독 + 적대적 재검증(5개 주장 전부 CONFIRM).

## TL;DR

- trae는 **단일-trajectory · LLM-자율 루프**다. bash + str-edit + sequentialthinking + task_done,
  `≤ max_steps`. 런타임에 best-of-N / candidate fanout / repro 강제 / escalation **전부 없음**.
- **코드로 강제하는 전략 게이트는 딱 하나** — `must_patch` 빈-diff veto(eval만 ON).
- CKG(코드 심볼 인덱스) · sequential_thinking · bug-reproduction 은 전부 **LLM 선택 / 프롬프트 권장**.
- reflection 은 TraeAgent 에서 `return None` 오버라이드 = **죽어있음**. lake_view 는 **뷰 전용**(실행 영향 0).
- ⭐ **best-of-N 은 존재하지만 별도 OFFLINE 하네스**(`evaluation/patch_selection/`), 런타임 루프에 **미배선**.

## 1. 프롬프트 구성 / 렌더링 / 최종 입력

### System prompt
`prompt/agent_prompt.py:4-53` 단일 정적 상수 `TRAE_AGENT_SYSTEM_PROMPT` (템플릿 변수 0):
- 역할: "expert AI software engineering agent"
- **유일한 하드 포맷 규칙**: 모든 `file_path`는 절대경로 (`[Project root path]`와 결합, agent_prompt.py:6-8)
- **7단계 방법론**(agent_prompt.py:12-41): Understand → Explore/Locate → **Reproduce the Bug (Crucial, "you must create a script")** → Debug → Implement(minimal) → **Verify rigorously**(repro 재실행 + regression + pytest 신규 + edge) → Summarize
- sequential_thinking 권장(total_thoughts ≥5, ≤25; agent_prompt.py:45-50)
- 종료: "sure the issue solved → call `task_done`" (agent_prompt.py:52)

### 렌더링 (핵심 아키텍처)
- **매 턴 messages 재조립 안 함.** LLMClient 가 `message_history` 를 provider-네이티브 타입으로 영속 보관
  (`reuse_history=True`, anthropic_client.py:65). 루프는 델타(tool_result)만 넘긴다.
- **system 은 messages 배열이 아니라 API `system=` 파라미터**로 별도(anthropic_client.py:159-160).
- 초기 user message = `[Project root path]\n...` + `[Problem statement]: ...{issue 원문 그대로}` (trae_agent.py:125-144).
  base_commit/must_patch/patch_path 는 프롬프트에 안 들어가고 인스턴스 속성에만 `setattr`(trae_agent.py:139-142).
- **한 턴 LLM 입력 순서** = `[system 고정] → [초기 user task] → (assistant 응답 ↔ user tool_result) 반복 누적`.
- reflection 은 별도 블록으로 안 붙음(아래 §4). 유일한 재독려 = must_patch 빈패치 시
  `"ERROR! Your Patch is empty..."` user 메시지 하나(trae_agent.py:246-249).

## 2. 내부 객체 구성

### 데이터 (agent/agent_basics.py)
- `AgentState`(IDLE/RUNNING/COMPLETED/ERROR, :29-35) + `AgentStepState`(THINKING/CALLING_TOOL/REFLECTING/COMPLETED/ERROR, :19-26) — **2층 상태**
- `AgentStep`(dataclass, :38-63): step_number/state/thought/tool_calls/tool_results/llm_response/reflection/error/llm_usage
- `AgentExecution`(:66-84): task/steps[]/final_result/success/total_tokens/execution_time

### 클래스 계층
- `BaseAgent(ABC)` (base_agent.py:24) — 루프 뼈대. `execute_task`(147 메인 while), `_run_llm_step`(209),
  `_tool_call_handler`(314), `reflect_on_result`(246). tools 는 `tools_registry`서 인스턴스화(:42-45),
  tool_caller 는 `ToolExecutor` 또는 **`DockerToolExecutor`**(docker_config 유무, :48-73).
- `TraeAgent(BaseAgent)` (trae_agent.py:30) — SWE 특화 + MCP. 완료=`task_done` 툴콜 판정(228),
  `_is_task_completed`=**must_patch 가드**(235: git diff 서 test변경 뺀 뒤 빈패치면 완료거부),
  `reflect_on_result`=**None 오버라이드**(176-178). 도구셋 `TraeAgentToolNames`(21-27).
- `Agent`(agent.py:14) — agent_type 로 조립하는 얇은 파사드.

### run 루프 (base_agent.py:147-200)
`while step_number <= max_steps`: LLM chat → task_done? (+must_patch OK?) → COMPLETED break /
아니면 tool 실행(parallel or sequential) → tool_result 재주입. 종료 = COMPLETED / 예외(ERROR) /
max_steps 초과("exceeded maximum steps" + ERROR). must_patch 미완료는 **종료 아니라 재촉 후 지속** →
max_steps 에 걸려서만 끝.

### 부가 계층 (전부 루프 바깥)
- **`DockerManager`**(agent/docker_manager.py) — pexpect **persistent bash shell** 격리,
  PyInstaller 빌드 `dist/` 도구를 `docker cp` 주입, `---CMD_DONE---$?` 마커로 exit-code 파싱.
  기본 SWE-bench 이미지 `swebench/sweb.eval.x86_64.<id>` 위에서 돔.
- **`TrajectoryRecorder`**(utils/trajectory_recorder.py) — 이벤트마다 JSON 전체 재기록(크래시 부분보존).
- **`LakeView`**(utils/lake_view.py) — 각 스텝을 **별도 LLM 2콜**로 요약: `<task>/<details>` 추출
  (EXTRACTOR_PROMPT:16) + 8종 태그(WRITE_TEST/EXAMINE_CODE/WRITE_FIX/VERIFY_FIX... :57-66) 이모지 분류.
  **실행 로직 영향 0** — CLI 콘솔서 백그라운드 뷰(simple_console.py:223-227). default ON(config.py:164).

## 3. 도구셋 (registry 6개 + 동적 MCP)

| 도구 | registry 키 | 목적 | 특징 (file:line) |
|---|---|---|---|
| bash | `bash` | persistent 쉘 | 단일 장수명 세션, sentinel 배너로 exit-code 캡처, **120s 하드 타임아웃**, restart 옵션 (bash_tool.py:19-59,87-159) |
| edit | `str_replace_based_edit_tool` | view/create/str_replace/insert | Anthropic식, old_str **verbatim-unique 강제**(0/다중매치 에러), undo 제거됨 (edit_tool.py:197-274) |
| json edit | `json_edit_tool` | JSONPath 편집 | jsonpath_ng, set/add/remove (json_edit_tool.py:195-329) |
| sequential thinking | `sequentialthinking` | **추론 스크래치패드** | 부수효과 0, revision·branch 지원, LLM/파일 I/O 없음, 각 thought=1 툴콜(궤적기록). Anthropic MCP 서버 포트 (sequential_thinking_tool.py:277-319) |
| CKG | `ckg` | **Code Knowledge Graph** | ↓ §3.1 |
| task done | `task_done` | 완료 선언 | "검증 전 호출 금지" 하드 경고 (task_done_tool.py:25) |
| MCP | 동적(툴명) | MCP 서버 툴 어댑터 | allowlist 게이트, self._tools 에 append (mcp_tool.py:8-58) |

**등록/기본 (drift 주의)**: registry(`tools/__init__.py:27-34`) 6개. 기본 도구셋 **2개가 불일치** —
`TraeAgentToolNames`(trae_agent.py:21-27)=5개(json_edit 포함), `config.py:165-172` default=4개(json_edit 빠짐).
**`ckg`는 어느 기본에도 없음 = config `tools:` 에 수동 추가해야 켜짐.**
Executor(base.py:182-244)는 name normalizer(lowercase+strip `_`)로 모델 변형 흡수, parallel/sequential 지원.
스키마 생성은 **OpenAI strict-mode** 대응(모든 param required + nullable optional, base.py:120-175).

### 3.1 CKG 상세 (차별점 + 한계)
tree-sitter AST → **SQLite 심볼 인덱스**. ⚠️ **테이블 2개(functions/classes), 엣지 없음** — "graph"는
과장이고 실은 **심볼 테이블**(ckg_database.py:122-145). 쿼리 3종(`search_function/class/class_method`)
전부 **exact-name equality**(fuzzy/regex 없음, ckg_database.py:660-693). git-HEAD 해시로 캐시
(status 바뀌면 rebuild, ckg_database.py:97-104), 1주 만료. 6언어(py/java/cpp/c/ts/js). 자기고백 한계
(ckg_database.py:23-28): incremental 없음, JS/TS arrow 미파싱. **grep 대체 아니라 보완**.

## 4. 문제해결 전략 + 트리거

| 전략 | 발동 조건 | 결정자 | 근거 |
|---|---|---|---|
| CKG 심볼검색 | LLM이 툴 호출 **+ config에 ckg 추가돼야**(기본 OFF), 인덱싱 lazy | **LLM**+det(캐시) | ckg_tool.py:80-133; 기본목록 omit trae_agent.py:21-27 |
| sequential_thinking | LLM 자율(프롬프트 권장, 코드 강제 X) | **LLM** | sequential_thinking_tool.py:277; agent_prompt.py:45-51 |
| reflection | **TraeAgent서 no-op(`return None`)** | 비활성 | trae_agent.py:176-178; 소비 `if reflection:` base_agent.py:342-350 |
| **must_patch 가드** | `must_patch=="true"`(eval 항상 ON, CLI 기본 OFF) — 빈 diff면 task_done 거부→루프 지속 | **det**(config 게이트) | trae_agent.py:236-249; cli.py:135; run_evaluation.py:295 |
| lake_view | enable_lakeview(기본 ON) + CLI — 스텝 요약 2 LLM콜 | det+별도 LLM(뷰) | lake_view.py:94-209 |
| task_done 완료 | LLM이 호출 → must_patch 확인 | LLM+det | trae_agent.py:228-233 |

**런타임 루프에 없는 것 (적대검증 CONFIRM)**: best-of-N/candidate fanout ❌ · repro-test **강제/코드화** ❌
(프롬프트 "must"는 문장뿐, 실행 게이트 배선 0) · escalation/retry loop ❌(max_steps 외 종료 없음) · voting ❌.

## 5. ⭐ Offline best-of-N: `evaluation/patch_selection/`

trae 에 best-of-N 이 **있다 — 단 런타임 미배선 별도 하네스**. README: "first agent-based ensemble".
- 입력: **미리 생성된** 후보 패치 `.jsonl`(`--num_candidate` 기본 10, `--group_size` 10; 생성기 아님).
- **SelectorAgent**(selector_agent.py:153-242) = **tool-using LLM 에이전트**가 Docker 샌드박스 안에서
  bash+str_edit 로 이슈/코드/각 패치 분석, (선택적으로) 테스트 작성·실행 후 `### Result: Patch-x` 방출
  → regex 로 winner 추출(selector_agent.py:210-229), fallback candidate 0.
- 전처리(det): **regression 필터**(precomputed regressions 빈 후보만, selector_evaluation.py:184-189) +
  **dedup**(clean_patch normalize, utils.py:33-74). 그 뒤 **LLM 이 최종 결정**(test 오라클 게이트 아님).
- `--majority_voting`: SelectorAgent 를 `num_candidate` 회 반복, `Counter` 최빈 id, strict majority 조기종료
  (selector_evaluation.py:214-251).
- **배선**: `patch_selection/*` 는 `trae_agent` 런타임을 import(LLMClient/tools/Config 재사용)하나
  **역방향 엣지 0**(런타임·`run_evaluation.py` 어디도 selector 참조 안 함) → **완전 post-hoc**.
- 채점: winner 를 precomputed `success_id` 오라클 라벨에 조회(**live SWE-bench 재실행 아님**,
  selector_evaluation.py:272-282) = **selection accuracy** 측정용 연구도구.

## 6. LLM / provider / retry 층 (utils/llm_clients)

- 데이터: `LLMMessage(role+content+tool_call+tool_result)` 단일 타입으로 텍스트/툴콜/툴결과 통일(llm_basics.py:10-17).
- 추상 2축: **직접 BaseLLMClient**(anthropic=Messages, openai=**Responses API**, google=genai, ollama) +
  **OpenAICompatibleClient+ProviderConfig 전략패턴**(chat.completions 공유: azure/doubao/openrouter).
- provider 차이: OpenAI 만 Responses(`max_output_tokens`); temperature 우회(o3/o4-mini/gpt-5 substring →
  `NOT_GIVEN`); tool-call 파싱 provider별(tool_use/function_call/tool_calls), call_id 없으면 uuid4.
- **retry(retry_utils.py:13-50)**: `except Exception` **무차별**(429/타임아웃/4xx 구분 0), 초기1+max_retries(기본3),
  backoff = **`random.randint(3,30)`초 균일 랜덤**(지수백오프 아님). = 순수 **API-level**(strategy 재시도 아님).
- history: client 별 provider-네이티브 리스트 보유(reuse_history), system 은 anthropic/google 만 별도 분리.
- usage: provider 별 필드 매핑 상이(anthropic 만 cache creation+read, openai reasoning_tokens, compatible 는
  prompt/completion 만=cache 유실), **누적은 상위 몫**. `parallel_tool_calls` 는 config 선언됐으나 이 층서 **dead**.

## 7. SWE-bench eval 하네스 (evaluation/run_evaluation.py)

- instance당 Docker 1개(공식 `swebench/sweb.eval.x86_64.<id>`, working_dir `/testbed`), 그 안에서
  `trae-cli run` **1회**(`--must-patch --patch-path --trajectory-file`, run_evaluation.py:291-297).
- 병렬: ThreadPoolExecutor 기본 `max_workers=4`. **attempt = instance당 정확히 1회**(재시도/다중생성 없음).
- 채점: predictions.json 모아 **공식 upstream SWE-bench 하네스** subprocess 호출(핀 커밋
  `2bf15e1...`) — 자체 채점 로직 없음.
- eval config(`trae_config.yaml.example`): anthropic `claude-4-sonnet`, **max_steps 200**, temperature 0.5,
  tools 4개(ckg 없음).

## 적대적 재검증 결과 (5/5 CONFIRM)

| 주장 | 판정 | 근거 |
|---|---|---|
| reflection = TraeAgent no-op | CONFIRM | trae_agent.py:176-178 `return None` only |
| repro-test 강제 없음(프롬프트뿐) | CONFIRM | reproduce 언급 전부 프롬프트/태그, 실행 게이트 0 |
| must_patch 만 유일 코드 게이트 | CONFIRM | trae_agent.py:236-249; 다른 hard gate 부재 |
| single trajectory, 런타임 best-of-N 없음 | CONFIRM | base_agent.py:163 단일 while; 단 offline selector 별도 존재(§5) |
| ckg 기본 OFF | CONFIRM | 어느 default/example config 에도 ckg 없음 |

## Quanta 대비 시사점

- trae 는 우리 감사문서(jul-1)의 `single bounded loop` family 를 **재확인** — 런타임엔 breadth escalation 부재.
- 단 **정정**: "trae 는 best-of-N 을 안 한다"는 과장. **offline `patch_selection` selector(agent-based ensemble)**
  가 별도로 있다(런타임 미배선, 외부 후보 입력형). jul-1 문서에 각주 반영함.
- 우리 v7 과 대비: trae 는 코드 게이트가 must_patch 하나(=우리 `no-patch-breaker` 유사)뿐이고, 검증·repro·
  best-of-N 을 전부 LLM 자율/오프라인에 맡긴다. 우리는 반대로 오라클(repro-vote/acceptance/strong-oracle)을
  런타임에 무겁게 박은 쪽 — 두 극단.
