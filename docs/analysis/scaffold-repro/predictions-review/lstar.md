# L*Agent (LogicStar) SWT-bench Verified 예측 딥리뷰

> 대상: `_predictions/lstar_agent_verified.json` (500 entries). SWT-bench Verified unit-test mode **#1, 84%**. 소스 비공개 → 이 예측 파일이 유일한 ground truth.
> 방법: Python으로 로드, repo 다양성 확보(django 231 / sympy 75 / sphinx 44 / matplotlib 34 / sklearn 32 / xarray 22 / astropy 22 / pytest 19 / pylint 10 / requests 8 / seaborn 2 / flask 1). 20+ 인스턴스 실코드 검토. 아래 모든 스니펫은 **실제 diff에서 그대로 인용**.

---

## 0. 분포 (전수 측정)

[evidence] repo별 new-file / multi-test 비율 (전체 500):

| repo | n | new-file | multi-test(>=2 fn) |
|---|---|---|---|
| django | 231 | 42 (18%) | 108 (47%) |
| sympy | 75 | 16 (21%) | 39 (52%) |
| sklearn | 32 | 7 (22%) | 12 |
| matplotlib | 34 | 24 (71%) | 11 |
| sphinx | 44 | 17 (39%) | 11 |
| xarray | 22 | 13 | 8 |
| astropy | 22 | 15 | 7 |
| pytest | 19 | 11 | 13 |
| requests | 8 | 6 | 3 |

핵심: **insertion 우세는 django/sklearn/sympy처럼 "큰 단일 테스트 모듈 + TestCase 클래스" 컨벤션이 강한 repo에서 나온다.** matplotlib(71% new-file)처럼 함수형·파일분산 컨벤션 repo에선 new-file로 기운다. 즉 insertion vs new-file 선택이 **repo의 테스트 조직 컨벤션을 따라간다**는 1차 증거.

test-fn 개수 분포: 1개=250, 2개=175, 3개=29, 4개=8, 5+=4. → multi-test는 "2개"가 압도적(=happy/bug 또는 case-matrix 2분할).

---

## 1. Integration mechanism — 기존 파일 insertion(70.8%)에서의 repo-test-suite awareness

가장 중요한 발견: **insertion 케이스는 거의 전부 기존 TestCase 클래스 끝에 메서드를 append하거나, 기존 클래스 끝에 같은 컨벤션의 새 클래스를 append하며, 기존 fixture/helper/모델/import를 재사용한다.** 단순히 "파일에 붙인다"가 아니라 그 파일의 **테스트 인프라를 읽고 재사용**한다.

[evidence] **(1) 기존 클래스의 setUp fixture 재사용** — `django-14559` (`tests/queries/test_bulk_update.py`):
기존 `BulkUpdateNoteTests` 클래스에 메서드를 추가하면서 그 클래스 setUp이 만든 `self.notes`를 그대로 소비.
```python
def test_return_rows_matched(self):
    for note in self.notes:                      # ← 기존 setUp의 fixture 재사용
        note.note = 'updated-%s' % note.id
    matched = Note.objects.bulk_update(self.notes, ['note'])
    self.assertEqual(int(matched), len(self.notes))
```
fixture를 새로 만들지 않고 클래스가 이미 가진 `self.notes`를 안다는 것 자체가 파일 내 인프라 인지의 증거.

[evidence] **(2) 기존 `.models` 모듈에 모델 추가 + tests.py import 라인 수정** — `django-15525` (`tests/fixtures/`):
2-파일 패치. `tests/fixtures/models.py`에 `NKAuthor`/`NKBook`을 append하고, `tests/fixtures/tests.py`의 **기존 import 블록**을 정확히 편집해 끼워 넣는다.
```python
 from .models import (
     Category, CircularA, CircularB,
+    NKAuthor,
+    NKBook,
     NaturalKeyThing, ...
```
그리고 새 클래스도 기존 컨벤션(`DumpDataAssertMixin, TestCase`가 쓰던 곳)과 같은 위치에 `class NaturalKeyMultiDatabaseTests(TestCase)`로 append. → 모델 정의 파일/테스트 파일 분리 컨벤션, import alphabetization까지 인지.

