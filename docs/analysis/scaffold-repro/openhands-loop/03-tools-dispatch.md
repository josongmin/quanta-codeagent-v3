# OpenHands agent-sdk — Tool 정의·실행(dispatch) 계층 정밀 분석

분석 소스 루트: `competitor-scaffolds/openhands-agent-sdk/openhands-tools/openhands/tools/`
(SDK dispatch 계층은 `openhands-sdk/openhands/sdk/tool/`, `.../sdk/agent/`)

모든 주장은 file:line으로 고정한다. 추측은 표기한다.

---

## 0. 핵심 판정 (TL;DR)

질문: "OpenHands는 그냥 프롬프트"라는 주장에 대해, 행동을 실제로 결정/가능케 하는 게 system_prompt인가 tool 정의인가?

판정: **둘 다 행동 사양이지만, "능력(capability)"과 "행동 지침(behavioral spec) 총량" 모두 tool 정의 쪽이 우세하다.** system_prompt(`system_prompt.j2`)는 152줄·약 1,100 단어의 정책 산문이고(line 1-152), 실제로 reproduce/edit/실행을 **가능케 하는 메커니즘은 전적으로 tool schema**다. system_prompt가 "버그를 재현하라"고 말해도 `terminal`(bash 실행)·`file_editor`(create/edit) tool이 LLM에 노출되지 않으면 그 문장은 실행 불가능한 선언이다 — system_prompt 안에는 명령을 실행하거나 파일을 쓰는 코드 경로가 단 한 줄도 없다.

게다가 tool description은 그 자체가 **mini-prompt**다. system_prompt가 한 곳에 모아둔 행동 지침("single file로 작업하라", "verify the directory", "delete temp file")이 거의 동일한 강도로 개별 tool description 안에 **중복·분산**되어 있다. tool description 단어 총량(아래 §6 표 기준 약 1,500+ 단어, task_tracker 한 개만 690 단어)이 system_prompt 본문을 **초과**한다. 즉 "행동 사양"의 물리적 다수는 tool 정의 안에 있다.

결론: OpenHands를 "그냥 프롬프트"로 부르는 것은 부정확하다. 행동의 **가능성(capability)** 은 100% tool schema가 공급하고, 행동의 **지침(spec)** 총량도 tool description이 system_prompt를 능가한다. system_prompt는 정책 레이어, tool 정의는 능력+행동 레이어다.

---

## 1. Tool 전체 인벤토리

`openhands-tools/openhands/tools/` 하위 디렉터리(definition.py 보유)와 SDK builtins를 합한 전수.

