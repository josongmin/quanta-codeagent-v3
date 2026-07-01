# ReProAgent 코드레벨 분석 (reproduction-test-generation scaffold)

소스: `/Users/songmin/quanta-codeagent-v3/.extracted_source/repro-scaffolds/reproagent/`
대상: SWT-bench Verified unit-test mode 69.7% (GPT-5-mini) 스캐폴드의 메커니즘 정밀 해부.
모든 주장은 실제 소스 file:line 인용으로 뒷받침. 증거태그: [verified]=코드 직접 확인, [inferred]=코드로부터 합리적 추론.

핵심 요약 (먼저 읽을 것):
- ReProAgent는 **fix를 만들지 않는다**. "reproduction test"(=버그를 드러내는 새 테스트 파일)만 생성한다. fix-as-oracle 루프는 `src/repair/`에 있으나 메인 파이프라인(`main.py`)에서 호출되지 않는 별도/오프라인 도구다 [verified].
- 메인 오라클은 "execution review"라는 **단일 LLM 호출 surrogate**다. 골드 패치 없이 테스트 1개를 채점한다. README가 말하는 "Triadic Review"는 3-voter 앙상블이 아니라 **1번 호출 안에서 3 dimension을 평가하는 unary review**다 [verified].
- Code Knowledge Graph는 tree-sitter+ast로 빌드해 msgpack으로 직렬화하고 in-memory로 로드한다. 단 **CALLS/REFERENCES edge는 실제로 비어있다**(tags 로딩이 비활성). 살아있는 것은 BELONGS_TO/HAS_METHOD/HAS_VARIABLE/INHERITS 구조 관계뿐 [verified].

---

## 1. Entry point & 전체 파이프라인

### 1.1 진입점과 per-instance 루프
- 진입점: `src/main.py:546` (`if __name__ == "__main__"`) → `asyncio.run(main(...))` (`src/main.py:628`).
- `main()`는 SWT-bench 데이터셋을 로드(`src/main.py:176`, `load_swebench_dataset`), instance/repo/range 필터(`src/main.py:186-219`), planner/generator 그래프 컴파일(`src/main.py:227-231`) 후 instance마다 루프(`src/main.py:241`).
- per-instance 절차(`src/main.py:255-316`):
  1. Docker 컨테이너 빌드/기동 (SWT-bench harness 경유, `build_and_start_container_swt`, `src/main.py:258`).
  2. 컨테이너 정보를 tools에 set (`set_container_info`, `src/main.py:267`).
  3. **Knowledge graph 빌드** (`construct_graph`, `src/main.py:275`) → `GRAPH_RETRIEVER.load(...)`로 메모리 로드(`src/main.py:279`).
  4. kg/tags msgpack 파일은 로드 직후 디스크에서 삭제(`src/main.py:286-289`). ← **honesty flag 참고**: `tags.msgpack`이 여기서 unlink되며 이후 관계 로딩이 없다.
  5. `EnvironmentService` 도커 모드 세팅(`src/main.py:310-314`).
  6. `PlannerState` 구성 후 `planner_graph.astream(...)`(`src/main.py:316-331`).
- 최종 검증(메인 측정 로직, `src/main.py:418-491`): 생성된 test에 대해 **before-patch**(buggy repo) 실행 결과와 **after-patch**(golden_code_patch 적용 후) 실행 결과를 SWT-bench harness로 재실행해 `fail_to_pass`/`fail_to_fail`/`pass_to_pass`를 계산(`calculate_transition_metrics`, `src/main.py:51-66`). 즉 **메인 채점은 골드 패치를 써서 사후 검증**하지만, 에이전트 자체는 골드를 못 본다 [verified].

### 1.2 Planner 그래프 (상위 스테이지, LangGraph)
`src/planner.py:236-252`의 그래프는 **선형**:
`START → initState → bugLocalization → rootCauseAnalyzer → testGenerationHintsGenerator → testGenerator → testAcceptor → END`.

