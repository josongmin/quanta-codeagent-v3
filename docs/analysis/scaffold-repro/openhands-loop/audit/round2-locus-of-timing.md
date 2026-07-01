# Round 2 적대 어딧 — "tool 중심 100%" 주장의 시점(timing) locus 재판정

대상 결론(R1 02/03/04 종합): **"행동 능력의 중심은 tool 계층(100%), system_prompt는 정책 레이어일 뿐."**

본 라운드 임무: 이 "tool 중심" 주장을 적대적으로 깬다. 핵심 공격 명제 —
**tool 은 *능력(capability)* 이지 *순서(order)/시점(timing)* 이 아니다.** "reproduce 를 *언제* 하는가"의 결정자는 tool 이 아니다.

분석 소스: `/Users/songmin/Documents/code-new/competitor-scaffolds/openhands-agent-sdk/`.
모든 file:line 은 `openhands-sdk/openhands/...` 기준(tool 계층만 `openhands-tools/...`).

---

## 0. 판정 요약 (먼저 박는다)

R1 "tool 중심 100%" 는 **차원 혼동(category error)** 이다. "행동"을 세 축으로 분해하면:

| 축 | 정의 | 결정자 | 코드 증거 |
|---|---|---|---|
| **능력(capability)** | 무엇을 *할 수 있나* (run/create/edit/search) | **tool schema (100%)** | executor 가 side-effect 의 유일 공급원 (03 §5 재확인) |
| **순서 권장(recommended order)** | "탐색→테스트→수정→검증"을 *권한다* | **system_prompt + few-shot** | `PROBLEM_SOLVING_WORKFLOW` (system_prompt.j2:60-75); few-shot |
| **시점 결정(actual timing)** | reproduce 를 *이 step 에서 할지* | **모델의 매-step 추론** | step loop 에 phase 분기 0 (agent.py:542-674) |

R1 의 "100%" 는 **능력 축에서만 참**이다. 순서 권장은 tool schema 에 0줄, 전부 prompt 측. 시점 결정은 prompt 도 tool 도 아닌 **모델 추론**이 잡는다. 따라서 "tool 이 행동의 무게중심" 은 *능력* 한정으로 정정되어야 하고, *시점* 의 무게중심은 tool 에서 모델로 이동한다. tool description 안의 행동 지침(exact-text, single-file, verify)은 전부 *개별 tool 사용법*이지 *워크플로 순서*가 아니다(§2 전수 확인).

---

## 1. 능력 vs 순서 분리 — tool schema 에 "순서"는 0줄

**공격 1 입증.** tool 18종(03 §1)의 schema 는 전부 *행위 동사*만 노출한다: `terminal{command,is_input,timeout,reset}`, `file_editor{command∈view/create/str_replace/insert/undo_edit, path,...}`, `grep{pattern,path,include}` 등. 어느 schema 에도 "이 tool 은 reproduce *후에만* / explore *먼저*" 같은 시퀀스 파라미터·전제조건 필드가 없다.

순서를 주는 유일한 SSOT 는 `<PROBLEM_SOLVING_WORKFLOW>` (system_prompt.j2:60-75, 코드 사본 `static.py:178-196` byte-identical):

```
1. EXPLORATION  : explore relevant files ... before proposing solutions   (:61)
2. ANALYSIS     : consider multiple approaches                            (:62)
3. TESTING      : For bug fixes: Create tests to verify issues
                  *before implementing fixes*                             (:64)
4. IMPLEMENTATION: focused, minimal changes                               (:70-73)
5. VERIFICATION : test your implementation thoroughly                     (:74)
```

이 "explore-first / test-before-fix" 순서는 **자연어 산문**으로만 존재한다. 이게 tool 에 있는지 반증 grep:

```
grep -rniE "fail.?to.?pass|pass.?to.?pass" → 0건  (오라클 키 부재)
grep -rniE "reproduction script|majority vot|n-sampl|dual.tree" → 0건
step() 본문(agent.py:542-674): 분기는 pending_actions / blocked_messages
   / condensation / response_type 4종뿐 — phase 변수도 phase if 도 없음
```

