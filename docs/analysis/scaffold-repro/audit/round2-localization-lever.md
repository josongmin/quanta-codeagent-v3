# Round-2 적대 감사 — Localization은 분리가능한 진짜 lever인가? (repo 난이도의 위장이 아닌가?)

**질문 (Round-1 후속)**: R1이 "AF·ReProAgent는 버그 모듈과 무관한 고정 덤프 버킷에 테스트를 떨군다 / L\*Agent·eOtter는 맞는 모듈을 겨냥한다"고 지목했다.
Round-2는 이걸 **정량 lever로 검증**한다: 생성된 테스트가 *gold가 고친 코드 경로를 실제로 건드리는가*(targets-gold) 라는 proxy를 만들고,
targets-gold vs misses-gold의 **resolved-rate 차이**를 시스템별로 측정한다. 그리고 적대적으로 — 이게 그냥 **어려운 repo(sphinx)와의 상관**을 localization으로 위장한 건 아닌지 repo를 통제해 반증한다.

---

## 0. 헤드라인 — targets-gold vs misses-gold resolved-rate gap (deliverable #1)

생성 테스트가 gold-changed symbol/module-path를 import/참조하면 `targets-gold=True`(strong), 아니면 miss. per-instance resolved 라벨 보유 3개 시스템(AssertFlip·eOtter·ReProAgent) pooled:

| system | N | tgtN | **tgt res%** | missN | **miss res%** | gap(pp) |
|---|---:|---:|---:|---:|---:|---:|
| AssertFlip | 326 | 263 | **61.2%** | 63 | **42.9%** | **+18.4** |
| eOtter++ | 432 | 215 | **70.2%** | 217 | **51.6%** | **+18.6** |
| ReProAgent | 431 | 374 | **74.1%** | 57 | **45.6%** | **+28.5** |
| **POOLED** | **1189** | **852** | **69.1%** | **337** | **49.0%** | **+20.2** |

> **결론: targets-gold 테스트는 misses-gold보다 +20.2pp 높게 resolve된다(69.1% vs 49.0%).**
> 2×2 (targets/miss × resolved/unresolved): a=589 b=263 c=165 d=172, **χ²=42.3 (df=1, p≪0.001), odds ratio=2.33**.
> 세 시스템 모두 같은 방향(+18~+29pp). localization 정확성은 **통계적으로 강건한 분리가능 lever**다 — R1의 정성 관찰을 정량 확증.

(evidence: `/tmp/loc_analysis.py`, `/tmp/loc_results.json`. proxy=test-body의 import 모듈 dotted-path가 gold 코드파일 dotted-path와 겹치거나, gold가 고친 함수/클래스 symbol이 test-body 식별자에 등장. gold 코드패치는 SWE-bench_Verified `patch` 필드에서 추출 — `+++ b/<file>`에서 비-test 파일만, `@@ def|class`/`+def|class`에서 변경 symbol. `/tmp/gold_code.json`, 500/500 instance, 496개 symbol 보유.)

---

## 1. 적대적 통제 — misses-gold는 그냥 sphinx(어려운 repo)인가? **아니다, gap의 ~3/4가 repo 내부에서 생존.** (deliverable #3)

가장 위험한 confound: "miss-gold"가 단지 hard repo에 몰려 있고, hard repo가 어차피 resolve 낮으면 gap은 가짜다. repo를 통제(within-repo 비교):

| repo | tgtN | tgt% | missN | miss% | within-repo gap(pp) |
|---|---:|---:|---:|---:|---:|
| django | 459 | 70% | 110 | 46% | **+23** |
| sympy | 166 | 66% | 41 | 63% | +3 |
| matplotlib | 39 | 64% | 54 | 76% | −12 |
| sphinx | 20 | 45% | 56 | 14% | **+31** |
| scikit-learn | 65 | 80% | 7 | 86% | −6 |
| astropy | 39 | 74% | 10 | 60% | +14 |
| xarray | 26 | 77% | 18 | 56% | +21 |
| pytest | 15 | 73% | 27 | 44% | +29 |
| pylint | 11 | 64% | 5 | 40% | +24 |
| requests | 9 | 67% | 3 | 67% | 0 |

