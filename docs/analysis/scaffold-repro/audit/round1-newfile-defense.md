# Round-1 적대적 어딧: New-file 변호 (counterexample hunt)

목적: "new-file은 본질적으로 약하다(insertion이 우월)"라는 가설을 **반증**하는 사례를 찾는다.
즉 new-file이 성공하는 경우, 특히 insertion이 실패하는데 new-file이 성공하는 경우를 사냥한다.

대상 데이터 (전부 local `.extracted_source/repro-scaffolds/`):
- ReProAgent gpt-5-mini Verified: `repro_agent_preds_gpt_5_mini_verified.jsonl` + `ReProAgent.repro_agent_gpt_5_mini_verified.json` (431 inst, resolved 303, **per-instance resolved_ids 보유**)
- AssertFlip Verified: `assertflip_verified.preds.jsonl` + `assertflip_verified.evaluation.json` (326 inst, resolved 188, **per-instance resolved_ids 보유**)
- 대조군(insertion): e-Otter++ `eotter_plus_verified.evaluation.json` (432 inst, resolved 263, 100% existing-file-insert)
- 선행리뷰: `predictions-review/reproagent.md`, `predictions-review/otter-assertflip.md`

전수 재측정으로 100% new-file 확인 [verified]: ReProAgent 431/431, AssertFlip 326/326 모두 `new file mode == diff --git` 카운트 일치, insertion 0건.

---

## 1. New-file이 RESOLVED — 어떻게 fixture 없이 self-bootstrap 했나

resolved new-file 테스트의 부트스트랩 패턴을 전수 분류했다(added-lines만 파싱).

### 1-1. 부트스트랩 패턴 분포 (resolved 중)

| 패턴 | ReProAgent (n=303) | AssertFlip (n=188) |
|---|---|---|
| `sympy` public API (Symbol/symbols) | 52 (17.2%) | 33 (17.6%) |
| `numpy` 직접 | 43 (14.2%) | 24 (12.8%) |
| inline django `class X(models.Model)` | 33 (10.9%) | 24 (12.8%) |
| `schema_editor`/SchemaEditor 자작테이블 | 25 (8.3%) | 3 (1.6%) |
| `matplotlib` public API (plt./Figure()) | 23 (7.6%) | 19 (10.1%) |
| `isolate_apps` | 20 (6.6%) | — |
| `override_settings`/`settings.configure` | 19 (6.3%) | 8 (4.3%) |
| `tmp_path`/`tempfile` 자작 | 10 (3.3%) | 7 (3.7%) |
| `RequestFactory` | 5 (1.7%) | 1 (0.5%) |
| `apps.get_model` runtime resolve | 4 (1.3%) | — |

→ **dangling이 아니라 성실한 self-bootstrap이 다수.** "isolated file = broken integration" 가설은 데이터로 반증됨.

### 1-2. 성공한 self-bootstrap 카테고리 (실 코드 인용)

**(a) public-API only — fixture가 애초에 불필요한 케이스** [verified]
ReProAgent `sympy__sympy-13480` (resolved): 20줄, import 1줄, 함수 1개. 레포 fixture 0.
```python
from sympy import Symbol, coth, log, tan, S
def test_coth_log_tan_subs_evaluates_to_finite_value():
    x = Symbol('x')
    e = coth(log(tan(x)))
    res = e.subs(x, 2)
    assert res is not S.ComplexInfinity
```
이 부류(sympy/numpy/matplotlib public API)는 insertion이 줄 수 있는 "기존 import/fixture 상속"의 이득이 **0**이다. 자작 import만으로 완결.

**(b) inline model + `schema_editor`/raw DDL — 가장 정교한 조달** [verified]
ReProAgent는 25건, AssertFlip은 적지만 존재. e.g. AssertFlip `django__django-11179` (new-file이 insertion을 이긴 케이스):
```python
class SimpleModel(models.Model):
    name = models.CharField(max_length=100)
    class Meta: app_label = 'test_app'
class DeleteModelTestCase(TestCase):
    def setUp(self):
        with connection.cursor() as cursor:
            cursor.execute('CREATE TABLE IF NOT EXISTS test_app_simplemodel (...);')
        self.instance = SimpleModel.objects.create(name="Test Name")
```
fixture가 없어도 **테이블을 손수 깔아** 토대를 만든다. insertion이 상속받는 migration된 app을 new-file이 명시적으로 재현.