| Tool (LLM 노출명) | definition.py 위치(:line) | LLM 파라미터(schema) | 능력 카테고리 | description 단어수(근사) | 행동 지침 박힌 정도 |
|---|---|---|---|---|---|
| `terminal` | terminal/definition.py:268 (desc descriptions.py:3) | `command`, `is_input`, `timeout`, `reset` | **bash 실행** (reproduce 핵심) | 303 | 높음(§2) |
| `file_editor` ("str_replace_editor") | file_editor/definition.py:193 (desc :160) | `command`(view/create/str_replace/insert/undo_edit), `path`, `file_text`, `old_str`, `new_str`, `insert_line`, `view_range` | **파일 create/edit/view** (reproduce 핵심) | 338 | 매우 높음(§3) |
| `task_tracker` | task_tracker/definition.py:403 (desc :270) | `command`(view/plan), `task_list[]` | 작업 계획/추적 | 690 | 극단적(§4) |
| `grep` | grep/definition.py:67 (desc :57) | `pattern`, `path`, `include` | 콘텐츠 검색(ripgrep) | 84 | 중 |
| `glob` | glob/definition.py:65 (desc :51) | `pattern`, `path` | 파일명 패턴 검색 | 90 | 중 |
| `edit` (Gemini-style) | gemini/edit/definition.py:134 (desc :106) | `file_path`, `old_string`, `new_string`, `expected_replacements` | 파일 find/replace | 171 | 높음 |
| `read_file` (Gemini) | gemini/read_file/definition.py:109 (desc :92) | `file_path`, `offset`, `limit` | 파일 읽기(pagination) | 72 | 중 |
| `write_file` (Gemini) | gemini/write_file/definition.py:101 (desc :82) | `file_path`, `content` | 파일 전체 쓰기 | 92 | 중 |
| `list_directory` (Gemini) | gemini/list_directory/definition.py | `path`, `recursive` | 디렉터리 나열 | (소) | 저 |
| `apply_patch` | apply_patch/definition.py:129 (desc :123) | `patch`(`*** Begin Patch`…) | unified-diff 패치 적용(GPT-5.1) | 27 | 저(서버측 schema, §1주석) |
| `planning_file_editor` | planning_file_editor/definition.py:63 (desc :48) | file_editor와 동일 + plan 범위 제한 | 계획전용 파일 편집 | file_editor 상속 | 매우 높음(상속) |
| `task` / `TaskToolSet` | task/definition.py | `description`, `prompt`, `subagent_type`, `task_id` | 서브에이전트 위임 | (중) | 중 |
| `delegate` | delegate/definition.py:16 | `command`(spawn/delegate), `ids[]`, `agent_types[]`, `tasks{}` | 멀티 서브에이전트 spawn/위임 | (중) | 중 |
| `workflow` | workflow/definition.py:24 (desc :54) | `name`, `code`(async wf.*) | 코드형 워크플로 실행 | (대) | 높음 |
| `consult_tom` / `tom_consult` | tom_consult/definition.py:30 | `reason`, … | 보조 에이전트 자문(sleeptime) | (중) | 중 |
| `browser_*` / `BrowserToolSet` | browser_use/definition.py (8개 액션) | navigate/click/type/get_state/get_content/scroll/go_back/list_tabs/switch_tab | 브라우저 자동화(ToolSet) | 각 소~중 | 중 |
| `finish` (builtin) | sdk/tool/builtins/finish.py:90 (desc :46) | `message` | 작업 종료 신호 | (중) | 중 |
| `think` (builtin) | sdk/tool/builtins/think.py (desc :60) | `thought` | 사고 로깅(no-op) | (소) | 저 |

주: `apply_patch`는 GPT-5.1에서 서버측 known tool이라 `to_responses_tool`이 의도적으로 **최소 schema**(`{"patch": string}`)만 반환한다(apply_patch/definition.py:159-178). 즉 description이 짧은 게 아니라 provider가 자체 정의를 wire한다.

### preset별 실제 활성 tool 집합 (16개 주장의 출처)

LLM에 한 번에 노출되는 tool은 preset이 결정한다 — 전체 18종이 동시에 켜지지 않는다.

- **default preset** (`preset/default.py:52-64`): `terminal`, `file_editor`, `task_tracker`, (+`browser`(8 액션) if non-CLI), (+`task` if sub-agents). CLI 모드면 browser 제외(default.py:79). 여기에 SDK builtins(`finish`, `think` 등)가 자동 합쳐져 실제 노출 tool 수가 두 자릿수가 된다.
- **gpt5 preset** (`preset/gpt5.py:47-55`): `file_editor` 대신 `apply_patch`. `terminal`, `apply_patch`, `task_tracker`, (+browser).
- **gemini preset** (`preset/gemini.py:67-77`): file_editor 대신 Gemini 4종(`read_file`, `write_file`, `edit`, `list_directory`) + `terminal` + `task_tracker` + browser. browser 8 액션을 합치면 단일 LLM 호출 schema에 **약 16개 function**이 실린다 — 이것이 "16개 tool" 정량의 출처로 보인다(추정: preset×browser-fanout 조합 의존).

핵심: reproduce(버그 재현→수정→검증) 루프를 가능케 하는 최소 3종 — `terminal`(실행)·파일 편집(`file_editor`/`apply_patch`/`edit`+`write_file`)·검색(`grep`/`glob`) — 은 **모든 preset에 빠짐없이 들어있다**(default.py:52, gpt5.py:47, gemini.py:67). 스캐폴드 설계자가 "이 능력은 협상 불가"로 본다는 뜻.

---

## 2. terminal tool — bash 실행 경로와 박힌 지침

### 2.1 능력: 어떻게 명령을 실행하고 결과를 돌려주나

- LLM 노출 액션 `TerminalAction`: `command`(shell 명령), `is_input`, `timeout`, `reset` (terminal/definition.py:86-114).
- 실행은 `TerminalExecutor.__call__`(terminal/impl.py:535-573)이 담당. 두 백엔드:
  - **pooled tmux**(impl.py:466-533): tmux 가용 시 기본. pane 단위 격리로 병렬 실행 허용.
  - **single subprocess**(impl.py:428-464): tmux 없으면. 단일 세션, 직렬화.
