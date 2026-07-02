# SWT-bench 평가 하네스 코드 분석 — 측정 레일 부착 청사진

> 소스: `/Users/songmin/quanta-codeagent-v3/.extracted_source/repro-scaffolds/swt-bench/` (logic-star-ai/SWT-bench, NeurIPS 2024)
> 목적: SWT-bench를 **내부 측정 레일**로 부착하여, full SWE-bench 패치-생성 박스런 없이 repro/test-gen 품질을 채점한다.
> 모든 주장은 file:line 인용으로 뒷받침. 태그: [verified]=소스에서 직접 확인, [inferred]=코드 정황상 추론.

---

## 0. 한눈에 보는 채점 파이프라인 [verified]

한 instance를 채점하려면 **6번의 컨테이너 실행**이 필요하다 (`run_instance`, `src/run_evaluation.py:176-193`):

```
patch_ids   = ["pred_pre", "pred_post", "gold_pre", "gold_post", "base_pre", "base_post"]   # :178
test_patches= [model,       model,       gold_test,   gold_test,   None,       None]          # :179
code_patches= [None,        gold_code,    None,        gold_code,   None,       gold_code]     # :180
```

즉 각 (pred / gold / base) × (pre = code 미적용 / post = golden_code_patch 적용) 의 2×3 매트릭스를 돌린다.
- `pred` = 모델이 만든 테스트 패치(우리가 채점하려는 대상)
- `gold` = SWT-bench 정답 reference 테스트
- `base` = 테스트 패치 없음(코드만) — **transition을 빼기 위한 컨트롤**

각 실행은 `eval_script_list` (`src/exec_spec.py:227-283`)로: `golden_code_patch`(있으면) + test_patch를 `git apply` → test_command 실행 → 로그를 파싱. 채점은 `report_results` (`src/grading.py:396-448`)가 `pred_pre vs pred_post`와 `base_pre vs base_post`의 transition을 비교해서 한다.

핵심 통찰: SWT-bench의 "성공"은 **두 번의 transition을 비교**한다. pred가 base보다 *추가로* F→P를 만들어내야 한다.

---

## 1. Success / Fail-to-Pass 정의 [verified]

### 1.1 per-test PASS/FAIL 판정
`test_passed`/`test_failed` (`src/grading.py:36-43`):
```python
def test_passed(case, sm):  return case in sm and sm[case] == "PASSED"
def test_failed(case, sm):  return case not in sm or sm[case] in ("FAILED","ERROR")
```

### 1.2 pre→post transition 계산 — `get_eval_report` (`src/grading.py:142-181`)
pre/post 두 status-map을 받아 3×3 분류표(`results_dict`, `:155-158`)로 모든 테스트를 (pre∈{PASSED,FAILED,None}) × (post∈{PASSED,FAILED,None})에 배정. `None` = 로그에 그 테스트가 안 나타남(syntax/name error로 수집 안 됨 등). 최종 집계(`:174-180`):
```python
FAIL_TO_PASS = x2p + f2p        # (X→P) ∪ (F→P)  ← None→PASS 도 F→P로 친다
PASS_TO_PASS = p2p
FAIL_TO_FAIL = f2f + x2f
PASS_TO_FAIL = p2f + p2x        # P→FAIL 과 P→None(사라짐) 둘 다 회귀로 침
UNMATCHED    = f2x + x2x
```
**주의**: `FAIL_TO_PASS`는 (pre에 없던 테스트가 post에서 PASS)도 포함한다 — 새로 추가된 통과 테스트를 잡기 위함.

