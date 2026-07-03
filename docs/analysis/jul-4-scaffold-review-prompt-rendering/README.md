# jul-4 — 경쟁 스캐폴드 프롬프트 렌더링 리뷰 + 적대어딧

> 목적: CC / Cursor / Codex + SWE-bench Verified 고득점 오픈스캐폴드(mini-swe / swe-agent / Trae / OpenHands / Agentless)가 **LLM한테 프롬프트를 어떻게 렌더링하는지** verbatim으로 추출하고, "우리가 놓친 것"을 적대적으로 검증해 진짜 흡수후보만 남긴다.
>
> 방법: 3바퀴 병렬 리뷰(실물 소스/번들 file:line 근거) → 적대어딧(우리 코드 + TB 맥락으로 각 claim 대조, 과장 KILL) → 합집합 표 + 에이전트별 특징 + 최종 계획.
>
> 근거 소스: `.extracted_source/{claude-code-cli,cursor,codex-cli}` (번들/심볼덤프), `competitor-scaffolds/{swe-agent,trae-agent,openhands*}` + `swe-bench-tools/mini-swe-agent` (실소스), `.extracted_source/agentless-ref` (연구용), `docs/reviews-{claude,codex}-agent/*`.

## TL;DR (결론 먼저)

1. **흡수할 것 사실상 없다.** 리뷰가 낸 "우리가 놓친 것 4개"는 적대어딧에서 전부 KILLED/PARTIAL. 우리 `SELF_TEST_DISCIPLINE`이 이미 대부분 커버하거나, SWE 관례가 TB(≠SWE)에 안 맞거나, 우리 메커니즘(exit-code 판정)이 다르게 커버.
2. **우리가 오히려 앞선 축이 둘 있다** — **no-leak taint SSOT**(오라클 읽기/세탁 차단; 어느 스캐폴드에도 없음, Agentless는 stdout-match라 오히려 느슨)와 **BOUNDED anti-over-persist**(over-persist 방어; 프로덕트 스캐폴드 대부분 없음).
3. **배치(lost-in-the-middle)는 이미 정렬됨** — self-test discipline을 durable system head로 올림(커밋 900c0a95e). CC의 head+tail split과 같은 지혜.
4. **유일 free A/B 후보 = Gap 2**: self-test를 "finalize 전"이 아니라 "일찍(작업 초반) 짜라"로 리워딩. 기대값 낮음, 측정 후 판단, 절대 무측정 ship 금지.

---

## 1. 합집합 매트릭스

모든 스캐폴드가 렌더링하는 프롬프트 요소의 **합집합**을 행으로, 각 스캐폴드를 열로. `✅` 있음 / `⚠️` 부분·default-OFF gated / `❌` 없음 / `—` 그 패러다임엔 N/A.

