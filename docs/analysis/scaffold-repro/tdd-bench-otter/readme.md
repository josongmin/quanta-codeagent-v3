# TDD-Bench Verified 하네스 분석 + Otter/Otter++ 역공학

분석 대상: `/.extracted_source/repro-scaffolds/tdd-bench-verified/` (IBM, ICML 2025).
목적: (a) TDD-Bench의 채점 코드를 읽어 우리 repro/test-gen 품질 측정 rail로 wiring할 근거 확보, (b) 코드 비공개인 Otter/Otter++의 *출력 아티팩트*만으로 접근법을 역공학.

증거 태그: `[verified]` = 소스에서 직접 확인, `[inferred]` = 코드 정황으로 추론, `[reverse-engineered]` = Otter 출력 JSON 관찰에서만 도출(소스 없음).

---

## 1. TDD-Bench 하네스 — 생성된 테스트를 어떻게 채점하나

### 1.1 데이터셋 포맷과 준비 `[verified]`
- `dataset_preparation.py:3-14`: `princeton-nlp/SWE-bench_Verified` test split을 로드 → `id_list.txt`의 id로 필터 → **`PASS_TO_PASS`, `FAIL_TO_PASS` 컬럼을 drop**(`df.drop(columns=['PASS_TO_PASS','FAIL_TO_PASS'])`) → `TDD_Bench.json`(records orient)로 저장.
  - 즉 SWE-bench의 미리 계산된 F2P/P2P 라벨을 **버린다**. TDD-Bench는 채점 시점에 자체적으로 F2P를 *런타임 재계산*한다(§1.3). 이게 핵심 설계.
- `id_list.txt`: 448줄(마지막 줄 개행 없음 → instance id 449개). `wc -l`=448이지만 `golden_test_patch.json` 449 엔트리와 일치 `[verified]`.
- `golden_test_patch.json` (853KB, 449 엔트리): 각 엔트리 `{"instance_id", "model_patch"}` `[verified]`. `model_patch`는 *테스트 파일* diff(gold test patch). README L51-64에 동일 포맷 명시. 예측 제출 포맷의 reference이자 gold 검증용.
- 예측 제출 포맷: `[{"instance_id", "model_patch"}]` JSON 또는 JSONL. `run_evaluation.py:1088-1098`에서 로드.

### 1.2 "기여(contributing) 테스트만 실행" — SWT-bench와의 결정적 차이 `[verified]`
이게 TDD-Bench의 가장 중요한 채점 결정이다. **전체 테스트 파일을 돌리지 않고, 예측 patch가 추가/수정한 테스트 함수만 골라 실행**한다.

- `run_evaluation.py:177-219` `get_contributing_functions(test_patch)`: test patch를 `+++ b`로 파일별 분할 → 각 파일에서 `def test`로 시작하는 세그먼트를 잘라 함수명 추출 → **`+`(추가) 라인을 한 줄이라도 포함한 test 함수만** `list_functions[file]`에 등록. 즉 patch가 실제로 건드린 테스트 함수만 후보가 된다.
- `run_evaluation.py:379-392`: 컨테이너 안에서 각 test 파일을 `cat`으로 읽어 AST/treesitter 파싱(`get_class_functions` L142-149, `get_outer_functions` L152-172) → contributing 함수를 `file::Class::method` 또는 `file::func` 형태의 정확한 pytest nodeid로 변환(`fun2test`).
- `run_evaluation.py:224-278` `modify_eval(...)`: 원본 SWE-bench eval 스크립트의 `coverage run`/`tox`/`./bin/test` 라인을 찾아 **파일 인자를 제거하고 `fun2test`(개별 nodeid)로 교체**. Django(L245)·sympy(L256)는 nodeid 표기법을 각각 dotted-module / `-k` 패턴으로 변환하는 분기 존재.
- 대조: SWT-bench는 변경된 test *파일 전체*를 실행한다(공개 SWT-bench harness가 test directive를 파일 단위로 넘김). TDD-Bench는 nodeid 단위로 좁힌다 → **무관한 기존 테스트의 노이즈/flakiness/실행시간을 제거**하고, "이 예측이 *기여한* 테스트가 실제로 fail→pass 하는가"만 본다.

