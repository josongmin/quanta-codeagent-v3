# Round-2 적대 어딧: assertion/oracle 품질이 진짜 분리 가능한 레버인가 — STRENGTH는 model confound, CORRECTNESS만 약한 lever

> 작성일 2026-07-01. Round-1 가설("assertion/oracle 품질이 진짜 분리 가능한 레버 — weak-substring/vacuous-or/skip-vacuous가 fail을 만든다")을 **확증 금지·적대적으로 스트레스**한다.
> 직전 단계(`round2-insertion-rescue.md`)가 insertion을 within-system p=1.0으로 null 판정 → assertion/oracle이 남은 유일 후보. 이번 임무: 이것도 model-strength confound인지 깬다.
> 벤치마크 = SWT-bench Verified. resolved = harness fail-to-pass + 회귀무변동.
> 4개 시스템 per-instance resolved 라벨 확보: **L*Agent(`/tmp/lstar_logs/.../report.json`, 500), e-Otter++(432), AssertFlip(326), ReProAgent(431)**. 분류기: 각 패치의 `+`행 assert를 라인별 분류 후 strongest 1개 채택. 등급 = exact-value(6) > structural-equality(5) > exit-code(4) > substring-message(3) > presence-only(2) > vacuous(1) > none(0). STRONG={exact,structural}, WEAK={나머지}. 모든 숫자·스니펫 실측.

---

## 헤드라인 (10줄 — within-system-within-repo assertion effect 먼저)

1. **`[verified]` within-system-within-repo assertion-strength 효과 = 거의 null.** STRONG(exact/struct) vs WEAK(substr/presence/vacuous)로 갈라 model(system) AND repo를 동시 고정하면, 충분표본(각 버킷 ≥3) 17개 cell 중 **Fisher p<0.05는 단 1개**(lstar×sphinx, p=0.037)뿐. 부호도 양쪽 뒤집힘(reproagent×sphinx +23pp vs assertflip×scikit −36pp). within-cell 풀링 STRONG 68.8% vs WEAK 62.1%, **p=0.0805 (비유의).**
2. **`[verified]` STRENGTH는 system이 confound한다.** within-**system** 단독에서도 4개 중 reproagent만 STRONG−WEAK=+25pp(p=0.004), 나머지 셋은 비유의(lstar +4.9 p=0.47, eotter −0.5 p=1.0, assertflip −10 p=0.22). 그리고 reproagent의 그 효과는 repo 고정 시 소멸(위 1번). 즉 raw strength의 cross-system 상관(substring 56% vs exact 69%, p=0.007)은 **Simpson 역설** — 약한 두 모델(eotter/assertflip)이 substring을 가장 많이 뱉어 substring=저점수로 위장됐을 뿐.
3. **`[verified]` 결정타 — STRENGTH와 정답은 비단조(non-monotonic).** 같은 인스턴스에서 "WEAK-assert 시스템이 resolved AND STRONG-assert 시스템이 failed" = **36건**, 그 반대(STRONG-resolved & WEAK-failed) = 32건. **비율 36/68 = 53%.** 약한 단언이 강한 단언을 이기는 일이 그 반대만큼 자주 일어난다 → 분리 레버는 strength가 아니다.
4. **`[verified]` 비단조 대표례 3종(실측 스니펫):** sklearn-10297(AF `hasattr` presence-only RESOLVED vs eotter `assert_equal(shape,(n_samples,n_alphas))` strong-but-WRONG FAIL — gold는 `(n_samples,n_classes,n_alphas)`), sphinx-8551(AF substring `not in` 1줄 RESOLVED vs eotter 6개 exact-xref-count FAIL — 내부구조 과명세), django-16082(lstar `assertIsInstance(output_field, combined)` presence RESOLVED vs eotter `assertAlmostEqual(...,Decimal("0.5"))` 하드코딩값 FAIL).
5. **`[verified]` 진짜 actionable 축 = STRENGTH 아니라 CORRECTNESS/DIRECTION.** unresolved 중 "다른 시스템이 같은 인스턴스 풀었다(=올바른 oracle이 존재했다)" = fixable로 보면 366/538 = **68% fixable**. 그러나 그 366의 **87%(320)는 이미 STRONG assert를 썼다(=strong-but-wrong, 방향/값/localization 오류)**, weak-oracle 10%(35), vacuous/empty 3%(11)에 불과.
6. **`[verified]` 그래서 "약한 단언 강화" 프롬프팅으로 회수 가능한 headroom = ~13%뿐.** 11 vacuous + 35 weak-when-strong-available = 46/366. 나머지 87%는 강한 단언을 *틀린 방향/값*으로 쓴 것이라, "더 강하게 단언해라"로는 안 고쳐진다 — 고치려면 "고친 뒤 무엇이 맞는가"(모델 추론)를 바꿔야 함.
7. **`[verified]` UNFIXABLE 바닥(아무도 못 푼 인스턴스) = 14% (72/500 distinct).** 이 바닥 행의 **85%(146/172)가 STRONG assert를 쓰고도 fail** → 벽은 assertion 품질이 아니라 localization/fixture/모델 추론. 단언을 더 강하게/약하게 한다고 안 뚫림.
8. **`[verified]` 명백 vacuous(skipTest/or-chain/빈본문)는 실재하나 희소.** 분류기로 잡힌 vacuous = 전 4시스템 통틀어 3건(lstar 2, reproagent 1). Round-1이 django-11138 등으로 든 vacuous는 **그 시스템 한 곳의 개별 결함**이지 fail의 구조적 다수 원인이 아님(fixable-unresolved의 3%).
9. **`[verified]` substring-message 약오라클 가설도 within-system에서 붕괴.** substr vs exact/struct: lstar −17pp(p=0.049, n=27 경계), eotter −12pp(p=0.142), assertflip −10pp(p=0.394), **reproagent +11pp(p=0.524, 부호반전)**. 4개 중 유의 0~1개. cross-system 신호는 model confound였다.
10. **`[verdict]` assertion-quality = "raw strength"로는 **분리 불가능한 model confound**, 단 "oracle correctness/direction"의 좁은 조각만 약하게·부분적으로 prompt-addressable(~13% headroom).** Round-1 "약한단언이 fail을 만든다"는 **strength 버전은 반증**, **correctness 버전은 부분 생존(하지만 우리가 프롬프트로 못 바꾸는 모델추론에 대부분 종속).**

