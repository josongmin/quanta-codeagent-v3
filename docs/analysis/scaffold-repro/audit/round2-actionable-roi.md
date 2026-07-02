# Round-2 종합 어딧: actionable ROI — "흥미로운 발견"과 "우리가 실제로 당길 수 있는 lever"의 분리

> 작성일 2026-07-01. synthesis-of-actionability 에이전트 (transient API error 후 Round-2 재실행).
> 입력: `audit/round1-{causation-data,insertion-counterexamples,newfile-defense,variable-tagging}.md`, `audit/round2-{insertion-rescue,localization-lever}.md`, `predictions-review/{lstar,otter-assertflip,reproagent,tex-t}.md`.
> **THE decision-input 문서.** 임무: 점수 driver 중 model/repo 하위(downstream)에 있는 lever를 적대적으로 솎아내고, 우리 synthesis-convergence 갭에 대한 ROI = (addressable causal effect) / (engineering cost)로 순위 매김.
> 우리 컨텍스트: 단일-pass-ish repro-gen이 skeleton-only self-contained NEW 파일을 emit; 우리 localization은 ~85% 파일적중(코드-fix); 진짜 갭은 synthesis 수렴(맞는 파일·틀린 edit, 24/28); acceptance/best-of-N seam + execution-review surrogate-oracle 방향 보유.
> **벤치 = SWT-bench Verified** (테스트 재현). resolved = harness의 fail-to-pass + 회귀무변동 라벨.

---

## 0. 두 단계 필터 (downstream-of-model/repo는 lever 아님)

Round-1+2가 확정한 점수 분산의 지배 인자 순서: **(1) repo 난이도 → (2) model+scaffold → (3) oracle 강도·fixture-state·localization.** (1)(2)는 우리가 못 바꾼다(repo는 주어짐, model은 OpenAI key 고정). 따라서 **actionable lever는 정의상 (3) 안에서만, 그리고 "우리 프롬프트/출력/선택으로 만질 수 있는 것"만**이다. 아래 모든 후보를 이 잣대로 1차 통과시킨 뒤 ROI를 매긴다.

핵심 적대 원칙(이 문서의 베이스라인): **어떤 lever든 "model을 바꾸면 같이 따라오는 능력"이면 downstream이라 기각**한다. 예—assertion 품질 자체는 model 능력의 함수다(L*Agent의 robust-assert는 강한 model의 산물). 우리가 만질 수 있는 건 *프롬프트로 그 능력을 끌어내는 가드/규칙*뿐이고, 그건 약-headroom일 수 있다.

---

## TASK 1 — 후보 lever별 분류 (causal&addressable / confounded / low-headroom)

분류 코드: **[CA]** causal & addressable by our prompt/output · **[CF]** confounded/unchangeable (downstream of model/repo) · **[LH]** addressable but low-headroom for US given 85% loc + synthesis-convergence gap. 각 판정에 Round-1/2 정량 근거.

### (A) existing-file insertion — **[CF] NULL. 기각.**
- **근거:** R2 insertion-rescue가 within-system(L*Agent 단일 model+scaffold)에서 직접 측정: insert 81.7% vs new-file 79.2%, existing vs new **Fisher p=1.0, OR=1.014**. within-repo 9/9 repo 전부 p≥0.158, delta 부호조차 뒤집힘(astropy +19 vs sphinx −26 둘 다 노이즈). R1 D1: UNRESOLVED 169 중 160(94.7%)이 insert — insert는 fail을 못 막음. 진짜 인과 insert-win은 전 데이터셋 2/500=0.4%(django-16950, shared test-infra 파일 편집).
- **판정:** 점수의 인과 판별축 아님. 우리가 new-file→insert로 출력 모드를 바꿔도 측정 가능한 점수 이득 ≈ 0. **명시적으로 NULL.** (단, ~0.4% shared-fixture-file 편집 케이스는 micro-conditional이라 별도 white-list 가치만 있고 일반 lever 아님.)

