# 채점·오라클 방법론 전개 + quanta 준비도 매핑 (2026-06)

> 목적: 2026-06 기준 repro/test 품질을 **정의**하는 채점 방법론(SWT-bench, TDD-Bench Verified)을 코드 `file:line`으로 전부 펼치고, 우리(`quanta-codeagent-v3`) 오라클(acceptance/closure/repro selection)이 그 규율을 얼마나 갖췄는지 매핑한다.
>
> 근거 태그: `[verified]`=소스 직독, `[inferred]`=코드 정황.
> 원본: `.extracted_source/repro-scaffolds/{swt-bench,tdd-bench-verified}/` · 우리: `src/runner/batch/eval/`.
>
> **핵심 프레이밍**: 이 채점 방법론들이 곧 "좋은 오라클의 정의"다. base-control / change-coverage / regression-veto / 곱셈-게이트 4규율이 "테스트가 진짜 버그를 잡는가 + over-narrow 아닌가"를 판정한다. 우리 준비도는 이 4규율 대비로 잰다.

---

## 0. 두 하네스가 정의하는 "좋은 test"의 SSOT (한눈에)

| 축 | SWT-bench | TDD-Bench Verified |
|---|---|---|
| 채점 SSOT | `grading.py:get_resolution_success` (:205-222) | `run_evaluation.py:713-740` (fail_before·pass_after·cov_score) |
| 성공 정의 | base 대비 **추가 F→P ≥1 + 회귀 0** | `cov_score × fail_before × pass_after > 0` |
| flaky 상쇄 | **6-container base-subtraction** (pred/gold/base × pre/post) | before/after 2-tree (base=fail_before로 흡수) |
| coverage adequacy | ΔC (진단·부분점수, resolved에는 미포함) | **cov_score 곱셈 게이트(resolved 필수)** |
| over-narrow 차단 | 회귀 veto만 | **cov_score 곱셈** (통과해도 변경라인 미커버면 0) |
| 실행 단위 | 변경 test **파일 전체** | 기여(contributing) test **nodeid만** |
| diff format | AST custom-diff(48.6→89.5% well-formed) | 표준 unified(파일 patch) |

---

## 1. 채점/오라클 방법론 전부 펼치기 (코드 `file:line`)

### (a) fail-to-pass 정의

**SWT-bench** — per-test 판정 `grading.py:36-43`:
```python
def test_passed(case, sm):  return case in sm and sm[case] == "PASSED"
def test_failed(case, sm):  return case not in sm or sm[case] in ("FAILED","ERROR")
```
pre→post transition을 3×3 분류(`get_eval_report`, `grading.py:142-181`)로 집계. `FAIL_TO_PASS = x2p + f2p` (`:175`) — **pre에 없던 테스트(None)가 post에서 PASS**도 F→P로 침(새 통과 테스트 포착).

성공 술어 `get_resolution_success` (`grading.py:205-222`) [verified]:
```python
added_p2f     = pred_f2p.issuperset(base_f2p) and len(pred_f2p - base_f2p) > 0   # :219
not_added_x2f = len(pred_p2f - base_p2f) == 0 and (len(pred_f2f - base_f2f) == 0) # :220
return added_p2f and not_added_x2f, len(pred_f2p - base_f2p)                      # :222
```
= "base 대비 새 F→P를 최소 1개 만들고(A) + base에 없던 회귀 0(B)".

**TDD-Bench** — `run_evaluation.py:713-729` [verified]:
```python
fail_before = 1  if 예측 테스트가 c_old(코드 미적용)에서 SKIP 제외 하나라도 FAILED/ERROR   # :713-719
pass_after  = 1  if 예측 테스트가 c_new(코드 적용)에서 전부 PASSED, FAILED/ERROR 없으면      # :721-729
```
= TDD "test-first" 계약: 수정 前 실패 ∧ 수정 後 통과.

### (b) base-subtraction (6-container flaky 상쇄)

**SWT-bench** — `run_evaluation.py:178-180` [verified]:
```python
patch_ids    = ["pred_pre","pred_post","gold_pre","gold_post","base_pre","base_post"]  # :178
test_patches = [model, model, gold_test, gold_test, None, None]                         # :179
code_patches = [None, gold_code, None, gold_code, None, gold_code]                      # :180
```
(pred/gold/base) × (pre=code 미적용 / post=`golden_code_patch` 적용) = **6번 컨테이너 실행**. `get_resolution_success`가 `pred` transition에서 `base` transition을 **빼서**(`pred_f2p - base_f2p`, `pred_p2f - base_p2f`), 코드와 무관하게 원래 flaky/always-pass인 테스트 노이즈를 상쇄. gold/base는 model-독립 → **캐시 가능**(`caching_log_dir`, `run_evaluation.py:177`).