각 스테이지 = 별도 agent 클래스:
- **Bug Localization** (`bug_localization`, `src/planner.py:58`) → `BugLocalizationAgent.localize_bugs` (`src/bug_localization_agent.py:19`). suspicious_locations(JSON) 산출.
- **Root Cause Analysis** (`root_cause_analysis`, `src/planner.py:93`) → `RootCauseAnalysisAgent.analyze_root_cause` (`src/root_cause_analysis_agent.py:19`). suspicious_locations를 입력으로 받음(`src/planner.py:104-108`).
- **Test Hints Generation** (`test_hints_generation`, `src/planner.py:115`) → `TestGenerationHintsAgent.generate_hints` (`src/test_generation_hints_agent.py:19`). README의 "Assertion-aware Test Planning".
- **Test Generator** (`test_generator`, `src/planner.py:136`) → generator sub-graph를 `ainvoke`(`src/planner.py:166`). hints/root_cause/suspicious_locations를 프롬프트 컨텍스트로 주입(`src/planner.py:149-164`).
- **Test Acceptor** (`test_acceptor`, `src/planner.py:192`) → 최종 test_cases/root_cause/hints 패키징.

각 ablation 토글(`enable_bug_localization` 등)은 해당 노드를 스킵하고 빈 결과 반환(`src/planner.py:67-71`, `96-100`, `118-122`). CLI 플래그 `--disable-*`로 제어(`src/main.py:598-621`).

### 1.3 Generator 서브그래프 (실행 피드백 루프, LangGraph)
`src/generator.py:522-568`:
```
START → init → testGenerator → codeExtractor
codeExtractor --(extract_checker)--> {testGenerator | failure=END | execution}
execution → executionReview
executionReview --(execution_review_checker)--> {feedbackIteration | reportGenerator}
feedbackIteration --(feedback_iteration_checker)--> {testGenerator | reportGenerator}
reportGenerator → END
```
- `testGenerator`(`src/generator.py:115`): `TestGenerationAgent.generate_test_case` 호출. feedback iteration이면 기존 messages 이어서 사용(`src/generator.py:133-142`).
- `codeExtractor`(`src/generator.py:173`): LLM 응답에서 코드블록 추출(`extract_code`). 실패 시 재요청 메시지 append, 실패 카운트 증가.
- `extract_checker`(`src/generator.py:213`): 추출 실패 10회면 `failure`→END(`MAX_CODE_EXTRACTION_FAILURES=10`, `src/generator.py:230`).
- `execution`(`src/generator.py:240`): test_case를 git diff로 변환(`code_to_patch`)해 **SWT-bench harness로 실행**(`execute_test_via_harness`, `src/generator.py:277`). status_map+stdout 반환.
- `executionReview`(`src/generator.py:310`): `ExecutionReviewAgent.review_execution` 호출(surrogate oracle). feedback off면 무조건 success로 통과(`src/generator.py:321-332`).
- `feedbackIteration`(`src/generator.py:397`): review의 `reasoning`을 다음 라운드 HumanMessage로 주입(`src/generator.py:447,463`).

### 1.4 Iteration caps (`src/config.py`)
- `MAX_BUG_LOCALIZATION_COUNT = 50` (`src/config.py:30`)
- `MAX_ROOT_CAUSE_ANALYSIS_COUNT = 50` (`src/config.py:31`)
- `MAX_TEST_HINTS_GENERATION_COUNT = 50` (`src/config.py:32`)
- `MAX_TEST_GENERATION_COUNT = 50` (`src/config.py:33`) — 단일 generate 호출 내 tool-call 루프 한도(`src/test_generation_agent.py:109`).
- `MAX_FEEDBACK_TIMES = 20` (`src/config.py:34`) — execution-review 피드백 라운드 한도(`src/generator.py:67`, checker `src/generator.py:481`).
- `RECURSION_LIMIT = 1024` (`src/config.py:6`), generator repair node retry `max_attempts=3 on ValueError` (`src/generator.py:526`).
- 모델: `gpt-5-mini`, `max_retries=10`, `timeout=1800` (`src/config.py:10-27`) [verified].

각 leaf agent는 동일 패턴의 **ReAct tool-call 루프**: while iteration < MAX, tool_calls 있으면 실행해 다시 LLM, 없으면 JSON/코드 파싱 시도; max 도달 시 "도구 없이 최종 JSON 내라"고 강제(`src/bug_localization_agent.py:69-165`, `src/test_generation_agent.py:114-210`, root_cause/hints도 동형 `src/root_cause_analysis_agent.py:76`, `src/test_generation_hints_agent.py:76`).

---

## 2. Code Knowledge Graph grounding (가장 중요)

