# Round-3 최종 종합 — "SWT-bench repro 점수를 실제로 무엇이 움직이나, 우리가 당길 레버는 무엇인가"

> 작성일 2026-07-01. 3-라운드 적대 어딧의 **Round-3 FINAL SYNTHESIS (객관/균형 시선)**.
> 입력: `round1-{causation-data,insertion-counterexamples,newfile-defense,variable-tagging}.md`,
> `round2-{insertion-rescue,localization-lever,assertion-lever,actionable-roi}.md`, `readme.md`, `predictions-review/*`.
> **벤치 = SWT-bench Verified** (issue-reproduction *test-generation*). resolved = harness fail-to-pass(신규 F→P>0, base 대비 ⊇) + 회귀무변동.
> 임무: Round-1의 헤드라인("existing-file insertion + fixture reuse가 repro 최강 단일 레버")을 3라운드에 걸쳐 적대·객관 양시선으로 검증한 뒤, **calibrated 단일 결론** 산출.

---

## 1. 무엇이 DIED — falsified, with the killing number

세 후보가 "레버"에서 **null로 강등**됐다. 각각 falsified + 죽인 숫자.

### (D1) insertion-as-lever — **FALSIFIED.** 죽인 숫자: **within-system Fisher p=1.0, OR=1.014**
- Round-2 insertion-rescue가 L\*Agent **단일 model+scaffold** 안에서 직접 측정(=교란 제거): insert 214/262=**81.7%** vs new-file 126/159=**79.2%**, existing(insert+modify) vs new = 79.5% vs 79.2%, **Fisher exact two-sided p=1.0, OR=1.014.** within-repo 통제 후에도 9/9 repo 전부 **p≥0.158**, delta 부호조차 양쪽으로 뒤집힘(astropy +19 vs sphinx −26 = 둘 다 small-n 노이즈).
- 보강: Round-1 D1 — UNRESOLVED 169건 중 **160건(94.7%)이 pure-insert**(insert는 fail을 못 막는다). 진짜 인과 insert-win은 전 데이터셋 **2/500=0.4%**(django-16950 shared test-infra 파일 편집만 강함, 12143은 n=1).
- 정정: Round-1이 "within-system 측정 자체가 불가능"(line 130)이라 한 건 **틀렸다** — L\*Agent embedded `report.json`으로 가능했고, 측정하니 null이었다. Round-1은 over-corrected가 아니라 오히려 **강화**됐다.

### (D2) multi-test-as-lever — **FALSIFIED.** 죽인 숫자: **resolved/unresolved 평균 test-fn 둘 다 1.47 (identical)**
- Round-1 insertion-counterexamples D3: insert RESOLVED와 UNRESOLVED의 평균 test-fn **둘 다 1.47로 동일**(resolved single-fn 135/249, unresolved 87/160).
- 보강: newfile-defense §3 — single-test resolved **300/303·184/188(~98%)**. variable-tagging — multi가 단독 변별한 instance **2/29(7%)**. "필요한 건 *여러* 개가 아니라 *맞는* 1개." (비용 ~0이라 켜도 무해하나 점수 lever로는 NULL.)

### (D3) assertion-STRENGTH-as-lever — **FALSIFIED.** 죽인 숫자: **within-system-within-repo Fisher p=0.08, non-monotonic 53%**
- Round-2 assertion-lever: STRONG(exact/struct) vs WEAK를 model AND repo 동시 고정하면 17 cell 중 **p<0.05는 단 1개**(lstar×sphinx, 우연 가능 n=44), within-cell 풀링 STRONG 68.8% vs WEAK 62.1% **p=0.0805(비유의)**.
- 결정타: 같은 instance에서 "WEAK-assert resolved & STRONG-assert failed" = 36건, 반대 = 32건 → **36/68 = 53% non-monotonic.** 약한 단언이 강한 단언을 그 반대만큼 자주 이긴다 → strength는 정답과 직교. cross-system 상관(substr 56% < exact 69%)은 **Simpson 역설**(약한 모델이 substring을 많이 뱉어 생긴 위장). 실측 반례: sklearn-10297(presence-only AF가 resolved, structural-but-wrong eOtter/RA fail), sphinx-8551, django-16082/16145.

---

## 2. 무엇이 SURVIVED — separable & addressable (calibrated confidence)