### (B) assertion-correctness prompting — **[LH] addressable-but-low-headroom. 조건부.**
- **근거(양면):** R1 variable-tagging은 29개 표본에서 better-assertion이 52%(15/29)로 *최대 변별자*라 했고, R1 insertion-counterexamples D2는 insert 고정 후 weak-assert가 fail쪽에 ~1.5x(18.8% vs 12.4%). **그러나** R1 §3의 sklearn-10297 반례—presence-only(약) AF가 resolve, exact(강) eOtter가 unresolve—는 "강도≠정답, 단조 아님"을 보임. 핵심은 **강도가 아니라 *방향/정답값 정확성***(R1 oracle-정확성 §4: sympy-11618에서 시스템마다 oracle 방향이 정반대).
- **왜 LH (downstream 위험):** "정답 동작을 정확히 단언"하는 능력은 *model이 정답 동작을 아는가*의 함수 = downstream. 우리가 프롬프트로 만질 수 있는 건 (b1) **비결정성 회피 가드**(set-subset·불변식·assertLessEqual·DB-feature skip; L*Agent §4 레시피) — 이건 flaky-pass를 줄이는 순수 출력규칙이라 addressable, 그러나 우리 갭(틀린 edit)을 직접 안 닫음. (b2) **weak-oracle 정적 거부**(substring-only·`X or Y`-vacuous·skip-vacuous·mock-target 금지; R1 §1 태그·ReProAgent §6·AF mock resolve 33%) — 이것도 *우리가 이미 가진 가드 표면*. headroom은 "우리 출력이 이 안티패턴을 얼마나 내는가"에 비례하는데, 우리는 skeleton-only라 안티패턴 표면이 작을 수 있다(미측정).
- **판정:** addressable이나 우리 synthesis-convergence(틀린 edit) 갭의 *직접* lever는 아님. **surrogate-oracle 루프의 출력 게이트로서만 의미** — (H)의 부품.

### (C) localization targeting gold module/symbol in the generated test — **[CA] causal & addressable, 단 (H)의 입력 게이트.**
- **근거:** R2 localization-lever가 정량 확증: targets-gold vs misses-gold resolved **+20.2pp pooled(69.1% vs 49.0%)**, χ²=42.3 p≪0.001, OR=2.33; 세 시스템 모두 +18~+29pp 동방향. **within-repo 통제 후 +15.1pp 생존**(7/10 repo 양수), sphinx 위장 아님(django 단독 +23pp). directory-placement는 cosmetic(+8~+15pp), **import/symbol targeting이 load-bearing**(+18~+29pp).
- **왜 CA지만 단독 1순위 아님:** R2 §4가 명시—이건 우리 ~85% 코드-fix localization과 **다른 좌표**(test-gen이 gold 코드경로를 *실행*하는가). 우리 change-coverage gate + extractSignatures grounding에 직결되어 addressable. 단 R2 §3-2 proxy 한계: "gold symbol 언급 ≠ 올바른 trigger 경로 도달"(astropy-13033 AF가 symbol 참조하되 인위호출로 unresolve). 즉 targeting은 **surrogate-oracle이 틀린 코드경로를 보면 fix 선택이 오염**되므로 (H)의 *입력 품질 게이트*로서 인과적.
- **판정:** causal & addressable이되 standalone 아님. **(H)를 켤 때 비로소 +15~20pp를 실현하는 전제 게이트.**

### (D) multi-test emission — **[CF] NULL. 기각.**
- **근거:** R1 D3: insert RESOLVED·UNRESOLVED 평균 test-fn **둘 다 1.47로 동일**. newfile-defense §3: single-test resolved 300/303·184/188(~98%). variable-tagging: 단독 변별 instance 2/29(7%). "필요한 건 *여러* 개가 아니라 *맞는* 1개." ReProAgent가 single-강제(prompt:127)인데 70%—multi 부재가 14%p의 *일부*라 주장되나, 이는 model+scaffold 교락이지 multi 자체 효과 아님(L*Agent multi는 강한 model의 robustness 부산물).
- **판정:** insert 내부에서 판별축 아님(p-급 차이 없음). 비용 거의 0이라 "공짜면 켜"는 가능하나 **점수 lever로는 NULL**. 명시적으로 NULL 마킹.

