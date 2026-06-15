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
---

# django__django-13837

## 문제 요약
`runserver`의 autoreload는 자식 프로세스를 다시 띄울 때 Python이 `-m` 으로 실행됐는지 감지해 `-m <pkg>` 인자를 재구성한다. 현재 `get_child_arguments`는 오직 `python -m django`(즉 모듈명이 정확히 `django`)인 경우만 감지하고, 게다가 모듈에 `__file__`이 세팅된 환경에서만 동작한다. 사용자는 Django를 기반으로 자체 `__main__` 서브모듈을 가진 CLI 유틸(`python -m pkg_other_than_django runserver`)을 만들려 하지만, 이 경로에서는 `-m` 실행이 감지되지 않아 reload 시 잘못된 인자로 재시작된다.

## 유형 분류
- 버그 카테고리: 누락처리 / edge-case (django 외 패키지 `-m` 실행 미지원, `__file__` 없는 환경 미지원)
- 서브시스템: django runserver autoreload (`django.utils.autoreload`)
- 증상 타입: silent-wrong (reload된 자식 프로세스가 잘못된 명령행으로 재시작)
- 로컬라이제이션 신호: problem_statement가 `django.utils.autoreload.get_child_arguments`를 직접 지목하고, `__main__.__spec__` / `__spec__.parent`라는 정확한 수정 메커니즘까지 명시

## 골드패치 분석
- 건드린 파일/함수: `django/utils/autoreload.py:get_child_arguments`
- 근본 원인: 기존 코드는 `import django.__main__` 후 `Path(django.__main__.__file__)`와 `sys.argv[0]`를 비교해 `-m django` 여부를 판정했다. 이 비교는 (1) 모듈명이 `django`일 때만 참이라 다른 패키지의 `-m` 실행을 못 잡고, (2) `__file__`이 없는 Python 환경에서는 `AttributeError`/오판이 발생한다.
- 수정 요지: `__file__` 비교 대신 Python이 문서화한 표준 신호인 `__main__.__spec__`을 사용한다. `import __main__` 후 `__main__.__spec__ is not None and __main__.__spec__.parent`가 참이면 `-m`으로 실행된 것이므로 `args += ['-m', __main__.__spec__.parent]`로 실제 실행된 패키지명을 그대로 넣는다(`django` 하드코딩 제거). `-m`이 아닌 directory/zipfile 실행 시 `__spec__.parent`는 빈 문자열이라 분기를 타지 않는다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_run_as_non_django_module` — django가 아닌 패키지로 `-m` 실행했을 때 reload 인자가 올바르게 재구성되는지 검증.
- 테스트가 어떻게 픽스를 증명하는지: 새 fixture 패키지 `tests/utils_tests/test_module/__main__.py`를 추가하고, `sys.modules['__main__']`를 그 모듈(`test_main`)로, `sys.argv`를 `[test_main.__file__, 'runserver']`로 mock한다. `get_child_arguments()`가 `[sys.executable, '-m', 'utils_tests.test_module', 'runserver']`를 반환하길 기대한다. 기존 `django` 경로(`test_run_as_module`, `test_python_m_django`)도 `mock.patch.dict(sys.modules, {'__main__': django.__main__})`로 `__main__`을 명시 주입하도록 보강돼, 새 `__spec__` 기반 분기에서도 회귀 없이 통과함을 함께 증명한다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement가 함수까지 정확히 찍어줬으므로 `django/utils/autoreload.py`의 `get_child_arguments` 단일 함수만 보면 된다. localization 난이도는 매우 낮음.
- 함정/난이도 메모: 핵심은 "올바른 신호 선택"이다. `django` 하드코딩을 `__main__.__spec__.parent`로 바꾸되, (1) `__spec__ is not None` 가드와 (2) `parent`가 빈 문자열(directory/zip 실행)인 경우를 truthiness로 동시에 걸러야 한다. 단순 파일 추가가 아니라 테스트가 `sys.modules['__main__']`를 패치하는 방식까지 맞춰야 해서 테스트 코드 구조 이해가 필요. 프로덕션 변경은 1파일이지만 검증엔 새 fixture 모듈 생성이 따른다.
- 우리 에이전트 관점: 막힐 만한 지점은 "왜 `__file__` 비교가 부족한가"를 정확히 이해하는 부분. 단순히 `'django'`를 동적 패키지명으로 바꾸는 데서 그치고 `__spec__` 표준 메커니즘 대신 `__package__`/`sys.argv` 휴리스틱으로 우회하면 directory/zip 실행 edge-case나 `__file__` 없는 환경에서 다시 깨진다. problem_statement에 정답 알고리즘이 명시돼 있어 그대로 따르면 안전.