---

## TASK 1 — assertion strength × resolved, system AND repo 통제

### 분류 분포 (4시스템 1689 attempted 행)

```
lstar      exact 420  struct 28  substr 27  presence 9  vacuous 2  none 14
eotter     exact 344  struct 26  substr 43  presence 6  vacuous 0  none 13
assertflip exact 269  struct  4  substr 24  presence 10 vacuous 0  none 19
reproagent exact 388  struct 11  substr 12  presence 7  vacuous 1  none 12
```
관찰: exact-value가 ~80% 지배(생성 테스트 대부분 실제로 `==`/`assertEqual`/`assertRaises`를 씀). 변별 신호는 WEAK 꼬리에만 존재 → STRONG vs WEAK 이분으로 검정.

### within-system (model 고정)

```
lstar       STRONG 358/448=79.9%  WEAK 39/52=75.0%  delta +4.9pp  Fisher p=0.468
eotter      STRONG 225/370=60.8%  WEAK 38/62=61.3%  delta -0.5pp  Fisher p=1.000
assertflip  STRONG 153/273=56.0%  WEAK 35/53=66.0%  delta -10.0pp Fisher p=0.224
reproagent  STRONG 288/399=72.2%  WEAK 15/32=46.9%  delta +25.3pp Fisher p=0.004   ← 유일 유의
```
**4개 중 3개가 비유의이고 부호도 엇갈린다.** reproagent만 STRONG 우위(+25pp). 하지만 이건 reproagent의 WEAK 행에 "none(빈/깨진 oracle) 0/13"이 몰린 아티팩트 — reproagent의 none 13건은 전부 fail(0% resolved)이라 WEAK 평균을 끌어내림. 이건 strength가 아니라 *그 시스템의 깨진 생성*이다.

### within-system-within-repo (model AND repo 동시 고정) — 결정적