### (S1) localization-targets-gold — **SURVIVED. confidence HIGH.**
- Round-2 localization-lever: 생성 테스트가 gold-changed symbol/module을 import·참조하면(targets-gold) resolved **+20.2pp pooled(69.1% vs 49.0%)**, χ²=42.3, **p≪0.001, OR=2.33**, 세 시스템 모두 +18~+29pp 동방향.
- **causal 근거(repo 위장 반증):** within-repo 통제 후 **+15.1pp 생존**(7/10 repo 양수), 최대 repo django 단독 **+23pp**, sphinx는 confound를 보태나 동력 아님. directory-placement는 cosmetic(+8~15pp), **import/symbol targeting이 load-bearing**(+18~29pp).
- **calibration:** proxy("gold symbol 언급")는 "올바른 trigger 경로 도달"을 과대포함 → 보수적 하한(진짜 효과는 더 클 수도). 따라서 effect 방향·존재는 HIGH, 절대 크기(+15pp)는 MED.

### (S2) assertion-CORRECTNESS / vacuous-guard — **SURVIVED (좁게). confidence MED.**
- Round-2 assertion-lever Task3: unresolved 중 fixable(다른 시스템이 같은 instance를 풀어 올바른 oracle이 존재) = 366/538(68%). 그 366의 **87%(320)는 이미 STRONG-but-wrong**(값/방향/localization 오류), weak-oracle 10%(35), vacuous 3%(11).
- → **"단언 강화" 프롬프트로 회수 가능한 headroom ≈ 13%**(vacuous 11 + weak-when-strong-available 35 = 46/366). 나머지 87%는 model이 "고친 뒤 무엇이 맞는가"를 알아야 고쳐짐 = **부분적으로 model-bound**.
- **calibration:** addressable한 부분(vacuous-guard: skipTest 가드·`assertX() or assertY()` or-chain·빈 본문·mock-target 금지)은 순수 출력 위생 규칙이라 확실하지만 빈도 ~3%. correctness-headroom 13%는 **상한**(일부는 사실 localization 문제). 그래서 MED, 단독 lever 아닌 (H)의 출력 게이트로서.

### (S3) surrogate-oracle execution-review loop — **SURVIVED. confidence MED(우리 갭 정렬은 HIGH, 효능은 미측정).**
- 우리 메모리 진단(`jun-29-gap-essence-synthesis-convergence-bottleneck`, `jun-28-closure-repair-false-green-root`)과 정렬: 천장 본질 = **단일-pass가 fail-to-pass 오라클 루프가 없어 틀린 edit에 false-green 정지.** 경쟁사(L\*Agent 84%·TEX-T 87%)의 우위는 multi-attempt + oracle-feedback(otter §4 inferred).
- **왜 유일 직접 lever:** insertion/multi-test는 repro *스타일*, localization/bootstrap은 repro *입력 품질* — 전부 "테스트를 잘 짜는" 축. 우리 진짜 병목은 "**fix를 잘 고르는**" 축이고, 그건 틀린 fix를 reject하는 실행-피드백 루프로만 닫힌다. (S1)이 그 루프의 입력 게이트(틀린 코드경로 오라클이면 selection 오염), (S2)가 출력 게이트(weak-oracle이면 false-green).
- **calibration:** 갭과의 정렬은 HIGH(우리 천장 병목 그 자체). 그러나 **실효능은 미측정** + 적대검증(roi Task4)이 밝힌 위험(아래) 때문에 종합 MED.

---

## 3. 지배 UNCHANGEABLE 드라이버 — addressable lever를 압도

점수 분산의 1·2차 인자는 **우리가 못 바꾸는 것**이다:

- **(1) repo 난이도 = 1차.** 어느 시스템이든 sphinx ~18-30% vs scikit ~67-92%(Round-1 §2.3). repo 내부 시스템간 격차 < repo 간 격차. repo는 주어진다.
- **(2) model + scaffold = 2차.** **같은 gpt-5-mini, 같은 new-file 스타일인데 ReProAgent 70.3% vs OpenHands 57.5% = 12.8pp**(Round-1 §2.4). 이 단일 숫자가 "integration-style 효과"라 주장될 어떤 cross-system 격차보다 크다. model은 OpenAI key 고정.
- **함의:** (1)+(2)가 우리가 측정한 모든 addressable lever를 **dwarf**한다. localization +15pp(within-repo)·correctness-guard ~13%-headroom은 의미 있으나, model+scaffold 한 축이 만드는 12.8pp와 repo가 만드는 ~40-70pp 스윙 옆에서는 **modest**다. 따라서 현실적 addressable headroom은 **작다** — "레버를 당기면 천장이 크게 오른다"가 아니라 "지배 드라이버가 허용하는 한도 안에서 modest gain"으로 calibrate해야 한다.