[evidence] **(3) 기존 import 라인에 DB-feature 가드 추가** — `django-11885` (`tests/delete/tests.py`):
기존 `from .models import (...)` 라인에 `SecondReferrer`를 **정확히 알파벳 위치**에 끼우고, 기존 `DeletionTests`의 assertNumQueries 테스트를 `CaptureQueriesContext`로 리라이트. import-line awareness가 결정적.
```python
-    M2MTo, MRNull, Origin, Parent, R, RChild, RChildChild, Referrer, S, T,
+    M2MTo, MRNull, Origin, Parent, R, RChild, RChildChild, Referrer, SecondReferrer, S, T,
```

[evidence] **(4) 기존 helper/super().setUp() 재사용** — `django-11292` (`tests/admin_scripts/tests.py`):
기존 `AdminScriptTestCase` 베이스의 `super().setUp()`·`self.write_settings`·`self.run_manage`·`self.assertIn` 헬퍼를 그대로 호출하는 새 클래스를 append.
```python
class ManageSkipChecks(AdminScriptTestCase):
    def setUp(self):
        super().setUp()
        self.write_settings('settings.py', apps=[...])   # ← 베이스 헬퍼
    def test_skip_checks_flag_skips_system_checks(self):
        out, err = self.run_manage(['dance'])            # ← 베이스 헬퍼
        self.assertIn('System check identified some issues', err)
```

[evidence] **(5) setUpTestData 패턴 + fields_for_model 등 모듈 헬퍼 재사용** — `django-13315` (`tests/model_forms/`):
`model_forms/models.py`에 FK 모델 3개 append, `tests.py`에 `class LimitChoicesToJoinDuplicatesTests(TestCase)`를 `@classmethod setUpTestData`로 추가하고 그 모듈이 import해 둔 `fields_for_model`을 호출.
```python
@classmethod
def setUpTestData(cls):
    from .models import LimitChoicesToFKChild, LimitChoicesToFKParent
    cls.p1 = LimitChoicesToFKParent.objects.create(name='p1')
...
fields = fields_for_model(LimitChoicesToFKHolder, ['parent'])   # 모듈 전역 헬퍼
```

**HOW does it know the fixtures — 증거의 본질**: 위 다섯 케이스는 전부 (a) 파일 끝 anchor 라인(예: 기존 마지막 클래스 `StrictAssignmentTests`, 마지막 모델 `CircularB`) 직후에 정확히 hunk를 박고, (b) 기존 import 블록을 알파벳 순서까지 맞춰 편집하고, (c) `self.notes`/`self.write_settings`/`super().setUp()`/`setUpTestData`/모듈 전역 헬퍼를 **새로 정의하지 않고 호출**한다. 이는 패치 생성 전에 **타깃 테스트 파일 전문(class 구조·setUp·import·helper)을 retrieve해서 컨텍스트로 넣었다**는 명확한 흔적이다. 모델을 추가할 땐 같은 앱의 `models.py`까지 동반 수정하는 2-파일 패턴 → repo의 "테스트 모델은 별도 models.py" 컨벤션까지 학습.

전수 카운트(insertion-awareness 지표): `setUpTestData` 4, `super().setUp` 4, `assertNumQueries`/CaptureQueries 11, `override_settings` 33, `@isolate_apps` 11, `self.client` 13. → django 영역에서 프레임워크 고유 테스트 데코레이터/유틸을 광범위하게 재사용.

---

## 2. New-file 케이스(29.2%) — 언제 새 파일을 고르나

[evidence] **디렉토리 정확도: new-file 159개 중 155개(97%)가 repo의 올바른 테스트 디렉토리에 안착** (`/tests/`·`/testing/`·`/test_`). 무작위 위치 생성이 아님.