### 2.1 그래프 빌드 & 직렬화
- 빌드 엔트리: `construct_tags.run` (`src/knowledge_graph/construct_tags.py:350`), `CodeGraph` 생성자가 `create_structure`로 전체 구조를 만들고(`construct_tags.py:51`), host path를 container path(`/testbed`)로 치환(`construct_tags.py:73-92`).
- **structure 파싱**은 Python `ast` 기반(`src/knowledge_graph/utils.py:281 parse_python_file`, `create_structure` `utils.py:330`). 노드 필드: name, full_qualified_name, absolute_path, start/end_line, content, class_type(`inner|normal`), parent_class, methods, constants, params, signature(`def name(args)`) (`utils.py:106-115, 168, 224-233`).
- **tags 추출**은 tree-sitter + pygments fallback(`construct_tags.py:161-292`). query로 `class_definition`/`function_definition`(def)와 `call`(ref) 캡처(`construct_tags.py:239-244`). 표준 라이브러리/builtin 함수는 필터링(`construct_tags.py:262`). Tag tuple: `(rel_fname, fname, line, name, kind, category, info)` (`construct_tags.py:26`).
- 직렬화: `STORAGE_BACKEND='msgpack'`(`src/config.py:50`). structure→`kg.msgpack`, tags→`tags.msgpack`(`construct_tags.py:65, 449`). **Neo4j는 아님** — README가 optional Neo4j를 언급하나 실제 코드 경로는 in-memory msgpack 전용(`src/knowledge_graph/in_memory_store.py:1-3` 주석 "Replaces Neo4j dependency") [verified].

### 2.2 In-memory store 적재 & 노드/엣지 타입
적재: `InMemoryGraphStore.load`(`in_memory_store.py:125`)가 `kg.msgpack`만 읽음. 디렉터리/파일 노드 재귀 순회(`_traverse_and_load` `in_memory_store.py:146`).

노드 타입(`in_memory_store.py:12-87`): `Clazz`, `Method`, `Variable`.

엣지/관계 인덱스(`in_memory_store.py:108-120`):
- `belongs_to`: method_name → class_name (적재 시 채워짐, `in_memory_store.py:231,311`).
- `has_method`: class_name → [method_names] (`in_memory_store.py:230`).
- `has_variable`: class_name → [var_names] (`in_memory_store.py:235`).
- `inherits`: class_name → parent (`in_memory_store.py:274`).
- `references`: 부분적으로만 — class 상수에 대해서만 setdefault(`in_memory_store.py:236`).
- `calls`: **선언만 되고 절대 채워지지 않음**(`in_memory_store.py:119`; population 코드 없음).

> 🔴 **CALLS/REFERENCES edge는 dead**. tree-sitter가 뽑은 call ref tag는 `tags.msgpack`에 있지만, 그것을 store로 로딩하는 `_load_relations_from_tags`는 **호출 자체가 주석 처리**돼 있다(`in_memory_store.py:134` "Note: ... would be called here if tags were needed"). 게다가 main이 로드 직후 `tags.msgpack`을 unlink(`src/main.py:288`). 따라서 `get_relevant_entities`의 CALLS(`in_memory_store.py:400-408`)와 대부분 REFERENCES는 항상 빈 리스트. **실제로 작동하는 그라운딩 = 구조 관계(소속/메서드보유/필드보유/상속)뿐** [verified].

### 2.3 LLM에 노출되는 tool surface
바인딩(`src/config.py:81-99`, `initialize_llm_with_tools`)에서 **실제 활성 도구는 6개만**:
- `find_related_entities` (KG), `search_files_smart` (KG+fs), `interactive_python`, `read_file`, `grep`, `glob`, `bash`.
- 나머지 graph_tool들(`find_methods_by_name`, `analyze_file_structure`, `get_class_constructor`, `find_variable_by_name`, `get_class_field_variables`)은 **주석 처리되어 미바인딩**(`src/config.py:82-97`). 코멘트: "find_methods_by_name 결과 과다→입력 폭증"(`config.py:84`). 즉 LLM이 직접 부르는 KG 도구는 사실상 `FindRelatedEntities`와 `SearchFilesSmart` 둘뿐 [verified].

