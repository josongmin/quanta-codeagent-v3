# ReProAgent (난징대) 방법론 전개 + quanta 준비도 매핑 — 2026-06

- 대상: ReProAgent, SWT-bench Verified **69.7% (GPT-5-mini)** — 싼 모델로 강한 reproduction-test-generation 스캐폴드.
- 원본: `.extracted_source/repro-scaffolds/reproagent/src/` (모든 file:line 실측).
- 선행 리뷰: `docs/analysis/scaffold-repro/reproagent/readme.md` (본 문서는 그 위에 "quanta 준비도 매핑"을 추가).
- 증거태그: `[verified]`=코드 직접 확인, `[inferred]`=코드로부터 합리적 추론.

> ⚠️ 핵심 정정 (선행 리뷰와 동일): ReProAgent는 **fix를 만들지 않는다**. reproduction test 1개만 생성한다. "메인 오라클"은 골드 없는 **단일-LLM execution-review surrogate**. README의 "Triadic Review"는 3-voter 앙상블이 아니라 **1 호출 내 3-dimension unary review** [verified].

---

## 1. ReProAgent 방법론 전부 펼치기 (코드 file:line)

### (a) 멀티에이전트 선형 파이프라인 (planner.py)
LangGraph 상위 그래프가 **선형** — `planner.py:246-252`:
```
START → initState → bugLocalization → rootCauseAnalyzer
      → testGenerationHintsGenerator → testGenerator → testAcceptor → END
```
각 스테이지 = 별도 agent 클래스 (동형 ReAct tool-call 루프):
- Bug Localization → `bug_localization_agent.py:19` (`localize_bugs`), suspicious_locations(JSON) 산출.
- Root Cause Analysis → `root_cause_analysis_agent.py:19`, suspicious_locations 입력(`planner.py:104-108`).
- Test Hints → `test_generation_hints_agent.py:19` (아래 (e)).
- Test Generator → generator 서브그래프 `ainvoke`(`planner.py:166`), hints/root_cause/suspicious를 프롬프트 주입(`planner.py:149-164`).
- Test Acceptor → 최종 패키징(`planner.py:192`).
ablation 토글은 노드 스킵(`planner.py:67-71` 등), CLI `--disable-*`(`main.py:598-621`) [verified].

### (b) Code Knowledge Graph grounding (symbol KG)
- 빌드: tree-sitter+`ast`로 structure/tags 추출 → msgpack 직렬화(`construct_tags.py:51,65,449`), in-memory 로드(`in_memory_store.py:125`). **Neo4j 아님**(`in_memory_store.py:1-3` "Replaces Neo4j").
- 노드 타입: `Clazz`/`Method`/`Variable`(`in_memory_store.py:12-87`).
- 엣지: `belongs_to`/`has_method`/`has_variable`/`inherits`는 채워짐(`in_memory_store.py:230-235,274`).
- 🔴 **CALLS/REFERENCES edge는 dead**: `self.calls` 채우는 코드 없음(`in_memory_store.py:119`), tags 로더 주석 비활성(`in_memory_store.py:134`), `tags.msgpack`은 로드 직후 unlink(`main.py:288`). 즉 살아있는 그라운딩 = **클래스-멤버 구조 그래프**뿐(호출/참조 그래프 아님) [verified].
- LLM 노출 KG 도구는 사실상 2개: `FindRelatedEntities`(`graph_tool.py:215`, cap 30), `SearchFilesSmart`(`graph_tool.py:75`). 나머지 graph_tool은 주석-미바인딩(`config.py:82-97`, 사유 "입력 폭증"). 주입 형태 = **정적 prepend 아님, tool-result(ToolMessage) on-demand** [verified].