**TDD-Bench**는 3-tree(initial/before/after)로 압축: base flaky를 `fail_before`(before-phase 실행)로 흡수하되 별도 base-컨트롤 컨테이너는 없음 [inferred].

### (c) change-coverage ΔC (gold 변경 executable 라인을 pred가 커버?)

**SWT-bench** — `grading.py:226-294`, `get_pred_report` (`:361-382`) [verified]:
- `extract_changed_lines_from_patch` (`:226-239`): `golden_code_patch` unidiff에서 removed/added 라인.
- `extract_executable_lines` (`:242-258`): 그 중 **coverage 결과에 실제 등장하는 라인만**(주석/공백 제외).
- ΔC = `get_coverage_delta`(post−pre, base 대비, `:261-272`) → `count_covered_lines`(delta>0 라인 수, `:288-294`) / `n_executable` (`:381`).
- 변형 `report.py:73-81`: `ΔC_all`(:75)·`ΔC_S`(resolved만, :77)·`ΔC_¬S`(:79). gold ΔC로 정규화(100%=gold 천장).
- **주의**: SWT에서 ΔC는 진단/부분점수 — **resolved 판정에는 미포함**.

### (d) ×→F regression veto (fixed 상태 깨는 test reject)

**SWT-bench** — `get_resolution_success`의 조건 B (`grading.py:220`): `pred_p2f - base_p2f == 0 AND pred_f2f - base_f2f == 0`. base 대비 새 P→F(회귀)나 새 F→F가 하나라도 있으면 `resolved=False`. `PASS_TO_FAIL = p2f + p2x` (`:178`) — P→FAIL과 P→None(사라짐) 둘 다 회귀로 침.

**TDD-Bench** — `pass_after`가 곧 no-regression: contributing nodeid 중 FAILED/ERROR 하나라도 있으면 `pass_after=0` (`:727-728`).

### (e) contributing-test-only (TDD nodeid vs SWT 파일 전체)

**TDD-Bench** — `get_contributing_functions` (`run_evaluation.py:177-219`) [verified]: test patch를 `+++ b`로 파일 분할 → `def test` 세그먼트 → **`+`(추가) 라인을 포함한 test 함수만** 등록. `modify_eval` (`:224-278`)이 원본 eval의 `coverage run`/`tox`/`./bin/test` 라인에서 파일 인자를 지우고 `fun2test`(개별 nodeid)로 교체(Django=dotted, sympy=`-k` 분기). → 무관 기존 테스트 노이즈/flake/시간 제거.

**SWT-bench**는 대조적으로 변경된 test **파일 전체**를 test_directive로 실행.

### (f) 곱셈 게이트 (TDD: final = cov × fail_before × pass_after — over-narrow 차단)

**TDD-Bench** — `run_evaluation.py:731-740` [verified]:
```python
cov_score = (total_change - total_miss) / total_change   # :685-688 (branch coverage, constants.py:44 --branch)
if sympy:  final_score = fail_before * pass_after         # :732 (cov 제외)
else:      final_score = cov_score * fail_before * pass_after   # :734
resolved = final_score > 0                                # :737-740
```
**곱셈이 핵심**: `pass_after=1`(통과)이어도 `cov_score`가 낮으면(변경 라인 미커버 = over-narrow/가짜-green) 점수가 깎이고, `fail_before=0`(원래 안 깨짐 = vacuous)이면 0. binary resolved보다 연속·엄격.

### (g) function/class-level diff format (well-formed 48.6→89.5%)

**SWT-bench** — `auxillary_src/extract_patches.py` [verified, swt readme §4]: 라인 기반 unified diff는 LLM이 라인번호 오류로 well-formed 48.6%. custom-diff(rewrite/insert)는 `apply_custom_patches` (`:313-380`)가 **라인번호 무시하고 AST로 적용**(`ReplaceFunctionTransformer` `:294-310`, 이름 같은 함수/클래스 통째 교체) → 89.5%. 최종은 `git diff`로 표준 unified diff 재산출.

---

## 2. 우리 준비도 매핑 (`src/`)