---

## 4. Confidence table (lever × causal × addressable × cost × confidence)

| lever | causal? | addressable by us? | eng cost | confidence | 한 줄 |
|---|---|---|---|---|---|
| **insertion (existing-file)** | **N** (p=1.0) | n/a | output-format(高) | **HIGH-null** | within-system null. 출력모드 갈아엎기=sunk. |
| **multi-test emission** | **N** (1.47=1.47) | y (prompt 1줄) | prompt-only(低) | **HIGH-null** | 공짜라 켜도 무해하나 lever 아님. |
| **assertion STRENGTH** | **N** (p=0.08, 53% non-mono) | partial | prompt-only | **HIGH-null** | "강하게 단언"=brittle/over-specify 역효과. |
| **localization-targets-gold** | **Y** (within-repo +15pp) | **Y** (change-cov gate + sig-grounding) | selection+retrieval(中) | **HIGH(존재)/MED(크기)** | import/symbol targeting이 load-bearing. (H)의 입력게이트. |
| **assertion CORRECTNESS / vacuous-guard** | **partial** | **partial** (가드만 순수, 방향은 model-bound) | prompt-only(低) | **MED** | ~13% headroom 상한, vacuous-guard ~3%가 확실분. (H)의 출력게이트. |
| **surrogate-oracle exec-review loop** | **Y(우리갭 정렬)** | **Y** (acceptance seam 보유) | harness(中, seam 보유) | **MED** (정렬 HIGH·효능 미측정) | 유일 직접 lever, 단 단독배선시 false-green 악화. |
| **richer-retrieval new-file / bootstrap recipes** | **Y** (bootstrap-class fail만) | **Y** (prompt few-shot~retrieval) | prompt(低)~infra(高) | **MED-LOW** | 우리 ~85% loc이면 분자 불확실, 분모 최소라 cheap rider. |
| **AssertFlip-style flip** | partial(repro품질) | y | prompt(2-step) | **LOW** | repro 품질 lever지 fix-수렴 misaligned. |
| **repo 난이도** | **Y(지배)** | **N** | — | **HIGH** | 1차 드라이버, unchangeable. |
| **model + scaffold** | **Y(지배)** | **N**(key 고정) | — | **HIGH** | 12.8pp(same-model same-style). unchangeable. |

---

## 5. 정정된 헤드라인 (the corrected headline)

> **(원래, 틀림)** "existing-file insertion + fixture reuse가 SWT-bench repro 점수의 가장 강한 단일 레버다."
>
> **(어딧된 진실)** insertion은 점수의 **인과 판별축이 아니다** — 한 model·한 scaffold 안에서 insert vs new-file의 resolved율은 통계적으로 구별 불가(Fisher p=1.0, OR=1.014)이고, 실패의 94.7%가 insert이며, repo를 통제해도 어떤 단일 repo에서도 유의(p≥0.158)하지 않다. insertion은 "최강 레버"가 아니라 **coverage 바닥을 높이는 값싼 깔개**이며, 인과적으로 작동하는 건 shared test-infra 파일을 편집해야 하는 ~0.4% 케이스뿐이다. 함께 lever로 지목됐던 multi-test(resolved/unresolved test-fn 1.47=1.47)와 assertion-strength(within-system-within-repo p=0.08, non-monotonic 53%)도 동일하게 null로 강등된다. **점수 분산을 지배하는 건 우리가 못 바꾸는 repo 난이도(1차)와 model+scaffold(2차, same-model same-style만으로 12.8pp)**이며, 우리가 실제로 당길 수 있는 separable lever는 (a) **생성 테스트가 gold 코드경로를 실제로 import·실행하는 localization-targeting**(within-repo causal +15pp), (b) **vacuous-oracle을 정적으로 거부하는 위생 가드**(~3% 확실분, correctness-headroom 상한 ~13%), 그리고 (c) 이 둘을 입력·출력 게이트로 삼는 **surrogate-oracle execution-review 루프**(우리 synthesis-convergence 갭에 정렬된 유일한 직접 lever)뿐이다. 단, 이 세 lever의 현실적 합산 headroom은 지배 드라이버에 비해 **modest**다.