### (c) Execution-review surrogate oracle (3-dimension)
- 프롬프트 `EXECUTION_REVIEW_PROMPT_TEMPLATE`(`prompt_template.py:177-258`). "A valid test must satisfy BOTH: (1) fails pre-fix, (2) PASSES post-fix"(`:208-210`). THREE dimensions(`:214`):
  1. **Bug Reproduction Check**(`:216-219`) — 실패가 issue/root_cause/suspicious와 일치하나.
  2. **Test Logic Soundness**(`:221-226`) — assertion이 post-fix(올바른) 동작 검증하나, `assert False`류 합성실패 아닌가.
  3. **POST-FIX VIABILITY**(`:228-238`) — "fix 후에도 pass할 수 있나?" 언어/직렬화 한계 등 **구조적 unviable**이면 reject(예: lambda 직렬화, `:236`).
- verdict schema(`:250-256`): `{issue_reproduced_successfully, confidence_score, reasoning, suggestion, recommended_action}`.
- 구현: `execution_review_agent.py:30`(분기), `:100`(빈map/all-pass는 LLM없이 regenerate), `:136`(FAILED/ERROR면 **LLM 1회 호출**). 파싱실패→보수적 regenerate(`:201-214,235-250`). confidence_score는 **게이팅에 안 씀**; 분기는 `issue_reproduced_successfully` boolean만(`generator.py:387-394`) [verified].

### (d) MAX_FEEDBACK_TIMES=20 repair loop
- Generator 서브그래프(`generator.py:522-568`): execution→executionReview→(feedbackIteration→testGenerator | reportGenerator).
- 한도 `MAX_FEEDBACK_TIMES=20`(`config.py:34`, checker `generator.py:481`). 매 라운드 review의 `reasoning`(+suggestion, `execution_review_agent.py:216-223`)을 다음 gen의 HumanMessage로 주입(`generator.py:447,463`). max 도달시 마지막 결과로 report(`generator.py:432-443`).
- ⚠️ **best-of-N voting 없음** — 단일 test_case를 iterative refine으로 수렴. 선택 = review가 success판정한 그것 or max 도달시 마지막(`planner.py:170-189`) [verified].

### (e) Assertion-aware hints (fix 전 기대동작 정의)
- `TestGenerationHintsAgent.generate_hints`(`test_generation_hints_agent.py:19-185`) — localization→root_cause 뒤, generation **전**에 별도 스테이지로 "어떤 assertion으로 어떤 코드패스를 쳐라"를 미리 합성. README의 "Assertion-aware Test Planning". ReAct 루프(max 50, `config.py:32`) [verified].

### (f) Tool-using (bash/grep/interactive_python/graph_tool)
- 바인딩 6~7개(`config.py:81-99`): `find_related_entities`, `search_files_smart`, `interactive_python`(`tools/interactive_python.py:16`, 출력 5000자 truncate), `read_file`, `grep`, `glob`, `bash`(`tools/bash.py`). 모두 Docker 컨테이너 내 실행(`environment_service.py:794` harness 경유) [verified].

---

## 2. quanta 준비도 매핑