### 1.3 resolution predicate — `get_resolution_success` (`src/grading.py:205-222`)
이게 **성공의 SSOT 술어**다. pred report와 base report를 비교:
```python
added_p2f     = pred_f2p.issuperset(base_f2p) and len(pred_f2p - base_f2p) > 0
not_added_x2f = len(pred_p2f - base_p2f) == 0 and len(pred_f2f - base_f2f) == 0
return added_p2f and not_added_x2f, len(pred_f2p - base_f2p)
```
풀어 쓰면 (질문서의 가설과 정확히 일치) [verified]:
- **조건 A (≥1 F→P 추가)**: pred의 F→P 집합이 base의 F→P를 **모두 포함하면서**(superset) **추가로 ≥1개**의 새 F→P를 만든다. → "골든 코드를 적용했더니 실패하던(또는 없던) 테스트가 통과로 바뀐 케이스가 적어도 하나 새로 생겼다".
- **조건 B (회귀 0)**: pred가 base 대비 새로운 P→F(`pred_p2f - base_p2f`)도, 새로운 F→F(`pred_f2f - base_f2f`)도 만들지 않는다. → "고정된 상태에서 ×→F가 0".
- `resolved = A and B`. 두 번째 리턴값 `added_f2p` = 새로 추가된 F→P 개수.

여기서 base와 비교하는 이유: base는 "테스트 패치 없이 코드만" 돌린 것이므로, 코드와 무관하게 원래 flaky하거나 항상 P→P인 테스트의 noise를 빼준다. pred가 만든 transition 중 **base에 없던 것만** 크레딧/페널티로 센다.

### 1.4 보조 지표 (`figures/util.py`)
- `no_error_filter` (`util.py:132-142`): post 테스트 수가 base의 10% 미만이면 syntax/name error로 간주 → **Applicability(W)**. 패치가 스위트 자체를 깨뜨렸는지의 프록시.
- `actual_ftp_count` (`util.py:174-175`): superset 요구 없이 "새 F→P 하나라도 있나"(`bool(pred_f2p - base_f2p)`) → **F→P** 메트릭. resolved보다 느슨.
- `ftx_count` (`util.py:195-196`): 새 F→P **또는** 새 F→F → **F→X** (실행은 됐는데 결론 안 났을 수도).
- 즉 report.py가 출력하는 컬럼: W(applied) / S(resolved=success) / F→X / F→P / P→P. (`src/report.py:53-57`)

> [inferred] resolved(S)가 논문의 핵심 "Success Rate". `actual_ftp`/`ftx`는 진단용 부분점수.

---

## 2. Coverage 메트릭 (ΔC) [verified]

### 2.1 coverage 수집
실행 시 `trace.py`(CPython trace 모듈 개작, `src/auxillary_src/trace.py:1-25`)를 `--count -C coverage.cover --include-pattern '/testbed/(<changed files>)'`로 감싸서(`src/exec_spec.py:72-109`, `test_command` 프로퍼티) golden code patch가 건드린 파일만 라인별 hit-count를 JSON으로 dump. `get_coverage_eval` (`src/grading.py:106-139`)이 `+ cat coverage.cover` 이후의 `{"/testbed/...": {line: count}}` 라인을 파싱해 `{file: {line_no: hits}}`로 모은다.

### 2.2 어떤 라인을 세나 — golden patch의 "executable changed lines"
`extract_changed_lines_from_patch` (`src/grading.py:226-239`): golden_code_patch의 unidiff에서 (removed_lines = source 측, added_lines = target 측) 추출. `extract_executable_lines` (`:242-258`): 그 중 **coverage 결과에 실제로 등장하는 라인만** 남김(= 실행 가능한 라인. 주석/공백 제외). removed는 `golden_pre+base_pre` coverage 기준, added는 `golden_post+base_post` 기준 (`src/grading.py:348-349`).