- **within-repo N-가중 평균 gap = +15.1pp** (양arm 보유·N≥8 repo 10개), **positive-gap repo = 7/10**.
- pooled gap +20.2pp 중 **약 3/4(15.1pp)가 repo를 통제해도 생존**. 나머지 ~5pp만 repo-mix(sphinx 같은 hard repo가 miss-heavy)로 설명됨.
- **sphinx ≠ 유일 동력**: 최대 repo인 django(569 instance) 단독으로 +23pp within-repo gap. pytest +29, pylint +24, xarray +21도 큰 양수. sphinx는 gap을 *부풀리지만*(miss-rate 74% + base resolve 22% 둘 다 극단) 제거해도 lever는 남는다.
- matplotlib(−12)·sklearn(−6)만 약한 음수 — 둘 다 miss arm이 작거나(sklearn miss 7) targeting이 거의 포화돼(sklearn tgt 90%) noise. 반례로 솔직히 기록.

> **adversarial verdict: localization은 repo 난이도의 위장이 아니다.** repo를 고정해도 targeting-gold가 resolved를 예측한다(+15pp). sphinx는 confound를 일부 보태지만 동력은 아니다.

(evidence: `/tmp/loc_analysis.py` 재실행 within-repo 블록. miss-rate by repo: sphinx 74%·pytest 64%·matplotlib 58%·xarray 41% = "어려운/이질적 repo일수록 miss 많음"은 사실 — 그래서 통제가 필수였고, 통제 후에도 생존.)

---

## 2. AssertFlip/ReProAgent "덤프 버킷" 주장 검증 — 사실이나 **directory는 cosmetic, import가 load-bearing** (deliverable #2)

R1 주장: AF/ReProAgent는 버그 모듈과 무관한 고정 디렉터리(`sympy/polys/tests`, `sklearn/tests` 등)에 떨군다. test 파일 디렉터리가 gold 코드 package dir과 무관한 비율 + 그게 실패를 예측하는지:

| system | N | **unrelated-dir 비율** | related-dir res% | unrelated-dir res% | dir-mismatch gap(pp) |
|---|---:|---:|---:|---:|---:|
| AssertFlip | 326 | **88%** (287/326) | 67% (26/39) | 56% (162/287) | +10 |
| ReProAgent | 431 | **90%** (387/431) | 77% (34/44) | 70% (269/387) | +8 |
| eOtter++ | 432 | 67% (291/432) | 71% (100/141) | 56% (163/291) | +15 |

- **R1의 덤프-버킷 관찰은 확증**: AF 88%·ReProAgent 90%가 gold 코드 package와 무관한 디렉터리에 배치(둘 다 `test_coverup_*`/`test_repro_agent_*` 신규 isolated 파일). eOtter는 67% — 기존 test 파일에 삽입하므로 "맞는 디렉터리" 빈도 더 높음.
- **그러나 디렉터리 mismatch는 실패를 *약하게만* 예측(+8~+10pp for AF/Repro)**. 이유: 새 isolated 파일이 "틀린 폴더"에 있어도 그 안에서 gold 모듈을 `import`해 올바른 코드 경로를 칠 수 있다. **파일이 어느 폴더에 사느냐는 채점과 거의 무관**(채점은 F→P 실행이지 위치가 아님).
- 대조: **import/symbol targeting gap(§0, +18~+29pp) ≫ directory-placement gap(+8~+15pp)**.

| system | symbol/module-target gap | directory-placement gap |
|---|---:|---:|
| AssertFlip | **+18pp** | +10pp |
| eOtter++ | **+19pp** | +15pp |
| ReProAgent | **+28pp** | +8pp |

> **R1 정정/정련**: AF/ReProAgent가 고정 버킷에 떨구는 건 맞지만, *디렉터리 위치 자체는 cosmetic confounder*다. 진짜 lever는 R1이 §2 끝에서 옳게 지적한 **"import 대상 symbol이 localization의 진짜 지표"** 쪽 — 테스트가 *무엇을 import하고 실행하느냐*. directory bucket은 그 상관물일 뿐 인과가 아니다.

