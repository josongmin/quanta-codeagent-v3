# 천장 72개 — "왜 아무도 못 풀었나" 적대적 리뷰

> ## ⚠️ 정정 (2026-06-19, 134-전수 census 반영 — 아래 본문보다 우선)
> 이 문서의 "72 천장"은 **9개 부분집합 과대계수**였다. 공개 134개 전수 union으로 재계산한 **진짜 천장 = 32개**(`scaffold-solving-summary.md` §4). 9-subset 72 중 ~40개는 다른 제출(Sonar/Trae/Prometheus 등)이 실제로 푼다.
> - **천장 32 = 134개 전부 실패**(Trae·Sonar 포함). 단 "풀 수 없다"의 증명 아님 — 우리 Opus-4.8은 census에 없음, 더 센 모델이면 깸.
> - **EDGE-YES 태깅은 오라클 오염으로 무효**(적대감사 C5 → census로 확정). 증거: 내가 EDGE-YES로 골라 실측한 3개 중 **2개(`sphinx-7462`,`django-16667`)가 하필 #=0 진짜 천장**(아무도 못 푸는 걸 "회복 가능"이라 태깅). `sympy-17630`은 천장 아님(#=2: Sonar/opus4.5 + Prometheus/gpt5가 풂, **단 Sonar는 🔒closed라 흡수 불가**; Trae는 실패)이고, 이후 quanta gpt-5.5도 clean sidecar PASS.
> - **edge3 실측 0/3은 stale**: 당시 localize_score 분해 = django-16667 EXACT(합성 미스, localize 무관) / sphinx-7462 PARTIAL(multi-site) / sympy-17630 MISS(loc), pyright+repro confounded(`jun-19-ceiling-bench-pyright-ami-gap`). 이후 `sympy-17630`은 quanta gpt-5.5 PASS로 회복.
> - **실제 회복 타겟 = 천장 32가 아니라 "#높은데 우리만 놓치는" 것**(예: `django-13417` #109). 천장은 우선순위↓.
> - 결론: "병목=localization"은 **미확정**. n=3에서 loc-miss/multi-site/합성 1:1:1. ~36셋 wrong-surface rate 측정 전엔 단정 금지.

---
*(이하 원본 — 9-subset 72 기준, 위 정정으로 superseded)*

입력: 9개 대표 스캐폴드(opus-tools/sonnet-tools/OH-c4/OH-4x/moatless/Refact/epam/sweagent/aless-lite) 전부 실패한 72 instance.
방법: repo별 8 에이전트 병렬, 각자 우리 oracle-grounded 리뷰(`docs/analysis/swe-bench-verified-analysis/<repo>/<id>.md`) + `verified-full.jsonl`(gold patch/test_patch/F2P/P2P) 근거. TAXONOMY.md 축 사용.
원칙: 난이도는 solve-rate가 아니라 구조적 피처로 본다 → "easy인데 0/9"가 핵심 신호.

## 헤드라인

**천장의 절반(~36/72)은 구조적으로 쉬움(T2–T4, 작은 패치, 대개 L0/L1 localize)인데 0/9다.** 즉 "어려워서 못 푼 게" 아니다. 못 푼 진짜 이유는 반복되는 **함정(trap)** 들이고, 이 함정들은 대부분 **하네스로 공격 가능한 클래스**다 — 우리가 jun 내내 만들어온 것과 정확히 겹친다.

### Primary 원인 분포 (72)

| 원인 | 수 | 성격 | 하네스로 잡히나 |
|---|---|---|---|
| DOMAIN-KNOWLEDGE | 21 | 프레임워크 내부지식(ORM/autodoc/transforms/assumptions) | 대체로 모델천장 (EDGE-MAYBE/NO) |
| HARD-DESIGN | 14 | 조율 멀티파일 / design-refactor (T5/T6) | 거의 불가 (EDGE-NO) |
| OVERFIT-TRAP | 10 | 얇은 F2P가 locally-green-but-wrong 통과 | **잡힘** (test-feedback closure) |
| SPEC-INFERENCE | 9 | 의도가 코드만으론 미결정 / 이슈가 거짓유도 | 부분 (closure가 노출, 합성은 모델) |
| HARD-LOCALIZE | 8 | symptom-site ≠ fix-site, 멀티사이트 | **잡힘** (execution-trace/LSP) |
| CONSTRAINT-REASON | 3 | 올바른 식·조건을 추론 합성(주로 sympy 수학) | 모델천장 (EDGE-NO) |
| TEST-HARNESS | 3 | image-compare/exact-output 등 테스트 메커닉 | 부분 |
| REGRESSION-TRAP | 3(primary)/~30(secondary) | 넓은 P2P가 그럴듯한 픽스를 깸 | **잡힘** (regression gating) |

secondary로 **REGRESSION-TRAP은 사실상 전 instance에 깔려있다**(P2P 4~3154). 즉 "픽스 자체"가 아니라 "옆 동작 안 깨기"가 진짜 벽인 경우가 압도적.

## 정적엔진 관점 재태깅 (manual, 2026-06-23)

> 아래는 "정적엔진이 있으면 도움되나?"를 보기 위한 **counterfactual 수기 태깅**이다.
> `MUST` 판정이 아니다. 특히 `SE-HELP-*`는 "실무상 확률을 올린다"는 뜻이지, 정적엔진만 넣으면 닫힌다는 뜻이 아니다.

### 태그 정의

- `SE-HELP-IMPACT` — cross-file impact / delegation / blast-radius
- `SE-HELP-MRO` — override / sibling reachability / explicit MRO walk
- `SE-HELP-DEFUSE` — def-use / alias / reference-closure
- `SE-HELP-AST` — AST shape search / bulk callsite enumeration
- `SE-NO-PRIMARY` — 정적신호가 있어도 최종 병목이 domain / reasoning / hard-design

### 이 문서의 원인분포와 정적엔진 태그의 관계

| 여기 원인축 | 정적엔진 관점 | 메모 |
|---|---|---|
| `HARD-LOCALIZE` | 주로 `SE-HELP-IMPACT` / `SE-HELP-MRO` / `SE-HELP-DEFUSE` | 정적엔진이 가장 직접적으로 먹히는 구간 |
| `OVERFIT-TRAP` / `REGRESSION-TRAP` | `SE-HELP-IMPACT` 보조 + regression gate 병행 | 엔진만으로 닫히지 않고 verify rail이 같이 필요 |
| `DOMAIN-KNOWLEDGE` / `HARD-DESIGN` / `CONSTRAINT-REASON` | 대체로 `SE-NO-PRIMARY` | 정적신호가 있어도 주병목은 남음 |
| `SPEC-INFERENCE` | mixed | callsite 열거엔 도움되지만 의도합성은 모델 몫 |

### 고신뢰 likely-help 묶음

- `SE-HELP-IMPACT`
  - `django-11400`, `django-12406`, `django-15629`, `sphinx-7462`
  - 공통점: shared helper / delegation / sibling site를 같이 따라가야 하고, 한 곳 수정으로는 closure가 안 난다.
- `SE-HELP-MRO`
  - `pytest-10356`, `astropy-14182`, `matplotlib-26466`
  - 공통점: 일반 lookup / grep으로는 형제 베이스나 override 전부를 못 본다.
- `SE-HELP-DEFUSE`
  - `django-11734`, `django-16263`
  - 공통점: alias / ref-use closure를 실제로 따라가야 한다.
- `SE-HELP-AST`
  - `django-13212`
  - 공통점: 같은 shape 호출부를 bulk-enumerate 해야 누락이 줄어든다.

### 정적엔진이 primary bottleneck은 아닌 대표군

- `SE-NO-PRIMARY`
  - `astropy-13398`, `sympy-13852`, `sympy-18199`, `sphinx-11510`, `xarray-6992`
  - 공통점: 최종 병목이 수학 추론, 프레임워크 의미, hard-design / lifecycle 재설계 쪽에 있다.

### 실무 결론

- `엄밀 MUST`로 확정된 케이스는 아직 없다.
- 하지만 `SE-HELP-IMPACT` 군은 이 셋업에선 **실무상 near-MUST**에 가깝다.
- 하나만 만들면 범용 "정적엔진"보다 **finalize 직전 blast-radius를 보는 impact backend**가 우선이다.
- 다음 검증은 `SE-HELP-*` 후보군을 묶어 finalize 직전 신호 주입 A/B로 해야 한다.

## "easy-but-failed" — 천장의 진짜 정체 (~36)

difficulty가 아니라 아래 4개 함정 중 하나로 0/9가 된 케이스들. **여기가 우리 ROI 구간.**

1. **이슈/힌트가 틀린 픽스를 권한다 (model-trust trap)** — 모델이 이슈 텍스트를 곧이곧대로 믿어서 죽음.
   - `sympy-20916`(이슈가 `\w` 권함 → 숫자 흡수로 틀림, 정답 `[^\W\d_]`+`re.U`), `pylint-4661`(이슈 `~/.local/share` vs gold `~/.cache`), `sklearn-26194`(이슈 `clip` vs gold `np.inf`), `xarray-7229`(힌트 `attrs[1]` dead-end), `django-10999`(이슈 정규식이 invalid 통과), `django-13794`.
2. **error-site ≠ fix-site (symptom/cause split)** — 스택트레이스 따라가면 엉뚱한 파일을 고침.
   - `matplotlib-23299`(Gcf→실은 rc_context), `matplotlib-23476`(`__setstate__`→실은 `__getstate__`), `matplotlib-25479`(set_cmap→실은 register+`__eq__`), `sympy-17630`(blockmatrix→matexpr postprocessor), `sympy-20428`(terms_gcd→EX `__bool__`), `sphinx-9229`(get_doc→add_content), `sklearn-14629`(consumer `_validation`→producer `multioutput`), `django-15973`(schema.py 증상→autodetector 의존성그래프).
3. **멀티사이트 exhaustiveness** — 픽스는 기계적인데 2~3+곳에 다 적용해야 하고 에이전트가 한 곳에서 멈춤.
   - `sphinx-7462`(unparse 2곳), `django-13212`(~12 raise + cross-file), `django-13195`(3 subsystem), `django-16256`(unnamed generic manager family), `matplotlib-26466`(OffsetFrom sibling), `astropy-8707`(card+header).
4. **얇은 F2P overfit / 넓은 P2P regression** — locally green인데 hidden generalize 실패, 또는 옆 깨짐.
   - `astropy-7606`/`8872`(L0 ~4줄인데 wrong fix가 F2P 통과), `django-16667`(OverflowError fallback sentinel), `pytest-10356`(store_mark이 P2P-79 깸).

## 우리 리뷰(`docs/analysis/...`)와의 정합

- 우리 oracle 리뷰가 이미 이 72개를 전부 커버 + tier/축 라벨링했고, 이번 적대 리뷰는 그걸 **"왜 0/9"** 각도로 교차검증함. 라벨과 충돌 없음.
- 우리 TAXONOMY의 핵심 주장("난이도 ≠ solve-rate, 구조피처로 매겨라")이 데이터로 확인됨: T2 라벨(`sympy-20916`, `django-14315`, `django-16667`, `sphinx-7462`)이 0/9. solve-rate로 tier 매겼으면 이걸 "T6 초고난도"로 오분류했을 것.

## quanta 강점(강티) 매핑 — 정직하게

EDGE-YES ~14 (우리 차별기로 플립 plausible) / EDGE-MAYBE ~43 / EDGE-NO ~15 (순수 모델·설계 천장).

| 우리가 만든 것 | 공격하는 천장 클래스 | 회복 후보 |
|---|---|---|
| execution-trace localization (jun-17, sympy-23262 교훈) | symptom/cause split #2 | matplotlib-23299/23476/25479, sympy-20428, sphinx-9229, django-11477/15973 (`sympy-17630`은 이후 quanta gpt-5.5 PASS receipt 확보) |
| warm-LSP cross-file grounding + steer DEFAULT-ON (jun-17) | 멀티사이트 #3, cross-file dep | django-11400/13195/13212/16256, astropy-8707, sphinx-7462 |
| agentless closure + test-feedback (jun-17 execfeedback) | overfit #1·#4, model-trust trap | sympy-20916/21930, astropy-7606/14182, django-16667/14315, sklearn류 |
| regression-safety gating (patch-slice/staleness) | REGRESSION-TRAP (전 instance secondary) | pytest-10356, django P2P-heavy 다수 |

**EDGE-NO 15개는 솔직히 우리 것도 아니다** — `astropy-13398`(ERFA 굴절모델+frame-graph 설계), `sympy-13852`(dilog 닫힌형), `sympy-18199`(합성수 nth-root Hensel/CRT), `django-11734`(OuterRef 이중래핑 비직관), `django-16263`(reference-closure 인프라 신설), `sphinx-7590/9461`(C++ UDL/descriptor 멀티사이트 feature-add), `xarray-6992`(>4h 945 P2P) 등. 이건 모델 capability or design synthesis라 하네스 무관.

## 결론 한 줄

천장 72개는 "모델이 약해서"가 아니라 **절반이 함정(이슈가 거짓유도 / 증상≠원인 / 멀티사이트 미완 / overfit·regression)** 때문이고, 그 함정의 다수가 우리가 이미 랜딩한 4대 차별기(trace-localize / warm-LSP / closure-feedback / regression-gating)의 정조준 대상이다. 즉 이 분석은 우리 로드맵이 "feature 수"가 아니라 **localization grounding + test-feedback 폐루프**에 박혀야 한다는 걸 외부 데이터로 재확인해준다.
