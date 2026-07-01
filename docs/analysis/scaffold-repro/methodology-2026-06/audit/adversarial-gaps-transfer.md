# 적대 어딧 — "진짜 없음 = 흡수 후보 ★" 3개의 SWE-bench transfer 반증 (2026-07-01)

> 대상: `methodology-2026-06/README.md` §B의 ①AssertFlip flip trick ②change-coverage ΔC 곱셈게이트 ③행동적 abstain gate.
> 임무: "novel 갭이다"를 확인이 아니라 **깨뜨린다**. 우리 타겟 task = **SWE-bench patch/fix 생성**(f2p=resolved/total, recall형).
> 근거: 논문 직독(`_papers/{assertflip_2507.17542,tdd-bench_2412.02883}.pdf`), 하네스 소스(`.extracted_source/repro-scaffolds/{swt-bench,tdd-bench-verified}/`), 우리 `src/` grep.
> 판정 축: (i) f2p 직접 transfer / (ii) oracle-loop 통해서만 간접 / (iii) test-gen 점수만·우리 patch 무관 / (iv) 우리 채점모델과 충돌.

---

## Ground truth 확정 (반증의 토대)

**AssertFlip은 patch 생성기가 아니라 BRT(Bug Reproducing Test) 생성기다** [verified, paper p.1 abstract + p.2 §2].
- Title: "Reproducing Bugs via Inversion of LLM-Generated Passing Tests". Contribution (1): "a novel **pass-then-invert test generation** technique". 평가는 **SWT-Bench-Verified fail-to-pass 43.6%** (p.1 abstract). SWT-Bench = "evaluate the ability of LLMs to **generate bug-reproducing tests**" (p.2 §2).
- 여기서 "resolved" 정의 [verified p.7 §5.2]: "an instance as **resolved if the generated test fails on the buggy code and passes on the fixed version**." 즉 **생성한 테스트의 품질** 판정이지 fix 성공률이 아니다.

**ablation −19pp는 SWT-Bench-Verified F→P(test-gen) 숫자다** [verified, Table 3 p.8].
- Table 3: AssertFlip 43.6% / Direct-Fail Variant **24.2%** → −19.4pp. 이 열 헤더가 `F→P Rate (%)` = SWT test-gen 지표. README가 인용한 −19%p는 **우리 f2p(SWE-bench resolved)가 아닌 SWT 지표**임을 논문이 명시.

**TDD-Bench Verified도 test-generation 벤치다** [verified, tdd paper p.1].
- Title: "Can LLMs **Generate Tests** for Issues Before They Get Resolved?" / "evaluating **test generation instead of issue resolution**". `tddScore = failToPass(x,y) × adequacy(x,y)`, `genTests(x)→y`(테스트 집합 산출). **cov_score(=adequacy)는 생성된 "테스트"가 변경 라인을 밟는지를 재는 항**이지 fix 채점 항이 아니다 [verified, run_evaluation.py:685-740].

**SRI abstain의 "success"는 precision 재정의다** [verified, AssertFlip 자기 문헌 p.7 §5.2 + lstar.md §1(e)].
- AssertFlip 본인이 abstain을 이렇게 쓴다: "our approach deliberately **abstains** from generating solutions for every instance. We only generate 326 of the 433 cases... our tool avoids producing low-confidence or misleading outputs... aligns with... BouncerBench... 'sometimes no answer is better than a wrong one.' ... our **actual resolution rate is 58% (189 out of 326)**." → 43.6% = 189/433(전체 대비, recall형), 58% = 189/326(제출한 것 대비, **precision형**). abstain은 분모를 줄여 precision을 올리는 장치.

---

## 갭 ① AssertFlip flip trick — 판정 (ii) oracle-loop 통해서만 간접 (README의 "synthesis 수렴 병목 직결" = 과장)

**공격**: flip trick은 "passing test 만들고 assertion만 flip"으로 **BRT(재현 테스트)를 잘 만드는** 기술이다. 우리 최종 산출물은 **fix patch**다. flip이 fix 코드를 합성해주지 않는다.

