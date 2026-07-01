# ReProAgent (Nanjing U.) 예측 deep-review — SWT-bench Verified, GPT-5-mini, 69.7%

대상: `reproagent/outputs_gpt_5_mini/repro_agent_preds_gpt_5_mini_verified.jsonl` (431 instances)
각 patch는 `tests/test_repro_agent_<instance>.py` 라는 **새 파일 1개**를 생성하는 git diff.
교차검증: `reproagent/src/` (prompt_template.py, generator.py).

## 0. 전수 통계 (재측정, async-aware)

| 지표 | 값 | 비고 |
|---|---|---|
| 100% new-file | 431/431 | 기존 파일 insert 0건 |
| test fn 분포 | 1=416, 0=10, 2=5 | single-test가 사실상 강제 |
| 0-test (shim-only) | 10 (전부 sphinx) | 테스트 함수 없는 conftest급 파일 |
| TestCase-class 스타일 | 212 | 주로 django |
| bare-function 스타일 | 209 | 주로 sympy/sklearn/mpl/astropy |
| `import pytest` | 66 | |
| `@pytest.fixture` 자체정의 | 1 | **fixture는 거의 안 만든다** |
| skip guard (skipif/importorskip/skipTest) | 9/431 | 거의 없음 |
| private attr poke (`._x=`) | 8 | |
| message/string-substring assert | 23 | 메시지 문자열 검사 |
| monkeypatch/spy 기반 | 19 | |

[FACT] 설계 의도가 source에 박혀 있음:
- `prompt_template.py:127` — `5. The test should only contain ONE test function that reproduces the bug`
- `prompt_template.py:159` — `generate a self-contained test ... in a FRESH, ISOLATED Docker container`
- `prompt_template.py:164` — `4. Write ONE test function that reproduces the bug`
- `generator.py:269` — `file_path = f"{test_dir}/test_repro_agent_{instance_id}.py"` (파일명 하드코딩, 기존 파일 편집 경로 없음)

즉 "always-new-file + single-test"는 LLM 우발이 아니라 **아키텍처 강제**다. L*Agent의 "기존 파일에 70.8% insert + fixture 재사용"과 정반대 설계점.

---

## 1. New-file isolation — 격리 파일은 fixture를 어떻게 조달하나

핵심 발견: ReProAgent의 격리 파일은 **dangling이 거의 없다.** repo object를 쓸 때 거의 항상 (a) import, (b) inline 정의, (c) runtime resolve 중 하나로 토대를 마련한다. "isolated new file = broken integration"이라는 순진한 가설은 틀렸다 — gpt-5-mini가 의외로 조달에 성실하다.

조달 패턴 4종:

**(a) repo의 기존 test-app model을 그대로 import (= L*Agent식 fixture 재사용)** — django에서 4건.
[FACT] `django__django-15280`:
```python
from tests.prefetch_related.models import Author, Bio, Book
...
book = Book.objects.create(title="Test Book")
author = Author.objects.create(name="Test Author", first_book=book)
```
이건 ReProAgent도 "기존 fixture model 재사용"을 할 줄 안다는 증거. 다만 격리 파일이라 **migration이 적용된 app인지**가 grading 환경에 달려있다 (별 파일이라 conftest/INSTALLED_APPS 보장이 약함).

**(b) inline 모델 정의** — 47건이 `class X(models.Model)`을 파일 안에서 직접 선언.

**(c) runtime resolve via `apps.get_model`** — User.objects를 쓰면서 import 없어 보이던 5건을 까보니 전부 안전 조달이었음.
[FACT] `django__django-13158`, `django__django-14017`:
```python
from django.apps import apps
User = apps.get_model('auth', 'User')   # import-time class 생성 회피
User.objects.create(username="repro_user")
```
주석까지 달려있음 — `avoiding import-time model class creation issues`. dangling 아님.