**(c) test-app 등록 — `modify_settings`+`override_settings`+`available_apps`** [verified]
ReProAgent `django__django-11066` (resolved): 격리 파일이 INSTALLED_APPS에 test app을 append하고 MIGRATION_MODULES를 덮어써서 `TransactionTestCase`로 다중 DB 라우팅까지 재현.
```python
@modify_settings(INSTALLED_APPS={'append': 'contenttypes_tests'})
@override_settings(MIGRATION_MODULES=dict(settings.MIGRATION_MODULES,
    contenttypes_tests='contenttypes_tests.operations_migrations'))
class ReproTests(TransactionTestCase):
    databases = ('default', 'other')
    available_apps = ['contenttypes_tests', 'django.contrib.contenttypes']
```
이건 L*Agent식 "기존 test app 상속"을 **선언적으로 재구성**한 것. new-file이라서 못 하는 게 아니다.

**(d) `isolate_apps` + 방어적 fallback shim** [verified]
ReProAgent `django__django-11095` (resolved): 환경에 `isolate_apps`가 없을 수 있다고 가정하고 try/except로 no-op decorator를 직접 정의. 격리 파일이 grading 환경 변동까지 흡수.
```python
try:
    from django.test import isolate_apps
except Exception:
    def isolate_apps(label):
        def decorator(fn): return fn
        return decorator
```

**(e) runtime resolve `apps.get_model` — import-time class 생성 회피** [verified]
`django__django-13158`, `-14017`: `User = apps.get_model('auth','User')`로 import 부작용 없이 조달, 주석에 의도 명시(`avoiding import-time model class creation`). dangling 아님.

→ **결론(1):** bootstrap이 제대로 되면 new-file은 insertion이 주는 fixture 상속의 이득을 대부분 자력으로 재현한다. 격차의 원인은 "new-file이라서"가 아니라 "bootstrap을 틀렸을 때"다.

---

## 2. Repo 패턴 — new-file 성공은 insertion-hostile 레포에 집중되나

### 2-1. 레포별 resolved-rate (new-file 시스템)

| repo | ReProAgent | AssertFlip |
|---|---|---|
| scikit-learn | 22/24 **91.7%** | 16/24 66.7% |
| astropy | 12/16 75.0% | 13/16 **81.2%** |
| django | 160/216 74.1% | 81/138 58.7% |
| sympy | 54/73 74.0% | 34/61 55.7% |
| pytest-dev | 11/15 73.3% | 3/12 25.0% |
| **matplotlib** | 23/32 **71.9%** | 19/29 **65.5%** |
| pydata/xarray | 10/15 66.7% | 10/14 71.4% |
| pylint-dev | 2/5 40.0% | 3/5 60.0% |
| **sphinx-doc** | 6/28 **21.4%** | 6/20 **30.0%** |

### 2-2. matplotlib — new-file이 "올바른 도구"인 직접 증거 [verified]
resolved matplotlib 테스트 중 **mpl 전용 insertion-coupled 데코레이터(`@image_comparison`, `@check_figures_equal`, `mpl_test_settings`)를 쓴 건 0건**. ReProAgent 23/23, AssertFlip 19/19 전부 **pure public API**(`Figure`, `plt.`)로 성공.
e.g. `matplotlib__matplotlib-23476`: `from matplotlib.figure import Figure` 하나로 pickle/unpickle DPI-doubling을 재현. 기존 mpl 테스트 파일에 insert해봐야 상속할 fixture가 없다(이미지비교 데코레이터는 새 버그재현에 무관/방해). matplotlib은 insertion 이득이 구조적으로 작은 레포 → **new-file이 약한 게 아니라 적합하다.**

