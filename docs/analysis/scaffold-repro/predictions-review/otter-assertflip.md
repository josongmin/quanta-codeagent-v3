# SWT-bench Verified 예측 리뷰: e-Otter++ (IBM, 62.1%) vs AssertFlip (UWaterloo, 45.5%)

ETH SWT-bench 서버에서 두 시스템의 Verified-split 예측을 받아 직접 까본 결과. 비교 baseline은
이전 리뷰의 L*Agent(70.8%, existing-file-insert / coverage 84%), ReProAgent(100% new-file / 70%),
TEX-T(100% script / 87%).

## 0. 다운로드 결과 [verified]

전부 다운로드 성공. `_predictions/` 아래 저장.

| 시스템 | 파일 | 인스턴스 수 | resolved | resolve율 | Mean coverage | coverage delta |
|---|---|---|---|---|---|---|
| e-Otter++ | `eotter_plus_verified.inference.json` (+`.evaluation.json`) | 432 | 263 | 60.9% | **0.857** | 0.625 |
| AssertFlip | `assertflip_verified.preds.jsonl` (+`.evaluation.json`) | 326 | 188 | 57.7% | 0.703 | 0.630 |

- 두 시스템 모두 전체 Verified(500개)를 다 제출하지 않았다 [verified]: e-Otter++=432, AssertFlip=326.
  서버 evaluation의 resolve율(60.9%/57.7%)은 제출한 부분집합 기준이라 공식 리더보드 점수
  (62.1%/45.5%)와 정확히 일치하진 않음(특히 AssertFlip 갭이 큼 — 미제출 인스턴스를 fail로 치면 45%대로 내려감). [inferred]
- e-Otter++ `model_name_or_path = "claude_e_otter_plus_verfied"` → **Claude 기반** [verified].
- AssertFlip은 파일명이 전부 `test_coverup_<instance_id>.py` → 오픈소스 테스트 제너레이터
  **CoverUp 위에 구축** (README도 "builds upon the opensource test generator CoverUp" 명시). [verified]

## 1. Integration style

전수 분류(정규식으로 `diff --git`/`new file mode`/touched path 카운트) [verified]:

| 시스템 | new-file-only | existing-file-insert | mixed | multi-file | avg diffs/inst | median +lines |
|---|---|---|---|---|---|---|
| **e-Otter++** | 0 | **432 (100%)** | 0 | 0 | 1.00 | 25 |
| **AssertFlip** | **326 (100%)** | 0 | 0 | 0 | 1.00 | 24 |

완벽하게 대칭. e-Otter++ = **100% existing-file-insertion**(L*Agent와 같은 계열), AssertFlip = **100% new-file**
(ReProAgent/TEX-T 계열). 둘 다 단일 파일/단일 diff.

**e-Otter++ — 기존 파일에 함수/메서드 append, 레포 픽스처 적극 재사용** [verified]:
- `astropy__astropy-12907`: 기존 `astropy/modeling/tests/test_separable.py`의 마지막 test 뒤에
  `def test_nested_compound_models()` 추가. import 추가 0 — 파일에 이미 있는 `models`,
  `separability_matrix`, `assert_allclose`를 그대로 씀.
- `django__django-11095`: 기존 `tests/admin_inlines/tests.py`의 `class TestInlinePermissions(TestCase)`
  **안에** `def test_get_inlines_hook(self)` 삽입 → 클래스 setUp/import/`RequestFactory` 전부 상속.
- 전체 432개 중 import를 새로 추가하는 건 **단 2개**(`adds_imports=2`) → 거의 항상 타깃 테스트 파일의 기존 import에 의존. [verified]
- 217/432가 `self.assert*` unittest 스타일 → 레포의 기존 테스트 컨벤션을 따라감. [verified]

**AssertFlip — `/dev/null`에서 새 standalone 파일 생성, 자기완결적** [verified]:
- 모든 패치가 `diff --git a/dev/null b/<dir>/test_coverup_<id>.py` + `new file mode 100644` + `--- /dev/null`.
- 매 파일이 자기 import 풀세트를 직접 적음(`import pytest`, `from ... import ...`). 레포 픽스처 재사용 거의 없음.
- 예: `sphinx-doc__sphinx-8551`은 `Sphinx` 앱을 conf.py/index.rst까지 tmp_path에 손으로 깔아
  처음부터 빌드(레포의 `app` pytest fixture 안 씀).