| Element | CC | Cursor | Codex | mini-swe | swe-agent | Trae | OpenHands | Agentless | **Ours** |
|---|---|---|---|---|---|---|---|---|---|
| Identity opener | ✅ | ✅ | ✅ | ⚠️ shell-op | ⚠️ task-solver | ✅ | ✅ | — one-shot | ✅ operator-guide |
| Persistence "keep going" | ❌ | ✅ head | ✅ | ❌ | ❌ | ❌ | ❌ | — | ⚠️ oracle-loop OFF |
| Reproduce-first-as-baseline | ⚠️ OFF-gated | ❌ | ⚠️ validate | ✅ | ✅ numbered | ✅ crucial step3 | ✅ | ✅ gen-target | ⚠️ self-test OFF |
| Verify-before-done | ⚠️ OFF-gated | ✅ read_lints | ✅ validating | ✅ rerun | ✅ | ✅ task_done gate | ✅ | ✅ stdout-match | ✅ converge+guide |
| Don't-modify-tests | ❌ | ❌ | ⚠️ no-test-add | ✅ | ✅ | ⚠️ writes-new | ❌ | — | ⚠️ don't-read(≈) |
| Minimal-diff / root-cause | ✅ root-cause | ✅ no_reverts | ✅ | ✅ | ✅ | ✅ clean | ✅ | ✅ SEARCH/REPL | ⚠️ implicit |
| Search-first | ⚠️ Grep-nag | ✅ MANDATORY | ✅ | ⚠️ analyze | ⚠️ | ✅ | ✅ explore | — | ⚠️ probe-first |
| Read-before-edit | ⚠️ tool-desc | ✅ | ✅ | ⚠️ | ⚠️ | ✅ | ✅ | — | ⚠️ probe |
| Edge-cases | ❌ | ❌ | ⚠️ broaden | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ range+edge |
| Anti-thrash | ✅ | ✅ | ✅ newest-wins | ✅ cmd-fail | ✅ cmd-fail | ❌ | ✅ reflect | ❌ | ⚠️ breaker |
| Completion / submit-protocol | ⚠️ | ✅ completion_def | ✅ | ✅ 3-step | ✅ submit-gate | ✅ task_done | ✅ finish | ✅ string-match | ✅ converge verdict |
| Durable-head + tail-reinjection | ✅ boundary token | ⚠️ head-only | ✅ compaction | ❌ | ❌ | ❌ | ❌ | — | ✅ head+guide |
| AGENTS.md / repo-rule ingestion | ⚠️ CLAUDE.md | ❌ | ✅ full spec | ❌ | ❌ | ❌ | ❌ | — | ❌ |
| Plan / todo tool | ✅ tail | ✅ phase-gate | ✅ update_plan | ❌ | ❌ | ⚠️ seq-think | ⚠️ plan-step | — | ❌ |
| Parallel-tool-calls | ✅ | ✅ swarm | ⚠️ multi_tool_use | ✅ | ❌ classic | ❌ | ✅ combine | — | ⚠️ pty |
| No-leak oracle guard | ❌ | ❌ | ❌ | ⚠️ strip-repro | ⚠️ rm-repro | ❌ | ❌ | ❌ | ✅ **TAINT SSOT** |
| BOUNDED anti-overpersist | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ seq-cap | ⚠️ reflect | ✅ N-cap | ✅ **bounded+OFF** |
| Structured format | ✅ md | ✅ | ✅ md | ⚠️ THOUGHT+bash | ⚠️ | ✅ | ✅ XML | ✅ SR/RP | ✅ guide |
| Prompt-injection defense | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | — | ❌ |
| Anti-fabrication / objectivity | ⚠️ FE-only | ✅ prof-obj | ❌ | ❌ | ❌ | ❌ | ❌ | — | ⚠️ clean-exit |
| Write-new regression tests | ⚠️ FE-partial | ❌ | ⚠️ gated | ❌ strip | ❌ strip | ✅ step6 | ✅ pre-fix | ✅ gen | ⚠️ self-test |
| Troubleshooting / reflect | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ 5-7 sources | ❌ | ⚠️ RCA-loop |

**클러스터 판독:**
- **거의 보편** (모든 loop 스캐폴드가 렌더): verify-before-done · completion/submit-protocol · minimal-diff/root-cause · structured-format. reproduce-first · search-first가 그 다음.
- **희소·차별화**: prompt-injection defense(CC만) · AGENTS.md repo-rule(Codex만 full) · **no-leak oracle guard + BOUNDED(우리만 둘 다 명시)** · troubleshooting-reflect(OpenHands만).

---

## 2. 에이전트별 특징 (프롬프트 시그니처)

### Claude Code — *cache-stable head + per-turn volatile tail (명시적 LITM 대응)*
- `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`로 프롬프트 분할: durable 규칙은 캐시-안정 head, 휘발 리마인더(todo/date/plan_mode/critical)는 **매 턴 tail `<system-reminder>`로 재주입** = recency 배치를 의도적 lost-in-middle 대응으로 씀.
- 가장 강한 verify 두 줄(reproduce→re-verify, verified-vs-assumed)은 **둘 다 default-OFF Statsig/env 게이트** — 좋은 검증 습관이 dark로 배포됨.
- **generic persistence 라인 없음.** todo-state 재주입으로 대체.
- lean+legacy 도구설명 2종 + dedicated-tool nag("Grep NOT grep") + anti-shortcut("root cause, not --no-verify, measure twice") + prompt-injection 자기방어.
- **훔칠 것**: head/tail 캐시 split — durable은 캐시, 휘발 상태만 매 턴 recency 슬롯에 재주입.

