# OpenHands (agent-sdk) 방법론 전개 + quanta 준비도 매핑 — 2026-06 기준

> 작성 2026-07-01. 초상위권 agentic 스캐폴드 **OpenHands**(SWT-bench Verified 79.8% w/ GPT-5, SWE-bench Verified 상위권)의
> 방법론을 코드 file:line으로 전부 펼치고, 우리(quanta-codeagent-v3)의 각 대응물을 `src/` file:line으로 매핑한다.
>
> **원본 소스**: `/Users/songmin/Documents/code-new/competitor-scaffolds/openhands-agent-sdk/` — 이하 OpenHands file:line은 이 트리 기준.
> **우리 소스**: `/Users/songmin/quanta-codeagent-v3/src/` — 이하 quanta file:line은 이 트리 기준.
> **재활용**: 이 문서는 앞선 5축 코드분석(`openhands-loop/01~06`)과 5바퀴 적대 어딧(`openhands-loop/audit/round1~5`)에서
> 이미 코드-핀된 결론을 **방법론 관점으로 재정리**한 것이다. 신규 grep은 각 방법론의 원본 위치·우리 대응물 확인용으로만 수행했고,
> 5바퀴에서 수렴한 정정(critic finish-gate 실재하나 default-OFF·repro 미검사; tool수=18/base3/repro2; condenser=진입점 의존 등)을 전제로 깐다.
>
> ⚠️ **scope 고정(5바퀴 §4-1 최대 약점 계승)**: 우리가 읽은 것은 `openhands-agent-sdk` 오픈소스 **default 코드 경로**다.
> All-Hands가 리더보드에 제출한 production config(외부 API critic `critic/impl/api/critic.py` 켜짐 여부·하네스 래퍼)는
> 이 트리에 없다. 아래 "OpenHands는 X를 자율로 맡긴다"류 명제는 전부 **SDK default 경로 한정**이며, 제품 일반화 시 unproven.

---

## 0. 핵심 판정 (TL;DR)

- OpenHands 방법론 7개(워크플로/repro-임시진단물/tool런타임/tool-desc few-shot·동적/condenser/critic finish-gate/모델자율)를 전개하니,
  **6개는 우리가 이미 대응물을 보유**(대개 우리가 *code-hard 게이트*라 OpenHands의 *prompt-soft*보다 강함), **1개는 방향이 정반대**(repro를
  OpenHands는 "확인 후 삭제할 임시물"로 격하 vs 우리는 fix-오라클로 되먹임).
- **우리에게 없는 OpenHands 방법론 = 0.** repro 전용 엔진(N-sampling/majority-vote/dual-tree)은 **OpenHands 쪽이 부재**(5바퀴 S1, HIGH).
  즉 흡수할 새 repro lever가 OpenHands엔 빈 우물이다.
- **우리가 더 가진 것**: (a) localization을 실제 tool-BLOCK으로 강제하는 phase-guard, (b) repro를 fix-오라클로 되먹이는
  acceptance/repro-vote 파이프라인, (c) empty-stream K-회 circuit breaker. OpenHands엔 셋 다 없음(모델 자율에 위임).
- 방법론 관점 순결론: OpenHands는 "비강제 워크플로 15줄 + terminal/file_editor 능력 + 매-step 모델 자율"의 조합이고,
  우리는 그 soft-nudge 층을 code-hard 게이트로 승격한 것 — **plan 변경 없음(측정 rail 우선), harness-강제 철학은 재검토 대상 아님**.

---

## 1. OpenHands 방법론 전개 (코드 file:line)

### (a) PROBLEM_SOLVING_WORKFLOW — explore→analysis→TESTING(fix 전 test)→implement→verify

5단계 워크플로가 **system prompt의 정적 텍스트 블록**으로만 존재한다. 원본은 Jinja 템플릿, 그 verbatim 포트는 Python 상수:

- 템플릿: `system_prompt.j2:60-75` — `<PROBLEM_SOLVING_WORKFLOW>` 1.EXPLORATION → 2.ANALYSIS → 3.TESTING → 4.IMPLEMENTATION → 5.VERIFICATION.
- 포트: `context/prompts/sections/static.py:178-196` (`ProblemSolvingSection.body`, `cache_tier=STATIC`, `guard`는 항상 `True` → 무조건 렌더).
- **fix 전 test 신호 본체**: `system_prompt.j2:64` `"For bug fixes: Create tests to verify issues before implementing fixes"`.
- **비강제 확정**: MUST/SHALL 부재 + 환경 조건부 출구(`:68-69` "If the environment is not set up to run tests, consult with the user first", `:74` VERIFICATION도 동일 조건부). 즉 "권고"지 게이트 아님.
- **강제 부재 확정**: 이 15줄은 conversation당 1회 freeze되는 정적 상수이며, step loop에 phase 분기가 0(5바퀴 S3/S4). 워크플로 순서를 코드가 검사·차단하지 않는다.

### (b) reproduce = 임시 단일파일 진단물 (확인 후 삭제)

reproduce 산출물을 "1급 오라클"이 아니라 **버릴 임시 디버그물**로 격하하는 지침이 `<FILE_SYSTEM_GUIDELINES>`에 박혀 있다:

- `system_prompt.j2:26-31` = `static.py:131-136` (`FileSystemSection.body`):
  - `:28`/`:133` "If you need to create a temporary file for testing, **delete it once you've confirmed** your solution works"
  - `:31`/`:136` "When reproducing bugs or implementing fixes, use a **single file** rather than creating multiple files with different versions"
  - `:26`/`:131` "NEVER create multiple versions of the same file with different suffixes (file_test.py, file_fix.py …)"
- **의미**: OpenHands의 "reproduce"는 build-run-debug 디버그 루프(깨지면 로그 보고 고침)이고, 재현물은 fix 확인 후 폐기 대상.
  fail-to-pass **재현 테스트 작성**이나 그 테스트를 **fix 오라클로 재활용**하는 메커니즘은 없다(5바퀴 S1: grep `fail.?to.?pass`/`majority vot`/`n-sampl`/`dual.tree` 전부 0건).

### (c) 실행 가능한 tool 런타임 (terminal / file_editor + 레지스트리 총 18종)

능력(=side-effect)은 100% tool schema+executor가 공급한다. 레지스트리 자동등록, preset이 default 바인딩:

- **레지스트리 총 18종 등록**(`register_tool(...)` 실측): file_editor·terminal·grep·glob·apply_patch·task_tracker·browser·task(+ToolSet)·workflow(+ToolSet)·planning_file_editor·tom_consult(+sleeptime)·gemini{read_file,edit,list_directory,write_file}. 위치 예: `file_editor/definition.py:272`, `terminal/definition.py:352`, `grep/definition.py:129`, `glob/definition.py:132`, `apply_patch/definition.py:181`, `task_tracker/definition.py:435`.
- **default preset 바인딩 base = 3개**: `preset/default.py:52-55` `Tool(TerminalTool)`, `Tool(FileEditorTool)`, `Tool(TaskTrackerTool)` + 옵션(browser if `enable_browser`, `:57-60`; task if `enable_sub_agents`, `:61-64`) + SDK builtins(finish/think).
- **reproduce 직접 사용 = Terminal + FileEditor 2개**(bash 실행 + 파일 편집). "16 tool"은 preset×browser-fanout(8 action) 조합 추정치이지 코드 직접 카운트 아님(5바퀴 (b), MED).
- **런타임성**: terminal이 실제 bash 실행 환경, file_editor가 view/create/str_replace 실행. 즉 능력은 "협상 불가"로 전 preset 무조건 노출.

### (d) tool description — few-shot + 런타임 동적 주입

tool description이 정적 리터럴이 아니라 (i)절차서 (ii)few-shot (iii)런타임 상태 조립을 섞는다:

- **런타임 동적 주입(cwd/vision)**: `file_editor/definition.py:245-251` — `create_from_state(conv_state)`가 `working_dir = conv_state.workspace.working_dir`를 뽑아 `"Your current working directory is: {working_dir}"`를 description에 삽입. vision 조건부: `:233` `if conv_state.agent.llm.vision_is_active():`로 이미지-view 줄 동적 삽입.
- **런타임 교정 hint**: `terminal/definition.py:37-42` `_LITERAL_ARG_HINT_TEMPLATE`(`:42` "Write a script first with `file_editor`") + `:55` `looks_like_python_literal_argument()` — command 첫 바이트가 `[{`/`{"` 등 리터럴이면 `impl.py:550,561`에서 실행 거부하고 hint를 `is_error` observation으로 되먹임. (5바퀴 (d): reproduce 강제 아니라 **malformed-argument 교정기**.)
- **few-shot in description**: `task_tracker/definition.py:270-435` — 690단어 절차서 + 3 Scenario + 2 Counter-example("Never mark done when: Test suites are failing"). file_editor도 ~338단어 절차서.
- **별도 채널 few-shot(ICL)**: `llm/mixins/fn_call_converter.py:398` `if is_first_user_message and add_in_context_learning_example:` → Flask 예제 주입. 단 **non-native-FC 경로 전용**이고 `add_iclex`가 약모델 제외(`non_native_fc.py:48`) → 강모델 native-FC엔 미주입(5바퀴 S7, HIGH).

### (e) condenser (context 압축) — 진입점 의존

history 길이 관리기. ON/OFF가 진입점에 달림:

- bare 생성자: `agent/base.py:402-417` `condenser: CondenserBase | None = Field(default=None)` → OFF.
- convenience 팩토리: `preset/default.py:85-87` `get_default_agent`가 `condenser=get_default_condenser(...)` 명시 배선 → ON. 기본값 `max_size=80/keep_first=10`(`base.py:413-414`), 구현 `llm_summarizing_condenser.py:478 default_condenser()`.
- **역할**: history-길이 관리(오래된 이벤트 요약)이지 reproduce 트리거 아님(5바퀴 (c)).

### (f) critic finish-gate (default-OFF) — 완료성 hard-gate

**loop-level hard gate가 코드에 실재**하되 default-OFF, 그리고 reproduce 미검사:

- gate 본체: `agent/critic_mixin.py:76-138` `_check_iterative_refinement` — critic 점수 < success_threshold && iteration < max_iterations이면 `(True, followup)` 반환 → finalize가 finish 무효화하고 재작업 강제. `:91` `if self.critic is None … return False, None` 단락.
- **default-OFF**: `agent/base.py:419-427` `critic: CriticBase | None = Field(default=None, description="EXPERIMENTAL…")`. 켜야만 작동.
- **reproduce 미검사**: shipped `AgentFinishedCritic.evaluate`(`critic/impl/agent_finished.py:49-71`)는 (1)non-empty git patch(`:49`) + (2)마지막 action이 FinishAction(`:59`)만 검사. 재현했는지/테스트 먼저 썼는지 검사 0. (외부 API critic `critic/impl/api/critic.py`는 서버 점수기라 검사 내용 코드로 불명 = scope 밖.)

### (g) 모델 자율 (시점 hard-gate = 0)

시점·순서 결정을 전적으로 매-step 모델 추론에 위임:

- step loop(`agent/agent.py`)에 "이 phase엔 이 tool만" 게이팅 0. `tools_map.get(name)`은 순수 매핑(5바퀴 S4). response 분기는 tool_calls/content/empty만 가르지 *어떤 tool*인지로 안 가름.
- reproduce 시점 hard-gate = 0(5바퀴 S2, HIGH): step loop·run loop에 "재현했는가/테스트 먼저 썼는가" 검사 분기 0. critic조차 시점이 아니라 *종료*를 친다.
- 즉 prompt(권고 입력) + tool(능력 메뉴) → 결정자 = 모델. 워크플로 순서·reproduce 시점은 강제되지 않는다.

---

## 2. 우리 준비도 매핑 — [방법론 | OpenHands 코드근거 | 우리 코드위치 | 상태]