각 (system,repo)에서 STRONG/WEAK 둘 다 ≥3인 17개 cell:

| system | repo | STRONG | WEAK | delta | Fisher p |
|---|---|---|---|---|---|
| lstar | sphinx-doc | 16/37=43% | 0/7=0% | **+43pp** | **0.037** |
| assertflip | scikit-learn | 8/15=53% | 8/9=89% | −36pp | 0.178 |
| assertflip | sphinx-doc | 3/14=21% | 3/6=50% | −29pp | 0.303 |
| reproagent | sphinx-doc | 5/16=31% | 1/12=8% | +23pp | 0.196 |
| eotter | scikit-learn | 16/20=80% | 4/4=100% | −20pp | 1.000 |
| eotter | sympy | 43/67=64% | 5/6=83% | −19pp | 0.657 |
| lstar | matplotlib | 25/29=86% | 5/5=100% | −14pp | 1.000 |
| … (나머지 9 cell delta ≤±12pp, 전부 p≥0.5) | | | | | |
| **within-cell 풀링** | | **749/1088=68.8%** | **108/174=62.1%** | **+6.7pp** | **0.0805** |

**핵심:** (a) 17 cell 중 p<0.05 단 1개(lstar×sphinx, n=44, WEAK가 0/7이라 우연 가능). (b) 부호가 sphinx 내부에서조차 system별로 뒤집힘(lstar +43 vs assertflip −29). (c) 풀링 p=0.08로 비유의. → **model과 repo를 동시 고정하면 assertion STRENGTH는 resolved를 예측하지 못한다. strength는 system이 confound한다.**

---

## TASK 2 — STRENGTH vs CORRECTNESS: 비단조(weak-correct가 strong-wrong을 이기는 빈도)

### 페어드 비단조 카운트 (같은 instance, 시스템 간)

```
WEAK-assert RESOLVED  &  STRONG-assert FAILED  (같은 인스턴스):  36건
STRONG-assert RESOLVED & WEAK-assert FAILED   (반대):           32건
비율 = 36/(36+32) = 53%
```
**약한 단언이 강한 단언을 이기는 일이 그 반대만큼 잦다.** strength가 정답을 단조 예측한다면 이 비율은 0에 수렴해야 한다. 53%는 strength와 correctness가 사실상 직교임을 뜻한다.

### 대표 비단조 (실측 assert 인용)

`[verified]` **sklearn-10297** (Round-1 사례 확대 확인):
- AssertFlip: `assert hasattr(model, 'cv_values_')` (presence-only, 最弱) → **RESOLVED**
- e-Otter: `assert_equal(clf.cv_values_.shape, (n_samples, n_alphas))` (structural, strong) → **FAILED** — multiclass gold shape는 `(n_samples, n_classes, n_alphas)`. strong인데 *틀린 shape*.
- ReProAgent: `assert clf.cv_values_.shape == expected_shape` (strong) → **FAILED** 동일 이유.
→ 약하지만 옳은 단언이 강하지만 틀린 단언 2개를 이김.

`[verified]` **sphinx-8551**:
- AssertFlip: `assert "...cross-reference 'A'..." not in warnings` (substring 1줄) → **RESOLVED**
- L*Agent/e-Otter: `assert len(xrefs)==2`, `assert param_xref_target=='A'`, `assert len(matches)==1` 등 6개 exact-xref-구조 단언 → **FAILED** — 내부 xref 객체 구조를 과명세해 실제와 불일치.

`[verified]` **django-16082**:
- L*Agent: `self.assertIsInstance(output_field, combined)` (presence, 타입만, but 올바른 파라미터화) → **RESOLVED**
- e-Otter: `self.assertAlmostEqual(mixed_obj1.n_mod, Decimal("0.5"))` (exact, 하드코딩 기대값) → **FAILED**.

`[verified]` **django-16145**: AF `assertIn("Starting development server at http://0.0.0.0:8000/", output)` (메시지 substring) RESOLVED; e-Otter `assertServerSettings("0.0.0.0","8000")`(틀린 helper 경로) FAIL; lstar는 print 위치 의존 회피 위해 일부러 `assertIn("0.0.0.0", str(pos_args[0]))`로 *약하게* 가서 RESOLVED — **의도적 약화가 robust해서 이김.**

