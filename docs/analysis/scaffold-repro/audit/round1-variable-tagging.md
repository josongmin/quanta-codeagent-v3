# Round-1 적대 감사 — 변수 태깅 (insertion 우위는 진짜 insertion인가?)

**질문**: 5개 repro 스캐폴드 시스템(L\*Agent 84% / TEX 87% / eOtter++ 62% / ReProAgent 70% / AssertFlip 45%)의
점수 차이를 "통합(insertion/integration) 방식"으로 귀속하는 통념이 옳은가, 아니면
assertion 강도·oracle 정확성·localization·test 개수 같은 **숨은 변수의 위장**인가?

**방법**: 5개 시스템에 모두 존재하는 323개 교집합 instance 중, repo를 가로질러 29개를 샘플
(django 6 / sympy 5 / sklearn 3 / matplotlib 3 / astropy 3 / sphinx 3 / pytest 2 / xarray 2 / requests 1 / pylint 1).
각 instance마다 5개 생성 테스트를 나란히 놓고 integration **이외의** 차원을 독립적으로 태깅.
AF·eOtter는 per-instance resolved/unresolved 정답(evaluation.json)까지 교차검증.

**데이터**: `/Users/songmin/quanta-codeagent-v3/.extracted_source/repro-scaffolds/_predictions/` +
`reproagent/outputs_gpt_5_mini/repro_agent_preds_gpt_5_mini_verified.jsonl`.
스키마는 5개 모두 `{instance_id, model_patch, model_name_or_path}`, `model_patch`가 곧 생성된 테스트 diff.

---

## 0. 헤드라인 — CONFOUND 분포 (deliverable #5)

29개 instance 각각에 대해 "L\*Agent의 우위(혹은 field 대비 차이)를 가장 잘 설명하는 변수"를 1개 태깅:

| 코드 | 변수 | 개수 | 비율 |
|---|---|---|---|
| (a) | **insertion/integration** | **0** | **0%** |
| (b) | better-assertion (oracle 강도/정확) | 15 | 52% |
| (c) | better-localization (맞는 symbol/path) | 7 | 24% |
| (d) | more-tests | 2 | 7% |
| (e) | tie (변별 없음) | 5 | 17% |

> **결론: insertion 단독으로 설명되는 instance = 0/29. assertion+localization 위장 = 22/29 (76%).**
> "통합 방식이 점수를 만든다"는 통념은 이 샘플에서 **반증**된다.

### 통념을 깨는 두 개의 자연실험 (integration을 통제한 대조군)

1. **TEX = 최고점(87%)인데 통합은 最弱**. TEX는 29/29 전부 repo 테스트 스위트에 삽입하지 않고
   독립 `reproduce_script.py`를 쓰며, exit-code(0=fixed/2=bug) 오라클이다 — pytest assertion 자체가 없음
   (29개 중 `assert` 보유 2개뿐). 가장 통합 안 된 스타일이 1등 → "insertion=점수"라면 설명 불가.

2. **AF(45%)와 ReProAgent(70%)는 integration 스타일이 100% 동일**(둘 다 `test_coverup_*` /
   `test_repro_agent_*` 라는 새 isolated 파일). 그런데 **25점 차**. integration이 동일한데 점수가 갈리므로
   이 25점은 정의상 assertion/oracle/localization 품질이다. integration이 아니다.

---

## 1. Integration 스타일 분류 (통제변수로 확정)

29/29 전부에서 스타일이 시스템별로 일관 — 즉 integration은 시스템 상수(confounder)이지 instance 변수가 아님:

| 시스템 | 점수 | 파일 배치 | 오라클 메커니즘 |
|---|---|---|---|
| **TEX** | 87% | 29/29 `reproduce_script.py` (독립 스크립트) | **exit-code** (`sys.exit`/`return 0|2`), assert 거의 없음 |
| **L\*Agent** | 84% | 정확한 모듈의 test 패키지(신규/기존 파일), fixture root까지 | pytest assert (exact) |
| **eOtter++** | 62% | **기존 repo test 파일/클래스 안에 삽입**(最고통합) | pytest assert, 종종 fixture(`pytester`,`app`) |
| **ReProAgent** | 70% | 29/29 `test_repro_agent_*` 신규 isolated 파일 | pytest assert |
| **AssertFlip** | 45% | 29/29 `test_coverup_*` 신규 isolated 파일 | pytest assert (얕음) |

핵심 관찰: 통합도 순위(eOtter 最고 ⊃ L\*/repro/AF 신규파일 ⊃ TEX 독립스크립트)와 점수 순위
(TEX 87 > L\* 84 > repro 70 > eOtter 62 > AF 45)가 **역상관/무상관**.
가장 통합한 eOtter가 62%, 가장 덜 통합한 TEX가 87%.

---

## 2. Localization — 시스템들이 "무엇을 테스트할지"에서 갈린다 (deliverable #1)

`+++ b/<path>` 와 테스트 내부 import를 비교. **AF·ReProAgent는 모듈과 무관한 고정 "덤프 버킷"에 떨군다**:

- **sympy 5/5 전부**: L\*Agent·eOtter는 실제 버그 모듈(`sympy/geometry/tests`, `sympy/core/tests`,
  `sympy/matrices/expressions/tests`, `sympy/combinatorics/tests`)에 배치.
  AF·ReProAgent는 **버그가 어느 모듈이든 무조건 `sympy/polys/tests/`** 에 배치. (evidence: §1 dir 스캔)
- **sklearn 3/3**: L\*/eOtter → `sklearn/linear_model/tests`·`metrics/cluster/tests`·`feature_extraction/tests`;
  AF/repro → 일괄 `sklearn/tests`.
- **astropy 3/3**: L\*/eOtter → `modeling|timeseries|table/tests`; AF/repro → 일괄 `astropy/tests`.
- django 6/6, sphinx, pytest 동일 패턴(전용 vs generic `tests/`).

파일 경로는 신규파일이면 cosmetic일 수 있으나, **import 대상 symbol이 localization의 진짜 지표**.
대표적 localization 실패(테스트 대상 코드 경로가 틀린 케이스):

- **`pytest-dev__pytest-10356`** (MRO mark 병합): AF는 `TestDings.pytestmark` **속성**을 직접 까서
  `len(markers)==2`를 단언 — 이건 클래스 자기 pytestmark이지 MRO 병합 결과가 아님(틀린 경로).
  → AF **unresolved**. L\*/repro는 `request.node.iter_markers()`(올바른 경로) → 정답.
  eOtter는 `pytester.inline_genitems`(정식 경로) → **resolved**. ← localization이 정답을 가른 instance.
- **`pylint-dev__pylint-6386`** (`-v` short flag): AF는 `OptionsManagerMixIn`+`optparse`를 mock
  (실제 코드와 무관한 가짜 경로) → unresolved. L\*/repro는 `Run([..., "-v"], exit=False)`(실 진입점) → 올바름.
- **`astropy__astropy-13033`**: AF는 `_required_columns_enabled=False`로 체크를 끄고
  `_check_required_columns()`를 직접 호출 — 실제 트리거(`remove_column`)를 우회한 인위적 경로.
  L\*/eOtter/repro는 `ts.remove_column("flux")`로 실 경로 통과.

→ **localization 차원만으로 7개 instance에서 우열이 갈림(verdict c).**

---

## 3. Assertion 강도 (deliverable #2) — L\*Agent이 insertion과 독립적으로 더 강한가? **그렇다.**

태깅 척도: exact-value > message/substring-match > presence-only(`hasattr`/`is not None`) > exit-code(TEX).
대표 비교:

- **`scikit-learn__scikit-learn-10297`** (`store_cv_values`):
  - L\*Agent: `cv_values_.shape[0]==n_samples`, `shape[-1]==n_alphas`, `shape[1]==n_classes` (3차원 exact).
  - AF: `assert hasattr(model,'cv_values_')` **presence-only**(最약) — 그런데 **resolved**.
  - eOtter: `assert_equal(cv_values_.shape, (n_samples, n_alphas))` — multiclass에서 gold shape는
    `(n_samples, n_classes, n_alphas)`라 **틀린 oracle** → **unresolved**.
  - → 여기선 **약한 assertion이 이기고 강한(틀린) assertion이 진다**. assertion "강도"와 정답은 단조관계가 아님.
- **`pydata__xarray-3095`** (deepcopy dtype):
  - L\*Agent: `dtype.kind=='U'` (폭 무관, robust) + 3개 테스트. repro: `np.issubdtype(..., np.unicode_)`.
  - AF: `dtype == '<U3'` — **폭까지 하드코딩(brittle)**. 정답이긴 하나 numpy/플랫폼 변동에 취약.
- **`django__django-10973`**: L\*Agent 17개 assert(pg 인자 exact 9개) vs eOtter 3 / AF 2(thin).
- **`astropy__astropy-13236`**: L\*Agent 5 assert(구조화 ndarray warning 검사) vs AF 1.

**판정**: L\*Agent은 평균적으로 exact-value 단언이 가장 촘촘(§1 feature 스캔의 `eq`/`asserts` 카운트가 최상위권).
이 강도는 insertion 위치와 무관하게 텍스트 자체의 속성. → 15개 instance에서 assertion이 변별자(verdict b).

---

## 4. Oracle 정확성 (deliverable #3) — 틀린 기대행동을 단언한 케이스

가장 치명적 confound. **같은 코드 경로를 봐도 "고친 뒤 무엇이 맞는가"를 틀리게 잡으면 점수가 무너진다**:

- **`sympy__sympy-11618`** (서로 다른 차원 Point.distance): gold는 **차원 불일치를 거부(error)** 하는 방향.
  - 올바른 oracle — L\*Agent("truncated 결과면 fail" guard), ReProAgent(`raises ValueError`).
  - **틀린 oracle** — eOtter `assert p1.distance(p2) == sqrt(5)` / AF `assert distance == 5**0.5`
    (= 2D를 0으로 채워 3D로 확장한다는 가정. 이슈가 막으려는 바로 그 silent 동작을 정답으로 단언).
  - 정답 라벨: AF unresolved, eOtter resolved — eOtter의 `== sqrt(5)`가 그 grader의 gold 테스트와
    우연히 합치(이 이슈의 채택 fix가 zero-pad 방향이었을 가능성)했음을 시사. **oracle 방향 자체가 시스템마다 정반대**.
- **`psf__requests-1142`** (GET에 Content-Length 안 붙어야): AF는 어댑터를 monkeypatch해서
  가짜 `status_code=503`을 만들고 "503이면 서버가 Content-Length 때문에 거절"이라 단언 — 실제 fix와
  무관한 **날조된 oracle**. L\*/repro는 `prep.headers`에 Content-Length 부재를 직접 검사(정확).
- **`django__django-11099`**: AF 함수명 `test_..._allows_trailing_newline` 인데 본문은
  `assertRaises(ValidationError)`(거부) — 이름↔본문 모순(주석/네이밍 oracle은 틀렸으나 실 assert는 맞음).
  eOtter는 본문이 깨진 삽입(아래 §6)이라 사실상 oracle 없음.

→ oracle 오류는 b/c 카테고리에 흡수해 집계했으나, **"insertion이 같아도 oracle 방향이 반대"** 라는 사실 자체가
insertion 귀속론의 결정적 반례.

---

## 5. Test 개수 (deliverable #4)

- 다중 테스트는 L\*Agent에 약간 더 흔함: `sympy-12481`(2), `matplotlib-14623`(2), `pytest-10356`(2),
  `xarray-3095`(3), `django-11099`(AF 2). 나머지 대부분 단일.
- 다중이 **gold 변경 커버리지와 강하게 상관하진 않음** — `xarray-3095`처럼 L\*가 3개로 Dataset/DataArray/stdlib copy를
  모두 덮은 케이스는 커버리지↑이나(verdict b로 흡수), 일반적으로 1개 정밀 테스트가 충분.
  단독으로 점수를 가른 instance는 2개(verdict d: `sympy-12481`, `matplotlib-14623`)에 그침.
- TEX는 단일 거대 스크립트(`+lines` 49~249)지만 ntest는 0~1 — 개수와 점수 무관의 또 다른 증거.

---

## 6. 부수 발견 — eOtter의 "삽입 파손" (integration이 **해**가 된 케이스)

eOtter는 기존 파일/클래스에 삽입하는 最고통합인데, 그 통합이 **깨진 본문**을 낳기도 함:

- **`django__django-11099`** eOtter 본문 전체:
  ```
  +        invalid_usernames = ["o'connell", 'Éric', 'jean marc', "أحمد", "newline\n"]
  ```
  리스트만 정의하고 **assert도 test 함수도 없음**(빈 삽입). → 단언 0개.
- **`django__django-10999`** eOtter: 들여쓰기가 기존 메서드 중간에 병합된 듯한 부유 코드 + 잉여 빈 줄.
- **`sympy-11618`** eOtter: 기존 `test_point.py`에 `==sqrt(5)`(틀린 oracle) 삽입.

→ "기존 파일 삽입"이라는 가장 통합적인 선택이 오히려 파손/오라클오류 위험을 키운다.
즉 integration은 점수에 **양(+)이 아니라 중립~음(−)** 방향으로도 작용. insertion 우위론과 정면 배치.

---

## 7. 증거 인덱스 (재현용)

- 교집합/커버리지: 323 instance가 5개 시스템 공통(coverage 히스토그램 {5:323, 4:110, 1:67}).
- feature 스캔(파일/+lines/ntest/assert 종류별 카운트): `/tmp/feature_summary.txt` 재생성 스크립트는 본 감사 세션 Bash 로그.
- per-instance 정답: `_predictions/{assertflip,eotter_plus}_verified.evaluation.json` 의 `resolved_ids`/`unresolved_ids`.
- 인용 스니펫은 모두 `model_patch`의 `+` 추가행에서 직접 발췌(가공 없음).
- 선정 29개 id: `/tmp/sel_instances.json`. 태깅 원장: `/tmp/verdicts.json`.

---

## 한계 (Round-2/3에서 검증할 것)

- 정답 라벨은 AF·eOtter만 per-instance 보유(L\*/TEX/repro는 집계 점수만). L\*Agent "우위"는 점수·snippet 강도로
  추론한 것이지 instance별 verdict 대조는 부분적. → R2에서 L\*/TEX/repro의 instance verdict 확보 필요.
- 29개는 repo 균형 위주 표본 → resolved-편향 가능. R2에서 unresolved-heavy 표본으로 재태깅(반례 사냥).
- verdict 카테고리 1개 강제 부여 → b/c 경계가 모호한 instance 존재(oracle 오류를 b/c에 흡수). 다중 라벨 재집계 권장.
- TEX의 exit-code 오라클은 채점 파이프라인이 다를 수 있어(별도 grader) 직접 비교에 주의.