활성 KG 도구 정의(`src/tools/graph_tool.py`):
- `FindRelatedEntities(file_path, full_qualified_name, max_results=10)` (`graph_tool.py:215`): `get_relevant_entities` 래핑. BELONGS_TO/CALLS/HAS_METHOD/HAS_VARIABLE/INHERITS/REFERENCES dict 반환(앞 절대로 CALLS/REFERENCES는 빈 값). 결과는 30으로 cap(`graph_tool.py:235`).
- `SearchFilesSmart(keywords, ...)` (`graph_tool.py:75`): Phase1 KG content keyword 검색(`search_file_by_keyword`, `in_memory_store.py:586` — 모든 노드 content를 lower-substring 스캔하는 O(N) brute force), 결과 부족 시 Phase2 filesystem `os.walk`(`graph_tool.py:138-171`). 파일명 매치 우선순위(`graph_tool.py:179-197`).

store가 지원하지만 LLM엔 노출 안 되는 내부 쿼리들(`graph_retriever.py`): `search_method_accurately`(`graph_retriever.py:103`), `search_method_fuzzy`(`:109`), `search_constructor_in_clazz`(`:143`), `search_methods_by_class_and_name`(`:158`), `search_variable_query`(`:174`), `search_field_variables_of_class`(`:187`), `read_all_classes_and_methods`(`:137`).

### 2.4 프롬프트로의 주입
KG는 LLM에 **tool-call 결과(ToolMessage)로** 주입된다. 별도 정적 컨텍스트 주입은 suspicious_locations/root_cause/hints 텍스트뿐(`src/planner.py:209-233`이 JSON을 프롬프트 섹션으로 직렬화). 즉 그라운딩의 표면적은 "LLM이 능동적으로 `FindRelatedEntities`/`SearchFilesSmart`를 호출 → 구조 관계/파일후보를 받음"이며, 그 외 심볼 본문 읽기는 `read_file`/`grep`/`interactive_python`로 일반적으로 처리 [verified/inferred].

---

## 3. Execution feedback loop (surrogate oracle)

### 3.1 실행 방식
- 모든 test 실행은 **SWT-bench harness 경유 Docker**: `EnvironmentService.execute_test_via_harness`(`src/environment_service.py:794`). `make_test_spec`→`exec_spec`에 run_id/patch_id(sha256)/test_directives/timeout/patch_list 세팅(`environment_service.py:821-832`) → `run_eval_exec_spec`(`environment_service.py:836`) → `get_logs_eval`로 status_map 파싱(`environment_service.py:853`). 반환: `{status_map, raw_output, log_file, found}`(`environment_service.py:875`).
- status_map 값: `"PASSED"|"FAILED"|"ERROR"|"SKIPPED"` per test(`environment_service.py:814`).

### 3.2 ExecutionReviewAgent — surrogate oracle 핵심
`src/execution_review_agent.py`:
- 분기(`review_execution`, `:30`): status_map가 비었거나 전부 PASSED/SKIPPED면 **LLM 없이** 결정(`_handle_passed_tests`, `:100`). 빈 map=system error→regenerate; all-pass=버그 미재현→regenerate(둘 다 `issue_reproduced_successfully: False`, confidence 1.0).
- FAILED/ERROR가 있으면 **LLM 1회 호출**(`_analyze_test_failure`, `:136`). 프롬프트=`EXECUTION_REVIEW_PROMPT_TEMPLATE`(`src/prompt_template.py:177`).
- **verdict schema**(`prompt_template.py:250-256`):
  ```
  issue_reproduced_successfully: boolean
  confidence_score: float 0.0-1.0
  reasoning: str
  suggestion: str
  recommended_action: "report_success" | "regenerate_test"
  ```
- LLM은 골드 패치/실 fix 없이 **세 dimension**을 추론으로 판정(`prompt_template.py:212-238`):
  1. Bug Reproduction Check — 실패가 issue/root_cause/suspicious_locations와 일치하는가.
  2. Test Logic Soundness — assertion이 post-fix(올바른) 동작을 검증하는가, `assert False` 같은 합성 실패 아닌가.
  3. **POST-FIX VIABILITY** — "fix 후에도 이 테스트가 통과할 수 있는가?" 구조적으로 불가능한 패턴(lambda 직렬화 등)이면 unviable로 reject.
- 파싱 실패/예외 시 **보수적으로 regenerate**로 fallback(`execution_review_agent.py:201-214, 235-250`). confidence_score는 산출되지만 **임계값 게이팅에 쓰이지 않는다** — 분기는 오직 `issue_reproduced_successfully` boolean(`src/generator.py:387-394`)에 의존 [verified].