| 방법론 | ReProAgent 코드근거 | quanta 코드 위치 | 상태 |
|---|---|---|---|
| (a) 멀티에이전트 선형 파이프라인 (loc→rca→hints→gen→review) | `planner.py:246-252` | 별도 스테이지-에이전트 파이프라인 **없음**. 우리는 단일-에이전트 loop(`src/agent/loop/turn-loop.ts`) + repair breadth fan-out(`src/runner/batch/eval/repair-breadth.ts`). subagent 인프라(`src/agent/subagent-runner.ts`)는 존재하나 bench repair에 loc→rca→hints 체인으로 미배선 | **부분/미측정** — subagent seam 있음, repro-repair에 파이프라인化 안 됨 |
| (b) code-KG grounding (Clazz/Method/INHERITS) | `graph_tool.py:215`, `in_memory_store.py:12-87` | LSP nav 8도구(`src/tool/lsp_nav/index.ts:24` def/refs/impl/workspace-symbol), find-references(`src/tool/find-refs`). semantica 정적엔진은 **port seam만**(`repro-grounding.ts:17,154` CodeIntelligencePort 미어댑터). repro-grounding은 lexical `discoverImpactedTests` 배선(`repro-grounding.ts:47,81`) | **있음(우위 잠재) / semantica 미배선** — LSP는 real refs/impl 있음(ReProAgent의 dead-CALLS보다 강함), semantica CALLS 어댑터는 미측정 |
| (c) execution-review surrogate oracle **3-dim** | `prompt_template.py:177-258`, `execution_review_agent.py:136` | (i) LLM reviewer rerank: `src/runner/batch/eval/acceptance-llm-rerank.ts` + wire(`acceptance-llm-rerank-wire.ts`) [never-veto/fail-open]. (ii) submit-review: `src/runner/batch/eval/submission-review.ts:42`(**deterministic 파일분류**, LLM 아님, viability 판정 아님). (iii) strong-oracle: `src/runner/batch/eval/repair/strong-oracle.ts`(**실행기반** 다중신호 conjunction) | **부분** — LLM soft-rerank 있음(3-dim 프롬프트는 아님). post-fix-viability를 **LLM 추론으로** 대리판정하는 것은 **없음** |
| — 그중 **post-fix-viability**(구조적 unviable reject) | `prompt_template.py:228-238` | 우리 최근접 = strong-oracle의 declared-expected/repro-vote conjunct(`strong-oracle.ts`, `bench-b.ts:118`) + acceptance-selector 실행판정(`acceptance-selector.ts`) | **없음(개념 다름)** — 우리는 실행(actual run)으로 판정, ReProAgent는 fix-없이 LLM추론으로 판정 |
| (d) feedback loop (20회 repair) | `config.py:34`, `generator.py:481` | repair breadth fan-out(`repair-breadth.ts`) + repair orchestrator(`src/runner/batch/eval/repair/index.ts`) + closure-repair(`knobs/closure-repair.ts`) + repro-vote per-round(`repair/repro-vote.ts`). agent 내부 edit-repair(`src/agent/edit-repair-loop`) | **있음(file:line)** — 라운드 반복+피드백 있음. 단 fan-out은 default 1(opt-in) |
| (e) assertion-aware hints (기대동작 선정의) | `test_generation_hints_agent.py:19` | verification-plan knob(`bench-a.ts:220`, `presets.ts:153` 일부 preset ON) + declared-expected 스펙충실 veto(`bench-b.ts:55`) + pytest-assertion-pin(`repair/pytest-assertion-pin.ts`) | **있음/부분** — declared-expected는 "이 assertion을 써라" hints라기보다 "expected 매칭 veto". 별도 hints-generation 스테이지 아님 |
| (f) interactive_python / bash | `tools/interactive_python.py:16`, `tools/bash.py` | bash(`src/tool/bash`), container-exec(`src/tool/container-exec`), run_tests/evidence(`src/tool/evidence/tool.ts`) | **있음(file:line)** — bash/container-exec 있음. 별도 REPL "interactive_python"은 bash python으로 커버 |

---

## 3. 핵심 판정

**Q1. ReProAgent가 싼 모델로 강한 비결(execution-review surrogate oracle + KG grounding)을 우리가 가졌나?**

- **execution-review surrogate oracle: 개념적으로 우리가 더 강하지만 "그 형태"는 없다.** ReProAgent의 비결 #1은 **골드/실-fix 없이 "이 테스트가 fix후 pass할까"를 LLM 1회 추론으로 대리판정**(`prompt_template.py:228-238`)하고 그 판정으로 20회 regenerate(`config.py:34`). 이게 싼 모델을 강하게 만드는 핵심 lever [inferred]. 우리는 이걸 **실행 기반 실측**으로 한다 — strong-oracle(`strong-oracle.ts`, base-discrimination+declared-expected+repro-vote conjunction), acceptance-selector(`acceptance-selector.ts`, 실제 sandbox 재실행). 즉 우리는 **oracle 신호가 더 hard(실행 ground-truth)**하지만, ReProAgent식 **cheap LLM pre-filter**(실행 전에 unviable 후보를 추론으로 거르는 앞단)는 **없다**. → 흡수 후보 #1: acceptance/repair-breadth의 **앞단 cheap gate**로 3-dim viability 프롬프트를 붙일 여지.
- **KG grounding: 우리가 잠재적 우위, 단 미배선.** ReProAgent의 KG는 CALLS/REFERENCES가 **dead**(`in_memory_store.py:119,134`)라 사실상 클래스-멤버 구조뿐. 우리는 LSP nav의 **real find-references/implementation**(`src/tool/lsp_nav/index.ts:24`)을 이미 가진다 → "test가 호출해야 할 진짜 entry-point/caller" 그라운딩에서 구조적 우위. 하지만 semantica 정적엔진은 repro-grounding에 **port seam만**(`repro-grounding.ts:17,154`), CALLS 어댑터 미측정. 현행 grounding은 lexical(`discoverImpactedTests`, `repro-grounding.ts:47`). → **미측정**.