**반증 시도 vs README 주장**:
- README §B-1: "synthesis 수렴 병목 직결 — '정답 값 합성' 부담 우회". 이건 **repro-test 합성**의 부담을 우회하는 것이지 **fix 합성**의 부담이 아니다. 우리 병목은 MEMORY(jun-29)대로 "맞는 파일 짚고 **edit 수렴 실패**" = fix-synthesis다. flip은 fix edit을 한 줄도 안 써준다.
- 우리 코드에서 flip이 닿을 수 있는 유일 지점 = repro-test 생성 서브스텝(`src/agent/repro-test/generate.ts`, K=5). 여기서 나온 repro test는 **oracle-loop의 입력**(base-RED gate `extract-issue-repro.ts`, acceptance `reproResolvedOnSandbox` `acceptance-selector.ts:47`)으로만 f2p에 영향. 즉 flip이 f2p를 올린다면 그 경로는 **"더 신뢰할 만한 repro oracle → best-of-N selection이 더 나은 fix를 픽"** 뿐. **독립 lever가 아니라 oracle 입력 품질 개선**이다.
- 게다가 우리 oracle은 이미 **PATCHED tree 실행 ground-truth**(exit-code green)를 쓴다. flip의 가치는 "LLM이 fail 테스트를 잘 못 써서 repro가 vacuous/flaky"한 문제를 푸는 것 — 우리는 base-RED gate(`bench-gap-1.ts:69` sticky)로 vacuous를 이미 차단. 따라서 flip의 한계효용은 "우리 repro가 base-RED를 못 넘기는 잔여분"에만 국한. 이 잔여분 크기 = **미측정**.
- AssertFlip 자기 prediction 약점 [verified, otter-assertflip.md §2]: mock 남용 45건(resolve 33%)·하드코딩 기대값 brittle. 이건 answer-key 안티패턴류(MEMORY no-answer-key)라 우리가 취하면 **오히려 selection 오라클을 오염**.

**판정: (ii) oracle-loop 통해서만 간접.** f2p 직접 transfer 아님(iii에 가까움 — SWT F→P 지표를 올리는 기술). "synthesis 수렴 병목 직결"은 **repro-synthesis와 fix-synthesis를 혼동한 과장**. 생존하되 우선순위 강등: repro-oracle 신뢰도가 우리 f2p의 실측 병목임이 먼저 증명돼야(현재 jun-29는 localize가 아니라 fix-edit이 병목이라 시사 → flip의 타겟과 어긋남).

---

## 갭 ② change-coverage ΔC 곱셈게이트 — 판정 (iii)에 가까운 (ii); 채점용 아님 확정, selection 추가변별 **미검증·의심**

**공격**: grading-oracle.md 자신이 "최종 f2p 채점은 official harness 위임 → (a)(b)(d) 갭은 harness가 대행, 우리 갭은 **selection 신호**"라 했다(§3, 요약10). 그럼 change-coverage는 **채점용으론 불필요**하고 **selection용**으로만 후보. 그런데 우리 selection은 이미 `reproResolved`(repro가 patched tree서 green) + `regressionFailureCount`(min-bar)로 admissible을 거른다(`acceptance-rerank.ts` tier1 `repro-pass AND min-regression`). **ΔC가 이 위에 추가 변별력을 주는가?**

**반증 시도**:
1. **TDD cov_score는 "테스트" 품질 항이지 "fix" 품질 항이 아니다** [verified]. `final_score = cov_score × fail_before × pass_after`, `resolved = final_score > 0`(run_evaluation.py:734-740). 여기 cov_score는 **genTests가 낸 테스트**가 gold 변경 라인을 밟는지. 우리 맥락으로 옮기면 이건 "우리 **repro-test**가 gold 변경 라인을 커버하나"를 재는 것 → **repro-test 품질 gate**이지 **fix 후보 selection gate가 아니다**. README §B-2가 "over-narrow/false-green을 수치로 거르는 유일 규율"이라 한 건 **대상 혼동**: TDD의 over-narrow는 "over-narrow한 **테스트**"(변경라인 미커버 테스트)를 거르는 것이지 "over-narrow한 **fix 패치**"가 아니다.
2. **곱셈게이트는 resolved 경계에선 이진 gate다** [verified, run_evaluation.py:685-740]. `resolved = final_score > 0`이므로 cov_score가 0(=테스트가 변경 라인을 **하나도** 안 밟음)일 때만 reject. cov_score의 연속값(0.5 vs 0.9)은 **resolved 판정을 안 바꾼다**(report/ranking용 부분점수일 뿐). SWT는 아예 ΔC를 resolved에서 제외(진단용, grading.py 주석 "resolved 판정에는 미포함"). 즉 "곱셈"의 규율성은 README가 시사하는 만큼 강하지 않다 — **"테스트가 변경라인을 최소 1줄 밟나"의 binary 필터**에 가깝다.
3. **우리 selection에 추가 변별을 주는가 — 반례로 무력화**: 우리 tier1 admissible = `reproPass=true ∧ regression=min`. repro가 patched tree에서 green(=resolved)이려면 그 repro는 **정의상 fix가 바꾼 동작을 실행**한다(안 밟으면 pass/fail이 안 갈림). 즉 우리 repro-resolved 신호는 **이미 "변경 동작을 커버"를 함의**. ΔC(line-exec)가 그 위에 추가로 거르려면 "repro는 green인데 gold 변경 라인은 안 밟는" 후보가 존재해야 하는데 — 이는 repro가 gold와 다른 경로로 green(가짜 green)인 경우. 그건 우리가 이미 **vacuous-guard**(`repro-oracle-calibration.ts:107-153`, base서 resolved면 무효) + **spec-fidelity veto**(`declared-expected-matcher.ts`)로 부분 차단. ΔC가 그 잔여를 얼마나 더 잡는지 = **미측정·불명**.
4. **인프라 비용 반증**: line-exec ΔC를 selection 신호로 쓰려면 **후보마다 coverage 계측 실행**(`coverage run --branch` per candidate)이 필요. 우리 acceptance는 후보당 repro+regression 2회 이미 실행(`withCandidatePatch`×2). coverage는 3번째 실행 + gold 변경라인 파싱(gold를 **읽어야** 함 → answer-key 근접, MEMORY no-answer-key 경계). ΔC를 "gold 변경라인" 없이 쓰면(=우리 fix가 바꾼 라인을 repro가 밟나) 그건 이미 repro-resolved가 함의. **gold 없이는 TDD식 ΔC가 성립 안 함**.