### 3.3 repair 라운드 수 / 피드백 내용
- 피드백 라운드 한도 `MAX_FEEDBACK_TIMES=20`(`config.py:34`). 매 라운드 review의 `reasoning`(실행 stdout/stderr 일부 + suggestion 포함, `execution_review_agent.py:216-223`)을 다음 generation의 HumanMessage로 주입(`generator.py:447,463`).
- max 도달 시 마지막 실행 결과로 reportGenerator 진입(`generator.py:432-443`).
- 컨테이너 격리: generation 단계 execution은 harness가 fresh run_id로 실행(`generator.py:280`). 별도 isolated container API도 있음(`environment_service.py:561,624`)이나 메인 generation 경로는 harness 경유 [verified].

> 핵심: **이 surrogate oracle이 ReProAgent의 진짜 lever**다. fix가 없으므로 "테스트가 fix 후 통과할지"를 LLM이 추론으로 대리 판정하고, 그 판정으로 regenerate를 20회까지 돌린다. cheap model(gpt-5-mini)이 강한 이유의 후보 #1 [inferred].

---

## 4. Selection / oracle — fix 없을 때 무엇을 고르나

- **메인 파이프라인은 best-of-N voting이 없다.** generator는 test_case **1개**를 iterative refine으로 수렴시킨다(planner `test_cases` 리스트지만 generator는 단일 test_case 산출, `src/planner.py:170-189`). 선택 = "execution review가 success라고 판정한 그 테스트" 또는 max-feedback 도달 시 마지막 테스트.
- 즉 oracle = §3의 unary execution review. 다후보 투표/스코어링 부재 [verified].

### README "Triadic Review" 검증
- README `README.md:14`: "Test Generation via Triadic Review".
- 실제: **3-voter 앙상블 아님**. `EXECUTION_REVIEW_PROMPT_TEMPLATE`(`prompt_template.py:177-258`)는 **단일 LLM 호출**이 "THREE dimensions"(Bug Reproduction / Test Logic Soundness / Post-fix Viability)를 평가하라는 **unary review**. "Triadic"=3차원 평가지 3중 투표가 아니다 [verified]. grep으로 ensemble/voter/voting 식별자 없음 확인.

### src/repair/ 는 무엇인가 (test-selection 아님, 별도 fix harness)
- `src/repair/`는 **메인 reproduction 파이프라인과 무관한 오프라인 fix-validation 도구**다. `main.py`/`planner.py`/`generator.py`는 `repair`를 import하지 않음(grep 확인). 각 파일이 자체 `if __name__=="__main__"` + argparse를 가짐.
- `repair/pipeline.py`: localize→repair(old_str/new_str JSON 편집)→patch→test 5라운드(`MAX_ITERATIONS=5`, `pipeline.py:59`). 생성된 reproduction_test(또는 gold testing patch)로 **fix를 검증**하고, 최종에 `passed_tests_count` 최대인 best iteration 패치 선택(`pipeline.py:988-994`). DeepSeek 엔드포인트 하드코딩(`pipeline.py:264`).
- `repair/agent.py`: LangGraph 기반 fix agent. tools=`bash, submit, text_editor`(`agent.py:16`), 모델 glm-4.6 하드코딩(`agent.py:47`), feedback 5라운드(`agent.py:85`). reproduction_test를 "make this test pass" 오라클로 사용(`agent.py:169-179`), "테스트가 결함일 수 있으니 confident하면 무시 가능"이라는 흥미로운 hedge 프롬프트 포함(`agent.py:177-179`).
- 결론: repair/는 "생성한 reproduction test를 fix-as-oracle로 재활용하는 별도 실험 harness". 우리(quanta)의 fix-as-oracle 구상과 직접 매핑되는 참고 코드 [verified].

---

## 5. swtbench / swebench 어댑터

### swtbench/ (메인이 쓰는 경로)
- 데이터셋 로더: `src/swtbench/dataset.py:136 load_swebench_dataset`. SWT 필터 파일(`swt_filter_cases_*.txt`, `:14-16`)로 instance 제외(`:156-157`). instance에 `golden_code_patch`(orig `patch`)와 `golden_test_patch`(orig `test_patch`) 매핑(`:127-133`).
- harness: `src/swtbench/run_evaluation.py`(`run_instance` `:135`, `run_eval_exec_spec` `:199`), exec_spec/test_spec(`exec_spec.py`, `test_spec.py`), log 파서(`log_parsers.py`), grading(`grading.py`), `constants.py`에 `MAP_REPO_TO_TEST_FRAMEWORK`/`REPO_TO_TEST_DIR_MAP`(`src/planner.py:15,145`에서 사용).
- 테스트 파일 경로 규약: `{test_dir}/test_repro_agent_{instance_id}.py`(`planner.py:145-146`, `main.py:424`).
- 평가 CLI: `python -m src.swtbench.run_evaluation`(`README.md:138`).