### 2.3 ΔC 계산 — `get_pred_report` (`src/grading.py:361-382`)
```python
n_executable = len(executable_removed) + len(executable_added)
# 절대 coverage (참고용)
coverage_pred = count_covered_lines(...pred...) / n_executable          # :377
# Δ coverage = post - pre, base 대비
coverage_delta_pred = n_coverage_delta_pred / n_executable             # :381
coverage_delta_gold = n_coverage_delta_gold / n_executable             # :382
```
`get_coverage_delta` (`:261-272`): 각 라인에 대해 `post_coverage - pre_coverage`. 여기서 pre=base, post=pred (`:368` `get_coverage_delta(executable_lines, coverage_base, coverage_pred)`). `count_covered_lines` (`:288-294`): delta가 **>0 인 라인 개수**를 센다(증가했으면 1). 즉 ΔC = (base 대비 pred가 새로 커버한, golden이 바꾼 실행가능 라인 수) / (golden이 바꾼 실행가능 라인 총수).

### 2.4 ΔC_all / ΔC_S / ΔC_¬S 변형 — `src/report.py:73-81`
```python
total_coverage_possible = count_coverage_delta_gold(gold_reports)              # 분모: gold가 커버 가능한 케이스 수
total_coverage_delta = 100 * sum_coverage_delta(reports) / total_coverage_possible          # ΔC_all (:75)
resolved, unresolved = filtered_by_resolved(reports)
resolved_coverage_delta   = 100 * sum_coverage_delta(resolved)   / count_coverage_delta_gold(resolved)    # ΔC_S (:77)
unresolved_coverage_delta = 100 * sum_coverage_delta(unresolved) / (total_possible - countable_resolved)  # ΔC_¬S (:79)
```
- **ΔC_all** = 전체 instance에 걸친 평균 coverage delta (gold가 잴 수 있는 케이스로 정규화).
- **ΔC_S** = `resolved=True`인 instance만. "성공한 케이스의 coverage 기여".
- **ΔC_¬S** = `resolved=False`인 instance만. "실패했지만 일부 커버는 한" 양.
- `sum_coverage_delta` (`util.py:227-233`)는 `coverage_delta_pred` 합, `count_coverage_delta_gold` (`util.py:235-239`)는 `coverage_delta_gold is not None`인 케이스 수 = gold가 측정가능한 모수. [verified]

> 한줄 요약: ΔC는 "golden fix가 건드린 실행가능 라인 중, 모델 테스트가 (base 대비) 새로 실행시키는 비율". gold 자신의 ΔC로 정규화해서 100%가 gold 천장.

---

## 3. Unit-test 모드 vs Reproduction-script 모드 [verified]

`ExecMode = Literal["unit_test", "reproduction_script"]` (`src/exec_spec.py:28`). 모드 분기는 **세 곳**:

### 3.1 test_command 분기 — `src/exec_spec.py:78-109`
```python
if self.exec_mode == "reproduction_script":
    reproduction_script_path = f"/testbed/{self.reproduction_script_name}"
    test_command = f"python3 {reproduction_script_path}"        # :81 standalone 실행
    ... (coverage면 trace로 감쌈)
# else: 테스트 프레임워크 + test_directives 로 스위트 실행 (:88-93)
```
- **unit_test**: `MAP_REPO_TO_TEST_FRAMEWORK[repo][version]` + `test_directives`(모델/gold 패치가 건드린 테스트 파일에서 도출, `get_test_directives`)로 기존 스위트에 통합 실행.
- **reproduction_script**: `/testbed/<script>`를 단독 `python3` 실행.

### 3.2 exit-code 캡처 — `src/exec_spec.py:272-275`
```python
if self.exec_mode == "reproduction_script":
    exit_mode_command = ["echo $?"]    # 스크립트 종료코드를 로그에 찍음
else:
    exit_mode_command = []
```

### 3.3 로그 파서 선택 — `src/grading.py:66`
```python
log_parser = MAP_REPO_TO_PARSER[repo] if exec_mode != "reproduction_script" else parse_log_reproduction_script
```
`parse_log_reproduction_script` (`src/log_parsers.py:208-217`): 로그에서 `^\+ echo (\d+)$` 정규식으로 첫 exit code를 잡아 `{"reproduction_script": "PASSED" if "0" else "FAILED"}` 단일 케이스 반환. 즉 **exit 0 = pass, ≠0 = fail**. 이 단일 케이스가 §1의 transition 머신을 그대로 탄다(pred_post에서 PASS, pred_pre/base에서 FAIL이면 F→P 성립).