### 1.3 채점 정의 — fail-to-pass + coverage adequacy `[verified]`
`run_evaluation.py`의 `run_instance(...)`는 **3-phase**로 돈다(코드에 `_initial` / `_before` / 최종 디렉토리로 분기):

1. **initial phase (L318-396)**: gold test_patch를 적용해 contributing 함수의 정확한 nodeid(`fun2test`)를 해석. (gold test patch는 `main()`에서 `dataset[i]['test_patch']`를 *예측 patch*로 덮어씀 — L1142-1143 — 그래서 실제로는 "예측이 추가한 테스트"를 식별.)
2. **before-patch phase (Pointer 1, L399-525)**: 소스 코드 변경(`c_new`의 source patch = `patch_path`, default `gold`) **미적용** 상태(`c_old`)에서 예측 테스트 실행 → `test_result_before`. 동시에 source patch가 바꾼 라인에 대한 coverage(`total_change_before`, `total_miss_before`)를 `calculate_coverage`(L50-138)로 계산.
3. **after-patch phase (Pointer 2, L528-?)**: source patch(`pred["model_patch"]` = 여기선 patches 딕셔너리의 source diff)를 git apply → 다시 예측 테스트 실행 → `test_result` + after coverage.

**최종 스코어 (L713-740)**:
```
fail_before = 1  if  예측 테스트가 c_old에서 (SKIP 제외) 하나라도 FAILED/ERROR 이면, 아니면 0   # L713-719
pass_after  = 1  if  예측 테스트가 c_new에서 전부 PASSED(FAILED/ERROR 없음), 아니면 0          # L721-729
cov_score   = (total_change - total_miss) / total_change                                    # L685-688
final_score = cov_score * fail_before * pass_after        (sympy는 cov 제외, fail*pass만)    # L731-734
resolved    = final_score > 0                                                                # L737-740
```
- **fail-to-pass 정의**: `fail_before=1 AND pass_after=1`. 즉 생성한 테스트가 *수정 전 코드에서 실패하고 수정 후 코드에서 통과*해야 한다. TDD의 "test first" 계약을 그대로 구현 `[verified]`.
- **coverage adequacy**: 단순 통과가 아니라, source patch가 **변경한 라인들**을 그 테스트가 얼마나 커버하는지(`cov_score`)를 곱한다. `calculate_coverage`(L86-138)는 patch hunk의 `+`/`-` 라인(주석/빈줄 제외, L116-119)을 changed line으로 보고, `coverage report --show-missing`(L267, sphinx는 `-m` L268)의 missing line과 대조해 `count_miss` 계산. branch coverage(`coverage run --branch`, `constants.py:44`)를 쓴다.
- 즉 TDD_Score = **F2P 충족 여부 × 변경코드 커버리지 비율**. fail_before 또는 pass_after가 0이면 score 0(곱셈). 이건 SWE-bench의 binary resolved보다 **연속적·엄격**하다 `[verified]`.
- 집계: `make_run_report`(L908-1030)가 instance별 `final_score` 합 / `len(full_dataset)`을 `Final score`로 출력(L998, L1019). resolved 개수도 별도 보고.

### 1.4 grading.py 의 SWE-bench-스타일 함수는 *미사용 경로* `[inferred]`
`grading.py`(get_eval_tests_report, compute_fail_to_pass, get_resolution_status)는 고전 SWE-bench의 F2P/P2P 리스트 기반 채점을 그대로 들고 있으나, TDD-Bench의 실제 스코어 경로(`run_instance`의 L713-740)는 이를 **호출하지 않는다**. `get_logs_eval`(grading.py:34)만 status map 파싱에 재사용된다(L518, L679). 즉 grading.py는 상당 부분 SWE-bench에서 물려받은 dead/legacy 코드. 채점 SSOT는 `run_evaluation.py`의 fail_before/pass_after/cov_score 블록이다.

