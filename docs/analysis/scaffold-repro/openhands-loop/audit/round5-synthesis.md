# Round 5 — 종합 + 메타 적대 (5바퀴 적대 어딧의 최종 수렴)

분석 소스: `/Users/songmin/Documents/code-new/competitor-scaffolds/openhands-agent-sdk/`
모든 file:line은 그 트리 기준. 본 라운드는 신규 grep보다 앞선 5축 코드분석(01~05)과 4바퀴 적대(round1~4)를 **reconcile**하고, 5바퀴를 통과해 살아남은 명제만 confidence와 함께 박은 뒤, 그 종합 결론 자체를 한 번 더 공격한다. 쟁점 5건은 소스 재확인(`base.py:402/419`, `preset/default.py:52-90`, `critic_mixin.py:91`)으로 ground-truth 재핀.

---

## 1. 정정 원장 (reconciliation table)

앞 라운드들이 서로 잡은 over-claim/오류 정리. **누가 정정**은 최초로 그 오류를 코드로 깬 라운드.

| # | 원 claim (출처) | 누가 정정 | 코드 ground-truth | 최종 상태 |
|---|---|---|---|---|
| **(a)** | "finish는 종료신호일 뿐, harness가 단계를 못박지 않는다 / finish-gate 없음" (02 §7-4, 04 §6) | **R1 §4.2** | finish를 거부하고 재작업을 강제하는 **loop-level hard gate 실재**: `_check_iterative_refinement`(`critic_mixin.py:76-138`)가 critic 점수 미달+max_iter 미달 시 `(True, followup)` 반환 → `finalize`(`agent.py:270-282`)가 finish 무효화. **단 `critic: CriticBase\|None = default=None`(`base.py:419`, "EXPERIMENTAL")이라 default-OFF**, 그리고 shipped critic은 reproduce/test 미검사(non-empty patch + FinishAction만, `agent_finished.py:49-65`). `self.critic is None`이면 즉시 `(False,None)` 단락(`critic_mixin.py:91`). | **정정 확정.** 02/04의 "finish-gate 없음"은 over-claim. 정확히는 "**critic finish-gate가 코드에 실재하되 default-OFF, reproduce는 미검사**". |
| **(b)** | "16 tool" / "18 tool" 혼용, default 노출 tool 수 불명 (03 §1 "16개 출처 추정", 03 표 18종) | **R3 §4·§7-7** | 레지스트리 **총 18종 등록**(`register_tool` 실측)이나 **default preset 바인딩 base = 3개**: `Tool(TerminalTool)`, `Tool(FileEditorTool)`, `Tool(TaskTrackerTool)`(`preset/default.py:52-55 확인`) + 옵션(browser if non-CLI, task if sub-agents) + SDK builtins(finish/think). "16"은 preset×browser-fanout(8 액션) 조합 추정치. reproduce 직접 사용 = **Terminal+FileEditor 2개**. | **정정 확정.** "16 tool"은 단일 LLM 호출 schema 함수 수 추정, "18"은 레지스트리 총량, **default base는 3, repro 핵심은 2**. 세 수치가 다른 것을 가리킴. |
| **(c)** | "메인 Agent condenser 기본 None → condenser default OFF" (05 §1.6, R1 §3, R2가 "기본 None" 인용) | **R3 §2** | 절반의 진실. bare `Agent()`는 `condenser: CondenserBase\|None = default=None`(`base.py:402 확인`)라 OFF. **그러나 convenience 팩토리 `get_default_agent`는 condenser를 명시 배선**(`preset/default.py:85-87 확인`: `condenser=get_default_condenser(...)`, `default_condenser` max_size=80/keep_first=4). | **정정 확정.** ON/OFF는 **진입점 의존**: 날 생성자=OFF, 팩토리=ON. "기본 None"만 인용하면 오도. 단 condenser는 어느 쪽이든 history-길이 관리기지 repro 트리거 아님(결론 불변). |
| **(d)** | "terminal `:42` 'Write a script first'는 tool이 reproduce 행동을 강제하는 사례" (03 §2.3) | **R1 §2.2 / R2 §2** | `_LITERAL_ARG_HINT_TEMPLATE`(`definition.py:42-44`)는 `looks_like_python_literal_argument`(`definition.py:55-83`)가 command 첫 1~2바이트가 `[{`/`{"` 등 Python/JSON 리터럴일 때만 발화(`impl.py:549-568`, `is_error=True`). reproduce 의도/단계와 0 상관 — **bash 자리에 dict 넣은 오입력 교정기**. | **정정 확정.** 03의 "reproduce 강제" 라벨은 over-claim. 정확히는 **malformed-argument 교정기**. (03 본문도 "흔한 실패를 tool이 교정"이라 정확히 적었으나 "reproduce 행동 강제" 라벨이 부정확.) |
| **(e)** | "tool 정의가 행동의 무게중심 / tool 중심 100%" (03 §0·§6, 행동 100% tool) | **R2 §0·§3** | 차원 혼동(category error). 행동=**능력+순서권장+시점결정** 3축. 능력=tool schema/executor 100%(유지, side-effect 유일 공급원, 03 §5 옳음). **순서권장**=`PROBLEM_SOLVING_WORKFLOW`(`system_prompt.j2:60-75`)+few-shot에만, tool schema 0줄. **시점결정**=매-step 모델 추론(step loop `agent.py:542-674`에 phase 분기 0, `tools_map.get(name)` `agent.py:1019`은 순수 매핑·게이팅 0). | **정정 확정.** "tool 100%"는 **능력 축에서만 참**. 행동(=시점 포함) 전체로 확대하면 거짓. tool은 능력 공급, 순서는 prompt 약권장, 시점은 모델. |

