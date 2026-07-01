# L*Agent (LogicStar) 방법론 전개 + quanta 준비도 매핑 — 2026-06

- 대상: **L*Agent (LogicStar)**, SWT-bench Verified unit-test mode **#1, 84%** (test-gen). 같은 스택이 SWE-bench Verified fix에서 **76.8% acc / 80% precision** 기록.
- 원본 근거:
  - LogicStar blog SWT post: `https://logicstar.ai/blog/logicstar-on-test-generation-benchmark-swt` (2025-09-10) — "combining multiple agents and models, iteratively refining both code and tests" / "advanced code search capabilities, iterative feedback driven by code execution with coverage metrics" / "static analysis tools developed by LogicStar for building codebase understanding".
  - LogicStar blog SWE post: `https://logicstar.ai/blog/swe-bench-verified-september-16` (2025-09-16) — "a strong model (GPT-5), generating baseline patches and tests, with diverse cheaper agents based on GPT-5-mini, to increase diversity before picking the best patch using our state-of-the-art tests"; "80% precision … ready to merge 8 out of 10 times"; Investigation/reproduction/fix/review/testing "hand in hand".
  - **reproduce-before-fix gate 원출처는 LogicStar blog가 아니라 SRI Lab** `https://www.sri.inf.ethz.ch/blog/fixedcode` ("Coding Agents Are 'Fixing' Correct Code"). 정확 수치는 §1(e).
  - 실물 predictions: `.extracted_source/repro-scaffolds/_predictions/lstar_agent_verified.json` (500 entries, `{instance_id, model_name_or_path:"logic_star_ai", model_patch}`).
- 선행 리뷰: `docs/analysis/scaffold-repro/predictions-review/lstar.md`(예측 딥리뷰), `docs/analysis/scaffold-repro/audit/round2-insertion-rescue.md`(within-system embedded report 회수, resolved=397/500).
- 증거태그: `[verified]`=blog/predictions/src 직접 확인, `[inferred]`=근거로부터 추론.

> ⚠️ 정정 1 — L*Agent 소스는 **비공개**다. blog는 방법론을 문장 단위로만 노출, 알고리즘/프롬프트 미공개. §1의 (a)~(f)는 **blog 발췌 + 실물 predictions 패턴 + SRI 자매 논문**의 삼각측량이지 소스 재현이 아니다.
> ⚠️ 정정 2 — 프롬프트에 준 "reproduce-before-fix gate 60.5→88.5% (fix task)"는 **SWT(test-gen) 84%의 lever가 아니다**. 그건 SRI의 SWE-**fix** 실험(GPT-5-mini)이며, L*Agent SWE-fix 76.8%의 배경 철학이다. SWT 84%의 lever는 §3에서 별도 판정.

---

## 1. L*Agent 방법론 전부 펼치기 (근거 발췌 + 출처)

### (a) Multi-agent orchestration — 여러 test/code agent + 여러 model
[verified] SWE post 발췌: "a strong model (**GPT-5**), generating baseline patches and tests, with **diverse cheaper agents based on GPT-5-mini**". SWT post: "**Multiple agents and models**, iteratively refining both code and tests". Sub-agent 역할 = "**Investigation, reproduction, fix generation, review, and testing** work hand in hand"(SWE post). → 역할-특화 sub-agent 파이프라인(단일 monolith 아님) + 2-tier model(strong baseline + cheap diversity).

### (b) Test + fix co-evolve (동시 정제)
[verified] SWT post 발췌: "iteratively refining **both code and tests**". 즉 SWT(test-gen)에서도 fix 후보를 같이 굴려 test를 다듬는다(테스트만 독립 생성 아님). fix가 있어야 "post-fix에서 pass"라는 fail-to-pass oracle을 검증할 수 있으므로 co-evolve는 구조적 필연. predictions 증거: assertion이 **post-fix 정답 동작**을 정확 단언(단순 no-crash 아님) — `django-16819` `assertOptimizesTo([...], [])`, `xarray-3151` `expected.identical(actual)`(predictions-review §4). fix 없이는 이 기대값을 알 수 없다 → 내부적으로 fix를 산출/참조했다는 [inferred] 강한 흔적.

### (c) Execution + coverage feedback (단순 pass/fail 아닌 coverage 신호)
[verified] SWT post 발췌: "iterative feedback driven by **code execution with coverage metrics**". 이게 pass/fail 이진이 아니라 **커버리지(패치가 실제로 어떤 라인/브랜치를 밟는가)**를 refinement 신호로 쓴다는 유일한 명시. predictions 정합: multi-test case-matrix가 수정 코드의 **가드 조건을 한 줄씩 핀**(`django-16819` positive 1 + negative 5, 각 분기 커버)(predictions-review §3) → coverage-driven test 확장의 산출물로 해석 [inferred]. SWT-bench 자체가 coverage delta를 보조 지표로 리포트하므로 신호원 존재 [verified].