### swebench/ (repair/만 사용)
- `src/swebench/harness/`(constants/run_evaluation/test_spec)는 **repair/pipeline.py만** import(`pipeline.py:37-45`). gold testing patch 모드에서 `make_test_spec`+`run_instance`로 FAIL_TO_PASS 검증(`pipeline.py:852-883`). 메인 reproduction 파이프라인은 swtbench harness만 사용.

---

## 6. 우리(quanta)가 흡수 가능한 메커니즘 — 랭킹

### #1 (최우선) Execution-review surrogate oracle = fix-as-oracle의 cheap 대체
- **무엇**: 골드/실 fix 없이 "이 테스트가 (a) 현재 버그로 fail하고 (b) fix 후 pass할 것인가"를 LLM 1회로 판정(`prompt_template.py:208-256`, `execution_review_agent.py:136-233`). verdict={issue_reproduced_successfully, confidence_score, recommended_action, suggestion}.
- **우리 매핑**: 우리 acceptance/best-of-N seam의 **soft-rerank/accept 신호**로 직접 붙는다. 특히 "POST-FIX VIABILITY" 차원은 우리가 repro를 만들 때 over-narrow/answer-key 테스트를 거르는 데 유용(구조적 unviability reject). 우리 fix-as-oracle 실루프가 비싸므로, 그 **앞단 cheap pre-filter**로 두면 ROI 큼.
- **주의/차용 시 가드**: confidence_score는 ReProAgent에선 게이팅에 안 쓰임(boolean만 본다). 우리도 confidence를 임계 하드게이트로 쓰면 위험(no-heuristics 원칙). suggestion→다음 라운드 feedback 주입(`execution_review_agent.py:216-223`)이 깔끔한 패턴.

### #2 구조-관계 그라운딩을 generation feedback에 주입 (semantica-codegraph 매핑)
- **무엇**: `FindRelatedEntities`(BELONGS_TO/HAS_METHOD/HAS_VARIABLE/INHERITS)로 타깃 심볼의 클래스 소속/형제 메서드/필드/상속을 LLM tool-result로 흘림(`graph_tool.py:215-260`, `in_memory_store.py:360-460`).
- **우리 매핑**: 우리 `semantica-codegraph` 정적 백엔드가 **CALLS/callers/inheritance를 실제로 채울 수 있으면** ReProAgent의 dead-edge 약점을 그대로 능가. ReProAgent는 caller/call edge를 못 살렸다(§7). 우리는 이미 caller recall(14315 witness)을 가진다 → "test가 호출해야 할 진짜 entry point" 그라운딩에서 우위.
- **주입 형태**: 정적 컨텍스트 prepend가 아니라 **tool-result on demand**가 ReProAgent 방식. 입력 폭증을 막으려 max_results 30 cap + 일부 도구 비활성(`config.py:82-97`)한 점을 교훈으로(우리도 fanout cap 필요).

### #3 Test Planning(hints)을 generation과 분리한 스테이징
- **무엇**: localization→root_cause→**assertion-aware hints**→generation 선형 파이프(`planner.py:236-252`). hints가 "어떤 assertion으로 어떤 코드패스를 쳐라"를 미리 합성.
- **우리 매핑**: 우리 synthesis 수렴 병목(MEMORY: jun-29)에 직접 대응. generation 직전 별도 hints 스테이지가 "맞는 파일 짚고 edit 수렴 실패"를 줄이는 후보 lever. 단 n=1 변경 금지(measure-first).

### #4 Feedback loop의 outcome 분류 (passed/failed/system_error)
- **무엇**: status_map→{system_error|passed|failed|unknown} 분류(`generator.py:419-429`)로 빈 status_map(런 자체 실패)과 진짜 미재현을 구분. 우리 leaderboard throttle/empty-patch 혼동(MEMORY: jun-20) 방지에 동형 유용.

### #5 repair/의 fix-as-oracle hedge 프롬프트
- "이 reproduction test가 결함일 수 있으니, fix가 옳다고 확신하면 test 실패를 무시하고 재제출하라"(`agent.py:177-179`). 우리 fix-as-oracle 루프가 **잘못된 repro에 갇히지 않게** 하는 escape valve로 차용 가치.