---

## 2. TDD-Bench vs SWT-bench — 범위·필터 차이, 우리 rail로 뭐가 나은가

### 2.1 인스턴스 필터링 `[verified]`(449) / `[inferred]`(500→449 사유)
- TDD-Bench는 SWE-bench **Verified 500**에서 시작해 `id_list.txt`로 **449**만 keep(`dataset_preparation.py:5-11`) `[verified]`.
- 드롭된 ~51개: 코드상 명시 사유는 없으나 README L3 + 채점 구조상 **(a) source patch가 변경한 라인에 대한 coverage가 0(=`total_change==0` → cov_score 강제 0, L685-686, 곱셈으로 항상 fail) 인 zero-coverage 케이스, (b) fail-to-pass 계약을 gold로도 만족 못 하는(gold 테스트가 c_old에서 안 깨지는) 케이스**를 제거한 것으로 추론된다 `[inferred]`. (논문 arXiv:2412.02883의 필터가 SWT-bench보다 strict하다는 README 서술과 일치.)

### 2.2 채점 범위 차이 (요약)
| 축 | TDD-Bench Verified | SWT-bench |
|---|---|---|
| 실행 단위 | contributing test **nodeid만** (`fun2test`, run_evaluation.py:379-392) `[verified]` | 변경된 test **파일 전체** |
| 스코어 | `cov_score × fail_before × pass_after` (연속) `[verified]` | F2P/P2P 충족(binary 계열) |
| coverage adequacy | **포함** (변경라인 branch coverage, L685-688) `[verified]` | 미포함 |
| 라벨 출처 | 채점 시 **런타임 재계산** (PASS/FAIL drop) `[verified]` | 데이터셋 사전 라벨 |
| 인스턴스 수 | 449 (Verified 500서 strict 필터) `[verified]` | (Verified 기준 500/그 변형) |

### 2.3 우리 내부 rail로 어느 게 나은가 — 추천: TDD-Bench `[inferred]`
- **더 싸다**: 파일 전체가 아니라 nodeid만 돌리므로 per-instance test 실행시간이 짧다(특히 Django/sympy 대형 test 모듈). 우리 repro/grading이 ARM64 박스에서 worker=1로 직렬 채점하는 제약(MEMORY: swebench-arm64-grading-recipe)과 잘 맞는다.
- **신호가 더 풍부**: binary resolved 대신 `cov_score`가 0~1 연속값이라, "테스트가 통과는 하는데 변경코드를 안 건드림"(over-narrow / 가짜 green) 케이스를 *수치로* 잡아낸다. 이건 우리가 반복적으로 데인 false-green(MEMORY: jun-28-closure-repair-false-green-root, over-narrow patch가 약한 predicate로 가짜 통과) 문제에 직접 대응하는 측정축이다.
- **test-gen 품질 전용**: TDD-Bench는 "이슈만 보고 c_new 없이 테스트를 생성"하는 과제(README L3) — 우리 repro-gen/test-gen 라인의 품질을 정조준한다. SWE-bench resolved는 source-fix 능력과 뒤섞여 test-gen 신호를 희석한다.
- **caveat**: Docker/coverage 의존이라 우리 full-remote 박스에 coverage 설치(`coverage run --branch`)와 nodeid 파싱(cldk treesitter, `cldk==1.0.6`) 의존을 얹어야 한다. 또 `calculate_coverage`/`modify_eval`은 repo별 하드코딩 분기(django/sympy/sphinx)가 많아 새 repo 추가 시 brittle `[verified]`(test_spec.py:247-264, run_evaluation.py:245-270).

---

## 3. Otter / Otter++ 역공학 (출력 아티팩트 only) `[reverse-engineered]`