**판정: (iii)에 가까운 (ii).** 채점용 아님(harness 위임)은 grading-oracle.md가 이미 정직하게 인정. selection용 추가변별은 **repro-resolved가 이미 함의하는 "변경동작 커버"와 중복 가능성 높음** + gold-라인 의존(answer-key 경계). "over-narrow fix를 수치로 거르는 유일 규율" = **테스트 over-narrow와 패치 over-narrow의 혼동으로 과대평가**. 생존하되 **"repro-resolved+vacuous+spec-fidelity 위에 ΔC가 실제로 다른 후보를 고르는가"를 A/B로 먼저 증명 못 하면 흡수 정당성 없음**. 우리 진짜 over-narrow 문제(jun-28 false-green)의 root는 "약한 predicate에 over-narrow **패치**가 가짜 green"인데, TDD ΔC는 **테스트**의 over-narrow를 재므로 그 root를 직접 안 친다 — assertion-pin/sticky-red가 더 정확한 대응.

---

## 갭 ③ 행동적 abstain gate — 판정 (iv) 우리 채점모델과 정면 충돌 (사망)

**공격**: SRI/AssertFlip의 abstain은 "no-action(패치 미제출)을 success로 reframe" = **precision 올리기**. 우리 f2p = resolved/total = **recall**. 빈 패치 = resolved 0 = f2p **손해**.

**반증 시도 vs 생존 시도, 그리고 결론**:
1. **abstain의 "success"는 분모 조작 precision이다** [verified, AssertFlip p.7 §5.2 자기 문헌]. 43.6%(189/433, 전체분모) → 58%(189/326, 제출분모). abstain은 107건을 **분모에서 빼서** 비율을 올린다. **SWE-bench 리더보드 분모는 항상 total(고정)** — 빈 패치를 빼주지 않는다. 따라서 abstain이 올리는 지표는 **우리 리더보드가 쓰지 않는 지표**다.
2. **우리 채점은 빈 패치 = fail-closed = unresolved** [verified, our src]:
   - `verdict.ts:138` "Fail-closed: empty patch ⇒ unresolved."
   - `driver.ts:5007` 빈 제출을 `selection_discarded_real_candidate`로 = "**infra/measurement hole, not a model miss**".
   - MEMORY jun-20-leaderboard-throttle-miss-confound: 빈 패치=측정구멍(throttle/429)을 진짜 miss와 뭉뚱그리지 말라. **우리 시스템 전체가 "빈 패치 = 측정실패"로 설계**됐고, abstain은 **의도적으로 빈 패치를 내는 것** → 우리 관측성 레일이 그걸 infra-hole로 오분류하거나, 리더보드에서 그냥 miss로 카운트.