**(d) dynamic `type()` 모델 + schema_editor로 테이블 자작** — 9건. 가장 정교한 조달.
[FACT] `django__django-11885` (Referrer/SecondReferrer, repo-import 없음):
```python
class ReproTests(TransactionTestCase):
    available_apps = ['django.contrib.contenttypes']
    def test_combined_fast_delete_for_two_fks(self):
        suffix = uuid.uuid4().hex[:8]
        ReferrerAttrs = {"__module__": module, "unique_field": models.IntegerField(unique=True),
                         "large_field": models.TextField(),
                         "Meta": type("Meta", (), {"app_label": 'contenttypes'})}
        Referrer = type("ReferrerRepro%s"%suffix, (models.Model,), ReferrerAttrs)
        ...
        with connection.schema_editor() as schema_editor:
            schema_editor.create_model(Referrer); schema_editor.create_model(SecondReferrer)
        try:
            r1 = Referrer.objects.create(unique_field=1000, large_field="r1")
            ...
        finally:
            schema_editor.delete_model(SecondReferrer); ...   # teardown까지
```
`uuid` 접미사로 registry collision 회피, finally teardown, `apps.register_model` 가드 — 격리 파일 안에서 **DB fixture 전체를 self-bootstrapping**한다. `django__django-13363`(ReproTimeSlot), `django__django-15814`(proxy model setUp/tearDown)도 동일 패턴.

[ASSESS] 결론: `Number.objects` 같은 게 dangling으로 매달려 있는 케이스는 사실상 없다. ReProAgent의 isolation 비용은 "dangling 참조"가 아니라 **fixture를 매번 처음부터 재구축하는 비용**(dynamic type + schema_editor + uuid + teardown)이다. 이 self-bootstrap이 한 군데라도 환경 가정을 어기면(예: `available_apps` 라벨, SQLite pragma, schema_editor 트랜잭션) 전체가 무너진다. L*Agent는 그 토대를 repo가 이미 깔아둔 기존 파일에 얹어 이 리스크를 통째로 회피한다.

---

## 2. Single-test 한계 — 1개 테스트가 너무 좁은가

[FACT] 분포: 1-test 416, 2-test 5, 0-test 10. multi-test는 prompt가 막아서 거의 불가능.

좁아서 손해 보는 구체 케이스:

[FACT] `scikit-learn__scikit-learn-13439` (Pipeline `__len__`): 한 테스트에 `len(pipe)`와 `pipe[:len(pipe)]` 슬라이싱을 욱여넣음.
```python
def test_pipeline_len():
    assert len(pipe) == len(pipe.steps)
    sliced = pipe[:len(pipe)]
    assert isinstance(sliced, Pipeline)
    assert sliced.steps == pipe.steps
```
한 함수에 두 동작을 묶었지만 — 만약 `__len__`은 고쳐졌는데 슬라이싱 회귀가 따로 있으면, single fn은 첫 assert에서 멈춰 **나머지 fail-to-pass를 못 본다.** L*Agent라면 `test_len` / `test_getitem`을 별 함수로 분리해 부분 크레딧 + 세분 진단이 가능.

[FACT] `django__django-16256` (async related-manager): single fn 안에서 acreate/aget_or_create/aupdate_or_create **3개 async API를 순차 검증**.
```python
self.assertTrue(related_present, "acreate() ... should add the relation")
...
tag_beta, created_beta = await article.tags.aget_or_create(name="beta")
self.assertTrue(created_beta, ...)
```
SWT-bench의 fail-to-pass 카운팅은 함수 단위 — 3개 행위를 1함수로 묶으면 first-failing-assert에서 단락되어 coverage(gold가 기대하는 다중 메서드)를 못 채울 수 있다.

[ASSESS] single-test는 hit-rate에 양날: (장점) 1개 함수에 집중해 fail-to-pass를 확실히 1개는 건드림. (단점) gold test가 여러 메서드/엣지를 커버하면 **부분커버 → fail-to-pass 다중 항목 미충족**으로 깎인다. multi-test 부재가 L*Agent(84%) 대비 coverage 천장을 누르는 직접 요인.

---

## 3. Docstring/intent quality — 의도가 실행으로 번역되나

docstring 품질은 일관되게 높다. 대부분 "buggy가 X 하던 걸 fixed는 Y 해야 함 + 이 assert가 buggy에 FAIL/fixed에 PASS"를 명시. 하지만 **intent가 integration을 앞지르는** 케이스가 보인다.