## 2. Distinctive technique

### e-Otter++: ensemble/diversity 신호는 **예측 산출물에선 직접 안 보임** [inferred]
- inference json은 인스턴스당 단일 `model_patch`만 — best-of-N의 후보들이나 execution-feedback 메타데이터는
  최종 산출물에 남지 않음(서버엔 `inference_outputs`만 공개, 중간 trajectory 비공개). [verified]
- 간접 신호: bug-aware 주석이 81/432(19%)로 존재 → "This method doesn't exist in the current code,
  which is why the test should fail"(django-11095) 같이 **기대 실패를 명시적으로 reasoning**.
  단일 LLM이 fail-to-pass를 의식하고 작성한다는 정황. coverage 0.857로 매우 높음 → 기존 테스트 하네스
  안에 꽂아 레포 코드를 넓게 실행시키는 게 점수의 핵심 동력. [inferred]
- "++"의 ensemble/execution-feedback은 산출물만으론 확증 불가 → method 차원에선 [inferred].

### AssertFlip: "passing test → assertion FLIP" 가설 **확정** [verified]
README 부제가 직접 말함: *"Inversion of LLM-Generated Passing Tests"*. 그리고 생성된 테스트의 주석/단언이
flip을 그대로 노출한다:

- `django__django-10999` — `assertEqual(result, datetime.timedelta(hours=-1))  # The function should
  return correct timedelta` + docstring "correctly parse the duration **once the bug is fixed**".
  → 버그 코드에선 음수 파싱이 틀리므로 이 단언은 **실패**, 고쳐지면 통과 = fail-to-pass.
- `sympy__sympy-24443` — `assert _check_homomorphism(...) is True` 뒤에 꼬리 주석
  `# The test will fail if the bug is present by returning False for valid homomorphisms.`
- `sympy__sympy-20438` — `assert b.is_subset(c) is True  # This should be True when the bug is fixed`.
- `scikit-learn__scikit-learn-13142` — `assert np.array_equal(c1, c2), "fit_predict and predict
  should agree when n_init > 1"` + `# ... the expected correct behavior`.
- `psf__requests-1142` — `assert 'Content-Length' not in request.headers` + `# ... which is the correct behavior`.
- `matplotlib__matplotlib-25122` — `# The window correction should be equal when the bug is fixed` /
  `# Assert that the difference is zero, indicating the bug is fixed`.

패턴이 일관적: **단언은 항상 post-fix 정답값**을 적고, 주석으로 "버그 있으면 실패한다"를 명시.
이게 flip의 직접 증거 — 원래 LLM이 현 동작(=버그값)으로 통과 테스트를 짠 뒤, 단언을 정답값으로 뒤집어
버그 코드에서 실패하게 만든 것. bug-aware 주석 밀도가 177/326(54%)로 e-Otter++(19%)의 ~3배 →
flip-중심 설계와 정합. [verified]

regen 10회 + refine 10회 + LLM validator + planner(README) — 즉 flip 후 "버그 코드에서 fail /
정답 코드에서 pass" 양쪽을 검증하는 dual-code 루프가 있다. [verified, README]

## 3. Assertion/oracle design

- **둘 다 post-fix correct-behavior oracle** [verified]. 버그 동작을 박제하는 게 아니라 "고쳐졌을 때의 정답"을 단언.
  - e-Otter++ `astropy-12907`: `assert_allclose(separability_matrix(nested_model), expected_nested_matrix)`로
    블록대각(정답) 기대 — 버그(중첩 시 off-diagonal 오염)에서 실패.
  - AssertFlip은 위 §2처럼 노골적으로 정답값+꼬리주석.
- 차이: e-Otter++는 oracle 값을 **레포 헬퍼/실제 객체**로 계산해 검증(예: 실제 모델로 separability 계산),
  AssertFlip은 종종 **하드코딩된 기대값**(`timedelta(hours=-1)`, `is True`)에 의존 → 더 brittle. [verified/inferred]

## 4. 점수가 L*Agent(70.8%)보다 낮은 이유 — 산출물에서 보이는 약점

**공통 인스턴스 325개 head-to-head** [verified]: e-Otter++ 67.4% vs AssertFlip 57.5%.
both-resolved 154, **e-Otter++ 단독승 65**, AssertFlip 단독승 33, 둘다실패 73.