### Cursor — *persistence-first + 기계검증 가능 completion 계약*
- persistence를 head 최전면("keep going until completely resolved") — CC와 정반대 배치.
- **`completion_definition`이 verify 전제조건을 열거**("how to verify" 섹션 + review-panel clean + progress.md에 성공 기록) = 완료가 체크리스트.
- `professional_objectivity` = anti-fabrication("유저 믿음 확인보다 진실"). `context_understanding` MANDATORY 멀티서치. `read_lints`가 verify 도구.
- orchestrator/swarm variant(phase-gated Clarify→Research→Plan→Review→Implement, "orchestrate don't execute").
- **훔칠 것**: 열거형 `completion_definition` — "다 됐나?"를 체크가능 전제조건 목록으로.

### Codex — *멀티프롬프트 + repo-local rule 흡수 + hot-swap personality*
- **3개 시스템 프롬프트 embed**(Classic CLI / GPT-5-server-templated / role-variant: backend-executor·reviewer·memory-writer) — 배포/역할별 선택.
- 풍부한 `# AGENTS.md spec`(repo-local 규칙, precedence: nested>shallow, prompt>AGENTS.md, developer-message 봉투로 주입).
- personality 서버 hot-swap(`{{personality}}`: pragmatic 기본 "avoid cheerleading/fluff" vs friendly).
- `## Planning` update_plan 플레이북(one in_progress, 패딩마, 하네스가 렌더하니 재진술마) + "newest message wins/오래된 유령 아님" + compaction handoff 재주입 + "스레드 작게 유지" LITM 경고.
- **훔칠 것**: 1급 `AGENTS.md` repo-local rule 흡수(precedence 포함) — 벤더뿐 아니라 타깃 repo가 에이전트 행동을 developer-message 봉투로 주도.

### mini-swe-agent — *SOTA-미니멀, 규율은 submit 의식에 집중*
- 의도적 미니멀 시스템 프롬프트(스캐폴딩 산문 거의 없음).
- 표준: 3단계 **분리-명령 submit 프로토콜**(git diff → `COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT`, "&& 금지 별도 명령", "제출 후 작업 불가").
- reproduce→verify 워크플로 + repro/test/helper 파일 제출서 strip.
- **훔칠 것**: near-zero 프롬프트 + 한 개의 명확한 submit 의식만으로 경쟁력 = 미니멀리즘이 설계 스탠스.

### swe-agent — *reproduce-first, 검증을 TOOL 레이어서 강제*
- reproduce-first 워크플로.
- 표준: **코드레벨 submit-gate**(`review_on_submit_m`: 첫 `submit`이 제출 안 하고 "repro 재실행 / repro 삭제 / git checkout으로 test 복원" 출력 + `exit(0)`).
- verify-before-submit이 프롬프트가 아니라 **코드로 기계 강제**. `-f` force 플래그를 모델서 숨김. late-repro exotic variant.
- **훔칠 것**: tool-layer submit interstitial — 첫 submit 가로채 re-verify 강제(산문 아니라 코드로 보장).

### Trae — *가장 명시적 TDD-first + regression 가드, veto는 코드*
- 가장 명시적 TDD: "**어떤 변경 전에도 반드시** 버그를 재현하는 스크립트를 baseline으로 만들어라" + "regression 방지 위해 NEW test 작성".
- `task_done` 도구설명이 "검증 전 호출 금지"로 자기단속. `must_patch` 빈-diff veto가 코드에(vacuous 제출 기계 거부). sequential_thinking 5-25 thought.
- **훔칠 것**: repro-baseline + NEW regression test를 쌍으로 강제 + `must_patch` 빈-diff veto.

### OpenHands (SDK) — *범용 XML-태그 capability + 구조적 reflection*
- 범용(SWE 특화 아님). XML 태그 섹션.
- 표준 `<TROUBLESHOOTING>`: "반복 실패 시 물러나 5-7개 원인 후보 반성, 확률 평가, 최고확률부터 공략."
- NO-mocks "real code paths 테스트" + `file_v2/file_fix` 중복 금지 + `<EFFICIENCY>` 액션 결합.
- **훔칠 것**: 구조적 `<TROUBLESHOOTING>` 의식 — 5-7 후보 열거→확률순 공략 = thrash 루프 탈출 프롬프트.

### Agentless (연구용) — *에이전트 루프 없음, 한샷 생성 + stdout match*
- 범주적으로 다름: **에이전트 루프 없음.** repro-test = 한샷 GENERATED artifact, **stdout string-match**("Issue resolved")로 판정.
- 견고성 = 샘플링(temp-0 + temp-0.8 ×20) + AST-정규화 + majority-vote = iteration 아니라 통계.
- in-loop 자가검증의 구조적 반대.
- **훔칠 것**: 앙상블 규율(sample→AST-normalize→vote로 한샷 판정 안정화) — 단 stdout-match 자체는 느슨.