### (d) Best-of-N — 강한 baseline agent + 싼 diverse agent들, 생성한 강한 test로 최종 선택
[verified] SWE post 발췌: "to increase diversity before **picking the best patch using our state-of-the-art tests**". → 후보 풀(GPT-5 baseline 1 + GPT-5-mini diverse N)을 **자기가 생성한 강한 test로 채점해 best-of-N 선택**. test가 selector 역할(외부 gold 아님). SWT 84% quality의 실물 상관: assertion이 정답 핀 + 비결정 축 느슨화(set-subset·`assertLessEqual`·DB-feature skip)로 **flaky-pass를 줄여** selector로서 신뢰 가능(predictions-review §4).

### (e) Reproduce-before-fix gate — 60.5 → 88.5% (SWE-**fix** task)
[verified] **출처 = SRI Lab** `.../blog/fixedcode`(LogicStar 자매). 발췌: "First, investigate whether the issue still exists, then **reproduce it, and only fix it if the reproduction succeeds**" + **명시적 abstain 옵션**. 수치: **GPT-5-mini 60.5% → 88.5%**(fix-or-abstain 프레이밍). 대조: Sonnet 4.6 65.0%→80.5%; Sorcar(GPT-5.3-Codex) 83.5%. **핵심 반례**: abstain 옵션 없이 "reproduce before patching"만 시키면 **역효과** — Sonnet 65.5%(불변), GPT-5-mini **47.5%로 하락**. 근본 진단: "Most models **eagerly modify code even when there is nothing to fix**". → lever의 본질은 "재현" 자체가 아니라 **재현 실패 시 abstain(무행동)을 성공으로 재정의**하는 것. L*Agent 80% precision(ready-to-merge 8/10)이 이 abstain 철학의 산물 [inferred].

### (f) 자체 static analysis
[verified] 양 post 공통: "**static analysis tools developed by LogicStar** for building codebase understanding" / "static-analysis-powered codebase understanding enhances performance across both stronger and weaker models". + "advanced **code search** capabilities". 구현 미공개(proprietary). → localization/context-building을 LLM 프리텍스트가 아니라 정적 심볼 그래프로 grounding [verified-claim, mechanism-inferred].

### 실물 predictions 패턴 발췌 (500, `_predictions/lstar_agent_verified.json`)
[verified] insert 262 / new-file 159 / modify 79; resolved(embedded report) **397/500=79.4%**(round2-insertion-rescue.md). within-system insert 81.7% vs new-file 79.2%, **Fisher p=1.0** → **삽입/신파일 스타일은 인과 lever 아님**. new-file조차 97%가 올바른 test dir + repo fixture(`SphinxTestApp`/`Pytester`/`_basic_auth_str`) import(predictions-review §2). → 84%의 실 lever는 스타일이 아니라 **repo 테스트-인프라 외과적 통합 + 비결정 회피 단언**(predictions-review §5).

---

## 2. 우리(quanta) 준비도 매핑