**중요 honesty**: Otter 소스는 비공개. 아래는 `Otter/Otter_TDD_GPT4o.json`, `Otter/Otter_Plus_TDD_GPT4o.json`의 *생성 출력*을 관찰·통계낸 추론이다. 논문(arXiv:2502.05368)의 "self-reflective action planning + rule-based repair / GPT-4o / Otter++=5-ensemble"는 README 인용에서 온 것이고, 코드 동작은 직접 못 봤다.

### 3.1 파일 구조 `[verified]`
- 두 파일 모두 **449 엔트리 리스트**, 각 `{"instance_id", "model_patch", "model_name_or_path"}`. `model_name_or_path`는 `Otter` / `Otterplus`로 고정.
- **이것들은 생성된 테스트 patch(예측)다** — `model_patch`가 test 파일 diff. golden_test_patch.json과 동일 제출 포맷이라 그대로 `--predictions_path`로 채점 가능.
- 449개 instance_id가 gold와 완전 일치(순서까지). 빈 patch 0개(Otter/Otter++/gold 모두). patch 바이트: Otter median 1285 / mean 1460 / max 8462, Otter++ median 1317 / mean 1470 / max 8462.

### 3.2 Otter++ vs Otter — 아티팩트 차이 `[reverse-engineered]`
- **111/449 인스턴스에서 patch가 다르다**(338개는 동일). Otter++가 "5개 후보 ensemble 중 선택"이라면, 다수 인스턴스는 1차 후보가 그대로 채택되고(동일), ~25%에서 다른 후보가 골라진 그림과 일치.
- 통계 차이(아래 §3.3 표): Otter++가 "새 test 함수 추가"(75%→81%), "함수 내부 import"(34%→46%), "순수 additive"(79%→85%) 비율이 일관되게 **더 높다**. 즉 Otter++의 selection이 **더 self-contained하고 더 비파괴적(기존 테스트를 덜 덮어쓰는)** 후보를 선호하는 경향 `[reverse-engineered]`. 이는 채점이 contributing-test-only + fail_before 계약이라, 기존 코드를 깨는 후보(P2P 위반 위험)보다 깔끔히 함수만 추가하는 후보가 통과율이 높다는 점과 정합적이다.
- 구체 사례 `django__django-11095`: 두 버전 모두 `test_get_inlines_hook`를 생성하지만 (Otter는 `AdminViewPermissionsTest`에 끼워넣고 decorator/setup 없이 in-test 클래스 정의, Otter++는 `GetFormsetsWithInlinesArgumentTest` 말미에 추가 + `RequestFactory`·`InlineModelAdmin` import inline) — **같은 의도, 다른 후보**. ensemble re-selection의 전형.

### 3.3 테스트 shape 특성 (449 코퍼스 통계) `[reverse-engineered]`
| 특성 | Otter | Otter++ |
|---|---|---|
| 새 `def test` 추가 | 341 (75%) | 367 (81%) |
| 함수 **내부**에 import 삽입 | 157 (34%) | 210 (46%) |
| `pytest.raises` 사용 | 10 | 9 |
| unittest assert*(`assertEqual/True/Raises`) | 133 | 135 |
| `@parametrize` 사용 | 2 | 2 |
| **>1 파일 touch** | **0** | **0** |
| 순수 additive(삭제 ≤2줄) | 359 (79%) | 384 (85%) |