→ 순서 권장의 *물리적 위치*는 100% prompt(+few-shot), tool schema 0%. 그러므로 "tool 이 행동 중심" 은 **능력에 한정**되고, *시점/순서*는 여전히 prompt 가 민다. 공격 1 성립.

---

## 2. tool description 의 지침은 *국소적*(per-tool), *전역 순서*가 아니다

**공격 2 입증.** 03 은 "tool description 이 행동지침 다수 보유"(task_tracker 690단어 등)라 했다. 맞다. 그러나 그 지침들이 *워크플로 순서*인지 *개별 tool 사용법*인지 전수 분류하면:

| tool description 내 지침 | 위치 | 분류 |
|---|---|---|
| "old_str must match EXACTLY incl. whitespace" | file_editor/definition.py:181 | per-tool 사용법 (어떻게 edit) |
| "Verify the parent directory exists (use view first)" | file_editor/definition.py:169-172 | per-tool 전제 (이 tool 호출 전) |
| "prefer all edits in a single message" | file_editor/definition.py:189 | per-tool 호출 형태 |
| "One command at a time, use && or ;" | terminal/descriptions.py:9-10 | per-tool 사용법 |
| "Write a script first with file_editor, then invoke" | terminal/definition.py:42-44 | 런타임 *교정* (literal-arg 거부 시) |
| "Limit active work to ONE task" | task_tracker/definition.py:291,380 | per-tool 사용 규칙 |
| "Never mark done when test suites failing" | task_tracker/definition.py:388-392 | per-tool 상태 규칙 |

전수 결과: **워크플로 순서("explore 먼저, fix 전 test")를 박은 tool description 은 0개.**
- file_editor `:169-172` 의 "view first" 는 *file_editor 한 호출 내부*의 전제(편집 전 그 파일을 봐라)이지, "코딩 phase 전에 reproduce phase" 같은 *전역 단계*가 아니다.
- terminal `:42-44` 의 "script first" 는 literal-arg 가드의 *교정 메시지*(impl.py:549-568 에서 `is_error=True` observation)이지 순서 강제가 아니다 — "bash 자리에 dict 넣지 마라"의 우회 안내.
- task_tracker `:388-392` 의 "test 통과 전 done 금지" 가 가장 순서-비슷하지만, 이건 *task_tracker 의 mark-done 조건*이지 reproduce *시점*을 못 박지 않는다(테스트를 *언제* 만드는지엔 무관).

→ tool description 의 지침은 전부 **국소(이 tool 을 이렇게 써라)**. 전역 워크플로 순서는 오직 system_prompt 의 `PROBLEM_SOLVING_WORKFLOW` 에만 산다. 03 의 "tool 이 행동지침 다수 보유" 는 *능력별 사용지침* 으로 정확히 한정해야 하며, 그것을 "행동의 시점/순서를 tool 이 쥔다"로 확대하면 과대주장이다. 공격 2 성립.

---

## 3. 3자 인과 재판정 — prompt 도 tool 도 "결정자"가 아니다, 모델이다

**공격 3 입증 (반대 극단 경계 포함).** "그럼 prompt 가 시점을 *결정*하는가?" — 이것도 과한 주장이다. 02 가 입증했듯 step loop 에 phase 분기는 0이다(agent.py:542-674). 인과를 정밀히 세우면:

```
[입력1] system_prompt 워크플로  ─┐
[입력2] few-shot (조건부, §4)   ─┤→  매-step LLM 추론  ──→  tool_call 1개  ──→  실행
[입력3] tool schema(능력 메뉴)  ─┘   (= 결정자)              (능력 사용)
```