> CLI 플래그: `--exec_mode {unit_test,reproduction_script}` + `--reproduction_script_name` (`src/main.py:131-136`). README:77이 "exit 0=pass,1=fail, 스위트 미실행"을 확인.

---

## 4. 함수/클래스 단위 diff 포맷 (custom-diff) [verified]

라인 기반 unified diff는 LLM이 라인번호를 자주 틀려 well-formedness가 낮다(논문: 48.6%). SWT-bench는 **AST 기반 replace/insert** 포맷을 도입(89.5%). 포맷 정의는 prompt에 박혀있다 (`dataset/swt_bench.py:10-89`, `PLUS_PROMPT`):

```
```custom-diff
diff
<path/filename>
< "rewrite" or "insert" >
< rough line number / EOF / BOF >
< 추가/재작성할 함수 본문 >
end diff
```
```

### 4.1 추출 — `extract_custom_patches` (`src/auxillary_src/extract_patches.py:158-180`)
`diff` 줄을 찾고 다음 3줄을 (file_name, patch_type, rough_line_number)로, `end diff`까지를 `changed_lines`로 파싱 → `CustomPatch` (`:41-46`).

### 4.2 적용 — `apply_custom_patches` (`src/auxillary_src/extract_patches.py:313-380`)
**라인번호를 무시하고 AST로 적용**한다:
- 파일과 패치 본문을 각각 `ast.parse` (`:348`, `:357`). 패치가 syntax error면 실패 반환(`:358-360`).
- `patch_type == "rewrite"` (`:361`): 패치의 첫 노드가 `FunctionDef`/`ClassDef`여야 함(`:363`). `ReplaceFunctionTransformer` (`:294-310`)가 **이름이 같은** 함수/클래스를 통째로 교체. 매칭 없으면 `any_change_applied=False`로 실패(`:368`).
- `patch_type == "insert"` (`:371`): `file_ast.body.extend(patch_ast.body)` — 파일 끝에 노드 추가(EOF). 새 파일이면 빈 파일에 추가.
- 마지막에 `ast.unparse(file_ast)`로 다시 써냄(`:376`) → 그래서 라인번호 부정확이 무력화됨.

### 4.3 다른 두 포맷
`run` (`:414-434`)이 `--patch_type` 순서대로 시도(첫 성공에서 멈춤):
- `vanilla` (`:428`): `extract_minimal_patch`(`:183-211`)로 hunk 헤더 재계산 후 `git apply`. 표준 unified diff 경로.
- `fuzzy` (`:422`): `extract_fuzzy_patch`(`:92-155`) + `apply_fuzzy_patches`(`:236-291`). editdistance 기반 `overlap_score`(`:383-390`)로 preceding/following 컨텍스트가 가장 잘 맞는 위치를 찾아 라인번호 없이 적용.
- `custom` (`:425`): 위 §4.2 AST 경로.

적용 후 `write_diff_and_reset` (`:393-400`)이 `git add -A; git diff <ref>`로 **정규화된 unified diff**를 산출하고 base로 리셋. 즉 어떤 입력 포맷이든 최종적으로 표준 diff(`extracted_patch.diff`)로 변환되어 `eval_script`가 `git apply`한다. 추출은 별도 컨테이너에서 실행(`extract_model_patch`, `src/run_evaluation.py:54-99`, `editdistance`/`git` 필요 → `requirements_extraction.txt`).

> CLI 기본값 `--patch_types vanilla` (`src/main.py:100`). vanilla 단독이면 컨테이너 추출 없이 `remove_binary_diffs`만 적용(`src/run_evaluation.py:171-174`).

