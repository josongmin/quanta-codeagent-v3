---
instance_id: django__django-13837
repo: django/django
base_commit: 415f50298f97fb17f841a9df38d995ccf347dfcc
version: "3.2"
difficulty: 1-4 hours
created_at: 2021-01-04T17:44:23Z
fail_to_pass: 1
pass_to_pass: 57
gold_files: [django/utils/autoreload.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-13837

## 문제 요약
`runserver`의 autoreload는 자식 프로세스를 다시 띄울 때 Python이 `-m`으로 실행됐는지 감지해 `-m <pkg>` 인자를 재구성한다. 현재 `get_child_arguments`는 오직 `python -m django`(모듈명이 정확히 `django`)인 경우만 감지하고, 게다가 모듈에 `__file__`이 세팅된 환경에서만 동작한다. 사용자는 Django 기반으로 자체 `__main__` 서브모듈을 가진 CLI 유틸(`python -m pkg_other_than_django runserver`)을 만들려 하지만, 이 경로에서는 `-m` 실행이 감지되지 않아 reload 시 잘못된 인자(`-m django` 누락 또는 오판)로 재시작된다. problem_statement는 Python 공식 문서를 인용해 정확한 대체 알고리즘(`__main__.__spec__.parent == "pkg"`)까지 명시한다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)** — problem_statement가 `django.utils.autoreload.get_child_arguments`를 파일·함수까지 직접 지목. grep 한 방. 탐색 노력 사실상 0.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S5 Spec-Inference)** — 고칠 위치는 자명하나, 픽스의 핵심은 "올바른 판정 식"을 합성하는 것이다. `__file__` 비교라는 잘못된 불변식을 버리고, `-m` 실행을 정확히 특징짓는 식 `__main__.__spec__ is not None and __main__.__spec__.parent`(빈 문자열 directory/zip 케이스를 truthiness로 동시 배제)를 추론으로 세워야 한다. 단순 가드 추가/상수 교체(S1)가 아니라 판정 조건 자체의 재설계라 S2. 그리고 "어떤 동작이 올바른가"는 코드만 봐선 결정되지 않고 CPython의 `__main__`/`__spec__` 임포트 계약(공식 문서)에서 스펙을 재구성해야 하므로 S5 보조.
- **K (Knowledge) = K-Domain** — Django 프레임워크 자체보다 CPython 런타임 내부 지식(`__main__` 모듈, `__spec__`, `ModuleSpec.parent` vs `__package__`, `-m` 실행 시맨틱)에 의존. 일반 파이썬 추론만으론 `__spec__.parent`가 빈 문자열이 되는 directory/zip 엣지를 떠올리기 어렵다.
- **primary type = T-ConstraintReason** — 위치는 명확(L0)하지만 난점이 "올바른 조건식 추론 합성"(S2)에 있으므로 T-ConstraintReason. T-DirectMap이 아닌 이유: 이슈가 지목한 게 단일 상수/가드가 아니라 판정 로직 전체의 의미적 교체이며, 정답이 정형 결함클래스(None가드/off-by-one) 템플릿에 매칭되지 않는다.

## 난이도 티어
**Tier: T3 (중간)** — 공식 라벨은 `1-4 hours`(T4~T5 시간대 prior)지만 구조 피처로 재조정해 T3로 내린다.
- T3로 미는 피처: **L0 localize(완전 무료)** + 단일 파일·단일 함수·실질 ±5줄 변경 + **has-repro 수준의 명세**(problem_statement가 정답 알고리즘과 출처 문서까지 적어줌 → S5 추론 부담을 거의 대납). 이는 T3 프로파일(L1+S2/S5, 단일파일 실질 추론)에 정확히 부합하며, localize가 L0라 오히려 T3 하단.
- T4로 밀지 않는 이유: cross-file가 없고(프로덕션은 1파일), constraint 추론도 이슈가 식을 제공해 순수 합성 부담이 약함. P2P 57개는 넓어 regression-trap 플래그를 달지만, 모두 같은 모듈(`test_autoreload`)의 인접 동작이고 변경이 한 분기에 국한돼 trap이 T4로 끌어올릴 만큼 광역적이지 않다.
- 공식 difficulty와 다른 이유: 공식 `1-4 hours`는 "개발자가 CPython `__spec__` 시맨틱을 조사·검증하고 PR/테스트 fixture를 작성하는 시간"을 반영한다. 에이전트 관점에선 이슈가 알고리즘을 명시(localize+spec-inference를 선결)했으므로 실제 추론·탐색 난이도는 그보다 낮다.