| 방법론 | 코드 근거(원본) | 우리 코드 위치 | 상태 |
|---|---|---|---|
| **(a) fail-to-pass 최종 채점** | `grading.py:205-222` | 최종 resolved는 **공식 SWE-bench 하네스에 위임**(원격 grade). `apps/bench/commands/grade.ts:39,268-290`(swebench/live 하네스 fork), `runner/batch/eval/verdict.ts:120-125`(로컬 `testCmd` 폴백, `passed=r.resolved`) | **있음(위임)** — 우리 자체 F→P transition 채점기는 없음. official harness가 SSOT |
| **(a′) repro fail-to-pass 오라클(내부)** | TDD `fail_before∧pass_after` `:713-729` | `mwe-proof.ts:1-24`(base_red→patched_green 승격 사다리), `regression-oracle.ts:141-147`(patched pass), acceptance `reproResolvedOnSandbox` (`acceptance-selector.ts:47-48`) | **있음** — 단 **candidate SELECTION용**(스코어 아님) |
| **(b) base-subtraction (flaky 상쇄)** | `run_evaluation.py:178-180` (6-tree) | `gold-sanity.ts:36-58`(base+gold **2-tree** sanity), `verdict.ts:134-138`(빈패치 base-run fail-closed). **pred/gold/base×pre/post 6-tree 없음** | **부분** — base+gold 2-tree만(어딧 SSOT: "execution-free 아님"); pred-vs-base transition subtraction 미구현 |
| **(c) change-coverage ΔC 게이트** | `grading.py:226-294`, TDD `cov_score` `:685-688` | **없음.** `coverage` 매치는 전부 family/co-edit(`family-coverage-coedit.ts`)·owner-coverage(어느 파일/어느 테스트) — **executable-line coverage 아님**. `trace.py`/`--cov`/`cov_score` grep 0 | **없음** |
| **(d) ×→F regression veto** | `grading.py:220` | `regression-oracle.ts:141-147`(`toRegressionGreen`), `selection-gates.ts:74,326`(`regressionGreen===true` hard gate), `regressionFailureCount` (`acceptance-selector.ts:34-38`, `!ran⇒+Inf`) | **있음(file:line)** — fail-OPEN(missing run은 reject 안 함) |
| **(e) contributing-test-only** | `run_evaluation.py:177-219` | `impacted-test-discovery.ts`, `regression-oracle-adapter.ts`(PASS_TO_PASS를 eval-only에서 주입) → 우리는 **impacted-set** 실행. TDD식 "예측 patch가 추가한 nodeid만" 격리 실행은 **부분** | **부분** — impacted-test 있음, "예측-기여 test만" 정밀 격리는 미구현 |
| **(f) 곱셈 게이트(over-narrow 차단)** | `run_evaluation.py:731-740` | **vacuous-guard**: `repro-oracle-calibration.ts:107-153`(`baseResolved⇒vacuous`, base에서 이미 resolved면 무의미 green). **곱셈(cov×fail×pass) 없음** — cov 항이 아예 없어서 over-narrow를 수치로 못 잼 | **부분** — vacuous(fail_before 유사)는 **있음**, coverage 곱셈은 **없음** |
| **(g) function-level diff format** | `extract_patches.py:294-380` | `tool/apply-patch-structured-tool.ts:1-50`(V4A 구조 patch, per-file 부분성공), `patch/structured.ts`(`applyPatchStructured`) | **있음(file:line)** — default-OFF(ADR-0464), AST-이름매칭이 아닌 V4A 컨텍스트 방식 |

### 보조 매핑 (오라클 규율 관련)
- **non-vacuity(=TDD fail_before 계약)**: `repro-oracle-calibration.ts:95-108,151-153` — base(un-patched) tree에서 probe가 RESOLVED면 `vacuous`. TDD의 `fail_before=0` 차단과 동형. **있음** [verified].
- **false-negative 오라클 보정(base-control 정신)**: `repro-oracle-calibration.ts:142-147` — gold-patched tree에서 probe가 resolved 못 하면 `falseNegative` → 그 오라클 fail-open. SWT의 base-subtraction과 목적(노이즈 오라클 상쇄) 유사하나 **transition 빼기가 아니라 gold-보정**. **있음(다른 형태)**.
- **spec-fidelity veto(over-narrow의 다른 축)**: `declared-expected-matcher.ts:1-45` + `selection-gates.ts:242-248` — 후보가 issue 선언 리터럴과 모순되면 hard veto(astropy-13033 shape). coverage 곱셈과는 다른, 공개-스펙 기반 execution-free veto. **있음**.

---

## 3. 핵심 판정 — 우리 오라클의 갭

우리 오라클(acceptance/closure/repro selection)을 4규율로 재면:

1. **base-control (b)** — **부분.** gold-sanity 2-tree(base+gold)와 vacuous-guard(base에서 resolved면 무효)는 있으나, SWT의 pred/gold/base×pre/post **6-container transition subtraction은 없다**. 우리는 flaky를 "gold가 base에서 안 깨지나"(non-vacuity)로 흡수할 뿐, "pred가 base 대비 *추가로* 만든 F→P만 크레딧"이라는 정밀 차감은 official harness에 위임한다. → flaky/always-pass 테스트가 우리 내부 selection 오라클에서 노이즈로 남을 수 있음.