- **prompt** = 시점의 *입력*(권장). 결정자가 아님 — `:64` 는 MUST 아님(§4 강제성 분석: 같은 prompt 가 강제 시 `NEVER`(:26)/`Important`(:53) 대문자 컨벤션 쓰는데 `:64` 엔 없음), `:68-69`/`:74` 환경 조건부 *탈출 출구* 명시. 코드는 모델이 이 순서를 어겨도 검사·차단 안 함.
- **tool** = 능력의 *입력*(메뉴). `_get_action_event` (agent.py:983-1037) 가 하는 일은 `tools_map.get(tool_name)` (agent.py:1019) — 이름→인스턴스 순수 매핑. 실패 케이스는 "not found"(agent.py:1020-1035) 단 하나, "지금 이 tool 은 phase 상 금지" 같은 게이팅 **0**. 매 step 전체 tool 셋 노출(`list(self.tools_map.values())`, agent.py:596).
- **모델** = 시점의 *결정자*. response_type 분기(agent.py:657-674)는 TOOL_CALLS vs CONTENT vs EMPTY 만 가르지 *어떤 tool 인지*로 가르지 않는다. 즉 "이 step 에 reproduce 할지" 는 harness 가 못 받고, 전적으로 모델이 뱉은 tool_call 이름으로 *사후*에 정해진다.

→ 정정된 인과: **prompt 와 tool 은 둘 다 모델 추론의 입력일 뿐, 시점의 결정자는 (권장을 입력으로 받은) 모델의 매-step 추론.** R1("tool 이 결정자")도, 단순 반대극단("prompt 가 결정자")도 둘 다 틀렸다. 결정자는 모델이다. 공격 3 성립.

---

## 4. 시점 결정 무게의 모델-강도 의존성 — prompt→모델 이동

**공격 4 입증.** few-shot 주입 경로가 모델 강도에 따라 prompt 의존을 깎는지 코드로 검증:

- few-shot(Flask ICL 예시)은 `is_first_user_message and add_in_context_learning_example` 일 때만 주입(fn_call_converter.py:398). 그리고 이 변환 경로 자체가 **non-native-FC 모델 전용**(non_native_fc.py 가 native FC off 일 때만 fncall→non-fncall 변환).
- 추가로 `add_iclex = not any(s in self.model for s in ("openhands-lm","devstral","nemotron"))` (non_native_fc.py:48-50): 특정 약-모델 패밀리엔 그나마도 *끈다*("models that understand the format" 주석, :46-47).

해석: native function-calling 모델(최신 Claude/GPT 등)은 fn_call_converter 경로 자체를 안 타므로 **few-shot 0 주입**. 즉 강한(native-FC) 모델일수록 (c)few-shot 의존이 0 으로 떨어지고, 남는 steer 는 (b)system_prompt 산문 권장뿐. 그 권장마저 비강제(§3)라 실제 시점은 모델 자율(d)이 흡수.

→ 가설 "시점 결정의 무게가 모델 강도에 따라 prompt→모델로 이동" **코드로 지지됨**. 약한 모델: few-shot+prompt 가 시점을 강하게 견인(reactive build-run-debug 패턴을 Flask 예시가 시연, 04 §3). 강한 모델: few-shot 증발 → prompt 는 약권장 → 시점 무게가 모델 추론으로 쏠림. 단 정량 비중은 측정 미실시(코드는 "주입/미주입"의 *가능성*만 입증; 실제 시점 행동의 모델별 분포는 A/B 필요 — 미검증). 공격 4 성립(방향), 정량은 보류.

---

## 5. 최종 판정 — "tool 중심 100%"의 3-축 분해 및 점수 영향 순위

R1 정정:

- **능력(capability) = tool (100%)** — 유지. executor 가 side-effect 유일 공급원, schema 없으면 호출 불가(03 §5). 이 축에서 R1 은 옳다.
- **순서 권장(recommended order) = system_prompt + few-shot** — tool schema 0줄. R1 의 "행동 중심 tool" 을 *순서*로 확대하면 거짓.
- **시점 결정(actual timing) = 모델의 매-step 추론** — prompt·tool 모두 입력일 뿐. harness 에 phase gate 0(02).