(evidence: `/tmp/dump_analysis.py`. related-dir = test 디렉터리가 gold 코드파일의 package dir과 prefix 공유. gold 코드패치 dir 기준.)

### 2-bis. miss가 그냥 "빈/사소한 테스트"는 아닌가? — 통제됨

miss-gold 테스트가 단지 degenerate(짧고 assert 없음)라서 떨어지는 것일 가능성 차단:

| system | miss N | <8-line | no-assert |
|---|---:|---:|---:|
| AssertFlip | 63 | 3% | 3% |
| eOtter++ | 217 | 3% | 2% |
| ReProAgent | 57 | 2% | 18% |

→ miss의 97%가 실질 본문(assert/raises 보유). targeting gap은 "miss=빈 테스트"의 위장이 아니다. (ReProAgent no-assert 18%는 일부 exit-code/exception 스타일 — 그래도 다수는 실질.) (evidence: `/tmp` substance-control 스크립트.)

---

## 3. proxy의 한계 (적대적 자기검증 — 결과를 과신하지 말 것)

1. **insertion 시스템에서 import-proxy는 targeting을 과소측정**. eOtter는 기존 test 파일에 삽입 → gold 모듈 import가 **diff hunk 밖(파일 상단 기존 import)**에 있어 proxy가 못 본다. 그래서 eOtter tgt-fraction(50%)이 AF/Repro(81~87%)보다 인위적으로 낮다. **단, 시스템 *내부* gap 방향성은 유효**(eOtter strong 70% vs miss 52% = +19pp) — body 안 symbol 참조로 여전히 변별. 절대 tgt-fraction의 cross-system 비교는 신뢰 금지, gap 부호/크기는 신뢰. (evidence: eOtter `astropy-13033` 등 본문에 import 라인 0, gold symbol은 본문서 직접 참조.)
2. **proxy는 R1의 정성 localization보다 coarse(관대)**. 예: AF `astropy-13033`은 `_check_required_columns()`를 *직접 인위 호출*(실 trigger `remove_column` 우회) → R1은 "틀린 경로"로 unresolved 판정했으나, proxy는 symbol을 참조하므로 strong=True인데 실제 unresolved. 즉 proxy는 "gold symbol을 언급" ≠ "올바른 trigger 경로로 도달"을 구분 못함. 이는 **보수적**(targeting의 진짜 효과를 *약화*시키는 방향) — gap이 과대평가 아님.
3. per-instance resolved 라벨은 AssertFlip·eOtter·ReProAgent 3개만 보유. **L\*Agent·TEX-T·OpenHands는 predictions(L\*/TEX)나 resolved(OpenHands) 중 하나만** 있어 proxy×resolved 교차 불가 — 제외. (OpenHands는 eval만 있고 test patch 없음 / L\*·TEX는 집계점수만.)

---

## 4. 우리(quanta)에게 이 lever는 addressable한가? — **YES, 단 "코드-fix localization"이 아니라 "test-gen localization"으로** (deliverable #4)

우리 memory([[jun-29-gap-essence-synthesis-convergence-bottleneck]])는 "**우리 localization은 거의 해결(~85% 파일적중), 진짜 갭은 synthesis 수렴(24/28)**"이라 한다. 표면적으론 "localization은 남의 문제"로 읽힌다. 그러나:

- **여기 "localization"은 다른 task다.** R1/R2가 측정한 건 **생성한 *테스트*가 gold 코드 경로를 건드리는가**(SWT-bench/TDD-bench = issue-reproduction *test-gen* 경쟁). 우리 ~85%는 **코드-*fix* 에이전트가 고칠 *파일*을 맞히는** localization. 두 개는 다른 좌표.
- **우리는 이 test-gen 능력을 적극 흡수 중이다**([[jul-1-swt-bench-repro-agent-review]]): grounding.ts(stripTestBodies/exemplarBlock)·change-coverage gate·acceptance seam 위 surrogate-oracle 루프. 즉 *우리 파이프라인에 test-gen 경로가 이미 존재*하고, 그 경로의 localization 품질은 우리가 직접 통제 가능한 손잡이다.
- **따라서 addressable**: R2가 분리해낸 lever(=생성 테스트가 gold symbol/module을 실제 import·실행)는 우리 흡수 백로그의 **change-coverage gate**(편집/타겟 라인을 커버하는 테스트 선호)와 **extractSignatures grounding**(gold 후보 모듈의 class/import 시그니처만 노출)으로 **직결**된다. R2는 그 두 흡수 항목의 *효능 근거*를 제공한다: targeting이 +20pp(within-repo +15pp)를 만든다면, change-coverage gate로 non-targeting 테스트를 reject/repair하는 게 ROI 있다.
- **단, 우선순위 재확인**: 우리 코드-fix 천장의 본 병목은 여전히 synthesis 수렴(24/28). 이 test-gen-localization lever는 *test-gen surrogate-oracle 루프를 켤 때* 비로소 의미 — 오라클이 틀린 코드 경로를 보면 fix 선택이 오염되므로. 즉 **lever#1(fix-as-oracle exec-feedback 루프)의 *전제 품질*로서 addressable**이지, 독립 1순위는 아니다.

> **우리 입장 (명시적)**: 이 lever는 "남의 문제"가 아니다. 우리가 흡수하려는 test-gen 경로의 핵심 품질지표이고, change-coverage gate / signature-grounding 으로 직접 손댈 수 있다. 다만 코드-fix localization(~85%, 이미 해결)과는 **별개 좌표**이며, 우선순위는 surrogate-oracle 루프(lever#1)의 *입력 품질 게이트*로서 의미를 가진다 — 단독 1순위 아님, 그러나 명백히 addressable.

---

## 5. 증거 인덱스 (재현용)

- gold 코드패치 추출: `/tmp/gold_code.json` (SWE-bench_Verified arrow `~/.cache/huggingface/datasets/princeton-nlp___swe-bench_verified/.../swe-bench_verified-test.arrow`, `patch` 필드 → 비-test `+++ b/` 파일 + `@@/+def|class` symbol). 500 instance.
- proxy + resolved-rate: `/tmp/loc_analysis.py` → `/tmp/loc_results.json`. χ²/odds ratio 동스크립트.
- 덤프-버킷: `/tmp/dump_analysis.py`.
- per-instance resolved 라벨: `_predictions/{assertflip,eotter_plus}_verified.evaluation.json`, `reproagent/outputs_gpt_5_mini/ReProAgent.repro_agent_gpt_5_mini_verified.json` (`resolved_ids`/`unresolved_ids`).
- test predictions: AF `assertflip_verified.preds.jsonl`(326) / eOtter `eotter_plus_verified.inference.json`(432) / ReProAgent `repro_agent_preds_gpt_5_mini_verified.jsonl`(431).

---

## 6. Round-3에서 검증할 것 (한계)

- insertion-proxy 과소측정(§3-1) 보정: eOtter 같은 삽입형은 대상 test 파일의 *기존 import*를 base repo에서 읽어와 targeting 재판정(현재는 hunk-only) → eOtter tgt-fraction 정정.
- proxy coarse-ness(§3-2): "symbol 언급" vs "올바른 trigger 경로 도달"을 분리하는 더 엄격한 localization 라벨(AST 호출그래프 도달성) → 현재 gap은 보수적 하한이므로 진짜 lever는 더 클 수 있음.
- L\*Agent·TEX-T resolved 라벨 확보 시 5-시스템 교차(현 3-시스템). 특히 L\*Agent(84%, existing-insert)에서 targeting-gold 비율이 AF/Repro보다 높은지 — "insert 진영이 localization도 더 정확"이라는 R1 가설의 직접 검정.
- matplotlib/sklearn 음수 gap(§1)의 instance-level 재태깅(반례 사냥): targeting 포화(sklearn tgt 90%)·작은 miss arm noise인지, 진짜 반례인지.