3. **생존 가능한 재해석 = "선별 제출"인가?** SRI 문헌의 진짜 lever(lstar.md §1(e) 재확인): GPT-5-mini 60.5→88.5%는 **SWE-fix task**의 fix-or-abstain 프레이밍이고, "reproduce 강제만으론 −13pp(47.5%)"의 대조는 **모델이 안 고쳐도 되는 걸 억지로 고쳐 회귀를 낸다**는 진단. 즉 이득의 본질 = "**틀린 수정으로 correct code를 깨는 걸 막는다**"(회귀 방지). 이건 abstain-as-empty-submit이 아니라 **회귀 veto**로 우리에게 이미 있다(`regression-oracle.ts:141-147` + `selection-gates.ts:74` hard gate). SRI 수치의 재현 조건인 "**abstain을 success로 세는 채점**"은 SWE-bench 공식 채점에 **없다** → 그 +28pp는 우리 채점에서 재현 불가.
4. **결정적 충돌**: abstain이 f2p를 올리려면 "빈 패치가 아니라 **최선-of-N에서 신뢰 낮으면 덜 위험한 후보 픽**"이어야 하는데, 그건 abstain이 아니라 **best-of-N selection**(우리 acceptance ladder가 이미 함)이다. "정말로 패치를 안 낸다"는 순수 abstain은 SWE-bench recall에서 **항상 순손실**(그 인스턴스 resolved=0 확정). MEMORY jun-27-11141의 반례(sticky-red가 gpt-5.4를 PASS로)는 abstain이 아니라 **sticky-red(회귀차단)** 효과 — abstain 무관.

**판정: (iv) 우리 채점모델과 정면 충돌 → 사망.** "행동적 abstain(패치 미제출)"은 SWE-bench f2p(recall, total 고정분모)에서 **구조적 순손실**이고 우리 fail-closed 채점·jun-20 측정구멍 정책과 정면 충돌. 살아남는 건 abstain이 아니라 그 **precision 효과의 실제 기전 = 회귀 veto**(이미 완비) + **선별 제출 = best-of-N**(이미 있음). README §B-3의 "L*Agent 84%의 진짜 lever" 표현은 이미 lstar.md가 "84%는 SWT test-gen이지 fix가 아니고, +28pp는 SWE-fix의 abstain-precision"이라 정정한 것을 §B가 **다시 fix task lever인 양 승격**시킨 것 = 반복된 오귀속.

---

## 최종 판정표

| 갭 | README §B 주장 | 반증 결과 | 판정 | 생존 여부 |
|---|---|---|---|---|
| ① flip trick | synthesis 수렴 병목 직결, −19%p 실증 | −19pp는 **SWT test-gen** 지표(paper Table3); repro-synthesis 우회지 fix-synthesis 아님; 우리 병목은 fix-edit(jun-29) | **(ii) oracle-loop 통해서만 간접** | 조건부 생존 (repro-oracle 신뢰도가 f2p 병목임 선증명 필요; 우선순위 강등) |
| ② change-coverage ΔC | over-narrow/false-green 거르는 유일 규율 | TDD cov는 **테스트** 품질 항(fix 아님); resolved 경계선 binary; repro-resolved가 "변경동작 커버" 이미 함의; gold-라인 의존(answer-key 경계) | **(iii)에 가까운 (ii)** | 조건부 생존 (repro-resolved+vacuous 위 추가변별 A/B 선증명 필요; "패치 over-narrow" 오해 정정) |
| ③ abstain gate | L*Agent 84% 진짜 lever | abstain=precision 재정의(189/326 vs 189/433); SWE-bench=recall·total고정; 우리=빈패치 fail-closed(verdict.ts:138)·측정구멍(jun-20); 실기전=회귀veto(이미완비) | **(iv) 우리 채점모델과 충돌** | **사망** (재해석하면 이미 보유한 회귀veto/best-of-N) |

**살아남는 진짜 갭 = 0개의 "직접 f2p lever".** ①②는 oracle/repro-selection 품질을 **간접** 개선할 여지만 있고 그나마 (①은 fix-edit이 진짜 병목이면 타겟 어긋남 / ②는 repro-resolved와 중복 가능성)로 **측정 전 흡수 정당성 없음**. ③은 우리 채점모델·측정정책과 충돌해 사망(그 효과는 이미 보유한 회귀-veto).

**교차 패턴(반복 오귀속)**: 세 갭 모두 **test-generation 벤치(SWT/TDD)의 lever를 patch-생성(SWE-bench) lever로 승격**시킨 카테고리 오류. AssertFlip/TDD-Bench/SWT-bench는 전부 "**테스트를 잘 만드는가**"를 재고, 우리는 "**패치로 이슈를 고치는가**"를 잰다. 전자의 지표(F→P test-gen, cov-adequacy, abstain-precision)는 후자(resolved/total recall)로 **자동 transfer되지 않는다**. transfer 경로는 오직 "우리 repro-test/oracle 품질 → best-of-N이 더 나은 fix 픽"의 **간접 한 갈래**뿐이고, 그 갈래조차 우리 병목이 repro품질이 아니라 fix-edit 수렴(jun-29)이면 무효.