패턴:
- **repo 컨벤션이 함수형/파일분산이면 new-file** — matplotlib 71%가 new-file. `matplotlib-24570 → lib/matplotlib/tests/test_offsetbox_hpacker_align_top_bottom.py`처럼 **이슈를 묘사하는 서술적 파일명**.
- **그래도 repo fixture를 import** — new-file이라고 isolated가 아니다.
  - `sphinx-8120 → tests/test_locale_override.py`: `from sphinx.testing.util import SphinxTestApp`, `make_app`/`tempdir` pytest fixture 사용 + 모듈 docstring을 sphinx 테스트 컨벤션(`~~~~` underline) 그대로 흉내.
  - `pytest-10081 → testing/test_unittest_pdb_skip_class.py`: `from _pytest.pytester import Pytester`, `from _pytest.monkeypatch import MonkeyPatch`, `pytester.makepyfile(...)`, `result.stdout.fnmatch_lines(...)` — pytest 자체 테스트 하네스 풀 사용.
  - `requests-6028 → tests/test_proxy_auth.py`: `from requests.auth import _basic_auth_str` 내부 심볼 import.
  - `astropy-13977`: 새 파일이지만 `np.lib.mixins.NDArrayOperatorsMixin` 기반 `DuckArray` 더미를 직접 구현해 `__array_ufunc__` NotImplemented 경로를 정밀 재현.

→ **new-file 선택 기준**: ① 타깃 동작이 기존 어느 TestCase에도 자연스럽게 안 붙고(횡단·신규 helper class 필요), ② repo가 파일-당-주제 컨벤션일 때. 그러나 new-file에서도 **repo 테스트 fixture/내부 심볼을 import**하므로 "isolated"가 아니라 "repo-aware standalone".

---

## 3. Multi-test 패턴(44%) — 추가 테스트가 하는 일

[evidence] **case-matrix(같은 동작의 분기 전수)** — `django-16819` (`tests/migrations/test_optimizer.py`), 기존 `OptimizerTests(SimpleTestCase)`에 6개 메서드 append:
```python
def test_add_index_then_remove_index(self):        # optimize 됨 → []
def test_remove_index_then_add_index(self):        # 역순 → 최적화 안 함
def test_add_remove_index_different_model(self):   # 다른 모델 → 안 함
def test_add_remove_index_different_name(self):    # 다른 이름 → 안 함
def test_add_remove_index_across_other_model_operation(self):  # 중간 무관 op → 통과
def test_add_remove_index_not_across_runsql(self): # 중간 RunSQL → 안 함
```
positive(최적화 발생) 1개 + negative(발생 안 함) 5개. 기존 `assertOptimizesTo`/`assertDoesNotOptimize` 헬퍼 재사용. **수정 코드의 가드 조건을 한 줄씩 핀하는 oracle.**

[evidence] **happy + edge** — `django-14559`: `test_return_rows_matched`(정상값 변경 시 matched==N) + `test_empty_objects_return_zero`(빈 입력 → 0), 각각 다른 기존 클래스(`BulkUpdateNoteTests`/`BulkUpdateTests`)에 배치.

[evidence] **fix의 두 방향 분리** — `requests-6028`: `test_rebuild_proxies_preserves_existing_proxy_auth_without_url_creds`(URL에 cred 없으면 기존 헤더 보존) + `..._replaces_proxy_auth_with_url_creds`(URL cred 있으면 교체). 버그의 양면을 별 테스트로.

[evidence] **계층별 동일 불변식** — `sympy-16792`: `test_codegen.py`에 C-header 레벨 검증 + `test_autowrap.py`에 Cython end-to-end 검증, 두 파일에 한 개씩. 같은 버그(unused MatrixSymbol을 array로)를 하위(헤더 문자열)·상위(`f(arr)==1.0`) 두 추상화에서 핀.

→ multi-test의 목적은 **회귀 가드의 정밀도**다: positive/negative 분기, happy/edge, low-level/high-level의 쌍. SWT-bench의 fail-to-pass 채점에서 **여러 메서드 중 하나라도 통과시키면 점수**라 multi가 커버리지+robustness를 동시에 올린다.