### (E) AssertFlip-style flip (passing test → assertion 뒤집기) — **[LH→CA-경계] 흥미롭지만 우리 갭과 misaligned.**
- **근거:** otter-assertflip §2가 메커니즘 확정(README "Inversion of LLM-Generated Passing Tests", bug-aware 주석 54%). 매력: "현 동작 캡처는 LLM이 잘함 → 정답값만 뒤집기"가 "단번에 fail-to-pass 짜기"보다 쉬울 수 있음. **그러나** AssertFlip은 전 시스템 중 **최저점(45.5%)**, mock 남용 resolve 33%, 하드코딩 brittle. flip의 "정답값으로 뒤집기" 단계 자체가 *정답 동작을 알아야 함* = (B)와 같은 downstream 문제로 회귀.
- **판정:** 우리 *repro-gen* 입장에선 흥미로운 2-스텝이나, 우리 진짜 갭은 repro-gen이 아니라 **코드-fix synthesis 수렴**. flip은 repro 품질 lever지 fix-수렴 lever 아님. **measure-first knob 후보지만 ROI 후순위**(misaligned with our gap).

### (F) richer retrieval still-new-file (test-app model/conftest skeleton/schema_editor 레시피 주입) — **[CA] causal & addressable, 중-headroom.**
- **근거:** newfile-defense §4 종합—insertion 우위 65건은 fixture-결합 강한 repo에 집중, 해법은 "insert"가 아니라 "관련 test-app model/conftest skeleton/schema_editor 레시피를 검색해 격리 파일이 self-bootstrap에 쓰게 주입"(EVIDENCE 1-2 (c)(d)(e)가 gpt-5-mini도 받으면 재현 입증). ReProAgent §6 [흡수]: runtime resolve(`apps.get_model`), dynamic `type()`+schema_editor+uuid teardown은 "검증된 레시피". lstar §6: extractSignatures를 class/fixture 시그니처까지 확장(본문 strip 유지 = no-leak).
- **왜 CA & 중-headroom:** 이건 *우리 출력의 bootstrap-correctness*를 올리는 retrieval-infra lever — model 능력 downstream이 아니라 *우리가 컨텍스트에 무엇을 주입하나*. 단 우리 갭은 "synthesis 수렴(틀린 edit)"이지 "bootstrap collection-error"가 아닐 수 있다(우리 ~85% loc이면 bootstrap은 덜 깨질 것). headroom은 우리 실패의 몇 %가 *bootstrap/fixture under-supply*인지에 비례(미측정).
- **판정:** causal & addressable. **우리 흡수 백로그(signature-grounding 확장)와 직결, 측정 가치 높음.** 단 우리 갭이 정말 bootstrap이냐는 측정 선결.

### (G) bootstrap recipes (apps.get_model / schema_editor / isolate_apps) — **[CA] (F)의 구체 부품. 가장 값싼 CA.**
- **근거:** (F)와 동일 근거의 *구현 단위*. ReProAgent §1 (a)~(d), TEX-T §1 P1~P4(settings.configure/`__main__` app_label, 공개 API, temp-project subprocess, write-test+pytest subprocess). 전부 **프롬프트 system-rule + 소수 few-shot exemplar**로 주입 가능 = 거의 prompt-only.
- **판정:** (F)의 핵심 부품 중 가장 cheap. **(F)와 묶어 한 knob으로 A/B.**