**Q2. post-fix-viability 3-dim 판정 = 우리 acceptance oracle과 같은가 다른가?**

- **다르다 (근본적으로).** ReProAgent의 post-fix-viability(`prompt_template.py:228-238`)는 **fix가 존재하지 않는 상태에서** "이 테스트가 어떤 fix로도 통과 가능한 구조인가"를 **LLM이 반사실적 추론**으로 판정한다(실행 없음, boolean+regenerate). 우리 acceptance oracle(`acceptance-selector.ts`, `strong-oracle.ts`)은 **후보 fix를 실제로 sandbox에 apply→실행→resolved 판정**한다(실측, K-of-N vote). 즉:
  - ReProAgent: fix-free · LLM-inference · unviability-reject(precision 앞단 필터).
  - quanta: fix-present · actual-execution · false-green/false-red 차단(정밀 게이트).
  - 우리 submit-review(`submission-review.ts:42`)는 이름만 비슷할 뿐 **파일분류 deterministic verdict**(clean/empty/test-edits)이지 viability와 무관.
- **함의**: 두 오라클은 **상보적**. 우리 실행-오라클은 비싸다(sandbox fork/run). ReProAgent식 LLM viability는 **실행 전에 구조적으로 못 통과할 후보(answer-key/over-narrow/직렬화불가)를 싸게 pre-reject** → 우리 비싼 실행 예산을 아끼는 앞단. confidence_score는 ReProAgent도 게이팅에 안 쓰므로(boolean만) 우리 no-heuristics 원칙과 충돌 안 함 — suggestion→다음 라운드 feedback 주입 패턴만 차용.

---

## 10줄 요약
1. ReProAgent = **fix 안 만듦**; reproduction test 1개만 생성, SWT 69.7%(gpt-5-mini) [verified].
2. 파이프라인 = 선형 멀티에이전트 loc→rca→**hints**→gen→review (`planner.py:246-252`).
3. 비결 #1 = **execution-review surrogate oracle**: 골드없이 LLM 1회가 3-dim(reproduce/soundness/**post-fix-viability**) 판정 후 20회 regenerate (`prompt_template.py:177-258`, `config.py:34`).
4. 비결 #2 = KG grounding이라 하나 **CALLS/REFERENCES edge는 dead**, 살아있는 건 클래스-멤버 구조뿐 (`in_memory_store.py:119,134`).
5. 우리 (a)파이프라인: 단일-agent loop+breadth fan-out, loc→rca→hints 스테이지 체인은 **없음/미측정**.
6. 우리 (b)KG: LSP real refs/impl 있음(ReProAgent dead-CALLS보다 강함), semantica CALLS 어댑터는 **port seam만/미측정** (`repro-grounding.ts:154`).
7. 우리 (c)oracle: **실행기반**(strong-oracle/acceptance-selector) — hard하지만 ReProAgent식 **cheap LLM viability pre-filter는 없음**.
8. post-fix-viability는 우리 acceptance와 **근본적으로 다름**: 저쪽 fix-free LLM추론, 우리 fix-present 실측 → **상보적**.
9. 우리 submit-review는 이름만 유사, 실은 **파일분류 deterministic**(`submission-review.ts:42`) — viability 아님.
10. 흡수 ROI #1 = acceptance/breadth **앞단**에 3-dim viability LLM pre-gate(비싼 실행 절약, suggestion→feedback 주입); #2 = semantica CALLS를 grounding에 실배선(ReProAgent dead-edge 능가). 둘 다 **measure-first**.
