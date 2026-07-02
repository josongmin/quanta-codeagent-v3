# TEX-T (Salesforce) 예측물 딥리뷰 — SWT-bench Verified 87% (repro-script mode)

> 대상: `_predictions/tex-t_verified.jsonl` (433 entries). 각 entry는 `reproduce_script.py` 한 개를
> 생성하는 git diff. 모델명 필드는 실제로 `TEX-T Claude 4 Sonnet`. TEX-T 소스 비공개 →
> 이 JSONL이 유일한 ground truth.

## 0. 집계 사실 (measured)

- 433개 전부 `new file mode` + `reproduce_script.py` 생성 → **100% 새파일·100% 스크립트** [tag: VERIFIED]
- patch 크기: median 4443B, min 1185B, max 13936B (3개 시스템 중 최대) [tag: VERIFIED]
- repo 분포: django 216, sympy 73, matplotlib 32, sphinx 28, sklearn 24, astropy 17,
  xarray 15, pytest 15, pylint 6, requests 4, seaborn 2, flask 1 [tag: VERIFIED]
- 구조 신호 (433 중): `def main(` 431 · `sys.exit(` 433 · `traceback` 306 · `return 0` 274 ·
  `return 2` 274 · `return 1` 240 · `django.setup` 181 · `settings.configure` 167 ·
  `app_label` 105 · `tempfile` 112 · `subprocess` 55 · `def test_` 80 [tag: VERIFIED]
- 리뷰 표본: django/sympy/matplotlib/sphinx/sklearn/astropy/xarray/pytest/pylint/requests/seaborn/flask
  12개 repo에서 20+ instance 코드 직접 정독.

---

## 1. Self-contained 구조 — repo 테스트 프레임워크 없이 부트스트랩하는 법 [tag: EVIDENCE]

스크립트는 pytest/conftest/fixture를 일절 안 쓰고 `python reproduce_script.py` 단독 실행되도록
짠다. 4가지 부트스트랩 패턴이 반복된다.

**(P1) Django `settings.configure` + in-memory sqlite + `__main__` app_label**
django 167개가 `settings.configure`, 105개가 `app_label`을 씀. `__main__`을 INSTALLED_APPS에
넣어 스크립트 자기 자신을 앱으로 등록하고, 모델을 인라인 정의한다.

`django__django-10554`:
```python
if not settings.configured:
    settings.configure(
        DEBUG=True,
        DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}},
        INSTALLED_APPS=['django.contrib.contenttypes','django.contrib.auth','__main__'],
        USE_TZ=True,
    )
django.setup()
from django.db import models, connection
class Dimension(models.Model):
    name = models.CharField(max_length=100)
    order = models.IntegerField(default=0)
    class Meta:
        app_label = '__main__'
```
→ ORM 스키마는 `connection.schema_editor().create_model(Dimension)`로 런타임 생성. migration/
fixture 디렉터리가 전혀 필요 없다.

**(P2) 라이브러리 공개 API 직접 import (sympy/astropy/xarray/sklearn)**
`sympy__sympy-13031`: `import sympy as sy; sy.Matrix.hstack(...)` — repo 설치본의 실제 함수를 그대로 호출.
`astropy__astropy-12907`: `from astropy.modeling.separable import separability_matrix` 후
`separability_matrix(nested)` 직접 호출. 픽스처 없이 import만으로 버그 경로 진입.

**(P3) `tempfile.TemporaryDirectory`로 미니 프로젝트 합성 후 외부 CLI subprocess (sphinx/pylint)**
sphinx 28개 중 26개가 subprocess. `sphinx-doc__sphinx-8721`:
```python
with tempfile.TemporaryDirectory() as temp_dir:
    project_dir = Path(temp_dir) / "test_project"; project_dir.mkdir()
    conf_py_content = '''
extensions = ['sphinx.ext.autodoc', 'sphinx.ext.viewcode']
master_doc = 'index'
...'''
```
→ conf.py/index.rst를 손으로 써서 sphinx 빌드를 subprocess로 돌린다. tox/repo conftest 불요.

**(P4) 테스트 파일을 문자열로 써서 pytest를 subprocess로 호출 (pytest/일부 django)**
49개가 "파일 작성 → subprocess spawn" 패턴. `pytest-dev__pytest-10051`:
```python
def test_caplog_consistency(caplog):
    records_from_get_records = caplog.get_records("call")
    records_from_records = caplog.records
```
→ caplog 같은 fixture가 진짜 필요한 케이스는 test_*.py를 임시로 써서
`subprocess.run([...,'-v','-s'], capture_output=True)`로 실제 pytest를 돌리고 stdout을 파싱한다.
즉 fixture 의존을 "스크립트 안에서 자체 호스팅"한다.

---

## 2. Pass/fail 신호 — exit code로 reproduction 표현 [tag: EVIDENCE]

**일관 규약: exit 0 = fixed, exit 2 = bug 재현됨, exit 1 = error/import 실패.**
(sys.exit(0) 161, sys.exit(2) 161, sys.exit(1) 139; return 0/2/1 = 274/274/240)