---

## 5. Dataset 정의 [verified]

### 5.1 instance 필드 — `SWEbenchInstance` (`src/constants.py:13-27`)
표준 SWE-bench 필드(`repo, instance_id, base_commit, patch, test_patch, problem_statement, version, environment_setup_commit, FAIL_TO_PASS, PASS_TO_PASS`)에 더해 **SWT 전용 2필드**:
- `golden_test_patch` (`:23`) = reference 테스트 패치 (gold가 만드는 정답 테스트)
- `golden_code_patch` (`:24`) = issue를 고치는 실제 코드 패치 (post 상태를 만들 때 쓰는 fix)

### 5.2 SWE→SWT 변환 — `src/dataset.py:125-133`
```python
def swe_to_swt_instance(d):   # 표준 SWE-bench를 SWT로
    d["golden_test_patch"] = d.pop("test_patch")   # SWE의 test_patch = SWT의 golden test
    d["golden_code_patch"] = d.pop("patch")        # SWE의 patch = SWT의 golden code fix
def swt_to_swt_instance(d):   # 이미 SWT 포맷(model 예측이 <patch>로 감싸진 경우)
    d["golden_code_patch"] = d.pop("patch")[len("<patch>\n"):-len("\n</patch>")]
    d["golden_test_patch"] = d.pop("test_patch")
```
`is_swt` 플래그(`src/main.py:91-93`)로 어느 변환을 쓸지 선택. **핵심**: SWT-bench의 채점에서 "정답 코드 패치"는 SWE-bench의 `patch`(gold fix)를 그대로 쓴다 — 우리는 이 fix를 알고 있어야 post 상태를 만들 수 있다.

### 5.3 Verified-433 split — `src/dataset.py:135-174` + `figures/util.py:35-37`
```python
total_cases_verified = 500 - len(_filter_cases("verified"))   # = 500 - 67 = 433  [verified: 파일 unique 67줄]
```
`filter_cases_verified.txt`(`dataset/filter_cases_verified.txt`, 67 unique ids)는 **제외 목록**이다. `load_swebench_dataset(filter_swt=True)` (`:171-172`)이 `i["instance_id"] not in instance_filter`로 거른다. 즉 SWE-bench_Verified 500개에서 67개(SWT-bench로 부적합 — gold test가 비정상/측정불가)를 빼서 **433**. lite는 300-23=277, full은 2294-(full filter).

### 5.4 로더 — `load_swebench_dataset` (`src/dataset.py:135-174`)
HF 데이터셋 이름 별칭 매핑(`:148-163`), 또는 로컬 `.json/.jsonl`(`:141-145`), 또는 `load_from_disk`(`:166-167`). gold predictions는 `golden_test_patch`를 model_patch로 써서 sanity-check 가능(`get_gold_predictions`, `:32-43`).

---

## 6. 우리 하네스에 부착하는 법 (concrete) [inferred + verified]

### 6.1 최소 채점 코어 (Docker 없이도 동작하는 순수 함수)
**순수 파이썬, 컨테이너 불필요**한 부분 — 우리 측정 레일에서 직접 재사용 가능:
- `src/log_parsers.py` 전체 (status-map 파서, 의존성 없음). [verified: stdlib re/enum만]
- `src/grading.py`의 `get_eval_report` / `get_resolution_success` / `get_pred_report` / coverage 함수들. 의존성: `unidiff`(PatchSet, `:5`), 그 외 stdlib.
- `src/constants.py`의 transition 상수 + `MAP_REPO_TO_PARSER`.

이 코어의 입력은 **6개 test_output 로그 텍스트**(pred_pre/post, gold_pre/post, base_pre/post)뿐이다. 즉 우리가 6개 컨테이너 실행을 우리 인프라로 대체해 로그만 만들어주면, 채점은 위 함수로 끝난다.