### Ours (quanta terminal brain) — *anti-leak taint SSOT + 측정레일*
- **유일 NO-LEAK TAINT SSOT**: 오라클 읽기 OR 세탁 거부 — 다른 스캐폴드에 없고, Agentless는 오히려 느슨(stdout-match 익스플로잇 가능).
- `SELF_TEST_DISCIPLINE`이 이제 durable system head — CC의 캐시-안정 head와 같은 LITM 정렬.
- converge 사후 verdict(L0 run / L1 compare / OC1 clean-exit) = 산문 아닌 명시적 측정레일.
- **BOUNDED** over-persist 방어 — Cursor식 "무한 keep going"의 의도적 반대.
- oracle-loop 하네스강제 + best-of-N = 둘 다 default-OFF(연구식); 프로덕트 스캐폴드는 이걸 하네스강제 안 함.

### 메타패턴
- **프로덕트 스캐폴드 = prompt-suade + LLM 자율.** CC/Cursor/Codex는 검증을 산문/체크리스트로 인코딩하고 모델 루프를 신뢰 — **아무도 하드게이트 안 함.** verification 기계강제는 연구/tool-layer(swe-agent submit-gate, Trae must_patch, Agentless 판정 artifact, 우리 oracle-loop/taint)에만.
- **검증 배치가 진짜 차별점**: 산문 권고(CC/Cursor/Codex) → 도구설명 자기단속(Trae task_done, mini-swe submit 의식) → tool-layer 가로채기(swe-agent submit-gate) → 외부 판정 artifact(Agentless) → taint-SSOT + 측정레일(우리). **오른쪽일수록 게이밍 어려움.**
- **head+tail split이 공통 배치 지혜**: durable 규칙은 head 캐시(CC boundary token, 우리 SELF_TEST_DISCIPLINE), 휘발 상태는 매 턴 tail/recency 재주입(CC reminders, Codex compaction+newest-wins). persistence 배치만 철학 갈림 — Cursor는 최전면, 우리는 의도적 BOUND.

---

## 3. 적대어딧 — "우리가 놓친 것 4개" 검증

기본 가정 = "이미 커버 or TB엔 안 맞음". 강한 증거 없으면 KILL.

| # | claim | verdict | 근거 |
|---|---|---|---|
| 1 | don't-modify-test-files | **KILLED** (negligible) | SWE는 patch서 test 빼는 관례. TB엔 patch도 agent-visible test suite도 없음. 오라클-fake는 프롬프트 아니라 **taint SSOT가 방어**(`oracle-taint.ts:27` `ORACLE_LOCATION_MARKERS`; grader 경로 self-test는 crediting 0). 게다가 우리 이미 "provided test/verifier/answer 읽지마"(`terminal-capability-guide.ts:53`). 라인 추가는 inert+redundant. |
| 2 | reproduce-FIRST as baseline | **PARTIAL, 대부분 KILLED** (low) | provenance가 전부 bug-reproduction 스캐폴드(pre-existing 버그 전제). TB 지배 클래스(polyglot/make-mips/code-from-image)는 **construction** — 재현할 버그 없음("아직 없는 프로그램은 red-first 불가"). 우리 finalize-time framing이 construction에 맞음. delta = "turn-1 vs finalize에 체크 작성" ≈ zero flip(어차피 같은 green 수렴). **유일 free A/B 후보이나 기대값 낮음.** |
| 3 | print success when silent | **KILLED** (zero) | swe-agent는 **stdout scrape**로 판정해서 print 필요. 우리는 **exit-code 판정**: `exercise.ts:108` `resultObservedOutput`(exitCode 있으면 observed) + `:121` `resultRanClean`(exit 0). 조용해도 exit 0이면 이미 observed+clean. 우리 메커니즘엔 print 무의미. |
| 4 | persistence "keep going" | **KILLED** (net-negative) | Codex/Cursor엔 head에 있음(사실). **근데 우리가 이미 측정→REVERT한 것**: `terminal-capability-guide.ts:14-17` "measure-to-gate steer 시도 REVERT — TB 3-task probe서 zero flip + over-persist(unsolvable 태스크 ~3× 오래)". 우리 스탠스는 정반대 BOUNDED(`:54`, `brain-mode.ts:88` `ORACLE_LOOP_MAX_ROUNDS=4` "over-persist bound", verify-gate K=0). "keep going"은 `:54`와 **모순**이고 REVERT한 회귀 재유발. 추가 = net-negative. |