---

## 4. Assertion 설계 — fail-to-pass oracle 품질

[evidence] **post-fix 정답 동작을 단언**(단순 no-crash 아님):
- `django-16819`: `assertOptimizesTo([...AddIndex, RemoveIndex...], [])` — 수정 후 최적화 결과가 정확히 `[]`여야 함을 단언.
- `xarray-3151`: `assert expected.identical(actual)` — 기대 Dataset을 명시 구성 후 정확 동등.
- `requests-6028`: 헤더 보존 `== proxy_auth_value`, 교체 시 base64 디코드해 `decoded == 'user:pass'`.

[evidence] **DB-feature / skip 가드 사용** — `skipUnlessDBFeature` 19건, `skipIfDBFeature` 6건, `@skip*` 18건. 예 `django-11951` import 라인 자체에 `skipIfDBFeature, skipUnlessDBFeature` 동반:
```python
from django.test import (
    TestCase, override_settings, skipIfDBFeature, skipUnlessDBFeature,
)
```
→ backend별 비결정성을 우회하는 데코레이터를 repo 컨벤션대로 사용. 이게 **그래더 환경(sqlite 등)에서 깨지지 않게** 하는 직접적 장치.

[evidence] **그래더 noise에 robust한 단언(over-fit 회피)** — L*Agent는 정확-동등이 위험한 곳에선 의도적으로 약한 단언을 쓴다:
- `sympy-18189`: `assert complete_soln.issubset(permuted)` + `set(map(abs, sol)) == {2,3}` — 정수 타입/표현 차이(`Integer` vs `int`)·순서 비결정성 때문에 set-equality 대신 **부분집합 + 불변식**. 주석에 이유 명시("Implementations may represent integers differently").
- `sklearn-25931`: 경고 문구 버전차를 흡수하려 소문자화 후 키워드 OR 매칭하는 `_is_feature_names_warning` 헬퍼.
- `matplotlib-24570`: 수치 하드코딩 대신 `{tuple(offsets_t), tuple(offsets_b)} == {tuple(offsets_l), tuple(offsets_r)}` 같은 **매핑 불변식**.
- `django-11885`/`14559`: `assertNumQueries` 정확치 대신 `assertLessEqual` / `int(matched)` 타입 robust 비교.

→ **핵심 품질 신호**: assertion이 "정답 동작을 핀하되, 환경/버전/타입 비결정 축은 의도적으로 느슨하게" 설계됨. fail-to-pass(수정 전 fail·수정 후 pass)는 지키면서 flaky-pass를 줄이는 균형. 이게 84%의 큰 비결.

---

## 5. 무엇이 "84%-quality"를 만드나 (종합)

isolated new-file 단순접근 대비, 이 예측들이 깔끔히 integrate·pass하는 구체 이유:

1. **타깃 테스트 파일 retrieval 후 in-place 편집** — 기존 클래스·setUp·import·helper를 읽고 그 위에 메서드/클래스를 append. 그래서 import 누락·fixture 부재로 인한 collection error가 안 난다(§1).
2. **컨벤션 모방** — 모델은 동반 `models.py`에, import는 알파벳 위치에, docstring underline 스타일까지(§1·§2). 그래더의 테스트 수집·실행 경로에 자연 편입.
3. **repo fixture/내부 심볼 재사용** — new-file조차 `SphinxTestApp`/`Pytester`/`_basic_auth_str` 등 repo 하네스를 import(§2). 셋업 부담을 repo에 위임 → 적은 코드로 정확.
4. **fail-to-pass oracle의 정밀+robust 균형** — 정답 동작 정확 단언 + 비결정 축 느슨화 + DB-feature skip 가드(§4). 수정 전엔 확실히 fail, 수정 후엔 환경 무관 pass.
5. **multi-test 커버리지** — positive/negative·happy/edge·low/high 쌍으로 채점 통과 확률과 회귀 강도 동시 상승(§3).
6. **디렉토리/명명 정확도 97%** — 올바른 test dir + 서술적 파일명(§2). 수집 누락 0에 가까움.

