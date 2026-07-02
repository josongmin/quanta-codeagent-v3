# repro-특화 스캐폴드 고유 방법론 전개 + quanta 준비도 매핑 (2026-06)

대상: **Echo**(arXiv:2603.07326), **Otter/Otter++**(arXiv:2502.05368), **e-Otter++**(arXiv:2508.06365, ICSE'26),
**AssertFlip**(arXiv:2507.17542). 전부 *issue-reproducing test 생성*(SWT-bench / TDD-Bench, F→P 지표) 스캐폴드다.

근거 규약: 논문 발췌는 `paper p.N §sec`, 코드는 `file:line` (전부 절대경로 base `/Users/songmin/quanta-codeagent-v3/`).
증거 태그: `[verified]`=PDF/소스 직독, `[reverse-engineered]`=출력 아티팩트에서만, `[inferred]`=정황 추론.

선행 리뷰(중복 대신 인용): `docs/analysis/scaffold-repro/echo/readme.md`(Prometheus 코드 대조),
`docs/analysis/scaffold-repro/tdd-bench-otter/readme.md`(Otter 역공학),
`docs/analysis/scaffold-repro/predictions-review/otter-assertflip.md`(prediction 까본 결과).

---

## 0. 준비도 매핑 총괄표 (방법론 → 우리 대응물)

| # | 방법론 | 출처(paper p./코드) | 우리 코드 위치 | 상태 |
|---|---|---|---|---|
| E1 | **graph-enhanced retrieval** (heterogeneous code graph, 5 edge type) | echo paper p.5 §4.1.1; **공개코드=file+AST+text 3중트리, call/import 엣지 0** (`.extracted_source/repro-scaffolds/echo/app/graph/graph_types.py:126`) | `src/lsp/`(nav 도구), swap-seam `src/runner/batch/eval/repro-grounding.ts:17-19`(→semantica `CodeIntelligencePort` 미배선) | **부분(있음, 열등형)** — 우리 lexical `discoverImpactedTests`가 substring-retrieval과 동급; semantica graph는 seam만 있고 未배선·未측정 |
| E2 | **automatic query-refinement 루프** (LLM이 "context 충분?" 판정→재쿼리, ≤2) | echo paper p.6 §4.1.2 | context fanout (`src/runner/batch/eval/location-set-fanout.ts`), grounding orchestrator `repro-grounding.ts` | **있음(유사)** `[inferred]` 중복 |
| E3 | **similar/regression 테스트 few-shot retrieval→gen 프롬프트 주입** (import/fixture/assert 포함, priority order) | echo paper p.6 §4.1.4; Otter shape `[reverse-engineered]` | `src/runner/batch/eval/repro-grounding.ts:15-22` (`retrieveExemplarSkeletons`), `src/agent/repro-test/grounding` (skeleton-strip) | **있음** `repro-grounding.ts` (knob `QUANTA_BENCH_REPRO_GROUNDING`, default-OFF, 未측정) |
| E4 | **self-generated patch as surrogate oracle + dual-version check** (원본에서 fail / 패치본에서 pass, rule-based, ≤2 retry) | echo paper p.8 §4.6; **공개코드엔 없음**(`docs/analysis/.../echo/readme.md` §3, grep 0건) | acceptance는 **PATCHED tree만** 채점 (`src/runner/batch/eval/acceptance-select.ts:55-59`) | **부분(갭)** — 우리 오라클은 self-repro의 exit-code green (agent 자기 repro), Echo식 *code-patch surrogate*로 base↔patched 2-tree 대조는 **없음** |
| E5 | **single-test-per-issue** (K-후보 sampling·voting 안 함, cost 절감) | echo paper p.3 §1 (3) | 우리는 반대로 best-of-N (`src/agent/repro-test/generate.ts:12`, K=5) | 설계 상이(우리가 더 aggressive) |
| E6 | **"patch는 새 파일 1개만 추가" + read-only executor** 하드 게이트 | echo paper p.7-8 §4.4 | `sourceOnlyDiff`/test-revert 계열 (`src/runner/batch/eval/` 하네스), MEMORY(jun-24 T5) | **있음(유사)** |
| O1 | **self-reflective action planning** (localizer→action-planner read/write/modify→gen, validation loop) | otter/e-otter paper p.2 §2.2 | agent loop plan-bridge (`src/agent/loop/`), focus-chain | **있음(agent-native)** `[inferred]` |
| O2 | **rule-based repair** (LLM 출력 검사/수정: import 누락→함수내 import, flake8/mypy 정적검사) | e-otter paper p.2 §2.2; Otter shape 34-46% 함수내 import `[reverse-engineered]` | patch hygiene / hunk-apply (`src/runner/hunk-apply.ts`), pytest-assertion-pin (`src/runner/batch/eval/repair/pytest-assertion-pin.ts`) | **부분** — assertion-pin은 *프롬프트* 교정, Otter식 *산출물 정적수정 룰*(import-inject)은 별도로 없음 |
| O3 | **Otter++ ensemble/best-select** (localization 입력 변형해 5후보, cold-code 실행결과로 best) | otter paper p.2 §2.2; 111/449 후보차 `[reverse-engineered]` | acceptance best-of-N (`acceptance-select.ts`), llm-candidate-select (`llm-candidate-select.ts`), location-fanout | **있음** (`QUANTA_BENCH_ACCEPTANCE`, `QUANTA_BENCH_LOCATION_FANOUT`, default-OFF) |
| EO1 | **heterogeneous prompting** — issue morphs(5) × context masks(5) = 10 diversity | e-otter paper p.4-5 §3.1, Table6 | **없음** — grep(morph/heterogeneous/reformulate/dropCode) src 매치 0 (bench 무관 union types만) | **없음** ← novel 갭 |
| EO2 | **execution-augmented test repair** (Alg.1: 실행 error → critic "right reason?" → read actions로 context 수집 → repairPrompt에 augment) | e-otter paper p.3 §3.1 Alg.1 | repair 루프 있음(`src/runner/batch/eval/repair/index.ts`, `context.ts`) — 실패 tail 재주입은 함 | **부분(갭)** — 우리는 fail-tail 재주입만, e-Otter++의 *critic-directed read-actions로 target context 능동 수집후 augment*는 없음 |
| EO3 | **patch-side test selection** (Agentless 후보패치 40→5로 pre-filter, coverage tie-break, LLM 미사용 rule) | e-otter paper p.6 §3.3, Table8 (CodePatch가 가장 큰 selector lever) | acceptance regression dual-guard 절반 (`acceptance-selector.ts:49-88`), 우리 selector는 self-repro·regression 기반 | **부분** — 우리 selector는 *patched-tree repro+regression*, e-Otter식 *surrogate code-patch 다수로 pre-filter*는 없음(E4와 동근원) |
| EO4 | **critic = LLM as validator** (test log 보고 "버그때문에 fail?" 판정, F-score 0.78~0.83) | e-otter paper p.9 Table5; echo p.8 §4.5 동형 | submit-review/reviewer (`QUANTA_BENCH_SUBMIT_REVIEW`, `src/runner/batch/eval/reviewer-evidence-redact.ts`), declared-expected-matcher, strong-oracle | **있음** (default-OFF) |
| AF1 | **pass-then-invert (flip trick)** — 현 동작 통과테스트 먼저 → assertion만 issue정답값으로 flip → fail-on-bug | assertflip paper p.1 §1, p.5 §4.5 Fig4→Fig6 | **없음** — grep(flip/invert/characterization/passingFirst) src 매치 0 (전부 무관 "flip a row/ttl") | **없음** ← 최대 novel 갭 |
| AF2 | **refinement loop** (실행 error prompt로 최대 10회 수정, "progress 있으면 계속") | assertflip paper p.5 §4.4 | repair rounds (`src/runner/batch/eval/kernel/steps/repair.ts`, budget `repairRounds`) | **있음(유사)** |
| AF3 | **regeneration + improved planning** (반복 reject시 이전 plan 폐기, "다른 각도" 강제) | assertflip paper p.6 §4.7 Fig9 | effort-ladder (`QUANTA_BENCH_EFFORT_LADDER`), repair-breadth (`repair-breadth.ts`) | **부분(유사)** — tier 상승은 있으나 "plan 폐기+반대각도 강제" 명시 프롬프트는 없음 |
| AF4 | **get_info 정적분석 도구** (심볼명→def 트리밍 발췌, 환각 억제) | assertflip paper p.6 §4.8 Fig8 | LSP nav (`src/lsp/`, def/hover/references), read 도구 | **있음(우월)** — 우리 LSP-nav가 상위호환 |
| AF5 | **coverage-adequacy 채점** (pass_after × 변경라인 branch coverage) | TDD-Bench harness `run_evaluation.py:685-740` (AssertFlip/Otter가 채점됨) | over-narrow guard(strong-oracle `repair/strong-oracle.ts`), closure-diagnostics | **부분(측정레일 갭)** — 우리 grading은 F2P binary, coverage-곱셈 미도입 |

---

## 1. 시스템별 고유 방법론 전개

### 1.1 Echo — graph retrieval + code-patch surrogate oracle + dual-version

**논문 6-stage** (echo p.5 §4, Fig.2): context retrieval → patch generation → test gen → autonomous run → verification → dual-version check.

- **graph-enhanced retrieval** [verified]: 코드베이스를 heterogeneous directed graph로 모델링 — node 3종
  `ResourceNode/ParseNode/TextSpanNode`, edge 5종 `HAS_FILE/HAS_AST/PARENT_OF/HAS_TEXT/NEXT_CHUNK`, Neo4j 저장
  (echo p.5 §4.1.1). **automatic query-refinement**: initial query → LLM이 rank/filter → 부족하면 follow-up
  query (echo p.6 §4.1.2). focal-code retrieval은 "핵심 컴포넌트+구현+class def+import 추종" 4단계 지시
  (echo p.6 §4.1.3), regression-test retrieval은 "complete·self-contained, exact file:line·import·helper·fixture
  보존, priority: 동일기능>유사에러>유사mock>유사assert" (echo p.6 §4.1.4).
  - **⚠️ 공개코드 반증** [verified]: 공개 레포는 실은 **Prometheus** 리브랜딩이고, 그래프에 call/import/def-use
    엣지가 **전무**하다 (`.extracted_source/repro-scaffolds/echo/app/graph/graph_types.py:126-133`).
    `PARENT_OF`는 AST 트리 부모자식일 뿐. 검색은 in-memory **substring 매칭**(`app/tools/graph_traversal.py:272,421`),
    Neo4j는 덤프스토어. 기본 `KNOWLEDGE_GRAPH_MAX_AST_DEPTH=1`이라 ASTNode≈top-level 심볼 인덱스. 즉 논문이 내세운
    "graph가 lever"라는 주장은 **코드 증거로 반증**됨 — grep+read+파일트리로 동등 이상 재현 가능
    (선행리뷰 `echo/readme.md` §2, §6).
- **self-generated patch as surrogate oracle + dual-version check** [verified/paper]: patch generator로 후보 fix
  patch 생성(구현은 Prometheus, echo p.7 §4.2) → 원본 codebase와 patched codebase 양쪽에서 재현테스트 실행 →
  **rule-based**(LLM 미사용)로 `pass`/`ok` 키워드 매칭해 fail-before∧pass-after 확인, 실패시 ≤2 retry
  (echo p.8 §4.6). **이게 논문의 핵심 기여이자 e-Otter++ [2]로부터 계승**(echo p.1 각주1, "first work leveraging
  execution feedback to select ... using the patched version as an oracle").
  - **⚠️ 공개코드엔 없음** [verified]: fix-patch 생성/apply/dual-version 실행 노드 grep 0건. 공개본 oracle은
    **LLM judge**(`app/lang_graph/nodes/bug_reproducing_structured_node.py:37-49`, "이슈와 같은 방식으로 fail?").
- **single-test-per-issue** [verified]: K-후보 sampling·voting 안 함 → cost-performance trade-off (echo p.3 §1).
- **executor 하드제약** [verified]: "test file 존재검사 금지 / full suite 금지 / edit 금지 / dep설치 금지" (echo p.7-8 §4.4).
  공개본은 "patch가 새 파일 정확히 1개만 추가" 검증(`bug_reproducing_execute_node.py:76-86`).
- 성능: SWT-bench Verified **66.28% F→P** open-source SOTA (echo p.3 §1).

### 1.2 Otter / Otter++ — self-reflective planning + rule-based repair + ensemble

Otter 소스 비공개, 아래는 논문 인용 + prediction 449 코퍼스 역공학 (선행리뷰 `tdd-bench-otter/readme.md` §3).

- **self-reflective action planning** [verified/paper]: 3컴포넌트 — localizer(context-aware 프롬프트로 relevant
  file/test-func/focal-func를 4단계로 pick, top-10) + action-planner(read/write/modify로 분류된 액션을
  self-reflective loop+validation으로 반복 구성) + test-generator(localized code+signature/import 구조단서로
  완전한 test-func 생성) (e-otter p.4 §3, otter p.2 §2.2).
- **rule-based repair** [verified/paper]: hallucinated/incomplete import 수정 + flake8 정적분석 통합해 syntactic·
  semantic correctness 확보 (e-otter p.2 §2.2). 역공학 정황: Otter 산출물의 **34%, Otter++ 46%가 import를
  테스트 함수 body 안에** 넣음(module-top import 누락으로 인한 NameError 방어) `[reverse-engineered]`.
- **Otter++ = heterogeneous ensemble** [verified/paper]: localization 입력을 얼마나 넣는지 다르게 한 여러 config로
  다수 후보 생성 → cold-code(c_old) 실행결과(assertion-fail vs syntax-error)로 best 1개 선택 (e-otter p.2 §2.2).
  역공학: Otter++가 Otter 대비 111/449에서 다른 patch, "새 함수 additive"·"self-contained" 후보를 선호
  `[reverse-engineered]`.
- 성능: TDD-Bench Verified Otter 37.2% → Otter++ 38.8% (GPT-4o) (e-otter p.6 Table2).

### 1.3 e-Otter++ — heterogeneous prompting + execution-augmented repair + patch-side selection

Otter를 base component로 3 신기술 추가 (e-otter p.3 §3, Fig.2). 3.7-Sonnet로 TDD-Bench **63.0%** SOTA.

- **① heterogeneous prompting** [verified] — diversity를 temperature 대신 프롬프트 변형으로:
  - **issue morphs** 5종 (e-otter p.5 §3.1): `standard`(LLM이 이슈 표준화, 72%가 non-standard라 substantial),
    `simple`(project-jargon 단순화), `dropCode`(오해유발 code snippet 제거 — 예 sympy가 numpy 안 쓰는데 이슈의
    np 예시가 오염), `initTest`(초기 fail-to-pass test를 이슈에 삽입), `initPatch`(초기 해결책 제안). issue를 LLM으로
    다시 씀 → Otter를 5회 재실행.
  - **context masks** 5종 (Otter++서 계승, e-otter p.5 §3.1): planner/full/testLoc/patchLoc/none — test-gen
    프롬프트에서 서로 다른 context 부분집합을 elide.
  - 효과: "plan+mask+morph"가 "plan+mask" 대비 F→P@N +13% 이상 (e-otter p.9 Table6, Finding3).
- **② execution-augmented test repair** [verified] Alg.1 (e-otter p.3 §3.1): Otter test를 c_old에서 실행 →
  `critic`(단일 LLM call, temp0)이 test log 보고 "**failsForRightReason?**" 판정. right-reason이면 stop;
  아니면 critic이 지목한 **buggy line + 관련 text/code snippet + 읽어야 할 function**을 read-action으로 수집해
  `extraContext`로 만들고 `repairPrompt(issue, y, extraContext)`에 **augment**(temp0.8) → 재시도 ≤10.
  ablation: critic 제거시 −21.0%p로 가장 큰 lever (e-otter p.8 Table4).
- **③ patch-side test selection** [verified] (e-otter p.6 §3.3, §3.2): Agentless로 code-patch 40개(1 greedy+39
  temp0.8) 생성 → 정규화후 최빈 5개 선택 → 각 후보 test를 c_old·5 code-patch 양쪽 실행, **모든 patch에서 F→P인
  test만 keep**(pre-filter), 동률이면 coverage(5 patch 평균) tie-break. LLM 미사용 rule-based. Table8: CodePatch
  pre-filter가 selection의 지배 lever(200.5→283) (e-otter p.9 Finding4).

### 1.4 AssertFlip — pass-then-invert (flip trick)

CoverUp 위 구축, Agentless localization 재사용 (assertflip p.4 §4.1). SWT-bench Verified **43.6% F→P**.
파이프라인 (assertflip p.2 Fig.1): localize → **test planning(pass-first)** → **passing test gen** → refinement
loop → **test inversion** → validation.

- **핵심 직관** [verified]: "LLM은 crash/fail 목적 테스트보다 **passing 테스트를 더 잘 쓴다**" (assertflip p.1 abstract,
  p.2 §3). 그래서 fail-to-pass를 직접 짜는 대신:
  1. **passing test gen** (assertflip p.5 §4.3, Fig.4): 버그 코드에서 **통과하는**(= 현 잘못된 동작을 캡처하는)
     test 먼저. plan은 "지금은 통과, 버그 고쳐지면 실패" 목표를 명시. `# BUG: this is incorrect behaviour but
     currently happens` 주석 스타일.
  2. **refinement loop** (assertflip p.5 §4.4, Fig.5): 실행 error를 error-prompt로 최대 10회 수정("progress
     있으면 = 다른 error 나오면 계속"). import path/arg/setup 교정.
  3. **test inversion** (assertflip p.5 §4.5, Fig.6): valid passing test 확보 후 **structure는 그대로 두고
     assertion만 정답값으로 flip** → 버그코드에서 fail, 수정후 pass하는 BRT. "가능한 한 적게 바꿔라, buggy
     acknowledge 주석 제거".
  4. **validation** (assertflip p.6 §4.6, Fig.7): LLM validator가 "정말 버그때문에 fail?" 판정, 실패시 regeneration.
  5. **regeneration + improved planning** (assertflip p.6 §4.7, Fig.9): reject 반복시 이전 plan **폐기**,
     `<ISSUE><THOUGHT><TEST ATTEMPT><ERROR><FEEDBACK>` 주고 "이전 plan 재사용 금지, 다른 각도" 강제.
- ablation (assertflip p.8 Table3): validator 제거 43.6→38.5%, planner 제거 43.6→41.8%, direct-fail variant
  43.6→**24.2%**(−19%p) — **pass-then-invert가 direct-fail 대비 핵심** (assertflip p.7 §5.3).
- prediction 확증 [verified]: 100% new-file(`test_coverup_<id>.py`), 단언은 항상 post-fix 정답값 + 꼬리주석
  "버그 있으면 실패"(bug-aware 주석 밀도 54% = e-Otter++의 3배) (선행리뷰 `otter-assertflip.md` §2).
  약점: mock 남용 45건(resolve 33%), 하드코딩 기대값 brittle, coverage 0.703(<e-Otter 0.857).

---

## 2. 핵심 판정 — 우리가 흡수 안 한 진짜 novel 방법론

우리 bench 하네스는 acceptance/best-of-N/repair-loop/reviewer/grounding/effort-ladder를 이미 leaf-knob(default-OFF)로
갖췄다(§0표 다수 "있음"). **그러나 아래 3개는 우리에게 진짜 없는 novel lever다:**

1. **★★ AssertFlip pass-then-invert (flip trick) — 없음, 최우선 갭** (AF1).
   grep 확인: `flip/invert/characterization/passingFirst` src 매치 0 (무관용만). 이건 우리 synthesis 수렴 병목
   (MEMORY jun-29: "맞는 파일 짚고 edit 수렴 실패")에 직결 — repro-gen에서 LLM이 *정답 동작을 처음부터 알아야*
   하는 난점을, "현 동작 캡처(쉬움) → assertion만 flip(쉬움)" 2-step으로 우회. ablation이 −19%p로 효과 실증.
   흡수처: `src/agent/repro-test/generate.ts`에 옵션 단계 삽입 + `QUANTA_BENCH_ACCEPTANCE` dual-guard와 결합.
   **주의**: prediction서 확인된 mock-남용(resolve 33%)/하드코딩 brittle은 answer-key 안티패턴류 — flip만 취하고
   mock은 배제 (MEMORY no-answer-key). measure-first A/B 대상.

2. **★ e-Otter++ heterogeneous prompting (issue morphs × context masks) — 없음** (EO1).
   grep 확인: `morph/heterogeneous/reformulate/dropCode` bench-무관 union types만. 우리 diversity는 temperature +
   location-fanout뿐 → e-Otter++가 "temperature보다 morph/mask가 F→P@N을 더 올린다"(p.5 Fig.5)고 실증한 축이 빈다.
   특히 `dropCode`(이슈의 오해유발 snippet 제거)·`standard`(이슈 표준화)는 값싸고 answer-key 무관. 흡수처: prompt
   변형 knob(default-OFF) + best-of-N pool 확대. **caveat**: `initTest`/`initPatch` morph는 contamination 위험
   (e-otter p.5, 2% 오염 보고) → 배제하고 standard/simple/dropCode만.

3. **★ e-Otter++ execution-augmented repair의 critic-directed read-actions — 부분 갭** (EO2).
   우리 repair는 fail-tail 재주입만 (`repair/context.ts:39`, `pytest-assertion-pin.ts`). e-Otter++는 critic이
   "right-reason 아님" 판정시 **어느 buggy line·어느 function을 읽어야 하는지 지목→read-action으로 능동 수집→
   repair 프롬프트에 augment**(Alg.1 L4-7). ablation −21%p로 최대 lever. 우리 assertion-pin은 *이미 있는 출력의
   재배치*지 *능동 context 수집*이 아님. 흡수처: repair 루프에 critic 지목 기반 read-action seam.

**흡수 정당성 없음(반증됨)**: Echo graph-retrieval(E1) — 공개코드가 substring-트리라 semantica graph wiring 정당성을
이 스캐폴드는 못 준다(선행리뷰 echo §6, SOTA 0개가 semantic graph 사용, MEMORY jul-1-swt-bench). Echo dual-version
oracle(E4)/e-Otter patch-side selection(EO3)은 동근원(surrogate code-patch)인데, 우리 acceptance가 *patched-tree*
채점이라 절반 대응 — 완전 대응은 "Agentless식 다수 code-patch 생성후 pre-filter" 인프라가 필요하나 이건 우리 repair가
소스-fix를 직접 하므로 ROI 낮음(measure-first).

**측정레일 갭**: coverage-adequacy 채점(AF5) — TDD-Bench harness(`run_evaluation.py:685-740`)가 pass_after×변경라인
coverage로 over-narrow 가짜green을 수치화. 우리 grading은 F2P binary라 이 신호가 없음(MEMORY jun-28 false-green
반복). 우리 strong-oracle는 프롬프트-측 대응뿐 → **채점 rail에 coverage-곱셈 도입**이 별개 lever(선행리뷰
tdd-bench-otter §5.1).

---

## 3. 10줄 요약

1. Echo가 논문서 내세운 graph-retrieval·dual-version oracle은 **공개코드에 없다**(Prometheus 리브랜딩, substring-트리) — semantica wiring 정당성 못 줌.
2. Echo의 실질 lever는 similar-test few-shot(E3)+LLM-judge(EO4)뿐인데 우리 `repro-grounding.ts`·reviewer로 **이미 보유**(default-OFF).
3. Otter self-reflective planning(O1)은 우리 agent-loop plan-bridge와 동형, ensemble(O3)은 acceptance best-of-N으로 **보유**.
4. Otter rule-based repair(O2, 함수내 import inject)는 **부분 갭** — 우리는 프롬프트 교정(assertion-pin)만, 산출물 정적수정 룰은 없음.
5. e-Otter++ **heterogeneous prompting(EO1, issue-morph×mask)은 없음** — 우리 diversity는 temp+location뿐, morph/mask 축이 빔.
6. e-Otter++ **execution-augmented repair critic-directed read-actions(EO2)는 부분 갭** — 우리는 fail-tail 재주입만, 능동 context 수집 없음(ablation 최대 −21%p).
7. **AssertFlip pass-then-invert(AF1)가 최대 novel 갭 — 완전 없음**; synthesis 수렴 병목에 직결, ablation −19%p 실증.
8. AssertFlip get_info(AF4)는 우리 LSP-nav가 **상위호환**, refinement loop(AF2)/regeneration(AF3)은 repair-rounds·effort-ladder로 유사 보유.
9. 흡수 우선순위: ①flip trick ②heterogeneous prompting(standard/simple/dropCode만, init* 배제) ③critic-directed read-actions — 전부 measure-first A/B, mock/init* 오염 배제.
10. 측정레일 별개 갭: coverage-adequacy 채점(AF5, TDD-Bench `run_evaluation.py:685-740`) — 우리 F2P-binary grading에 없어 over-narrow 가짜green 미포착.