2. **change-coverage (c)** — **없음(제로).** 우리 selection 어디에도 "fix가 바꾼 실행-라인을 이 테스트가 커버하나"의 line-execution ΔC가 없다. 우리 "coverage"는 전부 파일/소유자 단위(어느 파일·어느 테스트가 소유). → **가장 큰 갭.**

3. **regression-veto (d)** — **있음.** `regression-oracle` + `selection-gates` hard gate로 fixed 깨는 후보 reject. fail-OPEN 설계라 "미실행"은 통과시킴(false-RED 회피 우선). 규율 충족.

4. **곱셈 게이트/vacuous (f)** — **절반.** vacuous-guard(fail_before 유사)는 있어 "원래 안 깨지는 테스트로 가짜 green" 차단은 된다. 하지만 TDD의 **cov_score 곱셈이 없어 over-narrow(통과하지만 변경 라인 미커버)를 수치로 못 잡는다** — 이건 우리가 반복해서 데인 false-green(MEMORY: jun-28-closure-repair-false-green-root, 약한 predicate에 over-narrow 패치가 가짜 통과) 문제의 **정확한 미봉 지점**.

**결론**: 우리 오라클은 4규율 중 **regression-veto(완비)·vacuous(절반)** 는 갖췄고, **change-coverage(전무)·base-subtraction(부분)** 이 갭이다. 특히 (c)+(f)의 조합 = "곱셈 change-coverage 게이트"가 over-narrow/false-green을 수치로 차단하는 유일한 규율인데 우리에겐 line-execution coverage 항 자체가 없다. 이게 우리 selection 오라클이 "맞는 파일 짚고 틀린/좁은 edit"(synthesis 수렴 병목, MEMORY: jun-29)을 스코어로 못 거르는 근본 이유. 단, 최종 leaderboard 채점은 official harness가 4규율(특히 a/b/d)을 대행하므로 **내부 selection 신호의 갭**이지 최종 채점의 갭은 아님 — 즉 갭의 성격은 "후보를 잘못 고른다"이지 "가짜로 resolved 판정"이 아니다.

---

## 요약 (10줄)

1. 2026-06 repro 채점의 SSOT: SWT=`get_resolution_success`(base 대비 F→P 추가+회귀0, `grading.py:205-222`), TDD=`cov×fail_before×pass_after`(`run_evaluation.py:713-740`).
2. SWT의 base-subtraction=**6-container**(pred/gold/base×pre/post, `run_evaluation.py:178-180`)로 flaky를 pred−base 차감으로 상쇄; gold/base는 캐시 가능.
3. TDD의 4대 규율: contributing-test-only(nodeid만, `:177-219`)·fail_before(수정前 실패)·pass_after(수정後 통과)·cov_score 곱셈(over-narrow 수치 차단).
4. change-coverage ΔC(SWT `grading.py:226-294`)=gold 변경 executable 라인을 pred가 base 대비 새로 실행시키는 비율; SWT는 진단용, TDD는 곱셈으로 resolved에 강제.
5. 우리 fail-to-pass 최종 채점은 **공식 harness 위임**(`grade.ts`), 자체 transition 채점기 없음 — 그래서 (a)(b)(d)는 leaderboard에선 harness가 대행.
6. 우리 regression-veto=**완비**(`regression-oracle.ts:141-147` + `selection-gates.ts:74,326`, fail-open).
7. 우리 vacuous-guard=**있음**(`repro-oracle-calibration.ts:107-153`, base-resolved⇒무효), TDD fail_before 계약과 동형(=곱셈 게이트의 절반).
8. 우리 function-level diff=**있음**(`apply-patch-structured-tool.ts`, V4A, default-OFF); SWT AST-이름매칭과는 방식 차이.
9. **최대 갭 2개: change-coverage(전무 — line-execution coverage 항 자체가 없음)·base-subtraction 6-tree(부분, gold-sanity 2-tree만).** 우리 "coverage"는 전부 파일/소유자 단위.
10. 핵심 판정: over-narrow/false-green을 수치로 거르는 유일 규율이 "곱셈 change-coverage"인데 우리 selection 오라클엔 cov 항이 없다 → synthesis 수렴 병목(맞는 파일·틀린 edit)을 스코어로 못 걸러냄. 이는 **내부 selection 신호의 갭**(잘못 고름)이지 최종 채점 갭(가짜 resolved)은 아님.
