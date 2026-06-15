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
---

# django__django-14311

## 문제 요약
`python -m foo.bar.baz runserver`처럼 모듈(패키지가 아닌 단일 .py)을 점 표기 dotted name으로 실행하면 autoreloader가 자식 프로세스를 재실행할 때 인자를 `-m foo.bar`로 잘못 만들어 버린다. 기존 픽스는 `-m foo.bar`(bar가 패키지이고 `foo/bar/__main__.py`가 있는 경우)만 다뤘기 때문이다. 사용자는 `foo/bar/manage.py`를 `-m foo.bar.manage runserver`로 실행했을 때 3.1처럼 정상적으로 리로딩되길 기대했으나, 마지막 컴포넌트가 잘려 엉뚱한 모듈이 재실행됐다.

## 유형 분류
- 버그 카테고리: edge-case / 누락처리 (패키지 `__main__` 케이스만 처리, 일반 모듈 케이스 누락)
- 서브시스템: django.utils autoreload (runserver dev-server 재시작 로직)
- 증상 타입: 잘못된 출력 (재실행 인자 오생성 → 리로드 실패/엉뚱한 모듈 실행)
- 로컬라이제이션 신호: "autoreloading", "python -m", "the resulting arguments end up being -m foo.bar"와 commit ec6d2531(autoreload.py의 `get_child_arguments`) 참조가 곧장 골드 파일을 가리킨다.

## 골드패치 분석
- 건드린 파일/함수: `django/utils/autoreload.py`:`get_child_arguments()`
- 근본 원인: `__main__.__spec__.parent`를 무조건 `-m` 인자로 사용했다. `__spec__.parent`는 모듈이 속한 패키지명이라, `-m foo.bar.baz`로 단일 모듈 baz를 실행하면 parent가 `foo.bar`가 되어 baz가 통째로 누락된다. parent는 진짜 패키지의 `__main__`을 실행할 때만 옳다.
- 수정 요지: `__spec__`가 있을 때 `spec.name`을 검사한다. `spec.name == '__main__'` 또는 `spec.name.endswith('.__main__')`이고 `spec.parent`가 있으면(=패키지의 `__main__.py` 실행) `spec.parent`를 쓰고, 그 외(일반 모듈을 dotted name으로 직접 실행)에는 `spec.name`을 그대로 `-m` 인자로 넘긴다. 힌트(코어 리뷰어)대로 `split('.')[-1] == '__main__'` 대신 `endswith('.__main__')`을 써서 `foo.my__main__` 같은 코너 케이스 오탐을 피한다(runpy.py 방식).

## 검증 (test_patch)
- FAIL_TO_PASS: `test_run_as_non_django_module_non_package` — 패키지가 아닌 일반 모듈을 dotted name으로 실행한 경우를 검증.
- 새 fixture `tests/utils_tests/test_module/main_module.py`를 추가하고, `sys.modules['__main__']`을 그 모듈로 mock한 뒤 `get_child_arguments()`가 `[sys.executable, '-m', 'utils_tests.test_module.main_module', 'runserver']`를 반환하는지 확인한다. 즉 마지막 컴포넌트 `main_module`이 잘려나가지 않고 full dotted name이 보존됨을 증명한다. 기존 `test_run_as_non_django_module`(패키지 `__main__` 케이스)은 PASS_TO_PASS로 유지되어 회귀 방지.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement가 함수와 커밋을 거의 직접 명시 → `autoreload.py`에서 `-m`과 `__spec__`을 다루는 `get_child_arguments`로 바로 진입.
- 함정/난이도 메모: `__spec__.parent` vs `__spec__.name`의 의미 차이가 핵심. 패키지 `__main__` 실행과 단일 모듈 실행을 구별하지 못하면 한쪽만 고치고 다른 쪽을 깬다. 단순 `name.split('.')[-1] == '__main__'`로 짜면 `foo.my__main__` 오탐 위험(리뷰 피드백 포인트). 단일 파일·단일 함수 수정이지만 분기 조건이 미묘.
- 우리 에이전트 관점: Python import 시스템의 `ModuleSpec.name`/`parent` 시맨틱을 정확히 이해해야 분기를 옳게 짠다. 기존 `if ... .parent:` 한 줄을 "조건만 추가"하려다 parent 우선순위를 잘못 잡으면 패키지 케이스를 회귀시키기 쉽다. `endswith('.__main__')` 같은 미세 처리는 명시적 힌트 없이는 놓칠 가능성이 높다.