**점수(SWE 해결률)에 가장 영향 큰 축은?** 코드만으로는 단정 불가(측정 필요)지만 구조적 추론:
- 능력(tool)은 *필요조건*이나 *포화*다 — 3종(실행/편집/검색)이 모든 preset 에 무조건 포함(03 §1), 경쟁 스캐폴드 간 차이 작음. 능력 추가의 한계 점수 기여 낮음.
- 시점 결정(모델 추론)이 *변별 변수*다 — 04 §6 및 우리 MEMORY(jun-29 synthesis 수렴 병목, jun-28 oracle-loop 부재)와 일치: "맞는 파일 짚고도 edit 수렴 실패" = 능력 문제 아님, *언제 무엇을 검증/재시도하는지*(시점)의 문제. OpenHands 는 이 시점을 harness 가 안 잡고 모델에 위임 → 강한 모델에 점수가 묶임.
- 순서 권장(prompt)은 그 사이 *약한 레버* — 비강제라 강모델에서 효과 희석.

→ **결론: 점수 무게중심 = 시점 결정(모델 추론) > 능력(tool) > 순서 권장(prompt).** R1 "tool 100%" 는 *능력 축에서만* 참이며, 정작 점수를 가르는 *시점* 축에서 tool 의 기여는 0(게이팅 없음)이고 모델이 지배한다. 따라서 "행동 능력의 중심은 tool" 은 옳되, "행동(=시점 포함)의 중심은 tool" 로 읽으면 과대주장이다. OpenHands 설계 철학은 *능력은 tool 로 풍부하게 공급, 시점은 모델에 위임, 순서는 prompt 로 약하게 권장* 의 3분할.

---

## 10줄 요약

1. R1 "tool 중심 100%" 는 차원 혼동: "행동"=능력+순서권장+시점결정 3축인데 R1 은 *능력* 축만 100% 입증하고 전체로 확대.
2. **능력**=tool schema/executor 100% (유지, 03 §5 옳음): side-effect 유일 공급원.
3. **순서**(explore→test→fix→verify)는 tool schema 에 0줄, 오직 `PROBLEM_SOLVING_WORKFLOW`(system_prompt.j2:60-75)+few-shot 에만 — 공격1 성립.
4. tool description 의 지침(exact-text file_editor:181, verify-dir :169-172, ONE-task task_tracker:291)은 전부 *per-tool 사용법*, 전역 워크플로 순서 박은 tool 0개 — 공격2 성립.
5. step loop(agent.py:542-674)에 phase 분기 0; `tools_map.get(name)`(agent.py:1019)은 이름→인스턴스 순수매핑, 실패는 "not found" 뿐, phase 게이팅 0.
6. 인과 재판정: prompt·tool 둘 다 *입력*, **시점 결정자는 매-step 모델 추론** — R1(tool=결정자)도 반대극단(prompt=결정자)도 둘 다 오류, 결정자는 모델(공격3).
7. `:64` "create tests before fixing" 은 MUST 아님(같은 prompt 의 NEVER/:26·Important/:53 강제 컨벤션 부재)+환경 조건부 탈출(:68-69,:74) → soft nudge.
8. few-shot 은 non-native-FC 한정(fn_call_converter.py:398)+약모델 패밀리 제외(non_native_fc.py:48); native 강모델엔 0 주입 → 강할수록 prompt/few-shot 의존↓, 시점 무게 prompt→모델 이동(공격4, 방향 코드지지·정량 미측정).
9. 최종: 점수 무게중심 = **시점결정(모델) > 능력(tool, 포화) > 순서권장(prompt, 약레버)**; tool 의 시점 기여는 0(게이팅 없음).
10. 정정문: "행동 *능력*의 중심은 tool(참)"; "행동 *시점*의 중심은 모델 추론"; "순서는 prompt 약권장" — R1 을 능력/순서/시점으로 3분할해야 정확.