---

## 6. Decision — A/B 번들 + 측정 레일 prerequisite

### 6.1 번들 (2×2, +rider, 전부 default-OFF byte-identical)

적대검증(roi Task4)이 밝힌 핵심: **(H) 단독 배선은 죽는다** — 오라클이 우리 model 능력의 산물이라, 틀린 코드경로를 보면 틀린 fix를 green으로 통과시켜 false-green을 **악화**(우리가 이미 데인 `closure-repair-false-green-root` 재발). 따라서 입력·출력 게이트와 **반드시 묶는다**:

- **arm (H) surrogate-oracle exec-review loop** ON/OFF — `QUANTA_BENCH_ACCEPTANCE` + exit-code repro 오라클 배선. acceptance seam 보유라 신규 비용 최소.
- **arm (C) loc-gate (change-coverage gate)** ON/OFF — targets-gold 테스트만 오라클로 채택, non-targeting reject. R2 +15pp의 메커니즘 근거 = (H)의 **입력 게이트**(틀린 코드경로 오라클 차단).
- **rider (vacuous-guard)** — skipTest 가드·`assertX() or assertY()` or-chain·빈 본문·mock-target 정적 거부 = (H)의 **출력 게이트**(false-green 차단). prompt-only 직교 knob.
- **2×2 = (H ON/OFF) × (C ON/OFF), vacuous-guard rider 직교.** repair-breadth(보유)와 함께 — 적대검증 반론3(selection≠generation)의 방어: 오라클이 false-green 정지를 막아 *재합성 라운드를 트리거*하므로 selection이 generation을 유발.

### 6.2 측정 레일 prerequisite (싸게 A/B 할 채점기)

- **docker-free swt-bench `grading.py`** (이미 로컬 보유: `.extracted_source/repro-scaffolds/swt-bench/src/grading.py`). `get_resolution_success`(line 205)는 **순수 함수** — 입력은 파싱된 test-log(FAIL_TO_PASS/PASS_TO_PASS 세트)뿐, **docker 불필요·coverage optional**(R2가 L\*Agent embedded report를 재채점 없이 읽은 것도 이 덕분).
- **부품:** (1) 박스에서 후보 test patch 실행해 stdout 캡처 → swt-bench `get_logs_eval` 포맷 정규화 **adapter 1개**, (2) gold f2p 세트 = SWE-bench_Verified FAIL_TO_PASS/PASS_TO_PASS(dataset 보유), report_base = base commit 1회 실행(캐시).
- **운영:** serial 채점만(메모리: 동시채점=false-neg). 모집단 = synthesis-class fail 28 + competitor-gap top20 슬라이스. **n=1 귀속 금지, failToPassFailed 분포로 판정.** A/D(insertion/multi-test)에 측정 예산 쓰지 말 것(분자 0).

---

## 7. 재현 메모 (데이터·경로)
- per-instance resolved 라벨: `_predictions/{eotter_plus,assertflip}_verified.evaluation.json`(`resolved_ids`/`unresolved_ids`, disjoint·sum=total), ReProAgent `reproagent/outputs_gpt_5_mini/ReProAgent.repro_agent_gpt_5_mini_verified.json`(303/128), L\*Agent embedded `lstar_agent_verified.zip → logic_star_ai/<id>/report.json`의 `resolved`(500/500, 재채점 불필요).
- gold 코드패치: SWE-bench_Verified arrow `patch` 필드 → 비-test `+++ b/` 파일 + symbol(`/tmp/gold_code.json`, 500 instance).
- 분류기: `is_new = ('new file mode' in patch) or ('--- /dev/null' in patch)`; pure-insert = `not is_new and deleted==0 and added>0`.
- grading: `swt-bench/src/grading.py:get_resolution_success`(line 205, docker-free·coverage-optional·pure-python).
- 분석 스크립트: `/tmp/loc_analysis.py`·`/tmp/classify2.py`·`/tmp/contingency.py`·`/tmp/nonmono.py`·`/tmp/headroom2.py`.
</content>
</invoke>