해석 `[reverse-engineered]`:
- **단일 test 파일만 출력**(0개가 멀티파일). Otter는 "이 이슈에 대한 테스트는 정확히 한 test 파일에 들어간다"는 강한 가정 — TDD-Bench의 contributing-function 채점이 파일 단위로 정렬돼 있어 이게 안전하다.
- **함수-로컬 import가 매우 흔하다(34~46%)**. `from astropy.time import Time` 같은 import를 *테스트 함수 body 안*에 넣는다(예: astropy-13033). 이는 module-top import가 빠져 NameError로 터지는 걸 막는 **방어적 self-containment** 패턴 — "rule-based repair"가 import 누락을 함수 내 import 추가로 고치는 룰을 갖고 있다고 추론 가능 `[inferred]`. fail_before 계약상 ERROR도 "fail"로 치지만, pass_after에서 ERROR면 0점이라 import 안정성이 점수에 직결된다.
- **대부분 additive(새 함수 추가)**. 기존 테스트 함수를 통째로 덮어쓰는 경우(astropy-13033처럼 `test_required_columns` 재작성)도 있지만 소수. additive가 P2P(기존 통과 테스트 유지) 안전.
- repo 관행을 따라간다: sympy/sklearn은 module-top assert 스타일(`assert ...`, `assert_array_equal`), Django/admin은 `assertEqual`/`TestCase` 스타일을 모방(scikit-learn-13496, sympy-13031, django-11095 샘플에서 확인). 즉 **타깃 파일의 기존 컨벤션을 모사**하는 in-context 생성.
- self-reflective action planning의 직접 증거는 출력만으론 안 보인다 `[reverse-engineered, weak]`. 다만 (a) nodeid 정확 정렬(채점기가 `def test`로 잘라내기 좋게 깔끔한 함수 경계), (b) import 자가보정, (c) 단일파일 집중은 "어디에 무슨 테스트를 둘지 계획 후 생성"과 정합적인 정황.

---

## 4. TDD-Bench-Java — 우리 작업과의 관련성 `[verified]`

- `TDD-Bench-Java/`: TDD-Bench의 Java 확장. `README.md`는 `poly_bench_evaluation/run_evaluation.py`(별도 harness, `--dataset-path java.csv`) 기반.
- `id_list.txt` 249개 인스턴스(jackson-databind, mockito, gson 등). `java.csv`는 SWE-bench-Java류 컬럼(repo, base_commit, patch, test_patch, P2P/F2P, Dockerfile, test_command, node 분류 등).
- 예측 포맷: `{"instance_id","model_patch","class_name","file_name","function_name","model_name_or_path"}` — Python 버전과 달리 class/file/function을 명시(비어도 됨).
- **우리 관련성: 낮음.** 우리는 Python SWE-bench Verified 중심이고, Java rail은 별도 toolchain(maven/gradle, JUnit, poly_bench harness)이 필요. 흡수 ROI 없음 — 참고용으로만 둔다. (단, "class/file/function을 예측에 명시"하는 포맷은 우리 test-gen 출력에 localization 메타를 같이 실어보내는 아이디어로 차용 가능 `[inferred]`.)

---

## 5. 우리가 흡수할 것

### 5.1 "좋은 테스트"의 정의 (하네스가 가르치는 것) `[verified→차용]`
1. **contributing-test-only 채점**: 전체 파일이 아니라 *예측이 추가/수정한 테스트 함수만* 실행. 우리 grading에서 "이 patch가 진짜 기여한 테스트가 fail→pass 하나"를 격리 측정하는 nodeid-단위 채점을 도입하면, 무관 테스트 노이즈/flake/시간을 줄인다. 구현 참조: `get_contributing_functions`(run_evaluation.py:177-219) + treesitter nodeid 해석(L379-392) + `modify_eval`(L224-278).
2. **coverage-adequacy 곱셈 게이트**: `pass_after`만으로 green 주지 말고 **변경코드 라인 coverage(`cov_score`)를 곱하라**(L685-688, L734). over-narrow/가짜-green을 수치로 차단 — 우리의 반복 false-green 문제(MEMORY)에 직접 대응. `calculate_coverage`(L50-138)가 patch hunk 변경라인 ↔ `coverage report` missing line 대조 레시피.
3. **fail_before 강제**: c_old에서 *실제로 실패*해야만 점수(L713-719). "테스트가 버그를 실제로 잡는가"의 최소 계약. 우리 repro 오라클 강화 레버와 동형.