### 6.2 실행 레일 — 우리 arm64 recipe와의 매핑
SWT-bench의 `eval_script_list` (`src/exec_spec.py:227-283`)가 하는 일: `golden_code_patch`(post면) + test_patch를 `git apply` → test_command 실행 → 로그 캡처. 우리가 이미 가진 **prebuilt swebench namespace + max_workers=1 + local dataset** 레시피로 이걸 대체하려면:
- 컨테이너 안에서 `git apply <code_patch?> <test_patch>` → 레포별 test 커맨드 실행 → stdout을 SWT 파서가 먹을 형식으로 저장.
- coverage가 필요하면 `trace.py`를 컨테이너에 복사하고 test 커맨드를 trace로 감싸야 함(`src/run_evaluation.py:110-111`). coverage 불필요하면 생략 가능(`compute_coverage=False`, resolved만 채점, `src/grading.py:74` 분기가 trace 없을 때 graceful).

### 6.3 표준 SWE-bench eval과의 차이
| 항목 | 표준 SWE-bench | SWT-bench |
|---|---|---|
| 적용 대상 | model이 만든 **code patch** | model이 만든 **test patch** |
| post 상태 | model patch 적용 | **golden_code_patch** 적용(우리가 정답 fix 보유) |
| 성공 | gold F2P/P2P 통과 | base 대비 **추가 F→P 생성 + 회귀 0** (`get_resolution_success`) |
| 실행 횟수 | 1 (model patch) | **6** (pred/gold/base × pre/post) |
| 부가 메트릭 | resolved only | ΔC coverage, W applicability, F→X |

### 6.4 arm64 / local-dataset / max_workers=1 어댑팅
- **arch**: `make_exec_spec` (`src/exec_spec.py:393-397`)가 `platform.machine() in {aarch64,arm64}`면 arm64 기본, 단 `USE_X86`(`src/constants.py:1042+`, **496개** instance) 목록은 강제 x86_64. → arm64 박스에서 이 496개는 emulation 필요. 우리 verified-433 부분집합에 몇 개 겹치는지 교집합 확인 필요(대부분 django).
- **local dataset**: `load_swebench_dataset`가 `.json/.jsonl`/`load_from_disk` 다 지원(`src/dataset.py:141-167`) → 우리 로컬 dataset 그대로 먹임. 단 instance에 `golden_test_patch`/`golden_code_patch`가 있어야 함(없으면 `swe_to_swt_instance`로 `test_patch`/`patch`에서 파생).
- **max_workers=1**: `run_instances` (`src/run_evaluation.py:290`)가 `ThreadPoolExecutor(max_workers)`. =1로 직렬화 가능(우리 SWE-bench 동시채점 false-neg 회피 정책과 일치).

---

## 7. Honesty flags — 부착을 어렵게 만드는 것들

1. **[verified] 채점에 golden_code_patch가 필수.** post 상태는 정답 fix를 적용해서 만든다. 우리가 test-gen만 평가하더라도 그 instance의 **정답 코드 패치를 알아야** 한다(SWE-bench Verified는 가지고 있으니 OK, 하지만 novel instance엔 불가).

2. **[verified] 6× 실행 비용.** instance당 컨테이너 6번. gold_pre/post/base는 model과 무관하므로 **캐시 가능**(`caching_log_dir=[F,F,T,T,T,T]`, `src/run_evaluation.py:177`, gold/base는 test_directive 해시 경로로 재사용). 한 번 gold/base를 만들어두면 이후 model 채점은 pred_pre/post 2번만. → 측정 레일에서 gold/base 캐시를 미리 빌드해두는 게 핵심 최적화.