- 세션은 **persistent**: env var·venv·작업 디렉터리 변경이 명령 간 유지(descriptions.py:11-12, impl.py 세션 재사용).
- 결과는 `TerminalObservation`으로 LLM에 환원(definition.py:146-201). exit_code, working_dir, py_interpreter_path, "Command finished with exit code N"까지 텍스트로 주입(definition.py:184-190). 큰 출력은 truncate 후 파일 저장(definition.py:193-198).

### 2.2 description에 박힌 행동 지침 (= mini-prompt)

`UNIX_TOOL_DESCRIPTION`(descriptions.py:3-44)은 사실상 bash 사용 매뉴얼이다:
- "One command at a time … use `&&` or `;`"(descriptions.py:9-10)
- "Do NOT use `set -e`, `set -eu`, or `set -euo pipefail`"(descriptions.py:15-16)
- 장시간 명령은 백그라운드+파일 리다이렉트: `python3 app.py > server.log 2>&1 &`(descriptions.py:19-20)
- **Best Practices**: "Verify a parent directory exists before creating files"(descriptions.py:32), "Prefer absolute paths and avoid excessive use of `cd`"(descriptions.py:33).

### 2.3 "Write a script first with file_editor" — :42 확인

질문에서 지목한 ":42" 지침은 descriptions.py가 아니라 **terminal/definition.py:42**의 `_LITERAL_ARG_HINT_TEMPLATE`에 있다(definition.py:37-52):

> "Write a script first with `file_editor` (command="create", path="/tmp/run.py", ...), then invoke it: `python /tmp/run.py`." (definition.py:42-44)

이건 정적 description이 아니라 **런타임 가드가 LLM에 되먹이는 동적 지침**이다. `looks_like_python_literal_argument`(definition.py:55-83)가 `command` 인자가 Python/JSON 리터럴(`[{...}]`, `{"k":...}`)처럼 보이면 실행을 거부하고(impl.py:549-568), 위 템플릿을 `is_error=True` observation으로 돌려준다. 즉 모델이 bash 자리에 Python dict를 넣는 흔한 실패를 **tool 계층이 직접 교정**한다 — system_prompt에는 이 교정이 없다. reproduce 행동("스크립트로 재현하라")을 tool이 강제하는 사례.

추가로 impl.py:38-47 `_TMUX_POOL_RECOVERY_MESSAGE`는 "top-level `exit` 쓰지 말고 `test "$code" -eq 0` 써라"까지 모델에 지도한다 — 역시 tool 계층의 행동 지침.

---

## 3. file_editor tool — create/str_replace/view + verify 지침

### 3.1 능력

`FileEditorAction`(file_editor/definition.py:29-66): `command` ∈ {view, create, str_replace, insert, undo_edit}, `path`(절대경로 강제, :36), `file_text`, `old_str`, `new_str`, `insert_line`, `view_range`. 실행은 `FileEditorExecutor`(impl.py)가 workspace_root 바인딩 후 수행(definition.py:221-224).

### 3.2 description에 박힌 지침 (TOOL_DESCRIPTION, file_editor/definition.py:160-190)

이 description은 거의 절차서다:
- "Before using this tool: 1. Use the view tool to understand the file's contents … 2. **Verify the directory path is correct** … use the view tool to verify the parent directory exists"(:169-172) — 질문이 지목한 "verify the directory" 지침 확정.
- "Always use absolute file paths (starting with /)"(:177), "Do not leave the code in a broken state"(:176).
- **CRITICAL REQUIREMENTS**: "EXACT MATCHING: the `old_str` must match EXACTLY one or more consecutive lines … including all whitespace and indentation"(:181) — 질문이 지목한 "exact text" 지침 확정.
- "UNIQUENESS: include sufficient context (3-5 lines recommended)"(:183-185).
- "prefer to send all edits in a single message with multiple calls"(:189).

런타임 생성 단계에서 description에 **working_dir까지 주입**한다: "Your current working directory is: {working_dir} … start with this directory instead of the root filesystem"(definition.py:245-251). vision 모델이면 이미지 view 줄을 동적 삽입(:232-239). 즉 description은 정적 문자열이 아니라 **conv_state 기반으로 조립되는 동적 prompt**다.