### (H) surrogate-oracle execution-review loop (the cross-cutting one) — **[CA] causal & addressable. 우리 갭에 *직접* 정렬된 유일 lever.**
- **근거:** 우리 메모리 일관 진단(`jun-29-gap-essence`, `jun-28-closure-repair-false-green-root`): 천장 본질 = **단일-pass가 fail-to-pass 오라클 루프가 없어 틀린 edit에 수렴**. 경쟁사(L*Agent 84%·TEX-T 87%)의 우위는 multi-attempt + oracle-feedback(otter §4 [inferred] "단일 후보라 다회 attempt 오라클 루프가 약함"). TEX-T §6-A: self-contained exit-code repro(P1~P4 + exit 2/0 플립)는 우리 repair-rail의 *값 기반* 그라운딩 오라클로 직수입 가능(이전 약한 `test_exit_zero` false-green 자리를 강화). 우리는 acceptance seam + execution-review 방향을 *이미* 보유 → 배선만 남음.
- **왜 우리 갭과 정렬:** (A)(D)는 repro *스타일*, (C)(F)(G)는 repro *입력 품질* — 전부 "repro 테스트를 잘 짜는" 축. **우리 진짜 병목은 "fix를 잘 고르는" 축**이고, 그건 *틀린 fix를 reject하는 실행-피드백 루프*로만 닫힌다. (H)가 그 루프다. (C)는 그 루프의 입력 게이트(틀린 코드경로 오라클이면 fix 선택 오염), (B)는 그 루프의 출력 게이트(weak-oracle이면 false-green).
- **판정:** **유일하게 synthesis-convergence 갭에 *직접* causal. ROI #1 후보.**

---

## TASK 2 — engineering cost 매핑 (우리 파이프라인 기준)

| lever | 분류 | cost 계층 | 구체 |
|---|---|---|---|
| (A) insertion | [CF] NULL | output-format | new-file→insert 출력 모드(anchor-locate+import-merge). **하지만 효과 0이라 sunk.** |
| (B) assertion-correctness | [LH] | prompt-only (+selection) | 비결정성-회피 system-rule + weak-oracle 정적 거부 가드. 가드 표면 일부 보유. |
| (C) loc-targeting | [CA] | selection + retrieval-infra | change-coverage gate(타겟라인 커버 테스트 선호/reject) + extractSignatures 확장. (H)와 배선 공유. |
| (D) multi-test | [CF] NULL | prompt-only | "함수 여러 개 emit" system-rule. cheap이나 효과 0. |
| (E) AssertFlip | [LH] | prompt-only (2-step) | characterization-PASS → 정답값 flip 2-스텝 단계. knob 1개. |
| (F) richer-retrieval new-file | [CA] | retrieval-infra | test-app model/conftest skeleton/schema_editor 레시피 retrieval+주입. signature-grounding 확장. |
| (G) bootstrap recipes | [CA] | **prompt-only** | system-rule + few-shot exemplar(apps.get_model/schema_editor/isolate_apps/settings.configure). 가장 cheap. |
| (H) surrogate-oracle loop | [CA] | **harness** (seam 보유) | acceptance/best-of-N seam에 exit-code repro 오라클 배선 + repair-rail 피드백. 우리가 *이미* 방향 보유 → 배선·게이트 작업. |

cost 오름차순: (D)≈(G) < (B)≈(E) < (C)≈(F) < (H). 단 (H)는 seam을 이미 보유해 *순수 신규 비용*은 보이는 것보다 작다.

---

## TASK 3 — ROI 순위 = addressable-causal-effect / cost (우리 synthesis-convergence 갭 기준)

**핵심 통찰:** repro-스타일 lever(A/D=NULL, E=misaligned)는 분자(우리 갭에 대한 effect)가 ~0이라 ROI도 ~0. 우리 갭에 분자가 큰 건 **(H) 실행-피드백 루프**뿐이고, (C)(G)는 (H)의 effect를 *실현시키는 전제/증폭기*다. 따라서 단독 ROI가 아니라 **(H)를 중심으로 한 묶음 ROI**로 본다.