`sympy__sympy-13031` (정규형):
```python
if actual_shape == (0, 6):
    print("✅ CORRECT ..."); return 0       # fixed
elif actual_shape == (0, 3):
    print("❌ BUG DETECTED ..."); return 2  # reproduced
...
except Exception as e:
    print(f"❌ ERROR ..."); return 2
...
if __name__ == "__main__":
    exit_code = main(); sys.exit(exit_code)
```

`django__django-11099`:
```python
return 2  # Issue exists, not yet solved
...
print("Issue status: SOLVED"); return 0  # Issue is solved
...
except ImportError as e: traceback.print_exc(); return 1
```

**같은 스크립트가 buggy→fixed로 exit 뒤집히는 메커니즘:**
스크립트는 *동일 코드*에서 실제 함수 출력값을 분기 조건으로 본다. patch 적용 전엔 버그 분기
(`(0,3)` / `nested_matrix[2,3]==True`)가 참 → return 2. patch 적용 후 동일 입력이 올바른 값
(`(0,6)` / `False`) 반환 → return 0. 즉 **오라클이 "실제 반환값 == 기대값"에 묶여 있어**, repo 패치가
값을 바꾸면 exit이 자동으로 0으로 플립한다. 단언 기반은 소수 (`assert ` 17, `raise AssertionError` 1) —
주류는 print + return-code 분기. SWT-bench 채점은 exit 0/1만 보므로(0=PASS), 이 규약이 그대로 채점기에 맞는다.

---

## 3. script-mode가 점수를 올리는 이유 — 회피하는 실패모드 [tag: ANALYSIS]

unit-test 모드(기존 repo 테스트 파일에 테스트를 끼워넣는 방식) 대비 standalone script가 구조적으로
피하는 깨짐들:

- **suite 통합/수집 실패 회피**: conftest.py·pytest plugin·marker·collection 규칙을 안 거친다.
  `python reproduce_script.py` 한 줄이면 끝 → "test not collected / wrong nodeid" 류 0건.
- **fixture mismatch 회피**: repo fixture 시그니처(예: db, settings, tmp_path 조합)를 정확히 맞출
  필요가 없다. 필요한 것(P1 settings.configure, P3 temp project)을 *스스로 만든다*. django 167개가
  실제 repo test settings 대신 자작 in-memory 설정을 쓰는 이유.
- **import error into existing file 회피**: 기존 파일을 수정하지 않고 **새 파일만** 생성(433/433)하므로
  기존 import 트리·`__init__` 부작용·상대 import 깨짐이 발생할 수 없다.
- **버전/era 의존 fixture 회피**: tox env, repo의 test deps 핀과 무관. 라이브러리 공개 API만 부르면 됨(P2).

요컨대 "테스트가 *수집되고 import되어 실행 지점까지 도달*"하는 확률이 1에 가까워진다. SWT-bench는
"버그 재현 테스트를 만들어라"는 과제라, 도달성 자체가 점수의 큰 몫이고 script-mode가 그걸 최대화한다.
87% > unit-test 시스템의 핵심은 **재현 코드의 실행 도달성 극대화 + exit-code 규약이 채점기와 직결**.

---

## 4. 약점 — standalone 부트스트랩이 실제 repo 동작에서 발산할 위험 [tag: WEAKNESS]

script-mode는 게임 가능하다. 실제로 "진짜 코드 경로를 안 건드리는" 사례가 있다.

**(W1) 자체 monkey-patch로 "fix를 증명" — repo 패치를 전혀 검사하지 않음.** `psf__requests-5414`:
```python
def fixed_prepare_url(self, url, params):
    original_prepare_url(self, url, params)
    ...
    if ':' in url and not url.lower().startswith('http'): return
PreparedRequest.prepare_url = fixed_prepare_url   # 스크립트가 직접 패치 주입
```
tail:
```python
works = test_with_permanent_monkey_patch()
if works: ... sys.exit(0)   # "monkey patch가 동작하니 SOLVED"
```
→ 오라클이 **repo의 실제 prepare_url이 아니라 스크립트 내부 monkey-patch**에 걸려 있다. repo 패치가
없어도 0을 낼 수 있는 strawman. fail-to-pass 의미가 깨지는 전형.

**(W2) soft/우회 오라클 — 핵심 행위 대신 "노출 여부"만 본다.** `scikit-learn__scikit-learn-13496`:
```python
if constructor_exposed:
    print("ISSUE SOLVED: warm_start is properly exposed in constructor")
    return 0
else:
    if not functionality_works: return 1
    return 2
```
주석에 "Documentation is nice to have but not strictly required" — 이슈의 일부만 좁게 검증.
실제 warm_start *증분 학습 동작*이 아니라 생성자 인자 존재만 본다 → 약한 fix도 통과 가능.

**(W3) reimplementation/simulate 어휘 다수.** simulate 27, mock 30, `def _` 36, "our own" 1,
"copy of the" 2. 대부분은 실제 API를 부르되 *상황만* 재현하지만(예: `django-11333`의
`get_resolver(None)` 직접 호출 — 진짜 코드), W1처럼 *로직을 다시 구현*하는 케이스가 섞여 있어
표면 grep으로는 구분이 안 된다. → script-mode는 "실제 경로 호출"과 "재구현 strawman"을 외형이 같게
만들 수 있다는 게 구조적 취약점.