[FACT] `astropy__astropy-13033` — 의도는 명확("required non-first column 제거 시 에러 메시지가 컬럼명을 명시해야") 하나 integration이 의심스러움:
```python
ts = TimeSeries(time=t, data={"flux": flux})
ts._required_columns = ["time", "flux"]      # private attr 직접 주입
with pytest.raises(ValueError) as excinfo:
    ts.remove_column("flux")
msg = str(excinfo.value)
assert "flux" in msg
assert ("required" in msg) or ("missing" in msg)
```
[ASSESS] 두 가지 취약점: (1) `_required_columns`를 public API 우회해 직접 set — gold test가 subclass의 `_required_columns` 선언으로 트리거한다면 **트리거 경로 불일치**로 같은 버그를 못 건드릴 수 있음. (2) 메시지 문자열 substring(`"flux" in msg`, `"required" in msg`) 검사는 fixed 코드의 정확한 워딩에 종속 — gold가 "missing"이 아니라 다른 표현을 쓰면 PASS 못 함. 의도는 완벽한데 실행 결합이 brittle.

[FACT] sphinx 10건은 intent조차 테스트로 번역 실패 — docstring/테스트 함수 없이 **shim만** 생성. `sphinx-doc__sphinx-8638`:
```python
if 'pkg_resources' not in sys.modules:
    _pkg = types.ModuleType('pkg_resources')
    def iter_entry_points(group, name=None): return iter(())
    _pkg.iter_entry_points = iter_entry_points
    sys.modules['pkg_resources'] = _pkg
```
이건 collection-error 회피용 monkeypatch일 뿐 reproduction이 아니다. `test_repro_agent_*.py` 파일명이라 pytest가 수집은 하지만 **fail-to-pass test가 0개** → 구조적으로 점수 불가. sphinx에서 ReProAgent가 약한 직접 증거(28건 중 10건이 이 degenerate 형태).

반대로 의도→실행이 잘 된 케이스: `sphinx-doc__sphinx-10449`는 `@pytest.mark.sphinx('text', testroot='ext-autodoc', confoverrides={...})` + `app` fixture로 repo harness에 제대로 결합. 즉 ReProAgent도 fixture 재사용을 할 줄은 알지만, **할 때와 못 할 때의 분산이 크다.**

---

## 4. Assertion design

[FACT] post-fix 정답행위 단언 원칙은 prompt에 명시되어(`prompt_template.py:160` "verify what the code SHOULD produce") 대체로 지켜짐. assert 분포: plain assert 229, unittest `self.assertX` 208, raises 13, 검사 전무 22(주로 shim/`assertNumQueries`-only).

좋은 설계:
- [FACT] `matplotlib__matplotlib-23314` — spy 카운터로 정답행위 관찰:
```python
spy_count = {"calls": 0}
def _spy_draw(renderer): spy_count["calls"] += 1; ...
ax1.set_visible(False); fig.canvas.draw()
# 기대: visible=False면 spy 미호출
```
실효과(draw 호출 여부)를 관찰 — 약한 tautology 아님.
- [FACT] `django__django-11885` — `assertNumQueries`/SQL capture로 "단일 combined DELETE + OR" 구조를 검사. 강한 behavioral assert.

취약 설계:
- message-substring 23건(§3 astropy-13033) — fixed 워딩 종속.
- skip guard는 9건뿐. [FACT] `django__django-11087`은 `if connection.vendor != "mysql": self.skipTest(...)` — grading 환경이 MySQL이 아니면 **skip → fail-to-pass 미충족**(SWT-bench는 skip을 pass로 안 침). 환경 가정이 빗나가면 조용히 0점.

[ASSESS] 단언 자체 품질은 중상. 문제는 단언이 아니라 (i) 트리거 경로(private poke), (ii) 환경 skip, (iii) 메시지 워딩 종속 — 전부 "격리 파일이 환경/구현 디테일을 스스로 다 가정해야 해서" 생기는 brittleness.

---

## 5. L*Agent(84%)와의 30%p 갭 — 예측에서 보이는 구체 실패모드

가설("isolation이 나쁘다")은 단순화. 예측 증거로 본 실제 갭 기여요인 (영향 추정 순):

1. **single-test coverage 천장** [FACT 416/431]. gold가 multi-method/multi-edge를 fail-to-pass로 요구하면 1함수는 부분커버 → 다중 fail-to-pass 미충족. §2의 13439/16256. L*Agent는 multi-test로 항목별 충족.