추가 부수 정정(라운드 간 식별):
- **(f)** task_tracker description "Never mark done when test suites failing"(`task_tracker/definition.py:388-392`)은 R1 §2.3이 식별한 **test-우선 soft-bias**(텍스트, 비강제). 03이 빠뜨린 채널이나 hard gate 아님.
- **(g)** few-shot(Flask ICL)은 native-FC 미주입(`fn_call_converter.py:398` + `native_tool_calling=True` default `llm.py:413`, R1 §1이 자동-flip 부재까지 확인) — 04 §3-2 주장 **유지·강화**, over-claim 아님.

---

## 2. 5바퀴 생존 결론 (5번 공격받고도 코드로 흔들리지 않은 명제)

각 명제는 01~05 + round1~4를 거치며 *반증 시도를 받고도 코드가 뒤집지 못한* 것만. confidence는 코드 직접성(HIGH=file:line 직핀·반증 실패, MED=코드지지+측정/조건 단서).

| # | 생존 명제 | confidence | 핀 + 생존 이력 |
|---|---|---|---|
| **S1** | **reproduce 전용 엔진 부재 (Agentless식 N-sampling/majority-vote/dual-tree repro 생성기 = 0).** | **HIGH** | 04 §4 전수 grep: `fail.?to.?pass`/`reproduction script`/`majority vot`/`n-sampl`/`dual.tree` 전부 0건. R1~R4 어느 라운드도 이 부재를 깨는 코드 미발견(R1은 critic-gate를 찾았으나 그건 *완료성* gate지 repro 엔진 아님). |
| **S2** | **reproduce 시점 hard-gate = 0. critic조차 reproduce를 미검사한다.** | **HIGH** | step loop(`agent.py:542-674`)·run loop(`local_conversation.py:1227-1345`)에 "재현했는가/테스트 먼저 썼는가" 검사 분기 0. R1이 발견한 critic hard-gate(가장 강한 반증)조차 검사 대상은 non-empty patch+FinishAction(`agent_finished.py:49-65`)이지 reproduce 아님. → reproduce *특정* 0% hard-gate는 default·opt-in·전 preset 전부에서 생존. |
| **S3** | **reproduce 행동 = 비강제 워크플로 15줄 + Terminal/FileEditor + 모델 자율로 완전 환원.** | **HIGH** | 15줄 = `<PROBLEM_SOLVING_WORKFLOW>`(`static.py:178-196`/`system_prompt.j2:60-75`, guard 없는 정적 상수, conv당 1회 freeze `agent.py:408-415`); `:64` "create tests before fixing"이 repro 신호 본체이나 MUST 부재+환경 조건부 출구(`:68-69`,`:74`)로 비강제(04 §1-1). tool = Terminal+FileEditor(`preset/default.py:52-55`). R3가 오컴 면도날로 5계층을 잉여로 강등하고도 이 3요소는 "필요 집합"으로 생존. |
| **S4** | **시점(timing)의 결정자 = 모델의 매-step 추론. prompt도 tool도 *입력*일 뿐, 결정자 아님.** | **HIGH** | R2 §3 3자 인과: prompt=권장 입력(`:64` 비강제), tool=능력 메뉴(`tools_map.get` 순수매핑, phase 게이팅 0), 모델=결정자(response_type 분기는 tool_calls/content/empty만 가르지 *어떤 tool*인지로 안 가름 `agent.py:657-674`). R1의 critic-gate도 시점이 아니라 *종료*를 친다. |
| **S5** | **"그냥 프롬프트"도 "복잡 인프라 5계층"도 둘 다 부정확.** | **HIGH** | "그냥 프롬프트"=인프라 존재 부정→틀림(01 §7: 2엔진·guard 9·변수 5소스·OS refine·2블록 캐시). "복잡 5계층이 reproduce를 설명"=red herring→틀림(R3 §1 표 9항목 중 repro 시점 직접기여 0). 정확표현 = "비강제 워크플로 15줄을 모델에 권하고 터미널 줘서 맡기는 것을, 일반 prompt-합성 인프라가 배달한다"(층위 분리). |
| **S6** | **critic finish-gate(완료성 hard-gate)는 코드에 실재하나 default-OFF.** | **MED** | `critic_mixin.py:76-138` + `base.py:419`(default=None, EXPERIMENTAL) 재확인. HIGH가 아닌 이유: 이 명제의 "실재" 부분은 HIGH지만 "production 배포에서 켜지는지"는 SDK 밖이라 미확인(→메타 §4). 우리가 본 건 default-OFF 코드. |
| **S7** | **few-shot(Flask ICL)의 시점 영향은 native-FC 모델에서 0.** | **HIGH** | `fn_call_converter.py:398`(`is_first_user_message and add_in_context_learning_example`) + non-native-FC 전용 경로 + `native_tool_calling=True` default(`llm.py:413`, 자동-flip 부재 R1 §1.2) + `add_iclex` 약-모델 제외(`non_native_fc.py:48`). 켜져도 reproduce 미시연(pip-install 디버그). |
| **S8** | **transfer 가치 ≈ 0 — 이 분석은 우리 plan을 바꾸지 않는다(오히려 harness-강제를 강화).** | **MED** | R4 5축: 자율↔강제 model-confounded(same-model 12.8pp scaffold)·우리 강제-net-positive 직접반례(jun-27-11141 sticky-red가 gpt-5.4 PASS)·repro-test 흡수원으로 빈 우물(엔진 부재)·방향 정반대(우리 repro=oracle vs OpenHands "확인 후 삭제")·actionable 추출 ≈0. MED인 이유: 일부는 우리 측 측정(11141, 12.8pp)에 의존하므로 OpenHands-코드만의 명제는 아님. |