**(W4) subprocess+stdout 문자열 파싱 오라클의 취약성.** `pytest-dev__pytest-10051`은
`if "BUG DETECTED" in output: return 2`처럼 *자기 출력 문자열 매칭*으로 판정. 출력 포맷이 곧 오라클 →
실제 어서션이 아니라 print 컨벤션에 의존. 깨지기 쉽고 false-pass 여지.

종합: 12개 repo 표본에서 명백한 strawman/soft-oracle은 소수(requests·일부 sklearn)지만 **0이 아니며**,
script-mode 특성상 "실제 버그 경로를 안 타도 exit 0이 나오는" 게임이 가능하다는 점은 확정.

---

## 5. Assertion/oracle 설계 — post-fix 정답 행위를 검증하나? [tag: EVIDENCE]

- **구체값 비교 오라클** (`expected/assert ... == / !=`) ≈ 18개. 강한 케이스:
  `astropy__astropy-12907`은 `separability_matrix(nested)`의 특정 셀
  `nested_matrix[2,3]`/`[3,2]`가 fixed에선 `False`여야 함을 명시적으로 본다 → post-fix 정답 단언.
  `sympy-13031`은 `(0,6)` 정확 형상, `xarray-3095`는 copy 후 dtype 보존(`<U*` 유지)을 본다.
- 다수는 "버그 분기 도달 = return 2, 정상값 = return 0" 형태로, **암묵적으로 post-fix 정답을 인코딩**한다
  (정상값 분기가 곧 기대 행위). 즉 단언문은 적지만 분기 조건이 오라클 역할.
- 다만 W2/W4처럼 *후행 정답*이 아니라 *증상 부재/노출 여부/print 문자열*로 판정하는 약한 오라클이
  섞여 있어, 전부가 "정답 행위 검증"은 아니다. 강오라클:약오라클 ≈ 다수:소수.

---

## 6. 흡수 가능성 — 우리가 script-mode를 타깃해야 하나? [tag: ANALYSIS]

우리 작업(SWE-bench: 버그 *수정 패치* 생성, repo 테스트로 채점)과 SWT-bench(버그 *재현 테스트* 생성)는
과제가 다르다. 그래서 직수입이 아니라 두 갈래로 본다.

**A. 우리의 fix용 repro 오라클(repair-rail self-test)에 적용 — 추천.**
우리 메모리의 갭 본질은 "맞는 파일 짚고 edit 수렴 실패"이고, 오라클 루프 부재가 천장이었음
(`jun-29-gap-essence`, `jun-28-closure-repair-false-green-root`). TEX-T식 **self-contained exit-code
repro 스크립트**는 우리 repair phase의 *값싼 그라운딩 오라클*로 쓰기 좋다:
- P1(settings.configure/`__main__` app_label)·P2(공개 API 직접 호출)·P3(temp project + subprocess)는
  우리 grounding/repro-gen에 그대로 이식 가능한 부트스트랩 레시피.
- exit 2(buggy)/0(fixed) 플립이 우리 fail-to-pass 오라클 게이트(이전에 약한 `test_exit_zero`가
  false-green 냈던 자리)를 **값 기반**으로 강화한다.

**B. SWT-bench 점수 자체를 노리는 건 비추천 (measure-first 없이 채택 금지).**
- script-mode는 §4의 strawman/soft-oracle로 게임 가능 → 우리 `no-answer-key`·
  `claim-100-needs-3-adversarial-audits` 원칙과 충돌. 채택 시 "실제 코드 경로 호출 증명"
  (W1 monkey-patch 금지, 실 import 강제) 가드가 선결.
- unit-test 모드 대비 트레이드오프: script-mode는 *도달성↑·통합현실성↓*. 우리 SWE-bench 채점은 repo의
  진짜 test suite로 돌므로, script가 통과해도 repo 패치 정합성은 별도. 따라서 script는 *내부 오라클*로만,
  채점 신호로는 기존 repo test 유지가 맞다.

**결론**: 부트스트랩 레시피 4종(P1–P4)과 exit-code 값 오라클 규약은 우리 repair/repro-gen 오라클로
흡수 가치 높음(default-OFF knob → A/B). SWT-bench 점수 추격 자체는 게임성 때문에 보류, 흡수 시
"실 코드 경로 호출 증명 + 구체값 단언" 가드 필수.

---

### 부록 — 인용 instance 인덱스
django-10554(P1), sympy-13031(P2/exit규약), astropy-12907(강오라클), sphinx-8721(P3),
pytest-10051(P4/문자열오라클), xarray-3095(dtype단언), django-11099(exit규약),
django-10914(simulate-실API), django-11333(simulate-실API), matplotlib-26466,
requests-5414(W1 monkey-patch), sklearn-13496(W2 soft-oracle), pylint-4970(P3).
