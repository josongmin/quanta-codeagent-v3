# OpenHands agent-sdk: reproduce·탐색·코드생성·검증의 발생 메커니즘

분석 소스: `/Users/songmin/Documents/code-new/competitor-scaffolds/openhands-agent-sdk/`
분석일: 2026-07-01. 모든 인용은 file:line 동반, 추측 없음.

## 0. 핵심 결론 (먼저)

OpenHands agent-sdk에는 **reproduce를 강제하는 코드 분기·파이프라인 단계·repro 엔진이 존재하지 않는다.** SWE-bench Agentless류의 N-sampling/majority-vote/dual-tree repro 생성기는 코드에 **부재**(grep 0건). reproduce가 "언제 일어나는가"를 결정하는 것은 전적으로 **(b) system_prompt 워크플로 권장 + (c) few-shot 습관 + (d) 모델 자율**의 조합이며, (a) 코드 강제 분기는 **0**이다. 게다가 워크플로의 TESTING 단계조차 "MUST"가 아니라 환경 조건부("if the environment is set up")로 빠져나갈 출구가 명시돼 있어, repro/test는 **soft nudge**에 가깝다.

비중(코드 증거 기반):
- (a) 코드 강제 분기: **0%** — 전수 grep 결과 repro/test-first/fail_to_pass 어떤 것도 실행 경로로 존재하지 않음.
- (b) system_prompt 워크플로 권장: **~50%** — `PROBLEM_SOLVING_WORKFLOW` 3단계 TESTING이 "create tests to verify issues before implementing fixes"를 명시하나 강제어 아님.
- (c) few-shot 습관: **~15%** — 유일한 few-shot 예시(Flask)는 "만들고 실행→로그 보고→고침→재실행" 일반 디버그 루프이지 reproduce 시연이 아니며, 게다가 native FC 모델엔 주입조차 안 됨.
- (d) 순수 모델 자율: **~35%** — 위 둘 다 조건부/비강제라서 실제 시점 결정의 잔여 책임은 모델에 위임.

---

## 1. system_prompt.j2 의 PROBLEM_SOLVING_WORKFLOW 전문 분석

파일: `openhands-sdk/openhands/sdk/agent/prompts/system_prompt.j2:60-75`. (동일 텍스트가 코드 측 SSOT `context/prompts/sections/static.py:178-196` `ProblemSolvingSection`에 중복 보관 — 둘은 byte-identical.)

5단계 정확 문구:

- **1. EXPLORATION** (`:61`): "Thoroughly explore relevant files and understand the context before proposing solutions"
- **2. ANALYSIS** (`:62`): "Consider multiple approaches and select the most promising one"
- **3. TESTING** (`:63-69`):
  - `:64` "For bug fixes: Create tests to verify issues before implementing fixes"
  - `:65` "For new features: Consider test-driven development when appropriate"
  - `:66` "Do NOT write tests for documentation changes, README updates, configuration files, or other non-functionality changes"
  - `:67` "Do not use mocks in tests unless strictly necessary ... You must always test real code paths in tests, NOT mocks."
  - `:68` "If the repository lacks testing infrastructure ... consult with the user before investing time"
  - `:69` "If the environment is not set up to run tests, consult with the user first before investing time to install all dependencies"
- **4. IMPLEMENTATION** (`:70-73`): "Make focused, minimal changes" / "Always modify existing files directly rather than creating new versions" / "If you create temporary files for testing, delete them after confirming your solution works"
- **5. VERIFICATION** (`:74`): "If the environment is set up to run tests, test your implementation thoroughly, including edge cases. If the environment is not set up to run tests, consult with the user first before investing time to run tests."

### 1-1. "BEFORE implementing fixes" 가 강제(MUST)인가? — 강제성의 언어 정밀 분석

**강제 아님.** 정밀하게 보면:

- `:64`의 문구는 "**Create** tests to verify issues **before** implementing fixes"로 **명령형 동사**(Create)를 쓰지만 **MUST/ALWAYS/REQUIRED 같은 강제 부사를 동반하지 않는다.** 같은 프롬프트가 다른 곳에서는 강제를 명확히 표기한다 — 예: `FILE_SYSTEM_GUIDELINES`의 "**NEVER** create multiple versions"(`:26`), `PULL_REQUESTS`의 "**Important**: Do not push ... unless explicitly asked"(`:53`). 즉 이 프롬프트의 저자는 강제할 때 대문자 MUST/NEVER/Important를 쓰는 컨벤션이 있는데, TESTING `:64`엔 그게 **없다.**
- 바로 다음 줄 `:65`는 신기능에 대해 "**Consider** test-driven development **when appropriate**"로 명백한 권장·조건부.
- `:68`/`:69`는 "테스트 인프라가 없거나 환경이 셋업 안 됐으면 **사용자에게 먼저 상의**"라는 **탈출 출구**를 박아둠. 즉 repro/test는 환경 게이트로 언제든 스킵 가능.
- VERIFICATION `:74`도 동일하게 "If the environment is set up to run tests ... / If not ... consult the user first" 조건부.