2. **fixture self-bootstrap의 fragility** [FACT dynamic type 9 + inline model 47]. 격리 파일이 model/table/registry를 매번 재구축(§1d) — `available_apps` 라벨·SQLite pragma·schema_editor 트랜잭션 중 하나만 어긋나면 collection/setup error로 전멸. L*Agent는 repo가 이미 migrate한 기존 test app 위에 얹어 이 표면적을 0으로 만든다 (그래서 insert 70.8%가 효율적).

3. **트리거 경로 불일치** [FACT private poke 8, message-substring 23]. §3 astropy-13033처럼 public API 대신 `._required_columns` 직접 주입 / 메시지 문자열 검사 → 같은 버그라도 gold와 다른 경로를 타 fail-to-pass 미스.

4. **degenerate shim** [FACT sphinx 10/28]. 테스트 함수가 아예 없는 collection-fix 파일 → 구조적 0점. sphinx 카테고리 자체를 끌어내림.

5. **환경-가정 skip** [FACT skipTest/skipif 9, 특히 vendor-gated]. grading 환경 불일치 시 skip=비-pass.

[ASSESS] 즉 갭은 "isolation이 곧 broken"이 아니라 — isolation이 강제하는 (a) single-test 좁힘, (b) fixture 재구축 표면적, (c) 환경/구현 디테일을 파일이 통째로 떠안는 brittleness의 **누적 손실**이다. L*Agent의 in-place insert는 이 셋을 동시에 줄인다(기존 fixture·multi-test·repo conftest 상속).

---

## 6. 우리(Agentless-style new-file)에게 흡수/경계 시사점

ReProAgent는 우리와 가장 가까운 analog (Agentless식 새-파일). 그 천장에서 배울 점:

- [흡수] **runtime resolve 패턴은 베껴라.** `apps.get_model('auth','User')`(§1c), dynamic `type()`+`schema_editor`+uuid teardown(§1d)은 격리 파일을 dangling 없이 self-bootstrap하는 검증된 레시피. 우리 새-파일 생성기가 import 못 거는 repo object를 만날 때 fallback으로 가치. (왜) dangling 참조 제거가 격리 접근의 가장 큰 즉사 원인인데 ReProAgent가 이미 해결책을 갖고 있음. (ROI) 중 — 우리 django 실패 일부에 직접 적용 가능.

- [경계] **single-test 강제는 천장이다.** prompt가 "ONE test function"을 박아 multi fail-to-pass를 구조적으로 포기 → 84% vs 69.7%의 큰 몫. 우리는 새-파일이어도 **함수는 여러 개** 뽑게 설계해야 L*Agent 천장에 근접. (왜) §2 증거가 single-test coverage 손실을 직접 보임.

- [경계] **새-파일은 fixture 재구축 표면적을 떠안는다.** 47 inline + 9 dynamic은 전부 환경 가정 risk. 가능하면 **기존 test 파일 insert(L*Agent식)를 1순위, 새-파일을 fallback**으로 두는 게 상한이 높다. ReProAgent가 4건만 `tests.*.models` 재사용한 건 능력이 아니라 **설계가 새-파일을 강제해서** 재사용 기회를 스스로 버린 것. (ROI) 고 — 우리 scaffold 분기 정책에 직결.

- [경계] **degenerate shim/메시지-substring/vendor-skip을 가드하라.** 테스트 함수 0개(§3 sphinx 10), 워딩 종속 assert(§3 astropy), 환경 skip(§4)은 전부 "조용한 0점". 우리 검증 단계에서 (i) 새 파일에 실제 test fn ≥1 존재, (ii) public-API 트리거 우선, (iii) skip은 pass로 안 침을 정적 가드로 잡으면 ReProAgent가 흘린 표를 회수 가능. (ROI) 중.

- [핵심 교훈] **Agentless식 새-파일의 천장 ≈ 70%대**가 gpt-5-mini에서 실측됨. isolation 자체는 잘 굴러가지만(dangling 거의 0), single-test + fixture 재구축 + 환경가정이 누적해 in-place insert(84%) 대비 ~14%p를 잃는다. 우리가 새-파일 접근을 채택한다면 이 셋을 명시적으로 보정하지 않는 한 같은 천장에 묶인다.