상태 태그: **있음(우리 우위)** = 대응물 존재하고 우리가 code-hard라 더 강함 / **있음(parity)** = 동등 / **방향 반대** = 우리가 정반대 설계로 보유 / **없음** / **미측정** = 존재하나 효과 A/B 안 됨.

| # | 방법론 | OpenHands 코드근거 | 우리 코드위치 (`src/`) | 상태 |
|---|---|---|---|---|
| (a) | PROBLEM_SOLVING_WORKFLOW (explore→analysis→TESTING→impl→verify, 비강제 15줄) | `system_prompt.j2:60-75` / `static.py:178-196` (guard 항상 True, MUST 부재) | 워크플로 프롬프트: `agent/prompt.ts:287`("investigate, then produce…"), `agent/prompt-body.ts:169-170,223-224`(read-until-sufficient + 3-stage localize). **+ 코드 강제**: `agent/localize-phase-guard.ts:142`(Phase1 동안 mutating tool 실제 BLOCK, nudge "edits are blocked until you have identified the exact file and function") + `agent/exploration-ladder.ts` | **있음(우리 우위)** — OpenHands는 soft-nudge, 우리는 hard-BLOCK |
| (b) | "fix 전 test 작성" (TESTING 단계) | `system_prompt.j2:64` (비강제, 환경 조건부 출구 `:68-69`) | repro-test 파이프라인 `agent/repro-test/{generate,execute,select}.ts` + knob `runner/knobs/knobs/repro-test.ts`·`verify-select-repro.ts`; repro-doubt 안정화 `agent/repro-doubt-guard.ts:63` | **있음(우리 우위)** — 1급 파이프라인 단계 |
| (b') | reproduce = 확인 후 삭제할 임시 단일파일 진단물 | `system_prompt.j2:26-31` / `static.py:131-136` (`:28` delete, `:31` single-file) | 우리 repro = **fix 오라클로 되먹임**(폐기 아님): acceptance/repro-vote `runner/batch/eval/repair/repro-vote.ts`, `runner/batch/eval/repro-adapter.ts`, `repro-oracle-calibration.ts` | **방향 반대** — 우리 차별점(repro=oracle), OpenHands는 버림 |
| (c) | 실행 tool 런타임 (terminal/file_editor + 레지스트리 18종, base 3, repro 2) | `preset/default.py:52-55`; `register_tool` 18건(`terminal/definition.py:352` 외); repro=Terminal+FileEditor | BASE 26종 무-게이트 `tool/gated-tools.ts:13-40`, bench 무조건 노출 `runner/…driver.ts:2507` (`buildDefaultTools()`); reproduce 3종 bash/edit·apply_patch/grep·glob 모두 BASE (openhands-loop/06 §A6) | **있음(parity, 우리 상시 tool 더 많음)** |
| (d) | tool desc few-shot + cwd/vision 동적 주입 + literal-교정 hint | `file_editor/definition.py:245-251`(cwd), `:233`(vision); `terminal/definition.py:37-42,55`(literal hint); `task_tracker/definition.py:270-435`(690단어 few-shot) | 우리 desc = 정적 리터럴 ~90%(openhands-loop/06 §A2), 동적 주입 0건(§A3), few-shot 0건(§A4), bash literal-교정 hint 부재 | **없음** (단 openhands-loop/06 §D: 강모델 native-FC 조건 + 능력 동등이라 **점수 영향 여지 낮음, 미측정**) |
| (e) | condenser (context 압축, 진입점 의존 max_size80/keep10) | `base.py:402-417`(bare None), `preset/default.py:85-87`(팩토리 ON) | compaction 파이프라인 `agent/compaction.ts`(keepRecentTurns 초과분 1개 요약, `:42-43`) + `agent/compaction-breaker.ts` + `agent/loop/compaction-wire.ts` + `agent/conversation-summary-archive.ts` | **있음(parity)** |
| (f) | critic finish-gate (완료성 hard-gate, default-OFF, repro 미검사) | `critic_mixin.py:76-138` + `base.py:419`(default None, EXPERIMENTAL) + `agent_finished.py:49-71`(non-empty patch+FinishAction만) | verify-guard finish-gate `agent/guards/verify-guard.ts:31,52-63`(finish 시도가 verify policy 통과해야 anchor 전진, Cursor markVerifiedV2 패턴) + `agent/verify-guard.ts`; no-patch-breaker `agent/no-patch-breaker.ts`; closure-repair `agent/closure/`·`runner/knobs/knobs/closure-repair.ts` | **있음(우리 우위)** — 우리 verify-guard는 default 켬 경로 존재 + verify 통과를 종료조건화 |
| (g) | 모델 자율 (시점 hard-gate 0, step loop phase 분기 0) | step loop 게이팅 0; repro 시점 hard-gate 0 (5바퀴 S2/S4) | 우리는 **정반대**: `localize-phase-guard.ts:142`(phase별 tool BLOCK), `git/directive-emit/phase-guard.ts`, verify-guard 종료 게이트 → harness-강제 | **방향 반대(우리 강제)** — jun-27-11141서 강제(sticky-red)가 gpt-5.4 PASS시킨 직접 측정 보유 |
| (repro 엔진) | N-sampling / majority-vote / dual-tree repro 생성기 | **부재**(5바퀴 S1 grep 0건) | repro-vote/best-of-N `runner/batch/eval/repair/repro-vote.ts`, `agent/repro-test/select.ts`(select), acceptance rerank | **우리만 있음** — OpenHands가 흡수원으로 빈 우물 |

---

## 3. 핵심 판정 — 방법론 관점 갭/우위

### 3-1. OpenHands 방법론 중 우리가 없는 것 = 실질적으로 0

7개 방법론 전개 결과, **우리가 대응물을 안 가진 유일한 항목은 (d) tool-description few-shot/동적주입**이다. 그런데:
- 이건 *능력* 갭이 아니라 *desc 밀도* 차이다. reproduce **능력**(bash/edit/grep)은 우리 BASE에 100% 존재(openhands-loop/06 §A6).
- 5바퀴 결론: few-shot은 강모델 native-FC엔 애초에 미주입(S7); cwd 동적주입·literal-교정은 약모델의 오입력을 tool층이 교정하는 장치라 강모델(gpt-5.x)선 marginal 가치 낮음. → **점수 원인으로 귀속 불가(미측정), 흡수 우선순위 낮음.**

나머지 6개는 전부 우리가 보유하며, (a)(b)(f)(g)는 우리가 **code-hard 게이트라 OpenHands의 prompt-soft보다 강하다**.

### 3-2. repro 방법론은 OpenHands가 오히려 빈 우물 (S1, HIGH)

우리가 흡수하려던 건 "좋은 repro-test 품질"이었는데, OpenHands에 **repro-test 생성 엔진 자체가 부재**(N-sampling/majority-vote/dual-tree grep 0건). 게다가 방향이 정반대다:
- OpenHands: repro = "확인 후 삭제할 임시 단일파일 진단물"(`static.py:131-136`).
- quanta: repro = "fix를 검증·선별하는 오라클"(repro-vote/acceptance, `repair/repro-vote.ts`).

즉 우리 핵심 차별점(repro=oracle 루프)을 OpenHands는 *버린다*. OpenHands에서 흡수할 repro lever는 없다.

### 3-3. 우리 우위 3종 (OpenHands 부재)

1. **localization을 tool-BLOCK으로 강제** (`localize-phase-guard.ts:142`) — OpenHands는 phase 게이팅 0(모델 자율).
2. **repro를 fix-오라클로 되먹임** (`repair/repro-vote.ts`, acceptance rerank) — OpenHands는 repro 폐기.
3. **empty-stream K-회 circuit breaker**(jun-26, `QUANTA_LLM_EMPTY_STREAM_BREAKER_K`) — OpenHands는 무한 corrective nudge.

### 3-4. 자율 vs 하네스-강제 — 방향 전환 근거 0

OpenHands의 "모델 자율"이 리더보드 상위인 건 **강한 model + scaffold의 산물**(round3: same-model 12.8pp scaffold, repo 40-70pp 지배)이지 "자율 그 자체"의 인과 아님(model-confounded). 반대로 우리에겐 **강제가 약모델을 보정한 직접 측정**(jun-27-11141: sticky-red가 gpt-5.4를 naive-trap에서 PASS)이 있다. 따라서 harness-강제는 "재검토 대상"이 아니라 우리 측정으로 지지된 선택 — 단, 게이트가 *틀렸을 때*(jun-21 astropy 하드킬) 자율이 안전 fallback이라는 에지 경고로만 유효(=게이트를 옳게·default-OFF·measure-first로 유지하라는 기존 원칙 재확인).

### 3-5. 미측정 잔여 (정직)

- (d) desc few-shot/동적주입의 점수 효과: **미측정**. 주장하려면 working_dir 주입 on/off·bash literal-hint on/off·desc 장문화 on/off를 default-OFF knob로 심고 bench A/B 필요.
- scope: SDK default 경로 한정. All-Hands production이 외부 API critic(`critic/impl/api/critic.py`)에 reproduce-검사를 넣었는지는 코드 밖 = 미확인(후속 ROI MED, 측정 rail보다 후순위).

---

## 10줄 요약

1. OpenHands 방법론 7개(워크플로/repro-임시진단물/tool런타임/desc-fewshot·동적/condenser/critic-gate/모델자율)를 코드 file:line으로 전개 — 원본은 `system_prompt.j2` + `static.py` + `preset/default.py` + `critic_mixin.py`.
2. **(a) 워크플로** = 비강제 15줄(`system_prompt.j2:60-75`, MUST 부재+환경 조건부 출구). 우리는 `prompt.ts:287`+`localize-phase-guard.ts:142`로 **hard-BLOCK 강제** → 우리 우위.
3. **(b') reproduce = 확인 후 삭제할 임시 단일파일**(`static.py:131-136`). 우리는 **repro=fix-오라클**(`repair/repro-vote.ts`) → 방향 정반대, 우리 차별점.
4. **(c) tool 런타임** = 레지스트리 18종/default base 3/repro 핵심 2(`preset/default.py:52-55`). 우리 BASE 26종 무-게이트(`gated-tools.ts:13-40`) → parity(우리 상시 tool 더 많음).
5. **(d) desc few-shot+cwd/vision 동적주입+literal-교정**(`file_editor/definition.py:245-251`, `terminal/definition.py:42`, `task_tracker/definition.py:270-435`) = **우리 유일 미보유**. 단 강모델 native-FC 조건서 영향 여지 낮음, 미측정.
6. **(e) condenser** = 진입점 의존(`base.py:402` OFF / `preset/default.py:85` ON). 우리 `compaction.ts` 보유 → parity.
7. **(f) critic finish-gate** = 실재하나 **default-OFF·reproduce 미검사**(`critic_mixin.py:76-138`, `base.py:419`, `agent_finished.py:49-71`). 우리 verify-guard(`guards/verify-guard.ts:31,52-63`)는 종료를 verify-통과로 게이트 → 우리 우위.
8. **(g) 모델 자율** = 시점 hard-gate 0(step loop phase 분기 0). 우리는 phase-guard로 **정반대(강제)**; jun-27-11141서 강제가 gpt-5.4 PASS시킨 직접 측정 보유.
9. **핵심 판정**: 우리가 없는 OpenHands 방법론 ≈ 0(desc-fewshot 1개만, 저-영향·미측정). repro 전용 엔진은 **OpenHands가 부재**(S1 HIGH)라 흡수원 빈 우물. 우리 우위 3종=phase-BLOCK·repro-oracle·empty-stream breaker.
10. **plan 영향 0**: harness-강제는 재검토 대상 아니라 우리 측정으로 지지된 선택(자율은 model-confounded). 다음 레버=측정 rail. scope=SDK default 경로 한정(production critic config 미확인=후속 MED). 게이트를 옳게·default-OFF·measure-first로 유지하라는 기존 원칙 재확인.