**최종: 4개 다 흡수 안 함.** 진짜 흡수후보는 없거나(1/3/4) marginal(2). Gap 2만 "self-test를 일찍 짜라" 리워딩으로 free A/B 가능하나 무측정 ship 금지.

---

## 4. 최종 계획

### 코드 액션
- **없음(흡수 기준).** 적대어딧이 4갭 다 KILL/PARTIAL. 무측정으로 프롬프트 추가하는 건 노이즈.
- **이미 랜딩된 정렬 유지**: self-test discipline → system head(900c0a95e, LITM 정렬). converge SSOT(taint no-leak). BOUNDED. 이게 우리 차별 강점(표의 우리-only 열).

### measure-first 후보 (박스 A/B, 무측정 ship 금지)
1. **Gap 2 (free)**: `SELF_TEST_DISCIPLINE` 한 줄 리워딩 — "build your self-test EARLY (before you believe you're done), not only at finalize". construction 클래스엔 무해, bug-extend 소수 클래스에 marginal. 기존 `QUANTA_TB_SELF_TEST` knob으로 A/B, self-test↔hidden 정렬율 델타로 판정.
2. (선택) **Cursor `completion_definition` 아이디어**: 우리 converge가 이미 "verified stamp"로 유사하나, 프롬프트에 "완료 선언 전 체크리스트"를 명시하면 exercise↔compare 신호 강화 가능. 근데 우리 converge가 이미 사후 판정하니 중복 소지 — measure-first.

### 방향 재확인 (리뷰로 확정)
- **프로덕트 정렬 = prompt-suade + LLM 자율.** 우리 self-test discipline(프롬프트 유도) 방향 맞음. **oracle-loop(하네스 강제)은 연구/tool-layer 쪽** — 프로덕트엔 없음. default-OFF 유지, 박스서 "강제 vs 자율" A/B 후 삭제 판단.
- **best-of-N**: TB(단일 태스크 construction)엔 부적합. 프로덕트도 critical path 병렬 안 씀. 보류.
- **우리 강점 방어**: no-leak taint SSOT + BOUNDED는 표에서 우리-only. 유지·강화.

### 남은 관문 = 코드 아니라 측정
전 레버 효능 0 측정. 다음 수 = 박스 single-lever A/B(OFF-solo 컨트롤 후, arm 스페이싱): env-owned / self-test / verify-gate / oracle-loop 각각 baseline 대비 델타. **안 오르면 삭제.**

---

## 부록 — verbatim 핵심 인용 (원 리뷰서)

reproduce/verify 코어 (synthesis-convergence 병목 관련):
- **Trae** `agent_prompt.py:23`: "Before making any changes, you **must** create a script that reliably reproduces the bug. This will be your baseline for verification."
- **swe-agent** `config/default.yaml:25`: "4. Rerun your reproduce script and confirm that the error is fixed!"
- **swe-agent submit-gate** `review_on_submit_m/bin/submit:36-42`: 첫 submit이 "run the reproduction script again" 출력 + exit(0), 제출 안 함.
- **Trae** `tools/task_done_tool.py:25`: "you cannot call this tool before any verification is done."
- **Agentless** `test/generate_reproduction_tests.py:62`: "The generated test should be able to be used to both reproduce the issue as well as to verify the issue has been fixed." (판정: `run_reproduction_tests.py:102` `expected_output = "Issue resolved"` stdout-match)

배치/LITM:
- **CC**: durable head(`__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`) + tail `<system-reminder>` 매 턴 재주입(`agent-loop-prompt-injection.md:229-260`).
- **Codex** `_cli-symbols.txt:48818`: "…not an older ghost still lingering in the thread." (newest-wins)
- **Cursor**: "keep going until the user's query is completely resolved… Only terminate your turn when you are sure that the problem is solved."

우리(반증 근거):
- `terminal-capability-guide.ts:14-17`: persistence steer 시도 REVERT(TB zero flip + ~3× over-persist).
- `terminal-capability-guide.ts:53`: "Do NOT read, import, or run any provided test/verifier/answer files."
- `exercise.ts:108,121`: exit-code 기반 판정(stdout-match 아님).