결론: `:64`는 "버그 픽스 시엔 고치기 전에 검증 테스트를 만들라"는 **강한 권장(strong recommendation)**이되, 언어학적으로 **강제(hard MUST)는 아니며**, 환경/인프라 조건으로 무력화될 출구가 같은 단계 내에 명시돼 있다. Agentless가 repro 스크립트를 파이프라인 단계로 못 박는 것과 질적으로 다르다.

---

## 2. FILE_SYSTEM_GUIDELINES — reproduce를 임시 진단 파일로 다루는 지침

파일: `system_prompt.j2:22-32` (코드 SSOT: `static.py:124-137` `FileSystemSection`, byte-identical).

reproduce 관련 전문:

- `:26` "**NEVER create multiple versions of the same file with different suffixes (e.g., file_test.py, file_fix.py, file_simple.py).** Instead:"
- `:27` "  - Always modify the original file directly when making changes"
- `:28` "  - **If you need to create a temporary file for testing, delete it once you've confirmed your solution works**"
- `:29` "  - If you decide a file you created is no longer useful, delete it instead of creating a new version"
- `:31` "**When reproducing bugs or implementing fixes, use a single file rather than creating multiple files with different versions**"

해석: 여기서 reproduce는 1급 워크플로 단계가 아니라 **위생 규칙의 대상**으로만 등장한다. 즉 "reproduce는 해도 좋되 (1) 단일 파일로, (2) 임시 파일이면 확인 후 삭제하라"는 **클린업 제약**이다. `:31`의 "When reproducing bugs"는 reproduce를 *전제·권장*하는 게 아니라 *reproduce를 하게 되는 경우의 파일 위생*을 규율한다 — 조건절("When ...")이지 명령("You must reproduce ...")이 아니다. 이 지침은 repro 결과물(스크립트)을 **버리는 임시 진단물**로 취급하는 OpenHands의 태도를 드러낸다: repro 산출물을 패치 평가에 다시 먹이는 오라클 루프(Agentless식)와 정반대로, "확인되면 지워라"가 디폴트.

---

## 3. in_context_learning_example.j2 전문 분석 — few-shot 시연 시퀀스

파일: `openhands-sdk/openhands/sdk/agent/prompts/in_context_learning_example.j2` (전체 176줄). suffix는 `in_context_learning_example_suffix.j2:1-3` ("PLEASE EMIT ONE AND ONLY ONE FUNCTION CALL PER MESSAGE").

태스크(`:5`): "Create a list of numbers from 1 to 10, and display them in a web page at port 5000." — **버그 수정이 아니라 신규 기능 구축.**

실제 turn 시퀀스 추출:

1. `:7-12` 탐색: `pwd && ls` (현재 디렉토리 확인)
2. `:18-36` 생성: `str_replace_editor create /workspace/app.py` (Flask 앱 작성)
3. `:41-46` 실행: `python3 app.py > server.log 2>&1 &` (백그라운드 기동)
4. `:48-50` 관찰: 프로세스가 즉시 `Exit 1`로 크래시
5. `:52-57` 로그 확인: `cat server.log`
6. `:59-63` 진단: `ModuleNotFoundError: No module named 'flask'`
7. `:65-70` 고침(환경): `pip3 install flask`
8. `:89-94` 재실행: `python3 app.py ...` (재기동)
9. `:99-112` 재관찰: `cat server.log` → 정상 기동 확인
10. `:117-165` 후속 요청 처리(서버 kill → 코드 수정 → 재실행)
11. `:166-169` `finish` 호출로 종료

### 3-1. reproduce/test 가 예시에 등장하나?

**아니다.** 이 few-shot은 "탐색→생성→실행→로그확인→고침→재실행"의 **일반 build-run-debug 루프**를 시연하지만:

- 시연된 "고침"은 **소스 버그 수정이 아니라 누락 의존성 설치**(`pip3 install flask`, `:67`)다. 즉 환경 셋업 디버그이지 코드 결함 reproduce가 아니다.
- "테스트를 먼저 작성해 버그를 재현"하는 turn이 **단 하나도 없다.** 검증은 `cat server.log`로 런타임 출력을 읽는 것이지, fail-to-pass 테스트를 돌리는 것이 아니다.
- "확인 후 임시 파일 삭제"(§2의 `:28`)조차 시연 안 됨 — 만든 `app.py`는 최종 산출물로 유지.

즉 few-shot은 reproduce/test-first 습관을 **시연하지 않는다.** 모델이 여기서 학습하는 것은 "실행해서 깨지면 로그 보고 고치고 다시 실행"이라는 **사후(reactive) 디버그 패턴**이지, "고치기 전에 재현 테스트부터"라는 **사전(proactive) repro 패턴**이 아니다. 이는 §1 워크플로 `:64`의 권장과 few-shot 사이에 **불일치**가 있음을 뜻한다 — 프롬프트는 "before fixing, write a test"라 하지만 유일한 예시는 그걸 보여주지 않는다.

### 3-2. few-shot 의 주입 조건 (중요 — 항상 들어가지 않는다)

few-shot은 **non-native function calling 모델에만, 첫 user 메시지에만** 주입된다:

- `openhands-sdk/openhands/sdk/llm/mixins/fn_call_converter.py:398` `if is_first_user_message and add_in_context_learning_example:` 가드. `:399` `example = IN_CONTEXT_LEARNING_EXAMPLE_PREFIX(tools)`.
- `IN_CONTEXT_LEARNING_EXAMPLE_PREFIX = get_example_for_tools` (`fn_call_converter.py:75`), 실제 구현은 `fn_call_examples.py:333 def get_example_for_tools(...)` — **툴 조합별로 동적 조립**한 동일 Flask 예시(`fn_call_examples.py`의 `TOOL_EXAMPLES`에 같은 `python3 app.py > server.log`, `ModuleNotFoundError: ... flask`, `pip3 install flask` 리터럴 존재).
- 이 경로는 `mixins/non_native_fc.py:54 add_in_context_learning_example=add_iclex` 로만 활성. 즉 **native function-calling 모델(예: 최신 Claude/GPT)에는 이 few-shot이 아예 안 들어간다.** 따라서 reproduce 시점에 대한 few-shot의 영향력은 모델 종류에 따라 0이 될 수 있어, 비중을 낮게(~15%) 매긴다.

`.j2` 템플릿과 `fn_call_examples.py`의 리터럴은 동일 Flask 예시의 두 사본이다(`.j2`는 문서/스냅샷용, `.py`는 런타임 조립용).

---

## 4. reproduce 전용 로직이 코드에 있나 — 전수 확인

전수 grep (소스 루트):

```
grep -rniE "reproduc" --include="*.py"   → 코드 측 히트 전부 무관:
  context/prompts/sections/static.py:64   "reproduces AgentBase.static_system_message" (프롬프트 빌더 설명)
  context/prompts/sections/static.py:136  §2 프롬프트 텍스트 그 자체
  agent/base.py:480, 545                  "registry reproduces ... blocks" (직렬화 무관)
  conversation/impl/local_conversation.py:2182 "reproducing environment state from a saved conversation"
  critic/impl/api/critic.py:120           "for reproducibility" (event id 수집)
  examples/03_github_workflows/{posthog,datadog}_debugging.py  데모 태스크 설명 ("Attempt to reproduce the error")
```

```
grep -rniE "fail.?to.?pass|pass.?to.?pass"   → 0 건 (SWE-bench 오라클 키 부재)
grep -rniE "reproduction script|majority vot|n-sampl|dual.tree|self.consist"   → 0 건
grep -rniE "test.first|test-driven|\btdd\b"  → 실코드 히트는:
  tools/workflow/definition.py:114  strategies = ["minimal fix", "test-first", "security-focused"]
                                    ← map_agents 데모 docstring의 임의 전략 문자열, repro 엔진 아님
  context/prompts/sections/static.py:186 / system_prompt.j2:65  §1 프롬프트 텍스트
```

agent step 루프 검증: `agent/agent.py:542 def step(...)` 본문에 test/repro/verify/phase 분기 **없음** (조건문은 pending_actions, blocked_messages, condensation 처리뿐). 즉 에이전트 메인 루프는 reproduce를 **인지하지 못한다** — 그냥 LLM 턴을 돌릴 뿐.