| 방법론 | 근거 + 출처 | 우리 코드 위치 | 상태 |
|---|---|---|---|
| (a) Multi-agent orchestration (strong+cheap diverse) | SWE post "strong model (GPT-5) … diverse cheaper agents (GPT-5-mini) … increase diversity" | model-lane(model diversity): `src/config/knob-schema/schemas/bench-gap-3.ts:315` `QUANTA_BENCH_LOCATION_FANOUT`; sub-agent 역할분리 부재(단일 loop) | **부분 있음/미측정** — fanout=후보 다양화 O, role-specialized sub-agent(investigate/reproduce/fix/review 분리) ✗ |
| (b) Test+fix co-evolve | SWT post "iteratively refining both code **and tests**" | repair loop: `src/runner/knobs/knobs/closure-repair.ts`; repair 프리셋 `src/runner/knobs/presets.ts:208` `agentless-v6-oracle`; grounding `src/agent/repro-test/grounding.ts` | **있음(부분)/미측정** — repair rerun O, 그러나 test↔fix **동시** 정제 seam 아님(우리는 fix repair loop, test는 단일-pass repro-gen) |
| (c) Coverage-as-signal (pass/fail 초과) | SWT post "code execution with **coverage metrics**" | coverage_check tool(ADR-0165): `src/host/runtime/agent-arg-builder/gated-tool-ports.ts:253-255` `QUANTA_COVERAGE_TOOL`; sidecar coverage rate: `src/runner/batch/eval/closure-diagnostics-io.ts:174-176` `gold_coverage_rate`/`multi_file_full_coverage_rate` | **있음(default-OFF)/미측정** — 툴·diag 존재하나 **refinement 루프의 신호로 미배선**(coverage delta→test 확장 피드백 없음). diag는 사후 관측용 |
| (d) Best-of-N by own tests | SWE post "picking the best patch **using our state-of-the-art tests**" | acceptance/best-of-N: `src/runner/batch/eval/acceptance-select.ts`, `makeAcceptanceSelectCandidates` `src/runner/batch/eval/driver.ts:3432`; LLM soft-rerank `src/runner/batch/eval/acceptance-llm-rerank-wire.ts` `QUANTA_BENCH_LLM_SELECT`; repro-vote `src/runner/knobs/knobs/repro-vote.ts` | **있음(default-OFF)/미측정** — score-once+patch-vote+3tier ladder 랜딩. 단 "**자기 생성 test로** 채점" 정합(reproVote=우리 repro가 selector), 효능 A/B 미완 |
| (e) Reproduce-before-fix **+ abstain** gate | SRI `fixedcode`: 60.5→88.5%; abstain 없으면 47.5%로 역효과 | sticky-red: `src/config/knob-schema/schemas/bench-gap-1.ts:69` `QUANTA_BENCH_MUST_PASS=sticky`(reproduce 강제, base-RED gate); base-RED seed: `src/agent/verification-plan/extract-issue-repro.ts`(repro가 base서 fail해야 authority); submit-review verdict `src/runner/batch/eval/driver.ts:3517` `QUANTA_BENCH_SUBMIT_REVIEW`; repro-doubt `src/runner/knobs/knobs/repro-doubt.ts` | **있음(reproduce)/없음(abstain)/미측정** — reproduce-before-trust는 우리 sticky-red·base-RED gate가 커버. **그러나 abstain-as-success(무행동을 성공으로 재정의)는 부재** — 우리는 항상 패치 emit 지향 |
| (f) 자체 static analysis | 양 post "static analysis tools … codebase understanding" | semantica codegraph(별repo): `quanta-index-core/.../domains/semantic/inbound.rs:6` `semantic_query`; symbol-dep nav `src/host/runtime/internal/mention-symbol-deps.ts`; LSP readonly nav(server-gated, CLI-default-ON) | **있음(부분)/미측정** — semantica MCP backend 존재(full-corpus precision unmeasured), bench localization에 **미배선**(grounding은 skeleton-strip 프롬프트, 정적 그래프 grounding 아님) |

세부 근거:
- **(c) coverage_check**: `gated-tool-ports.ts:255` `...(gateOn(process.env, "QUANTA_COVERAGE_TOOL") ? { coverageCheck: true } : {})` — 툴 자체는 있으나 default-OFF이고 tool-menu 노출뿐. L*Agent식 "coverage를 test refinement 신호로 되먹임"하는 루프는 없다.
- **(e) sticky-red = reproduce, ≠ abstain**: `bench-gap-1.ts:66-69` `"sticky" ⇒ {mustPass:true, maxTrips:2, stickyRed:true}` — 재현 test가 red를 유지하도록 강제(false-green 차단). 이건 SRI gate의 "reproduce" 절반이다. SRI가 강조한 **다른 절반(재현 실패 시 abstain을 정답으로)**은 우리에 없다 — grep `abstain`은 전부 declared-expected-**matcher** 문맥(패치 판정 유보)이지, **에이전트가 패치를 안 내는** 행동적 abstain이 아니다.
- **(f) semantica 미배선**: 메모리 `semantica-codegraph-engine`대로 별 repo backend는 있으나 full-corpus precision unmeasured + bench grounding seam(`src/agent/repro-test/grounding.ts`)은 여전히 `stripTestBodies` skeleton 주입(정적 def-use 그래프 아님).

---

## 3. 핵심 판정

**Q1. L*Agent 84%(SWT)의 핵심 lever는?**
스타일(insert/new-file) 아님 — within-system Fisher **p=1.0**로 반증(round2-insertion-rescue). blog+predictions 삼각측량 결과 실 lever는 **(d) best-of-N by own strong tests + (b) test/fix co-evolve + (c) coverage-driven 확장**의 번들이고, 그걸 가능케 하는 토대가 **(a) strong+cheap-diverse multi-agent**와 **(f) static-analysis grounding**이다. predictions-review는 이걸 "더 똑똑한 test 로직이 아니라 **repo 테스트 스위트 외과적 통합 + 비결정 회피 단언**"으로 정제 — 즉 84%는 **selection quality(강한 self-test로 diverse 후보 중 best 픽) × integration precision**의 곱. 단일 lever가 아니라 **diversity→execution/coverage 채점→best-of-N 파이프라인**이 lever.