3. **[verified] SWT-bench는 prebuilt `swebench/` 네임스페이스 이미지를 안 쓴다.** `src/docker_build.py:106-166`가 `repo_script_list`/`env_script_list`(conda env를 `git clone` + `conda create` + pip로 from-scratch 구축, `src/exec_spec.py:197-361`)로 **자체 이미지를 빌드**한다. 우리 arm64 recipe의 prebuilt 이미지와 **호환 안 됨** — 가장 큰 어댑팅 포인트. 옵션: (a) SWT의 채점 코어(§6.1)만 떼어 우리 prebuilt 이미지+우리 실행 위에 얹기, (b) SWT의 이미지 빌드를 통째로 arm64로 돌리기(느리고 conda 의존성 era-rot 위험, 우리 MEMORY의 repro-env era 문제와 동일).

4. **[verified] x86 하드코딩 496개.** `USE_X86` 목록(`src/constants.py:1042+`)은 arm64에서 빌드 실패하는 것으로 알려진 instance를 x86로 강제 → Apple Silicon에서 emulation(느림) 또는 제외 필요.

5. **[verified] coverage 경로는 trace.py 주입 + 로그 형식 의존.** `get_logs_eval` (`src/grading.py:74-81`)이 `+ python3 ...trace.py --count` 와 `+ cat coverage.cover` 라인 마커로 로그를 split한다 — 우리가 로그를 만들 때 이 sentinel을 그대로 찍어줘야 coverage 파싱이 동작. coverage 불필요하면 resolved만 쓰고 이 경로 통째 생략 권장.

6. **[verified] 패치 추출이 별도 컨테이너.** custom/fuzzy 포맷이면 `extract_model_patch` (`src/run_evaluation.py:54-99`)가 `editdistance`/`git`/`requirements_extraction.txt`를 컨테이너에 깔고 `extract_patches.py`를 실행. vanilla면 호스트에서 `remove_binary_diffs`만(`:171-174`) — **우리는 vanilla(표준 unified diff) 출력을 쓰면 이 컨테이너 왕복을 회피** 가능. custom-diff 포맷의 89.5% well-formedness 이득을 원하면 AST 추출 경로를 호스트 파이썬으로 포팅(컨테이너 불필요, `ast`만 쓰므로 testbed 파일 접근만 있으면 됨, `src/auxillary_src/extract_patches.py:313-380`).

7. **[inferred] log_parser 레포 의존.** `MAP_REPO_TO_PARSER` (`src/log_parsers.py:237-257`)는 레포별 전용 파서(django/sympy/seaborn 등 18종). 우리 dataset의 레포가 이 맵에 없으면 파싱 실패 → 표준 SWE-bench와 같은 레포 커버리지라 verified-433은 OK, 하지만 novel 레포 추가 시 파서 작성 필요. reproduction_script 모드는 파서 무관(exit code만) → **novel 레포엔 reproduction_script 모드가 더 robust**.

---

## 부록: 부착 권장 경로 (TL;DR)

가장 싸고 빠른 부착:
1. **reproduction_script 모드 + 채점 코어만 포팅.** `parse_log_reproduction_script`(exit code) + `get_eval_report` + `get_resolution_success`를 우리 파이썬 측정 레일에 복사(순수함수, Docker 무관).
2. 우리 arm64 prebuilt-image 레시피로 컨테이너 안에서: (pred_pre) 코드 미적용+model script, (pred_post) golden_code_patch 적용+model script, (base_pre/post) script 없이. exit code를 `+ echo $?` 형식으로 로그에 찍기.
3. gold/base 실행은 model-독립이므로 verified-433에 대해 **한 번만 빌드해 캐시**. 이후 model 채점은 pred 2회 + 순수함수 채점.
4. coverage(ΔC)는 phase-2. trace.py 주입 + sentinel 로그가 필요하므로 처음엔 resolved(S)만 측정.

이렇게 하면 full SWE-bench patch-gen 박스런 없이, "우리 repro/test가 base 대비 새 F→P를 만들고 회귀 0인가"를 instance당 pred 2회 실행 + 순수함수로 채점할 수 있다.