| 순위 | lever | 분자(우리 갭 effect) | 분모(cost) | ROI | 비고 |
|---|---|---|---|---|---|
| **#1** | **(H) surrogate-oracle exec-review loop** | **높음** — 갭에 유일 직접 정렬, 경쟁사 우위의 본질 | 중(harness, **seam 보유**) | **최고** | 우리 천장 병목 그 자체. |
| **#2** | **(C) loc-targeting (change-coverage gate)** | 중-높음 — within-repo +15pp, 단 (H)의 입력 게이트 | 중(selection+retrieval) | **높음** | (H) 없이는 +15pp 미실현. (H)와 배선 공유 → 묶음. |
| **#3** | **(G) bootstrap recipes** | 중 — bootstrap-class 실패만, 우리 ~85% loc이면 작을 수도 | **낮음(prompt-only)** | **높음(cheap)** | 분자 불확실하나 분모 최소라 ROI 방어적. (F)의 cheap 코어. |
| 4 | (B) assertion-guard | 낮-중 — (H)의 출력 게이트, 단독 효과 약 | 낮(prompt-only) | 중 | (H) 켤 때 false-green 방지로만 의미. |
| 5 | (F) richer-retrieval full | 중 — (G)의 풀버전, retrieval-infra 비용↑ | 높(infra) | 중 | (G) 측정 후 확장 여부 결정. |
| ⊘ | (A) insertion / (D) multi-test | **0 (NULL)** | — | **0** | 절대 1순위 금지. high-interest low-headroom **트랩**. |
| ⊘ | (E) AssertFlip | misaligned | 낮 | 낮 | repro 품질 lever, fix-수렴 아님. measure-first 후순위. |

### 트랩 명시 (high-interest, low-headroom)
1. **(A) insertion** — Round-1 정성 인상("eOtter coverage 0.857, in-place 통합력")이 매혹적이나 within-system p=1.0. **출력 모드 갈아엎기는 sunk cost.** 가장 비싼 함정.
2. **(D) multi-test** — "L*Agent 84%는 multi, 우리 single이니 거기 갭이!"가 직관적이나 R1 D3 test-fn 1.47 동일·single resolved 98%. **prompt 한 줄이라 켜도 무해하나, lever로 착각해 측정 예산 쓰면 손해.**
3. **(B/E) assertion/flip을 "정답값 정확도"로 미는 것** — "정답 동작을 더 정확히 단언" = model이 정답을 아는가 = downstream. 우리가 만질 수 있는 건 가드(비결정성 회피·weak-oracle 거부)뿐이고 그건 *틀린 edit 수렴*을 안 닫는다.

### 권고: A/B 먼저 할 top-2 (+ #3 cheap rider)
- **A/B #1 — (H) surrogate-oracle exec-review 루프 ON/OFF** (`QUANTA_BENCH_ACCEPTANCE` + exit-code repro 오라클 배선, default-OFF). 우리 갭에 유일 직접 정렬. acceptance seam 보유라 신규 비용 최소.
- **A/B #2 — (C) change-coverage gate를 (H) 입력에 배선** (targets-gold 테스트만 오라클로 채택/non-targeting reject). R2 +15pp의 메커니즘적 근거. (H)와 retrieval/selection 배선 공유 → **(H)와 한 sprint로 묶어 2×2(loop ON/OFF × gate ON/OFF) A/B**가 효율적.
- **Cheap rider — (G) bootstrap-recipe few-shot** (prompt-only, exit-code/settings.configure/apps.get_model/schema_editor exemplar). 분모 최소라 (H) 측정에 끼워 같이 측정(직교 knob).

---

## TASK 4 — 적대적 검증 (#1 = (H) surrogate-oracle loop이 *안* 움직일 최강 논변)

**최강 반대론:** "(H)는 우리 천장을 못 올린다. 이유 셋—
1. **오라클 자체가 우리 model 능력의 산물.** exit-code repro가 '정답 동작'을 인코딩하려면 *우리 model이 정답을 알아야* 한다(TEX-T §6-B W1 monkey-patch strawman·W2 soft-oracle처럼 게임됨). model이 정답을 모르면 오라클이 틀린 코드경로를 보고 *틀린 fix를 green으로 통과*시켜 false-green을 **악화**시킨다 — 우리가 이미 데인 `closure-repair-false-green-root`의 재발.
2. **루프는 후보 다양성이 없으면 공회전.** best-of-N의 N이 전부 같은 틀린 edit이면 오라클이 다 reject해도 고를 게 없다. 경쟁사 우위는 *오라클*이 아니라 *multi-attempt diversity*(cross-vendor)일 수 있는데 우리는 single-vendor key.
3. **우리 갭의 24/28이 synthesis-class라면, 그건 '맞는 파일·틀린 edit'이고 오라클은 edit을 *고를* 뿐 *합성*하진 않는다.** 오라클은 selection lever지 generation lever가 아니므로, 합성 자체가 천장이면 무용."

