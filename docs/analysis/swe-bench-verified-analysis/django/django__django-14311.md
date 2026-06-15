---
instance_id: django__django-14311
repo: django/django
base_commit: 5a8e8f80bb82a867eab7e4d9d099f21d0a976d22
version: "4.0"
difficulty: 15 min - 1 hour
created_at: 2021-04-25T02:54:34Z
fail_to_pass: 1
pass_to_pass: 59
gold_files: [django/utils/autoreload.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

# django__django-14311

## 문제 요약
`python -m foo.bar.baz runserver`처럼 패키지가 아닌 단일 모듈(`foo/bar/baz.py`)을 dotted name으로 실행하면 autoreloader가 자식 프로세스를 재실행할 때 인자를 `-m foo.bar`로 잘못 만든다. 마지막 컴포넌트 `baz`가 통째로 잘려 엉뚱한 모듈이 재실행되거나 리로드가 실패한다. 기존 픽스(commit ec6d2531)는 `-m foo.bar`처럼 `bar`가 패키지이고 `foo/bar/__main__.py`가 존재하는 케이스만 처리했고, 일반 모듈을 dotted name으로 직접 실행하는 케이스는 누락됐다. 리포터는 `foo/bar/manage.py`를 `-m foo.bar.manage runserver`로 실행했을 때 Django 3.1처럼 정상 리로딩되길 기대했으나 마지막 컴포넌트가 잘려 실패했다.

## 유형 (정형화)

- **L0 (Pinpointed)** — problem_statement가 "autoreloading", "python -m", "the resulting arguments end up being `-m foo.bar`"라는 정확한 증상에 더해 원인 커밋 ec6d2531을 직접 링크한다. 그 커밋이 손댄 곳은 `django/utils/autoreload.py`의 `get_child_arguments()` 단 하나의 `__spec__.parent` 분기다. grep 한 방에 수정 지점이 확정된다. localize 노력 거의 0.
- **S2 (Constraint-Reasoning)** — 고칠 줄은 알지만 *올바른 분기 조건을 추론으로 합성*해야 한다. 핵심은 `__spec__.parent`(소속 패키지명)와 `__spec__.name`(모듈 fully-qualified name)의 의미 차이다. 패키지의 `__main__.py`를 실행한 경우(`spec.name`이 `__main__` 또는 `*.__main__`)에만 `parent`가 옳고, 단일 모듈을 직접 실행한 경우엔 `spec.name`을 써야 한다. 후보 패치를 마구 던져 테스트로 수렴시키는(S3/S4) 문제가 아니라, import 머신리의 불변식을 따져 "생각으로" 정확한 조건식을 짜는 문제다. SemFix/Angelix 계열의 condition synthesis.
- **K-Gen** — 필요한 지식은 django 내부(ORM/migrations/query-compiler)가 아니라 Python stdlib import system(`ModuleSpec.name`/`parent`)과 `runpy.py` 관례다. django-domain 병목이 아니므로 K-Gen. 다만 `endswith('.__main__')`이 runpy가 쓰는 정확한 컨벤션이라는 점은 약한 API-contract 색채가 있다(K-API 보조 성격이나 dominant 아님).
- **primary type = T-ConstraintReason** — L0로 위치는 명확하지만 픽스가 S1(가드 추가/상수 변경) 같은 기계적 템플릿이 아니라 두 가지 실행 모드를 구별하는 조건식 합성이 본질이기 때문. T-DirectMap이 아닌 이유: 단순히 `if x is not None` 가드를 추가하는 게 아니라 `parent` vs `name` 선택 로직을 새로 도입해야 한다.

## 난이도 티어
**T3 (중간).** 공식 라벨은 "15 min - 1 hour"(T2~T3 prior).
- 이 티어로 미는 피처: 단일 파일·단일 함수·소규모 헌크(+6/-1 라인)이지만 **localize는 직접(L0)인데 실질 추론(S2)이 끼어 있어** T2가 아니라 T3. 분기 조건이 미묘해서 한쪽(단일 모듈)을 고치면서 다른 쪽(패키지 `__main__`)을 깨기 쉽다.
- `has-repro`: problem_statement에 정확한 재현 명령(`-m foo.bar.baz runserver`)과 원인 커밋이 있어 easiness를 끌어올린다 → T4 이상으로 가지 않는 강한 신호.
- `regression-trap`: PASS_TO_PASS가 59개로 넓고, 그 중 `test_run_as_non_django_module`(패키지 `__main__` 케이스), `test_run_as_module`, `test_module_no_spec` 등 동일 함수의 인접 분기를 직접 보호한다. parent 우선순위를 잘못 잡으면 이들이 깨진다. 단, 트랩이 같은 함수 내부에 국소화돼 있어 T4까지 밀지는 않음.
- 공식 라벨과 큰 차이 없음(T3는 prior와 정합). T1/T2가 아닌 이유는 픽스가 S1 자명 변경이 아니라 import-spec 시맨틱 추론이 필요해서.

## 골드패치 분석
- **건드린 파일·함수**: `django/utils/autoreload.py` → `get_child_arguments()`
- **근본 원인**: 기존 코드는
  ```python
  if getattr(__main__, '__spec__', None) is not None and __main__.__spec__.parent:
      args += ['-m', __main__.__spec__.parent]
  ```
  로 `__spec__.parent`를 무조건 `-m` 인자로 사용했다. `__spec__.parent`는 모듈이 *속한 패키지명*이다. `-m foo.bar.baz`로 단일 모듈 `baz`를 실행하면 `spec.name == 'foo.bar.baz'`, `spec.parent == 'foo.bar'`가 되어 `-m foo.bar`로 잘리며 `baz`가 누락된다. `parent`가 옳은 경우는 오직 패키지의 `__main__.py`를 실행할 때(`-m foo.bar` → `spec.name`이 `foo.bar.__main__`, `parent`가 `foo.bar`)뿐이다.
- **수정 요지**: `__spec__`가 존재할 때 `spec.name`을 검사해 두 모드를 구별한다.
  ```python
  if getattr(__main__, '__spec__', None) is not None:
      spec = __main__.__spec__
      if (spec.name == '__main__' or spec.name.endswith('.__main__')) and spec.parent:
          name = spec.parent
      else:
          name = spec.name
      args += ['-m', name]
  ```
  패키지 `__main__` 실행이면(`spec.name`이 `__main__` 또는 `*.__main__`) `spec.parent`를 쓰고, 그 외(일반 모듈을 dotted name으로 직접 실행)엔 `spec.name`을 그대로 넘겨 full dotted name을 보존한다. 코어 리뷰어 힌트대로 `name.split('.')[-1] == '__main__'` 대신 `endswith('.__main__')`을 채택해 `foo.my__main__` 같은 코너 케이스 오탐을 피한다(runpy.py가 쓰는 방식).

## 검증 (test_patch)
- **FAIL_TO_PASS (1)**: `test_run_as_non_django_module_non_package (utils_tests.test_autoreload.TestChildArguments)`. 패키지가 아닌 일반 모듈을 dotted name으로 실행한 시나리오를 검증한다. 새 fixture `tests/utils_tests/test_module/main_module.py`를 추가하고 `sys.modules['__main__']`을 그 모듈로 mock, `sys.argv`/`sys.warnoptions`를 패치한 뒤 `get_child_arguments()`가 `[sys.executable, '-m', 'utils_tests.test_module.main_module', 'runserver']`를 반환하는지 확인한다 → 마지막 컴포넌트 `main_module`이 잘리지 않고 보존됨을 증명.
- **픽스 증명**: 기존 코드는 `spec.parent`(=`utils_tests.test_module`)를 반환해 `main_module`이 누락됐을 것이다. 픽스 후 `spec.name`이 `__main__`/`*.__main__`이 아니므로 else 분기로 `spec.name` 전체를 사용해 테스트가 통과한다.
- **overfit 관점**: FAIL_TO_PASS는 1개로 얇지만, 픽스가 단일 special-case 하드코딩이 아니라 두 실행 모드를 일반적으로 구별하는 조건식이라 overfit 위험은 낮다(`overfit-risk` 미부여). CEGIS(S4)가 아닌 S2 추론으로 풀리기 때문.
- **regression 관점**: PASS_TO_PASS 59개 중 같은 함수의 패키지 케이스를 보호하는 `test_run_as_non_django_module`(패키지 `__main__` → `spec.parent` 사용)이 핵심 가드다. 골드패치는 그 케이스를 `if (spec.name == '__main__' or endswith('.__main__')) and spec.parent` 분기로 그대로 보존하므로 회귀 없음. `test_module_no_spec`(spec 없음 → 다른 elif 분기)도 영향받지 않음.

## 모범답안 (오라클 기반)

1. **localize 경로**: problem_statement의 "autoreloading", "`python -m`", "the resulting arguments end up being `-m foo.bar`"와 직접 링크된 원인 커밋 ec6d2531을 따라간다. 커밋/키워드가 `django/utils/autoreload.py`의 `get_child_arguments()`, 그 안의 `__main__.__spec__.parent` 분기를 곧장 지목한다. `-m`과 `__spec__`을 함께 다루는 라인은 함수 내 하나뿐이라 수정 지점 확정.

2. **픽스 (왜 올바른 일반화인가)**: 버그의 본질은 "`parent`를 항상 쓴다"는 잘못된 가정이다. 올바른 일반화는 `__spec__.name`이 패키지 `__main__` 실행을 나타내는지를 판별해 그때만 `parent`로 축약하고, 그렇지 않으면 `name` 전체를 보존하는 것이다. 이는 단일 테스트를 통과시키는 special-case가 아니라 Python `-m` 실행의 두 모드(패키지 `__main__.py` vs 일반 모듈)를 import-spec 시맨틱에 따라 구분하는 정확한 분기다. 임의 입력(`foo.bar.baz.qux` 등 임의 깊이 dotted name)에도 일반적으로 옳다.

3. **regression 안전**: `test_run_as_non_django_module`(패키지 `-m utils_tests.test_module` 케이스, `spec.parent` 반환 기대)을 깨지 않아야 한다. 분기 순서를 `spec.name`이 `__main__`/`*.__main__`일 때 `parent` 사용으로 두면 기존 동작 보존. `spec` 없는 경로(`test_module_no_spec`)와 fallback 경로(`test_exe_fallback`, `test_entrypoint_fallback`)는 이 분기 밖이라 무영향. 59개 P2P 중 동일 함수 인접 분기들이 안전망.

4. **함정 회피 (오라클 없는 에이전트가 틀릴 지점)**:
   - 가장 흔한 실패: 기존 `if ... .parent:` 한 줄에 조건만 덧붙이려다 **parent 우선순위를 잘못 잡아** 패키지 케이스(`test_run_as_non_django_module`)를 회귀시킴. → parent는 `__main__` 패턴일 때만 쓴다는 점을 명확히.
   - `__main__` 판별을 `name.split('.')[-1] == '__main__'`로 짜면 동작은 비슷하나 `foo.my__main__`처럼 마지막 컴포넌트가 `__main__`을 포함하는 이름에서 오탐이 날 수 있다. `endswith('.__main__')`(+ top-level `== '__main__'`)이 runpy 관례에 맞는 안전한 판별. 명시적 힌트 없이는 이 미세 차이를 놓치기 쉬움 → import/runpy 시맨틱을 정확히 알아야 함.
   - `spec.parent`가 비어있는 경우(`and spec.parent` 가드)를 떨어뜨리면 빈 `-m` 인자가 생길 수 있으니 패키지 분기에도 `spec.parent` 존재 검사를 유지해야 한다.