## 골드패치 분석
- **건드린 파일/함수**: `django/utils/autoreload.py` 의 `get_child_arguments()` (단일 함수, 헌크 1개).
- **근본 원인**: 기존 코드는 `import django.__main__` 후 `django_main_path = Path(django.__main__.__file__)`를 `Path(sys.argv[0])`와 비교해 `-m django` 여부를 판정했다. 이 비교는 (1) 비교 대상이 `django`로 하드코딩돼 다른 패키지의 `-m` 실행을 못 잡고, (2) `__file__`이 없는 Python 환경(일부 임베딩/특수 로더)에선 성립하지 않아 오판/실패한다.
- **수정 요지**: `__file__` 경로 비교를 폐기하고 CPython 표준 신호로 교체.
  - `import django.__main__` / `django_main_path = Path(...)` 삭제 → `import __main__`.
  - 판정 분기를 `if py_script == django_main_path:` → `if __main__.__spec__ is not None and __main__.__spec__.parent:`로 교체. `__spec__`은 `-m` 또는 directory/zip 실행 시에만 not-None이고, 그중 `-m pkg`일 때만 `.parent`가 비어있지 않은 패키지명이 된다(directory/zip은 빈 문자열). 두 조건을 AND로 걸어 `-m pkg`만 정확히 특징짓는다.
  - 주입 인자를 하드코딩 `['-m', 'django']` → `['-m', __main__.__spec__.parent]`로 변경해 실제 실행된 패키지명을 그대로 사용. 이후 `args += sys.argv[1:]`는 동일.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_run_as_non_django_module (utils_tests.test_autoreload.TestChildArguments)` — django가 아닌 패키지로 `-m` 실행된 상황을 재현하고 reload 인자가 올바르게 재구성되는지 검증.
- **픽스 증명 메커니즘**: 새 fixture 패키지 `tests/utils_tests/test_module/__main__.py`를 추가하고 그 모듈을 `test_main`으로 임포트. 테스트는 `@mock.patch.dict(sys.modules, {'__main__': test_main})`로 인터프리터의 `__main__`을 비-django 모듈로 바꾸고, `sys.argv`를 `[test_main.__file__, 'runserver']`로 mock한 뒤 `get_child_arguments()`가 `[sys.executable, '-m', 'utils_tests.test_module', 'runserver']`를 반환할 것을 단언한다. 구 코드는 `'django'`만 주입하므로 이 단언에서 실패하고, 신 코드는 `__spec__.parent`(= `utils_tests.test_module`)를 주입해 통과 → 픽스가 동작의 일반화(임의 패키지명)를 정확히 입증.
- **회귀 보강**: 기존 `test_run_as_module`과 `test_python_m_django`에 `@mock.patch.dict(sys.modules, {'__main__': django.__main__})`(및 `with mock.patch.dict(...)`)가 추가됐다. 새 분기가 글로벌 `__main__.__spec__`을 읽기 때문에, django 경로 테스트도 `__main__`을 명시 주입해야 신 코드가 올바른 `__spec__`을 보고 기존 `-m django` 결과를 그대로 내는지 회귀 검증된다.
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇아 표면상 overfit 신호가 있으나, 픽스가 `__spec__.parent`로 **임의 패키지명을 일반화**하고 테스트가 비-django 패키지(`utils_tests.test_module`)를 명시 검증하므로, `'django'`→해당 패키지명 하드코딩 같은 special-case로는 통과 불가. CEGIS급 과소명세는 아니라 overfit-risk 플래그는 달지 않는다.
- **regression 관점**: P2P 57개(대부분 `test_autoreload` 전반)가 reload·glob·snapshot·child-args 인접 동작을 커버. 특히 `test_run_as_module`/`test_python_m_django`/`test_entrypoint_fallback`/`test_exe_fallback`/`test_raises_runtimeerror`는 `get_child_arguments`의 다른 분기를 직접 지킨다 → regression-trap 플래그.

## 모범답안 (오라클 기반)
1. **Localize 경로**: problem_statement가 `django.utils.autoreload.get_child_arguments`를 명시 지목 → 곧장 그 함수 단일 헌크로 직행. 핵심 신호는 본문의 "detects only when `-m` was passed specifically django" + "`__file__` is set on modules, which is not true of all Python environments" → 잘못된 판정축이 `__file__` 비교임을 즉시 특정. (L0, 탐색 거의 불필요)
2. **픽스와 일반화 정당성**: 판정 식을 `__main__.__spec__ is not None and __main__.__spec__.parent`로 바꾸고 주입 인자를 `__main__.__spec__.parent`로 동적화. 이게 올바른 일반화인 근거: CPython 문서상 `__main__.__spec__`은 `-m`/directory/zip 실행에서만 not-None이고 `.parent`(=보통 `__package__`)는 `-m pkg`에서만 비지 않는 패키지명이다. 따라서 "임의 패키지의 `-m` 실행"을 정확히 포착하면서 directory/zip(빈 문자열)과 일반 스크립트(`__spec__ is None`)를 동시에 배제 → 특정 테스트 입력이 아니라 실행 모드의 불변식을 직접 인코딩한 것이라 overfit이 아님. 부수 이득으로 `__file__` 의존도 제거.
3. **Regression 안전**: 같은 함수의 다른 분기(`not py_script.exists()` Windows fallback, exe-extension 보정, `RuntimeError` raise)를 건드리지 않고 `-m` 판정 분기만 교체해야 한다. `test_run_as_module`/`test_python_m_django`가 기존 `-m django` 결과를 그대로 지키므로, `'django'` 케이스에서 `__spec__.parent == 'django'`가 나와 byte-identical 결과여야 한다. `test_entrypoint_fallback`/`test_exe_fallback`/`test_raises_runtimeerror`가 나머지 분기를 지킨다.
4. **함정 회피(오라클 없는 에이전트)**: (a) 가장 흔한 오답은 `'django'`만 동적 패키지명으로 바꾸되 여전히 `__file__`/`sys.argv` 비교나 `__package__` 휴리스틱으로 우회하는 것 — 그러면 `__file__` 없는 환경과 directory/zip 엣지에서 다시 깨진다. 반드시 `__spec__` 표준 신호를 써야 한다. (b) `__spec__ is not None` 가드를 빠뜨리면 일반 스크립트 실행에서 `AttributeError`. (c) `.parent`가 빈 문자열일 수 있음(directory/zip)을 truthiness로 걸러야 함 — `is not None`만 보면 빈 패키지명으로 `-m ''` 오류. (d) 테스트 측에선 `sys.modules['__main__']` 패치와 비-django fixture 모듈 생성이 필요함을 인지하지 못하면 검증을 재현 못 한다. problem_statement에 정답 알고리즘이 명시돼 있으므로 그 문서 인용을 그대로 따르는 게 안전.