**판정 — 부분 survives, 단 조건부.**
- 반론 1(false-green 악화)은 **실재 위험이나 (C)+(B) 게이트가 정확히 그 방어**다: (C) targets-gold 입력 게이트가 "틀린 코드경로 오라클"을 reject(R2 +15pp), (B) weak-oracle 정적 거부가 vacuous-green을 차단(R1 §1 태그). 즉 (H)는 **(C)(B) 없이 단독 배선하면 위험**, 묶으면 방어됨 → A/B를 2×2로 묶으라는 TASK 3 권고와 정합. **이 반론이 (C)를 #2로 끌어올리는 이유 자체.**
- 반론 2(diversity 부재)는 **부분 타당**: 우리 single-vendor면 N의 diversity가 약하다. 그러나 (H)는 location-fanout/effort-ladder(이미 보유)와 직교 — 같은 model에서도 fanout이 후보 다양성을 만들고, 오라클이 그중 *맞는* 1개를 고른다. diversity가 0이 아니면 selection lever가 작동. **완전 무력화는 아님.**
- 반론 3(selection≠generation)이 **가장 날카롭다.** 오라클이 합성을 안 한다는 건 맞다. **그러나** 우리 갭이 "단일-pass라 *오라클 없이* 첫 edit에 정지(false-green)"라면(`closure-repair-false-green-root`가 정확히 이것), 오라클의 가치는 "false-green 정지를 막아 *재합성 라운드를 트리거*"하는 데 있다 — selection이 generation을 *유발*한다. 즉 오라클은 fanout/repair-breadth의 *게이트*로서 generation을 간접 구동. **반론 3은 (H) 단독이 아니라 (H)+repair-breadth 묶음이어야 함을 시사**(우리는 repair-breadth 보유).

**최종:** #1 = (H)는 **survives, 단 "(H) 단독 배선"은 false-green 악화로 죽을 수 있다.** 반드시 **(C) 입력 게이트 + (B) 출력 게이트 + repair-breadth 재합성**과 *묶어서* 배선해야 살아남는다. 이는 TASK 3의 "2×2 묶음 A/B" 권고를 적대검증이 오히려 강화한 결과다. **단독 #1로 던지면 트랩, 묶음 #1로 던지면 최고 ROI.**

---

## TASK 5 — 측정 prerequisite (싸게 A/B 할 rail)

**우리는 이미 swt-bench `grading.py`를 로컬에 보유**(`.extracted_source/repro-scaffolds/swt-bench/src/grading.py`). 핵심 사실(코드 확인):
- `get_resolution_success`(line 205)는 **`report_pred` f2p ⊇ `report_base` f2p & 신규 f2p>0 & 회귀 무변동**으로 resolved 판정 — **순수 함수, 입력은 파싱된 test-log(FAIL_TO_PASS/PASS_TO_PASS 세트)뿐.**
- `get_logs_eval`은 test stdout을 파싱(PASSED/FAILED 라인), **coverage는 optional**(line 74-75 "does not work when not computing coverage" — coverage 없이도 resolved 판정 성립).
- **docker 불필요**: resolution 경로는 로그+gold 세트만. R2가 L*Agent embedded `report.json`을 재채점 없이 읽은 것도 이 덕분(`grading.py:get_resolution_success`의 직렬화 출력).

→ **측정 rail = 우리 bench 하네스가 후보 test patch를 박스에서 실행해 stdout만 캡처 → 로컬 `grading.py`(pure-python, no-docker)로 resolved 라벨 산출.** 이게 (H)(C)(G) A/B의 *cheap* 채점기다.