### AssertFlip(45.5%)이 visibly 약한 점
1. **Mock 남용** [verified]: 45개 인스턴스가 함수를 직접 mock(`# Mock catch_all_view function` 처럼
   대상 함수를 가짜로 재구현). 이들 resolve율 **33%** vs non-mock 62%. mock은 레포 실코드를 안 건드려
   fail-to-pass 자체가 성립 안 함 — 예 `django__django-14404`는 `catch_all_view`를 통째로 mock해
   레포 버그와 무관한 테스트가 됨.
2. **standalone 파일이라 coverage 낮음**(0.703 vs e-Otter 0.857) — 새 파일이 레포 테스트 하네스/
   픽스처를 안 타서 실행 폭이 좁음. SWT-bench는 coverage delta도 보므로 손해.
3. **하드코딩 기대값 brittle** — 환경/버전차에 약함.
4. **미제출 174개**(326/500) — 공식 45.5%는 미제출 fail 반영분.

### e-Otter++(62.1%)가 L*Agent(70.8%)보다 약한 점 [verified/inferred]
1. existing-file-insert로 coverage(0.857)는 L*Agent급이지만, 기존 픽스처 의존이 가끔 역효과:
   `sphinx-8551`에서 e-Otter++는 레포 `app` 픽스처+`temp_data` 조작으로 시나리오를 깔다가 fail-to-pass
   성립 실패(AssertFlip은 self-contained Sphinx 빌드로 성공). 픽스처 상태 셋업이 미묘할 때 단일-pass가 못 맞춤. [verified]
2. ensemble/execution-feedback이 산출물엔 안 남아, L*Agent 대비 추가 검증 깊이가 부족한 정황(L*Agent는
   더 강한 localization+반복). 단일 후보 제출이라 다회 attempt 오라클 루프가 약함. [inferred]

## 5. 우리 repro-gen에 흡수 가능한 것

1. **★ AssertFlip flip 트릭 = 값싼 오라클 (HIGH ROI)** [verified로 메커니즘 확인]:
   "현 동작으로 통과하는 테스트 생성 → 단언만 정답값으로 뒤집기"는 우리 repro-gen의 핵심 난점
   (정답 동작을 LLM이 처음부터 알아야 함)을 우회한다. LLM은 **현재 관측 가능한 동작**을 캡처하는 건
   잘하므로, (a) 현 코드에서 PASS하는 characterization 테스트를 먼저 짜게 하고 (b) 이슈 텍스트로부터
   "정답이면 이 단언이 어떻게 바뀌어야 하나"만 LLM에 묻는 2-스텝이, 단번에 fail-to-pass 짜는 것보다 쉬울 수 있음.
   → 우리 grounding/synthesis 수렴 병목(맞는 파일 짚고 edit 수렴 실패)에 직접 대응되는 후보 lever.
   기존 acceptance/dual-guard 루프(`QUANTA_BENCH_ACCEPTANCE`)에 "flip 단계"를 옵션 단계로 끼울 수 있음. **measure-first A/B 대상.**
2. **dual-code 검증 루프**(버그/정답 양쪽에서 fail/pass 확인)는 우리 repro-oracle과 동형 — 이미 보유.
   AssertFlip은 여기에 regen10+refine10+LLM-validator를 붙임 → effort-ladder(`QUANTA_BENCH_EFFORT_LADDER`)와 합칠 여지.
3. **e-Otter++ existing-file-insert + import 재사용**(432/432 중 import 추가 2개): coverage를 끌어올리는
   가장 큰 단일 레버가 "레포 기존 테스트 파일에 꽂아 하네스를 통째로 재사용"임을 재확인. 우리 repro-gen이
   new-file로 기울어 있으면 coverage 손해 → 기존 테스트 파일 insertion 모드를 우선 고려.
4. **흡수 안 할 것 — AssertFlip의 mock**: 대상 함수를 mock하면 fail-to-pass가 무의미해짐(resolve 33%).
   answer-key 안티패턴과 같은 류의 함정. 명시적으로 피해야 함.

---
*근거 파일*: `_predictions/eotter_plus_verified.{inference,evaluation}.json`,
`_predictions/assertflip_verified.{preds.jsonl,evaluation.json}`. 인스턴스별 인용은 실제 패치 원문에서 발췌(미발명).