요약하면 84%는 "더 똑똑한 테스트 로직"보다 **"repo 테스트 스위트에 외과적으로 통합되는 능력 + 비결정성 회피 단언"**의 산물이다.

---

## 6. 우리가 흡수하려면 (repro-gen grounding seam에 직결)

우리 현 grounding(`src/agent/repro-test/grounding.ts`)은 **`stripTestBodies` → `exemplarBlock`/`signatureBlock`/`extractSignatures`로 본문을 제거한 skeleton만 프롬프트에 주입**한다(leak 방지가 설계 목표). L*Agent는 정반대 방향의 능력을 보여준다: **타깃 파일의 구조를 그대로 알고 그 안에 편집**한다. 흡수 항목 = "leak 없이 in-place 통합력을 더하기".

[absorbable] 구체 필요 부품:

1. **타깃 테스트 파일 선택 + 전체 구조 retrieval** — gold가 건드릴 (또는 동작 영역에 대응하는) 기존 테스트 파일을 고르고, 그 파일의 **class 목록·각 클래스 setUp/setUpTestData·전역 helper·import 블록**을 구조화해서 컨텍스트로 제공. 우리 `extractSignatures`를 클래스/메서드/fixture 시그니처까지 확장(본문은 여전히 strip → no-leak 유지). → §1의 awareness를 leak 없이 재현하는 핵심.
2. **insert-method vs new-file 결정기** — repo 테스트 조직 컨벤션 신호(타깃 영역에 매칭되는 TestCase 존재? 파일-당-주제 repo?)로 분기. matplotlib류는 new-file, django/sklearn류는 insertion. §0 분포가 라벨 근거.
3. **in-place 편집 출력 모드** — 현재 우리가 주로 new-file standalone을 emit한다면, "기존 클래스 끝 anchor 직후 메서드 append + import 라인 정밀 편집(알파벳 위치)" 패치를 생성하는 모드 추가. import-merge·anchor-locate가 미니 부품.
4. **동반 fixture 파일 편집** — django식 "테스트 모델은 별도 `models.py`" 같은 2-파일 패턴 지원(모델/픽스처를 동반 추가).
5. **assertion robustness 가이드** — 단언 생성 시 (a) 정답 동작 핀하되 (b) 타입/순서/버전/backend 비결정 축은 set-subset·불변식·`assertLessEqual`·DB-feature skip으로 느슨화하라는 시스템 프롬프트 규칙. §4가 그대로 레시피.
6. **multi-test 유도** — positive+negative 또는 happy+edge 쌍을 기본 1쌍 emit하도록(비용 거의 0, §3). 우리 location-fanout/effort-ladder와 직교.

[tie-in] 우리 메모리의 갭 진단(`jun-29-gap-essence`: localization은 거의 해결, 진범은 synthesis 수렴 + 단일-pass oracle 부재)과 정합. L*Agent의 84%는 synthesis를 **repo 인프라 재사용으로 단순화**해 얻는다 — 새 fixture를 합성하지 않고 기존 것을 호출하니 합성 부담이 작다. 따라서 우리 레버 1순위(oracle loop) 외에 **"타깃 테스트 파일 구조 retrieval → in-place 통합"**을 grounding seam에 추가하는 게 직접적 ROI. no-leak 불변식은 본문 strip은 유지하되 **구조(시그니처/fixture명/import)만 노출**하면 보존된다.

---

### 검토 인스턴스 (20+)
django: 13315, 14053, 15525, 11951, 11292, 11885, 16819, 14559 / sympy: 16792, 18189 / sklearn: 25931, 14983 / matplotlib: 24570 / astropy: 13977 / xarray: 3151 / sphinx: 8120 / requests: 6028 / pytest: 10081 — + repo별 분포 전수 집계(500).