**Q2. reproduce-before-fix gate(+28pp)가 우리 sticky-red와 같은가?**
**절반만 같다.** (1) 이 +28pp는 **SWE-fix task**(SRI GPT-5-mini)이지 SWT 84%의 lever가 아님 — 프롬프트 전제 정정. (2) SRI가 실험으로 분리한 결정적 사실: **"reproduce" 강제만으론 오히려 -13pp(47.5%)**, 이득의 전부가 **"재현 실패 시 abstain을 성공으로 재정의"**에서 온다. 우리 sticky-red(`bench-gap-1.ts:69`)·base-RED gate(`extract-issue-repro.ts`)는 **reproduce 절반만** 구현 — 재현/false-green 차단은 하지만 **행동적 abstain(패치 미제출을 정답으로)은 없다**. 따라서 sticky-red ≠ SRI gate. SRI 데이터대로면 우리처럼 reproduce만 있고 abstain 없는 구성은 **모델에 따라 순손실**일 수 있어, sticky-red 단독 효능은 **재측정 대상**(우리 메모리 `jun-27-11141`은 sticky-red가 gpt-5.4를 PASS로 돌린 n=1 증거 — 상충, 측정 필요).

**Q3. coverage-as-refinement-signal을 우리가 가졌나?**
**아니오(부품만).** coverage_check 툴(`gated-tool-ports.ts:255`)과 사후 coverage diag(`closure-diagnostics-io.ts:174`)는 있으나, L*Agent식 **"coverage delta를 읽어 test를 확장/정제하는 되먹임 루프"는 미배선**. 우리 신호는 여전히 이진 pass/fail(oracle) 중심. 이게 (c)에서 우리가 명확히 뒤진 갭이며, best-of-N selector 품질(d)과 직결.

---

## 10줄 요약
1. L*Agent(LogicStar)는 소스 비공개 — 방법론은 blog 발췌 + 실물 500-predictions + SRI 자매 논문 삼각측량으로만 복원 가능.
2. 파이프라인 = **strong GPT-5 baseline + cheap GPT-5-mini diverse agents**(role: investigate/reproduce/fix/review/test), **code+test 동시 정제**, **execution+coverage 피드백**, **자기 생성 강한 test로 best-of-N 선택**, **자체 static analysis grounding**.
3. SWT 84%의 실 lever = **best-of-N by own strong tests(d) × integration precision** — insert/new-file 스타일은 within-system Fisher p=1.0로 반증(비-lever).
4. 프롬프트가 준 "reproduce-before-fix 60.5→88.5%"는 **SWT lever 아님** — SRI의 SWE-**fix** 실험 수치, L*Agent fix 76.8%/80% precision의 배경.
5. SRI 결정적 발견: **reproduce 강제만으론 -13pp(GPT-5-mini 47.5%)**, 이득 전부는 **재현 실패 시 abstain(무행동)을 성공으로 재정의**에서 옴.
6. 우리 매핑 — (a) fanout 다양화 O·role sub-agent ✗; (b) repair loop O·test/fix 동시정제 seam ✗; (c) coverage 툴/diag O·refinement 되먹임 ✗; (d) acceptance best-of-N+reproVote O(default-OFF, 미측정); (e) sticky-red=reproduce 절반 O·abstain ✗; (f) semantica backend O·bench grounding 미배선.
7. **핵심 갭 1**: coverage-as-refinement-signal 부재 — 우리는 이진 pass/fail, L*는 coverage delta로 test 확장(c).
8. **핵심 갭 2**: 행동적 abstain 부재 — 우리 abstain은 전부 패치-판정 matcher 문맥(`declared-expected-matcher.ts`)이지 "패치를 안 낸다"는 에이전트 결정이 아님. sticky-red ≠ SRI gate.
9. **가장 준비된 축 = (d) best-of-N**: `acceptance-select.ts`/`makeAcceptanceSelectCandidates`(`driver.ts:3432`)/reproVote/`QUANTA_BENCH_LLM_SELECT` 전부 랜딩·"자기 test로 채점" 정합, 남은 건 효능 A/B(미측정).
10. 다음 ROI 순위: ① coverage→test-refinement 되먹임 배선(c), ② best-of-N 효능 실측(d), ③ 행동적 abstain(재현 실패=미제출) 실험(e); grounding(f)은 semantica precision 선측정 후.