### 2-3. sphinx — 진짜 new-file 약점이 드러나는 곳 (가설 qualifier) [verified]
sphinx는 양 시스템 다 최저(21%/30%). 28건 중 10건이 `app.build`/`SphinxTestApp`/`@pytest.mark.sphinx`/`rootdir` 류 **풀 app-build fixture가 필요한 시그니처**. 이건 conftest+테스트 루트 디렉토리에 결합돼 있어 격리 파일이 재현하기 비싸다.
resolved sphinx 6건은 전부 **풀빌드를 우회**: Catalog/Message 객체를 직접 때리거나(`-10466`), 작은 패키지 + text builder만 돌리거나(`-10449`), pkg_resources shim을 손수 깐다(`-9320`). 즉 sphinx에서도 bootstrap을 우회 설계하면 통과하지만, app-build 결합이 강한 케이스에서 new-file 비용이 실제로 높다.

→ **결론(2):** new-file 성공은 insertion 이득이 작은 레포(matplotlib/astropy/sympy public-API)에 강하게 집중. new-file의 실제 약점은 "conftest/app-build에 깊게 결합된 레포(sphinx)"로 **국소화**된다. 범용 "약함"이 아니다.

---

## 3. Single-test로도 resolved 되나 — 언제 1개면 충분한가

ReProAgent는 99% single-test(아키텍처 강제: `prompt_template.py:164` "Write ONE test function"). 그럼에도:

| | single-test(≤1) resolved | multi-test(≥2) resolved |
|---|---|---|
| ReProAgent | **300** | 3 |
| AssertFlip | **184** | 4 |

test-count 분포(resolved): ReProAgent {1:300, 2:3}, AssertFlip {1:184, 2:3, 4:1}.

→ **single-test가 압도적으로 충분하다(resolved의 ~98%).** SWT-bench의 fail-to-pass 판정은 "버그를 때리는 단 하나의 assertion"만 있으면 충족되므로, 한 버그=한 재현경로인 케이스에서 multi-test는 불필요. multi-test가 가치 있는 건 (a) 여러 분기/입력을 동시에 커버해야 fail-to-pass가 잡히는 소수 케이스뿐. **"multi-test가 필요하다"는 일반 주장은 데이터로 반증** — 필요한 건 *맞는* 1개지 *여러* 개가 아니다.

---

## 4. 적대적 종합 — 격차는 insertion-vs-newfile이 아니라 bootstrap/assertion/repo다

### EVIDENCE-A: new-file이 insertion을 이기는 33건이 존재 [verified, strongest]
동일 instance 공유집합(325)에서 AssertFlip(100% new-file) vs e-Otter++(100% insertion) head-to-head:
- both resolved: 154
- **new-file ONLY resolved (insertion 실패): 33**
- insertion ONLY resolved (new-file 실패): 65
- neither: 73

new-file이 **strictly dominated가 아니다.** 33건에서 new-file이 더 나았다(django 13, sympy 6, astropy 4, sphinx 4, ...). 예: `astropy__astropy-14182`는 `io.StringIO()`로 파일시스템 fixture를 우회해 통과 — insertion이 상속하는 컨벤션이 오히려 불필요. **"insertion 우월"은 평균값일 뿐 방향이 일정하지 않다.**

### EVIDENCE-B: ReProAgent(new-file) 70% > e-Otter++(insertion) 60.9% [verified]
같은 Verified split에서 100% new-file 시스템(ReProAgent 303/431=70.3%)이 100% insertion 시스템(e-Otter++ 263/432=60.9%)보다 **높다**. integration-style이 1차 결정변수라면 일어날 수 없는 순위. 1차 변수는 모델/부트스트랩 품질이지 파일전략이 아니다.

### EVIDENCE-C: 격차의 65건은 repo로 설명된다 (insertion-only wins by repo) [verified]
insertion이 이긴 65건의 분포: django 31, sympy 14, matplotlib 6, sklearn 5, **pytest-dev 4**. pytest-dev/sphinx처럼 conftest/플러그인 결합이 강한 레포에 insertion 이득이 몰린다. 즉 insertion의 우위는 **특정 레포의 fixture 결합도**에서 나오지, new-file의 일반적 결함에서 나오지 않는다.