**버려진/약화된 명제** (5바퀴서 못 버팀):
- "finish-gate 없음"(02/04) → S2/S6로 정정(critic-gate 실재, default-OFF).
- "tool이 행동 무게중심 100%"(03) → S3/S4로 능력 축 한정.
- "terminal :42 = reproduce 강제"(03) → (d) 오입력 교정기로 정정.
- "condenser 기본 None"(05) → (c) 진입점 의존으로 정정.

---

## 3. 정확한 한 문장 (코드 기준, 흔들리지 않게)

> **OpenHands는 reproduce·탐색·생성·검증을 위한 전용 엔진이나 시점 hard-gate를 코드에 두지 않고(critic 완료성-gate조차 default-OFF이며 reproduce를 검사하지 않는다), 비강제 워크플로 프롬프트 15줄(`<PROBLEM_SOLVING_WORKFLOW>`)로 "고치기 전 재현 테스트"를 *권하고* Terminal·FileEditor tool로 *능력만* 공급한 뒤, 실제 시점·순서 결정은 전적으로 매-step 모델 추론에 위임한다 — 일반 prompt-합성 인프라(2엔진·condenser·skill·cache-tier)는 이 권고·능력을 *배달·생존*시키는 봉투일 뿐 reproduce를 *발생*시키지 않는다.**

---

## 4. 메타 적대 — 이 종합 결론 자체의 약점

종합 결론을 마지막으로 한 번 더 공격한다. 남은 약점을 정직하게 명시.

### 4-1. ★최대 약점: "SDK ≠ 리더보드 제출 config" 갭 (정직하게 명시)

우리가 분석한 것은 **`openhands-agent-sdk` 오픈소스 트리의 default 코드 경로**다. 우리가 본 적 **없는** 것:

- **실제 SWT-bench/SWE-bench 리더보드 엔트리가 어떤 config로 제출됐는지.** All-Hands(OpenHands 운영사)의 production 배포가 `critic`을 켰는지, 어떤 critic(shipped `AgentFinishedCritic`/`EmptyPatchCritic`이 아니라 외부 API critic `critic/impl/api/critic.py`)을 배선했는지, condenser/preset을 어떻게 골랐는지는 **이 트리에 없다.**
- 따라서 S2("reproduce hard-gate 0")·S6("critic default-OFF")는 **SDK default에 대해 HIGH/MED지만, 실제 제출 구성에 대해서는 미확인**이다. production이 critic을 켜고(default-OFF는 단지 SDK 안전판일 수 있음) 거기에 reproduce-검사 로직을 넣었다면, "OpenHands는 reproduce를 자율로 맡긴다"는 종합 결론은 *제출 config 한정으로 깨질 수 있다*.
- 특히 API critic(`critic/impl/api/critic.py`)은 외부 서버 점수기다 — 그 서버가 무엇을 검사하는지는 코드로 알 수 없다. shipped critic 2종만 보고 "critic은 reproduce 미검사"라 한 것은 **shipped 범위에 대해서만** 참이다.

**판정: 이 갭은 종합 결론을 무너뜨리진 않으나(우리 명제는 "SDK default 경로"로 한정 시 전부 코드-핀됨), "OpenHands(제품)는 reproduce를 자율로 처리한다"로 *일반화*하는 순간 unproven이 된다.** 정직한 scope는 "우리가 읽은 SDK default 경로에 한정". 리더보드 동치성은 별도 검증 필요(제출 config·하네스 래퍼 미입수).

### 4-2. 부차 약점

- **(b) tool-수 추정 잔존**: "16 tool"의 출처는 여전히 *추정*(preset×browser-fanout)이지 코드 직접 카운트 아님(03 §1 "추정"·R3 §4 "보인다"). browser ToolSet 8 액션이 단일 schema에 어떻게 펼쳐지는지 정확 카운트는 미실측. default base=3은 HIGH지만 "노출 총 함수 수"는 MED.
- **S8(transfer) 측정 의존**: "harness-강제가 net-positive"는 OpenHands 코드가 아니라 *우리 측 단발 측정*(jun-27-11141 n=1, 12.8pp same-model)에 기댄다. n=1 인과는 우리 메모리(no-inference-from-insufficient-evidence) 기준 약하다. transfer 결론의 코어("바꾸지 않는다")는 *부재 증명*(흡수원 빈 우물)으로 버티지만, "강제가 더 낫다"는 적극 주장은 측정 미충분.
- **"15줄이 repro를 민다"의 비강제성 vs 실효성 미측정**: `:64`가 MUST 아님은 코드(언어 컨벤션)로 입증됐으나, *비강제 nudge가 강한 모델에게 얼마나 실제로 먹히는지*는 A/B 미실시(R2 §4도 정량 보류). "soft nudge"라는 라벨은 강제성 분석이지 효과 측정이 아니다.

### 4-3. 메타-메타: 이 약점들이 핵심 결론을 흔드나?

흔들지 못한다. S1~S5는 전부 **부재 증명**(grep 0건)과 **default 코드 경로 직핀**으로, config 변경으로 *추가*될 수는 있어도 우리가 읽은 경로에서 *현존하지 않음*은 불변이다. 4-1의 "제출 config 갭"은 결론의 **scope를 좁힐 뿐**(SDK default → not 제품 일반화) 결론 자체를 거짓으로 만들지 않는다. 정확한 종합문은 §3에 "SDK default 경로 기준"을 암묵 전제로 단다.

---

## 5. 우리 plan 영향 최종 확정

**round4 결론 유지 — plan 변경 0줄. 측정 rail부터.** 확정 근거:

1. 이 5바퀴 어딧이 OpenHands에서 추출한 actionable = ≈0(R4 §4: 워크플로/finish/nudge/single-file 전부 우리가 *code-hard* 게이트로 이미 보유하거나, insertion-null로 무의미). 5바퀴를 더 돌아도 새 흡수물이 안 나온다.
2. S1(repro 엔진 부재)·S3(15줄+2tool+자율 환원)은 OpenHands가 우리에게 **줄 새 repro lever가 없음**을 확정 — 흡수원이 빈 우물이라는 R4 §3 결론 강화.
3. 단 §4-1 메타가 추가한 **유일한 후속 ROI**: "리더보드 제출 config 입수→critic/하네스 래퍼가 reproduce-검사를 켜는지 확인"은 *측정* 작업이지 plan 구조 변경 아님. 이것조차 ROI MED(제출 config가 자율이든 강제든 우리는 이미 양쪽 다 보유). 지금 측정 rail(base+gold 2-tree 재실행)보다 우선순위 낮음.
4. harness-강제 철학은 "재검토 대상" 아님 — 우리 측 측정(11141 강제-net-positive, 단 n=1 단서 §4-2)으로 *지지*되고, OpenHands 자율-net-positive는 model-confounded라 미측정. 방향 전환 근거 0.

**결론: plan 변경 0. 다음 레버 = 측정 rail(우리 기존 합의), 자율 전환 아님. OpenHands 분석은 흥미롭지만 적용 불가 — 단 "게이트를 옳게·default-OFF·measure-first로 유지하라"는 우리 기존 원칙의 재확인으로만 유효(게이트가 틀렸을 때 자율이 안전 fallback이라는 에지 경고).**

---

## 6. 10줄 요약

1. **정정 5건 확정**: (a) "finish-gate 없음"(02/04)→critic finish-gate 실재하나 **default-OFF·reproduce 미검사**(`critic_mixin.py:76-138`, `base.py:419`); (b) tool수=레지스트리 18/default base 3/repro 핵심 2 세 수치 분리; (c) condenser=진입점 의존(bare OFF `base.py:402`, `get_default_agent` ON `default.py:85`); (d) terminal `:42`=오입력 교정기지 reproduce 강제 아님; (e) "tool 100%"=능력 축만 참, 시점은 모델.
2. **S1 (HIGH)**: reproduce 전용 엔진 부재 — N-sampling/majority-vote/dual-tree grep 0건(04 §4), 5바퀴 미반증.
3. **S2 (HIGH)**: reproduce 시점 hard-gate 0 — critic조차 non-empty patch+finish만 보지 reproduce 미검사(`agent_finished.py:49-65`).
4. **S3 (HIGH)**: reproduce 행동 = 비강제 워크플로 15줄(`static.py:178-196`, MUST 부재+환경 출구) + Terminal/FileEditor + 모델 자율로 완전 환원(R3 오컴).
5. **S4 (HIGH)**: 시점 결정자 = 매-step 모델 추론; prompt·tool은 입력일 뿐(step loop phase 분기 0, `tools_map.get` 순수매핑).
6. **S5 (HIGH)**: "그냥 프롬프트"(인프라 부정)도 "복잡 5계층"(repro로 전용)도 부정확 — 정확표현은 §3 한 문장.
7. **정확한 한 문장**: OpenHands는 repro 전용 엔진/시점 hard-gate 없이(critic-gate조차 default-OFF·repro 미검사), 워크플로 15줄로 *권하고* 2 tool로 *능력만* 주고 시점은 *모델에 위임*하며, 일반 prompt-합성 인프라는 그걸 *배달*하는 봉투다.
8. **메타 최대 약점**: **SDK ≠ 리더보드 제출 config.** 우리가 본 건 오픈소스 default 경로뿐 — All-Hands production이 critic(특히 외부 API critic `critic/impl/api/critic.py`)을 켜고 reproduce-검사를 넣었는지 미확인. 종합 결론은 "**SDK default 경로 한정**"으로 scope해야 정직(제품 일반화 시 unproven). 단 부재 증명들은 config로 *추가*될 뿐 현 경로에서 *현존 않음*은 불변이라 결론 코어는 견딤.
9. **부차 약점**: "16 tool"은 여전히 추정(browser-fanout 미실측); transfer 결론의 "강제 net-positive"는 우리 측 n=1(11141)에 의존(약함); 비강제 nudge의 실효성 A/B 미측정.
10. **plan 영향 최종**: **변경 0줄.** 측정 rail부터(round4 유지). OpenHands actionable ≈0(우리가 code-hard로 이미 보유), 새 repro lever 부재. 유일 후속 ROI=제출 config 입수해 critic 켜짐 여부 *측정*(MED, 측정 rail보다 후순위). harness-강제는 "재검토 대상" 아니라 우리 측정으로 지지된 선택 — 자율 전환 근거 0.