---

## 7. 코드가 보여주지 않는 것 / honesty flags

1. 🔴 **CALLS/REFERENCES edge는 사실상 dead.** `self.calls`는 절대 채워지지 않고(`in_memory_store.py:119`, population 없음), tags 로딩(`_load_relations_from_tags`)이 주석 비활성(`in_memory_store.py:134`)이며 `tags.msgpack`은 로드 직후 삭제(`main.py:288`). 따라서 README/구조가 시사하는 "call graph 그라운딩"은 **구조 관계만** 살아있고 호출/참조 그래프는 빈 값. ReProAgent의 KG 그라운딩은 우리가 흔히 상상하는 caller/callee 그래프가 아니라 **클래스-멤버 구조 그래프**다 [verified].

2. **"Triadic Review"는 마케팅 네이밍.** 3-voter 앙상블이 아니라 단일 호출 3-dimension 평가(§4). 다후보 투표/스코어 집계 없음 [verified].

3. **메인 채점은 golden_code_patch를 사용.** `calculate_transition_metrics`(`main.py:51`)의 before/after는 골드 패치 적용 결과(`main.py:437` `apply_patch_via_harness(golden_patch=patch)`). 즉 69.7% 같은 **fail_to_pass 측정은 골드 기반 검증**이고, 에이전트의 self-judgment(execution review)와는 별개. surrogate oracle의 정확도 자체는 이 코드에서 직접 측정/노출되지 않는다(에이전트 verdict vs 골드 검증의 일치율 로깅 없음) [verified/inferred].

4. **활성 KG 도구는 2개뿐.** 7개 graph_tool 중 5개가 입력 폭증 이유로 비활성(`config.py:82-97`). "풍부한 KG 도구셋"이라는 인상과 달리 LLM이 실제 쥐는 KG 표면은 `FindRelatedEntities`+`SearchFilesSmart`로 좁다 [verified].

5. **`SearchFilesSmart`의 KG 검색은 O(N) brute-force substring**(`in_memory_store.py:586-614`, 모든 노드 content를 lower()로 스캔). 인덱스 기반이 아님 — 대형 repo에서 느리고, 사실상 `grep`과 중복. 정적 분석의 강점(symbol-aware)을 못 살림 [verified].

6. **repair/는 메인과 단절된 별도 코드.** 모델 엔드포인트(DeepSeek `pipeline.py:264`, glm-4.6 `agent.py:47`)와 데이터 파일(`data/swebench-*.jsonl`)이 하드코딩돼 있어 그대로 재현 불가. 참고 설계로만 유효 [verified].

7. **gpt-5-mini 69.7%의 인과는 코드만으로 단정 불가.** 코드는 (a) surrogate oracle 20-라운드 refine, (b) 구조 그라운딩, (c) hints 스테이징이 켜져 있음을 보여주지만, 어느 컴포넌트가 점수에 얼마나 기여하는지는 ablation 로그(`outputs_gpt_5_mini/`)를 까봐야 함. claim-100/synthesis 의심 원칙에 따라 "surrogate oracle이 lever"는 **inferred**로 둔다.

---

## 부록: 파일 인덱스 (인용 핵심)
- 파이프라인 오케스트레이션: `src/main.py`, `src/planner.py`, `src/generator.py`
- 설정/캡: `src/config.py`
- KG: `src/knowledge_graph/construct_tags.py`(빌드), `src/knowledge_graph/utils.py`(ast 파싱), `src/knowledge_graph/in_memory_store.py`(적재/쿼리), `src/graph_retriever.py`(facade), `src/tools/graph_tool.py`(LLM 도구)
- Oracle: `src/execution_review_agent.py`, `src/prompt_template.py:177`(EXECUTION_REVIEW_PROMPT_TEMPLATE)
- Agents: `src/bug_localization_agent.py`, `src/root_cause_analysis_agent.py`, `src/test_generation_hints_agent.py`, `src/test_generation_agent.py`
- 실행/도커: `src/environment_service.py:794`(execute_test_via_harness), `src/docker_container_manager.py`
- fix harness(별도): `src/repair/pipeline.py`, `src/repair/agent.py`
- 벤치 어댑터: `src/swtbench/`(메인), `src/swebench/`(repair만)