`edit`(Gemini, gemini/edit/definition.py:106-131)도 동형 지침: "old_string must match EXACTLY (including whitespace)"(:117), "Use the `read_file` tool first to verify the exact text to replace"(:124) — verify+exact 지침이 또 중복.

---

## 4. tool description = 숨은 mini-prompt (정량화)

`task_tracker`의 `TASK_TRACKER_DESCRIPTION`(task_tracker/definition.py:270-400, 약 690 단어)이 가장 극단적 증거다. 이것은 schema 설명이 아니라 **완결된 행동 정책 문서**다:
- "When to use / When NOT to use" 섹션(:277-305)
- 3개의 전체 **Scenario** 예시 + 2개 Counter-example(:307-368) — few-shot 프롬프트 그 자체.
- "Limit active work to ONE task"(:291, :380), "Never mark done when: Test suites are failing / Implementation remains incomplete"(:388-392).

이 한 tool의 description 단어수(690)가 system_prompt.j2 본문(약 1,100 단어, soul 제외) 대비 **단일 tool로 60% 수준**이다. tool 4~5개만 합쳐도 system_prompt를 넘는다.

### 행동 지침의 중복(system_prompt ↔ tool description)

동일 지침이 두 레이어에 **이중 인코딩**되어 있다 — 이것이 "행동 사양이 tool에도 산다"는 결정적 증거:

| 행동 지침 | system_prompt.j2 | tool description |
|---|---|---|
| "single file로, suffix 버전 만들지 마라 / temp는 지워라" | :26-31, :73 (FILE_SYSTEM_GUIDELINES) | terminal best-practice는 absolute-path만, 하지만 reproduce 단일파일 지침은 prompt 측 |
| "verify the directory before creating" | (간접) | terminal descriptions.py:32, file_editor :169-172 |
| "exact text / whitespace 일치" | 없음 | file_editor :181, gemini edit :117 — **tool 전용** |
| "absolute path 사용" | :23 (간접) | terminal :33, file_editor :177 |
| "최소 변경" | :37 (CODE_QUALITY) | (tool엔 없음 — prompt 전용) |
| "ONE task focus" | 없음 | task_tracker :291,:380 — **tool 전용** |

즉 일부 행동 지침(exact-text, one-task-focus)은 **오직 tool description에만 존재**하고 system_prompt에는 없다. system_prompt를 통째로 지워도 이 지침들은 살아있고, 반대로 tool을 지우면 능력 자체가 사라진다.

---

## 5. tool이 reproduce 행동의 실제 능력 공급원임을 입증

dispatch 경로로 증명한다. system_prompt는 LLM messages의 텍스트일 뿐, 실행 부수효과(side-effect)를 만드는 코드는 tool executor에만 있다.

1. **schema 노출**: `ToolDefinition.to_openai_tool`(sdk/tool/tool.py:465-495)이 각 tool의 `name`+`description`+`parameters`(action schema)를 OpenAI function spec으로 직렬화. `to_responses_tool`(:497-525)도 동형. 이게 없으면 LLM은 `terminal`/`file_editor`를 **호출할 방법 자체가 없다**.
2. **dispatch**: 모델이 tool_call을 내면 agent가 이름으로 tool을 찾고(`self.tools_map.get(tool_name)`, agent.py:1019, 1139), 인자를 action으로 검증(`tool.action_from_arguments`, agent.py:1055; tool.py:347-359), 실행(`tool(action, conversation)`, agent.py:1154 → tool.py:361-390 → executor `__call__`).
3. **부수효과**: `terminal` executor(impl.py:535-573)만이 실제 shell 프로세스를 띄우고, `file_editor`/`write_file`/`apply_patch` executor만이 실제 디스크에 쓴다. system_prompt에는 `subprocess`·파일 I/O 호출이 0개다.

따라서 "버그를 재현하라"는 reproduce 지시는:
- system_prompt가 의도를 **유발**할 수는 있어도,
- 실제 재현 스크립트 작성(`file_editor.create`)·실행(`terminal`)·결과 확인(`terminal` exit_code observation, definition.py:184-190)은 **전적으로 tool schema+executor**가 공급한다.

tool을 제거하면 모델은 "재현하겠습니다"라고 말한 뒤 호출할 도구가 없어 멈춘다. 능력의 단일 공급원이 tool이라는 것의 구조적 증거다.

