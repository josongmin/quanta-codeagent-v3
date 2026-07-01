# Echo (Prometheus) reproduction-test-generation scaffold — code-level analysis

분석 대상: `/Users/songmin/quanta-codeagent-v3/.extracted_source/repro-scaffolds/echo/`
논문: "Graph-Enhanced Retrieval and Execution Feedback for Issue Reproduction Test Generation" (Echo, SWT-bench Verified 66.3%, Gemini 2.5 Pro).

> **가장 중요한 honesty flag (먼저 읽을 것) [verified]**: 이 공개 코드는 내부 `env_prefix="PROMETHEUS_"` ([config.py:8](../../../../.extracted_source/repro-scaffolds/echo/app/configuration/config.py#L8)), 로거 이름 `prometheus.*` ([bug_reproduction_context_message_node.py:113](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/nodes/bug_reproduction_context_message_node.py#L113)), main 모듈 docstring "Prometheus Bug Reproduction Agent" ([main.py:1](../../../../.extracted_source/repro-scaffolds/echo/app/main.py#L1))에서 보이듯 **Prometheus 코드베이스**다. README만 "Echo"로 리브랜딩되어 있다. 그리고 논문이 핵심으로 내세운 두 메커니즘 — **(a) self-generated fix patch as oracle, (b) dual-version check(원본 vs 패치 적용본에서 테스트 실행)** — 이 레포 코드에는 **존재하지 않는다**. grep으로 fix-patch 생성/golden-patch apply/dual-version 실행 노드를 전수 조사했으나 없음([grep 결과](#7-코드가-보여주지-않는-것--honesty-flags)). 즉 이 공개본은 논문 Echo의 **ablation 하한(graph + execution-feedback, 단일 버전 LLM judge)** 에 해당하는 베이스라인이며, 논문이 +7.16pt로 보고한 refinement loop의 일부(context-refine)만 들어 있고, oracle 부분은 빠졌다. 아래 모든 판단은 이 전제 위에 있다.

---

## 1. Entry point & full pipeline

진입점 `app/main.py`. 흐름 [verified]:

1. `main()` (click CLI) → `async_main()` → 데이터셋 로드, 인스턴스 필터, semaphore concurrency ([main.py:452-513](../../../../.extracted_source/repro-scaffolds/echo/app/main.py#L452), [main.py:430-441](../../../../.extracted_source/repro-scaffolds/echo/app/main.py#L430)).
2. `process_issue()`: SWE-bench row에서 `problem_statement` 첫 줄을 title, 나머지를 body로 분리. SWE-bench eval Docker 이미지명을 `swebench/sweb.eval.x86_64.{...}` 포맷으로 구성 ([main.py:312-320](../../../../.extracted_source/repro-scaffolds/echo/app/main.py#L312), [main.py:42](../../../../.extracted_source/repro-scaffolds/echo/app/main.py#L42)). `issue_comments`는 항상 `[]`로 넘어감 ([main.py:331](../../../../.extracted_source/repro-scaffolds/echo/app/main.py#L331)).
3. `reproduce_bug()`: repo clone → **knowledge graph build + Neo4j 저장** (`build_and_save_knowledge_graph`) → Neo4j에서 다시 읽어 in-memory `KnowledgeGraph` 복원 → 컨테이너 워크 → 끝나면 KG/repo 삭제 ([main.py:230-274](../../../../.extracted_source/repro-scaffolds/echo/app/main.py#L230)).
4. `_reproduce_bug()`: 컨테이너 빌드/기동/`run_build`, 그리고 `BugReproductionSubgraph.invoke()`로 LangGraph state machine 실행 ([main.py:118-152](../../../../.extracted_source/repro-scaffolds/echo/app/main.py#L118)).
5. 반환물: `reproduced_bug(bool)`, `reproduced_bug_file`, `reproduced_bug_commands`, `reproduced_bug_patch`(= 재현 테스트 diff 그 자체) ([main.py:168-173](../../../../.extracted_source/repro-scaffolds/echo/app/main.py#L168), [bug_reproduction_subgraph.py:243-248](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/subgraphs/bug_reproduction_subgraph.py#L243)).

### 논문 6-stage ↔ 실제 코드 매핑 [verified/inferred]

`BugReproductionSubgraph` 의 LangGraph 노드 배선 ([bug_reproduction_subgraph.py:148-209](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/subgraphs/bug_reproduction_subgraph.py#L148)):

| 논문 stage | 실제 노드 | 비고 |
|---|---|---|
| (1) context retrieval | `issue_bug_reproduction_context_message_node` → `context_retrieval_subgraph_node` | KG 검색 + query refine 루프 [verified] |
| (2) patch generation | — | **없음(공개본 미구현)**. self-fix patch 생성 노드 부재 [verified] |
| (3) test generation | `bug_reproducing_write_node` (+ `bug_reproducing_file_node`로 파일 작성) | 재현 테스트 1개 작성 [verified] |
| (4) autonomous execution | `update_container_node` → `bug_reproducing_execute_node` | 컨테이너에서 테스트 실행 [verified] |
| (5) test verification | `bug_reproducing_structured_node` | LLM이 "이슈대로 fail했나" 판정 [verified] |
| (6) dual-version check | — | **없음**. 단일 버전(버그 코드)만 실행 [verified] |

실패 시 retry 루프: `structured_node`가 `reproduced_bug=False` → file/execute 메시지 reset → `git_reset_node` → 다시 `bug_reproducing_write_message_node` ([bug_reproduction_subgraph.py:197-209](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/subgraphs/bug_reproduction_subgraph.py#L197)). 이 retry에는 명시적 횟수 cap이 없고 LangGraph `recursion_limit=150`으로만 제한 ([bug_reproduction_subgraph.py:219](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/subgraphs/bug_reproduction_subgraph.py#L219)) [verified].

---

## 2. Graph-enhanced retrieval (핵심)

파일: `app/graph/graph_types.py`, `knowledge_graph.py`, `file_graph_builder.py`, `app/neo4j/knowledge_graph_handler.py`, `app/tools/graph_traversal.py`.

### Node/Edge 타입 [verified]
Node 3종 ([graph_types.py:8-51](../../../../.extracted_source/repro-scaffolds/echo/app/graph/graph_types.py#L8)):
- `FileNode(basename, relative_path)` — 파일/디렉토리
- `ASTNode(type, start_line, end_line, text)` — tree-sitter 노드. `type`은 tree-sitter 문법 타입(예: `function_definition`), `text`는 해당 소스 조각
- `TextNode(text, start_line, end_line)` — md/txt/rst 청크

Edge 5종 ([graph_types.py:126-133](../../../../.extracted_source/repro-scaffolds/echo/app/graph/graph_types.py#L126)):
- `HAS_FILE` (dir→file), `HAS_AST` (file→AST root), `HAS_TEXT` (file→text chunk), `PARENT_OF` (AST→AST 부모자식), `NEXT_CHUNK` (text→다음 text)

### "정말 file+AST+text-chunk이고 semantic call graph가 아닌가?" → **그렇다 [verified]**
edge enum에 call/import/reference/def-use 가 **전혀 없다**. `PARENT_OF`는 호출 관계가 아니라 **AST 트리 구조상 부모-자식**일 뿐 ([graph_types.py:129](../../../../.extracted_source/repro-scaffolds/echo/app/graph/graph_types.py#L129), [file_graph_builder.py:166-169](../../../../.extracted_source/repro-scaffolds/echo/app/graph/file_graph_builder.py#L166)). 함수 A가 함수 B를 부른다는 cross-file/cross-symbol 엣지는 생성되지 않는다. 그래프는 본질적으로 **{디렉토리 트리} + {파일별 얕은 AST 트리} + {문서 청크 체인}** 의 3중 트리 합집합이다.

추가로 치명적인 한계: 기본 설정 `KNOWLEDGE_GRAPH_MAX_AST_DEPTH=1` ([example.env:12](../../../../.extracted_source/repro-scaffolds/echo/example.env#L12), [file_graph_builder.py:150-151](../../../../.extracted_source/repro-scaffolds/echo/app/graph/file_graph_builder.py#L150)). depth 1이면 파일 AST root + **직계 자식(top-level def/class 한 겹)** 만 노드화된다. 즉 함수 본문 내부 구조는 그래프에 거의 안 들어가고, ASTNode는 사실상 "파일 안의 top-level 심볼 목록" 수준 [verified/inferred].

### 저장 = Neo4j, 그러나 query-time 검색은 Neo4j가 아니다 [verified]
- 쓰기: `write_knowledge_graph()`가 `UNWIND ... CREATE` Cypher로 노드/엣지를 벌크 적재 ([knowledge_graph_handler.py:173-191](../../../../.extracted_source/repro-scaffolds/echo/app/neo4j/knowledge_graph_handler.py#L173)).
- 읽기: `read_knowledge_graph()`가 root에서 도달 가능한 **모든** node/edge를 `MATCH (root)-[*]->(n)` 로 통째로 끌어와 in-memory `KnowledgeGraph.from_neo4j()`로 재구성 ([knowledge_graph_handler.py:403-426](../../../../.extracted_source/repro-scaffolds/echo/app/neo4j/knowledge_graph_handler.py#L403), [knowledge_graph.py:167-253](../../../../.extracted_source/repro-scaffolds/echo/app/graph/knowledge_graph.py#L167)). 즉 **Neo4j는 직렬화/덤프-리로드 스토어**로 쓰이지, 질의 시점에 Cypher 검색을 돌리지 않는다.
- 실제 retrieval: `GraphTraversalTool`이 in-memory 리스트를 **Python substring 매칭**으로 훑는다. 예: `find_ast_node_with_text_in_file`은 `if text in current_node.node.text` ([graph_traversal.py:272](../../../../.extracted_source/repro-scaffolds/echo/app/tools/graph_traversal.py#L272)), `find_text_node_with_text`도 `text in node.node.text` ([graph_traversal.py:421](../../../../.extracted_source/repro-scaffolds/echo/app/tools/graph_traversal.py#L421)). 결과는 최대 5개(`MAX_RESULT=5`)로 잘림 ([graph_traversal.py:13](../../../../.extracted_source/repro-scaffolds/echo/app/tools/graph_traversal.py#L13)).

### "Cypher? traversal? embeddings?" → **embedding 없음, semantic 검색 없음 [verified]**
임베딩/벡터 인덱스/유사도 검색 코드는 전무하다. 검색 프리미티브는 (a) basename/relative_path **정확 일치**, (b) AST text **대소문자 구분 substring 포함**, (c) AST node `type` 정확 일치, (d) text node substring 포함, (e) `read_code`/`preview` 류 — 전부 문자열·경로 매칭이다 ([graph_traversal.py:202-587](../../../../.extracted_source/repro-scaffolds/echo/app/tools/graph_traversal.py#L202)). LLM이 이 툴들을 골라 호출하는 **agentic tool-use 검색**이고, 그래프 위상은 "파일트리 프린트 + AST 타입 목록"을 시스템 프롬프트에 주는 데만 기여한다([context_provider_node.py:116-119](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/nodes/context_provider_node.py#L116)).

### 자동 query-refinement 루프 [verified]
`ContextRetrievalSubgraph` ([context_retrieval_subgraph.py:79-115](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/subgraphs/context_retrieval_subgraph.py#L79)):
`context_query_message_node` → `context_provider_node`(KG 툴 호출 agentic loop) → `context_extraction_node`(LLM이 관련 라인 범위로 요약·압축, [context_extraction_node.py:146-227](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/nodes/context_extraction_node.py#L146)) → `context_refine_node`. refine 노드는 file_tree+누적 context를 보고 "더 필요한가?"를 LLM 구조화 출력으로 판단해 `refined_query`가 비어있지 않으면 provider로 되돌아간다 ([context_refine_node.py:104-124](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/nodes/context_refine_node.py#L104), [context_retrieval_subgraph.py:108-112](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/subgraphs/context_retrieval_subgraph.py#L108)). 루프 상한 `max_refined_query_loop=2` ([bug_reproduction_subgraph.py:239](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/subgraphs/bug_reproduction_subgraph.py#L239), 카운트다운 [context_refine_node.py:116-117](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/nodes/context_refine_node.py#L116)).

### focal code + example test가 generation prompt에 주입되는 방식 [verified]
- 최초 검색 쿼리의 **OBJECTIVE가 "버그와 유사한 기존 테스트 케이스 5개를 import/fixture/assertion 포함해서 찾아라"** 이다 ([issue_bug_reproduction_context_message_node.py:9-13](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/nodes/issue_bug_reproduction_context_message_node.py#L9)). 즉 retrieval의 1차 타깃이 focal code가 아니라 **few-shot 예시 테스트**다.
- 검색된 context는 `bug_reproducing_write_message_node`의 `FIRST_HUMAN_PROMPT`에 `Bug reproducing context:` 블록으로 통째 삽입되어 테스트 작성 LLM에게 전달 ([bug_reproducing_write_message_node.py:11-18](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/nodes/bug_reproducing_write_message_node.py#L11), [bug_reproducing_write_message_node.py:38-47](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/nodes/bug_reproducing_write_message_node.py#L38)).
- write 시스템 프롬프트는 "유사 테스트 스타일을 따라 minimal assertion 테스트를 써라"는 QA-expert 페르소나 + 인라인 few-shot ([bug_reproducing_write_node.py:15-113](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/nodes/bug_reproducing_write_node.py#L15)).
- 참고: `bug_reproduction_context_message_node.py`(3개 버전, [L9-12](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/nodes/bug_reproduction_context_message_node.py#L9))도 있으나 subgraph는 **`Issue...` (5개 버전)** 를 배선함 ([bug_reproduction_subgraph.py:59](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/subgraphs/bug_reproduction_subgraph.py#L59)). dead-code 가능성 [inferred].

### 의존성 추적: import-chasing인가 call-edge인가? → **둘 다 아님 [verified]**
그래프에 import/call 엣지가 없으므로 **구조적 의존성 추종은 불가능**하다. 의존성을 따라가려면 LLM이 (a) `read_code`로 파일을 읽고 import 줄을 눈으로 본 뒤 (b) 다음 검색 쿼리(`find_file_node_with_basename` 등)를 스스로 발행해야 한다. 즉 "import-chasing"이 일어난다면 **그래프가 아니라 LLM 에이전트의 멀티턴 tool-call**이 하는 것이고, 그래프는 매칭 인덱스 + 파일트리 컨텍스트만 제공한다 ([context_provider_node.py:36-86](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/nodes/context_provider_node.py#L36)).

---

## 3. Self-generated patch as oracle → **공개본에 없음 [verified]**

논문은 Echo가 자체 후보 fix patch를 만들어 "원본에서 fail / 패치본에서 pass"로 재현 테스트를 검증한다고 기술한다. 이 레포에서:
- fix-patch 생성 노드/프롬프트 부재. patch 관련 식별자는 전부 `bug_reproducing_patch`(재현 테스트 자체의 diff)와 `reproduced_bug_patch` 뿐 ([bug_reproduction_state.py:23](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/subgraphs/bug_reproduction_state.py#L23)).
- `git_repository.apply_patch()`는 존재하지만 ([git_repository.py:140-141](../../../../.extracted_source/repro-scaffolds/echo/app/git/git_repository.py#L140)) subgraph 어디서도 fix patch를 apply하는 호출 경로가 없다(전수 grep 결과 7-절 참조).
- "dual-version check"(원본 vs 패치 적용본 2회 실행)도 실행 노드가 1개(`bug_reproducing_execute_node`)뿐이라 구현 불가 ([bug_reproduction_subgraph.py:96-103](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/subgraphs/bug_reproduction_subgraph.py#L96)).

**결론**: 공개본의 "oracle"은 self-patch가 아니라 **LLM judge(§5)** 다. self-patch surrogate oracle은 논문 기여이지만 코드로 재현 불가.

---

## 4. Execution feedback loop

- 실행 툴: `ContainerCommandTool.run_command` — 컨테이너에서 임의 셸 명령 실행 후 출력 반환 ([container_command.py:36-43](../../../../.extracted_source/repro-scaffolds/echo/app/tools/container_command.py#L36)). 컨테이너는 pexpect 기반 ([README.md:135](../../../../.extracted_source/repro-scaffolds/echo/README.md#L135), `app/docker/`).
- `bug_reproducing_execute_node`: 먼저 patch가 **새 파일 정확히 1개만 추가**했는지 강제 검증(파일 삭제/기존 파일 수정/0개·2개 추가면 에러) ([bug_reproducing_execute_node.py:76-86](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/nodes/bug_reproducing_execute_node.py#L76)). 그 후 LLM이 "이 단일 테스트 파일만 실행하라"는 강한 시스템 프롬프트로 명령을 구성·실행 ([bug_reproducing_execute_node.py:19-34](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/nodes/bug_reproducing_execute_node.py#L19)). 의존성은 필요시 설치 허용.
- **verifier가 판정하는 것(LLM judge)**: `bug_reproducing_structured_node`. `reproduced_bug=True` 조건 = 테스트가 (1) fail하고 (2) **이슈에 기술된 것과 정확히 같은 방식으로** fail하며 (3) 이슈의 예시를 그대로 쓰고 (4) 같은 근본 문제를 보여줄 것 ([bug_reproducing_structured_node.py:37-49](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/nodes/bug_reproducing_structured_node.py#L37)). 즉 **"이슈와의 의미적 일치"를 LLM이 구조화 출력으로 판정** ([bug_reproducing_structured_node.py:17-27](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/nodes/bug_reproducing_structured_node.py#L17)).
- feedback 재주입: 판정 실패 시 `reproduced_bug_failure_log`(전체 실행 로그 + LLM의 "왜 틀렸나" 설명)가 다음 라운드 write 프롬프트의 `FOLLOWUP_HUMAN_PROMPT`로 들어가 재작성을 유도 ([bug_reproducing_write_message_node.py:20-25](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/nodes/bug_reproducing_write_message_node.py#L20), [bug_reproducing_structured_node.py:156-159](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/nodes/bug_reproducing_structured_node.py#L156)).
- retry 횟수: 논문은 ≤2라 하지만 **코드엔 명시적 카운터가 없다**. 재현 retry는 `recursion_limit=150`만으로 bound됨 ([bug_reproduction_subgraph.py:219](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/subgraphs/bug_reproduction_subgraph.py#L219)). (≤2는 **context-refine 루프** `max_refined_query_loop=2`와 혼동 가능 — 그쪽은 retrieval 루프임 [inferred].)

---

## 5. Selection

- **single-test pass@1, 멀티 후보 voting 없음 [verified]**. subgraph는 후보 테스트 1개를 만들고 retry로 개선할 뿐, K개를 만들어 투표·랭킹하는 경로가 없다 ([bug_reproduction_subgraph.py:119-212](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/subgraphs/bug_reproduction_subgraph.py#L119)). `main.py`도 인스턴스당 단일 `reproduce_bug` 호출, 단일 결과 직렬화 ([main.py:344-350](../../../../.extracted_source/repro-scaffolds/echo/app/main.py#L344)).
- self-patch surrogate oracle이 selection을 대체하는가? → 공개본엔 self-patch가 없으므로(§3) **selection 대체자는 LLM judge(§4)** 다. 즉 "여러 후보 중 고르기" 대신 "단일 후보를 LLM이 합격/불합격 판정하고 떨어지면 같은 슬롯에서 재작성". 이는 selection이라기보다 **single-slot accept-or-retry**다 [verified].

---

## 6. 우리(quanta)가 흡수할 만한 메커니즘 (랭크)

> 핵심 판단: **그래프는 real semantic work를 하지 않는다.** Edge에 call/import/def-use가 없고(§2), 검색은 substring/경로 정확매칭(`text in node.text`)이며, Neo4j는 덤프스토어다. **grep + ripgrep + 파일트리 + LLM의 import-chasing tool-loop로 동등 이상**을 재현할 수 있다. semantica-codegraph를 wiring할 정당성을 **이 스캐폴드는 제공하지 못한다** — Echo의 그래프는 우리가 이미 갖춘 grep/read 도구의 열등한 부분집합에 가깝다. (semantica의 가치는 별도로 측정해야지, "Echo가 그래프로 66%를 냈으니 그래프가 lever"라는 추론은 **코드 증거에 의해 반증됨** [verified].)

흡수 후보 (ROI 순):

1. **[HIGH] "유사 기존 테스트 5개를 few-shot으로 retrieval→write 프롬프트에 주입"** ([issue_bug_reproduction_context_message_node.py:9-44](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/nodes/issue_bug_reproduction_context_message_node.py#L9), [bug_reproducing_write_message_node.py:11-18](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/nodes/bug_reproducing_write_message_node.py#L11)). 그래프 불필요 — 우리 grep+read로 "이 repo의 기존 테스트 스타일/import/fixture" 예시를 모아 재현테스트 generation 프롬프트에 넣는 패턴. (왜) 재현테스트의 import/fixture 오류가 우리 synthesis 병목의 일부일 수 있음. (ROI) 도구 재사용, knob default-OFF A/B 1개.

2. **[HIGH] LLM verifier가 "테스트가 *이슈에 기술된 방식 그대로* fail하는가"를 구조화 판정 + 실패 로그를 다음 라운드에 재주입** ([bug_reproducing_structured_node.py:37-49](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/nodes/bug_reproducing_structured_node.py#L37), [bug_reproducing_write_message_node.py:20-25](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/nodes/bug_reproducing_write_message_node.py#L20)). (왜) 우리 submit-review/acceptance seam과 직결 — "fail 했음"이 아니라 "*맞는* 이유로 fail 했음"을 게이팅. (ROI) 기존 `QUANTA_BENCH_SUBMIT_REVIEW`/acceptance 위에 prompt-level로 흡수, 신규 인프라 0.

3. **[MED] "patch는 새 파일 정확히 1개만 추가" 하드 게이트** ([bug_reproducing_execute_node.py:76-86](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/nodes/bug_reproducing_execute_node.py#L76)). (왜) 재현테스트가 기존 소스를 건드리는 오염을 차단(우리 `sourceOnlyDiff`/test-revert와 상보). (ROI) 작은 validator, 우리에 이미 유사물 있으면 skip.

4. **[LOW] context-refine 루프(`max_refined_query_loop=2`)로 retrieval을 LLM이 자체 확장** ([context_refine_node.py:104-124](../../../../.extracted_source/repro-scaffolds/echo/app/lang_graph/nodes/context_refine_node.py#L104)). (왜) 우리 context fanout과 중복 가능성 높음. (ROI) 신규 가치 낮음, 측정 전제.

흡수하지 말 것: Neo4j KG 빌드/저장 파이프라인 전체([knowledge_graph_handler.py](../../../../.extracted_source/repro-scaffolds/echo/app/neo4j/knowledge_graph_handler.py), [knowledge_graph.py](../../../../.extracted_source/repro-scaffolds/echo/app/graph/knowledge_graph.py)). 인스턴스마다 전 repo를 tree-sitter 파싱→Neo4j 적재→전량 리로드→삭제하는 비용([main.py:236-271](../../../../.extracted_source/repro-scaffolds/echo/app/main.py#L236))은 substring 매칭 대비 ROI가 음수에 가깝다 [inferred].

---

## 7. 코드가 보여주지 않는 것 / honesty flags

- **[verified] 리브랜딩**: 공개 코드는 Prometheus(§서두). README의 "Echo"와 내부 식별자/논문 메커니즘이 불일치.
- **[verified] self-patch oracle + dual-version check 부재**. 전수 grep:
  `grep -rin "golden|gold_patch|fix_patch|candidate.*patch|apply.*patch|revert|dual.version|oracle|fixed.*version|self.patch"` → fix-patch 생성/golden apply/dual-version 실행 경로 **0건** (`apply_patch`는 정의만 있고 미배선, `revert`는 git_reset 주석뿐). 논문의 핵심 oracle이 이 레포로는 재현 불가.
- **[verified] retry ≤2는 코드상 보장 안 됨**. 재현 retry는 `recursion_limit=150` bound. ≤2는 retrieval refine 루프 값과 혼동 위험.
- **[verified] 그래프 = 비-semantic**. call/import/def-use 엣지 없음, embedding 없음, Cypher는 적재/덤프용. 질의 retrieval은 in-memory substring.
- **[verified] AST depth 기본 1** → ASTNode가 사실상 top-level 심볼 인덱스. "deep codebase understanding"(README:21) 주장과 코드 현실 괴리.
- **[verified] 그래더/SWT-bench 채점 코드 없음**. 본 레포는 prediction(`reproduced_bug*`) 생성까지만. 66.3% 산출에 쓰인 채점 하네스는 외부(SWE-bench v4.1.0, [README.md:43](../../../../.extracted_source/repro-scaffolds/echo/README.md#L43))이며 본 분석 범위 밖.
- **[verified] `issue_comments`는 항상 빈 리스트**로 파이프라인을 탐 ([main.py:331](../../../../.extracted_source/repro-scaffolds/echo/app/main.py#L331)) — comment 활용 코드는 있으나 SWE-bench 경로에선 dead.
- **[inferred] dead/중복 노드**: `bug_reproduction_context_message_node`(3-test 버전)는 배선되지 않음(5-test `Issue...` 버전이 사용). `bug_reproducing_file_node` 등 일부는 본 분석에서 호출 contract까지 정밀 확인하지 않음.
- **[inferred] DB/PostgreSQL 서비스**는 repo metadata 영속용으로 보이며 재현 품질에 무관할 가능성. 정밀 미확인.
- **미검증(코드 미독파)**: `app/docker/*` 컨테이너 pexpect 상세, `git_repository.get_diff` 제외규칙, `tree_sitter_parser` 지원 언어 범위. 필요 시 후속.

---

### 한 줄 결론
이 공개본은 **그래프가 semantic이 아니며(substring+파일트리), self-patch oracle/dual-version은 미구현**이라, 논문 Echo의 +7.16pt 주장 중 우리가 코드로 확인 가능한 lever는 "유사테스트 few-shot retrieval + LLM judge로 *이슈-일치 fail* 게이팅 + 실패로그 재주입"뿐이다. **semantica-codegraph wiring의 정당성은 이 스캐폴드에서 도출되지 않는다.**