**입증:** OpenHands agent-sdk에는 Agentless식 repro 엔진(N개 repro 후보 샘플링 → majority vote → dual-tree로 패치 검증)이 **없다.** repro/test-first는 오직 (1) `system_prompt.j2`/`static.py`의 워크플로 산문, (2) non-native FC 모델용 Flask few-shot에만 존재하며, **둘 다 실행 경로가 아니라 프롬프트 텍스트**다. 코드의 모든 "reproduce" 히트는 프롬프트 빌더 설명, 직렬화 용어, 데모 태스크 문구로 repro 메커니즘과 무관함을 확인.

---

## 5. 변종 프롬프트의 reproduce/test 흐름 차이

prompts 디렉토리 변종 전수:

- **system_prompt_long_horizon.j2** (`:1`): `{% include "system_prompt.j2" %}` 후 `<TASK_MANAGEMENT>` 추가만. PROBLEM_SOLVING_WORKFLOW를 그대로 상속하되 `task_tracker` 사용을 강하게 요구("ESSENTIAL", "unacceptable"). repro/test 흐름 자체는 base와 **동일** — 추가된 건 작업 분해·추적이지 repro 단계가 아님. `:13-26` 디버그 예시 워크플로조차 "Execute the test suite and resolve failures"로 **기존 테스트 실행**이지 repro 작성이 아님.
- **system_prompt_tech_philosophy.j2** (`:1` include + `<TECHNICAL_PHILOSOPHY>`): Linus Torvalds 멘탈모델(good taste/never break userspace/단순성). 5-layer 분석은 데이터구조·특수케이스·복잡도·호환성·실용성 검토 — **repro/test와 무관한 설계 리뷰 프레임워크.** repro 흐름은 base 상속, 변경 없음.
- **system_prompt_interactive.j2** (`:1` include + `<INTERACTION_RULES>`): `:7` "Check for existing solutions and test cases before creating new implementations" — *기존* 테스트 케이스 확인 권장이지 새 repro 작성 강제 아님. base 상속.
- **system_prompt_planning.j2**: base를 include하지 **않는** 독립 프롬프트(플래닝 전용 에이전트). `<PLANNING_WORKFLOW>` 4-Phase(이해→계획→합의→정련). 이 에이전트는 **코드를 쓰지 않고 PLAN.md만 작성**하므로 repro/test 단계가 **아예 없다** — `:35` "testing patterns" 탐색 언급은 계획 수립용 조사일 뿐.

종합: 어떤 변종도 repro/test를 base보다 **더 강하게 박지 않는다.** long_horizon/tech_philosophy/interactive는 base의 비강제 TESTING `:64`를 그대로 상속하고, planning은 repro 개념 자체가 없다. reproduce 시점 결정 메커니즘은 변종 간 **불변(invariant)**이며 전부 (b)+(c)+(d)에 의존한다.

---

## 6. 종합 — "OpenHands는 reproduce를 어느 시점에 하는가"

reproduce 시점은 **코드가 아니라 모델이, 프롬프트 권장을 참고해, 자율적으로** 정한다. 구체적으로:

1. **(a) 코드 강제 분기 = 없음.** step 루프·파이프라인·repro 엔진 전무. grep 입증 완료. → repro를 "반드시 N단계에서" 보장하는 장치 0.
2. **(b) system_prompt 권장 = 주력 레버이나 비강제.** `system_prompt.j2:64` "create tests to verify issues before implementing fixes"가 핵심 신호지만 MUST 부재 + 환경 조건부 출구(`:68-69`, `:74`) 존재. `:31` FILE_SYSTEM은 repro를 "단일 파일·확인 후 삭제할 임시 진단물"로 격하.
3. **(c) few-shot 습관 = 약함·조건부.** 유일 예시(Flask)는 reproduce가 아니라 build-run-debug 시연, 게다가 native FC 모델엔 미주입(`fn_call_converter.py:398`).
4. **(d) 모델 자율 = 잔여 책임 흡수.** 위가 전부 비강제·조건부라 실제 시점은 모델 판단에 위임.

Agentless/quanta가 repro를 오라클 루프의 1급 파이프라인 단계로 못 박는 것과 대조적으로, **OpenHands의 reproduce는 "프롬프트로 권장하고 모델에 맡기는" 순수 프롬프트-주도(prompt-steered) 방식**이며, repro 산출물을 패치 재평가에 되먹이는 코드 장치는 존재하지 않는다.