**구체 prerequisite:**
1. **per-instance test stdout 캡처** — 우리 repro-test execute 경로(`src/agent/repro-test/execute.ts`)가 이미 pytest 실행. 그 stdout을 swt-bench `get_logs_eval` 포맷으로 정규화해 `grading.py`에 먹이는 **adapter 1개**(repro-adapter 옆). docker/coverage 불요라 박스 부담 최소.
2. **gold f2p 세트** — SWE-bench_Verified의 FAIL_TO_PASS/PASS_TO_PASS(이미 dataset에 있음, R2가 arrow에서 추출). report_base는 base commit 1회 실행으로 산출(per-instance 1회, 캐시).
3. **2×2 knob 매트릭스** — (H) loop ON/OFF × (C) change-coverage gate ON/OFF, (G) bootstrap-recipe는 직교 rider. 전부 default-OFF byte-identical(우리 불변식). serial 채점(메모리: 동시채점=false-neg).
4. **A/B 모집단** — synthesis-class fail 28건(`jun-29-gap-essence`의 taxonomy) + competitor-gap top20을 1차 슬라이스. n=1 귀속 금지(메모리), 다회 failToPassFailed 분포로 판정.

**왜 이 rail이 결정적:** SWT-bench 채점이 docker-free·coverage-free·pure-python이라, **우리 박스에서 stdout만 뽑으면 EC2 grading 인프라(ssh/docker) 없이 로컬에서 즉시 resolved 라벨**을 얻는다. (H)/(C)/(G)의 effect를 *우리 갭 슬라이스에서* 싸게 직접 측정 가능 — TDD-bench 신규 도입 불요, 이미 가진 `grading.py`로 충분.

---

## 10줄 요약 (decision-input)

1. **ROI 순위(우리 synthesis-convergence 갭 기준):** #1 (H) surrogate-oracle exec-review 루프 → #2 (C) loc-targeting change-coverage gate → #3 (G) bootstrap recipes(cheap rider). 나머지는 NULL/misaligned.
2. **(A) insertion = NULL** — within-system Fisher p=1.0, OR=1.014. 출력 모드 갈아엎기는 sunk-cost 트랩.
3. **(D) multi-test = NULL** — resolved/unresolved test-fn 1.47 동일, single resolved 98%. prompt 한 줄이라 무해하나 lever 착각 금지.
4. **(B) assertion·(E) flip = LH/misaligned** — "정답값 정확도"는 model downstream. 우리가 만질 건 가드(비결정성 회피·weak-oracle 거부)뿐, 틀린-edit 수렴 안 닫음.
5. **(C) localization-targeting = CA but (H)의 입력 게이트** — within-repo +15pp(R2), 단 (H) 없이는 미실현. directory는 cosmetic, import/symbol targeting이 load-bearing.
6. **유일 직접 lever = (H)** — 우리 갭(오라클 루프 부재→틀린 edit false-green 정지)에 정렬된 유일 축. acceptance seam·exit-code repro·repair-breadth 보유 → 배선만.
7. **적대검증 결과: #1=(H)는 *단독 배선 시 false-green 악화로 죽는다*.** (C)입력게이트+(B)출력게이트+repair-breadth와 **묶어야 survives** — 적대검증이 (C)를 #2로 끌어올림.
8. **A/B 권고 = 2×2 묶음** — (H) loop ON/OFF × (C) gate ON/OFF, (G) bootstrap을 직교 rider로. 전부 default-OFF byte-identical, serial 채점.
9. **측정 prerequisite = 이미 보유한 swt-bench `grading.py`** — `get_resolution_success`는 docker-free·coverage-optional·pure-python(로그+gold 세트만). 박스 stdout→`get_logs_eval` 정규화 adapter 1개면 로컬 resolved 라벨. TDD-bench 신규 불요.
10. **모집단 = synthesis-class fail 28 + competitor-gap top20** 슬라이스, n=1 귀속 금지, failToPassFailed 분포로 판정. 트랩: (A)(D)에 측정 예산 쓰지 말 것(분자 0).