### 5.2 Otter 테스트-shape 패턴 (차용 가치) `[reverse-engineered→차용]`
- **함수-로컬 import로 self-containment 확보**: 생성 테스트의 의존 import를 함수 body 안에 넣어 module-top import 누락에 의한 ERROR(=pass_after 0점)를 방어. 우리 test-gen 프롬프트/repair 룰에 "필요 import를 테스트 함수 내부에 명시"를 넣을 수 있다.
- **단일 test 파일 집중 + 새 함수 additive**: 멀티파일·기존함수 파괴를 피하면 P2P 안전 + 채점기 파싱 친화. 우리 test-gen 출력 제약으로 차용.
- **타깃 파일 컨벤션 모사**: 같은 디렉토리 기존 테스트의 assert 스타일(pytest assert vs unittest)을 따라가는 in-context 생성.
- **Otter++ = best-of-5 selection이 "더 깔끔/더 self-contained" 후보를 고른다**는 정황: 우리 acceptance/best-of-N selection(MEMORY: jun-28-reprovote-to-acceptance-sota)의 selection 기준에 "self-containment·additive·coverage" 신호를 가중하는 가설로 A/B 가능 `[inferred]`.

---

## 6. Honesty flags

- **`[verified]`** (소스 직독): §1 채점 3-phase·fail_before/pass_after/cov_score 공식(run_evaluation.py:713-740), contributing-test-only(L177-219, L379-392, modify_eval), dataset이 F2P/P2P drop(dataset_preparation.py:13), 449 카운트, Otter JSON 구조·통계, Java README 포맷.
- **`[inferred]`** (코드 정황 추론): 500→449 드롭 사유(zero-coverage/F2P-violating — 코드에 명시 없음, 채점 구조+README로 추론), grading.py legacy-dead 경로, "TDD-Bench가 우리 rail로 낫다"는 판단(미실측 — 우리 박스에서 실제로 돌려봐야 확정), 함수-로컬 import = rule-based repair 룰이라는 연결.
- **`[reverse-engineered]`** (Otter 출력 only, 소스 없음): Otter/Otter++의 모든 접근법 추론, 111/449 차이의 ensemble 해석, self-reflective planning 정황(약한 증거). 논문 주장(GPT-4o, 5-ensemble, self-reflective+rule-based)은 README 인용에서 옴 — 코드로 검증 못 함.
- **JSON 크기 caveat**: Otter 파일 각 ~735KB(449 엔트리). 통계는 Python으로 전수 집계(샘플링 아님)했고, 본문에 인용한 개별 test 본문은 head 일부만 표시. patch 바이트 통계는 `len(model_patch)` 기준.
- **미열람**: `tdd-github.pdf`(논문 PDF), `Figures/`(포스터/그림), `tests/test_*.py`(하네스 자체 유닛테스트)는 채점 로직 분석에 불필요해 깊이 안 봄. constants.py는 enum/test_cmd만 발췌 확인(965줄 전체 미독).

---
파일 참조(절대경로):
- 하네스 채점 SSOT: `/Users/songmin/quanta-codeagent-v3/.extracted_source/repro-scaffolds/tdd-bench-verified/tddbench/harness/run_evaluation.py`
- dataset 준비: `.../tdd-bench-verified/dataset_preparation.py`
- test spec/eval 스크립트: `.../tdd-bench-verified/tddbench/harness/test_spec.py`
- contributing nodeid 유틸: `.../tdd-bench-verified/tddbench/harness/utils.py` (get_test_directives)
- legacy SWE-bench 채점: `.../tdd-bench-verified/tddbench/harness/grading.py`
- Otter 출력: `.../tdd-bench-verified/Otter/Otter_TDD_GPT4o.json`, `Otter_Plus_TDD_GPT4o.json`
- Java 확장: `.../tdd-bench-verified/TDD-Bench-Java/`