### EVIDENCE-D: resolved new-file의 ~50%는 bootstrap이 애초에 trivial한 부류 [verified]
resolved 중 sympy/numpy/matplotlib public-API + inline-model 합산이 ReProAgent ~50%, AssertFlip ~53%. 이 부류는 insertion이 줄 fixture 상속 이득이 0. 따라서 전체 갭의 분모 절반은 integration-style과 **무관**.

### EVIDENCE-E: 실패의 국소화 — sphinx app-build 결합 [verified]
new-file이 진짜 비싼 곳은 sphinx(21%/30%)뿐이고, 그 원인은 `app.build`/`SphinxTestApp` 풀빌드 fixture(10/28). 이건 "richer retrieval"로 conftest 루트/test-root skeleton을 주입하면 격리 파일에서도 재구성 가능한 종류(EVIDENCE 1-2의 (c)(d) 패턴이 이미 증명).

### 종합 주장: "retrieval-richer new-file"이 full insertion 재작성 없이 격차 대부분을 닫는다
- 갭의 절반(EVIDENCE-D)은 bootstrap-trivial이라 닫을 것도 없다.
- 33건(EVIDENCE-A)은 new-file이 이미 이기고 있다.
- 남는 insertion 우위 65건(EVIDENCE-C)은 fixture 결합이 강한 레포에 집중 → 해법은 "기존 파일에 insert"가 아니라 "관련 test-app model / conftest skeleton / schema_editor 레시피를 **검색해서 격리 파일이 self-bootstrap에 쓰게** 주입"이다. EVIDENCE 1-2 (c)(d)(e)는 gpt-5-mini가 그 레시피를 받으면 격리 파일에서도 재현 가능함을 이미 입증.
- 따라서 **architecture를 insertion으로 갈아엎을 ROI는 낮다.** 레버는 bootstrap correctness(test-app 등록/스키마 조달/conftest skeleton retrieval)와 assertion quality(맞는 1개)이지 file-placement가 아니다.

---

## 10줄 요약 (new-file을 변호 / 가설 qualify)

1. ReProAgent/AssertFlip 모두 전수 100% new-file 확인. dangling이 아니라 성실한 self-bootstrap이 다수다.
2. resolved의 ~50%는 sympy/numpy/matplotlib public-API라 insertion 이득이 구조적으로 0 — 갭과 무관한 분모.
3. 가장 강한 반증: AF(new-file) vs eOtter(insertion) 공유 325건에서 **new-file ONLY 성공 33건** — strictly dominated 아님.
4. 같은 Verified split에서 ReProAgent(new-file 70.3%) > e-Otter++(insertion 60.9%) — file-strategy가 1차 변수면 불가능한 순위.
5. matplotlib resolved 전건이 pure public API, mpl insertion-coupled 데코레이터 0건 — new-file이 약한 게 아니라 *적합한* 레포.
6. new-file 성공한 정교 부트스트랩: `modify_settings`+`available_apps` test-app 등록, `schema_editor`/raw `CREATE TABLE`, `apps.get_model` runtime resolve, `isolate_apps` fallback shim.
7. single-test resolved 300/303·184/188 — multi-test 불필요. 필요한 건 *여러* 개가 아니라 *맞는* 1개.
8. new-file의 진짜 약점은 sphinx(21%/30%)로 국소화 — 원인은 app-build 풀빌드 fixture 결합(10/28), 범용 약점 아님.
9. insertion 우위 65건은 django/sympy/pytest 등 fixture 결합 강한 레포에 집중 — repo 효과지 integration-style 효과 아님.
10. 결론: 격차는 insertion-vs-newfile이 아니라 **bootstrap correctness + assertion quality + repo fixture 결합도**. "retrieval-richer new-file"(test-app/conftest skeleton 주입)로 full insertion 재작성 없이 대부분 닫을 수 있다.