→ **결론(Task 2): 약한단언이 강한단언을 이긴 비단조 = 36건(전체 페어드의 53%). actionable 축은 STRENGTH가 아니라 CORRECTNESS/DIRECTION/robustness다.** "강하게 단언하라"는 오히려 brittle·over-specify를 늘려 sklearn-10297·sphinx-8551처럼 strong-wrong fail을 만든다.

---

## TASK 3 — Addressable headroom: fixable assert 문제 vs unfixable

### unresolved 538행(4시스템 attempted)의 fixable/unfixable

```
FIXABLE  (다른 시스템이 同 인스턴스 resolved = 올바른 oracle이 존재했음):  366/538 = 68.0%
UNFIXABLE(아무 시스템도 못 풂 = localization/fixture/모델추론 벽):        172/538 = 32.0%
distinct 인스턴스 기준 NEVER-solved(consensus-hard) = 72/500 = 14%
```
per-system fixable율: eotter 78%, assertflip 83%, reproagent 70%, lstar 30%(L*가 최강이라 L*가 못 푼 건 대개 진짜 어려움).

### FIXABLE 366의 실패-모드 — 거의 다 strong-but-wrong

```
strong-but-wrong oracle (exact/struct 썼는데 fail = 값/방향/localization 오류):  320  (87%)
weak-oracle (substring/presence; 강화로 고칠 수도)                                35  (10%)
vacuous/empty-oracle (확실히 fixable assert)                                       11  ( 3%)
```
**assertion-STRENGTHENING으로 회수 가능한 headroom = vacuous 11 + weak 35 = 46/366 = ~13%.** 나머지 87%는 **이미 강한 단언을 틀린 값/방향으로 쓴 것**이라, "더 강하게/덜 약하게" 프롬프팅으로 안 고쳐진다. 이걸 고치려면 "고친 후 기대 동작"을 모델이 옳게 추론해야 함(우리가 프롬프트로 직접 못 박는 부분).

### UNFIXABLE 바닥 172행 — 단언 품질 무관

```
strong-assert 쓰고도 fail:  146  (85%)
weak-assert:                 26  (15%)
```
바닥의 85%가 강한 단언을 쓰고도 실패 → **벽은 assertion 품질이 아니라 localization/fixture-state/모델 추론.** 단언을 손대도 못 뚫는다(Round-1 fixture under-supply·private-attr·내부구조 오가정과 동일 부류).

---

## TASK 4 — Verdict: assertion-quality는 우리가 프롬프트로 당길 수 있는 진짜 분리 레버인가

| 주장 | Round-2 데이터 판정 |
|---|---|
| assertion **STRENGTH**(exact > substring > presence)가 인과 레버 | **반증.** within-system-within-repo 17 cell 중 유의 1개, 풀링 p=0.08. 비단조 53%. cross-system 상관은 model confound(Simpson). |
| **weak-substring**이 fail을 만든다 (Round-1) | **부분 반증.** within-system에서 4중 유의 0~1개, reproagent는 부호반전(+11pp). substring 56%<exact 69%는 약한모델이 substring을 많이 써서 생긴 위장. |
| **vacuous(skip/or-chain/빈본문)**가 fail을 만든다 | **실재하나 희소.** 명백 vacuous 3건, fixable-unresolved의 3%. 개별 시스템 결함이지 구조적 다수 원인 아님. |
| oracle **CORRECTNESS/DIRECTION**이 레버 | **약하게 지지.** 비단조 36건·strong-but-wrong이 fixable-fail의 87%. 하지만 "방향을 옳게"는 대부분 **모델 추론**이라 prompt로 직접 강제 어려움. prompt-addressable headroom ≈ 13%(vacuous 제거 + weak-when-strong-available 강화). |
| assertion-quality가 **null** 레버 | strength 축은 **지지**, correctness 축은 **부분적으로만 반박**(13% 회수 가능). |

**정밀 결론:** Round-1이 "assertion/oracle 품질이 진짜 분리 레버"라 한 것은 **두 개념을 묶은 conflation**이다. 풀면:

1. **assertion STRENGTH(raw)** = insertion과 똑같이 **model-strength에 교락된 비-인과 변수.** model AND repo 고정 시 p=0.08, 비단조 53%. "더 강하게 단언하라"는 프롬프트는 오히려 brittle/over-specify로 strong-wrong fail을 늘릴 수 있다(sklearn-10297, sphinx-8551 실증).

2. **oracle CORRECTNESS/DIRECTION** = 약하게·부분적으로 살아남는 lever지만 대부분 **모델 추론에 종속**이라 우리가 프롬프트로 직접 못 바꾼다. prompt로 당길 수 있는 조각은 좁다: (a) 명백 vacuous(skipTest 가드·`assertX() or assertY()` or-chain·빈 본문) 금지 — 단 빈도 3%, (b) "exact 가능할 때 substring으로 도망가지 마라" — 단 within-system에서 robust한 약화가 이기는 경우(django-16145)도 있어 일률 강제는 역효과. 합쳐 ~13% headroom.

→ **분리 가능한 진짜 레버는 Round-1·insertion-rescue와 동일하게 (1) localization 정확도, (2) fixture-state 충족, (3) "고친 후 무엇이 맞는가"의 oracle DIRECTION 추론(=모델 능력)이며, assertion의 raw STRENGTH 축은 이 위에 독립 신호를 거의 남기지 않는다.** 우리가 프롬프트로 안전히 당길 수 있는 부분은 vacuous-guard 같은 위생 규칙(~3%)과 over-specify 억제이지, "단언을 강화하라"가 아니다.

---

## 한계 / Round-3에서 검증할 것

- 분류기 `none` 버킷이 **exit-code 오라클(TEX류, resolved 81~95%)과 진짜 빈/깨진 oracle(reproagent 0/13)을 conflate**한다. TASK1/3에서 none을 WEAK로 넣어 reproagent WEAK율을 인위적으로 낮춤(within-system reproagent +25pp의 일부 아티팩트). Round-3에서 exit-code를 별도 STRONG-equivalent로 재분류 권장.
- exact-value 버킷이 ~80%로 과대 — `==`만 잡아 "exact scalar"와 "구조 동등"을 충분히 분리 못 함. structural 세분류(shape/list/dict)로 재태깅 시 strength-효과가 더 작아질 가능성(현 분석은 strength-효과의 *상한*).
- "fixable = 다른 시스템이 풀었다"는 oracle-correctness의 proxy일 뿐 — 같은 인스턴스라도 시스템마다 localization이 달라 일부 fixable은 사실 localization 문제. 87% strong-but-wrong 중 일부는 strength도 correctness도 아닌 localization. → correctness-only headroom은 13%보다 더 작을 수 있음(현 추정은 prompt-headroom의 *상한*).
- 비단조 36건은 cat 분류 노이즈에 민감(presence/substring 경계). 핵심 3~4건(sklearn-10297, sphinx-8551, django-16082/16145)은 패치 직접 인용으로 검증됨.

## 재현 메모
- L*Agent 라벨: `/tmp/lstar_logs/lstar_agent_verified/logic_star_ai/<id>/report.json`의 `resolved`(500/500). tests_gold도 동봉.
- e-Otter/AssertFlip: `_predictions/{eotter_plus,assertflip}_verified.evaluation.json`의 `resolved_ids`/`unresolved_ids`.
- ReProAgent: `reproagent/outputs_gpt_5_mini/ReProAgent.repro_agent_gpt_5_mini_verified.json`(resolved 303, unresolved 128).
- 패치: eotter `*.inference.json`, AF `*.preds.jsonl`, RA `repro_agent_preds_*.jsonl`, lstar `*.json`.
- 분류·검정 스크립트: `/tmp/classify2.py`(strongest-assert 분류), `/tmp/contingency.py`(within-system-within-repo Fisher), `/tmp/nonmono.py`(비단조), `/tmp/headroom2.py`(fixable 분해), `/tmp/substr_within.py`(substring within-system). Fisher exact는 hypergeometric 직접 합산(2-sided).