### dispatch 계층의 추가 특성 (행동을 tool이 형성하는 또 다른 방식)

- **등록**: 모든 tool은 import 시 `register_tool(...)`로 전역 레지스트리에 자동 등록(예: terminal/definition.py:352, file_editor/definition.py:272; registry.py:113-147). preset이 `Tool(name=...)` spec만 나열하면 `resolve_tool`(registry.py:149-158)이 conv_state로 실제 인스턴스를 만든다.
- **병렬성도 tool이 선언**: `declared_resources`(tool.py:337-345)로 tool이 자기 동시성 키를 신고한다. `file_editor`는 `file:<path>` 키로 같은 파일 직렬화·다른 파일 병렬(file_editor/definition.py:196-206); `terminal` subprocess는 `terminal:session` 키로 직렬화, pooled tmux는 키 없이 병렬(definition.py:271-280); `grep`은 무락 병렬(grep/definition.py:70-79). → 실행 스케줄링 행동조차 system_prompt가 아니라 tool 메타데이터가 결정.
- **안전 힌트**: `ToolAnnotations`(readOnlyHint/destructiveHint 등)가 tool마다 선언되어(예: terminal destructiveHint=True, definition.py:339-345; grep readOnlyHint=True, grep/definition.py:118-122) security risk 평가 분기(agent.py:1044-1048, tool.py:448-453)를 탄다.
- **출력 정제**: secrets 마스킹(impl.py:355-379), 출력 truncate+파일저장(definition.py:193-198) — 모델이 보는 관찰 텍스트도 tool이 가공.

---

## 6. system_prompt vs tool description — "행동 사양" 위치 판정 (정량)

| 항목 | 위치 | 규모(근사) | 성격 |
|---|---|---|---|
| system_prompt.j2 본문 | sdk/agent/prompts/system_prompt.j2:1-152 | 152줄 / ~1,100 단어(soul 제외) | 정책: ROLE, EFFICIENCY, FILE_SYSTEM, CODE_QUALITY, VCS, PR, WORKFLOW, SECURITY, BROWSER, ENV, TROUBLESHOOT, PROCESS |
| terminal description | descriptions.py:3-44 (+definition.py:37-52 동적) | ~303 (+101) 단어 | bash 사용 매뉴얼+런타임 교정 |
| file_editor description | file_editor/definition.py:160-190 | ~338 단어 | 편집 절차서(verify/exact/unique) |
| task_tracker description | task_tracker/definition.py:270-400 | ~690 단어 | 완결 정책+few-shot |
| grep/glob/gemini-edit/write/read | 각 definition.py | 84/90/171/92/72 단어 | 사용 규칙+예시 |
| apply_patch | apply_patch/definition.py:123-126 | ~27 단어(서버측 schema) | 최소 |
| **tool description 합계(default+gemini류 핵심)** | — | **~1,500+ 단어** | 능력+행동 |

판정: 단일 LLM 호출에 실리는 텍스트 기준으로 **tool description 총량이 system_prompt 본문을 초과**한다(task_tracker 하나가 prompt의 60%). 그리고 reproduce/edit/실행을 **가능케 하는 메커니즘은 system_prompt에 0%, tool schema에 100%**. 일부 핵심 행동 지침(exact-text 매칭, one-task-focus, Python-literal 거부)은 **오직 tool 계층에만** 존재한다.

따라서 "OpenHands는 그냥 프롬프트"는 기각된다. 정확히는: **system_prompt는 정책 레이어, tool 정의(schema+description+executor+annotations)는 능력 레이어이자 행동 지침의 물리적 다수 보유자**다. 행동을 결정/가능케 하는 무게중심은 tool 정의 쪽에 있다.

---

## 부록: 우리(quanta)에의 함의 (관찰만, 처방 아님)

- 우리 tool-surface SSOT(`manifest.ts` BASE24+GATED)와 대비: OpenHands는 tool description을 **동적 조립**(working_dir/vision/런타임 교정 주입)하고 description에 few-shot까지 박는다 — 우리 도구 설명이 정적 1-라이너면 "행동 유도" 측면에서 갭일 수 있음(측정 필요, 미검증).
- reproduce 능력 3종(실행/편집/검색)을 **모든 preset에 무조건 포함**하는 설계 결정은 우리 bench preset 구성과 직접 비교 가능한 레퍼런스.
